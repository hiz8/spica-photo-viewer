use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

/// Title the window is born with. The frontend (useWindowTitle) sets the same
/// string again once React mounts; seeding it here keeps a file-association
/// launch from flashing the bare app name for the ~500ms until then.
/// Splits on both separators like the frontend's getFilename, rather than
/// `Path::file_name`, so the two agree on every platform CI runs on.
pub fn startup_title(app_name: &str, startup_file: Option<&str>) -> String {
    match startup_file.and_then(|p| p.rsplit(['\\', '/']).next()) {
        Some(file_name) if !file_name.is_empty() => format!("{file_name} - {app_name}"),
        _ => app_name.to_string(),
    }
}

#[tauri::command]
pub async fn get_window_position(app_handle: AppHandle) -> Result<WindowPosition, String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;

    let position = window
        .outer_position()
        .map_err(|e| format!("Failed to get window position: {}", e))?;

    Ok(WindowPosition {
        x: position.x,
        y: position.y,
    })
}

#[tauri::command]
pub async fn get_window_state(app_handle: AppHandle) -> Result<WindowState, String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;

    let is_maximized = window
        .is_maximized()
        .map_err(|e| format!("Failed to check if window is maximized: {}", e))?;

    let is_fullscreen = window
        .is_fullscreen()
        .map_err(|e| format!("Failed to check if window is fullscreen: {}", e))?;

    Ok(WindowState {
        is_maximized,
        is_fullscreen,
    })
}

/// Client area to shrink the window to, in CSS px of the maximized window's
/// viewport (computed by the frontend's `windowedClientBox`).
pub(crate) struct ClientBox {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// Physical screen-space rectangle (left/top inclusive, right/bottom exclusive).
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq, Clone, Copy)]
pub(crate) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    /// Zero-area rects and rects that only share an edge do not overlap.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn intersects(&self, other: &Rect) -> bool {
        self.left < other.right
            && other.left < self.right
            && self.top < other.bottom
            && other.top < self.bottom
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy)]
pub(crate) struct ZWindow {
    pub hwnd: isize,
    pub visible: bool,
    pub minimized: bool,
    pub tool_window: bool,
    pub topmost: bool,
    pub cloaked: bool,
    pub owned: bool,
    pub rect: Rect,
}

/// The first window in `above` (z-order top to bottom) that really hides part
/// of ours (docs/code-rationale.md#W3): topmost windows are skipped because
/// HWND_TOP cannot pass them, and the rect test keeps a window on another
/// monitor from triggering a raise.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn covering_window(above: &[ZWindow], ours: Rect) -> Option<isize> {
    above
        .iter()
        .find(|w| {
            w.visible
                && !w.minimized
                && !w.tool_window
                && !w.topmost
                && !w.cloaked
                && !w.owned
                && w.rect.intersects(&ours)
        })
        .map(|w| w.hwnd)
}

/// Thickness of the restored window's frame on each side of the client area.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy)]
pub(crate) struct FrameInsets {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// Max inner size given to the window builder: well above any monitor so the
/// OS max tracking size never trims a zoomed-in image's window, yet under the
/// 16-bit width/height packing of WM_SIZE up to 200% DPI (at higher scales
/// only a window that actually reaches the ceiling is affected). It must be a
/// builder attribute: tao's `set_max_size` re-applies the current size through
/// `set_inner_size`, which un-maximizes the window (docs/code-rationale.md#W1).
pub const MAX_TRACK_LOGICAL_PX: f64 = 32_000.0;

/// Screen-space physical position and size of the client box. CSS px are
/// scaled by the window's DPI factor and offset from the current client
/// origin, so the box lands where the image is on screen.
pub(crate) fn physical_client_target(
    client: &ClientBox,
    scale: f64,
    inner_origin: PhysicalPosition<i32>,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let x = (inner_origin.x as f64 + client.left * scale).round() as i32;
    let y = (inner_origin.y as f64 + client.top * scale).round() as i32;
    let width = (client.width * scale).round().max(1.0) as u32;
    let height = (client.height * scale).round().max(1.0) as u32;
    (
        PhysicalPosition::new(x, y),
        PhysicalSize::new(width, height),
    )
}

/// Outer position that puts the client area at `inner_target`. `set_position`
/// moves the outer frame while `set_size` sizes the client area, so the frame
/// offset (title bar and border) measured on the restored window is subtracted.
pub(crate) fn outer_position_for(
    inner_target: PhysicalPosition<i32>,
    outer: PhysicalPosition<i32>,
    inner: PhysicalPosition<i32>,
) -> PhysicalPosition<i32> {
    PhysicalPosition::new(
        inner_target.x - (inner.x - outer.x),
        inner_target.y - (inner.y - outer.y),
    )
}

/// Outer rectangle whose client area is exactly `size` at `inner_target`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn restored_outer_rect(
    inner_target: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    frame: FrameInsets,
) -> Rect {
    Rect {
        left: inner_target.x - frame.left,
        top: inner_target.y - frame.top,
        right: inner_target.x + size.width as i32 + frame.right,
        bottom: inner_target.y + size.height as i32 + frame.bottom,
    }
}

