import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import {
  THUMBNAIL_GENERATION_DEBOUNCE_MS,
  THUMBNAIL_GENERATION_INITIAL_RANGE,
  THUMBNAIL_GENERATION_EXPANDED_RANGE,
  THUMBNAIL_SIZE,
  MAX_CONCURRENT_LOADS,
} from "../constants/timing";
import { getFilename } from "../utils/path";
import { perfMark } from "../utils/perf";
import { currentPreviewBox } from "../utils/previewBox";
import type { ThumbnailWithDimensions } from "../types";

/**
 * Spec: docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md
 *
 * Hook for centralized thumbnail generation with priority queue.
 * Generates thumbnails in order: current image → +1, -1, +2, -2, ...
 * Pauses generation during navigation to prioritize image display.
 */
export const useThumbnailGenerator = () => {
  const { folder, currentImage } = useAppStore();

  const generationQueueRef = useRef<string[]>([]);
  const isGeneratingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expansionPhaseRef = useRef<0 | 1 | 2>(0); // 0: initial, 1: expanded range, 2: full range
  const lastStartRef = useRef(0);

  /**
   * Generate thumbnail for a single image
   */
  const generateThumbnail = useCallback(
    async (imagePath: string, signal: AbortSignal): Promise<boolean> => {
      // Get fresh cache state to avoid stale closure
      const {
        cache: currentCache,
        setCachedThumbnail,
        setThumbnailGeneration,
      } = useAppStore.getState();

      if (currentCache.thumbnails.has(imagePath)) {
        return true;
      }

      try {
        setThumbnailGeneration({ currentGeneratingPath: imagePath });

        const previewBox = currentPreviewBox();

        // First, try to get from backend cache (thumbnail + matching preview)
        const cachedThumbnail = await invoke<
          [string, number | null, number | null] | null
        >("get_cached_thumbnail", {
          path: imagePath,
          size: THUMBNAIL_SIZE,
          previewBox,
        });

        if (signal.aborted) return false;

        if (cachedThumbnail) {
          const [base64, width, height] = cachedThumbnail;
          if (width !== null && height !== null) {
            setCachedThumbnail(imagePath, { base64, width, height });
            perfMark("thumb:done", { path: imagePath, source: "cache" });
            return true;
          }
          // If cached entry lacks dimensions, regenerate.
        }

        // Generate thumbnail + preview from one decode; the command writes
        // both to the disk cache before returning (I1), so no write-back here.
        const result = await invoke<ThumbnailWithDimensions>(
          "generate_thumbnail_with_dimensions",
          { path: imagePath, size: THUMBNAIL_SIZE, previewBox },
        );

        if (signal.aborted) return false;

        setCachedThumbnail(imagePath, {
          base64: result.thumbnail_base64,
          width: result.original_width,
          height: result.original_height,
        });
        perfMark("thumb:done", { path: imagePath, source: "generate" });

        console.log(`Generated thumbnail: ${getFilename(imagePath)}`);
        return true;
      } catch (error) {
        if (!signal.aborted) {
          console.warn(
            `Failed to generate thumbnail for ${getFilename(imagePath)}:`,
            error,
          );

          // Cache error to avoid retry
          try {
            await invoke("set_cached_thumbnail", {
              path: imagePath,
              thumbnail: "error",
              size: THUMBNAIL_SIZE,
              width: null,
              height: null,
            });
            // Get fresh setCachedThumbnail in case it changed
            useAppStore.getState().setCachedThumbnail(imagePath, "error");
          } catch (cacheErr) {
            console.warn("Failed to cache thumbnail error:", cacheErr);
          }
        }
        return false;
      } finally {
        // Get fresh setThumbnailGeneration in case it changed
        useAppStore
          .getState()
          .setThumbnailGeneration({ currentGeneratingPath: null });
      }
    },
    [], // No dependencies - always get fresh state from useAppStore.getState()
  );

  /** @param maxRange - Maximum offset from current image (undefined = all images) */
  const buildPriorityQueue = useCallback((maxRange?: number): string[] => {
    // Get fresh state to avoid stale closure
    const { currentImage, folder, cache } = useAppStore.getState();

    if (currentImage.index === -1 || !folder.images.length) {
      return [];
    }

    const queue: string[] = [];
    const currentIndex = currentImage.index;
    const images = folder.images;

    queue.push(images[currentIndex].path);

    const effectiveRange =
      maxRange !== undefined
        ? Math.min(maxRange, images.length - 1)
        : images.length - 1;

    for (let offset = 1; offset <= effectiveRange; offset++) {
      const nextIndex = currentIndex + offset;
      if (nextIndex < images.length) {
        queue.push(images[nextIndex].path);
      }

      const prevIndex = currentIndex - offset;
      if (prevIndex >= 0) {
        queue.push(images[prevIndex].path);
      }
    }

    return queue.filter((path) => !cache.thumbnails.has(path));
  }, []); // No dependencies - always get fresh state from useAppStore.getState()

  const processQueue = useCallback(async () => {
    if (isGeneratingRef.current || generationQueueRef.current.length === 0) {
      return;
    }

    isGeneratingRef.current = true;
    useAppStore
      .getState()
      .setThumbnailGeneration({ isGenerating: true, allGenerated: false });

    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const queue = generationQueueRef.current;
    perfMark("thumbgen:start", { queue: queue.length });

    try {
      for (let i = 0; i < queue.length; i += MAX_CONCURRENT_LOADS) {
        if (signal.aborted) {
          console.log("Thumbnail generation aborted");
          break;
        }

        const chunk = queue.slice(i, i + MAX_CONCURRENT_LOADS);
        await Promise.allSettled(
          chunk.map((path) => generateThumbnail(path, signal)),
        );
      }

      if (!signal.aborted) {
        useAppStore.getState().setThumbnailGeneration({ allGenerated: true });
        console.log("All thumbnails generated");
      }
    } finally {
      isGeneratingRef.current = false;
      useAppStore.getState().setThumbnailGeneration({
        isGenerating: false,
        currentGeneratingPath: null,
      });
      generationQueueRef.current = [];
    }
  }, [generateThumbnail]); // Only depend on generateThumbnail which is now stable

  /** Progressive expansion (initial → expanded → full) avoids processing all 900+ images immediately. */
  const expandQueueProgressively = useCallback(async () => {
    const { currentImage, folder } = useAppStore.getState();

    if (currentImage.index === -1 || folder.images.length === 0) {
      return;
    }

    // Phase 1: initial range done, now the expanded range.
    if (expansionPhaseRef.current === 0) {
      expansionPhaseRef.current = 1;
      const expandedQueue = buildPriorityQueue(
        THUMBNAIL_GENERATION_EXPANDED_RANGE,
      );

      if (expandedQueue.length > 0) {
        console.log(
          `Expanding to ±${THUMBNAIL_GENERATION_EXPANDED_RANGE} range: ${expandedQueue.length} images`,
        );
        generationQueueRef.current = expandedQueue;
        await processQueue();
      }

      // Continue to full range after the expanded range completes.
      await expandQueueProgressively();
      return;
    }

    // Phase 2: process the remaining (full range) images.
    if (expansionPhaseRef.current === 1) {
      expansionPhaseRef.current = 2;
      const fullQueue = buildPriorityQueue();

      if (fullQueue.length === 0) {
        console.log("All thumbnails already generated");
        return;
      }

      console.log(
        `Expanding to full range: ${fullQueue.length} remaining images`,
      );
      generationQueueRef.current = fullQueue;
      await processQueue();
    }
  }, [buildPriorityQueue, processQueue]);

  const startGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    expansionPhaseRef.current = 0;

    // The debounce only exists to sit out rapid navigation; a folder open or
    // a navigation after a pause starts generating immediately.
    const now = Date.now();
    const isRapid =
      now - lastStartRef.current < THUMBNAIL_GENERATION_DEBOUNCE_MS;
    lastStartRef.current = now;

    const initialQueue = buildPriorityQueue(THUMBNAIL_GENERATION_INITIAL_RANGE);

    // Skip the debounce when all initial thumbnails are already cached —
    // saves ~500ms on subsequent large-folder opens.
    if (initialQueue.length === 0) {
      console.log(
        "All initial thumbnails cached, skipping debounce and expanding",
      );
      // Note: processQueue() in expandQueueProgressively sets isGenerating.
      void expandQueueProgressively();
      return;
    }

    generationQueueRef.current = initialQueue;
    console.log(
      `Initial thumbnail queue: ${initialQueue.length} images (±${THUMBNAIL_GENERATION_INITIAL_RANGE})`,
    );

    debounceTimeoutRef.current = setTimeout(
      () => {
        processQueue().then(() => {
          expandQueueProgressively();
        });
      },
      isRapid ? THUMBNAIL_GENERATION_DEBOUNCE_MS : 0,
    );
  }, [buildPriorityQueue, processQueue, expandQueueProgressively]);

  /**
   * Deliberately NOT gated on currentImage.data !== null: generation starts
   * immediately on navigation, independent of image loading, so thumbnails
   * are ready as placeholders for future navigations.
   */
  useEffect(() => {
    if (currentImage.index !== -1 && folder.images.length > 0) {
      startGeneration();
    }

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [currentImage.index, folder.images.length, startGeneration]);

  return {
    startGeneration,
  };
};
