use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[cfg(test)]
mod tests;

const VIDEO_EXTS: &[&str] = &[
    "mp4", "webm", "mov", "mkv", "avi", "flv", "m4v", "wmv", "ts", "mpg", "mpeg", "3gp",
];
const FOLDER_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
struct FolderCacheEntry {
    created_at: Instant,
    modified: Option<SystemTime>,
    files: Vec<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    editor_path: Option<String>,
    auto_switch: Option<bool>,
    autoplay_switched: Option<bool>,
}

#[derive(Default)]
struct AppState {
    folder_cache: Mutex<HashMap<PathBuf, FolderCacheEntry>>,
    ffmpeg: Mutex<Option<Child>>,
    temp_files: Mutex<HashSet<PathBuf>>,
    /// A file handed over by a second launch that the page has not taken yet. Holds only
    /// the most recent one — a burst of Explorer double-clicks means "open the last".
    pending_file: Mutex<Option<String>>,
    /// Set once the page has registered its `video-open-file` listener. Until then a
    /// handover can only be parked in `pending_file`; emitting would go nowhere.
    frontend_ready: AtomicBool,
    /// Last maximized state broadcast to the page, so a drag-resize does not emit on
    /// every frame.
    last_maximized: AtomicBool,
    /// Same, for minimized state — Resized fires repeatedly around a minimize.
    last_minimized: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscodeResult {
    success: bool,
    output_path: Option<String>,
    cancelled: bool,
    error: Option<String>,
}

/// Whether the window is minimized, asked of Windows rather than of Tauri.
///
/// `WebviewWindow::is_minimized()` reports tao's own cached flag, and an external restore
/// does not update it: measured with the window genuinely restored and visible
/// (`IsIconic` false, `IsWindowVisible` true), Tauri still answered `true` indefinitely.
/// Anything minimized by the app and restored from the taskbar or Alt-Tab therefore
/// looked minimized forever. `IsIconic` is the state Windows itself keeps.
#[cfg(windows)]
fn window_is_minimized(window: &WebviewWindow) -> Option<bool> {
    #[link(name = "user32")]
    extern "system" {
        fn IsIconic(hwnd: isize) -> i32;
    }
    let hwnd = window.hwnd().ok()?;
    Some(unsafe { IsIconic(hwnd.0 as isize) } != 0)
}

#[cfg(not(windows))]
fn window_is_minimized(window: &WebviewWindow) -> Option<bool> {
    window.is_minimized().ok()
}

fn is_video_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| VIDEO_EXTS.iter().any(|candidate| candidate.eq_ignore_ascii_case(ext)))
        .unwrap_or(false)
}

fn first_video_arg<I>(args: I, cwd: Option<&Path>) -> Option<PathBuf>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter()
        .map(|arg| {
            let arg = arg.trim_matches('"');
            let path = arg
                .strip_prefix("file:///")
                .map(|path| path.replace('/', "\\"))
                .or_else(|| arg.strip_prefix("file://").map(|path| path.replace('/', "\\")))
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(arg));
            if path.is_relative() {
                cwd.map(|cwd| cwd.join(&path)).unwrap_or(path)
            } else {
                path
            }
        })
        .find(|path| {
            !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with('-'))
                && path.exists()
                && is_video_path(path)
        })
}

fn initial_file_arg() -> Option<PathBuf> {
    first_video_arg(std::env::args().skip(1), None)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|data| serde_json::from_str::<Settings>(&data).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create settings directory: {error}"))?;
    }
    let data = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(path, data).map_err(|error| format!("Failed to save settings: {error}"))
}

fn fourcc_name(code: &str) -> &str {
    match code {
        "avc1" | "avc2" | "avc3" | "avc4" => "H.264",
        "hev1" | "hvc1" => "H.265/HEVC",
        "dvhe" | "dvh1" => "Dolby Vision (HEVC)",
        "dav1" => "Dolby Vision (AV1)",
        "av01" => "AV1",
        "vp08" => "VP8",
        "vp09" => "VP9",
        "mp4v" => "MPEG-4 Part 2",
        "vc-1" | "ovc1" => "VC-1 (WMV)",
        "mjp2" | "mjpg" => "Motion JPEG",
        "mp4a" => "AAC",
        "ac-3" | "ac3 " => "AC-3 (Dolby Digital)",
        "ec-3" => "E-AC-3 (Dolby Digital Plus)",
        "dtsc" => "DTS",
        "dtse" => "DTS Express",
        "dtsh" => "DTS-HD MA",
        "dtsl" => "DTS-HD",
        "alac" => "Apple Lossless (ALAC)",
        "Opus" | "opus" => "Opus",
        "fLaC" | "flac" => "FLAC",
        ".mp3" | "mp3 " => "MP3",
        "lpcm" | "sowt" | "twos" => "PCM",
        "samr" => "AMR",
        other => other,
    }
}

