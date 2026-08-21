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
import { imageFormat, imageSrc, previewSrc } from "./imageSrc";

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
      tier: "full",
    },
    bitmap,
  };
};

/**
 * Loads a display-resolution preview from the Phase 2 `/preview/<box>/`
 * route and decodes it off the main thread (same non-`src:set` contract as
 * loadBitmapViaProtocol). The natural (orientation-applied, full-resolution)
 * size comes back in the X-Spica-Natural-Width/Height response headers; a
 * missing or non-positive header falls back to the decoded bitmap's own
 * dimensions. When the decoded bitmap already equals the natural size (the
 * source didn't need downscaling to fit the box, so the server served it
 * unscaled) the result is tagged "full" rather than "preview" so callers
 * don't schedule a redundant full-resolution upgrade.
 */
export const loadPreviewBitmap = async (
  path: string,
  box: string,
  signal?: AbortSignal,
): Promise<{ data: ImageData; bitmap: ImageBitmap }> => {
  const src = previewSrc(path, box);
  const response = await fetch(src, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch preview: ${path} (${response.status})`);
  }
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const headerWidth = Number(response.headers.get("X-Spica-Natural-Width"));
  const headerHeight = Number(response.headers.get("X-Spica-Natural-Height"));
  const width =
    Number.isFinite(headerWidth) && headerWidth > 0
      ? headerWidth
      : bitmap.width;
  const height =
    Number.isFinite(headerHeight) && headerHeight > 0
      ? headerHeight
      : bitmap.height;

  return {
    data: {
      path,
      src,
      width,
      height,
      format: imageFormat(path),
      tier:
        bitmap.width === width && bitmap.height === height ? "full" : "preview",
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
    .then((bitmap) => setBitmap(path, bitmap, "full"))
    .catch(() => {
      /* retention is opportunistic; the scheduler can redo it */
    });
};
