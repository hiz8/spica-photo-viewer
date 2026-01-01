import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { mockImageData, mockImageList } from "../../utils/testUtils";
import type { ImageInfo } from "../../types";
import { PRELOAD_DELAY_MS } from "../../constants/timing";

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

// Type guard for invoke parameters with path
function hasPath(arg: unknown): arg is { path: string } {
  return (
    typeof arg === "object" &&
    arg !== null &&
    "path" in arg &&
    typeof (arg as Record<string, unknown>).path === "string"
  );
}

// Mock the invoke function before importing
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock the store
const mockStore = {
  folder: {
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
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

describe("useImagePreloader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.folder.images = [] as ImageInfo[];
    mockStore.currentImage.index = -1;
    mockStore.cache.preloaded = new Map();
    mockStore.thumbnailGeneration.allGenerated = true;
    mockInvoke.mockClear();

    // Clear console spy to avoid interference between tests
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("preloadImage", () => {
    it("should preload full-resolution image successfully", async () => {
      mockInvoke.mockResolvedValue(mockImageData);

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.preloadImage("/test/image.jpg");
      });

      expect(mockInvoke).toHaveBeenCalledWith("load_image", {
        path: "/test/image.jpg",
      });
      expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
        "/test/image.jpg",
        mockImageData,
      );
    });

    it("should not preload if image already in cache", async () => {
      // Setup cache with existing preloaded image
      mockStore.cache.preloaded.set("/test/image.jpg", mockImageData);

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.preloadImage("/test/image.jpg");
      });

      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockStore.setPreloadedImage).not.toHaveBeenCalled();
    });

    it("should handle preload error gracefully", async () => {
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      mockInvoke.mockRejectedValue(new Error("Failed to load image"));

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.preloadImage("/test/failed-image.jpg");
      });

      expect(mockInvoke).toHaveBeenCalledWith("load_image", {
        path: "/test/failed-image.jpg",
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Failed to preload image: failed-image.jpg",
        expect.any(Error),
      );

      // Should mark as error in cache
      expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
        "/test/failed-image.jpg",
        expect.objectContaining({
          format: "error",
        }),
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

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("should return empty queue when no images in folder", () => {
      mockStore.folder.images = [];
      mockStore.currentImage.index = 0;

      const { result } = renderHook(() => useImagePreloader());

      act(() => {
        result.current.startPreloading();
      });

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("should prioritize next and previous images", async () => {
      const mockThumbnail = "thumbnail_data";
      mockInvoke.mockResolvedValue(mockThumbnail);
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1; // Middle image

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.startPreloading();
      });

      // Should try to preload images around current index
      expect(mockInvoke).toHaveBeenCalled();
    });

    it("should skip already preloaded images in queue", async () => {
      mockInvoke.mockResolvedValue(mockImageData);
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      // Mark first image as already preloaded
      mockStore.cache.preloaded.set(mockImageList[0].path, mockImageData);

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.startPreloading();
      });

      // Should not try to preload the already preloaded image
      const calls = mockInvoke.mock.calls.map((call) =>
        hasPath(call[1]) ? call[1].path : undefined,
      );
      expect(calls).not.toContain(mockImageList[0].path);
    });

    it("should not start if thumbnail generation is not complete", async () => {
      mockInvoke.mockResolvedValue(mockImageData);
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
      expect(mockInvoke).not.toHaveBeenCalled();

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
      mockInvoke.mockResolvedValue(mockImageData);

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
      expect(mockInvoke).toHaveBeenCalled();
      expect(mockStore.setPreloadedImage).toHaveBeenCalled();
    });

    it("should handle partial failures in concurrent loading", async () => {
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      // Mock some successful and some failed loads
      mockInvoke
        .mockResolvedValueOnce(mockImageData) // First call succeeds
        .mockRejectedValueOnce(new Error("Failed")); // Second call fails

      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.startPreloading();
      });

      // Should have attempted loads for available images
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });
  });

  describe("useEffect integration", () => {
    it("should start preloading when current image changes", async () => {
      const mockThumbnail = "thumbnail_data";
      mockInvoke.mockResolvedValue(mockThumbnail);
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

      expect(mockInvoke).toHaveBeenCalled();
    });

    it("should delay preloading by 500ms", async () => {
      mockInvoke.mockResolvedValue(mockImageData);
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      renderHook(() => useImagePreloader());

      // Should not have called immediately
      expect(mockInvoke).not.toHaveBeenCalled();

      // Fast-forward just before delay - still should not have called
      await act(async () => {
        vi.advanceTimersByTime(PRELOAD_DELAY_MS - 1);
        await Promise.resolve();
      });
      expect(mockInvoke).not.toHaveBeenCalled();

      // Fast-forward remaining 1ms - now should have called
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(mockInvoke).toHaveBeenCalled();
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

      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe("console logging", () => {
    it("should log successful preload", async () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});
      mockInvoke.mockResolvedValue(mockImageData);

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