fn read_u32_be(data: &[u8], offset: usize) -> Option<u64> {
    Some(u32::from_be_bytes(data.get(offset..offset + 4)?.try_into().ok()?) as u64)
}

fn read_u64_be(data: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_be_bytes(data.get(offset..offset + 8)?.try_into().ok()?))
}

/// Walks the MP4/MOV box tree collecting sample-entry fourccs.
///
/// Every offset step here is saturating on purpose. Box sizes are attacker-shaped data
/// read straight off disk: a 64-bit extended size of `u64::MAX` used to make
/// `offset + size` overflow, which is a **panic** under the debug profile's overflow
/// checks. This runs on the main thread across a non-unwinding FFI boundary, so that
/// panic aborted the whole process — opening one corrupt file killed the player
/// (`STATUS_STACK_BUFFER_OVERRUN`). Saturating instead clamps the walk to `end` and the
/// loop terminates normally with whatever it managed to parse.
fn walk_boxes(data: &[u8], start: usize, end: usize, fourccs: &mut HashSet<String>) {
    let mut offset = start;
    while offset.saturating_add(8) <= end {
        let mut size = match read_u32_be(data, offset) {
            Some(size) => size,
            None => break,
        };
        let box_type = match data.get(offset + 4..offset + 8) {
            Some(value) => String::from_utf8_lossy(value).to_string(),
            None => break,
        };
        let mut header_len = 8usize;
        if size == 1 {
            if offset.saturating_add(16) > end {
                break;
            }
            size = match read_u64_be(data, offset + 8) {
                Some(size) => size,
                None => break,
            };
            header_len = 16;
        } else if size == 0 {
            size = (end - offset) as u64;
        }
        if size < 8 {
            break;
        }
        let step = usize::try_from(size).unwrap_or(usize::MAX);
        let box_end = offset.saturating_add(step).min(end);
        if matches!(box_type.as_str(), "moov" | "trak" | "mdia" | "minf" | "stbl") {
            walk_boxes(data, offset.saturating_add(header_len), box_end, fourccs);
        } else if box_type == "stsd" {
            let mut entry_offset = offset.saturating_add(header_len).saturating_add(8);
            while entry_offset.saturating_add(8) <= box_end {
                let entry_size = match read_u32_be(data, entry_offset) {
                    Some(size) if size >= 8 => size as usize,
                    _ => break,
                };
                if let Some(bytes) = data.get(entry_offset + 4..entry_offset + 8) {
                    if bytes.iter().all(|byte| (0x20..=0x7e).contains(byte)) {
                        fourccs.insert(String::from_utf8_lossy(bytes).to_string());
                    }
                }
                entry_offset = entry_offset.saturating_add(entry_size);
            }
        }
        // A size of 0 after saturation would spin forever; every path above guarantees
        // size >= 8, so this always advances.
        offset = offset.saturating_add(step);
    }
}

