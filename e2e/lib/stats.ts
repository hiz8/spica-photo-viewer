/**
 * Aggregation helpers for the perf bench (see e2e/specs/bench.perf.ts).
 * Single values are never reported - every metric is summarised as
 * median + p95 over N runs, per docs/PERFORMANCE_AUTONOMY_PLAN.md §2.
 */

export const median = (values: number[]): number => {
  if (values.length === 0) throw new Error("median of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Nearest-rank p95: the smallest value at or above the 95th percentile. */
export const p95 = (values: number[]): number => {
  if (values.length === 0) throw new Error("p95 of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
};
