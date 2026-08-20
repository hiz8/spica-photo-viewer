/**
 * Loads an image over the spica-img protocol and decodes it to an
 * ImageBitmap off the main thread. Deliberately does NOT go through an
 * HTMLImageElement and emits no `src:set` perf mark: the scheduler's loads
 * must not depend on the renderer image cache nor pollute the fetch_decode
 * bench pairing (src:set -> decode:done belongs to the viewer path).
 * EXIF orientation follows createImageBitmap's default ("from-image"),
 * matching <img>; width/height are post-orientation.
 */
import type { ImageData } from "../types";
import { setBitmap } from "./bitmapCache";
import { imageFormat, imageSrc } from "./imageSrc";

export const loadBitmapViaProtocol = async (
  path: string,
  signal?: AbortSignal,
): Promise<{ data: ImageData; bitmap: ImageBitmap }> => {
  const src = imageSrc(path);
  const response = await fetch(src, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${path} (${response.status})`);
  }
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  return {
    data: {
      path,
      src,
      width: bitmap.width,
      height: bitmap.height,
      format: imageFormat(path),
    },
    bitmap,
  };
};

/**
 * Best-effort: enter a viewer-loaded, already-decoded element into the
 * bitmap cache so a revisit paints without re-decoding (fixes the
 * "ImageViewer loads are never retained" asymmetry). Fire-and-forget and
 * off the main thread; the scheduler evicts it when it leaves the window.
 */
export const retainElementAsBitmap = (
  path: string,
  element: HTMLImageElement,
): void => {
  if (typeof createImageBitmap !== "function") return;
  void createImageBitmap(element)
    .then((bitmap) => setBitmap(path, bitmap))
    .catch(() => {
      /* retention is opportunistic; the scheduler can redo it */
    });
};
