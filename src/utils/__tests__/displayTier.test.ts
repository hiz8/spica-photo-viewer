import { describe, expect, it } from "vitest";
import { displayTierOf } from "../displayTier";
import { mockImageData } from "../testUtils";

describe("displayTierOf", () => {
  it("is 'none' without image data", () => {
    expect(displayTierOf(null, false)).toBe("none");
    expect(displayTierOf(null, true)).toBe("none");
  });

  it("is 'thumbnail' while the placeholder is displayed", () => {
    expect(displayTierOf(mockImageData, true)).toBe("thumbnail");
  });

  it("is 'full' for displayed image data that is not a placeholder", () => {
    expect(displayTierOf(mockImageData, false)).toBe("full");
    expect(displayTierOf(mockImageData, undefined)).toBe("full");
  });
});
