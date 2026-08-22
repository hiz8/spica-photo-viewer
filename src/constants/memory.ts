/**
 * Memory constants for the decoded-bitmap cache.
 * A 20MP RGBA bitmap is ~80MB and a screen-box preview ~8MB; the retained
 * set (the current image's full decode plus a preview for every visible
 * thumbnail) must stay inside the budget.
 */
export const BITMAP_CACHE_BUDGET_BYTES = 500 * 1024 * 1024;

/**
 * Screen-box buckets for display-resolution previews (design spec D2).
 * Mirrors ALLOWED_PREVIEW_BOXES in src-tauri/src/utils/preview.rs.
 */
export const PREVIEW_BOXES: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
];

/**
 * Width in px of one `.thumbnail-item` including its horizontal margins
 * (30px item + 5px margin × 2). Mirrors App.css and bench-helpers; used to
 * derive how many thumbnails are actually visible in the bar from the
 * window width alone.
 */
export const THUMBNAIL_ITEM_PITCH_PX = 40;

/** Floor on the visible-range preload radius, even for very narrow windows. */
export const PREVIEW_WINDOW_MIN_RADIUS = 4;

/**
 * Ceiling on the visible-range preload radius before the byte-budget guard
 * takes over (a 3840px-wide window needs radius 47).
 */
export const PREVIEW_WINDOW_MAX_RADIUS = 48;

/** Debounce before scheduling a full-resolution upgrade after zoom settles. */
export const FULL_UPGRADE_DEBOUNCE_MS = 150;
