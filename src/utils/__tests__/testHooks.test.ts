import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../store";
import { clearBitmaps, setBitmap } from "../bitmapCache";
import { _setPerfEnabledForTests } from "../perf";
import { installTestHooks } from "../testHooks";
import { mockImageData } from "../testUtils";

describe("testHooks", () => {
  beforeEach(() => {
    window.__SPICA_TEST__ = undefined;
    window.__PERF__ = [];
  });

  afterEach(() => {
    _setPerfEnabledForTests(null);
    clearBitmaps();
    useAppStore.getState().setThumbnailDisplayed(false);
    useAppStore.getState().setImageData(null);
    useAppStore.getState().setZoom(100);
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

  it("getStatus reports the displayed tier", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    expect(window.__SPICA_TEST__?.getStatus().displayedTier).toBe("none");

    useAppStore.getState().setImageData(mockImageData);
    expect(window.__SPICA_TEST__?.getStatus().displayedTier).toBe("full");

    useAppStore.getState().setThumbnailDisplayed(true);
    expect(window.__SPICA_TEST__?.getStatus().displayedTier).toBe("thumbnail");
  });

  it("evictDecoded drops every retained bitmap and preload entry", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    setBitmap("C:\\pics\\a.jpg", { close: () => {} } as ImageBitmap);
    useAppStore.getState().setPreloadedImage("C:\\pics\\a.jpg", mockImageData);
    useAppStore.getState().setPreloadedImage("C:\\pics\\b.jpg", mockImageData);

    const result = window.__SPICA_TEST__?.evictDecoded();

    expect(result).toEqual({ evictedBitmaps: 1, evictedPreloaded: 2 });
    expect(window.__SPICA_TEST__?.getStatus()).toMatchObject({
      bitmapPaths: [],
      preloadedCount: 0,
    });
  });

  it("zoomIn and resetZoom drive the store's zoom actions", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    window.__SPICA_TEST__?.zoomIn();
    expect(useAppStore.getState().view.zoom).toBe(120);

    window.__SPICA_TEST__?.resetZoom();
    expect(useAppStore.getState().view.zoom).toBe(100);
  });

  it("zoomOut drives the store's zoom action", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    window.__SPICA_TEST__?.zoomOut();
    expect(useAppStore.getState().view.zoom).toBeCloseTo(100 / 1.2);
  });

  it("setPan drives the store's pan action", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    window.__SPICA_TEST__?.setPan(-300, 20);
    const { panX, panY } = useAppStore.getState().view;
    expect([panX, panY]).toEqual([-300, 20]);
    useAppStore.getState().setPan(0, 0);
  });

  it("getView reports the window-mode flags and the zoom", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    useAppStore.getState().setMaximized(true);
    useAppStore.getState().setZoom(150);

    expect(window.__SPICA_TEST__?.getView()).toEqual({
      zoom: 150,
      isMaximized: true,
      isFullscreen: false,
      windowed: false,
    });
  });

  it("resizeToImage forwards to the store action", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    expect(typeof window.__SPICA_TEST__?.resizeToImage).toBe("function");
    // Not maximized: the store action returns without touching the backend.
    expect(window.__SPICA_TEST__?.resizeToImage()).resolves.toBeUndefined();
  });
});
