//! Regression tests for the A-B section save.
//!
//! Every case here was a real data-loss path. Saving a cut over its own source used to
//! delete the original and produce no cut at all; a destination whose path string merely
//! differed in case let ffmpeg truncate the source while it was still reading it, and
//! report success. The rule these encode: `save_section` may never destroy a file that
//! existed before it ran.
//!
//! The ffmpeg-backed tests no-op when ffmpeg is not on PATH.

use super::*;

fn ffmpeg_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn test_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("vp-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create test dir");
    dir
}

/// A real H.264/AAC clip, so the stream-copy path behaves the way it does live.
fn make_clip(path: &Path, seconds: u32) {
    let status = Command::new("ffmpeg")
        .args([
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc=size=320x240:rate=30:duration={seconds}"),
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency=440:duration={seconds}"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            "-y",
        ])
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run ffmpeg");
    assert!(status.success(), "failed to build the test clip");
    assert!(path.exists(), "test clip missing");
}

fn duration_of(path: &Path) -> f64 {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .expect("run ffprobe");
    assert!(out.status.success(), "ffprobe failed on {}", path.display());
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0.0)
}

/// Decodes every frame and fails on any error output. This is what separates a real cut
/// from the truncated stub the source-clobbering bug used to leave behind — that stub
/// still probes as a video, it just falls apart when read.
fn assert_decodes_cleanly(path: &Path) {
    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-f", "null", "-"])
        .output()
        .expect("run ffmpeg");
    let errors = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{} failed to decode", path.display());
    assert!(errors.trim().is_empty(), "{} decoded with errors: {errors}", path.display());
}

fn assert_no_scratch_left(dir: &Path) {
    let leftovers: Vec<String> = fs::read_dir(dir)
        .expect("read dir")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with(".vp-save-"))
        .collect();
    assert!(leftovers.is_empty(), "scratch files left behind: {leftovers:?}");
}

/// Trim the first 3s and keep the same filename: the case that used to delete the
/// original and leave the user with neither the cut nor the source.
#[test]
fn overwriting_the_source_in_place_produces_the_cut() {
    if !ffmpeg_available() {
        return;
    }
    let dir = test_dir("inplace");
    let clip = dir.join("Clip.mp4");
    make_clip(&clip, 10);

    let path = clip.to_string_lossy().to_string();
    save_section(path.clone(), 3.0, 10.0, path, false, None).expect("save should succeed");

    assert!(clip.exists(), "the original was deleted");
    let duration = duration_of(&clip);
    assert!((duration - 7.0).abs() < 0.5, "expected a ~7s cut, got {duration}s");
    assert_decodes_cleanly(&clip);
    assert_no_scratch_left(&dir);
}

/// One file, two path strings. ffmpeg's own in-place guard is a plain string compare, so
/// this slipped past it and truncated the source mid-read while exiting 0.
#[test]
fn case_differing_destination_does_not_truncate_the_source() {
    if !ffmpeg_available() {
        return;
    }
    let dir = test_dir("case");
    let clip = dir.join("Clip.mp4");
    make_clip(&clip, 10);

    let source = clip.to_string_lossy().to_string();
    let destination = dir.join("clip.mp4").to_string_lossy().to_string();
    assert_ne!(source, destination, "the test needs two different strings");
    assert!(
        is_same_file(Path::new(&source), Path::new(&destination)),
        "these must resolve to one file for this test to mean anything"
    );

    save_section(source, 3.0, 10.0, destination, false, None).expect("save should succeed");

    let duration = duration_of(&clip);
    assert!(
        (duration - 7.0).abs() < 0.5,
        "expected a complete ~7s cut, got {duration}s — a short stub means the source was \
         clobbered while ffmpeg was reading it"
    );
    assert_decodes_cleanly(&clip);
    assert_no_scratch_left(&dir);
}

/// A failed encode must not touch a destination that already held something.
#[test]
fn a_failed_save_leaves_an_existing_destination_alone() {
    if !ffmpeg_available() {
        return;
    }
    let dir = test_dir("failure");
    let broken = dir.join("broken.mp4");
    fs::write(&broken, b"this is not a video").expect("write junk source");
    let destination = dir.join("keep-me.mp4");
    make_clip(&destination, 4);
    let before = fs::read(&destination).expect("read destination");

    let result = save_section(
        broken.to_string_lossy().to_string(),
        0.0,
        2.0,
        destination.to_string_lossy().to_string(),
        false,
        None,
    );

    assert!(result.is_err(), "a junk source should fail");
    assert!(destination.exists(), "the pre-existing destination was deleted");
    assert_eq!(before, fs::read(&destination).unwrap(), "the destination was modified");
    assert_no_scratch_left(&dir);
}

