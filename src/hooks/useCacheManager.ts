import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";

const MAX_PRELOADED_IMAGES = 20;
const MAX_THUMBNAIL_CACHE = 100;
const CLEANUP_INTERVAL_MS = 30000;
/**
 * The disk sweep walks every cache entry (thousands of files after a few
 * large folders); run at mount it competes with the startup image and the
 * folder scan for disk and blocking threads, so it waits until they are done.
 */
const DISK_SWEEP_DELAY_MS = 5000;

export const useCacheManager = () => {
  useEffect(() => {
    const sweepDiskCache = async () => {
      try {
        await invoke("clear_old_cache");
        console.log("Cache cleanup completed");
      } catch (error) {
        console.warn("Failed to sweep cache:", error);
      }
    };

    const timeoutId = setTimeout(sweepDiskCache, DISK_SWEEP_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    const cleanupMemoryCache = () => {
      const { cache, removePreloadedImages, removeCachedThumbnails } =
        useAppStore.getState();

      if (cache.preloaded.size > MAX_PRELOADED_IMAGES) {
        const paths = Array.from(cache.preloaded.keys()).slice(
          0,
          cache.preloaded.size - MAX_PRELOADED_IMAGES,
        );
        removePreloadedImages(paths);
        console.log(`Cleaned up ${paths.length} preloaded images from memory`);
      }

      if (cache.thumbnails.size > MAX_THUMBNAIL_CACHE) {
        const paths = Array.from(cache.thumbnails.keys()).slice(
          0,
          cache.thumbnails.size - MAX_THUMBNAIL_CACHE,
        );
        removeCachedThumbnails(paths);
        console.log(`Cleaned up ${paths.length} thumbnails from memory`);
      }
    };

    const interval = setInterval(cleanupMemoryCache, CLEANUP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
};
