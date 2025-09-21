/**
 * Rust Command Implementation Contracts for Spica Photo Viewer
 *
 * These are the Rust function signatures and data structures that implement
 * the Tauri commands defined in tauri-commands.ts
 */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;
use tokio::sync::Mutex;

// =============================================================================
// Data Structures
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageFileInfo {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub extension: String,
    pub size: u64,
    pub last_modified: String, // ISO date string
    pub format: ImageFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Jpeg,
    Png,
    Webp,
    Gif,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderScanRequest {
    pub folder_path: String,
    pub sort_order: Option<SortOrder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortOrder {
    NameAsc,
    NameDesc,
    DateAsc,
    DateDesc,
}

#[derive(Debug, Serialize)]
pub struct FolderScanResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<FolderScanData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FolderScanData {
    pub folder_path: String,
    pub image_files: Vec<ImageFileInfo>,
    pub total_count: usize,
}

#[derive(Debug, Deserialize)]
pub struct ImageLoadRequest {
    pub image_path: String,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct ImageLoadResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<ImageLoadData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ImageLoadData {
    pub base64_data: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
}

#[derive(Debug, Deserialize)]
pub struct ThumbnailRequest {
    pub image_path: String,
    pub size: u32,
    pub force_regenerate: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ThumbnailResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<ThumbnailData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ThumbnailData {
    pub base64_data: String,
    pub cache_path: String,
    pub generated_at: String,
}

#[derive(Debug, Serialize)]
pub struct CacheStatsData {
    pub total_size: u64,
    pub entry_count: usize,
    pub oldest_entry: String,
    pub newest_entry: String,
}

#[derive(Debug, Serialize)]
pub struct FileWatchEvent {
    pub event_type: String,
    pub file_path: String,
    pub new_path: Option<String>,
    pub timestamp: String,
}

// =============================================================================
// Application State
// =============================================================================

#[derive(Debug)]
pub struct AppState {
    pub cache_dir: PathBuf,
    pub thumbnail_cache: Mutex<HashMap<String, ThumbnailCacheEntry>>,
    pub file_watcher: Mutex<Option<FileWatcher>>,
}

#[derive(Debug, Clone)]
pub struct ThumbnailCacheEntry {
    pub path: PathBuf,
    pub generated_at: chrono::DateTime<chrono::Utc>,
    pub file_hash: String,
    pub size: u32,
}

#[derive(Debug)]
pub struct FileWatcher {
    pub watcher: notify::RecommendedWatcher,
    pub watched_path: PathBuf,
}

// =============================================================================
// Error Types
// =============================================================================

#[derive(Debug, thiserror::Error)]
pub enum SpicaError {
    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Invalid image format: {0}")]
    InvalidFormat(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Cache error: {0}")]
    CacheError(String),

    #[error("Decode error: {0}")]
    DecodeError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Image processing error: {0}")]
    ImageError(#[from] image::ImageError),

    #[error("Unknown error: {0}")]
    Unknown(String),
}

impl From<SpicaError> for String {
    fn from(error: SpicaError) -> Self {
        error.to_string()
    }
}

// =============================================================================
// Command Implementations
// =============================================================================

/// Scan a folder for supported image files
#[tauri::command]
pub async fn get_folder_images(
    request: FolderScanRequest,
    state: State<'_, AppState>,
) -> Result<FolderScanResponse, String> {
    // Implementation will:
    // 1. Validate folder path exists and is readable
    // 2. Scan directory for supported image files (jpg, jpeg, png, webp, gif)
    // 3. Extract file metadata (size, modification date)
    // 4. Detect image format from file headers
    // 5. Sort according to requested order
    // 6. Return structured response
    todo!("Implementation in Phase 3")
}

/// Load a full-resolution image for display
#[tauri::command]
pub async fn load_image(
    request: ImageLoadRequest,
    state: State<'_, AppState>,
) -> Result<ImageLoadResponse, String> {
    // Implementation will:
    // 1. Validate image path and format
    // 2. Load and decode image using image-rs
    // 3. Resize if max dimensions specified
    // 4. Convert to base64 for frontend transmission
    // 5. Return image data with metadata
    todo!("Implementation in Phase 3")
}

/// Generate or retrieve cached thumbnail
#[tauri::command]
pub async fn generate_thumbnail(
    request: ThumbnailRequest,
    state: State<'_, AppState>,
) -> Result<ThumbnailResponse, String> {
    // Implementation will:
    // 1. Check if valid cached thumbnail exists
    // 2. If not cached or force_regenerate: generate new thumbnail
    // 3. Resize image to requested size (30x30)
    // 4. Save as WebP in cache directory
    // 5. Update cache index
    // 6. Return thumbnail data
    todo!("Implementation in Phase 3")
}

/// Get existing cached thumbnail without generation
#[tauri::command]
pub async fn get_cached_thumbnail(
    image_path: String,
    state: State<'_, AppState>,
) -> Result<ThumbnailResponse, String> {
    // Implementation will:
    // 1. Check cache index for existing thumbnail
    // 2. Validate cache file exists and is not expired
    // 3. Load cached thumbnail data
    // 4. Return base64 data or not-found error
    todo!("Implementation in Phase 3")
}

/// Clear expired cache entries
#[tauri::command]
pub async fn clear_old_cache(
    max_age: Option<u64>, // hours
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Implementation will:
    // 1. Scan cache directory for expired files
    // 2. Delete files older than max_age (default 24 hours)
    // 3. Update cache index
    // 4. Return count of deleted entries
    todo!("Implementation in Phase 3")
}

/// Get cache statistics
#[tauri::command]
pub async fn get_cache_stats(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Implementation will:
    // 1. Scan cache directory
    // 2. Calculate total size and entry count
    // 3. Find oldest and newest entries
    // 4. Return statistics object
    todo!("Implementation in Phase 3")
}

/// Get initial file path for file association launches
#[tauri::command]
pub fn get_initial_file() -> Option<String> {
    // Implementation will:
    // 1. Check command line arguments
    // 2. Extract file path if launched via file association
    // 3. Validate path exists and is supported format
    // 4. Return path or None
    todo!("Implementation in Phase 4")
}

/// Show native about dialog
#[tauri::command]
pub async fn show_about_dialog() -> Result<serde_json::Value, String> {
    // Implementation will:
    // 1. Create native Windows about dialog
    // 2. Show application version, author, copyright
    // 3. Handle dialog display and closure
    // 4. Return success status
    todo!("Implementation in Phase 4")
}

/// Start watching folder for file changes
#[tauri::command]
pub async fn start_file_watcher(
    folder_path: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    // Implementation will:
    // 1. Create file system watcher using notify crate
    // 2. Watch specified folder for changes
    // 3. Filter events for supported image formats
    // 4. Emit Tauri events for file changes
    // 5. Store watcher in application state
    todo!("Implementation in Phase 3")
}

/// Stop file watcher
#[tauri::command]
pub async fn stop_file_watcher(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Implementation will:
    // 1. Stop existing file watcher if running
    // 2. Clean up watcher resources
    // 3. Remove from application state
    // 4. Return success status
    todo!("Implementation in Phase 3")
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Detect image format from file extension and headers
pub fn detect_image_format(path: &PathBuf) -> ImageFormat {
    todo!("Implementation in Phase 1")
}

/// Generate file hash for cache validation
pub fn generate_file_hash(path: &PathBuf) -> Result<String, SpicaError> {
    todo!("Implementation in Phase 1")
}

/// Validate image file and extract metadata
pub fn validate_image_file(path: &PathBuf) -> Result<ImageFileInfo, SpicaError> {
    todo!("Implementation in Phase 1")
}

/// Create cache directory if it doesn't exist
pub fn ensure_cache_directory(cache_dir: &PathBuf) -> Result<(), SpicaError> {
    todo!("Implementation in Phase 1")
}

/// Convert image to base64 for frontend transmission
pub fn image_to_base64(
    image: &image::DynamicImage,
    format: image::ImageFormat,
) -> Result<String, SpicaError> {
    todo!("Implementation in Phase 1")
}

// =============================================================================
// Constants
// =============================================================================

pub const SUPPORTED_EXTENSIONS: &[&str] = &[".jpg", ".jpeg", ".png", ".webp", ".gif"];
pub const THUMBNAIL_SIZE: u32 = 30;
pub const CACHE_EXPIRY_HOURS: u64 = 24;
pub const MAX_CACHE_SIZE_MB: u64 = 1024; // 1GB cache limit
pub const MAX_PRELOAD_COUNT: usize = 40;
pub const WEBP_QUALITY: f32 = 80.0;