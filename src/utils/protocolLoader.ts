/**
 * Loads an image through the spica-img protocol with an off-DOM Image and
 * resolves after decode, so callers get dimensions (browser-derived, EXIF
 * orientation applied) and a warm decode cache before touching the DOM.
 * Network behavior is exercised by E2E (jsdom never loads resources);
 * unit tests mock this module at the import boundary.
 */
import type { ImageData } from "../types";
import { imageFormat, imageSrc } from "./imageSrc";
import { perfMark } from "./perf";

export const loadImageViaProtocol = async (
  path: string,
): Promise<{ data: ImageData; element: HTMLImageElement }> => {
  const src = imageSrc(path);
  perfMark("src:set", { path });
  const element = new Image();
  element.src = src;
  if (typeof element.decode === "function") {
    await element.decode();
  } else {
    await new Promise<void>((resolve, reject) => {
      element.onload = () => resolve();
      element.onerror = () =>
        reject(new Error(`Failed to load image: ${path}`));
    });
  }
  return {
    data: {
      path,
      src,
      width: element.naturalWidth,
      height: element.naturalHeight,
      format: imageFormat(path),
    },
    element,
  };
};
