/**
 * URL builder for the custom `spica-img` protocol (Windows/WebView2 form).
 * The Rust handler validates the extension and existence before serving.
 */
export const IMAGE_PROTOCOL_ORIGIN = "http://spica-img.localhost";

export const imageSrc = (path: string): string =>
  `${IMAGE_PROTOCOL_ORIGIN}/${encodeURIComponent(path)}`;

/**
 * URL for a display-resolution preview fitted into `box` ("WxH"), served by
 * the Rust `/preview/<box>/<path>` route (Phase 2).
 */
export const previewSrc = (path: string, box: string): string =>
  `${IMAGE_PROTOCOL_ORIGIN}/preview/${box}/${encodeURIComponent(path)}`;

export const imageFormat = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "unknown";
  return name.slice(dot + 1).toLowerCase();
};
