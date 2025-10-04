import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { ImageData } from "../types";

const PRELOAD_RANGE = 20; // ±20 images
const MAX_CONCURRENT_LOADS = 3;

export const useImagePreloader = () => {
  const {
    folder,
    currentImage,
    cache,
    setPreloadedImage,
    removePreloadedImage,
  } = useAppStore();

  const preloadImage = useCallback(
    async (imagePath: string): Promise<void> => {
      // Check if already preloaded or currently loading
      if (cache.preloaded.has(imagePath)) {
        return;
      }

      try {
        const imageData = await invoke<ImageData>("load_image", {
          path: imagePath,
        });

        // Update cache in store using proper action
        setPreloadedImage(imagePath, imageData);

        console.log(`Preloaded: ${imagePath.split(/[\\/]/).pop()}`);
      } catch (error) {
        console.warn(
          `Failed to preload image: ${imagePath.split(/[\\/]/).pop()}`,
          error,
        );

        // Mark as failed in cache to avoid retry
        const errorPlaceholder: ImageData = {
          path: imagePath,
          base64: "",
          width: 0,
          height: 0,
          format: "error",
        };
        setPreloadedImage(imagePath, errorPlaceholder);
      }
    },
    [cache.preloaded, setPreloadedImage],
  );

  const getPreloadQueue = useCallback(() => {
    if (currentImage.index === -1 || !folder.images.length) {
      return [];
    }

    const queue: string[] = [];
    const currentIndex = currentImage.index;

    // Add images in order of priority:
    // 1. Next image (most likely to be viewed)
    // 2. Previous image
    // 3. Gradually expand range ±1, ±2, ±3... up to ±PRELOAD_RANGE

    for (let range = 1; range <= PRELOAD_RANGE; range++) {
      // Add next image
      const nextIndex = currentIndex + range;
      if (nextIndex < folder.images.length) {
        const nextPath = folder.images[nextIndex].path;
        if (!cache.preloaded.has(nextPath)) {
          queue.push(nextPath);
        }
      }

      // Add previous image
      const prevIndex = currentIndex - range;
      if (prevIndex >= 0) {
        const prevPath = folder.images[prevIndex].path;
        if (!cache.preloaded.has(prevPath)) {
          queue.push(prevPath);
        }
      }
    }

    return queue;
  }, [currentImage.index, folder.images, cache.preloaded]);

  const cleanupCache = useCallback(() => {
    if (currentImage.index === -1 || !folder.images.length) {
      return;
    }

    const currentIndex = currentImage.index;
    const imagesToKeep = new Set<string>();

    // Keep current image and ±PRELOAD_RANGE images
    for (
      let i = Math.max(0, currentIndex - PRELOAD_RANGE);
      i <= Math.min(folder.images.length - 1, currentIndex + PRELOAD_RANGE);
      i++
    ) {
      imagesToKeep.add(folder.images[i].path);
    }

    // Remove images outside the range
    const keysToRemove: string[] = [];
    cache.preloaded.forEach((_, path) => {
      if (!imagesToKeep.has(path)) {
        keysToRemove.push(path);
      }
    });

    keysToRemove.forEach((path) => {
      removePreloadedImage(path);
      console.log(`Cleaned from cache: ${path.split(/[\\/]/).pop()}`);
    });
  }, [
    currentImage.index,
    folder.images,
    cache.preloaded,
    removePreloadedImage,
  ]);

  const startPreloading = useCallback(async () => {
    const queue = getPreloadQueue();

    if (queue.length === 0) {
      return;
    }

    // Clean up cache before preloading new images
    cleanupCache();

    // Process queue with concurrent loading limit
    const chunks = [];
    for (let i = 0; i < queue.length; i += MAX_CONCURRENT_LOADS) {
      chunks.push(queue.slice(i, i + MAX_CONCURRENT_LOADS));
    }

    for (const chunk of chunks) {
      await Promise.allSettled(chunk.map(preloadImage));
    }
  }, [getPreloadQueue, cleanupCache, preloadImage]);

  // Start preloading when current image changes
  useEffect(() => {
    if (currentImage.index !== -1 && folder.images.length > 0) {
      // Delay preloading slightly to prioritize current image loading
      const timeoutId = setTimeout(startPreloading, 500);
      return () => clearTimeout(timeoutId);
    }
  }, [currentImage.index, folder.images.length, startPreloading]);

  return {
    preloadImage,
    startPreloading,
    cleanupCache,
  };
};
