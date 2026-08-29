//! Detects the sort setting of the Explorer window/tab showing a folder
//! (spec §6.3). Every COM failure collapses to `None` so callers fall back
//! to natural name order (I2). Non-Windows builds are a stub that always
//! yields `None` (I4).

use crate::commands::file::SortSpec;
use std::path::PathBuf;
use std::time::Instant;

/// Whole-detection budget measured from thread spawn (§6.3). The folder scan
/// runs concurrently, so join() only waits for whatever remains of it.
#[cfg(windows)]
const DETECT_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(300);

/// Foreground window at process launch, kept as isize because HWND is not
/// Send. Used to pick among multiple Explorer windows showing the folder.
/// Deliberately frozen for the process lifetime (OnceLock): once our own
/// window exists it IS the foreground window, so re-querying later could
/// never yield the Explorer window the user came from. Folders opened later
/// in the session resolve multi-window ties by enumeration order alone (R2).
#[cfg(windows)]
static FOREGROUND_AT_LAUNCH: std::sync::OnceLock<isize> = std::sync::OnceLock::new();

/// Detection threads spawned but not yet finished. RPC into a hung Explorer
/// can block far past the 300ms budget (default COM call timeouts are tens
/// of seconds), and the worker cannot be cancelled (§6.3) — so instead of
/// accumulating one blocked thread per folder open, `spawn_detect` skips COM
/// entirely while a previous probe is still running: a hung shell costs at
/// most one detached thread process-wide, and later opens fall back to
/// natural name order immediately (I2).
#[cfg(windows)]
static PROBES_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Call as early as possible in `run()`: the Explorer window the user
/// launched the app from is still foreground until Tauri creates our window.
pub fn stash_foreground_window() {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let hwnd = unsafe { GetForegroundWindow() };
        if !hwnd.is_invalid() {
            let _ = FOREGROUND_AT_LAUNCH.set(hwnd.0 as isize);
        }
    }
}

/// In-flight Explorer query started by `spawn_detect`.
pub struct SortProbe {
    #[cfg(windows)]
    rx: std::sync::mpsc::Receiver<Option<SortSpec>>,
    started: Instant,
}

/// Spawns the Explorer query on a dedicated COM thread, concurrent with the
/// caller's folder scan (spec §5).
#[cfg(windows)]
pub fn spawn_detect(folder: PathBuf) -> SortProbe {
    use std::sync::atomic::Ordering;

    let started = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();
    // A healthy probe always finishes before the next folder open (join()
    // caps it at 300ms and opens are user-paced), so a probe still in flight
    // means the previous one is stuck in a hung Explorer. Don't stack
    // another blocked thread on it: dropping tx makes join() resolve to
    // None (fallback) immediately.
    if PROBES_IN_FLIGHT.load(Ordering::Acquire) > 0 {
        drop(tx);
        return SortProbe { rx, started };
    }
    let foreground = FOREGROUND_AT_LAUNCH.get().copied();
    PROBES_IN_FLIGHT.fetch_add(1, Ordering::AcqRel);
    std::thread::spawn(move || {
        // Decrements even if detect_sort_spec panics (unwind drops the
        // guard), so detection can never get permanently disabled.
        struct InFlight;
        impl Drop for InFlight {
            fn drop(&mut self) {
                PROBES_IN_FLIGHT.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
            }
        }
        let guard = InFlight;
        let result = detect_sort_spec(&folder, foreground);
        // Decrement before send so a folder opened right after this result
        // lands is not mistaken for running against a stuck probe.
        drop(guard);
        let _ = tx.send(result);
    });
    SortProbe { rx, started }
}

/// Non-Windows stub: no Explorer, always resolves to None (I4).
#[cfg(not(windows))]
pub fn spawn_detect(folder: PathBuf) -> SortProbe {
    let _ = folder;
    SortProbe {
        started: Instant::now(),
    }
}

impl SortProbe {
    /// Returns (detected spec, elapsed ms). Waits only for the remainder of
    /// the 300ms budget measured from spawn; timeout or any COM failure is
    /// None. The COM call cannot be cancelled, so on timeout the worker
    /// thread stays detached (§6.3) — bounded to one such thread process-wide
    /// by `PROBES_IN_FLIGHT` (spawn_detect skips COM while one is stuck).
    pub fn join(self) -> (Option<SortSpec>, f64) {
        #[cfg(windows)]
        let spec = {
            let remaining = DETECT_TIMEOUT.saturating_sub(self.started.elapsed());
            self.rx.recv_timeout(remaining).ok().flatten()
        };
        #[cfg(not(windows))]
        let spec = None;
        (spec, self.started.elapsed().as_secs_f64() * 1000.0)
    }
}

