/*
 * AudioWorklet: микрофон -> (запись сырого звука) -> обработка -> выход.
 * app.js сначала загружает в ворклет dsp.js (он задаёт VoiceDSP в общей области), потом этот файл.
 * ИИ-голос считает фоновый поток (ai-worker.js): ворклет шлёт ему звук по MessagePort пачками
 * и играет ответ из буфера с небольшим запасом (нейросеть отдаёт звук кусками по 160 мс).
 */
const AI_BATCH = 1024;          // отсчётов в одной посылке фоновому потоку
const AI_PREFILL = 0.08;        // запас на скачки времени обработки: ждём столько после первого ответа, с
const AI_MAX_LAG = 0.5;         // больше — выбрасываем старое, чтобы задержка не росла

class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new VoiceDSP.VoiceEngine(sampleRate);
    this.live = false;
    this.recording = false;
    this.ai = false;
    this.aiPort = null;
    this.aiGain = 1;
    this.batch = new Float32Array(AI_BATCH);
    this.batchLen = 0;
    this.ring = new Float32Array(sampleRate * 2);
    this.rRead = 0;
    this.rCount = 0;
    this.primed = false;
    this.wait = null;             // сколько отсчётов ещё ждать перед стартом (null — ответа ещё нет)
    this.peakIn = 0;
    this.peakOut = 0;
    this.frames = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'config') this.engine.configure(m.settings);
      else if (m.type === 'live') this.live = m.on;
      else if (m.type === 'record') this.recording = m.on;
      else if (m.type === 'ai-port') {
        this.aiPort = m.port;
        this.aiPort.onmessage = (ev) => this.push(ev.data.out);
      } else if (m.type === 'ai') {
        this.ai = m.on;
        this.aiGain = Math.pow(10, (m.gain || 0) / 20);
        this.rCount = 0; this.primed = false; this.wait = null; this.batchLen = 0;
      }
    };
  }

  /** Ответ фонового потока — в кольцевой буфер. */
  push(y) {
    const size = this.ring.length;
    for (let i = 0; i < y.length; i++) {
      if (this.rCount === size) { this.rRead = (this.rRead + 1) % size; this.rCount--; }
      this.ring[(this.rRead + this.rCount) % size] = y[i];
      this.rCount++;
    }
    const max = Math.floor(AI_MAX_LAG * sampleRate);
    if (this.rCount > max) { const drop = this.rCount - max; this.rRead = (this.rRead + drop) % size; this.rCount = max; }
  }

  processAi(input, output) {
    // вход — фоновому потоку пачками
    let i = 0;
    while (i < input.length) {
      const n = Math.min(AI_BATCH - this.batchLen, input.length - i);
      this.batch.set(input.subarray(i, i + n), this.batchLen);
      this.batchLen += n; i += n;
      if (this.batchLen === AI_BATCH) {
        if (this.aiPort) this.aiPort.postMessage({ in: this.batch.slice(0) });
        this.batchLen = 0;
      }
    }
    // выход — из буфера: ответы приходят пачками по 160 мс, поэтому после первой пачки
    // ждём ещё AI_PREFILL, чтобы следующая успевала прийти до конца предыдущей
    if (!this.primed) {
      if (this.wait === null && this.rCount > 0) this.wait = Math.round(AI_PREFILL * sampleRate);
      if (this.wait !== null) this.wait -= output.length;
      if (this.wait !== null && this.wait <= 0 && this.rCount >= output.length) this.primed = true;
    }
    if (!this.primed || this.rCount < output.length) {
      if (this.primed) this.wait = null;  // буфер опустел — снова набираем запас
      this.primed = false;
      output.fill(0);
      return;
    }
    const size = this.ring.length, g = this.aiGain;
    for (let k = 0; k < output.length; k++) {
      output[k] = Math.tanh(this.ring[this.rRead] * g);
      this.rRead = (this.rRead + 1) % size;
    }
    this.rCount -= output.length;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    if (this.recording) this.port.postMessage({ type: 'chunk', data: input.slice(0) });
    if (this.live && this.ai) this.processAi(input, output);
    else if (this.live) this.engine.process(input, output, input.length);
    else output.fill(0);

    for (let i = 0; i < input.length; i++) {
      this.peakIn = Math.max(this.peakIn, Math.abs(input[i]));
      this.peakOut = Math.max(this.peakOut, Math.abs(output[i]));
    }
    this.frames += input.length;
    if (this.frames >= sampleRate / 20) {  // уровни 20 раз в секунду
      this.port.postMessage({ type: 'levels', in: this.peakIn, out: this.peakOut });
      this.peakIn = this.peakOut = 0;
      this.frames = 0;
    }
    return true;
  }
}

registerProcessor('voice-processor', VoiceProcessor);
