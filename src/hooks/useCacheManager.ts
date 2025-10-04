import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";

const MAX_PRELOADED_IMAGES = 20; // Maximum number of preloaded images
const MAX_THUMBNAIL_CACHE = 100; // Maximum number of cached thumbnails

export const useCacheManager = () => {
  const { cache } = useAppStore();

  useEffect(() => {
    const initializeCache = async () => {
      try {
        // Clean up old cache entries on startup
        await invoke("clear_old_cache");
        console.log("Cache cleanup completed");

        // Optional: Log cache statistics
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

  // Clean up memory cache when it gets too large
  useEffect(() => {
    const cleanupMemoryCache = () => {
      // Clean up preloaded images if too many
      if (cache.preloaded.size > MAX_PRELOADED_IMAGES) {
        const entries = Array.from(cache.preloaded.entries());
        const entriesToRemove = entries.slice(
          0,
          cache.preloaded.size - MAX_PRELOADED_IMAGES,
        );
        entriesToRemove.forEach(([path]) => {
          cache.preloaded.delete(path);
        });
        console.log(
          `Cleaned up ${entriesToRemove.length} preloaded images from memory`,
        );
      }

      // Clean up thumbnail cache if too many
      if (cache.thumbnails.size > MAX_THUMBNAIL_CACHE) {
        const entries = Array.from(cache.thumbnails.entries());
        const entriesToRemove = entries.slice(
          0,
          cache.thumbnails.size - MAX_THUMBNAIL_CACHE,
        );
        entriesToRemove.forEach(([path]) => {
          cache.thumbnails.delete(path);
        });
        console.log(
          `Cleaned up ${entriesToRemove.length} thumbnails from memory`,
        );
      }
    };

    // Run cleanup every 30 seconds
    const interval = setInterval(cleanupMemoryCache, 30000);
    return () => clearInterval(interval);
  }, [cache]);

  const clearCache = async () => {
    try {
      await invoke("clear_old_cache");
      console.log("Manual cache cleanup completed");
    } catch (error) {
      console.error("Failed to clear cache:", error);
    }
  };

  const getCacheStats = async () => {
    try {
      const stats = await invoke<{ [key: string]: number }>("get_cache_stats");
      return stats;
    } catch (error) {
      console.error("Failed to get cache stats:", error);
      return {};
    }
  };

  return {
    clearCache,
    getCacheStats,
  };
};
