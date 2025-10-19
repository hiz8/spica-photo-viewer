/**
 * Timing constants for the application
 * All values are in milliseconds
 */

/**
 * Debounce delay for image loading in ImageViewer
 * Prevents loading intermediate images during rapid navigation
 */
export const IMAGE_LOAD_DEBOUNCE_MS = 200;

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
export const PRELOAD_RANGE = 20;

/**
 * Maximum number of concurrent image loads
 * Prevents overwhelming the backend with too many simultaneous requests
 */
export const MAX_CONCURRENT_LOADS = 3;
