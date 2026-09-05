/**
 * Values are milliseconds, except PRELOAD_RANGE, THUMBNAIL_GENERATION_INITIAL_RANGE
 * and THUMBNAIL_GENERATION_EXPANDED_RANGE (counts), MAX_CONCURRENT_LOADS
 * (a concurrency count), and PREVIEW_THUMBNAIL_SIZE and THUMBNAIL_SIZE (pixel sizes).
 */

/** Prevents loading intermediate images during rapid navigation. */
export const IMAGE_LOAD_DEBOUNCE_MS = 50;

/** Prevents excessive scroll operations during rapid navigation. */
export const THUMBNAIL_SCROLL_DEBOUNCE_MS = 100;

/** Prevents interfering with active navigation. */
export const PRELOAD_DELAY_MS = 500;

/** Navigation within this window is considered "rapid" and view state won't be saved. */
export const RAPID_NAVIGATION_THRESHOLD_MS = 500;

/** Total preloaded images = PRELOAD_RANGE * 2. */
export const PRELOAD_RANGE = 5;

/** Prevents overwhelming the backend with too many simultaneous requests. */
export const MAX_CONCURRENT_LOADS = 3;

/** Used to generate quick preview before loading full resolution. */
export const PREVIEW_THUMBNAIL_SIZE = 400;

/** Prevents starting thumbnail generation during rapid navigation. */
export const THUMBNAIL_GENERATION_DEBOUNCE_MS = 500;

/** Generates thumbnails for nearby images before expanding to full range. */
export const THUMBNAIL_GENERATION_INITIAL_RANGE = 10;

/**
 * After initial range, expands to this range before processing remaining images
 * This limits the immediate work for large folders (900+ images)
 */
export const THUMBNAIL_GENERATION_EXPANDED_RANGE = 30;

export const THUMBNAIL_SIZE = 20;

/**
 * Cached-thumbnail lookups per IPC call. Each hit used to be its own IPC
 * round trip and its own store update (= one thumbnail-bar render); a batch
 * turns a warm 2000-image folder into ~20 of each.
 */
export const THUMBNAIL_LOOKUP_BATCH = 100;

/** Prevents visual stuttering when user navigates quickly between images. */
export const SUPPRESS_TRANSITION_MS = 300;
