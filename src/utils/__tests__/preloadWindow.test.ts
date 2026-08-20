import { describe, expect, it } from "vitest";
import { computeWindow } from "../preloadWindow";

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
