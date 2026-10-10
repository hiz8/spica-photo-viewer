/**
 * Sizes the canvas to the bitmap and paints it in one place, so component
 * tests can mock this module (jsdom has no 2D context). After drawImage the
 * canvas owns its own backing pixels — evicting/closing the source bitmap
 * afterwards is safe.
 */
export const drawBitmapToCanvas = (
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
): void => {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.drawImage(bitmap, 0, 0);
  }
};
