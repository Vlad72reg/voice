/*
 * Фоновый поток ИИ-голоса: загружает модель Beatrice и обрабатывает звук.
 *   живой режим — звук приходит из ворклета по MessagePort кусками и уходит обратно туда же;
 *   запись — целиком, результат WAV.
 */
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.wasm.min.js');
importScripts('dsp.js', 'beatrice-synth.js', 'beatrice.js');
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';

const MODEL = 'models/beatrice_librivox.onnx', META = 'models/beatrice_librivox.json';
let session = null, meta = null, live = null, port = null, voice = { spk: 1, shift: 0 };
let busy = false;
const queue = [];

async function init() {
  meta = await fetch(META).then((r) => r.json());
  session = await ort.InferenceSession.create(MODEL, { executionProviders: ['wasm'] });
}

/** Живой звук обрабатывается строго по очереди; время каждого шага уходит в главный поток. */
async function pump() {
  if (busy || !live) return;
  busy = true;
  while (queue.length) {
    const x = queue.shift();
    const y = await live.process(x);
    if (y.length) {
      port.postMessage({ out: y }, [y.buffer]);
      self.postMessage({ type: 'stats', ms: live.lastMs, budget: live.stepBudgetMs, backlog: queue.length });
    }
  }
  busy = false;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      await init();
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'port') {
      port = m.port;
      live = new BeatriceEngine(ort, session, meta, m.sr);  // частота звуковой карты
      live.setVoice(voice.spk, voice.shift);
      port.onmessage = (ev) => { queue.push(ev.data.in); pump(); };
    } else if (m.type === 'voice') {
      voice = { spk: m.spk, shift: m.shift };
      if (live) live.setVoice(m.spk, m.shift);
    } else if (m.type === 'reset') {
      queue.length = 0;
      if (live) live.reset();
    } else if (m.type === 'convert') {
      // Запись: отдельный движок (своя память), хвост тишины, чтобы досчитать задержку.
      const eng = new BeatriceEngine(ort, session, meta, m.sr);
      eng.setVoice(m.spk, m.shift);
      const tail = Math.round(m.sr * 0.4), x = new Float32Array(m.audio.length + tail);
      x.set(m.audio);
      const outs = [];
      for (let i = 0; i < x.length; i += 16384) outs.push(await eng.process(x.subarray(i, i + 16384)));
      let n = 0; for (const o of outs) n += o.length;
      const y = new Float32Array(n); let p = 0;
      for (const o of outs) { y.set(o, p); p += o.length; }
      // Выход движка совпадает с входом по кадрам, кроме сдвига синтеза (5 мс) за вычетом
      // начальных отсчётов, которые съедают пересчёты частоты (~2 мс): срезаем ~3 мс.
      const delay = Math.round(m.sr * 0.003);
      const res = y.subarray(Math.min(delay, y.length), Math.min(delay + m.audio.length, y.length));
      const g = Math.pow(10, m.gain / 20);
      for (let i = 0; i < res.length; i++) res[i] = Math.tanh(res[i] * g);
      const wav = VoiceDSP.encodeWav(res, m.sr);
      self.postMessage({ type: 'converted', id: m.id, wav, seconds: m.audio.length / m.sr }, [wav]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};
