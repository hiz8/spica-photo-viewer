import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { mockImageData, mockImageList } from "../../utils/testUtils";
import type { ImageInfo } from "../../types";
import { PRELOAD_DELAY_MS } from "../../constants/timing";
import { _setPerfEnabledForTests } from "../../utils/perf";

// Helper function to create mock ImageInfo objects
const createMockImageInfo = (
  index: number,
  overrides: Partial<ImageInfo> = {},
): ImageInfo => ({
  path: `/test/image${index}.jpg`,
  filename: `image${index}.jpg`,
  size: 1024,
  modified: Date.now() - index * 1000,
  format: "jpeg",
  ...overrides,
});

// Mock the protocol loader (replaces the old IPC invoke boundary).
// Default implementation echoes the requested path into a src-based
// ImageData, mirroring what `loadImageViaProtocol` resolves with after
// decode. Individual tests override with mockResolvedValueOnce/
// mockRejectedValueOnce for specific scenarios.
vi.mock("../../utils/protocolLoader", () => ({
  loadImageViaProtocol: vi.fn(async (path: string) => ({
    data: {
      path,
      src: `http://spica-img.localhost/x`,
      width: 10,
      height: 10,
      format: "jpg",
    },
    element: new Image(),
  })),
}));

// Mock the store
const mockStore = {
  folder: {
    path: "/test",
    images: [] as ImageInfo[],
  },
  currentImage: {
    index: -1,
  },
  cache: {
    preloaded: new Map(),
  },
  thumbnailGeneration: {
    isGenerating: false,
    allGenerated: true,
    currentGeneratingPath: null,
  },
  setPreloadedImage: vi.fn(),
  removePreloadedImage: vi.fn(),
};

vi.mock("../../store", () => ({
  useAppStore: vi.fn(() => mockStore),
}));

import { useImagePreloader } from "../useImagePreloader";
import { loadImageViaProtocol } from "../../utils/protocolLoader";

const mockLoadImageViaProtocol = vi.mocked(loadImageViaProtocol);

