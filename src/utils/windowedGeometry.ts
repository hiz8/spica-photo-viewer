/**
 * Picasa's windowed-mode minimum: below this the window keeps the image's
 * aspect ratio instead of shrinking with it (docs/code-rationale.md#W1).
 */
export const MIN_WINDOWED_WIDTH = 544;

export interface WindowedGeometryInput {
  /** Natural size = the display element's layout box (view.imageWidth/Height). */
  imageWidth: number;
  imageHeight: number;
  /** Percent of natural size. */
  zoom: number;
  imageLeft: number;
  imageTop: number;
  panX: number;
  panY: number;
}

/** CSS px in the current (maximized) window's viewport coordinates. */
export interface ClientBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Client area the window shrinks to on an outside click: the displayed image
 * rect, or the 544px-wide box of the same aspect ratio centered on it. Derived
 * from store state rather than the DOM so it is independent of which display
 * element is mounted and of an in-flight zoom transition.
 */
export const windowedClientBox = (input: WindowedGeometryInput): ClientBox => {
  const { imageWidth, imageHeight, zoom, imageLeft, imageTop, panX, panY } =
    input;
  const scale = zoom / 100;
  const displayedWidth = imageWidth * scale;

  const width = Math.max(MIN_WINDOWED_WIDTH, displayedWidth);
  const height =
    displayedWidth >= MIN_WINDOWED_WIDTH
      ? imageHeight * scale
      : (MIN_WINDOWED_WIDTH * imageHeight) / imageWidth;

  // transform-origin is the layout box's center and pan is applied after the
  // scale (Z1), so the on-screen center is the layout center plus pan.
  const centerX = imageLeft + imageWidth / 2 + panX;
  const centerY = imageTop + imageHeight / 2 + panY;

  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height,
  };
};
