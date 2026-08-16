import type { ImageData } from "../types";

/** Shape returned by the Rust `load_image` command (transitional; removed with it). */
export interface RawImageData {
  path: string;
  base64: string;
  width: number;
  height: number;
  format: string;
}

export const rawToImageData = (raw: RawImageData): ImageData => ({
  path: raw.path,
  src: `data:${raw.format};base64,${raw.base64}`,
  width: raw.width,
  height: raw.height,
  format: raw.format,
});