#[test]
fn a_missing_source_is_rejected_before_ffmpeg_runs() {
    let dir = test_dir("missing");
    let destination = dir.join("out.mp4");
    let result = save_section(
        dir.join("nope.mp4").to_string_lossy().to_string(),
        0.0,
        2.0,
        destination.to_string_lossy().to_string(),
        false,
        None,
    );
    assert!(result.is_err());
    assert!(!destination.exists(), "nothing should have been created");
}

#[test]
fn an_empty_or_inverted_section_is_rejected() {
    let dir = test_dir("range");
    let clip = dir.join("Clip.mp4");
    fs::write(&clip, b"placeholder").expect("write placeholder");
    let out = dir.join("out.mp4").to_string_lossy().to_string();
    let src = clip.to_string_lossy().to_string();
    assert!(save_section(src.clone(), 5.0, 5.0, out.clone(), false, None).is_err());
    assert!(save_section(src, 8.0, 2.0, out, false, None).is_err());
}

#[test]
fn same_file_check_sees_through_separators_and_case() {
    let dir = test_dir("samefile");
    let clip = dir.join("Clip.mp4");
    fs::write(&clip, b"x").expect("write clip");
    let other = dir.join("Other.mp4");
    fs::write(&other, b"x").expect("write other");

    let exact = clip.to_string_lossy().to_string();
    assert!(is_same_file(Path::new(&exact), Path::new(&exact)));
    assert!(is_same_file(Path::new(&exact), Path::new(&exact.to_lowercase())));
    assert!(is_same_file(Path::new(&exact), Path::new(&exact.replace('\\', "/"))));
    assert!(!is_same_file(&clip, &other));
    assert!(!is_same_file(&clip, &dir.join("does-not-exist.mp4")));
}

#[test]
fn scratch_path_sits_beside_the_target_and_keeps_its_extension() {
    let target = Path::new("D:\\videos\\Clip.mkv");
    let scratch = scratch_path_for(target);
    assert_eq!(scratch.parent(), target.parent());
    assert_eq!(scratch.extension().unwrap(), "mkv");
    assert_ne!(scratch, target.to_path_buf());
    assert_eq!(scratch_path_for(Path::new("out")).extension().unwrap(), "mp4");
}

// ---------------------------------------------------------------------------------
// Corrupt-file parsing.
//
// A corrupt MP4 whose box header declares a 64-bit extended size of u64::MAX made
// `offset + size` overflow. Under the debug profile's overflow checks that is a panic,
// and it happened on the main thread inside a function that cannot unwind, so the whole
// process aborted with STATUS_STACK_BUFFER_OVERRUN: opening one bad file killed the
// player outright, with no error message and no window left. The rule these encode:
// `get_codec_info` may return None, but it may never panic.
// ---------------------------------------------------------------------------------

fn write_bytes(path: &Path, parts: &[&[u8]]) {
    let mut data = Vec::new();
    for part in parts {
        data.extend_from_slice(part);
    }
    fs::write(path, data).expect("write test file");
}

