import { describe, expect, it } from "vitest";
import { extractTimings, type PerfEntry } from "./bench-helpers";

describe("extractTimings", () => {
  it("scopes the fetchDecode interval to the full-res (thumbnail: false) decode:done mark", () => {
    const path = "/corpus/large/img-01.jpg";

    // A two-stage load: a thumbnail preview is decoded/painted first (from
    // the on-disk thumbnail cache, no protocol fetch), then the full-res
    // image arrives via the spica-img protocol and is decoded/painted
    // second. Both stages fire the app's paint/decode effect, so both emit
    // decode:done and paint:done - but only the full-res load's src:set is
    // the one that pairs with the full-res decode:done.
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      { type: "mark", name: "src:set", ts: 100, detail: { path } },
      // Thumbnail preview stage - decoded well BEFORE the full-res src:set
      // even fires. If decode:done lookup doesn't filter on thumbnail, this
      // is the mark that gets picked, making the "fetchDecode" interval
      // negative.
      {
        type: "mark",
        name: "decode:done",
        ts: 120,
        detail: { path, thumbnail: true },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 125,
        detail: { path, thumbnail: true },
      },
      // Full-res stage.
      {
        type: "mark",
        name: "decode:done",
        ts: 160,
        detail: { path, thumbnail: false },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 165,
        detail: { path, thumbnail: false },
      },
    ];

    const timings = extractTimings(entries, path);

    expect(timings.fetchDecode).toBe(60); // 160 (full-res decode) - 100 (src:set)
    expect(timings.fetchDecode).not.toBeLessThan(0);
  });
});