fn mp4_codec_info(file_path: &Path) -> Option<Vec<String>> {
    let mut file = fs::File::open(file_path).ok()?;
    let file_size = file.metadata().ok()?.len();
    if file_size < 8 {
        return None;
    }

    let mut probe = [0u8; 12];
    file.read_exact(&mut probe[..(file_size.min(12) as usize)]).ok()?;
    let first_type = std::str::from_utf8(probe.get(4..8)?).ok()?;
    if !matches!(first_type, "ftyp" | "moov" | "mdat" | "free" | "skip" | "wide" | "pnot") {
        return None;
    }

    let mut pos = 0u64;
    let mut moov_offset = None;
    let mut moov_size = 0u64;
    while pos < file_size {
        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut header = [0u8; 16];
        let read = file.read(&mut header).ok()?;
        if read < 8 {
            break;
        }
        let mut box_size = u32::from_be_bytes(header[0..4].try_into().ok()?) as u64;
        let box_type = std::str::from_utf8(&header[4..8]).ok()?;
        if box_size == 1 {
            if read < 16 {
                break;
            }
            box_size = u64::from_be_bytes(header[8..16].try_into().ok()?);
        } else if box_size == 0 {
            box_size = file_size - pos;
        }
        if box_size < 8 {
            break;
        }
        if box_type == "moov" {
            moov_offset = Some(pos);
            moov_size = box_size;
            break;
        }
        // Saturating for the same reason as walk_boxes: a corrupt 64-bit box size
        // overflowed this and aborted the process. Saturating just ends the scan.
        pos = pos.saturating_add(box_size);
    }

    // Clamp to what the file actually holds as well as to the 8 MB ceiling — a corrupt
    // box can claim far more than it has, and read_exact on a short read fails outright.
    let moov_offset = moov_offset?;
    let available = file_size.saturating_sub(moov_offset);
    let read_size = moov_size.min(8 * 1024 * 1024).min(available) as usize;
    if read_size < 8 {
        return None;
    }
    let mut moov = vec![0u8; read_size];
    file.seek(SeekFrom::Start(moov_offset)).ok()?;
    file.read_exact(&mut moov).ok()?;

    let mut fourccs = HashSet::new();
    walk_boxes(&moov, 0, moov.len(), &mut fourccs);
    if fourccs.is_empty() {
        return None;
    }

    Some(
        fourccs
            .into_iter()
            .map(|code| fourcc_name(&code).to_string())
            .collect(),
    )
}

/// Stop ffmpeg's console window from flashing up on Windows. The app is a GUI
/// (`windows` subsystem) binary, so any spawned console process pops its own window
/// unless we ask Windows to create it without one.
#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

fn kill_running_transcode(state: &AppState) {
    if let Ok(mut guard) = state.ffmpeg.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
        *guard = None;
    }
}

fn parse_timestamp(value: &str) -> Option<f64> {
    let mut parts = value.split(':');
    let hours = parts.next()?.parse::<f64>().ok()?;
    let minutes = parts.next()?.parse::<f64>().ok()?;
    let seconds = parts.next()?.parse::<f64>().ok()?;
    Some((hours * 3600.0) + (minutes * 60.0) + seconds)
}

fn parse_after<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    let start = text.find(marker)? + marker.len();
    text.get(start..)?.split_whitespace().next()
}

