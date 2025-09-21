/**
 * Tauri Command Contracts for Spica Photo Viewer
 *
 * These interfaces define the IPC communication between the React frontend
 * and Rust backend through Tauri's command system.
 */

// =============================================================================
// Command Request/Response Types
// =============================================================================

export interface FolderScanRequest {
  folderPath: string;
  sortOrder?: 'name_asc' | 'name_desc' | 'date_asc' | 'date_desc';
}

export interface FolderScanResponse {
  success: boolean;
  data?: {
    folderPath: string;
    imageFiles: ImageFileInfo[];
    totalCount: number;
  };
  error?: string;
}

export interface ImageFileInfo {
  id: string;
  path: string;
  filename: string;
  extension: string;
  size: number;
  lastModified: string; // ISO date string
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'unknown';
}

export interface ImageLoadRequest {
  imagePath: string;
  maxWidth?: number;
  maxHeight?: number;
}

export interface ImageLoadResponse {
  success: boolean;
  data?: {
    base64Data: string;
    width: number;
    height: number;
    format: string;
  };
  error?: string;
}

export interface ThumbnailRequest {
  imagePath: string;
  size: number; // Always 30 for main thumbnails
  forceRegenerate?: boolean;
}

export interface ThumbnailResponse {
  success: boolean;
  data?: {
    base64Data: string;
    cachePath: string;
    generatedAt: string; // ISO date string
  };
  error?: string;
}

export interface CacheStatsResponse {
  success: boolean;
  data?: {
    totalSize: number; // bytes
    entryCount: number;
    oldestEntry: string; // ISO date string
    newestEntry: string; // ISO date string
  };
  error?: string;
}

export interface FileWatchEvent {
  eventType: 'created' | 'modified' | 'deleted' | 'renamed';
  filePath: string;
  newPath?: string; // For rename events
  timestamp: string; // ISO date string
}

// =============================================================================
// Tauri Command Interfaces
// =============================================================================

/**
 * Scan a folder for supported image files
 * Command: get_folder_images
 */
export interface GetFolderImagesCommand {
  request: FolderScanRequest;
  response: FolderScanResponse;
}

/**
 * Load a full-resolution image for display
 * Command: load_image
 */
export interface LoadImageCommand {
  request: ImageLoadRequest;
  response: ImageLoadResponse;
}

/**
 * Generate or retrieve cached thumbnail
 * Command: generate_thumbnail
 */
export interface GenerateThumbnailCommand {
  request: ThumbnailRequest;
  response: ThumbnailResponse;
}

/**
 * Get existing cached thumbnail (no generation)
 * Command: get_cached_thumbnail
 */
export interface GetCachedThumbnailCommand {
  request: { imagePath: string };
  response: ThumbnailResponse;
}

/**
 * Clear expired cache entries
 * Command: clear_old_cache
 */
export interface ClearOldCacheCommand {
  request: { maxAge?: number }; // hours, default 24
  response: { success: boolean; deletedCount: number; error?: string };
}

/**
 * Get cache statistics
 * Command: get_cache_stats
 */
export interface GetCacheStatsCommand {
  request: {};
  response: CacheStatsResponse;
}

/**
 * Get initial file path (for file association launches)
 * Command: get_initial_file
 */
export interface GetInitialFileCommand {
  request: {};
  response: { filePath?: string };
}

/**
 * Show native about dialog
 * Command: show_about_dialog
 */
export interface ShowAboutDialogCommand {
  request: {};
  response: { success: boolean; error?: string };
}

/**
 * Start watching folder for file changes
 * Command: start_file_watcher
 */
export interface StartFileWatcherCommand {
  request: { folderPath: string };
  response: { success: boolean; error?: string };
}

/**
 * Stop file watcher
 * Command: stop_file_watcher
 */
export interface StopFileWatcherCommand {
  request: {};
  response: { success: boolean; error?: string };
}

// =============================================================================
// Error Types
// =============================================================================

export interface TauriError {
  code: string;
  message: string;
  details?: any;
}

export const ErrorCodes = {
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  INVALID_FORMAT: 'INVALID_FORMAT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CACHE_ERROR: 'CACHE_ERROR',
  DECODE_ERROR: 'DECODE_ERROR',
  IO_ERROR: 'IO_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

// =============================================================================
// Event Types (Tauri Events)
// =============================================================================

export interface TauriEvents {
  'file-changed': FileWatchEvent;
  'thumbnail-generated': { imagePath: string; success: boolean };
  'cache-cleaned': { deletedCount: number };
}

// =============================================================================
// Type Guards and Validation
// =============================================================================

export function isValidImageFormat(format: string): format is ImageFileInfo['format'] {
  return ['jpeg', 'png', 'webp', 'gif', 'unknown'].includes(format);
}

export function isValidSortOrder(order: string): order is FolderScanRequest['sortOrder'] {
  return ['name_asc', 'name_desc', 'date_asc', 'date_desc'].includes(order);
}

export function validateImagePath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;

  const supportedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  const extension = path.toLowerCase().substring(path.lastIndexOf('.'));

  return supportedExtensions.includes(extension);
}

export function validateThumbnailSize(size: number): boolean {
  return size === 30; // Current requirement - only 30x30 thumbnails
}

// =============================================================================
// Command Helpers
// =============================================================================

export interface TauriCommandWrapper {
  <T extends keyof CommandMap>(
    command: T,
    args: CommandMap[T]['request']
  ): Promise<CommandMap[T]['response']>;
}

export interface CommandMap {
  get_folder_images: GetFolderImagesCommand;
  load_image: LoadImageCommand;
  generate_thumbnail: GenerateThumbnailCommand;
  get_cached_thumbnail: GetCachedThumbnailCommand;
  clear_old_cache: ClearOldCacheCommand;
  get_cache_stats: GetCacheStatsCommand;
  get_initial_file: GetInitialFileCommand;
  show_about_dialog: ShowAboutDialogCommand;
  start_file_watcher: StartFileWatcherCommand;
  stop_file_watcher: StopFileWatcherCommand;
}

/**
 * Type-safe wrapper for Tauri invoke calls
 * Usage: const result = await invokeCommand('load_image', { imagePath: '/path/to/image.jpg' });
 */
declare const invokeCommand: TauriCommandWrapper;