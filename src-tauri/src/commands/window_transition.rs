//! Spec: docs/code-rationale.md#W7
//!
//! Holds the pixels already on screen over the client area while the window
//! maximizes or restores, until the WebView2 has painted the new layout. The
//! window's new rect is composed by DWM at the next vblank, but Chromium's
//! frame for the new size arrives one frame later, anchored at the new client
//! origin: without the cover that stale frame shows the image displaced (W7).

// The geometry helpers only have callers in `native` and in the tests; the
// Linux CI build (no `native`, no tests) must not fail its clippy gate on them.
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use super::window::{FrameInsets, Rect};

/// `GWL_STYLE` show-state bits; `WS_MAXIMIZE` already reflects the state the
/// window is entering when `WM_WINDOWPOSCHANGING` arrives (measured, W7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ShowState {
    pub maximized: bool,
    pub minimized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Transition {
    Maximize,
    Restore,
}

impl Transition {
    fn label(self) -> &'static str {
        match self {
            Transition::Maximize => "maximize",
            Transition::Restore => "restore",
        }
    }
}

/// Minimizing clears `WS_MAXIMIZE` and restoring from the taskbar sets it
/// again, with nothing on screen to hold in between, so both are excluded.
pub(crate) fn transition_between(prev: ShowState, now: ShowState) -> Option<Transition> {
    if prev.minimized || now.minimized || prev.maximized == now.maximized {
        return None;
    }
    Some(if now.maximized {
        Transition::Maximize
    } else {
        Transition::Restore
    })
}

/// Outer rect `WM_WINDOWPOSCHANGING` proposes; `SWP_NOMOVE` / `SWP_NOSIZE`
/// mean the corresponding `WINDOWPOS` fields are unset.
pub(crate) fn proposed_outer_rect(
    current: Rect,
    pos: (i32, i32, i32, i32),
    no_move: bool,
    no_size: bool,
) -> Rect {
    let (x, y) = if no_move {
        (current.left, current.top)
    } else {
        (pos.0, pos.1)
    };
    let (cx, cy) = if no_size {
        (current.right - current.left, current.bottom - current.top)
    } else {
        (pos.2, pos.3)
    };
    Rect {
        left: x,
        top: y,
        right: x + cx,
        bottom: y + cy,
    }
}

pub(crate) fn restored_client_rect(outer: Rect, frame: FrameInsets) -> Rect {
    Rect {
        left: outer.left + frame.left,
        top: outer.top + frame.top,
        right: outer.right - frame.right,
        bottom: outer.bottom - frame.bottom,
    }
}

/// The maximized frame hangs its borders outside the work area (W5), so the
/// client is the work area minus the caption, i.e. the top inset less the
/// border that the bottom inset measures.
pub(crate) fn maximized_client_rect(work: Rect, frame: FrameInsets) -> Rect {
    Rect {
        left: work.left,
        top: work.top + (frame.top - frame.bottom),
        right: work.right,
        bottom: work.bottom,
    }
}

pub(crate) fn intersection(a: Rect, b: Rect) -> Option<Rect> {
    let r = Rect {
        left: a.left.max(b.left),
        top: a.top.max(b.top),
        right: a.right.min(b.right),
        bottom: a.bottom.min(b.bottom),
    };
    (r.right > r.left && r.bottom > r.top).then_some(r)
}

/// The frontend ends the transition after its re-layout painted (~2 frames);
/// this is for a page that never answers (hidden page, dev server gone). It
/// is short on purpose: the cover is a frozen picture, and for a restore it
/// is pixel-identical to the live image, so an early end costs one stale
/// frame while a late one hides navigation.
pub const END_FALLBACK: Duration = Duration::from_millis(250);

static NEXT_ID: AtomicU32 = AtomicU32::new(1);
/// Id of the transition whose cover is up; 0 when none.
static ACTIVE_ID: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, serde::Serialize)]
struct TransitionPayload {
    id: u32,
    /// New client size in physical px; the frontend waits for the viewport to
    /// reach it before signalling.
    width: u32,
    height: u32,
    /// Tauri 2 has no maximize event, so the store learns the new state from
    /// a `get_window_state` round trip after the resize; told here instead, the
    /// frontend lays out for the right area in the same frame as the resize.
    maximized: bool,
}

