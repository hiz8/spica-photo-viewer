import {
  BITMAP_WINDOW_SIZE,
  PREVIEW_WINDOW_MAX_RADIUS,
  PREVIEW_WINDOW_MIN_RADIUS,
  THUMBNAIL_ITEM_PITCH_PX,
} from "../constants/memory";

/**
 * Priority-ordered neighbor indices to keep decoded around `index`
 * (order = decode order). Forward: [i+1, i+2, i+3, i-1], then further
 * ahead, then further behind; backward is the mirror. 3 steps of lead at
 * the 250ms navigation floor gives ~750ms, enough for a ~400ms decode at
 * MAX_CONCURRENT_LOADS parallelism. See the design spec
 * (docs/superpowers/specs/2026-08-16-nav-rapid-bitmap-window-design.md).
 */
export const computeWindow = (
  index: number,
  direction: 1 | -1,
  length: number,
  size: number = BITMAP_WINDOW_SIZE,
): number[] => {
  const candidates: number[] = [
    index + direction,
    index + 2 * direction,
    index + 3 * direction,
    index - direction,
  ];
  for (let k = 4; k < length; k++) candidates.push(index + k * direction);
  for (let k = 2; k < length; k++) candidates.push(index - k * direction);

  const result: number[] = [];
  for (const i of candidates) {
    if (i >= 0 && i < length && i !== index && !result.includes(i)) {
      result.push(i);
    }
    if (result.length === size) break;
  }
  return result;
};

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
