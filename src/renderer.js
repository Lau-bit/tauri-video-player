'use strict';

// ==============================
// Per-instance ephemeral state
// ==============================
const state = {
  filePath: null,
  folderFiles: [],
  folderIndex: -1,
  loop: false,
  autoSwitch: false,
  autoplaySwitched: true,
  noUI: false,
  zoomFill: false,
  panX: 50,
  panY: 50,
  zoomFillPrevNoUI: false,
  uiHideTimer: null,
  playbackRate: 1,
  tempFile: null,           // path of current transcoded temp file
  transcodeCancel: null,    // cleanup fn for transcode-progress listener
  pausedForHiddenWindow: false,
  closing: false,
  sectionLoop: false,
  sectionStart: 0,
  sectionEnd: 0,
  stripAudio: false,        // strip audio from saved A-B cut — resets on restart (never persisted)
  cropActive: false,        // A-B crop framing overlay shown
  crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, // normalized (0-1) crop rect, relative to the video frame
};

// A crop is (re)set to this centered 80% inset each time a new file loads.
function defaultCrop() {
  return { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Per-video section positions remembered within the session (filePath → {start, end})
const sectionPositions = new Map();

const UI_HIDE_DELAY = 350; // ms — how long after mouse leaves before controls hide
const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 2;
const PLAYBACK_RATE_STEP = 0.05;
let loadSequence = 0;

// ==============================
// DOM References
// ==============================
const video         = document.getElementById('video');
const seekbar       = document.getElementById('seekbar');
const volumeBar     = document.getElementById('volume-bar');
const speedBar      = document.getElementById('speed-bar');
const btnPlay       = document.getElementById('btn-play');
const btnLoop       = document.getElementById('btn-loop');
const btnAutoSwitch = document.getElementById('btn-auto-switch');
const btnAutoplaySwitched = document.getElementById('btn-autoplay-switched');
const btnSpeedDown  = document.getElementById('btn-speed-down');
const btnSpeedReset = document.getElementById('btn-speed-reset');
const btnSpeedUp    = document.getElementById('btn-speed-up');
const speedBarMarker = document.querySelector('.speed-bar-marker');
const btnPrev       = document.getElementById('btn-prev');
const btnNext       = document.getElementById('btn-next');
const btnOpen       = document.getElementById('btn-open');
const btnOpenEmpty  = document.getElementById('btn-open-empty');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnMute       = document.getElementById('btn-mute');
const btnMinimize   = document.getElementById('btn-minimize');
const btnMaximize   = document.getElementById('btn-maximize');
const btnClose      = document.getElementById('btn-close');
const btnEditor     = document.getElementById('btn-editor');
const timeDisplay   = document.getElementById('time-display');
const filenameDisplay = document.getElementById('filename-display');
const playerContainer = document.getElementById('player-container');
const controls      = document.getElementById('controls');
const transcodeMsg  = document.getElementById('transcode-msg');
const transcodeBar  = document.getElementById('transcode-bar');
const transcodePct  = document.getElementById('transcode-pct');
const btnCancelTranscode  = document.getElementById('btn-cancel-transcode');
const btnSectionLoop      = document.getElementById('btn-section-loop');
const btnCrop             = document.getElementById('btn-crop');
const btnStripAudio       = document.getElementById('btn-strip-audio');
const btnSaveSection      = document.getElementById('btn-save-section');
const cropOverlay         = document.getElementById('crop-overlay');
const cropBox             = document.getElementById('crop-box');
const saveMsg             = document.getElementById('save-msg');
const sectionMarkers      = document.getElementById('section-markers');
const sectionMarkerStart  = document.getElementById('section-marker-start');
const sectionMarkerEnd    = document.getElementById('section-marker-end');
const sectionRegion       = document.getElementById('section-region');
const sectionDragTooltip  = document.getElementById('section-drag-tooltip');

// ==============================
// Maximize Button State
// ==============================
async function updateMaximizeBtn(isMax) {
  // □ = maximize, ⧉ = restore
  btnMaximize.textContent = isMax ? '\u29C9' : '\u25A1';
  btnMaximize.title = isMax ? 'Restore' : 'Maximize';
}

window.videoAPI.isMaximized().then(updateMaximizeBtn);
window.videoAPI.onMaximizeChange(updateMaximizeBtn);

const titlebarDrag = document.getElementById('titlebar-drag');
titlebarDrag.addEventListener('mousedown', (e) => {
  if (e.button === 0) window.videoAPI.startWindowDrag();
});

// ==============================
// Editor Button
// ==============================
let editorPath = null;

async function loadEditorPath() {
  editorPath = await window.videoAPI.getEditorPath();
  btnEditor.classList.toggle('has-editor', !!editorPath);
  btnEditor.title = editorPath
    ? `Open Video Editor: ${editorPath}\n(right-click to change)`
    : 'Set Video Editor (right-click to configure)';
}

async function browseAndSetEditor() {
  const picked = await window.videoAPI.browseEditor();
  if (!picked) return;
  await window.videoAPI.setEditorPath(picked);
  editorPath = picked;
  btnEditor.classList.add('has-editor');
  btnEditor.title = `Open Video Editor: ${picked}\n(right-click to change)`;
}

loadEditorPath();

let autoplaySwitchedManualChanges = 0;

function applyAutoplaySwitched(value) {
  state.autoplaySwitched = value;
  btnAutoplaySwitched.classList.toggle('active', state.autoplaySwitched);
}

async function loadAutoplaySwitchedSetting() {
  const manualChangesAtLoadStart = autoplaySwitchedManualChanges;
  try {
    const savedValue = await window.videoAPI.getAutoplaySwitched();
    if (manualChangesAtLoadStart === autoplaySwitchedManualChanges) {
      applyAutoplaySwitched(savedValue ?? true);
    }
  } catch {
    if (manualChangesAtLoadStart === autoplaySwitchedManualChanges) {
      applyAutoplaySwitched(true);
    }
  }
}

applyAutoplaySwitched(state.autoplaySwitched);
loadAutoplaySwitchedSetting();

// ==============================
// Load File
// ==============================
async function loadFile(filePath, forcePlay = false) {
  if (!filePath) return;
  const sequence = ++loadSequence;

  // Cancel any running transcode and clean up its temp file
  if (state.transcodeCancel) { state.transcodeCancel(); state.transcodeCancel = null; }
  await window.videoAPI.cancelTranscode();
  document.body.classList.remove('transcoding');
  if (state.tempFile) {
    window.videoAPI.cleanupTemp(state.tempFile);
    state.tempFile = null;
  }

  // Save section positions for the video we're leaving
  if (state.sectionLoop && state.filePath) {
    sectionPositions.set(state.filePath, { start: state.sectionStart, end: state.sectionEnd });
  }

  state.filePath = filePath;

  // Crop rect is resolution/framing-specific — start every new video fresh.
  state.crop = defaultCrop();
  if (state.cropActive) exitCrop();

  // Restore or reset section positions for the incoming video
  if (state.sectionLoop) {
    const saved = sectionPositions.get(filePath);
    state.sectionStart = saved ? saved.start : 0;
    state.sectionEnd   = saved ? saved.end   : 0; // 0 = unknown until loadedmetadata
  }

  // Get all video files in the same folder (natural sort, from main process)
  state.folderFiles = await window.videoAPI.getFolderFiles(filePath);
  state.folderIndex = state.folderFiles.indexOf(filePath);

  // Convert to safe file:// URL (handles Windows backslashes, spaces, Unicode)
  const fileUrl = await window.videoAPI.getFileUrl(filePath);

  updateTimelineDisplay();
  video.src = fileUrl;
  video.load();
  video.playbackRate = state.playbackRate;

  // Extract just the filename for display
  const name = filePath.replace(/\\/g, '/').split('/').pop();
  filenameDisplay.textContent = name;
  document.title = name + ' — Video Player';

  document.body.classList.add('has-video');

  if (forcePlay || state.autoplaySwitched) {
    playVideoWhenReady(sequence);
  }
}

// ==============================
// Folder Navigation
// ==============================
let lastNavTime = 0;
const NAV_INTERVAL = 100; // ms — max 10 items/second

function navigateFolder(delta) {
  if (!state.folderFiles.length) return;
  const now = Date.now();
  if (now - lastNavTime < NAV_INTERVAL) return;
  lastNavTime = now;
  const next = state.folderIndex + delta;
  if (next < 0 || next >= state.folderFiles.length) return;
  loadFile(state.folderFiles[next]);
}

// ==============================
// Play / Pause
// ==============================
function togglePlayPause() {
  if (!video.src) return;
  if (video.paused) {
    if (state.sectionLoop && isFinite(video.duration) && video.currentTime >= state.sectionEnd - 0.1) {
      video.currentTime = state.sectionStart;
      video.addEventListener('seeked', () => video.play().catch(() => {}), { once: true });
    } else {
      playVideoWhenReady();
    }
  } else {
    video.pause();
  }
}

function updatePlayBtn() {
  btnPlay.textContent = video.paused ? '\u25B6' : '\u23F8';
}

function playVideoWhenReady(sequence = loadSequence) {
  if (!video.src) return;

  const play = () => {
    if (sequence !== loadSequence) return;
    video.play().catch(() => {});
  };

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    play();
    return;
  }

  video.addEventListener('loadeddata', play, { once: true });
}

// ==============================
// Timeline Display
// ==============================
function updateTimelineDisplay() {
  const duration = video.duration;
  const currentTime = video.currentTime;

  if (!duration || !isFinite(duration)) {
    seekbar.value = 0;
    seekbar.style.setProperty('--seek-fill', '0%');
    timeDisplay.textContent = '0:00 / 0:00';
    return;
  }

  const pct = (currentTime / duration) * 100;
  seekbar.value = Math.round((currentTime / duration) * 10000);
  seekbar.style.setProperty('--seek-fill', pct.toFixed(2) + '%');
  timeDisplay.textContent = formatTime(currentTime) + ' / ' + formatTime(duration);
}

// ==============================
// Playback Speed
// ==============================
function clampPlaybackRate(rate) {
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate));
}

