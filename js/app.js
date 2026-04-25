/**
 * SoundToAdio — Local Web Audio Recorder & Mixer
 * Vanilla JS, Web Audio API, MediaRecorder, no dependencies.
 */

/* ── 0. Constants & Defaults ──────────────────────────────── */

const COOKIE_NAME = 'soundtoadio_settings';
const COOKIE_DAYS = 180;

const DEFAULT_SETTINGS = {
  enableSystemAudio:  false,
  micDeviceId:        'default',
  micGain:            1,
  sysGain:            1,
  masterGain:         1,
  bitrate:            24000,
  format:             'audio/webm;codecs=opus',
  filenamePrefix:     'recording',
  noiseSuppression:   true,
  echoCancellation:   true,
  autoGainControl:    true,
  showViz:            true,
};

const STATES = Object.freeze({
  IDLE:       'idle',
  RECORDING:  'recording',
  PROCESSING: 'processing',
  READY:      'ready',
  ERROR:      'error',
});

const EQ_BARS      = 48;
const EQ_SMOOTHING = 0.8;
const EQ_FFT_SIZE  = 1024;

const VALID_BITRATES = [24000, 32000, 64000, 128000];
const VALID_FORMATS  = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'];

/* ── 1. SettingsManager ───────────────────────────────────── */

const SettingsManager = (() => {
  function load() {
    let raw = {};
    try {
      const cookie = document.cookie
        .split(';')
        .map(c => c.trim())
        .find(c => c.startsWith(COOKIE_NAME + '='));
      if (cookie) {
        raw = JSON.parse(decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1)));
      }
    } catch (_) {
      // corrupt cookie — start fresh
    }

    const s = { ...DEFAULT_SETTINGS };

    if (typeof raw.enableSystemAudio === 'boolean') s.enableSystemAudio = raw.enableSystemAudio;
    if (typeof raw.micDeviceId === 'string' && raw.micDeviceId) s.micDeviceId = raw.micDeviceId;
    if (typeof raw.micGain === 'number')    s.micGain    = Math.min(2, Math.max(0, raw.micGain));
    if (typeof raw.sysGain === 'number')    s.sysGain    = Math.min(2, Math.max(0, raw.sysGain));
    if (typeof raw.masterGain === 'number') s.masterGain = Math.min(2, Math.max(0, raw.masterGain));
    if (VALID_BITRATES.includes(raw.bitrate)) s.bitrate = raw.bitrate;
    if (VALID_FORMATS.includes(raw.format))   s.format  = raw.format;
    if (typeof raw.filenamePrefix === 'string') {
      s.filenamePrefix = sanitizeFilenamePrefix(raw.filenamePrefix) || 'recording';
    }
    if (typeof raw.noiseSuppression === 'boolean') s.noiseSuppression = raw.noiseSuppression;
    if (typeof raw.echoCancellation === 'boolean') s.echoCancellation = raw.echoCancellation;
    if (typeof raw.autoGainControl === 'boolean')  s.autoGainControl  = raw.autoGainControl;
    if (typeof raw.showViz === 'boolean') s.showViz = raw.showViz;

    return s;
  }

  function save(settings) {
    const value = encodeURIComponent(JSON.stringify(settings));
    document.cookie =
      `${COOKIE_NAME}=${value};` +
      `max-age=${COOKIE_DAYS * 86400};` +
      `path=/;SameSite=Lax`;
  }

  return { load, save };
})();

/* ── 2. DeviceManager ─────────────────────────────────────── */

const DeviceManager = (() => {
  async function populateMicDevices(savedDeviceId) {
    const select = document.getElementById('opt-mic-device');
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (_) {
      return;
    }
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    if (audioInputs.length === 0) return;

    // Preserve current selection if still valid
    const currentVal = select.value;

    // Clear and repopulate
    select.innerHTML = '';
    let foundSaved = false;
    audioInputs.forEach((device, i) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId || 'default';
      opt.textContent = device.label || `Microphone ${i + 1}`;
      select.appendChild(opt);
      if (device.deviceId === savedDeviceId) foundSaved = true;
    });

    // Restore selection
    if (foundSaved) {
      select.value = savedDeviceId;
    } else if (select.querySelector(`option[value="${currentVal}"]`)) {
      select.value = currentVal;
    }
    // else: first option is selected by default
  }

  function buildMicConstraints(settings) {
    const deviceId = settings.micDeviceId && settings.micDeviceId !== 'default'
      ? { exact: settings.micDeviceId }
      : undefined;

    return {
      audio: {
        ...(deviceId ? { deviceId } : {}),
        noiseSuppression: settings.noiseSuppression,
        echoCancellation: settings.echoCancellation,
        autoGainControl:  settings.autoGainControl,
        channelCount: 1,
      },
      video: false,
    };
  }

  return { populateMicDevices, buildMicConstraints };
})();

