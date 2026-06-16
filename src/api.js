'use strict';

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const listen = tauri?.event?.listen;
const dialog = tauri?.dialog;
const convertFileSrc = tauri?.core?.convertFileSrc;

if (!invoke || !listen || !dialog || !convertFileSrc) {
  console.error('Tauri API is not available.');
}

const VIDEO_FILTERS = [
  {
    name: 'Video Files',
    extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'flv', 'm4v', 'wmv', 'ts', 'mpg', 'mpeg', '3gp'],
  },
  { name: 'All Files', extensions: ['*'] },
];

window.videoAPI = {
  openFile: async () => {
    const selected = await dialog.open({
      multiple: false,
      directory: false,
      filters: VIDEO_FILTERS,
    });
    return selected || null;
  },

  getFolderFiles: filePath => invoke('get_folder_files', { filePath }),
  getFileUrl: filePath => convertFileSrc(filePath),
  getCodecInfo: filePath => invoke('get_codec_info', { filePath }),

  toggleFullscreen: () => invoke('window_toggle_fullscreen'),
  isFullscreen: () => invoke('window_is_fullscreen'),
  minimize: () => invoke('window_minimize'),
  maximize: () => invoke('window_toggle_maximize'),
  isMaximized: () => invoke('window_is_maximized'),
  close: () => invoke('window_close'),
  startWindowDrag: () => invoke('window_start_drag'),

  onMaximizeChange: callback => {
    let unlisten = null;
    listen('window-maximize-changed', event => callback(event.payload)).then(fn => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  },

  getEditorPath: () => invoke('get_editor_path'),
  setEditorPath: editorPath => invoke('set_editor_path', { editorPath }),
  browseEditor: async () => {
    const selected = await dialog.open({
      title: 'Select Video Editor',
      multiple: false,
      directory: false,
      filters: [
        { name: 'Applications & Scripts', extensions: ['exe', 'vbs', 'bat', 'cmd', 'ps1', 'lnk'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return selected || null;
  },
  openEditor: () => invoke('open_editor'),

  getAutoplaySwitched: () => invoke('get_autoplay_switched'),
  setAutoplaySwitched: autoplaySwitched => invoke('set_autoplay_switched', { autoplaySwitched }),

  saveSection: (filePath, start, end, outputPath) =>
    invoke('save_section', { filePath, start, end, outputPath }),
  saveSectionDialog: defaultPath =>
    dialog.save({
      title: 'Save A-B Section',
      defaultPath,
      filters: [
        { name: 'MP4 Video', extensions: ['mp4'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    }),

  transcodeFile: filePath => invoke('transcode_file', { filePath }),
  cancelTranscode: () => invoke('cancel_transcode'),
  cleanupTemp: filePath => invoke('cleanup_temp', { filePath }),
  onTranscodeProgress: callback => {
    let unlisten = null;
    listen('video-transcode-progress', event => callback(event.payload)).then(fn => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  },

  getInitialFile: () => invoke('get_initial_file'),
  onOpenFile: callback => {
    let unlisten = null;
    listen('video-open-file', event => callback(event.payload)).then(fn => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  },
  onTauriDragEnter: callback => listen('tauri://drag-enter', event => callback(event.payload)),
  onTauriDragLeave: callback => listen('tauri://drag-leave', event => callback(event.payload)),
  onTauriDragDrop: callback => listen('tauri://drag-drop', event => callback(event.payload)),
};
