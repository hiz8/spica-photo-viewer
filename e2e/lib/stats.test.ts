import { describe, expect, it } from "vitest";
import { median, p95 } from "./stats";

describe("stats", () => {
  it("median of odd-length array is the middle value", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it("median of even-length array averages the two middle values", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("p95 returns the value at the 95th percentile (nearest-rank)", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(values)).toBe(95);
  });
  it("p95 of a short array returns the max", () => {
    expect(p95([10, 30, 20])).toBe(30);
  });
  it("throws on empty input", () => {
    expect(() => median([])).toThrow();
    expect(() => p95([])).toThrow();
  });
});