#[tauri::command]
fn get_folder_files(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<Vec<String>, String> {
    let path = PathBuf::from(&file_path);
    let Some(dir) = path.parent().map(Path::to_path_buf) else {
        return Ok(vec![file_path]);
    };

    let modified = fs::metadata(&dir).and_then(|meta| meta.modified()).ok();
    if let Ok(cache) = state.folder_cache.lock() {
        if let Some(entry) = cache.get(&dir) {
            if entry.modified == modified && entry.created_at.elapsed() < FOLDER_CACHE_TTL {
                return Ok(entry.files.clone());
            }
        }
    }

    let mut files = fs::read_dir(&dir)
        .map_err(|error| format!("Failed to read folder: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_video_path(path))
        .filter_map(|path| {
            let modified = fs::metadata(&path).and_then(|meta| meta.modified()).ok()?;
            Some((path, modified))
        })
        .collect::<Vec<_>>();

    files.sort_by(|a, b| b.1.cmp(&a.1));
    let files = files
        .into_iter()
        .map(|(path, _)| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let files = if files.is_empty() { vec![file_path] } else { files };

    if let Ok(mut cache) = state.folder_cache.lock() {
        cache.insert(
            dir,
            FolderCacheEntry {
                created_at: Instant::now(),
                modified,
                files: files.clone(),
            },
        );
    }

    Ok(files)
}

#[tauri::command]
fn get_codec_info(file_path: String) -> Option<Vec<String>> {
    mp4_codec_info(Path::new(&file_path))
}

/// One discovered subtitle file: WebVTT text ready for a blob URL, plus a label.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubtitleTrack {
    label: String,
    vtt: String,
}

/// `Clip.mp4` -> `Clip.srt`, `Clip.vtt`, `Clip.en.srt`, `Clip.forced.vtt`, …
///
/// Chromium demuxes no embedded subtitle track this player can reach: MKV subtitle
/// streams and MP4 `mov_text` both come back as zero `textTracks` (measured on both).
/// A sidecar file is the only subtitle source that can actually be rendered, so it is
/// the one we look for.
fn find_sidecar_subtitles(video_path: &Path) -> Vec<SubtitleTrack> {
    let Some(dir) = video_path.parent() else {
        return Vec::new();
    };
    let Some(stem) = video_path.file_stem().and_then(|stem| stem.to_str()) else {
        return Vec::new();
    };
    let stem_lower = stem.to_lowercase();

    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter_map(|path| {
            let ext = path.extension()?.to_str()?.to_lowercase();
            if ext != "srt" && ext != "vtt" {
                return None;
            }
            let name = path.file_stem()?.to_str()?.to_lowercase();
            // Either exactly the video's name, or the video's name plus a language-ish
            // suffix (`Clip.en`, `Clip.forced`). Never a different video's subtitles.
            let suffix = if name == stem_lower {
                String::new()
            } else if let Some(rest) = name.strip_prefix(&format!("{stem_lower}.")) {
                rest.to_string()
            } else {
                return None;
            };
            Some((suffix, path))
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));

    found
        .into_iter()
        .filter_map(|(suffix, path)| {
            let raw = fs::read_to_string(&path).ok().or_else(|| {
                // Subtitle files are frequently Latin-1; salvage them rather than
                // dropping the track entirely.
                fs::read(&path)
                    .ok()
                    .map(|bytes| bytes.iter().map(|&b| b as char).collect())
            })?;
            let is_vtt = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("vtt"));
            let vtt = if is_vtt { raw } else { srt_to_vtt(&raw) };
            let label = if suffix.is_empty() {
                "Subtitles".to_string()
            } else {
                suffix
            };
            Some(SubtitleTrack { label, vtt })
        })
        .collect()
}

/// SRT -> WebVTT. The two formats differ, for our purposes, in the header and in the
/// `,` vs `.` decimal separator on cue timings.
fn srt_to_vtt(srt: &str) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for line in srt.lines() {
        let trimmed = line.trim_start_matches('\u{feff}');
        if trimmed.contains("-->") {
            out.push_str(&trimmed.replace(',', "."));
        } else {
            out.push_str(trimmed);
        }
        out.push('\n');
    }
    out
}

#[tauri::command]
fn get_subtitles(file_path: String) -> Vec<SubtitleTrack> {
    find_sidecar_subtitles(Path::new(&file_path))
}

/// Hand a parked file to the page, if there is one and the page is listening.
///
/// Called from a background thread after a second launch, and again from `frontend_ready`
/// once the page can actually receive it. Taking the value is what makes it idempotent:
/// whichever path gets there first wins and the other finds the slot empty.
fn deliver_pending_file(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.frontend_ready.load(Ordering::SeqCst) {
        return;
    }
    let pending = state
        .pending_file
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());
    if let Some(path) = pending {
        let _ = app.emit("video-open-file", path);
    }
}

