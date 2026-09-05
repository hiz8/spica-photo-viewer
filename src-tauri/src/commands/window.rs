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

/// Well above any monitor so the OS max tracking size never trims a
/// zoomed-in image's window, yet inside the 16-bit coordinate range some
/// GDI paths still use (docs/code-rationale.md#W1).
const MAX_TRACK_PX: u32 = 32_000;

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

    window
        .unmaximize()
        .map_err(|e| format!("Failed to unmaximize window: {}", e))?;
    window
        .set_max_size(Some(PhysicalSize::new(MAX_TRACK_PX, MAX_TRACK_PX)))
        .map_err(|e| format!("Failed to lift window max size: {}", e))?;
    window
        .set_size(size)
        .map_err(|e| format!("Failed to resize window: {}", e))?;

    // The maximized frame offset differs from the restored one (Windows pushes
    // a maximized window's borders off screen), so measure after restoring.
    let outer = window
        .outer_position()
        .map_err(|e| format!("Failed to get window position: {}", e))?;
    let inner = window
        .inner_position()
        .map_err(|e| format!("Failed to get window inner position: {}", e))?;
    window
        .set_position(outer_position_for(target_inner, outer, inner))
        .map_err(|e| format!("Failed to set window position: {}", e))?;

    Ok(())
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
}
