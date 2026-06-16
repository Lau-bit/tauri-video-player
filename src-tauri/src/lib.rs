use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscodeResult {
    success: bool,
    output_path: Option<String>,
    cancelled: bool,
    error: Option<String>,
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

fn walk_boxes(data: &[u8], start: usize, end: usize, fourccs: &mut HashSet<String>) {
    let mut offset = start;
    while offset + 8 <= end {
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
            if offset + 16 > end {
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
        let box_end = (offset + size as usize).min(end);
        if matches!(box_type.as_str(), "moov" | "trak" | "mdia" | "minf" | "stbl") {
            walk_boxes(data, offset + header_len, box_end, fourccs);
        } else if box_type == "stsd" {
            let mut entry_offset = offset + header_len + 8;
            while entry_offset + 8 <= box_end {
                let entry_size = match read_u32_be(data, entry_offset) {
                    Some(size) if size >= 8 => size as usize,
                    _ => break,
                };
                if let Some(bytes) = data.get(entry_offset + 4..entry_offset + 8) {
                    if bytes.iter().all(|byte| (0x20..=0x7e).contains(byte)) {
                        fourccs.insert(String::from_utf8_lossy(bytes).to_string());
                    }
                }
                entry_offset += entry_size;
            }
        }
        offset += size as usize;
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
        pos += box_size;
    }

    let read_size = moov_size.min(8 * 1024 * 1024) as usize;
    let mut moov = vec![0u8; read_size];
    file.seek(SeekFrom::Start(moov_offset?)).ok()?;
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

#[tauri::command]
fn get_initial_file() -> Option<String> {
    initial_file_arg().map(|path| path.to_string_lossy().to_string())
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

    let mut child = match Command::new("ffmpeg")
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
        .stdout(Stdio::null())
        .spawn()
    {
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

#[tauri::command]
fn save_section(
    file_path: String,
    start: f64,
    end: f64,
    output_path: String,
) -> Result<(), String> {
    let duration = end - start;
    if duration <= 0.0 {
        return Err("Invalid section: end must be after start".to_string());
    }
    let mut cmd = Command::new("ffmpeg");
    if start > 0.01 {
        cmd.args(["-ss", &format!("{:.3}", start)]);
    }
    cmd.args([
        "-i",
        &file_path,
        "-t",
        &format!("{:.3}", duration),
        "-c",
        "copy",
        "-y",
        &output_path,
    ]);
    let status = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("Failed to run ffmpeg: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        let _ = fs::remove_file(&output_path);
        Err(format!("ffmpeg exited with code {:?}", status.code()))
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            cancel_transcode,
            cleanup_temp,
            get_autoplay_switched,
            get_codec_info,
            get_editor_path,
            get_folder_files,
            get_initial_file,
            open_editor,
            set_autoplay_switched,
            set_editor_path,
            transcode_file,
            save_section,
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