/// Walks the open Explorer windows/tabs and returns the sort setting of the
/// one showing `folder`. Runs on a dedicated thread (spawn_detect) or a
/// probe binary; initializes STA COM for the duration of the query (§6.3).
#[cfg(windows)]
pub fn detect_sort_spec(
    folder: &std::path::Path,
    foreground_hwnd: Option<isize>,
) -> Option<SortSpec> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if hr.is_err() {
        return None;
    }
    let result = imp::scan_shell_windows(folder, foreground_hwnd);
    unsafe { CoUninitialize() };
    result
}

/// Normalizes a filesystem path for comparing an Explorer window's current
/// folder against the target folder (§6.3 step 6): strips the `\\?\` prefix,
/// unifies separators, drops trailing separators, lowercases. Compiled on all
/// platforms so the contract stays unit-tested on CI (ubuntu); only the
/// Windows COM path calls it at runtime.
pub fn normalize_path(p: &str) -> String {
    let p = p.strip_prefix(r"\\?\").unwrap_or(p);
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

#[cfg(all(windows, test))]
pub(crate) use imp::map_sort_column;

#[cfg(windows)]
mod imp {
    use crate::commands::file::{SortKey, SortSpec};
    use windows::Win32::UI::Shell::SORTCOLUMN;

    /// PSGUID_STORAGE: the fmtid shared by the standard column PROPERTYKEYs
    /// (spec appendix B).
    const FMTID_STORAGE: windows::core::GUID =
        windows::core::GUID::from_u128(0xB725F130_47EF_101A_A5F1_02608C9EEBAC);

    /// Appendix B mapping. Unmapped keys => None => caller falls back to
    /// natural name order ascending.
    pub(crate) fn map_sort_column(col: &SORTCOLUMN) -> Option<SortSpec> {
        if col.propkey.fmtid != FMTID_STORAGE {
            return None;
        }
        let key = match col.propkey.pid {
            10 => SortKey::Name,     // PKEY_ItemNameDisplay
            12 => SortKey::Size,     // PKEY_Size
            14 => SortKey::Modified, // PKEY_DateModified
            15 => SortKey::Created,  // PKEY_DateCreated
            4 => SortKey::Type,      // PKEY_ItemTypeText (approximated by extension, R4)
            _ => return None,
        };
        Some(SortSpec {
            key,
            descending: col.direction.0 < 0,
        })
    }

    use super::normalize_path;
    use std::path::Path;
    use windows::core::Interface;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, IDispatch, CLSCTX_ALL};
    use windows::Win32::System::Variant::{VARIANT, VARIANT_0_0, VARIANT_0_0_0, VT_I4};
    use windows::Win32::UI::Shell::{
        IFolderView2, IPersistFolder2, IShellBrowser, IShellView, IShellWindows,
        IUnknown_QueryService, SHGetPathFromIDListW, ShellWindows, SID_STopLevelBrowser,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};

    pub(super) fn scan_shell_windows(
        folder: &Path,
        foreground: Option<isize>,
    ) -> Option<SortSpec> {
        let target = normalize_path(&folder.to_string_lossy());
        let shell_windows: IShellWindows =
            unsafe { CoCreateInstance(&ShellWindows, None::<&windows::core::IUnknown>, CLSCTX_ALL) }
                .ok()?;
        let count = unsafe { shell_windows.Count() }.ok()?;
        // Outer Option: "some window showing the folder was seen"; inner:
        // that window's mapped spec. The FIRST matching window is locked in
        // deliberately — even when its sort key is unmapped — and only an
        // explicit foreground-HWND match overrides it. Letting a later
        // window with a mapped key win instead would contradict §6.3's
        // resolution order (known limitation R2; do not "fix" without
        // checking the spec).
        let mut first_match: Option<Option<SortSpec>> = None;
        for i in 0..count {
            let Some((view, top_hwnd)) = entry_at(&shell_windows, i) else {
                continue;
            };
            let Some(path) = current_folder_path(&view) else {
                continue;
            };
            if normalize_path(&path) != target {
                continue;
            }
            let spec = read_sort_spec(&view);
            // The window the user launched from wins outright (§6.3) — even
            // when its sort key is unmapped (=> Name fallback, D-P2-5).
            if foreground.is_some() && top_hwnd == foreground {
                return spec;
            }
            if first_match.is_none() {
                first_match = Some(spec);
            }
        }
        first_match.flatten()
    }

    /// Resolves one IShellWindows entry to its folder view and top-level
    /// frame HWND. Entries can be non-browser shell hosts or vanish
    /// mid-enumeration; any failure skips the entry.
    fn entry_at(shell_windows: &IShellWindows, index: i32) -> Option<(IFolderView2, Option<isize>)> {
        let mut idx = VARIANT::default();
        idx.Anonymous.Anonymous = std::mem::ManuallyDrop::new(VARIANT_0_0 {
            vt: VT_I4,
            wReserved1: 0,
            wReserved2: 0,
            wReserved3: 0,
            Anonymous: VARIANT_0_0_0 { lVal: index },
        });
        let disp: IDispatch = unsafe { shell_windows.Item(&idx) }.ok()?;
        let browser: IShellBrowser =
            unsafe { IUnknown_QueryService(&disp, &SID_STopLevelBrowser) }.ok()?;
        let view: IShellView = unsafe { browser.QueryActiveShellView() }.ok()?;
        let view2: IFolderView2 = view.cast().ok()?;
        // A Windows 11 tab's browser window is a child of the shared
        // top-level frame; GetForegroundWindow returns the frame, so
        // normalize via GA_ROOT before comparing (D-P2-3).
        let top = unsafe { browser.GetWindow() }
            .ok()
            .map(|h| unsafe { GetAncestor(h, GA_ROOT) }.0 as isize);
        Some((view2, top))
    }

    /// Real path of the folder the view is showing, via PIDL (§6.3 step 5).
    /// IWebBrowser2::LocationURL is NOT used (escaping/UNC format issues).
    fn current_folder_path(view: &IFolderView2) -> Option<String> {
        let persist: IPersistFolder2 = unsafe { view.GetFolder::<IPersistFolder2>() }.ok()?;
        let pidl = unsafe { persist.GetCurFolder() }.ok()?;
        if pidl.is_null() {
            return None;
        }
        let mut buf = [0u16; 260];
        let ok = unsafe { SHGetPathFromIDListW(pidl, &mut buf) }.as_bool();
        unsafe { CoTaskMemFree(Some(pidl as *const core::ffi::c_void)) };
        if !ok {
            // Virtual folders (This PC, ...) and > MAX_PATH folders (D-P2-7)
            // have no filesystem path here.
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    /// First sort column of the view, mapped to SortSpec (appendix B).
    /// Secondary columns are recorded to the perf log only (R12).
    fn read_sort_spec(view: &IFolderView2) -> Option<SortSpec> {
        let count = unsafe { view.GetSortColumnCount() }.ok()?;
        if count < 1 {
            return None;
        }
        let mut cols = vec![SORTCOLUMN::default(); count as usize];
        unsafe { view.GetSortColumns(&mut cols) }.ok()?;
        log_view_details(view, &cols);
        map_sort_column(&cols[0])
    }

    /// R12 (multi-column sorts) and R3 (grouping): recorded to the
    /// SPICA_PERF log as future decision material; never shown in UI (D4).
    fn log_view_details(view: &IFolderView2, cols: &[SORTCOLUMN]) {
        if !crate::utils::perf::enabled() {
            return;
        }
        if cols.len() > 1 {
            let all: Vec<String> = cols
                .iter()
                .map(|c| format!("{:?}/{}:{}", c.propkey.fmtid, c.propkey.pid, c.direction.0))
                .collect();
            eprintln!(
                r#"{{"perf":"rust","op":"explorer_sort_columns","ms":0.00,"detail":{}}}"#,
                serde_json::Value::String(all.join(";"))
            );
        }
        let mut key = PROPERTYKEY::default();
        let mut ascending = windows::core::BOOL(0);
        if unsafe { view.GetGroupBy(&mut key, Some(&mut ascending)) }.is_ok()
            && key.fmtid != windows::core::GUID::default()
        {
            eprintln!(
                r#"{{"perf":"rust","op":"explorer_group_by","ms":0.00,"detail":{}}}"#,
                serde_json::Value::String(format!(
                    "{:?}/{}:asc={}",
                    key.fmtid,
                    key.pid,
                    ascending.as_bool()
                ))
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn probe_on_unopened_folder_yields_none_within_budget() {
        // A fresh temp dir is never shown in any Explorer window, so the
        // probe must resolve to None on every platform. On Windows this
        // exercises the real COM chain (no matching window / no Explorer).
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let probe = spawn_detect(dir.path().to_path_buf());
        let (spec, ms) = probe.join();
        assert!(spec.is_none());
        assert!(ms >= 0.0);
        // join() must never wait past the 300ms budget by more than scheduling
        // slack (generous bound to avoid flakes on loaded machines).
        assert!(started.elapsed().as_millis() < 2000);
    }

    #[cfg(windows)]
    #[test]
    fn spawn_detect_skips_while_previous_probe_is_stuck() {
        use std::sync::atomic::Ordering;
        // Simulate a probe blocked in a hung Explorer RPC: with one in
        // flight, spawn_detect must not start another COM thread and must
        // resolve to fallback. (Other tests running concurrently just take
        // the same fallback they already expect for unopened folders.)
        super::PROBES_IN_FLIGHT.fetch_add(1, Ordering::AcqRel);
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let (spec, _ms) = spawn_detect(dir.path().to_path_buf()).join();
        super::PROBES_IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
        assert!(spec.is_none());
        // Hang guard only: the skip path is a channel drop + one atomic load,
        // nowhere near the 300ms COM budget.
        assert!(started.elapsed().as_millis() < 1000);
    }

    #[test]
    fn normalize_path_ignores_case_and_trailing_separator() {
        assert_eq!(
            normalize_path(r"C:\Users\X\Pictures\"),
            normalize_path(r"c:\users\x\pictures")
        );
    }

    #[test]
    fn normalize_path_strips_extended_length_prefix() {
        assert_eq!(
            normalize_path(r"\\?\C:\photos"),
            normalize_path(r"C:\photos")
        );
    }

    #[test]
    fn normalize_path_unifies_forward_slashes() {
        assert_eq!(normalize_path("C:/photos/2024"), normalize_path(r"C:\photos\2024"));
    }

    #[test]
    fn normalize_path_keeps_non_ascii() {
        assert_eq!(normalize_path("C:\\写真\\"), "c:\\写真");
    }

    #[test]
    fn normalize_path_distinguishes_different_folders() {
        assert_ne!(normalize_path(r"C:\a\b"), normalize_path(r"C:\a\c"));
    }

    #[cfg(windows)]
    mod windows_tests {
        use super::super::map_sort_column;
        use crate::commands::file::SortKey;
        use windows::Win32::Foundation::PROPERTYKEY;
        use windows::Win32::UI::Shell::{SORTCOLUMN, SORTDIRECTION};

        const STORAGE: windows::core::GUID =
            windows::core::GUID::from_u128(0xB725F130_47EF_101A_A5F1_02608C9EEBAC);

        fn col(fmtid: windows::core::GUID, pid: u32, dir: i32) -> SORTCOLUMN {
            SORTCOLUMN {
                propkey: PROPERTYKEY { fmtid, pid },
                direction: SORTDIRECTION(dir),
            }
        }

        #[test]
        fn maps_all_supported_pids() {
            for (pid, key) in [
                (10, SortKey::Name),
                (12, SortKey::Size),
                (14, SortKey::Modified),
                (15, SortKey::Created),
                (4, SortKey::Type),
            ] {
                let spec = map_sort_column(&col(STORAGE, pid, 1)).unwrap();
                assert_eq!(spec.key, key);
                assert!(!spec.descending);
            }
        }

        #[test]
        fn negative_direction_is_descending() {
            let spec = map_sort_column(&col(STORAGE, 12, -1)).unwrap();
            assert_eq!(spec.key, SortKey::Size);
            assert!(spec.descending);
        }

        #[test]
        fn unmapped_pid_is_none() {
            // e.g. pid 21 = PKEY_Author on the storage fmtid
            assert!(map_sort_column(&col(STORAGE, 21, 1)).is_none());
        }

        #[test]
        fn foreign_fmtid_is_none() {
            // PKEY_Photo_DateTaken {14B81DA1-0135-4D31-96D9-6CBFC9671A99},36867
            let taken = windows::core::GUID::from_u128(0x14B81DA1_0135_4D31_96D9_6CBFC9671A99);
            assert!(map_sort_column(&col(taken, 36867, 1)).is_none());
        }
    }
}