describe("useImagePreloader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.folder.path = "/test";
    mockStore.folder.images = [] as ImageInfo[];
    mockStore.currentImage.index = -1;
    mockStore.cache.preloaded = new Map();
    mockStore.thumbnailGeneration.allGenerated = true;

    // Reinstate the default success implementation: clearAllMocks() wipes
    // call history but a prior test's mockRejectedValue/mockResolvedValueOnce
    // queue could otherwise leak into the next test.
    mockLoadImageViaProtocol.mockReset();
    mockLoadImageViaProtocol.mockImplementation(async (path: string) => ({
      data: {
        path,
        src: `http://spica-img.localhost/x`,
        width: 10,
        height: 10,
        format: "jpg",
      },
      element: new Image(),
    }));

    // Clear console spy to avoid interference between tests
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _setPerfEnabledForTests(null);
    window.__PERF__ = [];
  });

  describe("preloadImage", () => {
    it("should preload full-resolution image successfully", async () => {
      _setPerfEnabledForTests(true);

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.preloadImage("/test/image.jpg");
      });

      expect(mockLoadImageViaProtocol).toHaveBeenCalledWith("/test/image.jpg");
      expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
        "/test/image.jpg",
        {
          path: "/test/image.jpg",
          src: "http://spica-img.localhost/x",
          width: 10,
          height: 10,
          format: "jpg",
        },
      );

      // preload:done perf event fires after the store is updated
      const events = window.__PERF__ ?? [];
      const doneEvent = events.find((e) => e.name === "preload:done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.type).toBe("event");
      expect(doneEvent?.detail).toEqual({ path: "/test/image.jpg" });
    });

    it("should not preload if image already in cache", async () => {
      // Setup cache with existing preloaded image
      mockStore.cache.preloaded.set("/test/image.jpg", mockImageData);

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.preloadImage("/test/image.jpg");
      });

      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();
      expect(mockStore.setPreloadedImage).not.toHaveBeenCalled();
    });

    it("should handle preload error gracefully", async () => {
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      mockLoadImageViaProtocol.mockRejectedValueOnce(
        new Error("Failed to load image"),
      );

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.preloadImage("/test/failed-image.jpg");
      });

      expect(mockLoadImageViaProtocol).toHaveBeenCalledWith(
        "/test/failed-image.jpg",
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Failed to preload image: failed-image.jpg",
        expect.any(Error),
      );

      // Should mark as error in cache with the exact error-entry shape
      expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
        "/test/failed-image.jpg",
        {
          path: "/test/failed-image.jpg",
          src: "",
          width: 0,
          height: 0,
          format: "error",
        },
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe("getPreloadQueue", () => {
    it("should return empty queue when no current image", () => {
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = -1;

      const { result } = renderHook(() => useImagePreloader());

      // Can't directly test getPreloadQueue as it's not exposed, but we can test startPreloading
      act(() => {
        result.current.startPreloading();
      });

      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();
    });

    it("should return empty queue when no images in folder", () => {
      mockStore.folder.images = [];
      mockStore.currentImage.index = 0;

      const { result } = renderHook(() => useImagePreloader());

      act(() => {
        result.current.startPreloading();
      });

      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();
    });

    it("should prioritize next and previous images", async () => {
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1; // Middle image

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.startPreloading();
      });

      // Should try to preload images around current index
      expect(mockLoadImageViaProtocol).toHaveBeenCalled();
    });

    it("should skip already preloaded images in queue", async () => {
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      // Mark first image as already preloaded
      mockStore.cache.preloaded.set(mockImageList[0].path, mockImageData);

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.startPreloading();
      });

      // Should not try to preload the already preloaded image
      const calls = mockLoadImageViaProtocol.mock.calls.map((call) => call[0]);
      expect(calls).not.toContain(mockImageList[0].path);
    });

    it("should not start if thumbnail generation is not complete", async () => {
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;
      mockStore.thumbnailGeneration.allGenerated = false; // Not complete

      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.startPreloading();
      });

      // Should log waiting message and not start preloading
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "Waiting for thumbnail generation to complete before preloading...",
      );
      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();

      consoleLogSpy.mockRestore();
    });
  });

  describe("cleanupCache", () => {
    it("should remove preloaded images outside preload range", () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      // Setup cache with many images
      const manyImages = Array.from({ length: 50 }, (_, i) =>
        createMockImageInfo(i),
      );

      mockStore.folder.images = manyImages as ImageInfo[];
      mockStore.currentImage.index = 25; // Middle position

      // Add preloaded images to cache that are outside range
      mockStore.cache.preloaded.set("/test/image0.jpg", mockImageData); // Far from current
      mockStore.cache.preloaded.set("/test/image49.jpg", mockImageData); // Far from current
      mockStore.cache.preloaded.set("/test/image25.jpg", mockImageData); // Current image

      const { result } = renderHook(() => useImagePreloader());

      act(() => {
        result.current.cleanupCache();
      });

      // Should remove images outside ±5 range
      expect(mockStore.removePreloadedImage).toHaveBeenCalledWith(
        "/test/image0.jpg",
      );
      expect(mockStore.removePreloadedImage).toHaveBeenCalledWith(
        "/test/image49.jpg",
      );
      // Should not remove current image
      expect(mockStore.removePreloadedImage).not.toHaveBeenCalledWith(
        "/test/image25.jpg",
      );

      consoleLogSpy.mockRestore();
    });

    it("should handle cleanup when no current image", () => {
      mockStore.currentImage.index = -1;

      const { result } = renderHook(() => useImagePreloader());

      act(() => {
        result.current.cleanupCache();
      });

      // Should not remove anything
      expect(mockStore.removePreloadedImage).not.toHaveBeenCalled();
    });
  });

  describe("startPreloading", () => {
    it("should process preload queue with concurrent limit", async () => {
      // Setup many images to exceed concurrent limit
      const manyImages = Array.from({ length: 10 }, (_, i) =>
        createMockImageInfo(i),
      );

      mockStore.folder.images = manyImages as ImageInfo[];
      mockStore.currentImage.index = 5;

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.startPreloading();
      });

      // Should have been called for multiple images
      expect(mockLoadImageViaProtocol).toHaveBeenCalled();
      expect(mockStore.setPreloadedImage).toHaveBeenCalled();
    });

    it("should handle partial failures in concurrent loading", async () => {
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      // Mock some successful and some failed loads: first call succeeds
      // (default implementation), second call fails.
      mockLoadImageViaProtocol.mockRejectedValueOnce(new Error("Failed"));

      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.startPreloading();
      });

      // Should have attempted loads for available images
      expect(mockLoadImageViaProtocol).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });
  });

  describe("useEffect integration", () => {
    it("should start preloading when current image changes", async () => {
      mockStore.folder.images = mockImageList as ImageInfo[];

      const { rerender } = renderHook(() => useImagePreloader());

      // Initially no current image
      mockStore.currentImage.index = -1;
      rerender();

      // Change to have current image
      mockStore.currentImage.index = 1;
      rerender();

      // Fast-forward timers to trigger delayed preloading
      await act(async () => {
        vi.runAllTimers();
      });

      expect(mockLoadImageViaProtocol).toHaveBeenCalled();
    });

    it("should delay preloading by 500ms", async () => {
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      renderHook(() => useImagePreloader());

      // Should not have called immediately
      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();

      // Fast-forward just before delay - still should not have called
      await act(async () => {
        vi.advanceTimersByTime(PRELOAD_DELAY_MS - 1);
        await Promise.resolve();
      });
      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();

      // Fast-forward remaining 1ms - now should have called
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(mockLoadImageViaProtocol).toHaveBeenCalled();
    });

    it("should cleanup timeout on unmount", () => {
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      const { unmount } = renderHook(() => useImagePreloader());

      unmount();

      // Fast-forward timers - should not call since unmounted
      act(() => {
        vi.runAllTimers();
      });

      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();
    });
  });

  describe("console logging", () => {
    it("should log successful preload", async () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.preloadImage("/test/subfolder/image.jpg");
      });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        "Preloaded full image: image.jpg",
      );

      consoleLogSpy.mockRestore();
    });

    it("should log cleanup operations", () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      mockStore.folder.images = [mockImageList[1]] as ImageInfo[]; // Only one image
      mockStore.currentImage.index = 0;

      // Add an image that will be cleaned up
      mockStore.cache.preloaded.set("/test/old-image.jpg", mockImageData);

      const { result } = renderHook(() => useImagePreloader());

      act(() => {
        result.current.cleanupCache();
      });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        "Cleaned from preload cache: old-image.jpg",
      );

      consoleLogSpy.mockRestore();
    });
  });
});
