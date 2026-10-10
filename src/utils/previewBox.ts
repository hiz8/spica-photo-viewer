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
  const w = Math.ceil(
    (Number.isFinite(width) ? Math.max(0, width) : 0) * scale,
  );
  const h = Math.ceil(
    (Number.isFinite(height) ? Math.max(0, height) : 0) * scale,
  );
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const [bl, bs] =
    PREVIEW_BOXES.find(([l, s]) => l >= long && s >= short) ??
    PREVIEW_BOXES[PREVIEW_BOXES.length - 1];
  return h > w ? `${bs}x${bl}` : `${bl}x${bs}`;
};

let sessionPreviewBox: string | null = null;

/** Box chosen once per session (first call), so one folder never straddles two boxes. */
export const currentPreviewBox = (): string => {
  if (sessionPreviewBox === null) {
    sessionPreviewBox = previewBoxForScreen(
      window.screen?.width ?? 0,
      window.screen?.height ?? 0,
      window.devicePixelRatio || 1,
    );
  }
  return sessionPreviewBox;
};

export const _resetPreviewBoxForTests = (): void => {
  sessionPreviewBox = null;
};