function formatPlaybackRate(rate) {
  return Number(rate.toFixed(2)).toString() + 'x';
}

function updateSpeedControls(skipSliderUpdate = false) {
  if (!skipSliderUpdate) {
    speedBar.value = state.playbackRate.toFixed(2);
  }
  btnSpeedReset.textContent = formatPlaybackRate(state.playbackRate);
  btnSpeedReset.classList.toggle('active', state.playbackRate !== 1);
  btnSpeedDown.disabled = state.playbackRate <= MIN_PLAYBACK_RATE;
  btnSpeedUp.disabled = state.playbackRate >= MAX_PLAYBACK_RATE;

  const pct = ((state.playbackRate - MIN_PLAYBACK_RATE) / (MAX_PLAYBACK_RATE - MIN_PLAYBACK_RATE)) * 100;
  speedBar.style.setProperty('--speed-fill', pct.toFixed(2) + '%');
}

function setPlaybackRate(rate, fromSlider = false) {
  state.playbackRate = Number(clampPlaybackRate(rate).toFixed(2));
  video.playbackRate = state.playbackRate;
  updateSpeedControls(fromSlider);
}

function adjustPlaybackRate(delta) {
  setPlaybackRate(state.playbackRate + delta);
}

// ==============================
// Loop
// ==============================
// Native video.loop must stay OFF while an A-B section is active: the browser
// seeks to 0 (the true start) when playback hits video.duration, which bypasses
// the section boundaries entirely. When a section is set, looping is handled
// manually by the timeupdate/ended logic so the markers are always respected.
function applyLoopMode() {
  video.loop = state.loop && !state.sectionLoop;
}

