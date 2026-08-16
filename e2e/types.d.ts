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
  };
  clearPerf: () => void;
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
