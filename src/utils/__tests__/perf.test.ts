import { afterEach, describe, expect, it } from "vitest";
import {
  _setPerfEnabledForTests,
  isPerfEnabled,
  perfEvent,
  perfMark,
} from "../perf";

describe("perf", () => {
  afterEach(() => {
    _setPerfEnabledForTests(null);
    window.__PERF__ = [];
  });

  it("records a mark with name, ts, and detail when enabled", () => {
    _setPerfEnabledForTests(true);
    perfMark("open:request", { path: "C:\\img\\a.jpg" });

    expect(window.__PERF__).toHaveLength(1);
    const entry = window.__PERF__?.[0];
    expect(entry?.type).toBe("mark");
    expect(entry?.name).toBe("open:request");
    expect(typeof entry?.ts).toBe("number");
    expect(entry?.detail).toEqual({ path: "C:\\img\\a.jpg" });
  });

  it("records an event entry with type 'event'", () => {
    _setPerfEnabledForTests(true);
    perfEvent("preload", { path: "a.jpg", hit: true });

    expect(window.__PERF__?.[0]?.type).toBe("event");
    expect(window.__PERF__?.[0]?.detail).toEqual({ path: "a.jpg", hit: true });
  });

  it("does nothing when disabled", () => {
    _setPerfEnabledForTests(false);
    perfMark("open:request");
    perfEvent("preload");

    expect(window.__PERF__ ?? []).toHaveLength(0);
  });

  it("appends to an existing buffer without clearing it", () => {
    _setPerfEnabledForTests(true);
    perfMark("first");
    perfMark("second");

    expect(window.__PERF__?.map((e) => e.name)).toEqual(["first", "second"]);
  });

  it("isPerfEnabled reflects the forced test value", () => {
    _setPerfEnabledForTests(true);
    expect(isPerfEnabled()).toBe(true);
    _setPerfEnabledForTests(false);
    expect(isPerfEnabled()).toBe(false);
  });
});
