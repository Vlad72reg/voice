/*
 * Обработка голоса — порт voice_engine.py / effects.py (и Java-версии для Android).
 * Обычный скрипт без модулей: подключается на странице, в Web Worker (importScripts)
 * и в AudioWorklet (build.py вклеивает его в worklet.js). Всё экспортируется в globalThis.VoiceDSP.
 */
(function (global) {
  'use strict';

  const TWO_PI = 2 * Math.PI;
  const db = (x) => Math.pow(10, x / 20);

  /**
   * БПФ вещественного сигнала длины n через комплексное БПФ длины n/2
   * (чётные отсчёты — в действительную часть, нечётные — в мнимую): вдвое быстрее.
   */
  class FFT {
    constructor(n) {
      this.n = n;
      const h = this.h = n / 2;
      this.cos = new Float64Array(h / 2);
      this.sin = new Float64Array(h / 2);
      for (let i = 0; i < h / 2; i++) {
        this.cos[i] = Math.cos(-TWO_PI * i / h);
        this.sin[i] = Math.sin(-TWO_PI * i / h);
      }
      const bits = Math.log2(h);
      this.rev = new Uint32Array(h);
      for (let i = 0; i < h; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        this.rev[i] = r;
      }
      // Поворачивающие множители W^k = e^{-2πik/n} для склейки половин.
      this.wr = new Float64Array(h + 1);
      this.wi = new Float64Array(h + 1);
      for (let k = 0; k <= h; k++) {
        this.wr[k] = Math.cos(-TWO_PI * k / n);
        this.wi[k] = Math.sin(-TWO_PI * k / n);
      }
      this.re = new Float64Array(h);
      this.im = new Float64Array(h);
    }

    /** Комплексное БПФ длины h на месте. */
    transform(r, m, inverse) {
      const n = this.h, rev = this.rev, cs = this.cos, sn = this.sin;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = r[i]; r[i] = r[j]; r[j] = t;
          t = m[i]; m[i] = m[j]; m[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0; k < half; k++) {
            const wr = cs[k * step], wi = inverse ? -sn[k * step] : sn[k * step];
            const a = start + k, b = a + half;
            const xr = r[b] * wr - m[b] * wi, xi = r[b] * wi + m[b] * wr;
            r[b] = r[a] - xr; m[b] = m[a] - xi;
            r[a] += xr; m[a] += xi;
          }
        }
      }
    }

    /** x (длина n) -> спектр outRe/outIm (n/2+1 бинов), как numpy.fft.rfft. */
    rfft(x, outRe, outIm) {
      const h = this.h, re = this.re, im = this.im, wr = this.wr, wi = this.wi;
      for (let i = 0; i < h; i++) { re[i] = x[2 * i]; im[i] = x[2 * i + 1]; }
      this.transform(re, im, false);
      for (let k = 0; k <= h; k++) {
        const a = k % h, b = (h - k) % h;
        // E = (Z[k] + conj Z[h-k]) / 2,  O = (Z[k] - conj Z[h-k]) / (2i)
        const er = 0.5 * (re[a] + re[b]), ei = 0.5 * (im[a] - im[b]);
        const or = 0.5 * (im[a] + im[b]), oi = -0.5 * (re[a] - re[b]);
        outRe[k] = er + wr[k] * or - wi[k] * oi;
        outIm[k] = ei + wr[k] * oi + wi[k] * or;
      }
    }

    /** Обратное к rfft: n/2+1 бинов -> вещественный сигнал длины n (как numpy.fft.irfft). */
    irfft(inRe, inIm, out) {
      const h = this.h, re = this.re, im = this.im, wr = this.wr, wi = this.wi;
      for (let k = 0; k < h; k++) {
        const xr = inRe[k], xi = k === 0 ? 0 : inIm[k];
        const yr = inRe[h - k], yi = -(h - k === h ? 0 : inIm[h - k]);  // conj X[h-k]
        const er = 0.5 * (xr + yr), ei = 0.5 * (xi + yi);
        // O = (X[k] - conj X[h-k]) / 2 * conj(W^k)
        const dr = 0.5 * (xr - yr), di = 0.5 * (xi - yi);
        const or = dr * wr[k] + di * wi[k], oi = di * wr[k] - dr * wi[k];
        re[k] = er - oi;  // Z = E + i·O
        im[k] = ei + or;
      }
      this.transform(re, im, true);
      for (let i = 0; i < h; i++) { out[2 * i] = re[i] / h; out[2 * i + 1] = im[i] / h; }
    }
  }

  /** Сдвиг тона с независимым сдвигом формант и «шёпотом» (фазовый вокодер). */
  class PitchFormantShifter {
    constructor() {
      const n = this.n = 2048;
      this.hop = n / 8;
      const bins = this.bins = n / 2 + 1;
      this.fft = new FFT(n);
      this.expected = TWO_PI * this.hop / n;
      this.window = new Float64Array(n);
      this.synWindow = new Float64Array(n);
      this.bypassWindow = new Float64Array(n);
      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        this.window[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / (n - 1));  // как np.hanning
        sumSq += this.window[i] * this.window[i];
      }
      const norm = 1 / (sumSq / this.hop);
      for (let i = 0; i < n; i++) {
        this.synWindow[i] = this.window[i] * norm;
        this.bypassWindow[i] = this.window[i] * this.window[i] * norm;
      }
      this.pitchRatio = 1; this.formantRatio = 1; this.whisper = 0;
      this.frame = new Float64Array(n); this.outAcc = new Float64Array(n);
      this.lastPhase = new Float64Array(bins); this.sumPhase = new Float64Array(bins);
      this.env = new Float64Array(bins); this.haveEnv = false; this.frameNo = 0;
      this.tmp = new Float64Array(n); this.cep = new Float64Array(n);
      this.specRe = new Float64Array(bins); this.specIm = new Float64Array(bins);
      this.envRe = new Float64Array(bins); this.envIm = new Float64Array(bins);
      this.mag = new Float64Array(bins); this.trueBin = new Float64Array(bins);
      this.synExc = new Float64Array(bins); this.synFreq = new Float64Array(bins);
      // Очереди: вход копится до hop сэмплов, выход заранее заполнен тишиной длиной n.
      this.inQ = new Float64Array(this.hop); this.inCount = 0;
      this.outQ = new Float64Array(n * 8); this.outRead = 0; this.outCount = n;
    }

    isBypass() {
      return Math.abs(this.pitchRatio - 1) < 1e-3 && Math.abs(this.formantRatio - 1) < 1e-3 &&
        this.whisper < 1e-3;
    }

    envelope() {
      const bins = this.bins, n = this.n, LIFTER = 40;
      for (let i = 0; i < bins; i++) this.specRe[i] = Math.log(this.mag[i] + 1e-9);
      this.specIm.fill(0);
      this.fft.irfft(this.specRe, this.specIm, this.cep);
      for (let i = LIFTER; i < n - LIFTER; i++) this.cep[i] = 0;
      this.fft.rfft(this.cep, this.envRe, this.envIm);
      for (let i = 0; i < bins; i++) this.env[i] = Math.exp(this.envRe[i]);
      this.haveEnv = true;
    }

    processFrame() {
      const n = this.n, bins = this.bins, outAcc = this.outAcc;
      if (this.isBypass()) {
        this.lastPhase.fill(0);
        for (let i = 0; i < n; i++) outAcc[i] += this.frame[i] * this.bypassWindow[i];
        return;
      }
      const tmp = this.tmp, re = this.specRe, im = this.specIm, expected = this.expected;
      for (let i = 0; i < n; i++) tmp[i] = this.frame[i] * this.window[i];
      this.fft.rfft(tmp, re, im);
      for (let k = 0; k < bins; k++) {
        this.mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);  // Math.hypot в V8 в разы медленнее
        const phase = Math.atan2(im[k], re[k]);
        let delta = phase - this.lastPhase[k] - k * expected;
        this.lastPhase[k] = phase;
        delta -= TWO_PI * Math.floor((delta + Math.PI) / TWO_PI);
        this.trueBin[k] = k + delta / expected;
      }
      // Огибающая (тембр) меняется медленно — пересчитываем её через кадр.
      if (!this.haveEnv || this.frameNo % 2 === 0) this.envelope();
      this.frameNo++;

      const p = this.pitchRatio, f = this.formantRatio, w = this.whisper, env = this.env;
      const synExc = this.synExc, synFreq = this.synFreq;
      synExc.fill(0); synFreq.fill(0);
      for (let k = 0; k < bins; k++) {
        const target = roundHalfEven(k * p);
        if (target < bins) {
          synExc[target] += this.mag[k] / env[k];
          synFreq[target] = this.trueBin[k] * p;
        }
      }
      for (let k = 0; k < bins; k++) {
        const x = k / f;
        let warped;
        if (x > bins - 1) warped = 0;
        else {
          const i0 = Math.floor(x), fr = x - i0;
          warped = i0 + 1 < bins ? env[i0] + (env[i0 + 1] - env[i0]) * fr : env[i0];
        }
        const m = synExc[k] * warped;
        this.sumPhase[k] = (this.sumPhase[k] + synFreq[k] * expected) % TWO_PI;
        let pr = Math.cos(this.sumPhase[k]), pi = Math.sin(this.sumPhase[k]);
        if (w > 0) {
          const a = Math.random() * TWO_PI;
          pr = (1 - w) * pr + w * Math.cos(a);
          pi = (1 - w) * pi + w * Math.sin(a);
        }
        re[k] = m * pr; im[k] = m * pi;
      }
      this.fft.irfft(re, im, tmp);
      for (let i = 0; i < n; i++) outAcc[i] += tmp[i] * this.synWindow[i];
    }

    /** x -> y той же длины (с задержкой n сэмплов). */
    process(x, y, len) {
      const hop = this.hop, n = this.n, q = this.outQ, qLen = q.length;
      for (let i = 0; i < len; i++) {
        this.inQ[this.inCount++] = x[i];
        if (this.inCount === hop) {
          this.frame.copyWithin(0, hop);
          this.frame.set(this.inQ, n - hop);
          this.inCount = 0;
          this.processFrame();
          for (let j = 0; j < hop; j++) {
            q[(this.outRead + this.outCount) % qLen] = this.outAcc[j];
            this.outCount++;
          }
          this.outAcc.copyWithin(0, hop);
          this.outAcc.fill(0, n - hop);
        }
      }
      for (let i = 0; i < len; i++) {
        if (this.outCount > 0) {
          y[i] = q[this.outRead];
          this.outRead = (this.outRead + 1) % qLen;
          this.outCount--;
        } else y[i] = 0;
      }
    }
  }

  // Math.rint / np.round: половины округляются к чётному.
  function roundHalfEven(v) {
    const r = Math.round(v);
    return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
  }

  // ---------- эффекты ----------
  class NoiseGate {
    constructor(sr) { this.sr = sr; this.threshold = db(-50); this.gain = 0; }
    process(x, len) {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / len + 1e-12);
      const target = rms > this.threshold ? 1 : 0;
      const tau = target > this.gain ? 2 : 150;
      const next = target + (this.gain - target) * Math.exp(-len / (this.sr * tau / 1000));
      for (let i = 0; i < len; i++) x[i] *= this.gain + (next - this.gain) * i / len;
      this.gain = next;
    }
  }

  /** Биквад Баттерворта 2-го порядка. */
  class Filter {
    constructor(sr, cutoff, highpass) {
      const k = Math.tan(Math.PI * cutoff / sr), q = Math.SQRT1_2;
      const norm = 1 / (1 + k / q + k * k);
      if (highpass) { this.b0 = norm; this.b1 = -2 * norm; this.b2 = norm; }
      else { this.b0 = k * k * norm; this.b1 = 2 * this.b0; this.b2 = this.b0; }
      this.a1 = 2 * (k * k - 1) * norm;
      this.a2 = (1 - k / q + k * k) * norm;
      this.z1 = 0; this.z2 = 0;
    }
    process(x, len) {
      for (let i = 0; i < len; i++) {
        const v = x[i], out = this.b0 * v + this.z1;
        this.z1 = this.b1 * v - this.a1 * out + this.z2;
        this.z2 = this.b2 * v - this.a2 * out;
        x[i] = out;
      }
    }
  }

  class Chorus {
    constructor(sr) {
      this.sr = sr; this.depth = 4 * sr / 1000; this.centre = 12 * sr / 1000;
      this.buf = new Float64Array(Math.floor(sr * 0.1)); this.pos = 0; this.t = 0;
    }
    process(x, len) {
      const size = this.buf.length, voices = 3, mix = 0.45;
      for (let i = 0; i < len; i++) {
        this.buf[this.pos] = x[i];
        const time = (this.t + i) / this.sr;
        let wet = 0;
        for (let v = 0; v < voices; v++) {
          const delay = this.centre + this.depth * Math.sin(TWO_PI * 0.25 * time + TWO_PI * v / voices);
          const p = this.pos - delay, i0 = Math.floor(p), fr = p - i0;
          const a = this.buf[((i0 % size) + size) % size], b = this.buf[(((i0 + 1) % size) + size) % size];
          wet += a + (b - a) * fr;
        }
        x[i] = (1 - mix) * x[i] + mix * wet / voices;
        this.pos = (this.pos + 1) % size;
      }
      this.t += len;
    }
  }

  class EchoDelay {
    constructor(sr) { this.buf = new Float64Array(Math.floor(sr * 0.33)); this.pos = 0; }
    process(x, len) {
      for (let i = 0; i < len; i++) {
        const d = this.buf[this.pos];
        this.buf[this.pos] = x[i] + d * 0.35;
        x[i] += d * 0.22;
        this.pos = (this.pos + 1) % this.buf.length;
      }
    }
  }

  /** Реверберация Freeverb (8 гребенчатых + 4 всепропускающих). */
  class Reverb {
    constructor(sr) {
      const scale = sr / 44100;
      this.feedback = 0.7 + 0.28 * 0.92; this.damp = 0.35 * 0.4;
      this.wet = 0.45 * 0.15; this.dry = 0.65;
      this.comb = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
        .map((d) => ({ buf: new Float64Array(Math.floor(d * scale)), pos: 0, lp: 0 }));
      this.ap = [556, 441, 341, 225].map((d) => ({ buf: new Float64Array(Math.floor(d * scale)), pos: 0 }));
    }
    process(x, len) {
      const fb = this.feedback, damp = this.damp;
      for (let i = 0; i < len; i++) {
        const v = x[i];
        let acc = 0;
        for (const c of this.comb) {
          const d = c.buf[c.pos];
          c.lp = (1 - damp) * d + damp * c.lp;
          c.buf[c.pos] = v + c.lp * fb;
          c.pos = (c.pos + 1) % c.buf.length;
          acc += d;
        }
        for (const a of this.ap) {
          const d = a.buf[a.pos];
          a.buf[a.pos] = acc + d * 0.5;
          a.pos = (a.pos + 1) % a.buf.length;
          acc = d - acc;
        }
        x[i] = v * this.dry + acc * this.wet;
      }
    }
  }

  class Limiter {
    constructor(sr) { this.makeup = 1; this.release = Math.exp(-1 / (sr * 0.15)); this.gain = 1; }
    process(x, len) {
      let peak = 1e-12;
      for (let i = 0; i < len; i++) { x[i] *= this.makeup; peak = Math.max(peak, Math.abs(x[i])); }
      const target = Math.min(1, 0.89 / peak);
      const next = target < this.gain ? target : target + (this.gain - target) * Math.pow(this.release, len);
      for (let i = 0; i < len; i++) x[i] = Math.tanh(x[i] * (this.gain + (next - this.gain) * i / len));
      this.gain = next;
    }
  }

  /** Те же пресеты, что в программе для ПК и в APK. level — компенсация громкости, дБ. */
  const PRESETS = {
    'Мужской': { pitch: -4, formant: 0.87, whisper: 0, ghost: false, level: 1.0, hint: 'ниже и глубже' },
    'Женский': { pitch: 5, formant: 1.17, whisper: 0, ghost: false, level: 4.5, hint: 'выше и светлее' },
    'Призрак': { pitch: -3, formant: 0.92, whisper: 0.55, ghost: true, level: 2.0, hint: 'шёпот и эхо' },
    'Без изменений': { pitch: 0, formant: 1.0, whisper: 0, ghost: false, level: 0, hint: 'ваш голос' },
  };

  class VoiceEngine {
    constructor(sr) {
      this.sr = sr;
      this.shifter = new PitchFormantShifter();
      this.gate = new NoiseGate(sr);
      this.limiter = new Limiter(sr);
      this.ghostFx = [];
      this.buf = new Float64Array(0);
      this.out = new Float64Array(0);
    }

    /** s: {pitch, formant, whisper, ghost, gain} — gain уже с компенсацией голоса. */
    configure(s) {
      this.shifter.pitchRatio = Math.pow(2, s.pitch / 12);
      this.shifter.formantRatio = s.formant;
      this.shifter.whisper = s.whisper;
      if (s.ghost && this.ghostFx.length === 0) {
        const sr = this.sr;
        this.ghostFx = [new Filter(sr, 180, true), new Filter(sr, 6500, false),
          new Chorus(sr), new EchoDelay(sr), new Reverb(sr)];
      } else if (!s.ghost) this.ghostFx = [];
      this.limiter.makeup = db(s.gain);
    }

    process(src, dst, len) {
      if (this.buf.length < len) { this.buf = new Float64Array(len); this.out = new Float64Array(len); }
      const b = this.buf, o = this.out;
      for (let i = 0; i < len; i++) b[i] = src[i];
      this.gate.process(b, len);
      this.shifter.process(b, o, len);
      for (const fx of this.ghostFx) fx.process(o, len);
      this.limiter.process(o, len);
      for (let i = 0; i < len; i++) dst[i] = Number.isNaN(o[i]) ? 0 : o[i];
    }
  }

  /** Обработка целой записи: задержку срезаем, для призрака дописываем хвост эха. */
  function processAll(audio, sr, settings) {
    const e = new VoiceEngine(sr);
    e.configure(settings);
    const delay = 2048, block = 512, tail = settings.ghost ? Math.floor(sr * 1.5) : 0;
    const total = audio.length + delay + tail;
    const res = new Float32Array(total), buf = new Float32Array(block);
    for (let pos = 0; pos < total; pos += block) {
      const len = Math.min(block, total - pos);
      for (let i = 0; i < len; i++) buf[i] = pos + i < audio.length ? audio[pos + i] : 0;
      e.process(buf, buf, len);
      res.set(buf.subarray(0, len), pos);
    }
    return res.subarray(delay);
  }

  /** Моно-WAV 16 бит. */
  function encodeWav(x, sr) {
    const buf = new ArrayBuffer(44 + x.length * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, x.length * 2, true);
    for (let i = 0; i < x.length; i++) {
      const s = Math.max(-1, Math.min(1, x[i]));
      v.setInt16(44 + i * 2, Math.round(s * 32767), true);
    }
    return buf;
  }

  global.VoiceDSP = { VoiceEngine, PRESETS, processAll, encodeWav, _FFT: FFT };
})(typeof globalThis !== 'undefined' ? globalThis : self);