/* ── 3. AudioGraph ────────────────────────────────────────── */

const AudioGraph = (() => {
  let ctx = null;
  let micGainNode    = null;
  let sysGainNode    = null;
  let masterGainNode = null;
  let analyserNode   = null;
  let destNode       = null;
  let allStreams      = [];

  async function build(micStream, sysStream, settings) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const localCtx = ctx; // capture now so teardown() nulling ctx doesn't break callbacks
    console.debug('[AudioGraph] AudioContext created. state=', localCtx.state, 'sampleRate=', localCtx.sampleRate);
    // AudioContext created after an `await` may start suspended (autoplay policy).
    if (localCtx.state === 'suspended') {
      console.debug('[AudioGraph] Context suspended — awaiting resume()');
      await localCtx.resume();
      console.debug('[AudioGraph] resume() resolved, state=', localCtx.state);
    }
    localCtx.onstatechange = () => console.debug('[AudioGraph] ctx.state changed ->', localCtx.state);
    allStreams = [];

    const merger = localCtx.createChannelMerger(2);

    // Microphone branch
    if (micStream) {
      allStreams.push(micStream);
      const tracks = micStream.getAudioTracks();
      console.debug('[AudioGraph] micStream audio tracks:', tracks.length,
        tracks.map(t => `${t.label} enabled=${t.enabled} readyState=${t.readyState}`));
      const micSource = localCtx.createMediaStreamSource(micStream);
      micGainNode = localCtx.createGain();
      micGainNode.gain.value = settings.micGain;
      micSource.connect(micGainNode);
      micGainNode.connect(merger, 0, 0);
    } else {
      console.warn('[AudioGraph] No micStream provided');
    }

    // System audio branch
    if (sysStream) {
      allStreams.push(sysStream);
      const tracks = sysStream.getAudioTracks();
      console.debug('[AudioGraph] sysStream audio tracks:', tracks.length,
        tracks.map(t => `${t.label} enabled=${t.enabled} readyState=${t.readyState}`));
      const sysSource = localCtx.createMediaStreamSource(sysStream);
      sysGainNode = localCtx.createGain();
      sysGainNode.gain.value = settings.sysGain;
      sysSource.connect(sysGainNode);
      sysGainNode.connect(merger, 0, 1);
    }

    // Master gain — enforce mono downmix
    masterGainNode = localCtx.createGain();
    masterGainNode.gain.value = settings.masterGain;
    masterGainNode.channelCount = 1;
    masterGainNode.channelCountMode = 'explicit';
    masterGainNode.channelInterpretation = 'speakers';
    merger.connect(masterGainNode);

    // Analyser
    analyserNode = localCtx.createAnalyser();
    analyserNode.fftSize = EQ_FFT_SIZE;
    analyserNode.smoothingTimeConstant = EQ_SMOOTHING;
    masterGainNode.connect(analyserNode);
    console.debug('[AudioGraph] Analyser: fftSize=', analyserNode.fftSize,
      'frequencyBinCount=', analyserNode.frequencyBinCount);

    // Destination (MediaStream for MediaRecorder)
    destNode = localCtx.createMediaStreamDestination();
    analyserNode.connect(destNode);
    const destTracks = destNode.stream.getAudioTracks();
    console.debug('[AudioGraph] destNode stream audio tracks:', destTracks.length,
      destTracks.map(t => `${t.label} enabled=${t.enabled} readyState=${t.readyState}`));

    return { analyser: analyserNode, destination: destNode };
  }

  function updateGains(micGain, sysGain, masterGain) {
    if (micGainNode)    micGainNode.gain.value    = micGain;
    if (sysGainNode)    sysGainNode.gain.value    = sysGain;
    if (masterGainNode) masterGainNode.gain.value = masterGain;
  }

  function teardown() {
    allStreams.forEach(stream => {
      stream.getTracks().forEach(t => t.stop());
    });
    allStreams = [];
    if (ctx && ctx.state !== 'closed') {
      ctx.close().catch(() => {});
    }
    ctx = null;
    micGainNode    = null;
    sysGainNode    = null;
    masterGainNode = null;
    analyserNode   = null;
    destNode       = null;
  }

  function isActive() { return ctx !== null && ctx.state !== 'closed'; }

  return { build, updateGains, teardown, isActive };
})();