/// `WINDOWPLACEMENT.rcNormalPosition` is in workspace coordinates, which
/// differ from screen coordinates by the PRIMARY work area's origin on every
/// monitor (a taskbar docked at the top or left shifts them); a secondary
/// monitor's own work area is not involved (measured, see W1).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn to_workspace(rect: Rect, work_area_origin: PhysicalPosition<i32>) -> Rect {
    Rect {
        left: rect.left - work_area_origin.x,
        top: rect.top - work_area_origin.y,
        right: rect.right - work_area_origin.x,
        bottom: rect.bottom - work_area_origin.y,
    }
}

/// Outer rect Windows gives a window maximized on `work`: the resize border
/// hangs outside the work area on every side (W5).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn maximized_outer_rect(work: Rect, frame: FrameInsets) -> Rect {
    Rect {
        left: work.left - frame.left,
        top: work.top - frame.bottom,
        right: work.right + frame.right,
        bottom: work.bottom + frame.bottom,
    }
}

/// Outer rect of a `client`-sized restored window centered in `work`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn centered_restored_rect(
    work: Rect,
    client: PhysicalSize<u32>,
    frame: FrameInsets,
) -> Rect {
    let width = client.width as i32 + frame.left + frame.right;
    let height = client.height as i32 + frame.top + frame.bottom;
    let left = work.left + (work.right - work.left - width) / 2;
    let top = work.top + (work.bottom - work.top - height) / 2;
    Rect {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}

#[cfg(windows)]
mod native {
    use super::{FrameInsets, Rect, ZWindow};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use tauri::PhysicalPosition;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_CLOAKED,
        DWMWA_TRANSITIONS_FORCEDISABLED,
    };
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetTopWindow, GetWindow, GetWindowLongPtrW, GetWindowPlacement,
        GetWindowRect, IsIconic, IsWindowVisible, SetWindowPlacement, SetWindowPos,
        SetWindowsHookExW, SystemParametersInfoW, UnhookWindowsHookEx, CWPRETSTRUCT, GWL_EXSTYLE,
        GWL_STYLE, GW_HWNDNEXT, GW_OWNER, HC_ACTION, HHOOK, HWND_TOP, SPI_GETWORKAREA,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        WH_CALLWNDPROCRET, WINDOWPLACEMENT, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CREATE, WS_CAPTION,
        WS_CHILD, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_MAXIMIZE,
    };

    fn window_rect(hwnd: HWND) -> Option<Rect> {
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect) }.ok()?;
        Some(Rect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        })
    }

    /// A DWM failure is read as "not cloaked" so an unreadable window still
    /// counts as covering; raising under an already-held foreground is harmless.
    fn is_cloaked(hwnd: HWND) -> bool {
        let mut cloaked: u32 = 0;
        unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
            )
        }
        .map(|_| cloaked != 0)
        .unwrap_or(false)
    }

    fn z_window(hwnd: HWND) -> Option<ZWindow> {
        let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        Some(ZWindow {
            hwnd: hwnd.0 as isize,
            visible: unsafe { IsWindowVisible(hwnd) }.as_bool(),
            minimized: unsafe { IsIconic(hwnd) }.as_bool(),
            tool_window: ex_style & WS_EX_TOOLWINDOW.0 != 0,
            topmost: ex_style & WS_EX_TOPMOST.0 != 0,
            cloaked: is_cloaked(hwnd),
            owned: unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok(),
            rect: window_rect(hwnd)?,
        })
    }

    /// Top-level windows above `ours`, z-order top to bottom. `None` when the
    /// walk ends without reaching ours (nothing can be said about its cover).
    pub(super) fn windows_above(ours: HWND) -> Option<Vec<ZWindow>> {
        let mut above = Vec::new();
        let mut cursor = unsafe { GetTopWindow(None) }.ok()?;
        while cursor != ours {
            if let Some(w) = z_window(cursor) {
                above.push(w);
            }
            cursor = unsafe { GetWindow(cursor, GW_HWNDNEXT) }.ok()?;
        }
        Some(above)
    }

    pub(super) fn covering_window(ours: HWND) -> Option<isize> {
        let rect = window_rect(ours)?;
        super::covering_window(&windows_above(ours)?, rect)
    }

    /// SWP_NOACTIVATE: only the z-order moves; activation is already ours and
    /// re-activating could make the OS re-run its foreground checks (W3).
    pub(super) fn raise_to_top(hwnd: HWND) -> Result<(), String> {
        unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        }
        .map_err(|e| format!("Failed to raise the window: {}", e))
    }

    pub(super) fn hwnd_of(window: &tauri::WebviewWindow) -> Result<HWND, String> {
        // tauri hands out the HWND of its own `windows` crate version; both
        // versions wrap the same raw pointer.
        let raw = window
            .hwnd()
            .map_err(|e| format!("Failed to get window handle: {}", e))?;
        Ok(HWND(raw.0))
    }

    /// The DWM restore animation scales the last composited frame from the
    /// maximized rect to the restored one, which visibly shrinks and moves the
    /// image; disabling it makes the restore land in one frame.
    pub(super) fn set_transitions_disabled(hwnd: HWND, disabled: bool) -> Result<(), String> {
        let value = BOOL(i32::from(disabled));
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &value as *const BOOL as *const c_void,
                std::mem::size_of::<BOOL>() as u32,
            )
        }
        .map_err(|e| format!("Failed to set DWM transitions: {}", e))
    }

    /// Frame of the *restored* window: WS_MAXIMIZE is cleared from the current
    /// style because the maximized frame is laid out differently.
    pub(super) fn frame_insets(hwnd: HWND, dpi: u32) -> Result<FrameInsets, String> {
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32 & !WS_MAXIMIZE.0;
        let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        let mut rect = RECT::default();
        unsafe {
            AdjustWindowRectExForDpi(
                &mut rect,
                WINDOW_STYLE(style),
                false,
                WINDOW_EX_STYLE(ex_style),
                dpi,
            )
        }
        .map_err(|e| format!("Failed to compute the window frame: {}", e))?;
        Ok(FrameInsets {
            left: -rect.left,
            top: -rect.top,
            right: rect.right,
            bottom: rect.bottom,
        })
    }

    /// SPI_GETWORKAREA is the primary monitor's work area by definition, and
    /// that is the origin workspace coordinates use on every monitor (W1).
    pub(super) fn work_area_origin() -> Result<PhysicalPosition<i32>, String> {
        let mut rect = RECT::default();
        unsafe {
            SystemParametersInfoW(
                SPI_GETWORKAREA,
                0,
                Some(&mut rect as *mut RECT as *mut c_void),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        }
        .map_err(|e| format!("Failed to read the work area: {}", e))?;
        Ok(PhysicalPosition::new(rect.left, rect.top))
    }

    static FIRST_SHOW_HOOK: AtomicIsize = AtomicIsize::new(0);
    static FIRST_SHOW_PLACED: AtomicBool = AtomicBool::new(false);

    /// The WebView2 windows are children and tao's event-target window exists
    /// before `.build()`, so the first captioned top-level one is the main window.
    fn is_captioned_top_level(hwnd: HWND) -> bool {
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32;
        style & WS_CAPTION.0 == WS_CAPTION.0 && style & WS_CHILD.0 == 0
    }

    /// The monitor is the one the OS placed the window on (CW_USEDEFAULT), which
    /// is where maximized creation used to maximize it.
    fn place_on_maximized_rect(hwnd: HWND) -> Result<Rect, String> {
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            return Err("Failed to read the monitor's work area".to_string());
        }
        let work = Rect {
            left: info.rcWork.left,
            top: info.rcWork.top,
            right: info.rcWork.right,
            bottom: info.rcWork.bottom,
        };
        let rect = super::maximized_outer_rect(
            work,
            frame_insets(hwnd, unsafe { GetDpiForWindow(hwnd) })?,
        );
        unsafe {
            SetWindowPos(
                hwnd,
                None,
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        }
        .map_err(|e| format!("Failed to place the window: {}", e))?;
        Ok(rect)
    }

    /// WH_CALLWNDPROCRET sees WM_CREATE after the window procedure ran and
    /// before CreateWindowEx returns, so tao has not shown the window yet.
    unsafe extern "system" fn first_show_hook(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 && !FIRST_SHOW_PLACED.load(Ordering::Relaxed) {
            let msg = unsafe { &*(lparam.0 as *const CWPRETSTRUCT) };
            if msg.message == WM_CREATE && is_captioned_top_level(msg.hwnd) {
                FIRST_SHOW_PLACED.store(true, Ordering::Relaxed);
                let extra = match place_on_maximized_rect(msg.hwnd) {
                    Ok(r) => format!(
                        r#","ok":true,"rect":[{},{},{},{}]"#,
                        r.left, r.top, r.right, r.bottom
                    ),
                    Err(e) => format!(r#","ok":false,"err":{:?}"#, e),
                };
                crate::utils::perf::phase("first_show_rect", &extra);
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    pub(super) fn install_first_show_hook() -> Result<(), String> {
        FIRST_SHOW_PLACED.store(false, Ordering::Relaxed);
        let hook = unsafe {
            SetWindowsHookExW(
                WH_CALLWNDPROCRET,
                Some(first_show_hook),
                None,
                GetCurrentThreadId(),
            )
        }
        .map_err(|e| format!("Failed to hook window creation: {}", e))?;
        FIRST_SHOW_HOOK.store(hook.0 as isize, Ordering::Relaxed);
        Ok(())
    }

    pub(super) fn remove_first_show_hook() {
        let raw = FIRST_SHOW_HOOK.swap(0, Ordering::Relaxed);
        if raw != 0 {
            let _ = unsafe { UnhookWindowsHookEx(HHOOK(raw as *mut c_void)) };
        }
    }

    /// Rewrites only the rect the next SW_RESTORE lands on; the show state is
    /// left as read, so the window stays maximized until tao restores it.
    pub(super) fn set_restore_rect(hwnd: HWND, workspace: Rect) -> Result<(), String> {
        let mut placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        unsafe { GetWindowPlacement(hwnd, &mut placement) }
            .map_err(|e| format!("Failed to read the window placement: {}", e))?;
        placement.rcNormalPosition = RECT {
            left: workspace.left,
            top: workspace.top,
            right: workspace.right,
            bottom: workspace.bottom,
        };
        unsafe { SetWindowPlacement(hwnd, &placement) }
            .map_err(|e| format!("Failed to set the window placement: {}", e))
    }
}

/// Restores the window straight onto the target client rect: the restore rect
/// is written first so tao's `unmaximize` (SW_RESTORE) is the only geometry
/// change. The result is verified and corrected once if the OS applied a
/// different frame or work-area offset.
#[cfg_attr(not(windows), allow(unused_variables))]
fn restore_onto(
    window: &tauri::WebviewWindow,
    target_inner: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = native::hwnd_of(window)?;
        let frame = native::frame_insets(hwnd, (scale * 96.0).round() as u32)?;
        let outer = restored_outer_rect(target_inner, size, frame);
        native::set_restore_rect(hwnd, to_workspace(outer, native::work_area_origin()?))?;
    }

    window
        .unmaximize()
        .map_err(|e| format!("Failed to unmaximize window: {}", e))?;

    let inner_size = window
        .inner_size()
        .map_err(|e| format!("Failed to get window size: {}", e))?;
    if inner_size != size {
        window
            .set_size(size)
            .map_err(|e| format!("Failed to resize window: {}", e))?;
    }

    let inner = window
        .inner_position()
        .map_err(|e| format!("Failed to get window inner position: {}", e))?;
    if inner != target_inner {
        let outer = window
            .outer_position()
            .map_err(|e| format!("Failed to get window position: {}", e))?;
        window
            .set_position(outer_position_for(target_inner, outer, inner))
            .map_err(|e| format!("Failed to set window position: {}", e))?;
    }

    Ok(())
}

/// Leaves maximized mode with the client area exactly on the given box, so the
/// displayed image does not move on screen (docs/code-rationale.md#W1).
#[tauri::command]
pub async fn resize_window_to_image(
    app_handle: AppHandle,
    client_left: f64,
    client_top: f64,
    client_width: f64,
    client_height: f64,
) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;

    let is_maximized = window
        .is_maximized()
        .map_err(|e| format!("Failed to check if window is maximized: {}", e))?;
    if !is_maximized {
        return Err("Window is not maximized".to_string());
    }

    let scale = window
        .scale_factor()
        .map_err(|e| format!("Failed to get scale factor: {}", e))?;
    let inner_origin = window
        .inner_position()
        .map_err(|e| format!("Failed to get window inner position: {}", e))?;
    let (target_inner, size) = physical_client_target(
        &ClientBox {
            left: client_left,
            top: client_top,
            width: client_width,
            height: client_height,
        },
        scale,
        inner_origin,
    );

    #[cfg(windows)]
    let hwnd = native::hwnd_of(&window)?;
    #[cfg(windows)]
    native::set_transitions_disabled(hwnd, true)?;
    let placed = restore_onto(&window, target_inner, size, scale);
    // Re-enable before reporting so a failed restore never leaves the window
    // without its minimize/maximize animations; a restore error is the more
    // useful one to report, so it takes precedence over a re-enable error.
    // `and` (not `and_then`) evaluates its argument eagerly, so the re-enable
    // call runs even when `placed` is an error.
    #[cfg(windows)]
    let placed = placed.and(native::set_transitions_disabled(hwnd, false));
    placed
}

#[derive(serde::Serialize)]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(serde::Serialize)]
pub struct WindowState {
    pub is_maximized: bool,
    pub is_fullscreen: bool,
}

#[tauri::command]
pub async fn maximize_window(app_handle: AppHandle) -> Result<(), String> {
    crate::utils::perf::phase("maximize_start", "");
    let window = app_handle
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;

    window
        .maximize()
        .map_err(|e| format!("Failed to maximize window: {}", e))?;
    crate::utils::perf::phase("maximize_end", "");

    Ok(())
}

/// While alive, the main window `.build()` creates is born on the maximized
/// outer rect of its monitor, restored (docs/code-rationale.md#W5). Drop it
/// right after `.build()` so no later window is touched.
pub struct FirstShowPlacement(());

impl FirstShowPlacement {
    pub fn install() -> Self {
        #[cfg(windows)]
        if let Err(e) = native::install_first_show_hook() {
            crate::utils::perf::phase("first_show_rect", &format!(r#","ok":false,"err":{:?}"#, e));
        }
        FirstShowPlacement(())
    }
}

impl Drop for FirstShowPlacement {
    fn drop(&mut self) {
        #[cfg(windows)]
        native::remove_first_show_hook();
    }
}

/// Maximizes the window born by `FirstShowPlacement` and points its restore
/// rect at `restored` (logical px) centered on the monitor, which is where a
/// maximized-born window restored to; otherwise Restore would keep the
/// maximized rect (W5).
#[cfg_attr(not(windows), allow(unused_variables))]
pub fn maximize_born_window(
    window: &tauri::WebviewWindow,
    restored: (f64, f64),
) -> Result<(), String> {
    window
        .maximize()
        .map_err(|e| format!("Failed to maximize window: {}", e))?;
    #[cfg(windows)]
    {
        let monitor = window
            .current_monitor()
            .map_err(|e| format!("Failed to get the monitor: {}", e))?
            .ok_or("Window is on no monitor")?;
        let area = monitor.work_area();
        let work = Rect {
            left: area.position.x,
            top: area.position.y,
            right: area.position.x + area.size.width as i32,
            bottom: area.position.y + area.size.height as i32,
        };
        let scale = monitor.scale_factor();
        let client = PhysicalSize::new(
            (restored.0 * scale).round() as u32,
            (restored.1 * scale).round() as u32,
        );
        let hwnd = native::hwnd_of(window)?;
        let frame = native::frame_insets(hwnd, (scale * 96.0).round() as u32)?;
        let outer = centered_restored_rect(work, client, frame);
        native::set_restore_rect(hwnd, to_workspace(outer, native::work_area_origin()?))?;
    }
    Ok(())
}

pub struct ForegroundState {
    pub is_ours: bool,
    pub foreground: isize,
    /// The window covering ours while the foreground is ours (W3), else 0.
    pub z_above: isize,
}

#[cfg(windows)]
pub fn foreground_state(window: &tauri::WebviewWindow) -> ForegroundState {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let fg = unsafe { GetForegroundWindow() };
    let hwnd = native::hwnd_of(window).ok();
    let is_ours = hwnd == Some(fg);
    ForegroundState {
        is_ours,
        foreground: fg.0 as isize,
        z_above: hwnd
            .filter(|_| is_ours)
            .and_then(native::covering_window)
            .unwrap_or(0),
    }
}

/// Non-Windows always reports "ours, uncovered" so the startup z raise is a
/// no-op there.
#[cfg(not(windows))]
pub fn foreground_state(window: &tauri::WebviewWindow) -> ForegroundState {
    let _ = window;
    ForegroundState {
        is_ours: true,
        foreground: 0,
        z_above: 0,
    }
}

/// Bounds of the startup z raise (docs/code-rationale.md#W3), measured from
/// our window's creation: inside the double-click's own launch, never once
/// the user has moved on. Two attempts cover its two triggers
/// (window_created, page_load_finished).
pub const Z_RAISE_WINDOW: Duration = Duration::from_millis(1500);
pub const Z_RAISE_MAX: u32 = 2;

pub(crate) fn should_raise_z(
    launched_with_file: bool,
    is_ours: bool,
    covered: bool,
    elapsed: Duration,
    attempts: u32,
) -> bool {
    launched_with_file && is_ours && covered && elapsed <= Z_RAISE_WINDOW && attempts < Z_RAISE_MAX
}

#[cfg(windows)]
fn raise_z(window: &tauri::WebviewWindow) -> Result<(), String> {
    native::raise_to_top(native::hwnd_of(window)?)
}

#[cfg(not(windows))]
fn raise_z(window: &tauri::WebviewWindow) -> Result<(), String> {
    let _ = window;
    Ok(())
}

/// Puts our window back on top when the launcher rose above it while the
/// foreground stayed ours (W3). Only the z-order is fixed: re-taking the
/// foreground was removed, the field never needed it (W2).
pub fn raise_startup_z(
    window: &tauri::WebviewWindow,
    launched_with_file: bool,
    window_created_at: Instant,
    attempts: &AtomicU32,
    phase: &str,
) {
    let state = foreground_state(window);
    let n = attempts.load(Ordering::Relaxed);
    if !should_raise_z(
        launched_with_file,
        state.is_ours,
        state.z_above != 0,
        window_created_at.elapsed(),
        n,
    ) {
        return;
    }
    attempts.fetch_add(1, Ordering::Relaxed);
    let result = raise_z(window);
    crate::utils::perf::phase(
        "z_raise",
        &format!(
            r#","at":"{phase}","above":{},"ok":{},"err":{:?}"#,
            state.z_above,
            result.is_ok(),
            result.err().unwrap_or_default()
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(left: f64, top: f64, width: f64, height: f64) -> ClientBox {
        ClientBox {
            left,
            top,
            width,
            height,
        }
    }

    #[test]
    fn client_target_offsets_from_the_current_client_origin() {
        let (pos, size) = physical_client_target(
            &client(790.0, 364.0, 1000.0, 500.0),
            1.0,
            PhysicalPosition::new(0, 31),
        );
        assert_eq!(pos, PhysicalPosition::new(790, 395));
        assert_eq!(size, PhysicalSize::new(1000, 500));
    }

    #[test]
    fn client_target_scales_css_px_by_the_dpi_factor() {
        let (pos, size) = physical_client_target(
            &client(100.0, 20.0, 544.0, 272.0),
            1.5,
            PhysicalPosition::new(0, 0),
        );
        assert_eq!(pos, PhysicalPosition::new(150, 30));
        assert_eq!(size, PhysicalSize::new(816, 408));
    }

    #[test]
    fn client_target_rounds_fractional_sizes_to_whole_px() {
        let (_, size) = physical_client_target(
            &client(0.0, 0.0, 666.67, 333.33),
            1.0,
            PhysicalPosition::new(0, 0),
        );
        assert_eq!(size, PhysicalSize::new(667, 333));
    }

    #[test]
    fn client_target_may_start_above_the_screen() {
        let (pos, _) = physical_client_target(
            &client(0.0, -50.0, 800.0, 600.0),
            1.0,
            PhysicalPosition::new(0, 31),
        );
        assert_eq!(pos, PhysicalPosition::new(0, -19));
    }

    #[test]
    fn outer_position_subtracts_the_measured_frame_offset() {
        let outer = outer_position_for(
            PhysicalPosition::new(790, 395),
            PhysicalPosition::new(100, 100),
            PhysicalPosition::new(108, 131),
        );
        assert_eq!(outer, PhysicalPosition::new(782, 364));
    }

    #[test]
    fn restored_outer_rect_wraps_the_client_target_in_the_frame() {
        let rect = restored_outer_rect(
            PhysicalPosition::new(790, 395),
            PhysicalSize::new(1000, 500),
            FrameInsets {
                left: 8,
                top: 31,
                right: 8,
                bottom: 8,
            },
        );
        assert_eq!(
            rect,
            Rect {
                left: 782,
                top: 364,
                right: 1798,
                bottom: 903
            }
        );
    }

    fn ours() -> Rect {
        Rect {
            left: 0,
            top: 0,
            right: 2560,
            bottom: 1392,
        }
    }

    /// WS_OVERLAPPEDWINDOW at 100% DPI.
    fn frame_100() -> FrameInsets {
        FrameInsets {
            left: 8,
            top: 31,
            right: 8,
            bottom: 8,
        }
    }

    #[test]
    fn maximized_outer_rect_matches_what_windows_reports() {
        // GetWindowRect of a maximized window on a 2560x1392 work area.
        assert_eq!(
            maximized_outer_rect(ours(), frame_100()),
            Rect {
                left: -8,
                top: -8,
                right: 2568,
                bottom: 1400
            }
        );
    }

    #[test]
    fn maximized_outer_rect_follows_a_work_area_off_the_origin() {
        // Taskbar docked on the left of a secondary monitor.
        let work = Rect {
            left: 2608,
            top: 0,
            right: 5120,
            bottom: 1440,
        };
        assert_eq!(
            maximized_outer_rect(work, frame_100()),
            Rect {
                left: 2600,
                top: -8,
                right: 5128,
                bottom: 1448
            }
        );
    }

    #[test]
    fn centered_restored_rect_wraps_the_client_in_the_frame_at_the_center() {
        // The config's 800x600 restores to an 816x639 outer rect.
        assert_eq!(
            centered_restored_rect(ours(), PhysicalSize::new(800, 600), frame_100()),
            Rect {
                left: 872,
                top: 376,
                right: 1688,
                bottom: 1015
            }
        );
    }

    #[test]
    fn centered_restored_rect_is_relative_to_the_work_area() {
        let work = Rect {
            left: 2560,
            top: 40,
            right: 5120,
            bottom: 1480,
        };
        let rect = centered_restored_rect(work, PhysicalSize::new(800, 600), frame_100());
        assert_eq!((rect.left, rect.top), (2560 + 872, 40 + 400));
    }

    /// A launcher-like window that qualifies as covering ours.
    fn cover(hwnd: isize) -> ZWindow {
        ZWindow {
            hwnd,
            visible: true,
            minimized: false,
            tool_window: false,
            topmost: false,
            cloaked: false,
            owned: false,
            rect: Rect {
                left: 100,
                top: 100,
                right: 1200,
                bottom: 900,
            },
        }
    }

    #[test]
    fn covering_window_is_the_first_qualifying_window_above_ours() {
        let above = [cover(0x10), cover(0x20)];
        assert_eq!(covering_window(&above, ours()), Some(0x10));
        assert_eq!(covering_window(&[], ours()), None);
    }

    #[test]
    fn covering_window_skips_invisible_windows() {
        let hidden = ZWindow {
            visible: false,
            ..cover(0x10)
        };
        assert_eq!(covering_window(&[hidden, cover(0x20)], ours()), Some(0x20));
    }

    #[test]
    fn covering_window_skips_minimized_windows() {
        let iconic = ZWindow {
            minimized: true,
            ..cover(0x10)
        };
        assert_eq!(covering_window(&[iconic], ours()), None);
    }

    #[test]
    fn covering_window_skips_tool_windows() {
        let tool = ZWindow {
            tool_window: true,
            ..cover(0x10)
        };
        assert_eq!(covering_window(&[tool], ours()), None);
    }

    #[test]
    fn covering_window_skips_topmost_windows() {
        let topmost = ZWindow {
            topmost: true,
            ..cover(0x10)
        };
        assert_eq!(covering_window(&[topmost], ours()), None);
    }

    #[test]
    fn covering_window_skips_cloaked_windows() {
        let cloaked = ZWindow {
            cloaked: true,
            ..cover(0x10)
        };
        assert_eq!(covering_window(&[cloaked], ours()), None);
    }

    #[test]
    fn covering_window_skips_owned_windows() {
        let owned = ZWindow {
            owned: true,
            ..cover(0x10)
        };
        assert_eq!(covering_window(&[owned], ours()), None);
    }

    #[test]
    fn covering_window_skips_windows_on_another_monitor() {
        let secondary = ZWindow {
            rect: Rect {
                left: 2560,
                top: 0,
                right: 5120,
                bottom: 1440,
            },
            ..cover(0x10)
        };
        assert_eq!(covering_window(&[secondary], ours()), None);
    }

    #[test]
    fn covering_window_ignores_windows_that_only_touch_our_edge() {
        let touching = ZWindow {
            rect: Rect {
                left: -800,
                top: 0,
                right: 0,
                bottom: 600,
            },
            ..cover(0x10)
        };
        assert_eq!(covering_window(&[touching], ours()), None);
    }

    #[test]
    fn raises_z_only_for_covered_file_launches_that_are_foreground() {
        assert!(should_raise_z(
            true,
            true,
            true,
            Duration::from_millis(300),
            0
        ));
        assert!(!should_raise_z(
            false,
            true,
            true,
            Duration::from_millis(300),
            0
        ));
        assert!(!should_raise_z(
            true,
            false,
            true,
            Duration::from_millis(300),
            0
        ));
        assert!(!should_raise_z(
            true,
            true,
            false,
            Duration::from_millis(300),
            0
        ));
    }

    #[test]
    fn z_raise_is_bounded_in_time_and_count() {
        assert!(should_raise_z(true, true, true, Z_RAISE_WINDOW, 1));
        assert!(!should_raise_z(
            true,
            true,
            true,
            Z_RAISE_WINDOW + Duration::from_millis(1),
            0
        ));
        assert!(!should_raise_z(
            true,
            true,
            true,
            Duration::from_millis(300),
            Z_RAISE_MAX
        ));
    }

    #[test]
    fn to_workspace_subtracts_the_work_area_origin() {
        // Taskbar docked at the top: the work area starts 40px down.
        let rect = to_workspace(
            Rect {
                left: 782,
                top: 364,
                right: 1798,
                bottom: 903,
            },
            PhysicalPosition::new(0, 40),
        );
        assert_eq!(
            rect,
            Rect {
                left: 782,
                top: 324,
                right: 1798,
                bottom: 863
            }
        );
    }

    #[test]
    fn startup_title_prefixes_the_file_name_with_its_extension() {
        assert_eq!(
            startup_title("Spica Photo Viewer", Some(r"C:\photos\IMG_1439.JPG")),
            "IMG_1439.JPG - Spica Photo Viewer"
        );
        assert_eq!(
            startup_title("Spica Photo Viewer", Some("/photos/sunset.png")),
            "sunset.png - Spica Photo Viewer"
        );
    }

    #[test]
    fn startup_title_is_the_app_name_alone_without_a_file() {
        assert_eq!(
            startup_title("Spica Photo Viewer", None),
            "Spica Photo Viewer"
        );
    }
}
