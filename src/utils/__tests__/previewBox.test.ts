import { afterEach, describe, expect, it } from "vitest";
import {
  _resetPreviewBoxForTests,
  currentPreviewBox,
  previewBoxForScreen,
} from "../previewBox";

describe("previewBoxForScreen", () => {
  it("picks the smallest bucket that contains the physical screen", () => {
    expect(previewBoxForScreen(1920, 1080, 1)).toBe("1920x1080");
    expect(previewBoxForScreen(1536, 864, 1.25)).toBe("1920x1080"); // 1080p at 125%
    expect(previewBoxForScreen(2560, 1440, 1)).toBe("2560x1440");
    expect(previewBoxForScreen(1920, 1200, 1)).toBe("2560x1440"); // 16:10 overflows 1080 in height
    expect(previewBoxForScreen(3840, 2160, 1)).toBe("3840x2160");
  });

  it("caps at the largest bucket", () => {
    expect(previewBoxForScreen(5120, 2880, 1)).toBe("3840x2160");
  });

  it("orients the box like a portrait screen", () => {
    expect(previewBoxForScreen(1080, 1920, 1)).toBe("1080x1920");
  });

  it("falls back to the smallest bucket for unknown screens", () => {
    expect(previewBoxForScreen(0, 0, 1)).toBe("1920x1080");
    expect(previewBoxForScreen(1920, 1080, 0)).toBe("1920x1080");
  });

  it("clamps non-finite dimensions to 0 instead of propagating NaN", () => {
    // width unknown (clamped to 0), height a real 1080 → h > w picks the
    // portrait-oriented box, same as any screen reporting 0 width would.
    expect(previewBoxForScreen(Number.NaN, 1080, 1)).toBe("1080x1920");
    expect(previewBoxForScreen(Number.POSITIVE_INFINITY, 1080, 1)).toBe(
      "1080x1920",
    );
    // height unknown (clamped to 0), width a real 1920 → landscape orientation.
    expect(previewBoxForScreen(1920, Number.NaN, 1)).toBe("1920x1080");
  });
});

describe("currentPreviewBox", () => {
  const originalScreen = window.screen;

  const setScreen = (width: number, height: number) => {
    Object.defineProperty(window, "screen", {
      value: { width, height },
      configurable: true,
      writable: true,
    });
  };

  afterEach(() => {
    _resetPreviewBoxForTests();
    Object.defineProperty(window, "screen", {
      value: originalScreen,
      configurable: true,
      writable: true,
    });
  });

  it("memoizes the first result for the session", () => {
    setScreen(1920, 1080);
    const first = currentPreviewBox();
    // Moving the window to a different monitor mid-session must NOT split one
    // folder's previews across two boxes — the memoized value wins.
    setScreen(3840, 2160);
    const second = currentPreviewBox();
    expect(second).toBe(first);
    expect(second).toBe("1920x1080");
  });

  it("recomputes for the new screen after _resetPreviewBoxForTests()", () => {
    setScreen(1920, 1080);
    expect(currentPreviewBox()).toBe("1920x1080");
    _resetPreviewBoxForTests();
    setScreen(3840, 2160);
    expect(currentPreviewBox()).toBe("3840x2160");
  });
});