/* ── 4. RecorderManager ───────────────────────────────────── */

const RecorderManager = (() => {
  let mediaRecorder = null;
  let chunks = [];

  function resolveMimeType(preferred) {
    const candidates = [
      preferred,
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      '',
    ];
    for (const type of candidates) {
      if (type === '' || MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  function start(stream, settings) {
    chunks = [];
    const mimeType = resolveMimeType(settings.format);
    const opts = { audioBitsPerSecond: settings.bitrate };
    if (mimeType) opts.mimeType = mimeType;
    console.debug('[Recorder] Starting. mimeType=', mimeType || '(browser default)',
      'bitrate=', settings.bitrate);
    const streamTracks = stream.getAudioTracks();
    console.debug('[Recorder] stream audio tracks:', streamTracks.length,
      streamTracks.map(t => `${t.label} enabled=${t.enabled} readyState=${t.readyState}`));
    mediaRecorder = new MediaRecorder(stream, opts);
    console.debug('[Recorder] MediaRecorder created. state=', mediaRecorder.state,
      'mimeType=', mediaRecorder.mimeType);
    mediaRecorder.ondataavailable = e => {
      console.debug('[Recorder] ondataavailable size=', e.data?.size, 'chunks so far=', chunks.length + (e.data?.size > 0 ? 1 : 0));
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onerror = e => console.error('[Recorder] MediaRecorder error:', e.error);
    mediaRecorder.start(250);
    console.debug('[Recorder] start() called. state=', mediaRecorder.state);
  }

  function stop() {
    return new Promise((resolve, reject) => {
      if (!mediaRecorder) {
        reject(new Error('No active recorder'));
        return;
      }
      mediaRecorder.onerror = e => reject(e.error || new Error('MediaRecorder error'));
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        chunks = [];
        resolve(blob);
      };
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      } else {
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        chunks = [];
        resolve(blob);
      }
    });
  }

  function isActive() {
    return mediaRecorder !== null && mediaRecorder.state === 'recording';
  }

  return { start, stop, isActive, resolveMimeType };
})();

/* ── 5. Visualizer ────────────────────────────────────────── */

const Visualizer = (() => {
  let rafId    = null;
  let canvas   = null;
  let ctx2d    = null;
  let analyser = null;
  let dataArr  = null;

  const COLOR_ACTIVE   = '#3d9af5';
  const COLOR_INACTIVE = '#1e3a5f';
  const COLOR_BG       = '#0f1117';

  let _debugFrameCount = 0;

  function init(analyserNode) {
    try {
      canvas   = document.getElementById('eq-canvas');
      // Sync the canvas pixel buffer to its CSS display size so bars fill it correctly.
      canvas.width  = canvas.offsetWidth  || 640;
      canvas.height = canvas.offsetHeight || 120;
      ctx2d    = canvas.getContext('2d');
      analyser = analyserNode;
      dataArr  = new Uint8Array(analyser.frequencyBinCount);
      _debugFrameCount = 0;
      canvas.classList.remove('eq-canvas--inactive');
      console.debug('[Visualizer] init ok. canvas size=', canvas.width, 'x', canvas.height,
        'binCount=', analyser.frequencyBinCount);
    } catch (e) {
      console.warn('[Visualizer] init failed:', e);
      canvas = null;
    }
  }

  function start() {
    if (!ctx2d || !analyser) {
      console.warn('[Visualizer] start() skipped — ctx2d=', !!ctx2d, 'analyser=', !!analyser);
      return;
    }
    console.debug('[Visualizer] start() — beginning animation loop');
    _drawFrame();
  }

  function _drawFrame() {
    rafId = requestAnimationFrame(_drawFrame);
    try {
      analyser.getByteFrequencyData(dataArr);

      // Log a sample of frequency data every ~60 frames (~1 second)
      _debugFrameCount++;
      if (_debugFrameCount % 60 === 0) {
        const max = Math.max(...dataArr);
        const avg = (dataArr.reduce((s, v) => s + v, 0) / dataArr.length).toFixed(1);
        console.debug('[Visualizer] frame', _debugFrameCount, '— freq max=', max, 'avg=', avg,
          '(all zero = no audio flowing)');
      }

      const w = canvas.width;
      const h = canvas.height;
      const barW = Math.floor(w / EQ_BARS);
      const gap  = Math.max(1, Math.floor(barW * 0.15));

      ctx2d.fillStyle = COLOR_BG;
      ctx2d.fillRect(0, 0, w, h);

      for (let i = 0; i < EQ_BARS; i++) {
        // Sample frequency data at proportional index
        const dataIndex = Math.floor(i * dataArr.length / EQ_BARS);
        const value = dataArr[dataIndex] / 255;
        const barH  = Math.max(2, Math.round(value * h));
        const x     = i * barW + gap / 2;
        const bw    = barW - gap;

        // Gradient colour: brighter at peak
        const alpha = 0.5 + value * 0.5;
        ctx2d.fillStyle = value > 0.01
          ? `rgba(61,154,245,${alpha})`
          : COLOR_INACTIVE;
        ctx2d.fillRect(x, h - barH, bw, barH);
      }
    } catch (e) {
      stop();
    }
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    // Draw final resting state
    try {
      if (ctx2d && canvas) {
        const w = canvas.width;
        const h = canvas.height;
        const barW = Math.floor(w / EQ_BARS);
        const gap  = Math.max(1, Math.floor(barW * 0.15));
        ctx2d.fillStyle = COLOR_BG;
        ctx2d.fillRect(0, 0, w, h);
        for (let i = 0; i < EQ_BARS; i++) {
          ctx2d.fillStyle = COLOR_INACTIVE;
          ctx2d.fillRect(i * barW + gap / 2, h - 2, barW - gap, 2);
        }
        canvas.classList.add('eq-canvas--inactive');
      }
    } catch (_) {}
  }

  function reset() {
    stop();
    try {
      if (ctx2d && canvas) {
        ctx2d.fillStyle = COLOR_BG;
        ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      }
    } catch (_) {}
    analyser = null;
    dataArr  = null;
  }

  return { init, start, stop, reset };
})();

/* ── 6. Timer ─────────────────────────────────────────────── */

const Timer = (() => {
  let intervalId = null;
  let startTime  = 0;
  let el         = null;

  function init(element) { el = element; }

  function start() {
    startTime = Date.now();
    el.hidden = false;
    _tick();
    intervalId = setInterval(_tick, 1000);
  }

  function _tick() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    el.textContent = `${mm}:${ss}`;
  }

  function stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function reset() {
    stop();
    if (el) {
      el.textContent = '00:00';
      el.hidden = true;
    }
  }

  return { init, start, stop, reset };
})();

/* ── 7. StateMachine ──────────────────────────────────────── */

const StateMachine = (() => {
  let current     = STATES.IDLE;
  let downloadUrl = null;
  let downloadFilename = null;

  // DOM refs cached on init
  let startBtn, stopBtn, downloadBtn;
  let stateBadge, statusText, progressBar;
  let recorderError, vizCard, timer;

  function init() {
    startBtn      = document.getElementById('start-btn');
    stopBtn       = document.getElementById('stop-btn');
    downloadBtn   = document.getElementById('download-btn');
    stateBadge    = document.getElementById('state-badge');
    statusText    = document.getElementById('status-text');
    progressBar   = document.getElementById('progress-bar');
    recorderError = document.getElementById('recorder-error');
    vizCard       = document.getElementById('viz-card');
    timer         = document.getElementById('timer');
  }

  function transition(state, opts = {}) {
    current = state;
    _apply(state, opts);
  }

  function _apply(state, { message = '', errorMsg = '', url = null, filename = null } = {}) {
    // Clear previous error unless we're explicitly setting one
    if (state !== STATES.ERROR && !errorMsg) {
      recorderError.hidden   = true;
      recorderError.textContent = '';
    }

    switch (state) {
      case STATES.IDLE:
        _btn(startBtn, true);
        _btn(stopBtn,  false);
        _btn(downloadBtn, false);
        _badge('badge--undownloaded', 'Idle');
        statusText.textContent = 'Ready to record';
        progressBar.hidden = true;
        break;

      case STATES.RECORDING:
        _btn(startBtn, false);
        _btn(stopBtn,  true);
        _btn(downloadBtn, false);
        _badge('badge--loading', 'Recording');
        statusText.textContent = 'Recording\u2026';
        progressBar.hidden = true;
        break;

      case STATES.PROCESSING:
        _btn(startBtn, false);
        _btn(stopBtn,  false);
        _btn(downloadBtn, false);
        _badge('badge--loading', 'Processing\u2026');
        statusText.textContent = message || 'Finalizing recording\u2026';
        progressBar.hidden = false;
        break;

      case STATES.READY:
        _btn(startBtn, true);
        _btn(stopBtn,  false);
        _btn(downloadBtn, true);
        _badge('badge--cached', 'Ready');
        statusText.textContent = message || 'Recording ready';
        progressBar.hidden = true;
        if (url && filename) {
          downloadUrl      = url;
          downloadFilename = filename;
        }
        break;

      case STATES.ERROR:
        _btn(startBtn, true);
        _btn(stopBtn,  false);
        _btn(downloadBtn, false);
        _badge('badge--error', 'Error');
        statusText.textContent = '';
        progressBar.hidden = true;
        if (errorMsg) {
          recorderError.textContent = errorMsg;
          recorderError.hidden = false;
        }
        break;
    }
  }

  function _btn(btn, enabled) {
    btn.disabled = !enabled;
    btn.setAttribute('aria-disabled', String(!enabled));
  }

  function _badge(cls, text) {
    stateBadge.className = `badge ${cls}`;
    stateBadge.textContent = text;
  }

  function get()              { return current; }
  function getDownloadUrl()   { return downloadUrl; }
  function getDownloadName()  { return downloadFilename; }

  return { init, transition, get, getDownloadUrl, getDownloadName };
})();

/* ── 8. OptionsController ─────────────────────────────────── */

const OptionsController = (() => {
  let settings = {};
  let graphActive = false;

  function init(savedSettings) {
    settings = { ...savedSettings };
    _applyToDOM();
    _bindAll();
    _toggleVizCard();
  }

  function _applyToDOM() {
    _set('opt-enable-system',      'checked',  settings.enableSystemAudio);
    _set('opt-mic-device',         'value',    settings.micDeviceId);
    _set('opt-mic-gain',           'value',    settings.micGain);
    _set('opt-sys-gain',           'value',    settings.sysGain);
    _set('opt-master-gain',        'value',    settings.masterGain);
    _set('opt-bitrate',            'value',    settings.bitrate);
    _set('opt-format',             'value',    settings.format);
    _set('opt-filename-prefix',    'value',    settings.filenamePrefix);
    _set('opt-noise-suppression',  'checked',  settings.noiseSuppression);
    _set('opt-echo-cancel',        'checked',  settings.echoCancellation);
    _set('opt-agc',                'checked',  settings.autoGainControl);
    _set('opt-show-viz',           'checked',  settings.showViz);

    document.getElementById('opt-mic-gain-val').textContent    = Number(settings.micGain).toFixed(2);
    document.getElementById('opt-sys-gain-val').textContent    = Number(settings.sysGain).toFixed(2);
    document.getElementById('opt-master-gain-val').textContent = Number(settings.masterGain).toFixed(2);
  }

  function _set(id, prop, val) {
    const el = document.getElementById(id);
    if (el) el[prop] = val;
  }

  function _bindAll() {
    const bind = (id, key, transform) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        settings[key] = transform(el);
        SettingsManager.save(settings);
        _onSettingChanged(key, settings[key], el);
      });
    };

    bind('opt-enable-system',     'enableSystemAudio', el => el.checked);
    bind('opt-mic-device',        'micDeviceId',       el => el.value);
    bind('opt-mic-gain',          'micGain',           el => parseFloat(el.value));
    bind('opt-sys-gain',          'sysGain',           el => parseFloat(el.value));
    bind('opt-master-gain',       'masterGain',        el => parseFloat(el.value));
    bind('opt-bitrate',           'bitrate',           el => parseInt(el.value, 10));
    bind('opt-format',            'format',            el => el.value);
    bind('opt-filename-prefix',   'filenamePrefix',    el => sanitizeFilenamePrefix(el.value) || 'recording');
    bind('opt-noise-suppression', 'noiseSuppression',  el => el.checked);
    bind('opt-echo-cancel',       'echoCancellation',  el => el.checked);
    bind('opt-agc',               'autoGainControl',   el => el.checked);
    bind('opt-show-viz',          'showViz',           el => el.checked);
  }

  function _onSettingChanged(key, value, el) {
    // Update slider display values
    if (key === 'micGain')    document.getElementById('opt-mic-gain-val').textContent    = value.toFixed(2);
    if (key === 'sysGain')    document.getElementById('opt-sys-gain-val').textContent    = value.toFixed(2);
    if (key === 'masterGain') document.getElementById('opt-master-gain-val').textContent = value.toFixed(2);

    // Live gain updates while recording
    if (graphActive && (key === 'micGain' || key === 'sysGain' || key === 'masterGain')) {
      AudioGraph.updateGains(settings.micGain, settings.sysGain, settings.masterGain);
    }

    // Toggle viz card
    if (key === 'showViz') _toggleVizCard();
  }

  function _toggleVizCard() {
    const vizCard = document.getElementById('viz-card');
    if (vizCard) vizCard.hidden = !settings.showViz;
  }

  function setGraphActive(active) { graphActive = active; }
  function getSettings() { return { ...settings }; }
  function refreshMicDevices() {
    DeviceManager.populateMicDevices(settings.micDeviceId).catch(() => {});
  }

  return { init, getSettings, setGraphActive, refreshMicDevices };
})();

