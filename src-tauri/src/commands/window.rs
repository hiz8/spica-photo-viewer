use tauri::{AppHandle, Manager, PhysicalSize, PhysicalPosition};

#[tauri::command]
pub async fn get_window_position(app_handle: AppHandle) -> Result<WindowPosition, String> {
    let window = app_handle.get_webview_window("main")
        .ok_or("Failed to get main window")?;

    let position = window.outer_position()
        .map_err(|e| format!("Failed to get window position: {}", e))?;

    Ok(WindowPosition {
        x: position.x,
        y: position.y,
    })
}

#[tauri::command]
pub async fn get_window_state(app_handle: AppHandle) -> Result<WindowState, String> {
    let window = app_handle.get_webview_window("main")
        .ok_or("Failed to get main window")?;

    let is_maximized = window.is_maximized()
        .map_err(|e| format!("Failed to check if window is maximized: {}", e))?;

    let is_fullscreen = window.is_fullscreen()
        .map_err(|e| format!("Failed to check if window is fullscreen: {}", e))?;

    Ok(WindowState {
        is_maximized,
        is_fullscreen,
    })
}

#[tauri::command]
pub async fn resize_window_to_image(
    app_handle: AppHandle,
    image_width: u32,
    image_height: u32,
    zoom_percent: f64,
    image_screen_center_x: f64,
    image_screen_center_y: f64,
    disable_animation: Option<bool>,
) -> Result<(), String> {
    let window = app_handle.get_webview_window("main")
        .ok_or("Failed to get main window")?;

    // Check if window is maximized before resizing
    let is_maximized = window.is_maximized()
        .map_err(|e| format!("Failed to check if window is maximized: {}", e))?;

    if !is_maximized {
        return Err("Window is not maximized".to_string());
    }

    // Calculate the actual displayed image size based on zoom
    let zoom_factor = zoom_percent / 100.0;
    let displayed_width = (image_width as f64 * zoom_factor) as u32;
    let displayed_height = (image_height as f64 * zoom_factor) as u32;

    // Add some padding for UI elements (thumbnail bar, etc.)
    let padding_width = 40;
    let padding_height = 80; // Space for thumbnail bar

    let new_width = displayed_width + padding_width;
    let new_height = displayed_height + padding_height;

    // For smooth operation without animation, unmaximize and resize quickly
    if disable_animation.unwrap_or(true) {
        // Unmaximize first
        window.unmaximize()
            .map_err(|e| format!("Failed to unmaximize window: {}", e))?;

        // Set the new size immediately
        let new_size = PhysicalSize::new(new_width, new_height);
        window.set_size(new_size)
            .map_err(|e| format!("Failed to resize window: {}", e))?;

        // Position window around the image location
        let new_window_x = image_screen_center_x - (new_width as f64 / 2.0);
        let new_window_y = image_screen_center_y - (new_height as f64 / 2.0);

        // Get screen size for boundary checking
        let monitor = window.primary_monitor()
            .map_err(|e| format!("Failed to get primary monitor: {}", e))?
            .ok_or("No primary monitor found")?;
        let screen_size = monitor.size();

        // Apply boundary constraints
        let constrained_x = new_window_x.max(0.0).min((screen_size.width as f64 - new_width as f64).max(0.0));
        let constrained_y = new_window_y.max(0.0).min((screen_size.height as f64 - new_height as f64).max(0.0));

        let new_position = PhysicalPosition::new(constrained_x as i32, constrained_y as i32);
        window.set_position(new_position)
            .map_err(|e| format!("Failed to set window position: {}", e))?;
    } else {
        // Standard resize with system animations
        window.unmaximize()
            .map_err(|e| format!("Failed to unmaximize window: {}", e))?;

        let new_size = PhysicalSize::new(new_width, new_height);
        window.set_size(new_size)
            .map_err(|e| format!("Failed to resize window: {}", e))?;

        // Position window around the image location
        let new_window_x = image_screen_center_x - (new_width as f64 / 2.0);
        let new_window_y = image_screen_center_y - (new_height as f64 / 2.0);

        // Get screen size for boundary checking
        let monitor = window.primary_monitor()
            .map_err(|e| format!("Failed to get primary monitor: {}", e))?
            .ok_or("No primary monitor found")?;
        let screen_size = monitor.size();

        // Apply boundary constraints
        let constrained_x = new_window_x.max(0.0).min((screen_size.width as f64 - new_width as f64).max(0.0));
        let constrained_y = new_window_y.max(0.0).min((screen_size.height as f64 - new_height as f64).max(0.0));

        let new_position = PhysicalPosition::new(constrained_x as i32, constrained_y as i32);
        window.set_position(new_position)
            .map_err(|e| format!("Failed to set window position: {}", e))?;
    }

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