/// Bring the existing window forward for a handover. Deliberately does NOT build
/// anything: creating a webview window inside the single-instance callback deadlocks the
/// app (see the comment on the plugin registration in `run`).
fn surface_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The page announcing that its event listeners are attached. Returns the file this
/// instance should open: a handover that arrived during startup if there is one,
/// otherwise this process's own command line.
///
/// This exists because the two are genuinely racy — `initialize_plugins` runs before
/// `setup` creates the window, so a second launch can land before the page exists at all.
#[tauri::command]
fn frontend_ready(state: tauri::State<'_, AppState>) -> Option<String> {
    state.frontend_ready.store(true, Ordering::SeqCst);
    let pending = state
        .pending_file
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());
    pending.or_else(|| initial_file_arg().map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn get_editor_path(app: AppHandle) -> Option<String> {
    load_settings(&app).editor_path
}

#[tauri::command]
fn set_editor_path(app: AppHandle, editor_path: String) -> Result<String, String> {
    let mut settings = load_settings(&app);
    settings.editor_path = Some(editor_path.clone());
    save_settings(&app, &settings)?;
    Ok(editor_path)
}

#[tauri::command]
fn get_autoplay_switched(app: AppHandle) -> Option<bool> {
    load_settings(&app).autoplay_switched
}

#[tauri::command]
fn set_autoplay_switched(app: AppHandle, autoplay_switched: bool) -> Result<bool, String> {
    let mut settings = load_settings(&app);
    settings.autoplay_switched = Some(autoplay_switched);
    save_settings(&app, &settings)?;
    Ok(autoplay_switched)
}

#[tauri::command]
fn open_editor(app: AppHandle) -> Result<(), String> {
    let Some(editor_path) = load_settings(&app).editor_path else {
        return Err("No editor configured".to_string());
    };

    Command::new(editor_path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn transcode_file(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> TranscodeResult {
    kill_running_transcode(&state);

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let output_path = std::env::temp_dir().join(format!("vp-{}-{stamp}.mp4", std::process::id()));

    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-i",
            &file_path,
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-y",
        ])
        .arg(&output_path)
        .stderr(Stdio::piped())
        .stdout(Stdio::null());
    no_window(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return TranscodeResult {
                success: false,
                output_path: None,
                cancelled: false,
                error: Some(error.to_string()),
            };
        }
    };

    if let Some(stderr) = child.stderr.take() {
        let app_for_progress = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut duration = None;
            for line in reader.lines().map_while(Result::ok) {
                if duration.is_none() {
                    duration = parse_after(&line, "Duration:").and_then(parse_timestamp);
                }
                if let (Some(duration), Some(current)) =
                    (duration, parse_after(&line, "time=").and_then(parse_timestamp))
                {
                    let pct = ((current / duration) * 100.0).round().clamp(0.0, 99.0) as u8;
                    let _ = app_for_progress.emit("video-transcode-progress", pct);
                }
            }
        });
    }

    if let Ok(mut guard) = state.ffmpeg.lock() {
        *guard = Some(child);
    }

    loop {
        let status = {
            let Ok(mut guard) = state.ffmpeg.lock() else {
                return TranscodeResult {
                    success: false,
                    output_path: None,
                    cancelled: false,
                    error: Some("Failed to lock ffmpeg state".to_string()),
                };
            };
            let Some(child) = guard.as_mut() else {
                return TranscodeResult {
                    success: false,
                    output_path: None,
                    cancelled: true,
                    error: None,
                };
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    *guard = None;
                    Some(Ok(status))
                }
                Ok(None) => None,
                Err(error) => {
                    *guard = None;
                    Some(Err(error))
                }
            }
        };

        if let Some(status) = status {
            return match status {
                Ok(status) if status.success() => {
                    if let Ok(mut temp_files) = state.temp_files.lock() {
                        temp_files.insert(output_path.clone());
                    }
                    TranscodeResult {
                        success: true,
                        output_path: Some(output_path.to_string_lossy().to_string()),
                        cancelled: false,
                        error: None,
                    }
                }
                Ok(status) => {
                    let _ = fs::remove_file(&output_path);
                    TranscodeResult {
                        success: false,
                        output_path: None,
                        cancelled: false,
                        error: Some(format!("ffmpeg exited with code {:?}", status.code())),
                    }
                }
                Err(error) => {
                    let _ = fs::remove_file(&output_path);
                    TranscodeResult {
                        success: false,
                        output_path: None,
                        cancelled: false,
                        error: Some(error.to_string()),
                    }
                }
            };
        }

        thread::sleep(Duration::from_millis(100));
    }
}

#[tauri::command]
fn cancel_transcode(state: tauri::State<'_, AppState>) {
    kill_running_transcode(&state);
}

/// A-B crop rectangle, as fractions (0.0–1.0) of the displayed video frame. Kept as
/// fractions rather than pixels so ffmpeg can evaluate them against the coded frame
/// (`iw`/`ih`); that stays correct for anamorphic / non-square-pixel sources, where
/// the browser's `videoWidth` (display pixels) differs from the coded width.
#[derive(Debug, Deserialize)]
struct CropRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// A scratch path beside `target`, so a finished save can be moved into place with a
/// same-volume rename. Keeps the destination's extension — ffmpeg picks the muxer from it.
fn scratch_path_for(target: &Path) -> PathBuf {
    let ext = target
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
        .unwrap_or("mp4");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let name = format!(".vp-save-{}-{stamp}.{ext}", std::process::id());
    match target.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(name),
        _ => PathBuf::from(name),
    }
}

/// First free `stem (n).ext` beside `target`. Used only to park a finished cut when the
/// destination itself can't be replaced, so the encode is never thrown away.
fn unique_sibling(target: &Path) -> PathBuf {
    let dir = target.parent().unwrap_or_else(|| Path::new(""));
    let stem = target
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("cut");
    let ext = target.extension().and_then(|ext| ext.to_str()).unwrap_or("mp4");
    for n in 1..1000 {
        let candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} (cut).{ext}"))
}

