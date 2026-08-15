/**
 * Performance instrumentation utility.
 * Marks are pushed to window.__PERF__ so the E2E bench harness can read them
 * via browser.execute(). Interval pairing (ttfi = open:request -> paint:done)
 * is done offline by the harness, keyed by detail.path — the app never pairs
 * marks itself, so aborted navigations cannot corrupt measurements.
 *
 * Enabled when: DEV build, or release build with VITE_PERF_LOG=1 at build time.
 */

export interface PerfEntry {
  type: "mark" | "event";
  name: string;
  ts: number;
  detail?: Record<string, unknown>;
}

declare global {
  interface Window {
    __PERF__?: PerfEntry[];
  }
}

let forcedEnabled: boolean | null = null;

export const isPerfEnabled = (): boolean => {
  if (forcedEnabled !== null) return forcedEnabled;
  return import.meta.env.DEV || import.meta.env.VITE_PERF_LOG === "1";
};

/** Test-only override. Pass null to restore environment-based detection. */
export const _setPerfEnabledForTests = (enabled: boolean | null): void => {
  forcedEnabled = enabled;
};

const buffer = (): PerfEntry[] => {
  if (!window.__PERF__) {
    window.__PERF__ = [];
  }
  return window.__PERF__;
};

export const perfMark = (
  name: string,
  detail?: Record<string, unknown>,
): void => {
  if (!isPerfEnabled()) return;
  buffer().push({ type: "mark", name, ts: performance.now(), detail });
};

export const perfEvent = (
  name: string,
  detail?: Record<string, unknown>,
): void => {
  if (!isPerfEnabled()) return;
  buffer().push({ type: "event", name, ts: performance.now(), detail });
};
