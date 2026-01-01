/**
 * Timing constants for the application
 * All values are in milliseconds
 */

/**
 * Debounce delay for image loading in ImageViewer
 * Prevents loading intermediate images during rapid navigation
 */
export const IMAGE_LOAD_DEBOUNCE_MS = 50;

/**
 * Debounce delay for thumbnail scrolling in ThumbnailBar
 * Prevents excessive scroll operations during rapid navigation
 */
export const THUMBNAIL_SCROLL_DEBOUNCE_MS = 100;

/**
 * Delay before starting image preloading
 * Prevents interfering with active navigation
 */
export const PRELOAD_DELAY_MS = 500;

/**
 * Threshold for detecting rapid navigation
 * Navigation within this window is considered "rapid" and view state won't be saved
 */
export const RAPID_NAVIGATION_THRESHOLD_MS = 500;

/**
 * Number of images to preload in each direction (±N)
 * Total preloaded images = PRELOAD_RANGE * 2
 */
export const PRELOAD_RANGE = 5;

/**
 * Maximum number of concurrent image loads
 * Prevents overwhelming the backend with too many simultaneous requests
 */
export const MAX_CONCURRENT_LOADS = 3;

/**
 * Size (in pixels) for preview thumbnails in two-phase loading
 * Used to generate quick preview before loading full resolution
 */
export const PREVIEW_THUMBNAIL_SIZE = 400;

/**
 * Debounce delay for thumbnail generation
 * Prevents starting thumbnail generation during rapid navigation
 */
export const THUMBNAIL_GENERATION_DEBOUNCE_MS = 500;

/**
 * Initial range for thumbnail generation (±N images)
 * Generates thumbnails for nearby images before expanding to full range
 */
export const THUMBNAIL_GENERATION_INITIAL_RANGE = 10;

/**
 * Size (in pixels) for thumbnail generation and caching
 * Used by the thumbnail generator for creating preview thumbnails
 */
export const THUMBNAIL_SIZE = 20;

/**
 * Duration to suppress CSS transitions during rapid navigation
 * Prevents visual stuttering when user navigates quickly between images
 */
export const SUPPRESS_TRANSITION_MS = 300;
