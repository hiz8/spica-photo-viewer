import { useCallback, useEffect, useRef } from "react";
import {
  BITMAP_CACHE_BUDGET_BYTES,
  BITMAP_WINDOW_SIZE,
} from "../constants/memory";
import { MAX_CONCURRENT_LOADS } from "../constants/timing";
import { useAppStore } from "../store";
import type { ImageData } from "../types";
import {
  bitmapBytes,
  bitmapPaths,
  clearBitmaps,
  deleteBitmap,
  hasBitmap,
  setBitmap,
} from "../utils/bitmapCache";
import { loadBitmapViaProtocol } from "../utils/bitmapLoader";
import { getFilename } from "../utils/path";
import { perfEvent } from "../utils/perf";
import { computeWindow } from "../utils/preloadWindow";

/**
 * Decoded-bitmap window scheduler (hypothesis C). Keeps the current image's
 * neighbors decoded as ImageBitmaps so a preload-hit navigation paints at
 * full resolution without re-decoding. Launches immediately on index change
 * (the old PRELOAD_DELAY_MS timer meant nothing ever preloaded during rapid
 * navigation), but only once the current image itself is displayed at full
 * resolution, so window decodes never compete with the decode the user is
 * waiting for (protects NAV_cold / TTFI_cold).
 * Invariant (non-GIF): cache.preloaded ⊆ bitmapCache ∪ {current} — eviction
 * always removes both, so a "preloaded" hit implies decoded pixels exist.
 */
export const useImagePreloader = (): void => {
  const { folder, currentImage, thumbnailGeneration, ui } = useAppStore();

  const directionRef = useRef<1 | -1>(1);
  const prevIndexRef = useRef(-1);
  const pendingRef = useRef(new Map<string, AbortController>());
  // Captured from the first render, so the folder-change effect below can
  // tell a genuine folder switch apart from its own initial-mount firing.
  const prevFolderPathRef = useRef(folder.path);

  const currentReady =
    currentImage.data !== null &&
    currentImage.data.width > 0 &&
    !ui.thumbnailDisplayed;

  /**
   * Recomputes the retained set from live state, evicts what fell out,
   * and fills free load slots in priority order. Called from the index
   * effect and from every load completion (to pump queued targets).
   */
  const pump = useCallback(() => {
    const state = useAppStore.getState();
    const images = state.folder.images;
    const index = state.currentImage.index;
    if (index < 0 || index >= images.length) return;
    if (!state.thumbnailGeneration.allGenerated) return;
    const data = state.currentImage.data;
    if (!data || data.width <= 0 || state.ui.thumbnailDisplayed) return;

    const windowIndices = computeWindow(
      index,
      directionRef.current,
      images.length,
      BITMAP_WINDOW_SIZE,
    );
    const currentPath = images[index].path;
    const keep = new Set<string>([currentPath]);
    for (const i of windowIndices) keep.add(images[i].path);

    // Evict decoded bitmaps (and their preload entries) outside the window.
    for (const path of bitmapPaths()) {
      if (!keep.has(path)) {
        deleteBitmap(path);
        state.removePreloadedImage(path);
        console.log(`Cleaned from preload cache: ${getFilename(path)}`);
      }
    }
    // Budget guard for oversized images: evict farthest-first, never current.
    const ranked = [currentPath, ...windowIndices.map((i) => images[i].path)];
    while (bitmapBytes() > BITMAP_CACHE_BUDGET_BYTES) {
      const victim = [...ranked]
        .reverse()
        .find((p) => p !== currentPath && hasBitmap(p));
      if (!victim) break;
      deleteBitmap(victim);
      state.removePreloadedImage(victim);
    }
    // Abort loads whose target left the window.
    for (const [path, controller] of pendingRef.current) {
      if (!keep.has(path)) {
        controller.abort();
        pendingRef.current.delete(path);
      }
    }

    // Fill free slots in priority order.
    for (const i of windowIndices) {
      if (pendingRef.current.size >= MAX_CONCURRENT_LOADS) break;
      const info = images[i];
      if (info.format === "gif") continue;
      const path = info.path;
      if (hasBitmap(path) || pendingRef.current.has(path)) continue;
      if (state.cache.preloaded.get(path)?.format === "error") continue;

      const controller = new AbortController();
      pendingRef.current.set(path, controller);
      void loadBitmapViaProtocol(path, controller.signal)
        .then(({ data: loaded, bitmap }) => {
          // Identity check, not existence: abort() cannot guarantee the
          // fetch/decode chain actually stops once the response has
          // arrived (bitmapLoader only passes the signal to fetch()), so a
          // path can leave the window, get re-requested under a NEW
          // controller, and have its stale load resolve afterward. Keying
          // on path alone would let that stale result win over the fresh
          // one; comparing the stored controller detects supersession.
          if (pendingRef.current.get(path) !== controller) {
            bitmap.close(); // superseded, aborted, or evicted while decoding
            return;
          }
          setBitmap(path, bitmap);
          useAppStore.getState().setPreloadedImage(path, loaded);
          perfEvent("preload:done", { path });
          console.log(`Preloaded bitmap: ${getFilename(path)}`);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          console.warn(`Failed to preload image: ${getFilename(path)}`, error);
          const errorData: ImageData = {
            path,
            src: "",
            width: 0,
            height: 0,
            format: "error",
          };
          useAppStore.getState().setPreloadedImage(path, errorData);
        })
        .finally(() => {
          // Only clear the pending entry if it still belongs to this load;
          // a superseded load must not delete the fresh load's ownership
          // record (which would let a still-later stale resolution look
          // "current" again, or make a legit in-flight load look free).
          if (pendingRef.current.get(path) === controller) {
            pendingRef.current.delete(path);
          }
          pump();
        });
    }
  }, []);

  // Folder change invalidates every retained bitmap and in-flight load.
  // Guarded against the initial-mount firing (prevFolderPathRef starts
  // equal to folder.path) so remounting the hook against an unchanged
  // folder never wipes bitmaps a caller may have already retained.
  useEffect(() => {
    if (prevFolderPathRef.current === folder.path) return;
    prevFolderPathRef.current = folder.path;
    clearBitmaps();
    for (const controller of pendingRef.current.values()) controller.abort();
    pendingRef.current.clear();
    prevIndexRef.current = -1;
    directionRef.current = 1;
  }, [folder.path]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: folder.images isn't read in the closure (pump() re-reads it fresh via useAppStore.getState()), but it must stay a dependency so this effect re-fires — and pumps — when the image list itself changes (e.g. populates asynchronously) even while currentImage.index stays put.
  useEffect(() => {
    const index = currentImage.index;
    if (index !== prevIndexRef.current) {
      if (prevIndexRef.current !== -1 && index !== -1) {
        directionRef.current = index > prevIndexRef.current ? 1 : -1;
      }
      prevIndexRef.current = index;
    }
    if (index === -1 || !thumbnailGeneration.allGenerated || !currentReady) {
      return;
    }
    pump();
  }, [
    currentImage.index,
    folder.images,
    thumbnailGeneration.allGenerated,
    currentReady,
    pump,
  ]);

  // Abort in-flight loads on unmount.
  useEffect(
    () => () => {
      for (const controller of pendingRef.current.values()) controller.abort();
      pendingRef.current.clear();
    },
    [],
  );
};