/* ── 9. Main Controller ───────────────────────────────────── */

// Check browser capabilities before wiring anything up
function checkBrowserCapabilities() {
  const issues = [];
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    issues.push('getUserMedia not supported — microphone recording unavailable.');
  }
  if (!window.AudioContext && !window.webkitAudioContext) {
    issues.push('Web Audio API not supported in this browser.');
  }
  if (!window.MediaRecorder) {
    issues.push('MediaRecorder not supported — cannot record audio.');
  }
  return issues;
}

async function onStartClick() {
  if (StateMachine.get() === STATES.RECORDING) return;

  const s = OptionsController.getSettings();

  // Transition immediately so user sees state change
  StateMachine.transition(STATES.RECORDING);
  Timer.start();

  let micStream = null;
  let sysStream = null;

  // 1. Microphone (required)
  try {
    const constraints = DeviceManager.buildMicConstraints(s);
    console.debug('[Start] getUserMedia constraints:', JSON.stringify(constraints));
    micStream = await navigator.mediaDevices.getUserMedia(constraints);
    const micTracks = micStream.getAudioTracks();
    console.debug('[Start] micStream obtained. tracks=', micTracks.length,
      micTracks.map(t => `"${t.label}" enabled=${t.enabled} readyState=${t.readyState}`));
    // After first permission grant, device labels become available
    OptionsController.refreshMicDevices();
  } catch (err) {
    Timer.reset();
    handlePermissionError('microphone', err);
    return;
  }

  // 2. System audio (optional — failures are non-fatal)
  if (s.enableSystemAudio) {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,   // some browsers require video:true to show the picker
        audio: true,
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
      });
      // Stop any video tracks — we only want audio
      displayStream.getVideoTracks().forEach(t => t.stop());
      if (displayStream.getAudioTracks().length > 0) {
        sysStream = displayStream;
      } else {
        showInlineWarning('System audio was not captured. Recording microphone only.');
      }
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        showInlineWarning('System audio permission denied. Recording microphone only.');
      } else if (err.name === 'NotSupportedError') {
        showInlineWarning('System audio is not supported in this browser. Recording microphone only.');
      } else {
        showInlineWarning(`System audio unavailable: ${err.message}. Recording microphone only.`);
      }
    }
  }

  // 3. Build audio graph
  let graphResult;
  try {
    graphResult = await AudioGraph.build(micStream, sysStream, s);
    OptionsController.setGraphActive(true);
  } catch (err) {
    stopAllTracks(micStream, sysStream);
    Timer.reset();
    StateMachine.transition(STATES.ERROR, { errorMsg: `Audio routing failed: ${err.message}` });
    return;
  }

  // 4. Start recorder
  try {
    RecorderManager.start(graphResult.destination.stream, s);
  } catch (err) {
    AudioGraph.teardown();
    OptionsController.setGraphActive(false);
    Timer.reset();
    StateMachine.transition(STATES.ERROR, { errorMsg: `Recorder failed to start: ${err.message}` });
    return;
  }

  // 5. Start visualizer (non-fatal)
  if (s.showViz) {
    try {
      Visualizer.init(graphResult.analyser);
      Visualizer.start();
    } catch (e) {
      console.warn('Visualizer failed:', e);
    }
  }
}

