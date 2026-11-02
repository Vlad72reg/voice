/*
 * ИИ-голос (Beatrice 2) в браузере: потоковая нейросеть (ONNX Runtime Web) + синтез (beatrice-synth.js).
 * Работает в Worker. Звук любой частоты дискретизации -> 16 кГц -> модель кусками по N кадров (10 мс)
 * -> параметры кадров -> синтез 24 кГц -> исходная частота. Модель и её описание: models/*.onnx, *.json.
 */
(function (global) {
  'use strict';
  const { Resampler, Synth } = global.BeatriceSynth;

  class BeatriceEngine {
    /** session — ort.InferenceSession, meta — описание состояний модели (export_stream.py). */
    constructor(ort, session, meta, sampleRate) {
      this.ort = ort; this.session = session; this.meta = meta; this.sr = sampleRate;
      this.N = meta.n_frames;
      this.spk = 1; this.shift = 0;
      this.reset();
    }

    static async create(ort, modelUrl, metaUrl, sampleRate) {
      const meta = await fetch(metaUrl).then((r) => r.json());
      const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
      return new BeatriceEngine(ort, session, meta, sampleRate);
    }

    /** Голос модели (номер диктора) и сдвиг тона в полутонах. */
    setVoice(spk, shift) { this.spk = spk; this.shift = shift; }

    reset() {
      const T = this.ort.Tensor;
      this.states = this.meta.states.map((s) => {
        const n = s.shape.reduce((a, b) => a * b, 1);
        return s.dtype === 'int64'
          ? new T('int64', new BigInt64Array(n).fill(BigInt(Math.round(s.fill))), s.shape)
          : new T('float32', new Float32Array(n).fill(s.fill), s.shape);
      });
      this.M = 0;
      this.inRes = new Resampler(this.sr, 16000);
      this.outRes = new Resampler(24000, this.sr);
      this.in16 = new Float32Array(0);
      this.synth = new Synth(this.meta.ir_window);
      this.lastMs = 0;  // время последнего шага модели, мс
    }

    /** Обрабатывает звук x (частота sr); возвращает весь готовый выход (длина может отличаться). */
    async process(x) {
      const add = this.inRes.process(x), buf = new Float32Array(this.in16.length + add.length);
      buf.set(this.in16); buf.set(add, this.in16.length);
      this.in16 = buf;
      const step = 160 * this.N, outs = [];
      while (this.in16.length >= step) {
        const chunk = this.in16.slice(0, step);
        this.in16 = this.in16.slice(step);
        outs.push(await this._step(chunk));
      }
      let n = 0;
      for (const o of outs) n += o.length;
      const y = new Float32Array(n);
      let p = 0;
      for (const o of outs) { y.set(o, p); p += o.length; }
      return y;
    }

    async _step(chunk) {
      const T = this.ort.Tensor, N = this.N, t0 = performance.now();
      this.M += N;
      const feeds = {
        wav: new T('float32', chunk, [1, chunk.length]),
        spk: new T('int64', BigInt64Array.of(BigInt(this.spk)), [1]),
        shift: new T('float32', Float32Array.of(this.shift), [1]),
        M: new T('int64', BigInt64Array.of(BigInt(this.M)), []),
      };
      this.meta.states.forEach((s, i) => { feeds[s.name] = this.states[i]; });
      const r = await this.session.run(feeds);
      this.states = this.meta.states.map((s) => r['n' + s.name]);
      const ir = r.ir.data, ap = r.ap.data, pf = r.pf.data, hz = r.hz.data;
      const y24 = [];
      for (let f = 0; f < N; f++) {
        if (this.M - N - 3 + f < 0) continue;  // кадры «до начала» — ещё не настоящие
        const col = (a, ch) => { const v = new Float64Array(ch); for (let c = 0; c < ch; c++) v[c] = a[c * N + f]; return v; };
        const y = this.synth.push(col(ir, 512), col(ap, 240), col(pf, 512), hz[f]);
        if (y) y24.push(y);
      }
      let n = 0;
      for (const y of y24) n += y.length;
      const all = new Float32Array(n);
      let p = 0;
      for (const y of y24) { all.set(y, p); p += y.length; }
      this.lastMs = performance.now() - t0;
      return this.outRes.process(all);
    }

    /** Длительность одного шага, мс (бюджет реального времени). */
    get stepBudgetMs() { return this.N * 10; }
  }

  global.BeatriceEngine = BeatriceEngine;
})(typeof globalThis !== 'undefined' ? globalThis : self);
