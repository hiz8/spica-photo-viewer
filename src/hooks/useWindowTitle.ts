import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { useAppStore } from "../store";
import { getFilename } from "../utils/path";

const APP_NAME = "Spica Photo Viewer";

/** Picasa's format: `IMG_1439.JPG - Picasa フォト ビューア`, extension kept. */
export const windowTitleFor = (imagePath: string): string =>
  imagePath ? `${getFilename(imagePath)} - ${APP_NAME}` : APP_NAME;

export const useWindowTitle = () => {
  const imagePath = useAppStore((state) => state.currentImage.path);

  useEffect(() => {
    const title = windowTitleFor(imagePath);
    // Tauri does not mirror document.title onto the native title bar, so the
    // native call is what the user sees; document.title is set as well so
    // WebDriver (e2e) can observe the same string.
    document.title = title;
    getCurrentWindow()
      .setTitle(title)
      .catch((error: unknown) => {
        console.error("Failed to set window title:", error);
      });
  }, [imagePath]);
};
