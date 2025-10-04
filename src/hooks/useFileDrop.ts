import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { ImageInfo } from "../types";

export const useFileDrop = () => {
  const { setCurrentImage, setFolderImages, setError, setLoading } =
    useAppStore();

  useEffect(() => {
    console.log("Setting up file drop listeners...");

    let unlistenFileDrop: (() => void) | null = null;
    let unlistenFileDropHover: (() => void) | null = null;
    let unlistenFileDropCancelled: (() => void) | null = null;

    const setupListeners = async () => {
      try {
        // Listen for file drop events - try multiple event names
        unlistenFileDrop = await listen("tauri://file-drop", async (event) => {
          console.log("File drop detected (tauri://file-drop):", event.payload);
          try {
            setLoading(true);
            setError(null);

            // event.payload contains array of file paths
            const paths = event.payload as string[];

            if (!paths || paths.length === 0) {
              console.log("No files dropped");
              return;
            }

            // Get the first dropped file
            const filePath = paths[0];
            console.log("Dropped file path:", filePath);

            // Validate that it's an image file
            const isValid = await invoke<boolean>("validate_image_file", {
              path: filePath,
            });

            console.log("File validation result:", isValid);

            if (!isValid) {
              setError(
                new Error("Please drop an image file (JPG, PNG, WebP, GIF)"),
              );
              setTimeout(() => setError(null), 3000);
              return;
            }

            // Get folder images - handle both Windows and Unix path separators
            const separator = filePath.includes("\\") ? "\\" : "/";
            const folderPath = filePath.substring(
              0,
              filePath.lastIndexOf(separator),
            );
            console.log("Folder path:", folderPath);

            const folderImages = await invoke<ImageInfo[]>(
              "get_folder_images",
              {
                path: folderPath,
              },
            );

            console.log("Found images:", folderImages.length);

            setFolderImages(folderPath, folderImages);

            // Set current image
            const imageIndex = folderImages.findIndex(
              (img) => img.path === filePath,
            );
            if (imageIndex !== -1) {
              setCurrentImage(filePath, imageIndex);
              console.log(
                "Set current image:",
                filePath,
                "at index:",
                imageIndex,
              );
            }
          } catch (error) {
            console.error("Failed to handle dropped file:", error);
            setError(new Error("Failed to load dropped image"));
            setTimeout(() => setError(null), 3000);
          } finally {
            setLoading(false);
          }
        });

        // Listen for file drop hover events
        unlistenFileDropHover = await listen(
          "tauri://file-drop-hover",
          (event) => {
            console.log("File drop hover:", event.payload);
          },
        );

        // Listen for file drop cancelled events
        unlistenFileDropCancelled = await listen(
          "tauri://file-drop-cancelled",
          (event) => {
            console.log("File drop cancelled:", event.payload);
          },
        );

        // Try alternative event names for Tauri v2
        await listen("file-drop", async (event) => {
          console.log("File drop detected (file-drop):", event.payload);
        });

        await listen("drop", async (event) => {
          console.log("File drop detected (drop):", event.payload);
        });

        await listen("tauri://drop", async (event) => {
          console.log("File drop detected (tauri://drop):", event.payload);
        });

        console.log("File drop listeners set up successfully");
      } catch (error) {
        console.error("Failed to setup file drop listeners:", error);
      }
    };

    setupListeners();

    // Return cleanup function
    return () => {
      console.log("Cleaning up file drop listeners...");
      if (unlistenFileDrop) unlistenFileDrop();
      if (unlistenFileDropHover) unlistenFileDropHover();
      if (unlistenFileDropCancelled) unlistenFileDropCancelled();
    };
  }, [setCurrentImage, setFolderImages, setError, setLoading]);
};
