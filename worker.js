/* Работа в фоне, чтобы страница не подвисала: высота голоса по записи и обработка записи. */
importScripts('dsp.js');

self.onmessage = (e) => {
  const { id, type, audio, sr, settings } = e.data;
  if (type === 'measure') {
    self.postMessage({ id, f0: VoiceDSP.medianF0(audio, sr) });
    return;
  }
  const y = VoiceDSP.processAll(audio, sr, settings);
  const wav = VoiceDSP.encodeWav(y, sr);
  self.postMessage({ id, wav, seconds: audio.length / sr }, [wav]);
};
