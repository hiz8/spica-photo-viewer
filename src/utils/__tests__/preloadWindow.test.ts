import { describe, expect, it } from "vitest";
import { computeVisibleWindow, visibleThumbnailRadius } from "../preloadWindow";

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

  it("mid-folder forward: interleaved by distance, direction first", () => {
    expect(computeVisibleWindow(5, 1, 16, 2)).toEqual([6, 4, 7, 3]);
  });

  it("mid-folder backward is the mirror", () => {
    expect(computeVisibleWindow(5, -1, 16, 2)).toEqual([4, 6, 3, 7]);
  });

  it("at the last index forward, fills from behind only", () => {
    expect(computeVisibleWindow(15, 1, 16, 3)).toEqual([14, 13, 12]);
  });

  it("two-image folder yields the single neighbor", () => {
    expect(computeVisibleWindow(1, 1, 2, 4)).toEqual([0]);
    expect(computeVisibleWindow(0, 1, 2, 4)).toEqual([1]);
  });

  it("a radius wider than the folder stops at the folder's ends", () => {
    expect(computeVisibleWindow(1, 1, 3, 10)).toEqual([2, 0]);
  });

  it("single-image folder yields nothing", () => {
    expect(computeVisibleWindow(0, 1, 1, 4)).toEqual([]);
  });
});
