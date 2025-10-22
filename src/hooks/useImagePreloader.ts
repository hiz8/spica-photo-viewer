import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import {
  PRELOAD_DELAY_MS,
  PRELOAD_RANGE,
  MAX_CONCURRENT_LOADS,
  PREVIEW_THUMBNAIL_SIZE,
  SMALL_THUMBNAIL_SIZE,
} from "../constants/timing";

export const useImagePreloader = () => {
  const { folder, currentImage } = useAppStore();

  const preloadImage = useCallback(
    async (imagePath: string): Promise<void> => {
      // Get fresh cache state to avoid stale closure
      const {
        cache: currentCache,
        setCachedThumbnail: setCachedThumb,
        setCachedSmallThumbnail: setSmallThumb,
      } = useAppStore.getState();

      // Check if already cached
      if (currentCache.thumbnails.has(imagePath)) {
        return;
      }

      try {
        // Generate 400px preview thumbnail for preloading
        const thumbnailBase64 = await invoke<string>(
          "generate_image_thumbnail",
          {
            path: imagePath,
            size: PREVIEW_THUMBNAIL_SIZE,
          },
        );

        // Update cache in store using proper action
        setCachedThumb(imagePath, thumbnailBase64);

        // Also generate 20px small thumbnail for thumbnail bar
        const smallThumbnailBase64 = await invoke<string>(
          "generate_image_thumbnail",
          {
            path: imagePath,
            size: SMALL_THUMBNAIL_SIZE,
          },
        );

        // Save to disk cache for persistence
        await invoke("set_cached_thumbnail", {
          path: imagePath,
          thumbnail: smallThumbnailBase64,
          size: SMALL_THUMBNAIL_SIZE,
        });

        // Update memory cache
        setSmallThumb(imagePath, smallThumbnailBase64);

        console.log(`Preloaded: ${imagePath.split(/[\\/]/).pop()}`);
      } catch (error) {
        console.warn(
          `Failed to preload thumbnail: ${imagePath.split(/[\\/]/).pop()}`,
          error,
        );

        // Mark as failed in cache to avoid retry (empty string)
        setCachedThumb(imagePath, "");
      }
    },
    [], // No dependencies - always use fresh state from getState()
  );

  const getPreloadQueue = useCallback(() => {
    // Get fresh state to avoid stale closure
    const {
      currentImage: current,
      folder: currentFolder,
      cache: currentCache,
    } = useAppStore.getState();

    if (current.index === -1 || !currentFolder.images.length) {
      return [];
    }

    const queue: string[] = [];
    const currentIndex = current.index;

    // Add images in order of priority:
    // 1. Next image (most likely to be viewed)
    // 2. Previous image
    // 3. Gradually expand range ±1, ±2, ±3... up to ±PRELOAD_RANGE

    for (let range = 1; range <= PRELOAD_RANGE; range++) {
      // Add next image
      const nextIndex = currentIndex + range;
      if (nextIndex < currentFolder.images.length) {
        const nextPath = currentFolder.images[nextIndex].path;
        if (!currentCache.thumbnails.has(nextPath)) {
          queue.push(nextPath);
        }
      }

      // Add previous image
      const prevIndex = currentIndex - range;
      if (prevIndex >= 0) {
        const prevPath = currentFolder.images[prevIndex].path;
        if (!currentCache.thumbnails.has(prevPath)) {
          queue.push(prevPath);
        }
      }
    }

    return queue;
  }, []); // No dependencies - always use fresh state from getState()

  const cleanupCache = useCallback(() => {
    // Get fresh state to avoid stale closure
    const {
      currentImage: current,
      folder: currentFolder,
      cache: currentCache,
      removeCachedThumbnail: removeThumb,
    } = useAppStore.getState();

    if (current.index === -1 || !currentFolder.images.length) {
      return;
    }

    const currentIndex = current.index;
    const imagesToKeep = new Set<string>();

    // Keep current image and ±PRELOAD_RANGE images
    for (
      let i = Math.max(0, currentIndex - PRELOAD_RANGE);
      i <=
      Math.min(currentFolder.images.length - 1, currentIndex + PRELOAD_RANGE);
      i++
    ) {
      imagesToKeep.add(currentFolder.images[i].path);
    }

    // Remove 400px preview thumbnails outside the range
    const keysToRemove: string[] = [];
    currentCache.thumbnails.forEach((_, path) => {
      if (!imagesToKeep.has(path)) {
        keysToRemove.push(path);
      }
    });

    keysToRemove.forEach((path) => {
      removeThumb(path);
      console.log(`Cleaned from cache: ${path.split(/[\\/]/).pop()}`);
    });

    // Note: 20px small thumbnails are kept permanently for thumbnail bar display
    // They are only cleared when changing folders or explicitly requested
  }, []); // No dependencies - always use fresh state from getState()

  const loadCurrentImageThumbnail = useCallback(
    async (imagePath: string): Promise<void> => {
      // Get fresh cache state to avoid stale closure
      const { cache: currentCache, setCachedSmallThumbnail: setSmallThumb } =
        useAppStore.getState();

      // Check if already cached
      if (currentCache.smallThumbnails.has(imagePath)) {
        return;
      }

      try {
        // Check disk cache first
        const cachedThumbnail = await invoke<string | null>(
          "get_cached_thumbnail",
          {
            path: imagePath,
            size: SMALL_THUMBNAIL_SIZE,
          },
        );

        if (cachedThumbnail) {
          setSmallThumb(imagePath, cachedThumbnail);
          return;
        }

        // Generate 20px small thumbnail for current image
        const smallThumbnailBase64 = await invoke<string>(
          "generate_image_thumbnail",
          {
            path: imagePath,
            size: SMALL_THUMBNAIL_SIZE,
          },
        );

        // Save to disk cache for persistence
        await invoke("set_cached_thumbnail", {
          path: imagePath,
          thumbnail: smallThumbnailBase64,
          size: SMALL_THUMBNAIL_SIZE,
        });

        // Update memory cache
        setSmallThumb(imagePath, smallThumbnailBase64);

        console.log(
          `Generated thumbnail for current image: ${imagePath.split(/[\\/]/).pop()}`,
        );
      } catch (error) {
        console.warn(
          `Failed to generate thumbnail for current image: ${imagePath.split(/[\\/]/).pop()}`,
          error,
        );
      }
    },
    [], // No dependencies - always use fresh state from getState()
  );

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Functions use getState() for fresh data
  useEffect(() => {
    if (currentImage.index !== -1 && folder.images.length > 0) {
      // Immediately load thumbnail for current image
      const currentImagePath = folder.images[currentImage.index]?.path;
      if (currentImagePath) {
        loadCurrentImageThumbnail(currentImagePath);
      }

      // Delay preloading to avoid interfering with rapid navigation
      const timeoutId = setTimeout(startPreloading, PRELOAD_DELAY_MS);
      return () => clearTimeout(timeoutId);
    }
  }, [currentImage.index, folder.images.length]);

  return {
    preloadImage,
    startPreloading,
    cleanupCache,
    loadCurrentImageThumbnail,
    getPreloadQueue,
  };
};
