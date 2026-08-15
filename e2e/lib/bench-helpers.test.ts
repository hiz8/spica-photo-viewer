import { describe, expect, it } from "vitest";
import { extractTimings, type PerfEntry } from "./bench-helpers";

describe("extractTimings", () => {
  it("scopes the decode interval to the full-res (thumbnail: false) decode:done mark", () => {
    const path = "/corpus/large/img-01.jpg";

    // A two-stage load: a thumbnail preview is decoded/painted first (from
    // the on-disk thumbnail cache, no IPC round trip), then the full-res
    // image arrives over IPC and is decoded/painted second. Both stages fire
    // the app's paint/decode effect, so both emit decode:done and paint:done
    // - but only the full-res load emits ipc:sent/ipc:received.
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      { type: "mark", name: "ipc:sent", ts: 5, detail: { path } },
      // Thumbnail preview stage - decoded well BEFORE ipc:received even
      // fires. If decode:done lookup doesn't filter on thumbnail, this is
      // the mark that gets picked, making the "decode" interval negative.
      {
        type: "mark",
        name: "decode:done",
        ts: 30,
        detail: { path, thumbnail: true },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 35,
        detail: { path, thumbnail: true },
      },
      // Full-res stage.
      { type: "mark", name: "ipc:received", ts: 100, detail: { path } },
      {
        type: "mark",
        name: "decode:done",
        ts: 140,
        detail: { path, thumbnail: false },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 145,
        detail: { path, thumbnail: false },
      },
    ];

    const timings = extractTimings(entries, path);

    expect(timings.decode).toBe(40); // 140 (full-res decode) - 100 (ipc:received)
    expect(timings.decode).not.toBeLessThan(0);
  });
});
