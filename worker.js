/* Обработка готовой записи в фоне, чтобы страница не подвисала. */
importScripts('dsp.js');

self.onmessage = (e) => {
  const { id, audio, sr, settings } = e.data;
  const y = VoiceDSP.processAll(audio, sr, settings);
  const wav = VoiceDSP.encodeWav(y, sr);
  self.postMessage({ id, wav, seconds: audio.length / sr }, [wav]);
};
