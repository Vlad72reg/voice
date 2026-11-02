/*
 * ИИ-голос (Beatrice) в браузере: пересчёт частоты дискретизации и синтез звука из параметров кадров.
 * Порт synth.py (проверен против синтеза тренера Beatrice). Работает в Worker вместе с beatrice.js.
 */
(function (global) {
  'use strict';
  const TWO_PI = 2 * Math.PI, HOP = 240, IRN = 512;

  /** Комплексное БПФ (radix-2) на месте. */
  class FFT {
    constructor(n) {
      this.n = n;
      this.rev = new Uint32Array(n);
      const bits = Math.log2(n);
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        this.rev[i] = r;
      }
      this.c = new Float64Array(n / 2); this.s = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) { this.c[i] = Math.cos(-TWO_PI * i / n); this.s[i] = Math.sin(-TWO_PI * i / n); }
    }
    run(re, im, inverse) {
      const n = this.n, rev = this.rev;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let st = 0; st < n; st += size) {
          for (let k = 0; k < half; k++) {
            const wr = this.c[k * step], wi = inverse ? -this.s[k * step] : this.s[k * step];
            const a = st + k, b = a + half;
            const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          }
        }
      }
      if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  /** Комплексное БПФ длины 480 = 15·32 (Кули–Тьюки): 32 ДПФ по 15 точек, повороты, 15 БПФ по 32. */
  class FFT480 {
    constructor() {
      const P = 15, Q = 32, N = 480;
      this.c15 = new Float64Array(P * P); this.s15 = new Float64Array(P * P);
      for (let k = 0; k < P; k++) for (let t = 0; t < P; t++) {
        this.c15[k * P + t] = Math.cos(-TWO_PI * k * t / P); this.s15[k * P + t] = Math.sin(-TWO_PI * k * t / P);
      }
      this.tc = new Float64Array(Q * P); this.ts = new Float64Array(Q * P);
      for (let n2 = 0; n2 < Q; n2++) for (let k1 = 0; k1 < P; k1++) {
        this.tc[n2 * P + k1] = Math.cos(-TWO_PI * n2 * k1 / N); this.ts[n2 * P + k1] = Math.sin(-TWO_PI * n2 * k1 / N);
      }
      this.f32 = new FFT(Q);
      this.yr = new Float64Array(Q * P); this.yi = new Float64Array(Q * P);
      this.br = new Float64Array(Q); this.bi = new Float64Array(Q);
      this.or = new Float64Array(N); this.oi = new Float64Array(N);
    }
    /** Прямое БПФ; возвращает [re, im] (внутренние массивы — копировать, если нужно хранить). */
    run(re, im) {
      const P = 15, Q = 32, yr = this.yr, yi = this.yi, c = this.c15, s = this.s15;
      for (let n2 = 0; n2 < Q; n2++) {
        for (let k1 = 0; k1 < P; k1++) {
          let a = 0, b = 0;
          for (let n1 = 0; n1 < P; n1++) {
            const xr = re[n2 + Q * n1], xi = im[n2 + Q * n1], w = k1 * P + n1;
            a += xr * c[w] - xi * s[w]; b += xr * s[w] + xi * c[w];
          }
          const t = n2 * P + k1, wr = this.tc[t], wi = this.ts[t];
          yr[t] = a * wr - b * wi; yi[t] = a * wi + b * wr;
        }
      }
      for (let k1 = 0; k1 < P; k1++) {
        const br = this.br, bi = this.bi;
        for (let n2 = 0; n2 < Q; n2++) { br[n2] = yr[n2 * P + k1]; bi[n2] = yi[n2 * P + k1]; }
        this.f32.run(br, bi, false);
        for (let k2 = 0; k2 < Q; k2++) { this.or[k1 + P * k2] = br[k2]; this.oi[k1 + P * k2] = bi[k2]; }
      }
      return [this.or, this.oi];
    }
  }

  /** Потоковый пересчёт частоты (оконный sinc, окно Блэкмана), любое отношение частот.
   * Ядро заранее посчитано для PHASES дробных сдвигов — без тригонометрии на каждом отсчёте. */
  class Resampler {
    constructor(fromRate, toRate, taps = 32) {
      const PH = 256, cut = Math.min(1, toRate / fromRate) * 0.92, T = taps;
      this.step = fromRate / toRate;            // шаг по входу на один выходной отсчёт
      this.taps = T; this.PH = PH;
      this.kern = new Float32Array((PH + 1) * 2 * T);
      for (let ph = 0; ph <= PH; ph++) {
        const f = ph / PH;
        for (let k = -T + 1; k <= T; k++) {
          const t = k - f, w = 0.42 + 0.5 * Math.cos(Math.PI * t / T) + 0.08 * Math.cos(TWO_PI * t / T);
          this.kern[ph * 2 * T + k + T - 1] = (t === 0 ? cut : Math.sin(Math.PI * t * cut) / (Math.PI * t)) * w;
        }
      }
      this.buf = new Float32Array(4096); this.len = 0;
      this.pos = T;                              // позиция следующего выходного отсчёта во входе
    }
    process(x) {
      if (this.len + x.length > this.buf.length) {
        const nb = new Float32Array(2 * (this.len + x.length)); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
      }
      this.buf.set(x, this.len); this.len += x.length;
      const T = this.taps, buf = this.buf, K = this.kern, PH = this.PH;
      const out = new Float32Array(Math.max(0, Math.ceil((this.len - T - this.pos) / this.step) + 1));
      let n = 0;
      while (this.pos + T < this.len) {
        const c = Math.floor(this.pos), base = Math.round((this.pos - c) * PH) * 2 * T, s0 = c - T + 1;
        let acc = 0;
        for (let j = 0; j < 2 * T; j++) acc += buf[s0 + j] * K[base + j];
        out[n++] = acc;
        this.pos += this.step;
      }
      const drop = Math.max(0, Math.floor(this.pos) - T);
      buf.copyWithin(0, drop, this.len); this.len -= drop; this.pos -= drop;
      return out.subarray(0, n);
    }
  }

  /** Синтез 24 кГц: импульсы на периодах тона, шум, постфильтр. push() кадра t отдаёт звук кадра t-1. */
  class Synth {
    /** rand — источник случайных чисел [0, 1) (для проверки — заданная последовательность). */
    constructor(irWindow, rand = Math.random) {
      this.win = Float64Array.from(irWindow);
      this.rand = rand;
      this.phase = rand();
      this.pending = null;
      this.per = new Float64Array(HOP + IRN);
      this.noise = new Float64Array(2 * HOP);
      this.out = new Float64Array(HOP + 1024);
      this.f512 = new FFT(512); this.f1024 = new FFT(1024);
      this.re = new Float64Array(1024); this.im = new Float64Array(1024);
      this.hann = new Float64Array(2 * HOP).map((_, i) => 0.5 - 0.5 * Math.cos(TWO_PI * i / (2 * HOP)));
      this.f480 = new FFT480();  // шум: ДПФ длины 480, как torch.stft n_fft=480
      this.phases = null;
    }
    _exc() { const e = new Float64Array(HOP); for (let i = 0; i < HOP; i++) e[i] = this.rand() - 0.5; return e; }
    _phases(start, hz) {
      const f = hz / 24000, p = new Float64Array(HOP);
      for (let i = 0; i < HOP; i++) p[i] = (start + (i + 1) * f) % 1;
      return p;
    }
    /** ИХ импульса из параметров кадра с дробной задержкой frac (в отсчётах). */
    _ir(ir, frac) {
      const re = this.re, im = this.im, n = IRN, h = n / 2;
      for (let k = 0; k <= h; k++) {
        const amp = Math.exp(ir[k]);
        let ph = (k === 0 || k === h) ? 0 : ir[h + k];
        if (k & 1) ph += Math.PI;
        ph += k * (-TWO_PI / n) * frac;
        re[k] = amp * Math.cos(ph); im[k] = amp * Math.sin(ph);
        if (k > 0 && k < h) { re[n - k] = re[k]; im[n - k] = -im[k]; }
      }
      this.f512.run(re, im, true);
      return re;
    }
    push(ir, ap, pf, hz) {
      const cur = { ir, ap, pf, hz };
      if (!this.pending) {
        this.pending = cur;
        const f = hz / 24000;
        this.phases = this._phases(this.phase - f, hz);
        this.exc = this._exc();
        return null;
      }
      const p = this.pending, ph = this.phases, nxt = this._phases(ph[HOP - 1], hz);
      for (let i = 0; i < HOP; i++) {
        const a = ph[i], b = i + 1 < HOP ? ph[i + 1] : nxt[0];
        if (a > b) {
          const numer = 1 - a, frac = numer / (numer + b), r = this._ir(p.ir, frac);
          for (let j = 0; j < IRN; j++) this.per[i + j] += r[j] * this.win[j];
        }
      }
      // шум: ДПФ окна возбуждения 480, умножение на ap, обратное ДПФ, окно Ханна
      const nexc = this._exc(), fr = new Float64Array(480);
      fr.set(this.exc); fr.set(nexc, HOP); this.exc = nexc;
      const [sr0, si0] = this.f480.run(fr, new Float64Array(480));
      const sr = Float64Array.from(sr0), si = Float64Array.from(si0);
      sr[0] = si[0] = 0; si[240] = 0;  // как irfft: мнимая часть на частоте Найквиста не учитывается
      for (let k = 1; k <= 240; k++) { sr[k] *= p.ap[k - 1]; si[k] *= p.ap[k - 1]; }
      for (let k = 1; k < 240; k++) { sr[480 - k] = sr[k]; si[480 - k] = -si[k]; }
      for (let k = 0; k < 480; k++) si[k] = -si[k];  // обратное ДПФ через прямое: conj(FFT(conj(X)))
      const [tr] = this.f480.run(sr, si);
      for (let t = 0; t < 480; t++) this.noise[t] += tr[t] / 480 * this.hann[t];
      // постфильтр (линейная свёртка блока 240 с фильтром 512 через БПФ 1024)
      const re = this.re, im = this.im, F = this.f1024;
      const hr = new Float64Array(1024), hi = new Float64Array(1024);
      for (let i = 0; i < 512; i++) hr[i] = p.pf[i] + (i === 0 ? 1 : 0);
      F.run(hr, hi, false);
      re.fill(0); im.fill(0);
      for (let i = 0; i < HOP; i++) re[i] = this.per[i] + this.noise[i];
      F.run(re, im, false);
      for (let k = 0; k < 1024; k++) {
        const a = re[k] * hr[k] - im[k] * hi[k], b = re[k] * hi[k] + im[k] * hr[k];
        re[k] = a; im[k] = b;
      }
      F.run(re, im, true);
      for (let i = 0; i < 1024; i++) this.out[i] += re[i];
      const y = Float32Array.from(this.out.subarray(0, HOP));
      this.per.copyWithin(0, HOP); this.per.fill(0, IRN);
      this.noise.copyWithin(0, HOP); this.noise.fill(0, HOP);
      this.out.copyWithin(0, HOP); this.out.fill(0, 1024);
      this.pending = cur; this.phases = nxt;
      return y;
    }
  }

  global.BeatriceSynth = { FFT, Resampler, Synth };
})(typeof globalThis !== 'undefined' ? globalThis : self);
