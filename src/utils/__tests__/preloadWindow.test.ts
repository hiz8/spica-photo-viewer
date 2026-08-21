import { describe, expect, it } from "vitest";
import {
  computeVisibleWindow,
  computeWindow,
  visibleThumbnailRadius,
} from "../preloadWindow";

describe("computeWindow", () => {
  it("forward mid-folder: 3 ahead then 1 behind", () => {
    expect(computeWindow(5, 1, 16)).toEqual([6, 7, 8, 4]);
  });

  it("backward mid-folder is the mirror", () => {
    expect(computeWindow(5, -1, 16)).toEqual([4, 3, 2, 6]);
  });

  it("at index 0 forward, fills from ahead only", () => {
    expect(computeWindow(0, 1, 16)).toEqual([1, 2, 3, 4]);
  });

  it("at the last index forward, fills from behind", () => {
    expect(computeWindow(15, 1, 16)).toEqual([14, 13, 12, 11]);
  });

  it("two-image folder yields the single neighbor", () => {
    expect(computeWindow(1, 1, 2)).toEqual([0]);
    expect(computeWindow(0, 1, 2)).toEqual([1]);
  });

  it("single-image folder yields nothing", () => {
    expect(computeWindow(0, 1, 1)).toEqual([]);
  });

  it("respects an explicit size", () => {
    expect(computeWindow(5, 1, 16, 2)).toEqual([6, 7]);
  });
});

describe("visibleThumbnailRadius", () => {
  it("derives a radius from the thumbnail bar's pitch geometry", () => {
    expect(visibleThumbnailRadius(1920)).toBe(23);
    expect(visibleThumbnailRadius(2560)).toBe(31);
    expect(visibleThumbnailRadius(640)).toBe(7);
  });

  it("clamps to the minimum for very narrow windows", () => {
    expect(visibleThumbnailRadius(200)).toBe(4);
  });

  it("clamps to the maximum for very wide windows", () => {
    expect(visibleThumbnailRadius(8000)).toBe(48);
  });
});

describe("computeVisibleWindow", () => {
  it("at index 0 forward, fills from ahead only (no negative indices)", () => {
    expect(computeVisibleWindow(0, 1, 16, 3)).toEqual([1, 2, 3]);
  });

  it("mid-folder forward: ahead first, then behind, in decode order", () => {
    expect(computeVisibleWindow(5, 1, 16, 2)).toEqual([6, 7, 4, 3]);
  });

  it("mid-folder backward is the mirror", () => {
    expect(computeVisibleWindow(5, -1, 16, 2)).toEqual([4, 3, 6, 7]);
  });

  it("at the last index forward, fills from behind only", () => {
    expect(computeVisibleWindow(15, 1, 16, 3)).toEqual([14, 13, 12]);
  });
});
