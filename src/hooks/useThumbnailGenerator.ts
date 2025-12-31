import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import {
  THUMBNAIL_GENERATION_DEBOUNCE_MS,
  MAX_CONCURRENT_LOADS,
} from "../constants/timing";

const THUMBNAIL_SIZE = 20;
const INITIAL_RANGE = 10; // ±10 images for initial quick load

/**
 * Hook for centralized thumbnail generation with priority queue
 * Generates thumbnails in order: current image → +1, -1, +2, -2, ...
 * Pauses generation during navigation to prioritize image display
 */
export const useThumbnailGenerator = () => {
  const { folder, currentImage } = useAppStore();

  const generationQueueRef = useRef<string[]>([]);
  const isGeneratingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasExpandedQueueRef = useRef(false); // Track if queue expanded to full range

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

      // Check if already cached
      if (currentCache.thumbnails.has(imagePath)) {
        return true;
      }

      try {
        setThumbnailGeneration({ currentGeneratingPath: imagePath });

        // First, try to get from backend cache
        const cachedThumbnail = await invoke<
          [string, number | null, number | null] | null
        >("get_cached_thumbnail", {
          path: imagePath,
          size: THUMBNAIL_SIZE,
        });

        if (signal.aborted) return false;

        if (cachedThumbnail) {
          const [base64, width, height] = cachedThumbnail;
          // Only use cached thumbnail if it has dimensions
          if (width !== null && height !== null) {
            setCachedThumbnail(imagePath, { base64, width, height });
            return true;
          }
          // If cached entry lacks dimensions, regenerate
        }

        // Generate new thumbnail with dimensions
        const result = await invoke<{
          thumbnail_base64: string;
          original_width: number;
          original_height: number;
        }>("generate_thumbnail_with_dimensions", {
          path: imagePath,
          size: THUMBNAIL_SIZE,
        });

        if (signal.aborted) return false;

        // Cache the generated thumbnail with dimensions in backend
        await invoke("set_cached_thumbnail", {
          path: imagePath,
          thumbnail: result.thumbnail_base64,
          size: THUMBNAIL_SIZE,
          width: result.original_width,
          height: result.original_height,
        });

        if (signal.aborted) return false;

        // Store in frontend cache
        setCachedThumbnail(imagePath, {
          base64: result.thumbnail_base64,
          width: result.original_width,
          height: result.original_height,
        });

        console.log(`Generated thumbnail: ${imagePath.split(/[\\/]/).pop()}`);
        return true;
      } catch (error) {
        if (!signal.aborted) {
          console.warn(
            `Failed to generate thumbnail for ${imagePath.split(/[\\/]/).pop()}:`,
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

  /**
   * Build priority queue: current → +1, -1, +2, -2, ...
   * @param maxRange - Maximum offset from current image (undefined = all images)
   */
  const buildPriorityQueue = useCallback((maxRange?: number): string[] => {
    // Get fresh state to avoid stale closure
    const { currentImage, folder, cache } = useAppStore.getState();

    if (currentImage.index === -1 || !folder.images.length) {
      return [];
    }

    const queue: string[] = [];
    const currentIndex = currentImage.index;
    const images = folder.images;

    // Add current image first (highest priority)
    queue.push(images[currentIndex].path);

    // Determine effective range
    const effectiveRange =
      maxRange !== undefined
        ? Math.min(maxRange, images.length - 1)
        : images.length - 1;

    // Add images in expanding radius: +1, -1, +2, -2, +3, -3...
    // Stop at effectiveRange instead of images.length
    for (let offset = 1; offset <= effectiveRange; offset++) {
      // Add next image (+offset)
      const nextIndex = currentIndex + offset;
      if (nextIndex < images.length) {
        queue.push(images[nextIndex].path);
      }

      // Add previous image (-offset)
      const prevIndex = currentIndex - offset;
      if (prevIndex >= 0) {
        queue.push(images[prevIndex].path);
      }
    }

    // Filter out already cached thumbnails
    return queue.filter((path) => !cache.thumbnails.has(path));
  }, []); // No dependencies - always get fresh state from useAppStore.getState()

  /**
   * Process thumbnail generation queue
   */
  const processQueue = useCallback(async () => {
    if (isGeneratingRef.current || generationQueueRef.current.length === 0) {
      return;
    }

    isGeneratingRef.current = true;
    // Get fresh setThumbnailGeneration
    useAppStore
      .getState()
      .setThumbnailGeneration({ isGenerating: true, allGenerated: false });

    // Create new abort controller for this generation session
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const queue = generationQueueRef.current;

    try {
      // Process queue with concurrent loading limit
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

      // Mark all as generated if not aborted
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

  /**
   * Expand queue to full range in background after initial thumbnails complete
   */
  const expandQueueToFullRange = useCallback(async () => {
    const { currentImage, folder } = useAppStore.getState();

    if (currentImage.index === -1 || folder.images.length === 0) {
      return;
    }

    // Build full priority queue (no maxRange limit)
    const fullQueue = buildPriorityQueue();

    if (fullQueue.length === 0) {
      console.log("All thumbnails already generated");
      return;
    }

    console.log(
      `Expanding thumbnail queue to ${fullQueue.length} remaining images`,
    );
    generationQueueRef.current = fullQueue;
    hasExpandedQueueRef.current = true;

    await processQueue();
  }, [buildPriorityQueue, processQueue]);

  /**
   * Start thumbnail generation with debounce
   */
  const startGeneration = useCallback(() => {
    // Abort any ongoing generation
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Clear existing debounce timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // Reset expansion flag on new navigation
    hasExpandedQueueRef.current = false;

    // Build initial priority queue with limited range
    const initialQueue = buildPriorityQueue(INITIAL_RANGE);
    if (initialQueue.length === 0) {
      useAppStore
        .getState()
        .setThumbnailGeneration({ allGenerated: true, isGenerating: false });
      return;
    }

    generationQueueRef.current = initialQueue;
    console.log(
      `Initial thumbnail queue: ${initialQueue.length} images (±${INITIAL_RANGE})`,
    );

    // Debounce: wait for navigation to settle
    debounceTimeoutRef.current = setTimeout(() => {
      processQueue().then(() => {
        // After initial queue completes, expand to full range in background
        if (!hasExpandedQueueRef.current) {
          expandQueueToFullRange();
        }
      });
    }, THUMBNAIL_GENERATION_DEBOUNCE_MS);
  }, [buildPriorityQueue, processQueue, expandQueueToFullRange]);

  /**
   * Trigger generation when current image or folder changes
   * Note: Removed currentImage.data !== null condition to allow thumbnail generation
   * to start immediately on navigation, independent of image loading.
   * This ensures thumbnails are available as placeholders for future navigations.
   */
  useEffect(() => {
    if (currentImage.index !== -1 && folder.images.length > 0) {
      startGeneration();
    }

    return () => {
      // Cleanup: abort generation and clear timeout
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