function toggleLoop() {
  state.loop = !state.loop;
  applyLoopMode();
  btnLoop.classList.toggle('active', state.loop);
}

// ==============================
// Section Loop (A-B)
// ==============================
function updateSectionMarkers() {
  if (!isFinite(video.duration) || video.duration === 0) return;
  const startPct = (state.sectionStart / video.duration) * 100;
  const endPct   = (state.sectionEnd   / video.duration) * 100;
  sectionMarkerStart.style.left = startPct.toFixed(3) + '%';
  sectionMarkerEnd.style.left   = endPct.toFixed(3)   + '%';
  sectionRegion.style.left      = startPct.toFixed(3) + '%';
  sectionRegion.style.width     = (endPct - startPct).toFixed(3) + '%';
}

function enableSectionLoop() {
  const dur   = isFinite(video.duration) ? video.duration : 0;
  const saved = sectionPositions.get(state.filePath);
  if (saved) {
    state.sectionStart = saved.start;
    state.sectionEnd   = dur > 0 ? Math.min(saved.end, dur) : saved.end;
  } else {
    state.sectionStart = 0;
    state.sectionEnd   = dur;
  }
  state.sectionLoop = true;
  applyLoopMode();
  document.body.classList.add('section-loop-active');
  btnSectionLoop.classList.add('active');
  updateSectionMarkers();
}

function disableSectionLoop() {
  if (state.filePath) {
    sectionPositions.set(state.filePath, { start: state.sectionStart, end: state.sectionEnd });
  }
  state.sectionLoop = false;
  applyLoopMode();
  document.body.classList.remove('section-loop-active');
  btnSectionLoop.classList.remove('active');
  if (state.cropActive) exitCrop(); // crop controls live inside the A-B group
}

function toggleSectionLoop() {
  if (state.sectionLoop) {
    disableSectionLoop();
  } else {
    enableSectionLoop();
  }
}

