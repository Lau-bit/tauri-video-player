# Video Player

Minimalist desktop video player built with Tauri 2 and vanilla HTML/CSS/JS. Dark theme, no native chrome, custom title bar.

## Features

- Drag-and-drop to open, or use the file picker
- Folder navigation — cycle through videos in the same directory (sorted by date)
- A-B section loop — drag markers on the seekbar to set a region, loop it, or export it via ffmpeg
  - **Crop** — drag the on-video box to frame the exported clip (re-encoded; no crop = lossless stream-copy)
  - **No Audio** — strip the audio track from the exported clip (session-only toggle, resets to off on restart)
- Auto-transcode — unsupported codecs (e.g. HEVC, AV1) trigger an automatic ffmpeg re-encode to H.264
- Playback speed control (0.25×–2×) with a drag-reset marker
- Zoom-to-fill mode with mouse panning
- Mute, volume, loop, autoplay settings
- External editor integration (right-click the editor button to configure)
- Windows file association registration script

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) (WebView2 on Windows)
- **Optional:** `ffmpeg` on PATH — required for transcoding and A-B section export

## Development

```sh
npm install
npm run dev        # tauri dev (hot-reload frontend, recompiles Rust on change)
npm run build      # tauri build — produces installer in src-tauri/target/release/bundle
npm run check      # syntax-check the JS files
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` / `→` | Seek ±5 s |
| `↑` / `↓` | Volume ±10% |
| `[` / `]` | Speed −/+ 0.05× |
| `0` | Reset speed to 1× |
| `F` | Toggle fullscreen |
| `L` | Toggle loop |
| `A` | Toggle auto-switch to next video |
| `Shift+A` | Toggle autoplay on switch |
| `N` / `B` | Next / Previous in folder |
| `M` | Toggle mute |
| `Z` | Toggle zoom-to-fill |
| `X` | Re-center pan (zoom mode) |
| `Shift+Q` | Hide all UI |
| `Esc` | Exit fullscreen / zoom / no-UI mode |

## Project Structure

```
src/
  index.html      # Single-page shell, all UI markup
  styles.css      # All styling — dark theme, layout, controls
  api.js          # window.videoAPI — thin wrapper over Tauri invoke/listen calls
  renderer.js     # All UI logic — playback, seek, drag-drop, keyboard shortcuts

src-tauri/
  src/
    lib.rs        # All Tauri commands — folder listing, ffmpeg transcode,
                  # codec detection (MP4 box parser), settings, window ops
    main.rs       # Tauri entry point (calls lib::run)
  tauri.conf.json # App config — window size, CSP, asset protocol
  Cargo.toml      # Rust dependencies
  capabilities/   # Tauri permission manifests
  icons/          # App icons for all platforms

register-windows-default-app.cmd   # Run once after building to register
                                    # the app as a selectable Windows default
                                    # for video file types
```

## Architecture Notes

- **No bundler.** The frontend is plain HTML/CSS/JS loaded directly from `src/`. Script tags in `index.html` load `api.js` then `renderer.js`.
- **IPC pattern.** `api.js` exposes `window.videoAPI` — a thin façade over `tauri.core.invoke` and `tauri.event.listen`. `renderer.js` only talks to Tauri through this object.
- **Folder cache.** The Rust backend caches directory listings for 60 s with mtime validation so rapid folder navigation doesn't hammer the filesystem.
- **Transcoding.** When the browser reports a codec error (MediaError code 3 or 4), the frontend calls `transcode_file`. Rust spawns ffmpeg, streams progress events via `video-transcode-progress`, and returns the temp output path when done. The temp file is cleaned up on close or when a new video loads.
- **Settings** are stored as JSON in the OS app-data directory (`AppHandle::path().app_data_dir()`).
