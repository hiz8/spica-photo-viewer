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
 * Indices to keep loaded around `index`, in decode order: the full radius
 * in the navigation direction first (what the user is heading toward),
 * then the full radius behind (in case they reverse). Out-of-range indices
 * are dropped; `index` itself is never included.
 */
export const computeVisibleWindow = (
  index: number,
  direction: 1 | -1,
  length: number,
  radius: number,
): number[] => {
  const result: number[] = [];
  for (let k = 1; k <= radius; k++) {
    const i = index + k * direction;
    if (i >= 0 && i < length) result.push(i);
  }
  for (let k = 1; k <= radius; k++) {
    const i = index - k * direction;
    if (i >= 0 && i < length) result.push(i);
  }
  return result;
};
