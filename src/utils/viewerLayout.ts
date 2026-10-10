export const THUMBNAIL_BAR_HEIGHT = 80;
const FIT_MARGIN = 20;
// Floors for degenerate sizes (zero-size window or image) to avoid dividing by zero.
const MIN_DIMENSION = 1;

export interface LayoutArea {
  width: number;
  height: number;
  /** Kept clear on every side when fitting; centering ignores it. */
  margin: number;
}

/**
 * Area the image is centered in and fitted to. Maximized/fullscreen keeps the
 * image above the fixed thumbnail bar with a margin. Windowed (the viewer sized
 * the window to the image on an outside click) is the whole client area with
 * no margin: the window IS the image rect and the bar overlays its bottom, so
 * any other area would shift the image away from where it was on screen (W1).
 */
export const viewerLayoutArea = (
  innerWidth: number,
  innerHeight: number,
  windowed: boolean,
): LayoutArea =>
  windowed
    ? { width: innerWidth, height: innerHeight, margin: 0 }
    : {
        width: innerWidth,
        height: innerHeight - THUMBNAIL_BAR_HEIGHT,
        margin: FIT_MARGIN,
      };

/** Zoom percent that fits the image inside the area's margins; never upscales, floors at 10%. */
export const fitZoom = (
  area: LayoutArea,
  imageWidth: number,
  imageHeight: number,
): number => {
  const validImageWidth = Math.max(MIN_DIMENSION, imageWidth);
  const validImageHeight = Math.max(MIN_DIMENSION, imageHeight);
  const availableWidth = Math.max(
    MIN_DIMENSION,
    Math.max(MIN_DIMENSION, area.width) - area.margin * 2,
  );
  const availableHeight = Math.max(
    MIN_DIMENSION,
    Math.max(MIN_DIMENSION, area.height) - area.margin * 2,
  );
  const fitScale = Math.min(
    availableWidth / validImageWidth,
    availableHeight / validImageHeight,
  );
  return fitScale >= 1 ? 100 : Math.max(10, fitScale * 100);
};

/** Layout position of the natural-size box; the CSS transform scales it about its center. */
export const centeredPosition = (
  area: LayoutArea,
  imageWidth: number,
  imageHeight: number,
): { left: number; top: number } => ({
  left: (area.width - imageWidth) / 2,
  top: (area.height - imageHeight) / 2,
});
