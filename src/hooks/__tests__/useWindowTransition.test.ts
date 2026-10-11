import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler>();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: async (event: string, handler: Handler) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  }),
}));

import { invoke } from "@tauri-apps/api/core";

import { useAppStore } from "../../store";
import {
  LAYOUT_TIMEOUT_MS,
  useWindowTransition,
  viewportMatches,
  type WindowTransition,
} from "../useWindowTransition";

const mockInvoke = vi.mocked(invoke);

// Animation frames are queued and run by hand, one frame at a time.
let frames: FrameRequestCallback[] = [];
const runFrame = () => {
  const due = frames;
  frames = [];
  act(() => {
    for (const cb of due) cb(performance.now());
  });
};

const setViewport = (innerWidth: number, innerHeight: number, dpr = 1) => {
  Object.defineProperty(window, "innerWidth", {
    value: innerWidth,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    value: innerHeight,
    configurable: true,
  });
  Object.defineProperty(window, "devicePixelRatio", {
    value: dpr,
    configurable: true,
  });
};

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

describe("viewportMatches", () => {
  it("compares the viewport in physical px with a tolerance", () => {
    const target = { width: 660, height: 1273 };
    expect(viewportMatches(660, 1273, 1, target)).toBe(true);
    expect(viewportMatches(661, 1271, 1, target)).toBe(true);
    expect(viewportMatches(663, 1273, 1, target)).toBe(false);
    // 150% DPI: 440 CSS px are the 660 physical px the window reports.
    expect(viewportMatches(440, 848.67, 1.5, target)).toBe(true);
    expect(viewportMatches(660, 1273, 1.5, target)).toBe(false);
  });
});

describe("useWindowTransition", () => {
  beforeEach(() => {
    listeners.clear();
    frames = [];
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    setViewport(2560, 1369);
    useAppStore.getState().setMaximized(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const restore: WindowTransition = {
    id: 7,
    width: 660,
    height: 1273,
    maximized: false,
  };

  const begin = async (payload: WindowTransition) => {
    renderHook(() => useWindowTransition());
    await flush();
    const onTransition = listeners.get("window-transition");
    expect(onTransition).toBeDefined();
    act(() => onTransition?.({ payload }));
  };

  it("ends the transition one frame after the viewport reached the new size", async () => {
    await begin(restore);
    runFrame();
    expect(mockInvoke).not.toHaveBeenCalled();
    setViewport(660, 1273);
    runFrame();
    expect(mockInvoke).not.toHaveBeenCalled();
    runFrame();
    await flush();
    expect(mockInvoke).toHaveBeenCalledWith("end_window_transition", { id: 7 });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("applies the new maximized state before the resize lands", async () => {
    await begin(restore);
    expect(useAppStore.getState().view.isMaximized).toBe(false);
    await begin({ ...restore, id: 10, maximized: true });
    expect(useAppStore.getState().view.isMaximized).toBe(true);
  });

  it("ends the transition at the timeout when the size never arrives", async () => {
    await begin({ ...restore, id: 8 });
    runFrame();
    act(() => {
      vi.advanceTimersByTime(LAYOUT_TIMEOUT_MS);
    });
    await flush();
    expect(mockInvoke).toHaveBeenCalledWith("end_window_transition", { id: 8 });
    // A frame that matches after the timeout must not signal twice.
    setViewport(660, 1273);
    runFrame();
    runFrame();
    await flush();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("does not signal after unmount", async () => {
    const { unmount } = renderHook(() => useWindowTransition());
    await flush();
    const onTransition = listeners.get("window-transition");
    act(() => onTransition?.({ payload: { ...restore, id: 9 } }));
    unmount();
    setViewport(660, 1273);
    runFrame();
    runFrame();
    act(() => {
      vi.advanceTimersByTime(LAYOUT_TIMEOUT_MS);
    });
    await flush();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
