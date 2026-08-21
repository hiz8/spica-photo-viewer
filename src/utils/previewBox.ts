import { PREVIEW_BOXES } from "../constants/memory";

/**
 * "WxH" of the smallest preview bucket that contains the screen in physical
 * pixels (CSS size × devicePixelRatio), oriented like the screen. fit-to-window
 * never exceeds the screen, so a preview fitted into this box is never upscaled.
 */
export const previewBoxForScreen = (
  width: number,
  height: number,
  dpr: number,
): string => {
  const scale = dpr > 0 ? dpr : 1;
  const w = Math.ceil(Math.max(0, width) * scale);
  const h = Math.ceil(Math.max(0, height) * scale);
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const [bl, bs] =
    PREVIEW_BOXES.find(([l, s]) => l >= long && s >= short) ??
    PREVIEW_BOXES[PREVIEW_BOXES.length - 1];
  return h > w ? `${bs}x${bl}` : `${bl}x${bs}`;
};

export const currentPreviewBox = (): string =>
  previewBoxForScreen(
    window.screen?.width ?? 0,
    window.screen?.height ?? 0,
    window.devicePixelRatio || 1,
  );
