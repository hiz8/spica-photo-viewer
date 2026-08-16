//! Lightweight perf logging for bench runs. Enabled only when the process is
//! launched with SPICA_PERF=1; completely silent otherwise. One JSON object
//! per line on stderr so the bench harness (or a human) can grep/parse it.

use std::sync::OnceLock;
use std::time::Instant;

fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("SPICA_PERF").map(|v| v == "1").unwrap_or(false)
    })
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
        eprintln!("{}", format_perf_line(self.op, &self.path, ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // SPICA_PERF is not set in the test environment
        assert!(PerfTimer::start("decode", "x.jpg").is_none());
    }
}
