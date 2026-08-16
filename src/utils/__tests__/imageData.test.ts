import { describe, expect, it } from "vitest";
import { rawToImageData } from "../imageData";

describe("rawToImageData", () => {
  it("converts an IPC payload to a data-URL ImageData preserving the current format string", () => {
    const result = rawToImageData({
      path: "C:\\p\\a.jpg",
      base64: "QUJD",
      width: 100,
      height: 50,
      format: "jpg",
    });
    // NOTE: `data:jpg;...` は厳密な MIME ではないが、現行実装と同一文字列を
    // 意図的に維持する（このタスクは挙動不変が要件。Task 4 でパイプラインごと消える）
    expect(result).toEqual({
      path: "C:\\p\\a.jpg",
      src: "data:jpg;base64,QUJD",
      width: 100,
      height: 50,
      format: "jpg",
    });
  });
});
