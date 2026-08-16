import { describe, expect, it } from "vitest";
import { imageFormat, imageSrc } from "../imageSrc";

describe("imageSrc", () => {
  it("builds a spica-img URL with the path fully encoded", () => {
    const url = imageSrc("C:\\photos\\テスト 画像.jpg");
    expect(url.startsWith("http://spica-img.localhost/")).toBe(true);
    expect(url).not.toContain("\\");
    expect(url).not.toContain(" ");
    expect(
      decodeURIComponent(url.slice("http://spica-img.localhost/".length)),
    ).toBe("C:\\photos\\テスト 画像.jpg");
  });

  it("imageFormat returns the lowercase extension", () => {
    expect(imageFormat("C:\\a\\b.JPG")).toBe("jpg");
    expect(imageFormat("C:\\a\\b.jpeg")).toBe("jpeg");
    expect(imageFormat("C:\\a\\noext")).toBe("unknown");
  });
});
