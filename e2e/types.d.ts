/**
 * Mirror of the app-side test/perf globals (src/utils/testHooks.ts and
 * src/utils/perf.ts) so `browser.execute()` callbacks type-check without casts.
 * Keep in sync with those files.
 */

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
    /** Paths with a retained decoded bitmap (the <canvas> hit set). */
    bitmapPaths: string[];
    /** What the viewer currently shows: none | thumbnail | preview | full. */
    displayedTier: "none" | "thumbnail" | "preview" | "full";
  };
  clearPerf: () => void;
  /** Drops decoded bitmaps + cache.preloaded (thumbnails/disk cache stay). */
  evictDecoded: () => { evictedBitmaps: number; evictedPreloaded: number };
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  getView: () => {
    zoom: number;
    isMaximized: boolean;
    isFullscreen: boolean;
    windowed: boolean;
  };
  /** The outside-click action (for when the image leaves no background to click). */
  resizeToImage: () => Promise<void>;
}

export interface PerfEntry {
  type: "mark" | "event";
  name: string;
  ts: number;
  detail?: Record<string, unknown>;
}

declare global {
  interface Window {
    __SPICA_TEST__?: SpicaTestHooks;
    __PERF__?: PerfEntry[];
  }
}
