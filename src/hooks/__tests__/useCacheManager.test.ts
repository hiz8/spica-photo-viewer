import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImageData } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

import { useAppStore } from "../../store";
import { useCacheManager } from "../useCacheManager";

const mockInvoke = vi.mocked(invoke);

const thumbnail = { base64: "AAAA", width: 4000, height: 3000 };

const preloaded = (path: string): ImageData => ({
  path,
  src: "data:image/jpeg;base64,AAAA",
  width: 1920,
  height: 1080,
  format: "jpeg",
});

// Long enough for any periodic sweep to have run several times.
const LONG_ENOUGH_MS = 5 * 60 * 1000;

describe("useCacheManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockResolvedValue(undefined);
    useAppStore.setState((state) => ({
      cache: {
        ...state.cache,
        thumbnails: new Map(),
        preloaded: new Map(),
      },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps every thumbnail of a large folder while the app sits idle", () => {
    // Thumbnails land nearest-first, so a count cap that drops the oldest
    // entries blanks exactly the visible part of the bar (the bug this
    // guards against).
    const entries = Array.from(
      { length: 150 },
      (_, i) => [`/test/image${i}.jpg`, thumbnail] as const,
    );
    useAppStore.getState().setCachedThumbnails(entries);

    renderHook(() => useCacheManager());
    act(() => {
      vi.advanceTimersByTime(LONG_ENOUGH_MS);
    });

    expect(useAppStore.getState().cache.thumbnails.size).toBe(150);
  });

  it("keeps every preloaded entry while the app sits idle", () => {
    // The preloader owns this map's lifetime (window eviction + byte
    // budget, I3); a second sweep here would drop entries whose bitmaps
    // are still retained and turn hits into misses.
    for (let i = 0; i < 47; i++) {
      const path = `/test/image${i}.jpg`;
      useAppStore.getState().setPreloadedImage(path, preloaded(path));
    }

    renderHook(() => useCacheManager());
    act(() => {
      vi.advanceTimersByTime(LONG_ENOUGH_MS);
    });

    expect(useAppStore.getState().cache.preloaded.size).toBe(47);
  });

  it("sweeps the disk cache once, after the startup work has settled", () => {
    renderHook(() => useCacheManager());

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(mockInvoke).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(LONG_ENOUGH_MS);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("clear_old_cache");
  });
});
