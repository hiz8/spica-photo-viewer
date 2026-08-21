import { describe, expect, it } from "vitest";
import { previewBoxForScreen } from "../previewBox";

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
});
