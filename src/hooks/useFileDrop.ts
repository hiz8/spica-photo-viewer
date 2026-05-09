import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { ImageInfo } from "../types";
import { getFolderPath } from "../utils/path";

const ERROR_TOAST_DURATION_MS = 3000;

export const useFileDrop = () => {
  const { setCurrentImage, setFolderImages, setError, setLoading } =
    useAppStore();

  useEffect(() => {
    let unlistenFileDrop: (() => void) | null = null;

    const setupListeners = async () => {
      try {
        unlistenFileDrop = await listen("tauri://file-drop", async (event) => {
          try {
            setLoading(true);
            setError(null);

            const paths = event.payload as string[];
            if (!paths || paths.length === 0) {
              return;
            }

            const filePath = paths[0];

            const isValid = await invoke<boolean>("validate_image_file", {
              path: filePath,
            });

            if (!isValid) {
              setError(
                new Error("Please drop an image file (JPG, PNG, WebP, GIF)"),
              );
              setTimeout(() => setError(null), ERROR_TOAST_DURATION_MS);
              return;
            }

            const folderPath = getFolderPath(filePath);

            const folderImages = await invoke<ImageInfo[]>(
              "get_folder_images",
              { path: folderPath },
            );

            setFolderImages(folderPath, folderImages);

            const imageIndex = folderImages.findIndex(
              (img) => img.path === filePath,
            );
            if (imageIndex !== -1) {
              setCurrentImage(filePath, imageIndex);
            }
          } catch (error) {
            console.error("Failed to handle dropped file:", error);
            setError(new Error("Failed to load dropped image"));
            setTimeout(() => setError(null), ERROR_TOAST_DURATION_MS);
          } finally {
            setLoading(false);
          }
        });
      } catch (error) {
        console.error("Failed to setup file drop listeners:", error);
      }
    };

    setupListeners();

    return () => {
      if (unlistenFileDrop) unlistenFileDrop();
    };
  }, [setCurrentImage, setFolderImages, setError, setLoading]);
};
