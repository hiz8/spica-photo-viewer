import { useCallback, useEffect, useRef } from "react";
import { BITMAP_CACHE_BUDGET_BYTES } from "../constants/memory";
import { MAX_CONCURRENT_LOADS } from "../constants/timing";
import { useAppStore } from "../store";
import type { ImageData } from "../types";
import {
  bitmapBytes,
  bitmapPaths,
  clearBitmaps,
  deleteBitmap,
  fullBitmapPaths,
  hasBitmap,
  setBitmap,
} from "../utils/bitmapCache";
import { loadPreviewBitmap } from "../utils/bitmapLoader";
import { getFilename } from "../utils/path";
import { perfEvent } from "../utils/perf";
import {
  computeVisibleWindow,
  visibleThumbnailRadius,
} from "../utils/preloadWindow";
import { currentPreviewBox } from "../utils/previewBox";

/** Debounce before recomputing the radius once a window resize settles. */
const RESIZE_DEBOUNCE_MS = 200;

/**
 * Spec: docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md
 *
 * Visible-range preview window scheduler (§6.6). Keeps a decoded preview-tier
 * bitmap for every image the thumbnail bar can show (current ±
 * visibleThumbnailRadius) — "if you can see the thumbnail, the image is
 * ready". Full resolution is retained for the current image only: a 20MP
 * RGBA decode is ~80MB vs ~8MB for a screen-box preview, so the whole
 * visible window costs less than five full decodes.
 *
 * Invariants (non-GIF):
 * - I2 (window = visible range): §5. The current path is in `keep` (never
 *   evicted) but is never filled here — its bitmap comes from the viewer,
 *   which is already decoding it.
 * - I3 (honest hits): §5. Eviction always removes the bitmap and the
 *   cache.preloaded entry together, so a hit always has decoded pixels of
 *   the tier the store reports behind it.
 *
 * Fill is gated per path on cache.thumbnails holding a non-"error" entry:
 * (I1) means the preview is already on disk, so the load is a file read
 * instead of a decode racing the thumbnail generator. cache.thumbnails is an
 * effect dependency, so the window fills progressively as the generator
 * works outward from the current image (distance-first) — no allGenerated
 * gate.
 *
 * pump() is split into two phases so eviction/budget enforcement can never
 * be silently skipped: maintenance (full-tier sweep, evict outside the
 * window, enforce the byte budget, abort stale fetches) runs unconditionally
 * whenever there's a valid current index; fill (launch new decodes) is
 * gated on the current image itself being displayed at non-placeholder
 * resolution, so window decodes never compete with the decode the user is
 * waiting for (protects NAV_cold / TTFI_cold). Without this split, browsing
 * during a folder's thumbnail-generation window would retain unbounded
 * decoded bitmaps (ImageViewer's retainElementAsBitmap retains
 * unconditionally) with no eviction and no budget enforcement.
 */
