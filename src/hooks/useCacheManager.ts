import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";

const MAX_PRELOADED_IMAGES = 20;
const MAX_THUMBNAIL_CACHE = 100;
const CLEANUP_INTERVAL_MS = 30000;

export const useCacheManager = () => {
  useEffect(() => {
    const initializeCache = async () => {
      try {
        await invoke("clear_old_cache");
        console.log("Cache cleanup completed");

        const stats = await invoke<{ [key: string]: number }>(
          "get_cache_stats",
        );
        console.log("Cache stats:", stats);
      } catch (error) {
        console.warn("Failed to initialize cache:", error);
      }
    };

    initializeCache();
  }, []);

  useEffect(() => {
    const cleanupMemoryCache = () => {
      const { cache, removePreloadedImage, removeCachedThumbnail } =
        useAppStore.getState();

      if (cache.preloaded.size > MAX_PRELOADED_IMAGES) {
        const paths = Array.from(cache.preloaded.keys()).slice(
          0,
          cache.preloaded.size - MAX_PRELOADED_IMAGES,
        );
        paths.forEach(removePreloadedImage);
        console.log(`Cleaned up ${paths.length} preloaded images from memory`);
      }

      if (cache.thumbnails.size > MAX_THUMBNAIL_CACHE) {
        const paths = Array.from(cache.thumbnails.keys()).slice(
          0,
          cache.thumbnails.size - MAX_THUMBNAIL_CACHE,
        );
        paths.forEach(removeCachedThumbnail);
        console.log(`Cleaned up ${paths.length} thumbnails from memory`);
      }
    };

    const interval = setInterval(cleanupMemoryCache, CLEANUP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
};
