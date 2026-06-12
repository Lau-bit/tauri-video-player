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
  uiHideTimer: null,
  playbackRate: 1,
  tempFile: null,           // path of current transcoded temp file
  transcodeCancel: null,    // cleanup fn for transcode-progress listener
  pausedForHiddenWindow: false,
  closing: false,
};

const UI_HIDE_DELAY = 350; // ms — how long after mouse leaves before controls hide
const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 2;
const PLAYBACK_RATE_STEP = 0.05;
const AUTOPLAY_SWITCHED_STORAGE_KEY = 'video-player:autoplay-switched:v1';
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
const btnCancelTranscode = document.getElementById('btn-cancel-transcode');

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

function loadLocalAutoplaySwitchedSetting() {
  try {
    const value = localStorage.getItem(AUTOPLAY_SWITCHED_STORAGE_KEY);
    if (value === null) return null;
    return value === 'true';
  } catch {
    return null;
  }
}

function saveLocalAutoplaySwitchedSetting(value) {
  try {
    localStorage.setItem(AUTOPLAY_SWITCHED_STORAGE_KEY, String(value));
  } catch {
    // The Rust settings file is the primary persistent store.
  }
}

async function loadAutoplaySwitchedSetting() {
  const manualChangesAtLoadStart = autoplaySwitchedManualChanges;
  const localValue = loadLocalAutoplaySwitchedSetting();
  if (localValue !== null) {
    applyAutoplaySwitched(localValue);
    return;
  }

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

  state.filePath = filePath;

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
    playVideoWhenReady();
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

function updateSpeedControls() {
  speedBar.value = state.playbackRate.toFixed(2);
  btnSpeedReset.textContent = formatPlaybackRate(state.playbackRate);
  btnSpeedReset.classList.toggle('active', state.playbackRate !== 1);
  btnSpeedDown.disabled = state.playbackRate <= MIN_PLAYBACK_RATE;
  btnSpeedUp.disabled = state.playbackRate >= MAX_PLAYBACK_RATE;

  const pct = ((state.playbackRate - MIN_PLAYBACK_RATE) / (MAX_PLAYBACK_RATE - MIN_PLAYBACK_RATE)) * 100;
  speedBar.style.setProperty('--speed-fill', pct.toFixed(2) + '%');
}

function setPlaybackRate(rate) {
  state.playbackRate = Number(clampPlaybackRate(rate).toFixed(2));
  video.playbackRate = state.playbackRate;
  updateSpeedControls();
}

function adjustPlaybackRate(delta) {
  setPlaybackRate(state.playbackRate + delta);
}

// ==============================
// Loop
// ==============================
function toggleLoop() {
  state.loop = !state.loop;
  video.loop = state.loop;
  btnLoop.classList.toggle('active', state.loop);
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
  saveLocalAutoplaySwitchedSetting(next);
  await window.videoAPI.setAutoplaySwitched(next).catch(() => {});
}

// ==============================
// UI Visibility (hover show/hide)
// ==============================
function showUI() {
  clearTimeout(state.uiHideTimer);
  if (state.noUI) return;
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
video.addEventListener('loadedmetadata', updateTimelineDisplay);
video.addEventListener('durationchange', updateTimelineDisplay);
video.addEventListener('timeupdate', updateTimelineDisplay);
video.addEventListener('seeked', updateTimelineDisplay);

video.addEventListener('ended', () => {
  // video.loop handles actual looping natively; this fires if loop is off
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
video.addEventListener('click', togglePlayPause);


// ==============================
// Seekbar
// ==============================
let isScrubbing = false;

seekbar.addEventListener('mousedown', () => { isScrubbing = true; });

seekbar.addEventListener('input', () => {
  if (!video.duration || !isFinite(video.duration)) return;
  video.currentTime = (seekbar.value / 10000) * video.duration;
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
  setPlaybackRate(Number(speedBar.value));
});

btnSpeedDown.addEventListener('click', () => adjustPlaybackRate(-PLAYBACK_RATE_STEP));
btnSpeedUp.addEventListener('click', () => adjustPlaybackRate(PLAYBACK_RATE_STEP));
btnSpeedReset.addEventListener('click', () => setPlaybackRate(1));

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
// Button Click Handlers
// ==============================
btnPlay.addEventListener('click', togglePlayPause);
btnLoop.addEventListener('click', toggleLoop);
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

    case e.key === 'ArrowLeft' && !isRangeInput: {
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 5);
      break;
    }

    case e.key === 'ArrowRight' && !isRangeInput: {
      e.preventDefault();
      if (isFinite(video.duration)) {
        video.currentTime = Math.min(video.duration, video.currentTime + 5);
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

    case e.key === 'Escape': {
      const isFS = await window.videoAPI.isFullscreen();
      if (isFS) {
        window.videoAPI.toggleFullscreen();
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
