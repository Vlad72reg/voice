/* Страница «Изменение голоса»: режимы «Запись» и «Вживую», выбор устройств, настройки. */
(() => {
  'use strict';
  const { VOICES, USER_VOICES, settingsFor, levelFor } = VoiceDSP;
  const $ = (s) => document.querySelector(s);
  const MAX_SECONDS = 180;
  const sinkSupported = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

  // ---------- настройки (localStorage может быть недоступен) ----------
  const defaults = { preset: 'Мужской', userVoice: 'мужской', mode: 'record', gain: 0, mic: '', out: '', monitor: '',
    monitorOn: false };
  let state = { ...defaults };
  try { state = { ...defaults, ...JSON.parse(localStorage.getItem('voice-settings') || '{}') }; } catch (e) { /* нет хранилища */ }
  if (!VOICES[state.preset]) state.preset = defaults.preset;
  if (!USER_VOICES[state.userVoice]) state.userVoice = defaults.userVoice;
  let measuredF0 = 0;  // высота голоса, измеренная по последней записи (0 — нет)
  /** Высота голоса пользователя: по записи (режим «Запись») или из «Мой голос». */
  const userF0 = () => (state.mode === 'record' && measuredF0 > 0 ? measuredF0 : USER_VOICES[state.userVoice]);
  const p0 = settingsFor(state.preset, userF0());
  for (const k of ['pitch', 'formant', 'whisper', 'ghost']) if (state[k] === undefined) state[k] = p0[k];
  const save = () => { try { localStorage.setItem('voice-settings', JSON.stringify(state)); } catch (e) { /* ничего */ } };

  /** Настройки для движка: громкость уже с компенсацией выбранного голоса. */
  const settings = () => ({
    pitch: state.pitch, formant: state.formant, whisper: state.whisper, ghost: state.ghost,
    gain: state.gain + levelFor(state.preset, state.pitch), style: VOICES[state.preset].style || null,
  });

  // ---------- аудио ----------
  let ctx = null, node = null, stream = null, source = null;
  let monitorEl = null, monitorDest = null;
  let live = false, recording = false, recChunks = [], recSamples = 0, recTimer = null;
  let raw = null, procId = 0, resultUrl = null, resultFile = null;
  const worker = new Worker('worker.js');

  // ---------- ИИ-голос (Beatrice): «Мужской» и «Женский» считает нейросеть в фоновом потоке ----------
  // state: loading — модель загружается; on — работает; off — недоступна; slow — компьютер не успевает.
  const ai = { state: 'off', worker: null, wired: false, slow: 0 };
  /** Параметры ИИ для голоса name, если ИИ сейчас работает; иначе null (обычная обработка). */
  const aiFor = (name) => (ai.state === 'on' && VOICES[name].ai) || null;
  const aiShift = (v) => Math.max(-12, Math.min(12, 12 * Math.log2(v.hz / userF0())));

  function startAi() {
    if (typeof WebAssembly === 'undefined' || !window.Worker) return;
    ai.state = 'loading';
    ai.worker = new Worker('ai-worker.js');
    ai.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { ai.state = 'on'; wireAi(); sendConfig(); renderAi(); }
      else if (m.type === 'error' && ai.state === 'loading') { ai.state = 'off'; renderAi(); }
      else if (m.type === 'stats') onAiStats(m);
      else if (m.type === 'converted' || m.type === 'error') onAiConverted(m);
    };
    ai.worker.postMessage({ type: 'init' });
  }

  /** Ворклет и фоновый поток соединяются напрямую: звук идёт мимо главного потока. */
  function wireAi() {
    if (ai.wired || !node || ai.state !== 'on') return;
    const ch = new MessageChannel();
    node.port.postMessage({ type: 'ai-port', port: ch.port1 }, [ch.port1]);
    ai.worker.postMessage({ type: 'port', port: ch.port2, sr: ctx.sampleRate }, [ch.port2]);
    ai.wired = true;
  }

  /** Если шаг нейросети не укладывается во время звука — переходим на обычную обработку. */
  function onAiStats(m) {
    if (ai.state !== 'on' || !live) return;
    ai.slow = m.ms > 0.9 * m.budget || m.backlog > 3 ? ai.slow + 1 : Math.max(0, ai.slow - 1);
    if (ai.slow >= 4) { ai.state = 'slow'; sendConfig(); renderAi(); }
  }

  function renderAi() {
    const el = $('#ai-status'), v = VOICES[state.preset].ai;
    el.classList.toggle('warn', ai.state === 'slow');
    el.textContent = !v ? '' : {
      loading: 'ИИ-голос загружается (около 40 МБ, один раз)… Пока — обычная обработка.',
      on: 'ИИ-голос: нейросеть прямо в браузере. «Тембр» и «Шёпот» для него не действуют.',
      off: 'ИИ-голос недоступен в этом браузере — обычная обработка.',
      slow: 'Компьютер не успевает с ИИ-голосом — включена обычная обработка (перезагрузите страницу, чтобы попробовать снова).',
    }[ai.state];
  }

  const supported = !!(window.AudioWorkletNode && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!supported) {
    $('#unsupported').style.display = 'block';
    $('#rec').disabled = true;
    $('#live').disabled = true;
  }

  /**
   * Safari включает звук только синхронно в обработчике нажатия: контекст создаётся
   * и «будится» здесь, до любых await. Вызывать первой строкой обработчика клика.
   */
  function unlockAudio() {
    if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  /** iOS: «запись» пока открыт микрофон, «воспроизведение» без него (иначе прослушивание очень тихое). */
  function setAudioSession(type) {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* нет API */ }
  }

  /** Контекст, ворклет и микрофон. Микрофон открыт только пока идёт запись или живой режим. */
  async function ensureAudio() {
    unlockAudio();
    if (!node) {
      // Два обычных модуля в общей области ворклета: dsp.js задаёт VoiceDSP, processor.js его использует.
      // (Склейка в Blob-ссылку ненадёжна в старых Safari.)
      await ctx.audioWorklet.addModule('dsp.js');
      await ctx.audioWorklet.addModule('processor.js');
      node = new AudioWorkletNode(ctx, 'voice-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = onWorkletMessage;
      node.connect(ctx.destination);
      sendConfig();
    }
    if (!stream) {
      setAudioSession('play-and-record');
      await openMic();
      await refreshDevices();
      await applySink();
    }
    if (ctx.state !== 'running') await ctx.resume();
  }

  function releaseMic() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (source) source.disconnect();
    stream = source = null;
    setAudioSession('playback');
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
    if (!node) return;
    node.port.postMessage({ type: 'config', settings: settings() });
    const v = aiFor(state.preset);
    if (v) {
      wireAi();
      ai.worker.postMessage({ type: 'voice', spk: v.spk, shift: aiShift(v) });
    }
    node.port.postMessage({ type: 'ai', on: !!v, gain: v ? state.gain + v.level : 0 });
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
  for (const [name, p] of Object.entries(VOICES)) {
    const b = document.createElement('button');
    b.className = 'voice';
    b.dataset.voice = name;
    b.innerHTML = `<b>${name}</b><span>${p.hint}</span>`;
    b.addEventListener('click', () => chooseVoice(name));
    voices.appendChild(b);
  }
  // Восьмая ячейка — «Мой голос»: от него считаются сдвиги голосов.
  const me = document.createElement('div');
  me.className = 'me';
  me.innerHTML = '<span>Мой голос</span><div class="seg"><button data-user="мужской">Мужской</button>' +
    '<button data-user="женский">Женский</button></div>';
  for (const b of me.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      state.userVoice = b.dataset.user;
      measuredF0 = 0;  // выбор пользователя важнее измеренного по записи
      chooseVoice(state.preset);
    });
  }
  // «Мой голос» — сразу после обычных голосов, дальше отдельный блок призраков.
  const firstGhost = voices.querySelector('.voice[data-voice="Глухой бас"]');
  voices.insertBefore(me, firstGhost);
  const ghostTitle = document.createElement('div');
  ghostTitle.className = 'group-title';
  ghostTitle.textContent = 'Призраки';
  voices.insertBefore(ghostTitle, firstGhost);

  const sliders = {
    pitch: (v) => (v > 0 ? '+' : '') + v.toFixed(1),
    formant: (v) => v.toFixed(2),
    whisper: (v) => v.toFixed(2),
    gain: (v) => (v > 0 ? '+' : '') + v.toFixed(1),
  };

  function render() {
    renderAi();
    for (const b of voices.querySelectorAll('.voice')) b.setAttribute('aria-pressed', b.dataset.voice === state.preset);
    for (const b of me.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.user === state.userVoice);
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
    // Голос задан целевой высотой — сдвиг считается от высоты голоса пользователя.
    const p = settingsFor(name, userF0());
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
    unlockAudio();  // синхронно, пока действует нажатие (Safari)
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
    releaseMic();  // на iPhone при открытом микрофоне прослушивание идёт очень тихо
    const audio = new Float32Array(recSamples);
    let pos = 0;
    for (const c of recChunks) { audio.set(c, pos); pos += c.length; }
    recChunks = [];
    if (audio.length < ctx.sampleRate / 4) {
      $('#rec-status').textContent = 'Запись слишком короткая — попробуйте ещё раз.';
      return;
    }
    raw = audio;
    measureThenProcess(audio);
  }

  /** Высота голоса по записи (YIN, в фоне) -> голос пересчитывается под неё -> обработка. */
  function measureThenProcess(audio) {
    const id = ++procId;
    $('#rec-status').textContent = 'Определяю высоту вашего голоса…';
    worker.onmessage = (e) => {
      if (e.data.id !== procId || audio !== raw) return;
      measuredF0 = e.data.f0;
      if (measuredF0 > 0) state.userVoice = measuredF0 >= 160 ? 'женский' : 'мужской';
      chooseVoice(state.preset);  // ползунки под измеренный голос -> processRecording()
    };
    worker.postMessage({ id, type: 'measure', audio, sr: ctx.sampleRate });
  }

  function processRecording() {
    const id = ++procId;
    setResult(null);
    const v = aiFor(state.preset);
    if (v) {
      $('#rec-status').textContent = 'Обработка нейросетью…';
      ai.worker.postMessage({ type: 'convert', id, audio: raw, sr: ctx.sampleRate, spk: v.spk, shift: aiShift(v),
        gain: state.gain + v.level });
      return;
    }
    $('#rec-status').textContent = 'Обработка…';
    worker.postMessage({ id, audio: raw, sr: ctx.sampleRate, settings: settings(), voice: state.preset });
    worker.onmessage = (e) => {
      if (e.data.id !== procId) return;  // пока считали, настройки уже сменили
      const name = `Голос — ${state.preset}.wav`;
      const blob = new Blob([e.data.wav], { type: 'audio/wav' });
      setResult(blob, name);
      const yours = measuredF0 > 0 ? ` Ваш голос по записи: ${Math.round(measuredF0)} Гц.` : '';
      $('#rec-status').textContent = `Готово: «${state.preset}», ${Math.round(e.data.seconds)} с.${yours} ` +
        'Прослушайте, скачайте или отправьте. Можно выбрать другой голос — запись пересчитается.';
    };
  }

  function onAiConverted(m) {
    if (m.id !== procId) return;
    if (m.type === 'error') { ai.state = 'off'; renderAi(); processRecording(); return; }
    const name = `Голос — ${state.preset}.wav`;
    setResult(new Blob([m.wav], { type: 'audio/wav' }), name);
    const yours = measuredF0 > 0 ? ` Ваш голос по записи: ${Math.round(measuredF0)} Гц.` : '';
    $('#rec-status').textContent = `Готово: «${state.preset}» (ИИ-голос), ${Math.round(m.seconds)} с.${yours} ` +
      'Прослушайте, скачайте или отправьте. Можно выбрать другой голос — запись пересчитается.';
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
    if (on && ai.worker && ai.state === 'on') ai.worker.postMessage({ type: 'reset' });
    if (node) node.port.postMessage({ type: 'live', on });
    const btn = $('#live');
    btn.textContent = on ? 'Выключить' : 'Включить';
    btn.classList.toggle('on', on);
    if (ctx) await updateMonitor();
    if (!on) releaseMic();
  }
  $('#live').addEventListener('click', () => {
    if (!live) unlockAudio();  // синхронно, пока действует нажатие (Safari)
    setLive(!live);
  });

  // ---------- устройства ----------
  $('#mic').addEventListener('change', async (e) => {
    state.mic = e.target.value;
    save();
    if (stream) { try { await openMic(); } catch (err) { micError(err); } }  // переоткрываем, только если он сейчас открыт
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
  startAi();
})();
