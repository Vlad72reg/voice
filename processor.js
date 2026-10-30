/*
 * AudioWorklet: микрофон -> (запись сырого звука) -> обработка -> выход.
 * app.js сначала загружает в ворклет dsp.js (он задаёт VoiceDSP в общей области), потом этот файл.
 */
class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new VoiceDSP.VoiceEngine(sampleRate);
    this.live = false;
    this.recording = false;
    this.peakIn = 0;
    this.peakOut = 0;
    this.frames = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'config') this.engine.configure(m.settings);
      else if (m.type === 'live') this.live = m.on;
      else if (m.type === 'record') this.recording = m.on;
    };
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
    if (this.live) this.engine.process(input, output, input.length);
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