/// True when two paths name the same file on disk. A string compare is not enough: on
/// Windows `C:\a\Clip.mp4`, `C:/a/clip.mp4` and the 8.3 short form are all one file.
/// Canonicalize resolves the real on-disk casing; a path that doesn't exist can't be a
/// match, so a failed lookup is a clean `false`.
fn is_same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Reports whether the save target is the file currently open, so the frontend can let
/// go of the media element before its file is replaced underneath it.
#[tauri::command]
fn is_same_video_file(a: String, b: String) -> bool {
    is_same_file(Path::new(&a), Path::new(&b))
}

#[tauri::command]
fn save_section(
    file_path: String,
    start: f64,
    end: f64,
    output_path: String,
    strip_audio: bool,
    crop: Option<CropRect>,
) -> Result<(), String> {
    let duration = end - start;
    if duration <= 0.0 {
        return Err("Invalid section: end must be after start".to_string());
    }
    if !Path::new(&file_path).exists() {
        return Err(format!("Source file no longer exists: {file_path}"));
    }
    let mut cmd = Command::new("ffmpeg");
    if start > 0.01 {
        cmd.args(["-ss", &format!("{:.3}", start)]);
    }
    cmd.args(["-i", &file_path, "-t", &format!("{:.3}", duration)]);

    if let Some(crop) = &crop {
        // A crop needs a filter, which forces a video re-encode. Evaluate the crop
        // against the coded frame (iw/ih) so it stays correct for anamorphic sources,
        // and trunc(…/2)*2 forces even sizes/offsets for yuv420p. Map only the primary
        // video (+ optional audio) so a subtitle/data stream can't derail the encode.
        let filter = format!(
            "crop=trunc(iw*{:.6}/2)*2:trunc(ih*{:.6}/2)*2:trunc(iw*{:.6}/2)*2:trunc(ih*{:.6}/2)*2",
            crop.w, crop.h, crop.x, crop.y
        );
        cmd.args([
            "-map",
            "0:v:0",
            "-vf",
            &filter,
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
        ]);
        if strip_audio {
            cmd.arg("-an");
        } else {
            cmd.args(["-map", "0:a?", "-c:a", "copy"]);
        }
    } else {
        // No crop: stream-copy every track losslessly (as before), dropping only
        // the audio when the strip toggle is on.
        cmd.args(["-c", "copy"]);
        if strip_audio {
            cmd.arg("-an");
        }
    }

    // Never point ffmpeg at the destination. It truncates its output as soon as it opens
    // it, so writing there directly destroys whatever was in that path the moment
    // anything goes wrong — and when the destination IS the source (trim the head, keep
    // the name) it eats the file it is still reading. ffmpeg's own in-place guard is a
    // plain strcmp on the two path strings, so `Clip.mp4` -> `clip.mp4` sails past it and
    // silently truncates the original mid-read, exiting 0 as if it had worked.
    //
    // So: encode to a scratch file beside the destination, and only once ffmpeg has
    // exited cleanly move it into place. Until that rename the original is untouched, and
    // nothing that existed before this call is ever deleted.
    let final_path = PathBuf::from(&output_path);
    let scratch = scratch_path_for(&final_path);

    cmd.arg("-y").arg(&scratch);
    no_window(&mut cmd);
    let status = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            let _ = fs::remove_file(&scratch);
            format!("Failed to run ffmpeg: {error}")
        })?;
    if !status.success() {
        let _ = fs::remove_file(&scratch);
        return Err(format!("ffmpeg exited with code {:?}", status.code()));
    }

    // `fs::rename` is MoveFileEx(MOVEFILE_REPLACE_EXISTING) on Windows: the swap is
    // atomic, so the destination is either the old file or the complete new one.
    if fs::rename(&scratch, &final_path).is_ok() {
        return Ok(());
    }

    // Replace refused — the destination is typically still held open by a player. The cut
    // is finished and valid, so park it under a free name rather than discard it.
    let parked = unique_sibling(&final_path);
    match fs::rename(&scratch, &parked) {
        Ok(()) => Err(format!(
            "Could not replace {} — it may still be open. The cut was saved as {} instead.",
            final_path.display(),
            parked.display()
        )),
        Err(error) => Err(format!(
            "Could not write {}: {error}. The cut is at {}.",
            final_path.display(),
            scratch.display()
        )),
    }
}