async function onStopClick() {
  if (!RecorderManager.isActive()) return;

  Visualizer.stop();
  Timer.stop();
  StateMachine.transition(STATES.PROCESSING);

  let blob;
  try {
    blob = await RecorderManager.stop();
  } catch (err) {
    AudioGraph.teardown();
    OptionsController.setGraphActive(false);
    Timer.reset();
    StateMachine.transition(STATES.ERROR, { errorMsg: `Failed to finalize recording: ${err.message}` });
    return;
  }

  AudioGraph.teardown();
  OptionsController.setGraphActive(false);

  if (!blob || blob.size === 0) {
    Timer.reset();
    StateMachine.transition(STATES.ERROR, { errorMsg: 'Recording was empty. Please try again.' });
    return;
  }

  // Revoke previous object URL to free memory
  const oldUrl = window._soundtoadioUrl;
  if (oldUrl) {
    URL.revokeObjectURL(oldUrl);
    window._soundtoadioUrl = null;
  }

  // Build filename
  const s = OptionsController.getSettings();
  const ts  = buildTimestamp();
  const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
  const prefix = s.filenamePrefix || 'recording';
  const filename = `${prefix}-${ts}.${ext}`;

  const url = URL.createObjectURL(blob);
  window._soundtoadioUrl      = url;
  window._soundtoadioFilename = filename;

  StateMachine.transition(STATES.READY, {
    url,
    filename,
    message: `Recording ready \u2014 ${formatBytes(blob.size)}`,
  });
}

