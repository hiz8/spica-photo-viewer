import { describe, expect, it } from "vitest";
import { centeredPosition, fitZoom, viewerLayoutArea } from "../viewerLayout";

describe("viewerLayoutArea", () => {
  it("excludes the thumbnail bar and keeps a 20px fit margin when maximized", () => {
    expect(viewerLayoutArea(1920, 1080, false)).toEqual({
      width: 1920,
      height: 1000,
      margin: 20,
    });
  });

  it("uses the whole client area with no margin in windowed mode", () => {
    expect(viewerLayoutArea(544, 272, true)).toEqual({
      width: 544,
      height: 272,
      margin: 0,
    });
  });
});

describe("fitZoom", () => {
  const maximized = { width: 1920, height: 1000, margin: 20 };

  it("shrinks a large image to fit inside the margins", () => {
    // min(1880 / 4000, 960 / 500) = 0.47
    expect(fitZoom(maximized, 4000, 500)).toBeCloseTo(47);
  });

  it("never upscales an image that already fits", () => {
    expect(fitZoom(maximized, 800, 600)).toBe(100);
  });

  it("clamps at 10% for a huge image", () => {
    expect(fitZoom({ width: 100, height: 100, margin: 0 }, 10000, 10000)).toBe(
      10,
    );
  });

  it("fills a windowed area that matches the image aspect exactly", () => {
    expect(
      fitZoom({ width: 544, height: 272, margin: 0 }, 2000, 1000),
    ).toBeCloseTo(27.2);
  });
});

describe("centeredPosition", () => {
  it("centers the layout box in the area, ignoring the margin", () => {
    expect(
      centeredPosition({ width: 1000, height: 720, margin: 20 }, 400, 300),
    ).toEqual({ left: 300, top: 210 });
  });
});
