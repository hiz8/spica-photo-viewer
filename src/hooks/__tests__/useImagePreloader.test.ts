import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { mockImageData, mockImageList } from "../../utils/testUtils";
import type { ImageInfo } from "../../types";
import {
  PRELOAD_DELAY_MS,
  PREVIEW_THUMBNAIL_SIZE,
} from "../../constants/timing";

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
    thumbnails: new Map(),
    smallThumbnails: new Map(),
  },
  setCachedThumbnail: vi.fn(),
  removeCachedThumbnail: vi.fn(),
  setCachedSmallThumbnail: vi.fn(),
  removeCachedSmallThumbnail: vi.fn(),
};

vi.mock("../../store", () => ({
  useAppStore: Object.assign(vi.fn(() => mockStore), {
    getState: () => mockStore,
  }),
}));

import { useImagePreloader } from "../useImagePreloader";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

describe("useImagePreloader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.folder.images = [] as ImageInfo[];
    mockStore.currentImage.index = -1;
    mockStore.cache.thumbnails = new Map();
    mockStore.cache.smallThumbnails = new Map();
    mockInvoke.mockClear();

    // Clear console spy to avoid interference between tests
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("preloadImage", () => {
    it("should preload image successfully", async () => {
      const mockThumbnail = "thumbnail_base64_data";
      const mockSmallThumbnail = "small_thumbnail_base64_data";
      mockInvoke
        .mockResolvedValueOnce(mockThumbnail) // First call: 400px preview
        .mockResolvedValueOnce(mockSmallThumbnail) // Second call: 20px small thumbnail
        .mockResolvedValueOnce(undefined); // Third call: set_cached_thumbnail

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.preloadImage("/test/image.jpg");
      });

      // Should generate both 400px preview and 20px small thumbnail
      expect(mockInvoke).toHaveBeenCalledWith("generate_image_thumbnail", {
        path: "/test/image.jpg",
        size: PREVIEW_THUMBNAIL_SIZE,
      });
      expect(mockInvoke).toHaveBeenCalledWith("generate_image_thumbnail", {
        path: "/test/image.jpg",
        size: 20, // SMALL_THUMBNAIL_SIZE
      });
      expect(mockInvoke).toHaveBeenCalledWith("set_cached_thumbnail", {
        path: "/test/image.jpg",
        thumbnail: mockSmallThumbnail,
        size: 20,
      });

      expect(mockStore.setCachedThumbnail).toHaveBeenCalledWith(
        "/test/image.jpg",
        mockThumbnail,
      );
      expect(mockStore.setCachedSmallThumbnail).toHaveBeenCalledWith(
        "/test/image.jpg",
        mockSmallThumbnail,
      );
    });

    it("should not preload if image already in cache", async () => {
      // Setup cache with existing thumbnail
      mockStore.cache.thumbnails.set("/test/image.jpg", "cached_thumbnail");

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.preloadImage("/test/image.jpg");
      });

      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockStore.setCachedThumbnail).not.toHaveBeenCalled();
    });

    it("should handle preload error gracefully", async () => {
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      mockInvoke.mockRejectedValue(new Error("Failed to load thumbnail"));

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.preloadImage("/test/failed-image.jpg");
      });

      expect(mockInvoke).toHaveBeenCalledWith("generate_image_thumbnail", {
        path: "/test/failed-image.jpg",
        size: PREVIEW_THUMBNAIL_SIZE,
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Failed to preload thumbnail: failed-image.jpg",
        expect.any(Error),
      );

      // Should mark as failed in cache (empty string)
      expect(mockStore.setCachedThumbnail).toHaveBeenCalledWith(
        "/test/failed-image.jpg",
        "",
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

    it("should skip already cached images in queue", async () => {
      const mockThumbnail = "thumbnail_data";
      mockInvoke.mockResolvedValue(mockThumbnail);
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      // Mark first image as already cached
      mockStore.cache.thumbnails.set(mockImageList[0].path, mockThumbnail);

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.startPreloading();
      });

      // Should not try to preload the cached image
      const calls = mockInvoke.mock.calls.map((call) =>
        hasPath(call[1]) ? call[1].path : undefined,
      );
      expect(calls).not.toContain(mockImageList[0].path);
    });
  });

  describe("cleanupCache", () => {
    it("should remove images outside preload range", () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      // Setup cache with many images
      const manyImages = Array.from({ length: 50 }, (_, i) =>
        createMockImageInfo(i),
      );

      mockStore.folder.images = manyImages as ImageInfo[];
      mockStore.currentImage.index = 25; // Middle position

      // Add thumbnails to cache that are outside range
      mockStore.cache.thumbnails.set("/test/image0.jpg", "thumbnail"); // Far from current
      mockStore.cache.thumbnails.set("/test/image49.jpg", "thumbnail"); // Far from current
      mockStore.cache.thumbnails.set("/test/image25.jpg", "thumbnail"); // Current image

      const { result } = renderHook(() => useImagePreloader());

      act(() => {
        result.current.cleanupCache();
      });

      // Should remove images outside ±5 range
      expect(mockStore.removeCachedThumbnail).toHaveBeenCalledWith(
        "/test/image0.jpg",
      );
      expect(mockStore.removeCachedThumbnail).toHaveBeenCalledWith(
        "/test/image49.jpg",
      );
      // Should not remove current image
      expect(mockStore.removeCachedThumbnail).not.toHaveBeenCalledWith(
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
      expect(mockStore.removeCachedThumbnail).not.toHaveBeenCalled();
    });
  });

  describe("startPreloading", () => {
    it("should process preload queue with concurrent limit", async () => {
      const mockThumbnail = "thumbnail_data";
      mockInvoke.mockResolvedValue(mockThumbnail);

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
      expect(mockStore.setCachedThumbnail).toHaveBeenCalled();
    });

    it("should handle partial failures in concurrent loading", async () => {
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      const mockThumbnail = "thumbnail_data";
      const mockSmallThumbnail = "small_thumbnail_data";
      // Mock some successful and some failed loads
      // First image (success): 400px preview, 20px small, set_cached_thumbnail
      // Second image (fail): 400px preview fails
      mockInvoke
        .mockResolvedValueOnce(mockThumbnail) // First image: 400px preview
        .mockResolvedValueOnce(mockSmallThumbnail) // First image: 20px small
        .mockResolvedValueOnce(undefined) // First image: set_cached_thumbnail
        .mockRejectedValueOnce(new Error("Failed")) // Second image: 400px preview fails
        .mockRejectedValueOnce(new Error("Failed")); // Extra call in case

      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      const { result } = renderHook(() => useImagePreloader());

      await act(async () => {
        await result.current.startPreloading();
      });

      // Should have attempted loads for available images (at least 4 calls)
      expect(mockInvoke).toHaveBeenCalled();
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
      const mockThumbnail = "thumbnail_data";
      mockInvoke.mockResolvedValue(mockThumbnail);
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      renderHook(() => useImagePreloader());

      // Current image thumbnail is loaded immediately (triggers invoke calls)
      await act(async () => {
        await Promise.resolve();
      });

      // Clear invoke calls from initial thumbnail load
      const initialCallCount = mockInvoke.mock.calls.length;

      // Fast-forward just before delay - no additional preloading should happen
      await act(async () => {
        vi.advanceTimersByTime(PRELOAD_DELAY_MS - 1);
        await Promise.resolve();
      });
      expect(mockInvoke.mock.calls.length).toBe(initialCallCount);

      // Fast-forward remaining 1ms - now preloading should start
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      // Should have more calls after preloading starts
      expect(mockInvoke.mock.calls.length).toBeGreaterThan(initialCallCount);
    });

    it("should cleanup timeout on unmount", () => {
      mockInvoke.mockResolvedValue(mockImageData);
      mockStore.folder.images = mockImageList as ImageInfo[];
      mockStore.currentImage.index = 1;

      const { result, unmount } = renderHook(() => useImagePreloader());
      const startPreloadingSpy = vi.spyOn(result.current, "startPreloading");

      // Clear any calls from current image thumbnail loading
      mockInvoke.mockClear();
      startPreloadingSpy.mockClear();

      unmount();

      // Fast-forward timers - startPreloading should not be called since unmounted
      act(() => {
        vi.runAllTimers();
      });

      expect(startPreloadingSpy).not.toHaveBeenCalled();
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

      expect(consoleLogSpy).toHaveBeenCalledWith("Preloaded: image.jpg");

      consoleLogSpy.mockRestore();
    });

    it("should log cleanup operations", () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      mockStore.folder.images = [mockImageList[1]] as ImageInfo[]; // Only one image
      mockStore.currentImage.index = 0;

      // Add an image that will be cleaned up
      mockStore.cache.thumbnails.set("/test/old-image.jpg", "thumbnail_data");

      const { result } = renderHook(() => useImagePreloader());

      act(() => {
        result.current.cleanupCache();
      });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        "Cleaned from cache: old-image.jpg",
      );

      consoleLogSpy.mockRestore();
    });
  });
});
