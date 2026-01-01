import { useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { ImageData } from "../types";
import {
  PRELOAD_DELAY_MS,
  PRELOAD_RANGE,
  MAX_CONCURRENT_LOADS,
} from "../constants/timing";

/**
 * Hook for preloading full-resolution images
 * Only starts after all thumbnails are generated
 * Preloads up to ±5 images around current position
 */
export const useImagePreloader = () => {
  const {
    folder,
    currentImage,
    cache,
    thumbnailGeneration,
    setPreloadedImage,
    removePreloadedImage,
  } = useAppStore();

  // Track pending loads to prevent duplicate requests
  const pendingLoadsRef = useRef<Set<string>>(new Set());

  /**
   * Preload full-resolution image
   */
  const preloadImage = useCallback(
    async (imagePath: string): Promise<void> => {
      // Check if already preloaded or currently loading
      if (cache.preloaded.has(imagePath) || pendingLoadsRef.current.has(imagePath)) {
        return;
      }

      // Mark as pending to prevent duplicate loads
      pendingLoadsRef.current.add(imagePath);

      try {
        // Load full-resolution image
        const imageData = await invoke<ImageData>("load_image", {
          path: imagePath,
        });

        // Store in preload cache
        setPreloadedImage(imagePath, imageData);

        console.log(`Preloaded full image: ${imagePath.split(/[\\/]/).pop()}`);
      } catch (error) {
        console.warn(
          `Failed to preload image: ${imagePath.split(/[\\/]/).pop()}`,
          error,
        );

        // Mark as error in cache to avoid retry
        const errorData: ImageData = {
          path: imagePath,
          base64: "",
          width: 0,
          height: 0,
          format: "error",
        };
        setPreloadedImage(imagePath, errorData);
      } finally {
        // Remove from pending loads
        pendingLoadsRef.current.delete(imagePath);
      }
    },
    [cache.preloaded, setPreloadedImage],
  );

  /**
   * Build preload queue: ±1, ±2, ±3... up to ±PRELOAD_RANGE
   */
  const getPreloadQueue = useCallback(() => {
    if (currentImage.index === -1 || !folder.images.length) {
      return [];
    }

    const queue: string[] = [];
    const currentIndex = currentImage.index;

    // Add images in order of priority:
    // ±1, ±2, ±3... up to ±PRELOAD_RANGE

    for (let range = 1; range <= PRELOAD_RANGE; range++) {
      // Add next image (+range)
      const nextIndex = currentIndex + range;
      if (nextIndex < folder.images.length) {
        const nextPath = folder.images[nextIndex].path;
        if (!cache.preloaded.has(nextPath)) {
          queue.push(nextPath);
        }
      }

      // Add previous image (-range)
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

  /**
   * Clean up preloaded images outside the range
   */
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

    // Remove preloaded images outside the range
    const keysToRemove: string[] = [];
    cache.preloaded.forEach((_, path) => {
      if (!imagesToKeep.has(path)) {
        keysToRemove.push(path);
      }
    });

    keysToRemove.forEach((path) => {
      removePreloadedImage(path);
      console.log(`Cleaned from preload cache: ${path.split(/[\\/]/).pop()}`);
    });
  }, [
    currentImage.index,
    folder.images,
    cache.preloaded,
    removePreloadedImage,
  ]);

  /**
   * Start preloading full-resolution images
   */
  const startPreloading = useCallback(async () => {
    // Only start if all thumbnails are generated
    if (!thumbnailGeneration.allGenerated) {
      console.log(
        "Waiting for thumbnail generation to complete before preloading...",
      );
      return;
    }

    const queue = getPreloadQueue();

    if (queue.length === 0) {
      return;
    }

    console.log(`Starting preload of ${queue.length} images...`);

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

    console.log("Preloading complete");
  }, [
    thumbnailGeneration.allGenerated,
    getPreloadQueue,
    cleanupCache,
    preloadImage,
  ]);

  // Start preloading when current image changes or all thumbnails are generated
  useEffect(() => {
    if (
      currentImage.index !== -1 &&
      folder.images.length > 0 &&
      thumbnailGeneration.allGenerated
    ) {
      // Delay preloading to avoid interfering with rapid navigation
      const timeoutId = setTimeout(startPreloading, PRELOAD_DELAY_MS);
      return () => clearTimeout(timeoutId);
    }
  }, [
    currentImage.index,
    folder.images.length,
    thumbnailGeneration.allGenerated,
    startPreloading,
  ]);

  return {
    preloadImage,
    startPreloading,
    cleanupCache,
  };
};
