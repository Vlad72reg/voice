/* Страница «Изменение голоса»: режимы «Запись» и «Вживую», выбор устройств, настройки. */
(() => {
  'use strict';
  const { PRESETS } = VoiceDSP;
  const $ = (s) => document.querySelector(s);
  const MAX_SECONDS = 180;
  const sinkSupported = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

  // ---------- настройки (localStorage может быть недоступен) ----------
  const defaults = { preset: 'Мужской', mode: 'record', gain: 0, mic: '', out: '', monitor: '', monitorOn: false };
  let state = { ...defaults };
  try { state = { ...defaults, ...JSON.parse(localStorage.getItem('voice-settings') || '{}') }; } catch (e) { /* нет хранилища */ }
  if (!PRESETS[state.preset]) state.preset = defaults.preset;
  const p0 = PRESETS[state.preset];
  for (const k of ['pitch', 'formant', 'whisper', 'ghost']) if (state[k] === undefined) state[k] = p0[k];
  const save = () => { try { localStorage.setItem('voice-settings', JSON.stringify(state)); } catch (e) { /* ничего */ } };

  /** Настройки для движка: громкость уже с компенсацией выбранного голоса. */
  const settings = () => ({
    pitch: state.pitch, formant: state.formant, whisper: state.whisper, ghost: state.ghost,
    gain: state.gain + PRESETS[state.preset].level,
  });

  // ---------- аудио ----------
  let ctx = null, node = null, stream = null, source = null;
  let monitorEl = null, monitorDest = null;
  let live = false, recording = false, recChunks = [], recSamples = 0, recTimer = null;
  let raw = null, procId = 0, resultUrl = null, resultFile = null;
  const worker = new Worker('worker.js');

  const supported = !!(window.AudioWorkletNode && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!supported) {
    $('#unsupported').style.display = 'block';
    $('#rec').disabled = true;
    $('#live').disabled = true;
  }

  async function ensureAudio() {
    if (ctx) {
      if (ctx.state !== 'running') await ctx.resume();
      return;
    }
    ctx = new AudioContext({ latencyHint: 'interactive' });
    // В ворклете нет importScripts — склеиваем dsp.js и processor.js в один модуль.
    const [dsp, proc] = await Promise.all(['dsp.js', 'processor.js'].map((f) => fetch(f).then((r) => r.text())));
    const url = URL.createObjectURL(new Blob([dsp, '\n', proc], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    node = new AudioWorkletNode(ctx, 'voice-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = onWorkletMessage;
    node.connect(ctx.destination);
    sendConfig();
    await openMic();
    await refreshDevices();
    await applySink();
    if (ctx.state !== 'running') await ctx.resume();
  }

  async function openMic() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (source) source.disconnect();
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: state.mic ? { ...audio, deviceId: { exact: state.mic } } : audio });
    } catch (e) {
      if (!state.mic) throw e;
      state.mic = '';  // сохранённого микрофона больше нет — берём основной
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    }
    source = ctx.createMediaStreamSource(stream);
    source.connect(node);
  }

  function sendConfig() {
    if (node) node.port.postMessage({ type: 'config', settings: settings() });
  }

  function onWorkletMessage(e) {
    const m = e.data;
    if (m.type === 'chunk' && recording) {
      recChunks.push(m.data);
      recSamples += m.data.length;
      if (recSamples >= MAX_SECONDS * ctx.sampleRate) stopRecording();
    } else if (m.type === 'levels') {
      const w = (v) => Math.min(100, Math.sqrt(v) * 100) + '%';
      $('#rec-meter').style.width = recording ? w(m.in) : '0';
      $('#live-in').style.width = live ? w(m.in) : '0';
      $('#live-out').style.width = live ? w(m.out) : '0';
    }
  }

  function micError(e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    alert(denied
      ? 'Нет доступа к микрофону. Разрешите его в настройках сайта (значок замка в адресной строке) и попробуйте снова.'
      : 'Не удалось открыть микрофон: ' + (e && e.message ? e.message : e));
  }

  // ---------- устройства ----------
  async function refreshDevices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, value, def) => {
      sel.innerHTML = '';
      sel.add(new Option(def, ''));
      for (const d of list.filter((x) => x.kind === kind)) {
        if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
        sel.add(new Option(d.label || 'Устройство', d.deviceId));
      }
      sel.value = [...sel.options].some((o) => o.value === value) ? value : '';
    };
    fill($('#mic'), 'audioinput', state.mic, 'По умолчанию');
    if (!sinkSupported) {
      $('#out-block').hidden = true;
      $('#cable-hint').textContent = 'Этот браузер не умеет выбирать устройство вывода — звук идёт в динамики/наушники. ' +
        'Для звонков на компьютере используйте Chrome или Edge.';
      return;
    }
    const outs = list.filter((x) => x.kind === 'audiooutput');
    const cable = outs.find((d) => /CABLE Input/i.test(d.label));
    // Сохранённый выход без кабеля не должен перебивать найденный кабель (как в программе для ПК).
    const savedIsCable = outs.some((d) => d.deviceId === state.out && /CABLE Input/i.test(d.label));
    if (cable && !savedIsCable && !state.outChosen) state.out = cable.deviceId;
    fill($('#out'), 'audiooutput', state.out, 'По умолчанию (динамики/наушники)');
    fill($('#monitor'), 'audiooutput', state.monitor, 'По умолчанию');
    $('#monitor-on').checked = state.monitorOn;
    const hint = $('#cable-hint');
    if (cable) {
      hint.textContent = 'VB-CABLE найден. В Zoom, Discord, Telegram или OBS выберите микрофон «CABLE Output».';
      hint.classList.remove('bad');
    } else {
      hint.textContent = 'Виртуальный микрофон VB-CABLE не найден — голос пойдёт в динамики/наушники. ' +
        'Чтобы говорить изменённым голосом в Zoom и Discord, установите VB-CABLE (vb-cable.com) и обновите страницу.';
      hint.classList.add('bad');
    }
  }

  async function applySink() {
    if (!sinkSupported || !ctx) return;
    try {
      await ctx.setSinkId(state.out || '');
    } catch (e) {
      alert('Не удалось выбрать устройство вывода: ' + e.message);
    }
    await updateMonitor();
  }

  /** «Слышать себя»: копия выхода в наушники, когда основной выход — кабель. */
  async function updateMonitor() {
    const want = live && sinkSupported && state.monitorOn && state.out && state.out !== state.monitor;
    if (want && !monitorEl) {
      monitorDest = ctx.createMediaStreamDestination();
      node.connect(monitorDest);
      monitorEl = new Audio();
      monitorEl.srcObject = monitorDest.stream;
    }
    if (monitorEl) {
      if (want) {
        try {
          if (monitorEl.setSinkId) await monitorEl.setSinkId(state.monitor || '');
          await monitorEl.play();
        } catch (e) { /* не страшно: просто не будет прослушивания */ }
      } else {
        monitorEl.pause();
        node.disconnect(monitorDest);
        monitorEl = monitorDest = null;
      }
    }
  }

  // ---------- интерфейс ----------
  const voices = $('#voices');
  for (const [name, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'voice';
    b.dataset.voice = name;
    b.innerHTML = `<b>${name}</b><span>${p.hint}</span>`;
    b.addEventListener('click', () => chooseVoice(name));
    voices.appendChild(b);
  }

  const sliders = {
    pitch: (v) => (v > 0 ? '+' : '') + v.toFixed(1),
    formant: (v) => v.toFixed(2),
    whisper: (v) => v.toFixed(2),
    gain: (v) => (v > 0 ? '+' : '') + v.toFixed(1),
  };

  function render() {
    for (const b of voices.children) b.setAttribute('aria-pressed', b.dataset.voice === state.preset);
    for (const [k, fmt] of Object.entries(sliders)) {
      $('#' + k).value = state[k];
      $('#' + k + '-v').textContent = fmt(state[k]);
    }
    $('#ghost').checked = state.ghost;
    const rec = state.mode === 'record';
    $('#tab-record').setAttribute('aria-selected', rec);
    $('#tab-live').setAttribute('aria-selected', !rec);
    $('#panel-record').hidden = !rec;
    $('#panel-live').hidden = rec;
  }

  function changed(finalChange) {
    save();
    sendConfig();
    if (finalChange && raw && !recording) processRecording();
  }

  function chooseVoice(name) {
    const p = PRESETS[name];
    Object.assign(state, { preset: name, pitch: p.pitch, formant: p.formant, whisper: p.whisper, ghost: p.ghost });
    render();
    changed(true);
  }

  for (const k of Object.keys(sliders)) {
    const el = $('#' + k);
    el.addEventListener('input', () => {
      state[k] = parseFloat(el.value);
      $('#' + k + '-v').textContent = sliders[k](state[k]);
      changed(false);
    });
    el.addEventListener('change', () => changed(true));  // отпустили ползунок — пересчитать запись
  }
  $('#ghost').addEventListener('change', (e) => { state.ghost = e.target.checked; changed(true); });
  $('#reset').addEventListener('click', () => chooseVoice(state.preset));

  function setMode(mode) {
    if (mode === 'live' && recording) stopRecording();
    if (mode === 'record' && live) setLive(false);
    state.mode = mode;
    save();
    render();
  }
  $('#tab-record').addEventListener('click', () => setMode('record'));
  $('#tab-live').addEventListener('click', () => setMode('live'));

  // ---------- режим «Запись» ----------
  $('#rec').addEventListener('click', async () => {
    if (recording) { stopRecording(); return; }
    try { await ensureAudio(); } catch (e) { micError(e); return; }
    recChunks = [];
    recSamples = 0;
    raw = null;
    recording = true;
    node.port.postMessage({ type: 'record', on: true });
    $('#preview').pause();
    setResult(null);
    $('#rec-status').textContent = 'Идёт запись… Нажмите «Остановить», когда закончите.';
    const btn = $('#rec');
    btn.classList.replace('rec', 'stop');
    const t0 = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      btn.innerHTML = `■&nbsp; Остановить &nbsp;${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    recTimer = setInterval(tick, 250);
  });

  function stopRecording() {
    if (!recording) return;
    recording = false;
    node.port.postMessage({ type: 'record', on: false });
    clearInterval(recTimer);
    const btn = $('#rec');
    btn.classList.replace('stop', 'rec');
    btn.innerHTML = '●&nbsp; Записать';
    const audio = new Float32Array(recSamples);
    let pos = 0;
    for (const c of recChunks) { audio.set(c, pos); pos += c.length; }
    recChunks = [];
    if (audio.length < ctx.sampleRate / 4) {
      $('#rec-status').textContent = 'Запись слишком короткая — попробуйте ещё раз.';
      return;
    }
    raw = audio;
    processRecording();
  }

  function processRecording() {
    const id = ++procId;
    setResult(null);
    $('#rec-status').textContent = 'Обработка…';
    worker.postMessage({ id, audio: raw, sr: ctx.sampleRate, settings: settings(), voice: state.preset });
    worker.onmessage = (e) => {
      if (e.data.id !== procId) return;  // пока считали, настройки уже сменили
      const name = `Голос — ${state.preset}.wav`;
      const blob = new Blob([e.data.wav], { type: 'audio/wav' });
      setResult(blob, name);
      $('#rec-status').textContent = `Готово: «${state.preset}», ${Math.round(e.data.seconds)} с. ` +
        'Прослушайте, скачайте или отправьте. Можно выбрать другой голос — запись пересчитается.';
    };
  }

  function setResult(blob, name) {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = blob ? URL.createObjectURL(blob) : null;
    resultFile = blob ? new File([blob], name, { type: 'audio/wav' }) : null;
    const preview = $('#preview'), dl = $('#download');
    preview.hidden = !blob;
    if (blob) preview.src = resultUrl; else preview.removeAttribute('src');
    if (blob) { dl.href = resultUrl; dl.download = name; dl.removeAttribute('aria-disabled'); }
    else { dl.removeAttribute('href'); dl.setAttribute('aria-disabled', 'true'); }
    const canShare = !!(blob && navigator.canShare && navigator.canShare({ files: [resultFile] }));
    $('#share').disabled = !canShare;
  }

  $('#share').addEventListener('click', async () => {
    try {
      await navigator.share({ files: [resultFile], title: 'Изменённый голос' });
    } catch (e) {
      if (e.name !== 'AbortError') alert('Не удалось поделиться: ' + e.message + '. Скачайте файл и отправьте его вручную.');
    }
  });

  // ---------- режим «Вживую» ----------
  async function setLive(on) {
    if (on) {
      try { await ensureAudio(); } catch (e) { micError(e); return; }
    }
    live = on;
    if (node) node.port.postMessage({ type: 'live', on });
    const btn = $('#live');
    btn.textContent = on ? 'Выключить' : 'Включить';
    btn.classList.toggle('on', on);
    if (ctx) await updateMonitor();
  }
  $('#live').addEventListener('click', () => setLive(!live));

  // ---------- устройства ----------
  $('#mic').addEventListener('change', async (e) => {
    state.mic = e.target.value;
    save();
    if (ctx) { try { await openMic(); } catch (err) { micError(err); } }
  });
  $('#out').addEventListener('change', async (e) => {
    state.out = e.target.value;
    state.outChosen = true;  // выбрано вручную — больше не подставляем кабель сами
    save();
    await applySink();
  });
  $('#monitor').addEventListener('change', async (e) => { state.monitor = e.target.value; save(); await updateMonitor(); });
  $('#monitor-on').addEventListener('change', async (e) => { state.monitorOn = e.target.checked; save(); if (ctx) await updateMonitor(); });
  $('#devices').addEventListener('toggle', () => {
    if ($('#devices').open && navigator.mediaDevices) refreshDevices().catch(() => {});
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices().catch(() => {}));
  }

  render();
})();
