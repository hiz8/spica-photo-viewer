use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

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
#[derive(Debug, PartialEq, Clone, Copy)]
pub(crate) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// Thickness of the restored window's frame on each side of the client area.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FrameInsets {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// Max inner size given to the window builder: well above any monitor so the
/// OS max tracking size never trims a zoomed-in image's window, yet with room
/// under the 16-bit width/height packing of WM_SIZE at 200% DPI. It must be a
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
    (PhysicalPosition::new(x, y), PhysicalSize::new(width, height))
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
/// differ from screen coordinates by the primary work area's origin (a
/// taskbar docked at the top or left shifts them).
pub(crate) fn to_workspace(rect: Rect, work_area_origin: PhysicalPosition<i32>) -> Rect {
    Rect {
        left: rect.left - work_area_origin.x,
        top: rect.top - work_area_origin.y,
        right: rect.right - work_area_origin.x,
        bottom: rect.bottom - work_area_origin.y,
    }
}

#[cfg(windows)]
mod native {
    use super::{FrameInsets, Rect};
    use std::ffi::c_void;
    use tauri::PhysicalPosition;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    use windows::Win32::UI::HiDpi::AdjustWindowRectExForDpi;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowPlacement, SetWindowPlacement, SystemParametersInfoW,
        GWL_EXSTYLE, GWL_STYLE, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        WINDOWPLACEMENT, WINDOW_EX_STYLE, WINDOW_STYLE, WS_MAXIMIZE,
    };

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
    // without its minimize/maximize animations.
    #[cfg(windows)]
    native::set_transitions_disabled(hwnd, false)?;
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
}