/// Installs the cover on the main window. No-op off Windows.
pub fn install(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Err(e) = native::install(window) {
        crate::utils::perf::phase("transition_cover", &format!(r#","ok":false,"err":{:?}"#, e));
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Frontend signal: the layout for the new client size has been painted.
#[tauri::command]
pub async fn end_window_transition(app_handle: AppHandle, id: u32) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;
    #[cfg(windows)]
    {
        window
            .run_on_main_thread(move || native::end(id, "frontend"))
            .map_err(|e| format!("Failed to reach the main thread: {}", e))
    }
    #[cfg(not(windows))]
    {
        let _ = (window, id);
        Ok(())
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::commands::window::native as win;
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use std::time::Instant;
    use tauri::Emitter;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{
        COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{
        BitBlt, ClientToScreen, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
        GetDC, GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, MONITORINFO,
        MONITOR_DEFAULTTONEAREST, SRCCOPY,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW,
        GetWindowRect, IsWindowVisible, KillTimer, RegisterClassExW, SetTimer, SetWindowPos,
        ShowWindow, UpdateLayeredWindow, CS_HREDRAW, CS_VREDRAW, GWL_STYLE, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, ULW_OPAQUE, WINDOWPOS,
        WM_NCDESTROY, WM_TIMER, WM_WINDOWPOSCHANGED, WM_WINDOWPOSCHANGING, WNDCLASSEXW,
        WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_MAXIMIZE,
        WS_MINIMIZE, WS_POPUP,
    };

    const SUBCLASS_ID: usize = 0x5753_3700; // 'WS7\0'

    static WINDOW: OnceLock<tauri::WebviewWindow> = OnceLock::new();

    thread_local! {
        /// Main-thread only: the cover window and the transition it is holding.
        /// Borrows are kept short and never span a Win32 call that could
        /// re-enter `subclass_proc` (showing/hiding the owned popup may
        /// message the owner); a nested borrow would panic inside an
        /// `extern "system"` frame and abort the process.
        static COVER: RefCell<Option<Cover>> = const { RefCell::new(None) };
    }

    /// A 32bpp top-down DIB selected into its own memory DC.
    struct Dib {
        dc: HDC,
        bitmap: HBITMAP,
        width: i32,
        height: i32,
    }

    impl Dib {
        fn new(width: i32, height: i32) -> Result<Dib, String> {
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut c_void = std::ptr::null_mut();
            // A fresh DIB section is zeroed, which is the black the cover
            // shows where no snapshot lands.
            let bitmap =
                unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0) }
                    .map_err(|e| format!("CreateDIBSection: {}", e))?;
            let dc = unsafe { CreateCompatibleDC(None) };
            if dc.is_invalid() {
                unsafe {
                    let _ = DeleteObject(bitmap.into());
                }
                return Err("CreateCompatibleDC failed".to_string());
            }
            if unsafe { SelectObject(dc, bitmap.into()) }.is_invalid() {
                unsafe {
                    let _ = DeleteDC(dc);
                    let _ = DeleteObject(bitmap.into());
                }
                return Err("SelectObject failed".to_string());
            }
            Ok(Dib {
                dc,
                bitmap,
                width,
                height,
            })
        }

        /// Copies what DWM last composed at `src` (screen px) to `dst` in
        /// this bitmap: the pixels the user is looking at right now.
        fn blit_from_screen(&self, dst: (i32, i32), src: Rect) -> Result<(), String> {
            let screen = unsafe { GetDC(None) };
            let result = unsafe {
                BitBlt(
                    self.dc,
                    dst.0,
                    dst.1,
                    src.right - src.left,
                    src.bottom - src.top,
                    Some(screen),
                    src.left,
                    src.top,
                    SRCCOPY,
                )
            };
            unsafe { ReleaseDC(None, screen) };
            result.map_err(|e| format!("BitBlt(screen): {}", e))
        }

        fn blit_from(&self, dst: (i32, i32), src: &Dib) -> Result<(), String> {
            unsafe {
                BitBlt(
                    self.dc,
                    dst.0,
                    dst.1,
                    src.width,
                    src.height,
                    Some(src.dc),
                    0,
                    0,
                    SRCCOPY,
                )
            }
            .map_err(|e| format!("BitBlt(dib): {}", e))
        }
    }

    impl Drop for Dib {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteDC(self.dc);
                let _ = DeleteObject(self.bitmap.into());
            }
        }
    }

    struct Holding {
        id: u32,
        kind: Transition,
        /// Screen px the cover currently occupies.
        cover: Rect,
        /// Old client pixels, kept for recomposing when the window's rect
        /// keeps changing under the cover.
        snapshot: Option<(Rect, Dib)>,
        /// Size last sent to the frontend; `None` until the first
        /// `WM_WINDOWPOSCHANGED` measured the real client rect.
        announced: Option<(u32, u32)>,
    }

    struct Cover {
        hwnd: HWND,
        main: HWND,
        /// Show state at the last `WM_WINDOWPOSCHANGED`.
        prev: ShowState,
        holding: Option<Holding>,
    }

    fn with_cover<R>(f: impl FnOnce(&mut Cover) -> R) -> Option<R> {
        COVER.with(|c| c.borrow_mut().as_mut().map(f))
    }

    fn show_state(hwnd: HWND) -> ShowState {
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32;
        ShowState {
            maximized: style & WS_MAXIMIZE.0 != 0,
            minimized: style & WS_MINIMIZE.0 != 0,
        }
    }

    fn client_rect_on_screen(hwnd: HWND) -> Result<Rect, String> {
        let mut rect = RECT::default();
        unsafe { GetClientRect(hwnd, &mut rect) }.map_err(|e| format!("GetClientRect: {}", e))?;
        let mut origin = POINT::default();
        if !unsafe { ClientToScreen(hwnd, &mut origin) }.as_bool() {
            return Err("ClientToScreen failed".to_string());
        }
        Ok(Rect {
            left: origin.x,
            top: origin.y,
            right: origin.x + rect.right,
            bottom: origin.y + rect.bottom,
        })
    }

    fn outer_rect(hwnd: HWND) -> Result<Rect, String> {
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|e| format!("GetWindowRect: {}", e))?;
        Ok(Rect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        })
    }

    fn work_area(hwnd: HWND) -> Result<Rect, String> {
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            return Err("GetMonitorInfoW failed".to_string());
        }
        Ok(Rect {
            left: info.rcWork.left,
            top: info.rcWork.top,
            right: info.rcWork.right,
            bottom: info.rcWork.bottom,
        })
    }

    fn size_of(rect: Rect) -> (u32, u32) {
        (
            (rect.right - rect.left).max(0) as u32,
            (rect.bottom - rect.top).max(0) as u32,
        )
    }

    /// The layered popup never paints (`UpdateLayeredWindow` hands it a
    /// finished bitmap); it only runs the fallback timer, whose id is the
    /// transition's.
    unsafe extern "system" fn cover_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_TIMER {
            end(wparam.0 as u32, "fallback");
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    fn create_cover_window(owner: HWND) -> Result<HWND, String> {
        static CLASS: OnceLock<Result<(), String>> = OnceLock::new();
        let class_name: PCWSTR = w!("SPICA_TRANSITION_COVER");
        let instance =
            unsafe { GetModuleHandleW(None) }.map_err(|e| format!("GetModuleHandleW: {}", e))?;
        CLASS
            .get_or_init(|| {
                let class = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    style: CS_HREDRAW | CS_VREDRAW,
                    lpfnWndProc: Some(cover_proc),
                    hInstance: HINSTANCE(instance.0),
                    lpszClassName: class_name,
                    ..Default::default()
                };
                if unsafe { RegisterClassExW(&class) } == 0 {
                    Err("RegisterClassExW failed".to_string())
                } else {
                    Ok(())
                }
            })
            .clone()?;
        // Owned by the main window so it stays above it; layered so its
        // content is set before it is shown; transparent so a click during
        // the ~2 frames it is up still reaches the page; no-activate so the
        // show never moves the focus.
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                class_name,
                w!(""),
                WS_POPUP,
                0,
                0,
                0,
                0,
                Some(owner),
                None,
                Some(HINSTANCE(instance.0)),
                None,
            )
        }
        .map_err(|e| format!("CreateWindowExW: {}", e))?;
        // Without this DWM fades the cover in and out.
        win::set_transitions_disabled(hwnd, true)?;
        Ok(hwnd)
    }

    pub(super) fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
        let main = win::hwnd_of(window)?;
        let hwnd = create_cover_window(main)?;
        let _ = WINDOW.set(window.clone());
        COVER.with(|c| {
            *c.borrow_mut() = Some(Cover {
                hwnd,
                main,
                prev: show_state(main),
                holding: None,
            });
        });
        // Installed after wry's parent subclass, so it runs before it: the
        // cover is up before wry resizes the WebView2 on WM_SIZE.
        if !unsafe { SetWindowSubclass(main, Some(subclass_proc), SUBCLASS_ID, 0) }.as_bool() {
            return Err("SetWindowSubclass failed".to_string());
        }
        crate::utils::perf::phase("transition_cover", r#","ok":true"#);
        Ok(())
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            WM_WINDOWPOSCHANGING => {
                let pos = unsafe { &*(lparam.0 as *const WINDOWPOS) };
                on_pos_changing(hwnd, pos);
            }
            WM_WINDOWPOSCHANGED => on_pos_changed(hwnd),
            WM_NCDESTROY => {
                let _ = unsafe { RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID) };
                let cover = COVER.with(|c| c.borrow_mut().take());
                if let Some(cover) = cover {
                    let _ = unsafe { DestroyWindow(cover.hwnd) };
                }
            }
            _ => {}
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    /// Before the rect changes: predict the new client, snapshot the old
    /// pixels that stay inside it, and show the cover there. Everything in
    /// this function delays the geometry change itself, so nothing stale is
    /// exposed while it runs.
    fn on_pos_changing(hwnd: HWND, pos: &WINDOWPOS) {
        if !super::super::window::webview_revealed() || !unsafe { IsWindowVisible(hwnd) }.as_bool()
        {
            return;
        }
        let Some(kind) =
            with_cover(|cover| transition_between(cover.prev, show_state(hwnd))).flatten()
        else {
            return;
        };
        let started = Instant::now();
        let result = begin(hwnd, kind, pos);
        let (ok, extra) = match &result {
            Ok(b) => (
                true,
                format!(
                    r#","id":{},"kind":"{}","capture_ms":{:.1},"present_ms":{:.1},"cover":[{},{},{},{}],"snapshot":{}"#,
                    b.id,
                    kind.label(),
                    b.capture_ms,
                    b.present_ms,
                    b.cover.left,
                    b.cover.top,
                    b.cover.right,
                    b.cover.bottom,
                    b.snapshot.map_or("null".to_string(), |s| {
                        format!("[{},{},{},{}]", s.left, s.top, s.right, s.bottom)
                    })
                ),
            ),
            Err(e) => (
                false,
                format!(r#","kind":"{}","err":{:?}"#, kind.label(), e),
            ),
        };
        crate::utils::perf::phase(
            "transition_begin",
            &format!(r#","ok":{},"ms":{:.1}{}"#, ok, ms_since(started), extra),
        );
    }

    fn ms_since(at: Instant) -> f64 {
        at.elapsed().as_secs_f64() * 1000.0
    }

    struct Begun {
        id: u32,
        cover: Rect,
        snapshot: Option<Rect>,
        /// Screen `BitBlt` (a DWM readback): the part of the delay worth watching.
        capture_ms: f64,
        present_ms: f64,
    }

    fn begin(hwnd: HWND, kind: Transition, pos: &WINDOWPOS) -> Result<Begun, String> {
        // A transition still covered is superseded; its picture may still be
        // in the frame the snapshot copies, which is harmless because a cover
        // only ever shows pixels that are right for its rect.
        let previous = ACTIVE_ID.load(Ordering::SeqCst);
        if previous != 0 {
            end(previous, "replaced");
        }
        let old_client = client_rect_on_screen(hwnd)?;
        let frame = win::frame_insets(hwnd, unsafe { GetDpiForWindow(hwnd) })?;
        let new_client = match kind {
            Transition::Restore => restored_client_rect(
                proposed_outer_rect(
                    outer_rect(hwnd)?,
                    (pos.x, pos.y, pos.cx, pos.cy),
                    pos.flags.contains(SWP_NOMOVE),
                    pos.flags.contains(SWP_NOSIZE),
                ),
                frame,
            ),
            // The proposed rect is the raw monitor size before WM_GETMINMAXINFO
            // trims it to the work area, so it is computed from the work area.
            Transition::Maximize => maximized_client_rect(work_area(hwnd)?, frame),
        };
        let capture_started = Instant::now();
        let snapshot = match intersection(new_client, old_client) {
            Some(rect) => {
                let dib = Dib::new(rect.right - rect.left, rect.bottom - rect.top)?;
                dib.blit_from_screen((0, 0), rect)?;
                Some((rect, dib))
            }
            None => None,
        };
        let capture_ms = ms_since(capture_started);
        let snapshot_rect = snapshot.as_ref().map(|(rect, _)| *rect);
        let cover_hwnd = with_cover(|cover| cover.hwnd).ok_or("cover not installed")?;
        // Best effort, like W1's: a failure costs the animation, not the cover.
        let _ = win::set_transitions_disabled(hwnd, true);
        let present_started = Instant::now();
        present(cover_hwnd, new_client, snapshot.as_ref())?;
        let present_ms = ms_since(present_started);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        with_cover(|cover| {
            cover.holding = Some(Holding {
                id,
                kind,
                cover: new_client,
                snapshot,
                announced: None,
            });
        });
        ACTIVE_ID.store(id, Ordering::SeqCst);
        unsafe {
            SetTimer(
                Some(cover_hwnd),
                id as usize,
                END_FALLBACK.as_millis() as u32,
                None,
            )
        };
        Ok(Begun {
            id,
            cover: new_client,
            snapshot: snapshot_rect,
            capture_ms,
            present_ms,
        })
    }

    /// Composes black + snapshot for `cover` and shows the window there.
    fn present(hwnd: HWND, cover: Rect, snapshot: Option<&(Rect, Dib)>) -> Result<(), String> {
        let width = cover.right - cover.left;
        let height = cover.bottom - cover.top;
        let dib = Dib::new(width, height)?;
        if let Some((rect, source)) = snapshot {
            dib.blit_from((rect.left - cover.left, rect.top - cover.top), source)?;
        }
        let origin = POINT {
            x: cover.left,
            y: cover.top,
        };
        let size = SIZE {
            cx: width,
            cy: height,
        };
        let zero = POINT::default();
        unsafe {
            UpdateLayeredWindow(
                hwnd,
                None,
                Some(&origin),
                Some(&size),
                Some(dib.dc),
                Some(&zero),
                COLORREF(0),
                None,
                ULW_OPAQUE,
            )
        }
        .map_err(|e| format!("UpdateLayeredWindow: {}", e))?;
        let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
        Ok(())
    }

    /// After each rect change while a cover is up (and before WM_SIZE lets
    /// wry resize the WebView2): keep the cover on the real client rect and
    /// tell the frontend what size to wait for. The rect can change more
    /// than once under one cover: W1 corrects size/position after the
    /// restore, and dragging a maximized caption restores under the cursor
    /// and keeps moving.
    fn on_pos_changed(hwnd: HWND) {
        let now = show_state(hwnd);
        let Some(Some((id, cover_hwnd, held, snapshot))) = with_cover(|cover| {
            cover.prev = now;
            let holding = cover.holding.as_mut()?;
            Some((
                holding.id,
                cover.hwnd,
                holding.cover,
                // Taken out for the duration of the Win32 calls below.
                holding.snapshot.take(),
            ))
        }) else {
            return;
        };
        let actual = client_rect_on_screen(hwnd);
        let placed = *actual.as_ref().unwrap_or(&held);
        let refit = match actual {
            Ok(actual) if actual == held => Ok(false),
            Ok(actual) if size_of(actual) == size_of(held) => unsafe {
                SetWindowPos(
                    cover_hwnd,
                    None,
                    actual.left,
                    actual.top,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                )
            }
            .map(|()| true)
            .map_err(|e| format!("SetWindowPos: {}", e)),
            Ok(actual) => present(cover_hwnd, actual, snapshot.as_ref()).map(|()| true),
            Err(e) => Err(e),
        };
        let payload = with_cover(|cover| {
            let holding = cover.holding.as_mut().filter(|h| h.id == id)?;
            holding.snapshot = snapshot;
            holding.cover = placed;
            let size = size_of(placed);
            if holding.announced == Some(size) {
                return None;
            }
            holding.announced = Some(size);
            Some(TransitionPayload {
                id,
                width: size.0,
                height: size.1,
                maximized: now.maximized,
            })
        })
        .flatten();
        let Some(payload) = payload else {
            return;
        };
        if let Some(window) = WINDOW.get() {
            let _ = window.emit("window-transition", payload.clone());
        }
        let (refit, err) = match refit {
            Ok(refit) => (refit, String::new()),
            Err(e) => (false, format!(r#","err":{:?}"#, e)),
        };
        crate::utils::perf::phase(
            "transition_placed",
            &format!(
                r#","id":{},"width":{},"height":{},"refit":{}{}"#,
                payload.id, payload.width, payload.height, refit, err
            ),
        );
    }

    /// Hides the cover of transition `id`; a stale id (a newer transition
    /// replaced the cover, or it already ended) does nothing.
    pub(super) fn end(id: u32, by: &str) {
        if ACTIVE_ID
            .compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let Some((cover_hwnd, main, kind)) =
            with_cover(|cover| (cover.hwnd, cover.main, cover.holding.take().map(|h| h.kind)))
        else {
            return;
        };
        unsafe {
            let _ = KillTimer(Some(cover_hwnd), id as usize);
            let _ = ShowWindow(cover_hwnd, SW_HIDE);
        }
        let _ = win::set_transitions_disabled(main, false);
        crate::utils::perf::phase(
            "transition_end",
            &format!(
                r#","id":{},"by":{:?},"kind":{}"#,
                id,
                by,
                kind.map_or("null".to_string(), |k| format!("{:?}", k.label()))
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE_RESTORED: ShowState = ShowState {
        maximized: false,
        minimized: false,
    };
    const STATE_MAXIMIZED: ShowState = ShowState {
        maximized: true,
        minimized: false,
    };
    const STATE_MINIMIZED: ShowState = ShowState {
        maximized: false,
        minimized: true,
    };

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect {
            left,
            top,
            right,
            bottom,
        }
    }

    // 100% DPI standard frame: 8px borders, 31px top (border + caption).
    const FRAME: FrameInsets = FrameInsets {
        left: 8,
        top: 31,
        right: 8,
        bottom: 8,
    };

    #[test]
    fn maximize_and_restore_are_transitions() {
        assert_eq!(
            transition_between(STATE_RESTORED, STATE_MAXIMIZED),
            Some(Transition::Maximize)
        );
        assert_eq!(
            transition_between(STATE_MAXIMIZED, STATE_RESTORED),
            Some(Transition::Restore)
        );
    }

    #[test]
    fn unchanged_state_is_no_transition() {
        assert_eq!(transition_between(STATE_RESTORED, STATE_RESTORED), None);
        assert_eq!(transition_between(STATE_MAXIMIZED, STATE_MAXIMIZED), None);
    }

    #[test]
    fn minimize_in_either_state_is_no_transition() {
        assert_eq!(transition_between(STATE_MAXIMIZED, STATE_MINIMIZED), None);
        assert_eq!(transition_between(STATE_MINIMIZED, STATE_MAXIMIZED), None);
        assert_eq!(transition_between(STATE_RESTORED, STATE_MINIMIZED), None);
    }

    #[test]
    fn restored_client_is_outer_minus_frame() {
        assert_eq!(
            restored_client_rect(rect(942, -11, 1618, 1301), FRAME),
            rect(950, 20, 1610, 1293)
        );
    }

    #[test]
    fn maximized_client_is_work_area_below_the_caption() {
        // Measured at 100%: work (0,0,2560,1392) -> client (0,23,2560,1392).
        assert_eq!(
            maximized_client_rect(rect(0, 0, 2560, 1392), FRAME),
            rect(0, 23, 2560, 1392)
        );
    }

    #[test]
    fn intersection_of_nested_rects_is_the_inner_one() {
        let maximized = rect(0, 23, 2560, 1392);
        let box_ = rect(950, 20, 1610, 1293);
        assert_eq!(
            intersection(box_, maximized),
            Some(rect(950, 23, 1610, 1293))
        );
        assert_eq!(
            intersection(maximized, box_),
            Some(rect(950, 23, 1610, 1293))
        );
    }

    #[test]
    fn intersection_of_disjoint_rects_is_none() {
        assert_eq!(intersection(rect(0, 0, 10, 10), rect(10, 0, 20, 10)), None);
        assert_eq!(intersection(rect(0, 0, 10, 10), rect(0, 10, 10, 20)), None);
    }

    #[test]
    fn proposed_rect_honours_nomove_and_nosize() {
        let current = rect(100, 100, 900, 700);
        assert_eq!(
            proposed_outer_rect(current, (5, 6, 300, 200), true, false),
            rect(100, 100, 400, 300)
        );
        assert_eq!(
            proposed_outer_rect(current, (5, 6, 300, 200), false, true),
            rect(5, 6, 805, 606)
        );
        assert_eq!(
            proposed_outer_rect(current, (5, 6, 300, 200), false, false),
            rect(5, 6, 305, 206)
        );
    }
}