// ==============================
// A-B Crop (framing overlay)
// ==============================
// The crop rect (state.crop) is stored normalized to the video frame (0-1), so it
// is display-independent. The overlay is positioned over the letterboxed content
// rect (object-fit: contain), so those normalized coords map straight onto it.
function getContentRect() {
  const cw = playerContainer.clientWidth;
  const ch = playerContainer.clientHeight;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.min(cw / vw, ch / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { left: (cw - w) / 2, top: (ch - h) / 2, width: w, height: h };
}

function positionCropBox() {
  cropBox.style.left   = (state.crop.x * 100).toFixed(3) + '%';
  cropBox.style.top    = (state.crop.y * 100).toFixed(3) + '%';
  cropBox.style.width  = (state.crop.w * 100).toFixed(3) + '%';
  cropBox.style.height = (state.crop.h * 100).toFixed(3) + '%';
}

function updateCropOverlay() {
  if (!state.cropActive) return;
  const rect = getContentRect();
  cropOverlay.style.left   = rect.left + 'px';
  cropOverlay.style.top    = rect.top + 'px';
  cropOverlay.style.width  = rect.width + 'px';
  cropOverlay.style.height = rect.height + 'px';
  positionCropBox();
}

function startCropDrag(mode, handle) {
  return (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = cropOverlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...state.crop };
    const minW = Math.min(0.5, 24 / rect.width);   // min box size, in normalized units
    const minH = Math.min(0.5, 24 / rect.height);

    const onMove = (ev) => {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      if (mode === 'move') {
        state.crop.x = clamp(orig.x + dx, 0, 1 - orig.w);
        state.crop.y = clamp(orig.y + dy, 0, 1 - orig.h);
      } else {
        let left = orig.x, top = orig.y, right = orig.x + orig.w, bottom = orig.y + orig.h;
        if (handle.includes('w')) left   = clamp(orig.x + dx, 0, right - minW);
        if (handle.includes('e')) right  = clamp(right + dx, left + minW, 1);
        if (handle.includes('n')) top    = clamp(orig.y + dy, 0, bottom - minH);
        if (handle.includes('s')) bottom = clamp(bottom + dy, top + minH, 1);
        state.crop.x = left;
        state.crop.y = top;
        state.crop.w = right - left;
        state.crop.h = bottom - top;
      }
      positionCropBox();
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
}

function enterCrop() {
  state.cropActive = true;
  document.body.classList.add('crop-active');
  btnCrop.classList.add('active');
  updateCropOverlay();
}

function exitCrop() {
  state.cropActive = false;
  document.body.classList.remove('crop-active');
  btnCrop.classList.remove('active');
}

function toggleCrop() {
  if (state.cropActive) {
    exitCrop();
  } else {
    enterCrop();
  }
}

// Resolve the crop for saving as fractions (0-1) of the video frame. Fractions (not
// pixels) go to the backend so ffmpeg evaluates them against the coded frame — correct
// even for anamorphic sources — and forces even dimensions itself. Returns null when
// the rect covers (essentially) the whole frame, so a full-frame "crop" saves via
// lossless stream-copy instead of a pointless re-encode.
function computeCrop() {
  if (!video.videoWidth || !video.videoHeight) return null;
  let { x, y, w, h } = state.crop;
  x = clamp(x, 0, 1);
  y = clamp(y, 0, 1);
  w = clamp(w, 0, 1 - x);
  h = clamp(h, 0, 1 - y);
  if (w <= 0 || h <= 0) return null;
  if (x <= 0.002 && y <= 0.002 && w >= 0.998 && h >= 0.998) return null;
  return { x, y, w, h };
}

// ==============================
// Strip Audio (save option)
// ==============================
function toggleStripAudio() {
  state.stripAudio = !state.stripAudio;
  btnStripAudio.classList.toggle('active', state.stripAudio);
}

// ==============================
// Switch / Autoplay
// ==============================
function toggleAutoSwitch() {
  state.autoSwitch = !state.autoSwitch;
  btnAutoSwitch.classList.toggle('active', state.autoSwitch);
}

async function toggleAutoplaySwitched() {
  autoplaySwitchedManualChanges += 1;
  const next = !state.autoplaySwitched;
  applyAutoplaySwitched(next);
  await window.videoAPI.setAutoplaySwitched(next).catch(() => {});
}

// ==============================
// UI Visibility (hover show/hide)
// ==============================
function showUI() {
  clearTimeout(state.uiHideTimer);
  if (state.noUI || state.zoomFill) return;
  document.body.classList.add('ui-visible');
}

function scheduleHideUI() {
  clearTimeout(state.uiHideTimer);
  state.uiHideTimer = setTimeout(() => {
    document.body.classList.remove('ui-visible');
  }, UI_HIDE_DELAY);
}

// ==============================
// No-UI Mode (Shift+Q)
// ==============================
function toggleNoUI() {
  state.noUI = !state.noUI;
  document.body.classList.toggle('no-ui', state.noUI);
  if (!state.noUI) {
    showUI();
    scheduleHideUI();
  } else {
    clearTimeout(state.uiHideTimer);
    document.body.classList.remove('ui-visible');
  }
}

// ==============================
// Zoom-to-Fill Mode
// ==============================
function applyPan() {
  video.style.setProperty('--pan-x', state.panX.toFixed(2) + '%');
  video.style.setProperty('--pan-y', state.panY.toFixed(2) + '%');
}

function recenterPan() {
  state.panX = 50;
  state.panY = 50;
  applyPan();
}

function enterZoomFill() {
  state.zoomFillPrevNoUI = state.noUI;
  state.zoomFill = true;
  clearTimeout(state.uiHideTimer);
  document.body.classList.remove('ui-visible');
  document.body.classList.add('zoom-fill');
  applyPan();
}

function exitZoomFill() {
  state.zoomFill = false;
  isPanning = false;
  document.body.classList.remove('zoom-fill');
  document.body.classList.remove('panning');
  if (!state.zoomFillPrevNoUI) {
    showUI();
    scheduleHideUI();
  }
}

function toggleZoomFill() {
  if (state.zoomFill) {
    exitZoomFill();
  } else {
    enterZoomFill();
  }
}

// ==============================
// Time Formatting
// ==============================
function formatTime(secs) {
  if (!isFinite(secs) || isNaN(secs)) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ==============================
// Mute Button
// ==============================
function updateMuteBtn() {
  if (video.muted || video.volume === 0) {
    btnMute.textContent = '\uD83D\uDD07'; // 🔇
  } else if (video.volume < 0.5) {
    btnMute.textContent = '\uD83D\uDD09'; // 🔉
  } else {
    btnMute.textContent = '\uD83D\uDD0A'; // 🔊
  }
}

// ==============================
// Open File Dialog
// ==============================
async function openFileDialog() {
  const filePath = await window.videoAPI.openFile();
  if (filePath) loadFile(filePath);
}

// ==============================
// Passive / Minimized State
// ==============================
async function cancelActiveTranscode(message) {
  if (!state.transcodeCancel && !document.body.classList.contains('transcoding')) return;

  if (state.transcodeCancel) {
    state.transcodeCancel();
    state.transcodeCancel = null;
  }

  await window.videoAPI.cancelTranscode();
  document.body.classList.remove('transcoding');

  if (message) {
    filenameDisplay.textContent = message;
  }
}

async function enterHiddenWindowState() {
  if (state.closing) return;

  if (video.src && !video.paused && !video.ended) {
    state.pausedForHiddenWindow = true;
    video.pause();
  }

  await cancelActiveTranscode('Transcode cancelled while minimized');
}

function leaveHiddenWindowState() {
  if (state.closing) return;
  if (!state.pausedForHiddenWindow) return;
  state.pausedForHiddenWindow = false;
  if (video.src) {
    playVideoWhenReady();
  }
}

// ==============================
// Video Event Listeners
// ==============================
video.addEventListener('play', updatePlayBtn);
video.addEventListener('pause', updatePlayBtn);
video.addEventListener('emptied', updateTimelineDisplay);
video.addEventListener('loadedmetadata', () => {
  updateTimelineDisplay();
  if (state.sectionLoop) {
    if (state.sectionEnd === 0) state.sectionEnd = video.duration;
    updateSectionMarkers();
  }
  updateCropOverlay(); // video dimensions now known — realign the crop content rect
});
video.addEventListener('durationchange', updateTimelineDisplay);
video.addEventListener('timeupdate', updateTimelineDisplay);
video.addEventListener('timeupdate', () => {
  if (!state.sectionLoop || !isFinite(video.duration)) return;
  if (video.currentTime >= state.sectionEnd) {
    if (state.loop) {
      video.currentTime = state.sectionStart;
    } else {
      video.currentTime = state.sectionEnd;
      video.pause();
    }
  }
});
video.addEventListener('seeked', updateTimelineDisplay);

video.addEventListener('ended', () => {
  // Native video.loop handles whole-video looping; this fires when it's off,
  // including section+loop (native loop is suppressed during sections) where
  // the section end coincides with the true end of the video.
  if (state.sectionLoop && state.loop) {
    video.currentTime = state.sectionStart;
    video.play().catch(() => {});
    return;
  }
  if (state.autoSwitch) {
    navigateFolder(1);
  }
});

video.addEventListener('error', async () => {
  const err = video.error;
  if (!err) return;

  let detail = '';

  // Ask the main process to read the file's actual codec info (MP4/MOV box parser)
  if (state.filePath) {
    const codecs = await window.videoAPI.getCodecInfo(state.filePath);
    if (codecs && codecs.length) detail = codecs.join(', ');
  }

  // MediaError codes: 1=aborted, 2=network, 3=decode, 4=not supported
  let msg;
  if (err.code === 4) {
    msg = detail ? `Unsupported codec: ${detail}` : 'Unsupported format or codec';
  } else if (err.code === 3) {
    msg = detail ? `Decode error (${detail})` : 'Corrupted file or unsupported codec';
  } else if (err.code === 2) {
    msg = 'Network error loading video';
    filenameDisplay.textContent = '\u26A0 ' + msg;
    return;
  } else {
    msg = detail || 'Cannot play this video';
  }

  filenameDisplay.textContent = '\u26A0 ' + msg;

  // Auto-transcode via ffmpeg for codec/format errors
  if (err.code === 3 || err.code === 4) {
    startTranscode();
  }
});

// ==============================
// ffmpeg Transcoding
// ==============================
async function startTranscode() {
  if (!state.filePath) return;

  transcodeMsg.textContent = 'Transcoding with ffmpeg\u2026';
  transcodeBar.style.width = '0%';
  transcodePct.textContent = '0%';
  document.body.classList.add('transcoding');

  if (state.transcodeCancel) state.transcodeCancel();
  state.transcodeCancel = window.videoAPI.onTranscodeProgress((pct) => {
    transcodeBar.style.width = pct + '%';
    transcodePct.textContent = pct + '%';
  });

  const result = await window.videoAPI.transcodeFile(state.filePath);

  if (state.transcodeCancel) { state.transcodeCancel(); state.transcodeCancel = null; }
  document.body.classList.remove('transcoding');

  if (!result || result.cancelled) return;

  if (result.success) {
    state.tempFile = result.outputPath;
    const fileUrl = await window.videoAPI.getFileUrl(result.outputPath);
    const sequence = ++loadSequence;
    updateTimelineDisplay();
    video.src = fileUrl;
    video.load();
    video.playbackRate = state.playbackRate;
    playVideoWhenReady(sequence);
  } else {
    filenameDisplay.textContent = '\u26A0 Transcode failed: ' + (result.error || 'unknown error');
  }
}

btnCancelTranscode.addEventListener('click', async () => {
  if (state.transcodeCancel) { state.transcodeCancel(); state.transcodeCancel = null; }
  await window.videoAPI.cancelTranscode();
  document.body.classList.remove('transcoding');
});

video.addEventListener('volumechange', updateMuteBtn);
video.addEventListener('ratechange', () => {
  if (video.playbackRate !== state.playbackRate) {
    setPlaybackRate(video.playbackRate);
  }
});

// Play/pause on click (pointer-events:none on controls when hidden means clicks land here)
// Long holds/drags (300+ms) are intentionally ignored.
let videoPointerDownAt = 0;
video.addEventListener('pointerdown', () => { videoPointerDownAt = Date.now(); });
video.addEventListener('click', () => {
  if (state.zoomFill && panMoved) return;
  if (Date.now() - videoPointerDownAt <= 300) togglePlayPause();
});


// ==============================
// Seekbar
// ==============================
let isScrubbing = false;

seekbar.addEventListener('mousedown', () => { isScrubbing = true; });

seekbar.addEventListener('input', () => {
  if (!video.duration || !isFinite(video.duration)) return;
  let t = (seekbar.value / 10000) * video.duration;
  if (state.sectionLoop) {
    t = Math.max(state.sectionStart, Math.min(state.sectionEnd, t));
  }
  video.currentTime = t;
});

document.addEventListener('mouseup', () => { isScrubbing = false; });

// ==============================
// Volume
// ==============================
volumeBar.addEventListener('input', () => {
  video.volume = volumeBar.value / 100;
  video.muted = video.volume === 0;
});

btnMute.addEventListener('click', () => {
  video.muted = !video.muted;
  if (video.muted) {
    volumeBar.value = 0;
  } else {
    // Restore to current volume or default
    volumeBar.value = Math.round(video.volume * 100) || 100;
    if (video.volume === 0) video.volume = 1;
  }
});

// ==============================
// Playback Speed
// ==============================
speedBar.addEventListener('input', () => {
  setPlaybackRate(Number(speedBar.value), true);
});

btnSpeedDown.addEventListener('click', () => adjustPlaybackRate(-PLAYBACK_RATE_STEP));
btnSpeedUp.addEventListener('click', () => adjustPlaybackRate(PLAYBACK_RATE_STEP));
btnSpeedReset.addEventListener('click', () => setPlaybackRate(1));
speedBarMarker.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  let moved = false;

  const onMove = (moveEvent) => {
    if (!moved && Math.abs(moveEvent.clientX - startX) < 4) return;
    moved = true;
    const rect = speedBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width));
    const rawRate = MIN_PLAYBACK_RATE + pct * (MAX_PLAYBACK_RATE - MIN_PLAYBACK_RATE);
    const step = Number(speedBar.step);
    setPlaybackRate(Math.round(rawRate / step) * step);
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) setPlaybackRate(1);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ==============================
// Hover UI Show/Hide
// ==============================
playerContainer.addEventListener('mouseenter', showUI);
playerContainer.addEventListener('mousemove', showUI);
playerContainer.addEventListener('mouseleave', scheduleHideUI);

const titlebar = document.getElementById('titlebar');
titlebar.addEventListener('mouseenter', () => clearTimeout(state.uiHideTimer));
titlebar.addEventListener('mouseleave', scheduleHideUI);

// ==============================
// Zoom-to-Fill Pan (mouse drag)
// ==============================
let isPanning = false;
let panMoved = false;
let panLastX = 0;
let panLastY = 0;

playerContainer.addEventListener('mousedown', (e) => {
  if (!state.zoomFill || e.button !== 0) return;
  isPanning = true;
  panMoved = false;
  panLastX = e.clientX;
  panLastY = e.clientY;
  document.body.classList.add('panning');
});

document.addEventListener('mousemove', (e) => {
  if (!isPanning) return;
  const dx = e.clientX - panLastX;
  const dy = e.clientY - panLastY;
  panLastX = e.clientX;
  panLastY = e.clientY;
  if (Math.abs(dx) > 0 || Math.abs(dy) > 0) panMoved = true;

  const rect = playerContainer.getBoundingClientRect();
  const videoAspect = (video.videoWidth || 16) / (video.videoHeight || 9);
  const containerAspect = rect.width / rect.height;

  if (videoAspect > containerAspect) {
    // Video wider than container — horizontal overflow, pan X only
    const renderedW = rect.height * videoAspect;
    const overflow = Math.max(0.01, renderedW - rect.width);
    state.panX = Math.max(0, Math.min(100, state.panX - dx / overflow * 100));
  } else {
    // Video taller than container — vertical overflow, pan Y only
    const renderedH = rect.width / videoAspect;
    const overflow = Math.max(0.01, renderedH - rect.height);
    state.panY = Math.max(0, Math.min(100, state.panY - dy / overflow * 100));
  }

  applyPan();
});

document.addEventListener('mouseup', () => {
  if (isPanning) {
    isPanning = false;
    document.body.classList.remove('panning');
  }
});

// ==============================
// Button Click Handlers
// ==============================
function startSectionMarkerDrag(isStart) {
  return (e) => {
    e.preventDefault();
    e.stopPropagation();

    const onMove = (moveEvent) => {
      if (!isFinite(video.duration) || video.duration === 0) return;
      const rect = seekbar.getBoundingClientRect();
      const pct  = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width));
      const time = pct * video.duration;
      if (isStart) {
        state.sectionStart = Math.max(0, Math.min(time, state.sectionEnd - 0.25));
      } else {
        state.sectionEnd = Math.min(video.duration, Math.max(time, state.sectionStart + 0.25));
      }
      updateSectionMarkers();
      if (video.currentTime < state.sectionStart) {
        video.currentTime = state.sectionStart;
      } else if (video.currentTime > state.sectionEnd) {
        video.currentTime = state.sectionEnd;
      }
      const markerTime = isStart ? state.sectionStart : state.sectionEnd;
      sectionDragTooltip.textContent = formatTime(markerTime);
      sectionDragTooltip.style.left = ((markerTime / video.duration) * 100).toFixed(3) + '%';
      sectionDragTooltip.classList.add('visible');
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      sectionDragTooltip.classList.remove('visible');
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
}

sectionMarkerStart.addEventListener('mousedown', startSectionMarkerDrag(true));
sectionMarkerEnd.addEventListener('mousedown', startSectionMarkerDrag(false));

// Crop box: drag the body to move, drag a handle to resize.
cropBox.addEventListener('mousedown', (e) => {
  if (e.target.classList.contains('crop-handle')) return;
  startCropDrag('move')(e);
});
cropBox.querySelectorAll('.crop-handle').forEach((handle) => {
  handle.addEventListener('mousedown', startCropDrag('resize', handle.dataset.handle));
});

// Keep the crop overlay aligned with the letterboxed video as the window resizes.
const cropResizeObserver = new ResizeObserver(() => updateCropOverlay());
cropResizeObserver.observe(playerContainer);

btnSaveSection.addEventListener('click', async () => {
  if (!state.filePath || !state.sectionLoop || !isFinite(video.duration)) return;

  const srcNorm = state.filePath.replace(/\\/g, '/');
  const dir     = srcNorm.includes('/') ? srcNorm.slice(0, srcNorm.lastIndexOf('/')) : '';
  const base    = srcNorm.split('/').pop();
  const stem    = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  const defaultPath = (dir ? dir + '/' : '') + stem + '_cut.mp4';

  const outputPath = await window.videoAPI.saveSectionDialog(defaultPath.replace(/\//g, '\\'));
  if (!outputPath) return;

  const crop = state.cropActive ? computeCrop() : null;
  const stripAudio = state.stripAudio;

  const prevName = filenameDisplay.textContent;
  saveMsg.textContent = crop ? 'Saving cropped A-B section…' : 'Saving A-B section…';
  document.body.classList.add('saving');
  btnSaveSection.disabled = true;

  try {
    await window.videoAPI.saveSection(
      state.filePath, state.sectionStart, state.sectionEnd, outputPath, stripAudio, crop,
    );
    const savedName = outputPath.replace(/\\/g, '/').split('/').pop();
    filenameDisplay.textContent = 'Saved: ' + savedName;
    setTimeout(() => { filenameDisplay.textContent = prevName; }, 3000);
  } catch (err) {
    filenameDisplay.textContent = '⚠ Save failed: ' + (err?.message || String(err));
    setTimeout(() => { filenameDisplay.textContent = prevName; }, 4000);
  } finally {
    document.body.classList.remove('saving');
    btnSaveSection.disabled = false;
  }
});

btnPlay.addEventListener('click', togglePlayPause);
btnLoop.addEventListener('click', toggleLoop);
btnSectionLoop.addEventListener('click', toggleSectionLoop);
btnCrop.addEventListener('click', toggleCrop);
btnStripAudio.addEventListener('click', toggleStripAudio);
btnAutoSwitch.addEventListener('click', toggleAutoSwitch);
btnAutoplaySwitched.addEventListener('click', toggleAutoplaySwitched);
btnPrev.addEventListener('click', () => navigateFolder(-1));
btnNext.addEventListener('click', () => navigateFolder(1));
btnOpen.addEventListener('click', openFileDialog);
btnOpenEmpty.addEventListener('click', openFileDialog);
btnMinimize.addEventListener('click', async () => {
  await enterHiddenWindowState();
  window.videoAPI.minimize();
});
btnMaximize.addEventListener('click', () => window.videoAPI.maximize());
btnClose.addEventListener('click', () => {
  state.closing = true;
  window.videoAPI.close();
});

btnEditor.addEventListener('click', async () => {
  if (!editorPath) {
    await browseAndSetEditor();
  } else {
    window.videoAPI.openEditor();
  }
});

btnEditor.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  await browseAndSetEditor();
});

btnFullscreen.addEventListener('click', () => {
  window.videoAPI.toggleFullscreen();
});

// ==============================
// Keyboard Shortcuts
// ==============================
document.addEventListener('keydown', async (e) => {
  // Let range inputs handle their own arrow keys only when focused
  const focused = document.activeElement;
  const isRangeInput = focused === seekbar || focused === volumeBar || focused === speedBar;

  // Never steal from text inputs (none expected, but defensive)
  if (focused && focused.tagName === 'INPUT' && focused.type !== 'range') return;

  // Blur any focused UI control on keyboard shortcuts to prevent focus ring highlights.
  // Volume/speed bars keep focus only when navigated with their own arrow keys.
  if (focused && focused !== document.body) {
    const keepFocus = isRangeInput &&
      (focused === volumeBar || focused === speedBar) &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown');
    if (!keepFocus) focused.blur();
  }

  switch (true) {
    case e.code === 'Space' && !e.shiftKey && !e.ctrlKey && !e.metaKey: {
      e.preventDefault();
      togglePlayPause();
      break;
    }

    case (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey: {
      e.preventDefault();
      window.videoAPI.toggleFullscreen();
      break;
    }

    case e.shiftKey && (e.key === 'Q' || e.key === 'q'): {
      e.preventDefault();
      toggleNoUI();
      break;
    }

    case e.key === 'ArrowLeft' && focused !== volumeBar && focused !== speedBar: {
      e.preventDefault();
      const leftMin = state.sectionLoop ? state.sectionStart : 0;
      video.currentTime = Math.max(leftMin, video.currentTime - 5);
      break;
    }

    case e.key === 'ArrowRight' && focused !== volumeBar && focused !== speedBar: {
      e.preventDefault();
      if (isFinite(video.duration)) {
        const rightMax = state.sectionLoop ? state.sectionEnd : video.duration;
        video.currentTime = Math.min(rightMax, video.currentTime + 5);
      }
      break;
    }

    case e.key === 'ArrowUp' && !isRangeInput: {
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.1);
      volumeBar.value = Math.round(video.volume * 100);
      video.muted = false;
      break;
    }

    case e.key === 'ArrowDown' && !isRangeInput: {
      e.preventDefault();
      video.volume = Math.max(0, video.volume - 0.1);
      volumeBar.value = Math.round(video.volume * 100);
      break;
    }

    case e.key === '[' && !e.ctrlKey && !e.metaKey: {
      e.preventDefault();
      adjustPlaybackRate(-PLAYBACK_RATE_STEP);
      break;
    }

    case e.key === ']' && !e.ctrlKey && !e.metaKey: {
      e.preventDefault();
      adjustPlaybackRate(PLAYBACK_RATE_STEP);
      break;
    }

    case e.key === '0' && !e.ctrlKey && !e.metaKey: {
      e.preventDefault();
      setPlaybackRate(1);
      break;
    }

    case e.key === 'n' || e.key === 'N': {
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        navigateFolder(1);
      }
      break;
    }

    case e.key === 'b' || e.key === 'B': {
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        navigateFolder(-1);
      }
      break;
    }

    case e.key === 'l' || e.key === 'L': {
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleLoop();
      }
      break;
    }

    case (e.key === 'a' || e.key === 'A') && e.shiftKey: {
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleAutoplaySwitched();
      }
      break;
    }

    case e.key === 'a' || e.key === 'A': {
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleAutoSwitch();
      }
      break;
    }

    case e.key === 'm' || e.key === 'M': {
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        video.muted = !video.muted;
        if (video.muted) {
          volumeBar.value = 0;
        } else {
          volumeBar.value = Math.round(video.volume * 100) || 100;
          if (video.volume === 0) video.volume = 1;
        }
      }
      break;
    }

    case e.key === 'z' || e.key === 'Z': {
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleZoomFill();
      }
      break;
    }

    case e.key === 'x' || e.key === 'X': {
      if (!e.ctrlKey && !e.metaKey && state.zoomFill) {
        e.preventDefault();
        recenterPan();
      }
      break;
    }

    case e.key === 'Escape': {
      const isFS = await window.videoAPI.isFullscreen();
      if (isFS) {
        window.videoAPI.toggleFullscreen();
      } else if (state.zoomFill) {
        exitZoomFill();
      } else if (state.noUI) {
        toggleNoUI();
      }
      break;
    }
  }
});

