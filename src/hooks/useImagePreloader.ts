import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import {
  PRELOAD_DELAY_MS,
  PRELOAD_RANGE,
  MAX_CONCURRENT_LOADS,
  PREVIEW_THUMBNAIL_SIZE,
} from "../constants/timing";

export const useImagePreloader = () => {
  const {
    folder,
    currentImage,
    cache,
    setCachedThumbnail,
    removeCachedThumbnail,
  } = useAppStore();

  const preloadImage = useCallback(
    async (imagePath: string): Promise<void> => {
      // Check if already cached
      if (cache.thumbnails.has(imagePath)) {
        return;
      }

      try {
        // Generate thumbnail for preloading
        const thumbnailBase64 = await invoke<string>(
          "generate_image_thumbnail",
          {
            path: imagePath,
            size: PREVIEW_THUMBNAIL_SIZE,
          },
        );

        // Update cache in store using proper action
        setCachedThumbnail(imagePath, thumbnailBase64);

        console.log(`Preloaded: ${imagePath.split(/[\\/]/).pop()}`);
      } catch (error) {
        console.warn(
          `Failed to preload thumbnail: ${imagePath.split(/[\\/]/).pop()}`,
          error,
        );

        // Mark as failed in cache to avoid retry (empty string)
        setCachedThumbnail(imagePath, "");
      }
    },
    [cache.thumbnails, setCachedThumbnail],
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
        if (!cache.thumbnails.has(nextPath)) {
          queue.push(nextPath);
        }
      }

      // Add previous image
      const prevIndex = currentIndex - range;
      if (prevIndex >= 0) {
        const prevPath = folder.images[prevIndex].path;
        if (!cache.thumbnails.has(prevPath)) {
          queue.push(prevPath);
        }
      }
    }

    return queue;
  }, [currentImage.index, folder.images, cache.thumbnails]);

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

    // Remove thumbnails outside the range
    const keysToRemove: string[] = [];
    cache.thumbnails.forEach((_, path) => {
      if (!imagesToKeep.has(path)) {
        keysToRemove.push(path);
      }
    });

    keysToRemove.forEach((path) => {
      removeCachedThumbnail(path);
      console.log(`Cleaned from cache: ${path.split(/[\\/]/).pop()}`);
    });
  }, [
    currentImage.index,
    folder.images,
    cache.thumbnails,
    removeCachedThumbnail,
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
      // Delay preloading to avoid interfering with rapid navigation
      const timeoutId = setTimeout(startPreloading, PRELOAD_DELAY_MS);
      return () => clearTimeout(timeoutId);
    }
  }, [currentImage.index, folder.images.length, startPreloading]);

  return {
    preloadImage,
    startPreloading,
    cleanupCache,
  };
};
