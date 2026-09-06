import { describe, expect, it } from "vitest";
import { windowedClientBox } from "../windowedGeometry";

// Natural 2000x1000 laid out at the origin; each case overrides what it needs.
const base = {
  imageWidth: 2000,
  imageHeight: 1000,
  zoom: 100,
  imageLeft: 0,
  imageTop: 0,
  panX: 0,
  panY: 0,
};

describe("windowedClientBox", () => {
  it("sizes the client area to the displayed image at 100%", () => {
    expect(windowedClientBox(base)).toMatchObject({
      width: 2000,
      height: 1000,
    });
  });

  it("scales the client area with the current zoom", () => {
    expect(windowedClientBox({ ...base, zoom: 50 })).toMatchObject({
      width: 1000,
      height: 500,
    });
  });

  it("widens a narrow landscape image to the 544px minimum, keeping its aspect", () => {
    // 2000x1000 at 20% displays as 400x200.
    expect(windowedClientBox({ ...base, zoom: 20 })).toMatchObject({
      width: 544,
      height: 272,
    });
  });

  it("widens a narrow portrait image to the 544px minimum, keeping its aspect", () => {
    expect(
      windowedClientBox({
        ...base,
        imageWidth: 1000,
        imageHeight: 2000,
        zoom: 20,
      }),
    ).toMatchObject({ width: 544, height: 1088 });
  });

  it("does not cap the client area at the screen size", () => {
    expect(windowedClientBox({ ...base, zoom: 200 })).toMatchObject({
      width: 4000,
      height: 2000,
    });
  });

  it("centers the client area on the image's on-screen center", () => {
    // Layout box at (280,134), transform-origin center, pan applied after
    // scale (Z1): center = (280 + 1000 + 10, 134 + 500 - 20) = (1290, 614).
    expect(
      windowedClientBox({
        ...base,
        zoom: 50,
        imageLeft: 280,
        imageTop: 134,
        panX: 10,
        panY: -20,
      }),
    ).toEqual({ left: 790, top: 364, width: 1000, height: 500 });
  });

  it("keeps the image centered when the minimum width enlarges the client area", () => {
    // center = (1280, 634); the 544x272 box is centered on it.
    expect(
      windowedClientBox({ ...base, zoom: 20, imageLeft: 280, imageTop: 134 }),
    ).toEqual({ left: 1008, top: 498, width: 544, height: 272 });
  });
});
