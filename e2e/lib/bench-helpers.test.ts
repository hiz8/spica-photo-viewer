import { describe, expect, it } from "vitest";
import {
  extractTimings,
  type PerfEntry,
  placeholderDuration,
} from "./bench-helpers";

describe("extractTimings", () => {
  it("scopes the fetchDecode interval to the full-res (thumbnail: false) decode:done mark", () => {
    const path = "/corpus/large/img-01.jpg";

    // A two-stage load: a thumbnail preview is decoded/painted first (from
    // the on-disk thumbnail cache, no protocol fetch) - its decode:done
    // fires BEFORE the full-res load's src:set even happens - then the
    // full-res image arrives via the spica-img protocol and is
    // decoded/painted second. Both stages fire the app's paint/decode
    // effect, so both emit decode:done and paint:done - but only the
    // full-res load's src:set is the one that pairs with the full-res
    // decode:done.
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      // Thumbnail preview stage - decoded/painted well before the full-res
      // src:set fires. If the decode:done lookup doesn't filter on
      // thumbnail, this earlier mark is the one that gets picked (entries.find
      // returns the first match), making the "fetchDecode" interval negative
      // (80 - 100 = -20) rather than merely wrong.
      {
        type: "mark",
        name: "decode:done",
        ts: 80,
        detail: { path, thumbnail: true },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 85,
        detail: { path, thumbnail: true },
      },
      // Full-res stage.
      { type: "mark", name: "src:set", ts: 100, detail: { path } },
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

describe("placeholderDuration", () => {
  const path = "/corpus/large/img-01.jpg";

  it("returns the thumbnail->full-res gap for a two-stage paint", () => {
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      {
        type: "mark",
        name: "paint:done",
        ts: 30,
        detail: { path, thumbnail: true },
      },
      { type: "mark", name: "src:set", ts: 35, detail: { path } },
      {
        type: "mark",
        name: "decode:done",
        ts: 400,
        detail: { path, thumbnail: false },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 430,
        detail: { path, thumbnail: false },
      },
    ];
    expect(placeholderDuration(extractTimings(entries, path))).toBe(400); // 430 - 30
  });

  it("returns 0 when the first paint is already full resolution (preload hit)", () => {
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      {
        type: "mark",
        name: "paint:done",
        ts: 25,
        detail: { path, thumbnail: false },
      },
    ];
    expect(placeholderDuration(extractTimings(entries, path))).toBe(0);
  });
});
