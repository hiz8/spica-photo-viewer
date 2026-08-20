/**
 * E2E test hooks. Only installed in perf-enabled builds (dev, or
 * VITE_PERF_LOG=1). The bench harness drives the app through these via
 * browser.execute() instead of simulating UI input, which keeps the
 * measured interval (open:request -> paint:done) identical to real usage.
 */
import { useAppStore } from "../store";
import { bitmapPaths } from "./bitmapCache";
import { isPerfEnabled } from "./perf";

export interface SpicaTestHooks {
  openImage: (path: string) => Promise<void>;
  navigateToImage: (index: number) => void;
  navigateNext: () => void;
  getStatus: () => {
    path: string;
    index: number;
    hasData: boolean;
    isLoading: boolean;
    thumbnailDisplayed: boolean;
    preloadedCount: number;
    /**
     * Paths with a retained decoded bitmap. A cache.preloaded entry alone
     * does not imply one (viewer-loaded entries survive a folder switch and
     * their bitmap retention races clearBitmaps()), and only a path listed
     * here paints via <canvas> on navigation.
     */
    bitmapPaths: string[];
  };
  clearPerf: () => void;
}

declare global {
  interface Window {
    __SPICA_TEST__?: SpicaTestHooks;
  }
}

export const installTestHooks = (): void => {
  if (!isPerfEnabled()) return;
  window.__SPICA_TEST__ = {
    openImage: (path) => useAppStore.getState().openImageFromPath(path),
    navigateToImage: (index) => useAppStore.getState().navigateToImage(index),
    navigateNext: () => useAppStore.getState().navigateNext(),
    getStatus: () => {
      const state = useAppStore.getState();
      return {
        path: state.currentImage.path,
        index: state.currentImage.index,
        hasData: state.currentImage.data !== null,
        isLoading: state.ui.isLoading,
        // ui.thumbnailDisplayed is optional in AppState; normalize to boolean
        // to match the SpicaTestHooks#getStatus contract.
        thumbnailDisplayed: !!state.ui.thumbnailDisplayed,
        preloadedCount: state.cache.preloaded.size,
        bitmapPaths: bitmapPaths(),
      };
    },
    clearPerf: () => {
      window.__PERF__ = [];
    },
  };
};
