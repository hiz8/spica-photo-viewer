/**
 * Spec: docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md
 *
 * Module-level cache of decoded bitmaps (hypothesis C), keyed by path and
 * tier. Keeps decoded pixels alive independent of the renderer's own
 * image-cache eviction, so a preload-hit navigation can paint without
 * re-decoding. Not part of the Zustand store: ImageBitmap objects are large
 * mutable resources, not immutable state. Eviction POLICY lives in
 * useImagePreloader (it knows index/direction/budget); this module only
 * does bookkeeping and deterministic release via close().
 *
 * Each path can hold up to two independently-retained bitmaps: a
 * display-resolution "preview" (§6.4) and the "full" resolution decode.
 * They coexist so a preview can keep painting while a full-resolution
 * upgrade decodes in the background. Callers that only care about "the best
 * bitmap available" (the pre-Phase-3 API) use `getBitmap`/`getRetained`,
 * which prefer full over preview.
 */
export type BitmapTier = "preview" | "full";

export interface RetainedBitmap {
  bitmap: ImageBitmap;
  tier: BitmapTier;
}

interface CacheEntry {
  preview?: ImageBitmap;
  full?: ImageBitmap;
}

const bitmaps = new Map<string, CacheEntry>();

export const setBitmap = (
  path: string,
  bitmap: ImageBitmap,
  tier: BitmapTier = "full",
): void => {
  const entry = bitmaps.get(path) ?? {};
  entry[tier]?.close();
  entry[tier] = bitmap;
  bitmaps.set(path, entry);
};

export const getBitmapOfTier = (
  path: string,
  tier: BitmapTier,
): ImageBitmap | undefined => bitmaps.get(path)?.[tier];

/** Full tier preferred, falling back to preview; same preference as getBitmap. */
export const getRetained = (path: string): RetainedBitmap | undefined => {
  const entry = bitmaps.get(path);
  if (!entry) return undefined;
  if (entry.full) return { bitmap: entry.full, tier: "full" };
  if (entry.preview) return { bitmap: entry.preview, tier: "preview" };
  return undefined;
};

/** Full tier preferred, falling back to preview. */
export const getBitmap = (path: string): ImageBitmap | undefined =>
  getRetained(path)?.bitmap;

export const bitmapTier = (path: string): BitmapTier | undefined =>
  getRetained(path)?.tier;

/**
 * Tier the viewer should report for `path` given its natural size: a retained
 * bitmap whose size equals the natural size IS full resolution even when the
 * scheduler filed it under the preview tier (unscaled preview); otherwise the
 * retained tier. Undefined when nothing is retained.
 */
export const effectiveTier = (
  path: string,
  naturalWidth: number,
  naturalHeight: number,
): BitmapTier | undefined => {
  const retained = getRetained(path);
  if (!retained) return undefined;
  if (
    retained.bitmap.width === naturalWidth &&
    retained.bitmap.height === naturalHeight
  )
    return "full";
  return retained.tier;
};

export const hasBitmap = (path: string, tier?: BitmapTier): boolean => {
  const entry = bitmaps.get(path);
  if (!entry) return false;
  if (tier) return entry[tier] !== undefined;
  return entry.preview !== undefined || entry.full !== undefined;
};

/** Omitting `tier` closes and removes both tiers for the path. */
export const deleteBitmap = (path: string, tier?: BitmapTier): void => {
  const entry = bitmaps.get(path);
  if (!entry) return;
  if (!tier) {
    entry.preview?.close();
    entry.full?.close();
    bitmaps.delete(path);
    return;
  }
  entry[tier]?.close();
  entry[tier] = undefined;
  if (entry.preview === undefined && entry.full === undefined) {
    bitmaps.delete(path);
  }
};

export const clearBitmaps = (): void => {
  for (const entry of bitmaps.values()) {
    entry.preview?.close();
    entry.full?.close();
  }
  bitmaps.clear();
};

/** Both tiers, summed across all retained paths, as width*height*4. */
export const bitmapBytes = (): number => {
  let total = 0;
  for (const entry of bitmaps.values()) {
    if (entry.preview) {
      total += entry.preview.width * entry.preview.height * 4;
    }
    if (entry.full) {
      total += entry.full.width * entry.full.height * 4;
    }
  }
  return total;
};

/** Paths holding a bitmap in either tier. */
export const bitmapPaths = (): string[] => [...bitmaps.keys()];

/** Paths holding a full-resolution bitmap (for current-image-excluded eviction). */
export const fullBitmapPaths = (): string[] =>
  [...bitmaps.entries()]
    .filter(([, entry]) => entry.full !== undefined)
    .map(([path]) => path);
