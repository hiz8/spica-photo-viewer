import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearBitmaps, setBitmap } from "../bitmapCache";
import { _setPerfEnabledForTests } from "../perf";
import { installTestHooks } from "../testHooks";

describe("testHooks", () => {
  beforeEach(() => {
    window.__SPICA_TEST__ = undefined;
    window.__PERF__ = [];
  });

  afterEach(() => {
    _setPerfEnabledForTests(null);
    clearBitmaps();
  });

  it("installs window.__SPICA_TEST__ when perf is enabled", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    expect(window.__SPICA_TEST__).toBeDefined();
    expect(typeof window.__SPICA_TEST__?.openImage).toBe("function");
    expect(typeof window.__SPICA_TEST__?.getStatus).toBe("function");
  });

  it("does not install hooks when perf is disabled", () => {
    _setPerfEnabledForTests(false);
    installTestHooks();
    expect(window.__SPICA_TEST__).toBeUndefined();
  });

  it("getStatus reflects store state and clearPerf empties the buffer", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    window.__PERF__ = [{ type: "mark", name: "x", ts: 1 }];

    const status = window.__SPICA_TEST__?.getStatus();
    expect(status).toMatchObject({
      index: -1,
      hasData: false,
      bitmapPaths: [],
    });

    window.__SPICA_TEST__?.clearPerf();
    expect(window.__PERF__).toHaveLength(0);
  });

  it("getStatus lists the paths with a retained bitmap", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    setBitmap("C:\\pics\\a.jpg", { close: () => {} } as ImageBitmap);

    expect(window.__SPICA_TEST__?.getStatus().bitmapPaths).toEqual([
      "C:\\pics\\a.jpg",
    ]);
  });
});
