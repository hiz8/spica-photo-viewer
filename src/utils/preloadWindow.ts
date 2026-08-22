import {
  PREVIEW_WINDOW_MAX_RADIUS,
  PREVIEW_WINDOW_MIN_RADIUS,
  THUMBNAIL_ITEM_PITCH_PX,
} from "../constants/memory";

/**
 * How many thumbnails are actually visible on each side of the current one,
 * derived from the thumbnail bar's own pitch geometry rather than a fixed
 * window size (design spec 2026-08-21 §7.2 — the visible-range window
 * scales with how much of the strip the user can actually see). Clamped so
 * a very narrow window still preloads at least the legacy window's worth,
 * and a very wide window doesn't outrun the byte-budget guard.
 */
export const visibleThumbnailRadius = (innerWidth: number): number => {
  const raw = Math.floor(
    (innerWidth - THUMBNAIL_ITEM_PITCH_PX) / (THUMBNAIL_ITEM_PITCH_PX * 2),
  );
  return Math.min(
    PREVIEW_WINDOW_MAX_RADIUS,
    Math.max(PREVIEW_WINDOW_MIN_RADIUS, raw),
  );
};

/**
 * Indices to keep loaded around `index`, in decode order: interleaved by
 * distance, the navigation direction first at each step — [+1, −1, +2, −2,
 * …] going forward, mirrored going backward. Out-of-range indices are
 * dropped; `index` itself is never included.
 *
 * The order is also the eviction order reversed, so it decides what
 * survives when the byte budget bites. All-forward-then-all-backward would
 * fill the whole forward radius before the first neighbor behind and evict
 * every backward path first, leaving the thumbnails behind the current one
 * showing placeholders — interleaving keeps the retained set centered on
 * the current image, which is what the visible strip actually shows.
 */
export const computeVisibleWindow = (
  index: number,
  direction: 1 | -1,
  length: number,
  radius: number,
): number[] => {
  const result: number[] = [];
  for (let k = 1; k <= radius; k++) {
    const ahead = index + k * direction;
    if (ahead >= 0 && ahead < length) result.push(ahead);
    const behind = index - k * direction;
    if (behind >= 0 && behind < length) result.push(behind);
  }
  return result;
};
