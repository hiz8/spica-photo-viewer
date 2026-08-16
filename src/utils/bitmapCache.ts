/**
 * Module-level cache of decoded full-resolution bitmaps (hypothesis C).
 * Keeps decoded pixels alive independent of the renderer's own image-cache
 * eviction, so a preload-hit navigation can paint without re-decoding.
 * Not part of the Zustand store: ImageBitmap objects are large mutable
 * resources, not immutable state. Eviction POLICY lives in
 * useImagePreloader (it knows index/direction/budget); this module only
 * does bookkeeping and deterministic release via close().
 */
const bitmaps = new Map<string, ImageBitmap>();

export const setBitmap = (path: string, bitmap: ImageBitmap): void => {
  bitmaps.get(path)?.close();
  bitmaps.set(path, bitmap);
};

export const getBitmap = (path: string): ImageBitmap | undefined =>
  bitmaps.get(path);

export const hasBitmap = (path: string): boolean => bitmaps.has(path);

export const deleteBitmap = (path: string): void => {
  bitmaps.get(path)?.close();
  bitmaps.delete(path);
};

export const clearBitmaps = (): void => {
  for (const bitmap of bitmaps.values()) {
    bitmap.close();
  }
  bitmaps.clear();
};

export const bitmapBytes = (): number => {
  let total = 0;
  for (const bitmap of bitmaps.values()) {
    total += bitmap.width * bitmap.height * 4;
  }
  return total;
};

export const bitmapPaths = (): string[] => [...bitmaps.keys()];