export const useImagePreloader = (): void => {
  const { folder, currentImage, cache, ui } = useAppStore();

  const directionRef = useRef<1 | -1>(1);
  const prevIndexRef = useRef(-1);
  const pendingRef = useRef(new Map<string, AbortController>());
  // Latched when the byte budget had to evict: the window is worth more
  // than the budget, so filling it further only displaces what is already
  // retained. Cleared whenever the retained set's demand can change — index,
  // folder, or window width — never by a mere re-render (see pump()).
  const budgetSaturatedRef = useRef(false);
  // Captured from the first render, so the folder-change effect below can
  // tell a genuine folder switch apart from its own initial-mount firing.
  const prevFolderPathRef = useRef(folder.path);

  const currentReady =
    currentImage.data !== null &&
    currentImage.data.width > 0 &&
    !ui.thumbnailDisplayed;

  /**
   * Recomputes the retained set from live state, evicts what fell out,
   * enforces the byte budget, and (once gated open) fills free load slots
   * in priority order. Called from the index effect, from the debounced
   * resize listener, and from every load completion (to pump queued
   * targets).
   */
  const pump = useCallback(() => {
    const state = useAppStore.getState();
    const images = state.folder.images;
    const index = state.currentImage.index;
    if (index < 0 || index >= images.length) return;

    const windowIndices = computeVisibleWindow(
      index,
      directionRef.current,
      images.length,
      visibleThumbnailRadius(window.innerWidth),
    );
    const currentPath = images[index].path;
    const keep = new Set<string>([currentPath]);
    for (const i of windowIndices) keep.add(images[i].path);

    // --- Maintenance phase: always runs while the index is valid, even
    // while the fill phase below is gated off (e.g. while the current image
    // still shows its thumbnail placeholder). Eviction and the budget guard
    // must never be skippable, or unbounded ~80MB decoded bitmaps
    // accumulate.

    // Full resolution is for the current image only. Everything else keeps
    // at most its preview: ImageViewer retains what it displayed at full
    // resolution (retainElementAsBitmap) and the zoom upgrade adds more, so
    // without this sweep a few visits would blow the byte budget on their
    // own. Dropping the last tier also drops the preload entry (I3) —
    // keeping it would advertise a hit with no pixels behind it.
    for (const path of fullBitmapPaths()) {
      if (path === currentPath) continue;
      deleteBitmap(path, "full");
      if (!hasBitmap(path)) state.removePreloadedImage(path);
    }

    // Sweeps bitmapPaths() ∪ cache.preloaded keys, not just bitmapPaths(),
    // so entries the bitmap cache never knew about — stale entries from a
    // folder switch via openImageFromPath, GIF entries, permanent error
    // entries — are also evicted outside the window; otherwise a parked
    // error entry could never retry even after the path re-enters it.
    const trackedPaths = new Set<string>(bitmapPaths());
    for (const path of state.cache.preloaded.keys()) trackedPaths.add(path);
    for (const path of trackedPaths) {
      if (!keep.has(path)) {
        deleteBitmap(path); // no-op if the path has no bitmap
        state.removePreloadedImage(path);
        console.log(`Cleaned from preload cache: ${getFilename(path)}`);
      }
    }
    // Budget guard for oversized images and wide windows: evict
    // farthest-first, never current.
    const ranked = [currentPath, ...windowIndices.map((i) => images[i].path)];
    while (bitmapBytes() > BITMAP_CACHE_BUDGET_BYTES) {
      const victim = [...ranked]
        .reverse()
        .find((p) => p !== currentPath && hasBitmap(p));
      if (!victim) break;
      deleteBitmap(victim);
      state.removePreloadedImage(victim);
      budgetSaturatedRef.current = true;
    }
    // Abort loads whose target left the window.
    for (const [path, controller] of pendingRef.current) {
      if (!keep.has(path)) {
        controller.abort();
        pendingRef.current.delete(path);
      }
    }

    // --- Fill phase: only launch new decodes once the current image itself
    // is already displayed at non-placeholder resolution, so window decodes
    // never compete with the decode the user is waiting for (protects
    // NAV_cold / TTFI_cold).
    const data = state.currentImage.data;
    if (!data || data.width <= 0 || state.ui.thumbnailDisplayed) return;
    // The window is already worth more than the budget (a wide window on a
    // 4K box asks for ~3GB of previews), so eviction just made room that
    // fill would immediately spend — and every completion pumps again.
    // Stop instead: the retained set converges to the paths nearest the
    // current image, because eviction is farthest-first and fill is
    // nearest-first. The flag is a ref rather than a per-pump local
    // because cache.thumbnails is an effect dependency: a large folder
    // pumps once per generated thumbnail, and a per-pump stop would let
    // every one of those hundreds of pumps refetch the tail that the
    // previous pump evicted (wasted I/O competing with the generator, and
    // an oscillating preloadedCount).
    if (budgetSaturatedRef.current) return;

    const box = currentPreviewBox();
    // Fill free slots in priority order.
    for (const i of windowIndices) {
      if (pendingRef.current.size >= MAX_CONCURRENT_LOADS) break;
      const info = images[i];
      if (info.format === "gif") continue;
      const path = info.path;
      if (hasBitmap(path) || pendingRef.current.has(path)) continue;
      if (state.cache.preloaded.get(path)?.format === "error") continue;
      // No thumbnail entry yet ⇒ no preview on disk yet (I1). Skip rather
      // than let the protocol route self-heal: generating the preview here
      // would decode the original a second time, in parallel with the
      // thumbnail generator already decoding it. The path gets picked up on
      // the pump that its thumbnail entry triggers.
      const thumbnail = state.cache.thumbnails.get(path);
      if (thumbnail === undefined || thumbnail === "error") continue;

      const controller = new AbortController();
      pendingRef.current.set(path, controller);
      void loadPreviewBitmap(path, box, controller.signal)
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
          // Stored as preview TIER always, even when loaded.tier is "full"
          // (no downscaling needed, so the viewer skips a redundant
          // upgrade): filing it as full would make the sweep above drop it
          // next pump and fill below re-fetch it, forever. The loader's own
          // verdict still survives in the stored ImageData.tier.
          setBitmap(path, bitmap, "preview");
          useAppStore.getState().setPreloadedImage(path, loaded);
          perfEvent("preload:done", { path, tier: loaded.tier });
          console.log(`Preloaded preview: ${getFilename(path)}`);
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
          // Re-pump to fill the slot this load just freed. Assumes the
          // hook stays mounted for the app's lifetime (ImageViewer is
          // permanently mounted, App.tsx) — if it ever unmounted mid-flight
          // this could launch an owner-less load.
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
    budgetSaturatedRef.current = false;
  }, [folder.path]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: folder.images isn't read in the closure (pump() re-reads it fresh via useAppStore.getState()), but it must stay a dependency so this effect re-fires — and pumps — when the image list itself changes (e.g. populates asynchronously) even while currentImage.index stays put. cache.thumbnails and currentReady are also unread here but must stay dependencies so the effect re-fires — and lets the fill phase inside pump() reach newly eligible paths — when a thumbnail lands or the fill gate opens without the index itself changing.
  useEffect(() => {
    const index = currentImage.index;
    if (index !== prevIndexRef.current) {
      if (prevIndexRef.current !== -1 && index !== -1) {
        directionRef.current = index > prevIndexRef.current ? 1 : -1;
      }
      prevIndexRef.current = index;
      // The window moved, so what it asks for changed: re-test the budget
      // instead of inheriting the previous window's verdict.
      budgetSaturatedRef.current = false;
    }
    // pump() itself decides which phases run (maintenance always runs for
    // a valid index; fill is gated inside pump on currentReady and, per
    // path, on the thumbnail entry) — this effect only needs to know
    // there's an index to pump for.
    if (index === -1) {
      return;
    }
    pump();
  }, [currentImage.index, folder.images, cache.thumbnails, currentReady, pump]);

  // The retained radius is derived from window.innerWidth (how many
  // thumbnails the bar can show), so a resize changes the window itself:
  // re-pump once the drag settles rather than on every resize event.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // A new width means a new radius, so the budget verdict is stale.
        budgetSaturatedRef.current = false;
        pump();
      }, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [pump]);

  // Abort in-flight loads on unmount.
  useEffect(
    () => () => {
      for (const controller of pendingRef.current.values()) controller.abort();
      pendingRef.current.clear();
    },
    [],
  );
};