function onDownloadClick() {
  const url  = StateMachine.getDownloadUrl();
  const name = StateMachine.getDownloadName();
  if (!url) return;
  const a = document.createElement('a');
  a.href     = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/* ── 10. Utilities ────────────────────────────────────────── */

function buildTimestamp() {
  const d  = new Date();
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yr}-${mo}-${dy}-${hh}${mm}${ss}`;
}

function formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function stopAllTracks(...streams) {
  streams.filter(Boolean).forEach(stream => {
    stream.getTracks().forEach(t => t.stop());
  });
}

let _warningTimeout = null;
function showInlineWarning(msg) {
  const el = document.getElementById('recorder-error');
  el.textContent = msg;
  el.hidden = false;
  if (_warningTimeout) clearTimeout(_warningTimeout);
  _warningTimeout = setTimeout(() => {
    el.hidden = true;
    el.textContent = '';
    _warningTimeout = null;
  }, 8000);
}

function handlePermissionError(source, err) {
  Visualizer.reset();
  AudioGraph.teardown();
  OptionsController.setGraphActive(false);

  let msg;
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    msg = `${capitalise(source)} permission denied. Please allow access in your browser and try again.`;
  } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
    msg = `No ${source} device was found. Please connect a microphone and try again.`;
  } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
    msg = `Could not access ${source}. It may be in use by another application.`;
  } else {
    msg = `Failed to access ${source}: ${err.message}`;
  }

  StateMachine.transition(STATES.ERROR, { errorMsg: msg });
}

function sanitizeFilenamePrefix(str) {
  return String(str)
    .replace(/[^a-zA-Z0-9_\-\s]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 64)
    .replace(/^[-_]+|[-_]+$/g, '');
}

function capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/* ── Entry point ──────────────────────────────────────────── */

(async function main() {
  // 1. Check browser capabilities
  const issues = checkBrowserCapabilities();
  if (issues.length > 0) {
    StateMachine.init();
    StateMachine.transition(STATES.ERROR, { errorMsg: issues.join(' ') });
    document.getElementById('start-btn').disabled = true;
    document.getElementById('start-btn').setAttribute('aria-disabled', 'true');
    return;
  }

  // 2. Load settings & init modules
  const settings = SettingsManager.load();

  StateMachine.init();
  Timer.init(document.getElementById('timer'));
  OptionsController.init(settings);

  // 3. Populate mic devices (labels may be hidden until permission granted)
  await DeviceManager.populateMicDevices(settings.micDeviceId).catch(() => {});

  // 4. Wire buttons
  document.getElementById('start-btn').addEventListener('click', onStartClick);
  document.getElementById('stop-btn').addEventListener('click', onStopClick);
  document.getElementById('download-btn').addEventListener('click', onDownloadClick);

  // 5. Set initial state
  StateMachine.transition(STATES.IDLE);
})();