/// An `ftyp` box, so the file passes the container sniff and reaches the box walker.
fn ftyp() -> Vec<u8> {
    let payload = b"isom\x00\x00\x02\x00isomiso2avc1mp41";
    let mut out = ((8 + payload.len()) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(b"ftyp");
    out.extend_from_slice(payload);
    out
}

/// A box header declaring size==1 (64-bit extended) with an extended size of u64::MAX.
fn huge_64bit_box(box_type: &[u8; 4]) -> Vec<u8> {
    let mut out = 1u32.to_be_bytes().to_vec();
    out.extend_from_slice(box_type);
    out.extend_from_slice(&u64::MAX.to_be_bytes());
    out
}

#[test]
fn a_huge_top_level_box_size_does_not_overflow_the_scan() {
    let dir = test_dir("badouterbox");
    let path = dir.join("bad.mp4");
    write_bytes(&path, &[&ftyp(), &huge_64bit_box(b"mdat"), &[0u8; 64]]);
    assert_eq!(mp4_codec_info(&path), None);
}

#[test]
fn a_huge_nested_box_size_does_not_overflow_the_walk() {
    let dir = test_dir("badinnerbox");
    let path = dir.join("bad.mp4");
    // moov > trak > mdia > minf > stbl, where stbl claims a 64-bit size of u64::MAX.
    let mut inner = huge_64bit_box(b"stbl");
    for name in [b"minf", b"mdia", b"trak", b"moov"] {
        let mut wrapped = ((8 + inner.len()) as u32).to_be_bytes().to_vec();
        wrapped.extend_from_slice(name);
        wrapped.extend_from_slice(&inner);
        inner = wrapped;
    }
    write_bytes(&path, &[&ftyp(), &inner]);
    assert_eq!(mp4_codec_info(&path), None);
}

#[test]
fn truncated_and_garbage_files_are_rejected_without_panicking() {
    let dir = test_dir("junk");
    let garbage = dir.join("garbage.mp4");
    fs::write(&garbage, (0..4096u32).map(|n| (n % 251) as u8).collect::<Vec<_>>())
        .expect("write garbage");
    assert_eq!(mp4_codec_info(&garbage), None);

    // A valid header whose moov box claims far more bytes than the file holds.
    let short = dir.join("short.mp4");
    let mut moov = 8_000_000u32.to_be_bytes().to_vec();
    moov.extend_from_slice(b"moov");
    write_bytes(&short, &[&ftyp(), &moov, &[0u8; 32]]);
    assert_eq!(mp4_codec_info(&short), None);

    let empty = dir.join("empty.mp4");
    fs::write(&empty, b"").expect("write empty");
    assert_eq!(mp4_codec_info(&empty), None);
}

#[test]
fn a_real_clip_still_reports_its_codecs() {
    if !ffmpeg_available() {
        return;
    }
    let dir = test_dir("codecs");
    let clip = dir.join("Clip.mp4");
    make_clip(&clip, 2);
    let codecs = mp4_codec_info(&clip).expect("a real clip should parse");
    assert!(codecs.iter().any(|c| c == "H.264"), "expected H.264, got {codecs:?}");
    assert!(codecs.iter().any(|c| c == "AAC"), "expected AAC, got {codecs:?}");
}

// ---------------------------------------------------------------------------------
// Sidecar subtitles
// ---------------------------------------------------------------------------------

#[test]
fn srt_becomes_vtt_with_dotted_timestamps() {
    let srt = "1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\n";
    let vtt = srt_to_vtt(srt);
    assert!(vtt.starts_with("WEBVTT\n"), "missing WEBVTT header: {vtt:?}");
    assert!(vtt.contains("00:00:01.500 --> 00:00:03.000"), "timings not converted: {vtt:?}");
    assert!(vtt.contains("Hello"));
    // Commas in the dialogue itself must survive — only cue timing lines are rewritten.
    assert!(srt_to_vtt("1\n00:00:01,000 --> 00:00:02,000\nWait, no\n").contains("Wait, no"));
}

#[test]
fn sidecars_match_the_video_stem_and_nothing_else() {
    let dir = test_dir("subs");
    let video = dir.join("Clip.mp4");
    fs::write(&video, b"x").expect("write video");
    fs::write(dir.join("Clip.srt"), "1\n00:00:01,000 --> 00:00:02,000\nplain\n").unwrap();
    fs::write(dir.join("Clip.en.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nenglish\n").unwrap();
    fs::write(dir.join("Other.srt"), "1\n00:00:01,000 --> 00:00:02,000\nnope\n").unwrap();
    fs::write(dir.join("Clip.txt"), "not a subtitle").unwrap();

    let tracks = find_sidecar_subtitles(&video);
    let labels: Vec<&str> = tracks.iter().map(|t| t.label.as_str()).collect();
    assert_eq!(labels, vec!["Subtitles", "en"], "got {labels:?}");
    assert!(tracks.iter().all(|t| t.vtt.starts_with("WEBVTT")));
    assert!(!tracks.iter().any(|t| t.vtt.contains("nope")), "picked up another video's subs");
}

#[test]
fn no_sidecars_is_an_empty_list_not_an_error() {
    let dir = test_dir("nosubs");
    let video = dir.join("Clip.mp4");
    fs::write(&video, b"x").expect("write video");
    assert!(find_sidecar_subtitles(&video).is_empty());
    assert!(find_sidecar_subtitles(&dir.join("does-not-exist.mp4")).is_empty());
}

#[test]
fn parked_fallback_name_does_not_collide() {
    let dir = test_dir("parked");
    let target = dir.join("Clip.mp4");
    fs::write(&target, b"x").expect("write target");
    let first = unique_sibling(&target);
    assert_eq!(first, dir.join("Clip (1).mp4"));
    fs::write(&first, b"x").expect("write first");
    assert_eq!(unique_sibling(&target), dir.join("Clip (2).mp4"));
}
