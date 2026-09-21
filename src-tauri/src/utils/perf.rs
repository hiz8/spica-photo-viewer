//! Lightweight perf logging for bench runs. Enabled only when the process is
//! launched with SPICA_PERF=1 or SPICA_PERF_FILE=<path>; completely silent
//! otherwise. One JSON object per line so the bench harness (or a human) can
//! grep/parse it.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("SPICA_PERF")
            .map(|v| v == "1")
            .unwrap_or(false)
            || file_sink().is_some()
    })
}

/// An Explorer launch has no stderr anyone can read, so SPICA_PERF_FILE
/// redirects the log to a file for field diagnosis (W3 evidence).
fn file_sink() -> Option<&'static PathBuf> {
    static SINK: OnceLock<Option<PathBuf>> = OnceLock::new();
    SINK.get_or_init(|| std::env::var_os("SPICA_PERF_FILE").map(PathBuf::from))
        .as_ref()
}

/// Failures are swallowed: diagnostics must never take the app down.
/// One write per line: emitters on other threads append through their own
/// handles, and a body write followed by a separate newline write lets two
/// lines interleave into `{a}{b}` plus an empty line.
pub(crate) fn append_line(path: &Path, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
}

/// Every perf line goes through here so the file sink covers all of them.
pub fn emit(line: String) {
    if !enabled() {
        return;
    }
    match file_sink() {
        Some(path) => append_line(path, &line),
        None => eprintln!("{line}"),
    }
}

/// Wall-clock ms since the UNIX epoch, on the same clock as the WebView's
/// `performance.timeOrigin`, so Rust startup phases can be lined up with
/// the frontend's marks.
pub fn wall_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Startup timeline point. `extra` is appended verbatim inside the JSON
/// object (e.g. `,"n":42`), empty for none.
pub fn phase(phase: &str, extra: &str) {
    if !enabled() {
        return;
    }
    emit(format!(
        r#"{{"perf":"rust","op":"startup","phase":{},"wall":{:.1}{}}}"#,
        serde_json::to_string(phase).unwrap_or_else(|_| "\"?\"".into()),
        wall_ms(),
        extra
    ));
}

pub fn format_perf_line(op: &str, path: &str, ms: f64) -> String {
    format!(
        r#"{{"perf":"rust","op":{},"path":{},"ms":{:.2}}}"#,
        serde_json::to_string(op).unwrap_or_else(|_| "\"?\"".into()),
        serde_json::to_string(path).unwrap_or_else(|_| "\"?\"".into()),
        ms
    )
}

pub struct PerfTimer {
    op: &'static str,
    path: String,
    start: Instant,
}

impl PerfTimer {
    pub fn start(op: &'static str, path: &str) -> Option<Self> {
        if !enabled() {
            return None;
        }
        Some(Self {
            op,
            path: path.to_string(),
            start: Instant::now(),
        })
    }
}

impl Drop for PerfTimer {
    fn drop(&mut self) {
        let ms = self.start.elapsed().as_secs_f64() * 1000.0;
        emit(format_perf_line(self.op, &self.path, ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_line_creates_and_appends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("perf.log");
        append_line(&path, "{\"a\":1}");
        append_line(&path, "{\"b\":2}");
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "{\"a\":1}\n{\"b\":2}\n");
    }

    #[test]
    fn concurrent_appends_keep_one_object_per_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("perf.log");
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for i in 0..200 {
                        append_line(&path, &format!(r#"{{"t":{t},"i":{i}}}"#));
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 8 * 200);
        for line in lines {
            serde_json::from_str::<serde_json::Value>(line)
                .unwrap_or_else(|e| panic!("torn line {line:?}: {e}"));
        }
    }

    #[test]
    fn append_line_ignores_unwritable_path() {
        append_line(Path::new("Z:/no/such/dir/perf.log"), "x");
    }

    #[test]
    fn test_format_perf_line_is_valid_json() {
        let line = format_perf_line("decode", r"C:\photos\a.jpg", 123.456);
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["perf"], "rust");
        assert_eq!(parsed["op"], "decode");
        assert_eq!(parsed["path"], r"C:\photos\a.jpg");
        assert!((parsed["ms"].as_f64().unwrap() - 123.46).abs() < 0.01);
    }

    #[test]
    fn test_timer_disabled_without_env_var() {
        assert!(PerfTimer::start("decode", "x.jpg").is_none());
    }
}