#[tauri::command]
fn cleanup_temp(state: tauri::State<'_, AppState>, file_path: String) {
    let path = PathBuf::from(file_path);
    let _ = fs::remove_file(&path);
    if let Ok(mut temp_files) = state.temp_files.lock() {
        temp_files.remove(&path);
    }
}

#[tauri::command]
fn window_toggle_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|error| error.to_string())?;
    window
        .set_fullscreen(next)
        .map_err(|error| error.to_string())?;
    Ok(next)
}

#[tauri::command]
fn window_is_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    window.is_fullscreen().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())?;
        window
            .emit("window-maximize-changed", false)
            .map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
        window
            .emit("window-maximize-changed", true)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn window_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_start_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        // Registered first, per the plugin's own guidance. The callback parks the path
        // and hands off to a background thread rather than doing the work inline: the
        // plugin runs this synchronously inside the window procedure while the launching
        // process is blocked in a cross-process SendMessageW, so anything slow (or
        // anything that pumps messages, such as building a window) deadlocks the app
        // permanently. Explorer opening several selected files at once is exactly that
        // burst. See memory note `tauri-single-instance-window-hang`.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let cwd = PathBuf::from(cwd);
            if let Some(path) = first_video_arg(argv.into_iter().skip(1), Some(&cwd)) {
                if let Ok(mut slot) = app.state::<AppState>().pending_file.lock() {
                    *slot = Some(path.to_string_lossy().to_string());
                }
            }
            let app = app.clone();
            thread::spawn(move || {
                surface_main_window(&app);
                deliver_pending_file(&app);
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Minimized state has no event to hang off: WebView2 does not fire
            // `visibilitychange` for a minimize, and tao swallows the WM_SIZE that
            // carries SIZE_MINIMIZED so `WindowEvent::Resized` never arrives either
            // (both measured — a taskbar minimize produced no event of any kind).
            // Without a signal, a window minimized by the app's own button and restored
            // from the taskbar stayed paused forever. So: poll it, cheaply, and emit only
            // on a change.
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(400));
                let Some(window) = handle.get_webview_window("main") else {
                    continue;
                };
                let Some(is_minimized) = window_is_minimized(&window) else {
                    continue;
                };
                let state = handle.state::<AppState>();
                if state.last_minimized.swap(is_minimized, Ordering::SeqCst) != is_minimized {
                    let _ = handle.emit("window-minimize-changed", is_minimized);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cancel_transcode,
            cleanup_temp,
            frontend_ready,
            get_autoplay_switched,
            get_codec_info,
            get_editor_path,
            get_folder_files,
            get_subtitles,
            open_editor,
            set_autoplay_switched,
            set_editor_path,
            transcode_file,
            save_section,
            is_same_video_file,
            window_close,
            window_is_fullscreen,
            window_is_maximized,
            window_minimize,
            window_start_drag,
            window_toggle_fullscreen,
            window_toggle_maximize
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                let state = window.state::<AppState>();
                kill_running_transcode(&state);
                let paths = state
                    .temp_files
                    .lock()
                    .map(|mut temp_files| temp_files.drain().collect::<Vec<_>>())
                    .unwrap_or_default();
                for path in paths {
                    let _ = fs::remove_file(path);
                }
            }
            // The titlebar button used to track maximized state only when the app itself
            // did the maximizing. Win+Up, Aero Snap, a taskbar restore and the drag
            // strip's own double-click all go through Windows without touching our
            // command, leaving the button showing the wrong glyph and the wrong tooltip
            // — and "Maximize" would then restore. Resized covers every one of those.
            // Guarded on change so a drag-resize does not emit on every frame.
            tauri::WindowEvent::Resized(_) => {
                if let Ok(is_maximized) = window.is_maximized() {
                    let state = window.state::<AppState>();
                    if state.last_maximized.swap(is_maximized, Ordering::SeqCst) != is_maximized {
                        let _ = window.emit("window-maximize-changed", is_maximized);
                    }
                }
                // Minimize/restore is watched by the poll in `setup` instead: tao filters
                // out the WM_SIZE that carries SIZE_MINIMIZED, so Resized never fires for
                // it, and WebView2 fires no `visibilitychange` either (both measured).
            }
            tauri::WindowEvent::ScaleFactorChanged { new_inner_size, .. } => {
                // WebView2 loses its render surface when moved to a monitor with a
                // different DPI scale. Forcing set_size with the new size triggers
                // WebView2 to reinitialize the surface and clears the black screen.
                let _ = window.set_size(tauri::Size::Physical(*new_inner_size));
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
