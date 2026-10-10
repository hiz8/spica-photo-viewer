import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

/**
 * The disk sweep walks every cache entry (thousands of files after a few
 * large folders); run at mount it competes with the startup image and the
 * folder scan for disk and blocking threads, so it waits until they are done.
 */
const DISK_SWEEP_DELAY_MS = 5000;

/**
 * Deliberately no periodic count cap on the in-memory caches. Thumbnails
 * are inserted nearest-first, so an oldest-first cap blanked exactly the
 * visible part of the bar in folders above the cap; and cache.preloaded is
 * owned by useImagePreloader (window eviction + byte budget, I3), where a
 * second sweep dropped entries whose bitmaps were still retained. Both maps
 * are bounded by the folder: a folder switch drops the other folder's
 * entries.
 */
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
};
