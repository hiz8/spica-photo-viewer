import { describe, it, expect } from "vitest";
import { getFilename, getFolderPath } from "../path";

describe("getFilename", () => {
  it("extracts the filename from a Unix path", () => {
    expect(getFilename("/foo/bar/baz.jpg")).toBe("baz.jpg");
  });

  it("extracts the filename from a Windows path", () => {
    expect(getFilename("C:\\foo\\bar\\baz.jpg")).toBe("baz.jpg");
  });

  it("returns the input when there is no separator", () => {
    expect(getFilename("baz.jpg")).toBe("baz.jpg");
  });

  it("returns empty string for trailing separator", () => {
    expect(getFilename("/foo/bar/")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(getFilename("")).toBe("");
  });

  it("handles paths with mixed separators", () => {
    expect(getFilename("C:/foo\\bar/baz.jpg")).toBe("baz.jpg");
  });
});

describe("getFolderPath", () => {
  it("extracts the folder from a Unix path", () => {
    expect(getFolderPath("/foo/bar/baz.jpg")).toBe("/foo/bar");
  });

  it("extracts the folder from a Windows path", () => {
    expect(getFolderPath("C:\\foo\\bar\\baz.jpg")).toBe("C:\\foo\\bar");
  });

  it("returns empty string when no separator is present", () => {
    expect(getFolderPath("baz.jpg")).toBe("");
  });

  it("preserves the slash for files at the Unix filesystem root", () => {
    expect(getFolderPath("/file.jpg")).toBe("/");
  });

  it("preserves the trailing separator for files at a Windows drive root", () => {
    expect(getFolderPath("C:\\file.jpg")).toBe("C:\\");
  });

  it("preserves the trailing separator for files at a Windows drive root with forward slash", () => {
    expect(getFolderPath("C:/file.jpg")).toBe("C:/");
  });

  it("returns the folder up to the last separator regardless of separator mix", () => {
    expect(getFolderPath("C:/foo\\bar/baz.jpg")).toBe("C:/foo\\bar");
    expect(getFolderPath("/foo\\bar.jpg")).toBe("/foo");
  });
});
