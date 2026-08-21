import { describe, expect, it } from "vitest";
import {
  extractTimings,
  extractZoomTiming,
  type PerfEntry,
  placeholderDuration,
  visibleThumbnailCapacity,
  visibleThumbnailRadius,
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

describe("extractTimings.fullTier", () => {
  const path = "/corpus/large/img-02.jpg";

  it("exposes the tier of the first non-placeholder paint", () => {
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      {
        type: "mark",
        name: "paint:done",
        ts: 20,
        detail: { path, thumbnail: true, tier: "thumbnail" },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 60,
        detail: { path, thumbnail: false, tier: "preview" },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 500,
        detail: { path, thumbnail: false, tier: "full" },
      },
    ];
    const timings = extractTimings(entries, path);
    expect(timings.fullPaint).toBe(60); // first thumbnail:false paint wins
    expect(timings.fullTier).toBe("preview");
  });

  it("is null on marks without a tier (older builds)", () => {
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      {
        type: "mark",
        name: "paint:done",
        ts: 25,
        detail: { path, thumbnail: false },
      },
    ];
    expect(extractTimings(entries, path).fullTier).toBeNull();
  });
});

describe("extractZoomTiming", () => {
  const path = "/corpus/large/img-03.jpg";

  it("is 0 when the displayed tier at request time is already full", () => {
    const entries: PerfEntry[] = [
      {
        type: "mark",
        name: "zoom:request",
        ts: 1000,
        detail: { path, zoom: 120, displayedTier: "full" },
      },
    ];
    expect(extractZoomTiming(entries, path)).toBe(0);
  });

  it("measures request -> first full paint at or after the request", () => {
    const entries: PerfEntry[] = [
      // A full paint BEFORE the request must not be picked up.
      {
        type: "mark",
        name: "paint:done",
        ts: 900,
        detail: { path, thumbnail: false, tier: "full" },
      },
      {
        type: "mark",
        name: "zoom:request",
        ts: 1000,
        detail: { path, zoom: 120, displayedTier: "preview" },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 1010,
        detail: { path, thumbnail: false, tier: "preview" },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 1400,
        detail: { path, thumbnail: false, tier: "full" },
      },
    ];
    expect(extractZoomTiming(entries, path)).toBe(400);
  });

  it("is null without a zoom:request or without a following full paint", () => {
    expect(extractZoomTiming([], path)).toBeNull();
    const pending: PerfEntry[] = [
      {
        type: "mark",
        name: "zoom:request",
        ts: 1000,
        detail: { path, zoom: 120, displayedTier: "preview" },
      },
    ];
    expect(extractZoomTiming(pending, path)).toBeNull();
  });

  it("ignores marks for other paths", () => {
    const entries: PerfEntry[] = [
      {
        type: "mark",
        name: "zoom:request",
        ts: 1000,
        detail: { path: "/other.jpg", zoom: 120, displayedTier: "full" },
      },
    ];
    expect(extractZoomTiming(entries, path)).toBeNull();
  });
});

describe("visibleThumbnailCapacity", () => {
  it("mirrors the 40px thumbnail pitch", () => {
    expect(visibleThumbnailCapacity(1920)).toBe(48);
    expect(visibleThumbnailCapacity(2560)).toBe(64);
    expect(visibleThumbnailCapacity(639)).toBe(15);
  });
});

describe("visibleThumbnailRadius", () => {
  it("is the one-sided count from the centered active item", () => {
    expect(visibleThumbnailRadius(2560)).toBe(31);
    expect(visibleThumbnailRadius(1920)).toBe(23);
    expect(visibleThumbnailRadius(1240)).toBe(15);
    expect(visibleThumbnailRadius(1239)).toBe(14);
  });
});