// ==============================
// Drag-and-Drop
// ==============================
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.body.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  // Only remove the class if leaving the window entirely
  if (!e.relatedTarget) {
    document.body.classList.remove('drag-over');
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.body.classList.remove('drag-over');

  const VIDEO_EXTS = /\.(mp4|webm|mov|mkv|avi|flv|m4v|wmv|ts|mpg|mpeg|3gp)$/i;
  const files = Array.from(e.dataTransfer.files);
  // Electron exposes File.path with the absolute filesystem path
  const videoFile = files.find(f => VIDEO_EXTS.test(f.name) && f.path);
  if (videoFile) {
    loadFile(videoFile.path, true);
  }
});

document.addEventListener('visibilitychange', () => {
  if (state.closing) return;

  if (document.visibilityState === 'hidden') {
    enterHiddenWindowState();
  } else {
    leaveHiddenWindowState();
  }
});

window.addEventListener('pagehide', () => {
  state.closing = true;
});

window.addEventListener('beforeunload', () => {
  state.closing = true;
});

window.videoAPI.onTauriDragEnter(() => {
  document.body.classList.add('drag-over');
});

window.videoAPI.onTauriDragLeave(() => {
  document.body.classList.remove('drag-over');
});

window.videoAPI.onTauriDragDrop((payload) => {
  document.body.classList.remove('drag-over');

  const VIDEO_EXTS = /\.(mp4|webm|mov|mkv|avi|flv|m4v|wmv|ts|mpg|mpeg|3gp)$/i;
  const paths = Array.isArray(payload?.paths) ? payload.paths : [];
  const videoFile = paths.find(p => VIDEO_EXTS.test(p));
  if (videoFile) {
    loadFile(videoFile, true);
  }
});

// ==============================
// CLI / File Association
// ==============================
// Main process sends this after did-finish-load if a file was passed on CLI
window.videoAPI.onOpenFile((filePath) => {
  loadFile(filePath, true);
});

window.videoAPI.getInitialFile().then((filePath) => {
  if (filePath) loadFile(filePath, true);
});

setPlaybackRate(1);
