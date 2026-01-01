import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ImageInfo } from "../../types";
import {
  THUMBNAIL_GENERATION_DEBOUNCE_MS,
  THUMBNAIL_GENERATION_INITIAL_RANGE,
  THUMBNAIL_SIZE,
  MAX_CONCURRENT_LOADS,
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
    thumbnails: new Map<
      string,
      { base64: string; width: number; height: number } | "error"
    >(),
  },
  setCachedThumbnail: vi.fn(),
  setThumbnailGeneration: vi.fn(),
};

// Mock getState to return fresh state
const mockGetState = vi.fn(() => ({
  folder: mockStore.folder,
  currentImage: mockStore.currentImage,
  cache: mockStore.cache,
  setCachedThumbnail: mockStore.setCachedThumbnail,
  setThumbnailGeneration: mockStore.setThumbnailGeneration,
}));

vi.mock("../../store", () => {
  const mockUseAppStore = vi.fn(() => mockStore);
  mockUseAppStore.getState = () => mockGetState();
  return {
    useAppStore: mockUseAppStore,
  };
});

import { useThumbnailGenerator } from "../useThumbnailGenerator";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

describe("useThumbnailGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.folder.images = [];
    mockStore.currentImage.index = -1;
    mockStore.cache.thumbnails = new Map();
    mockInvoke.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initialization", () => {
    it("should return startGeneration function", () => {
      const { result } = renderHook(() => useThumbnailGenerator());

      expect(result.current.startGeneration).toBeDefined();
      expect(typeof result.current.startGeneration).toBe("function");
    });

    it("should not start generation when no current image", () => {
      mockStore.folder.images = [createMockImageInfo(0)];
      mockStore.currentImage.index = -1;

      renderHook(() => useThumbnailGenerator());

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("should not start generation when no images in folder", () => {
      mockStore.folder.images = [];
      mockStore.currentImage.index = 0;

      renderHook(() => useThumbnailGenerator());

      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe("thumbnail generation with debounce", () => {
    it("should debounce thumbnail generation by 500ms", async () => {
      const images = Array.from({ length: 5 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStore.folder.images = images;
      mockStore.currentImage.index = 2;
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "get_cached_thumbnail") return null;
        if (cmd === "generate_thumbnail_with_dimensions") {
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        if (cmd === "set_cached_thumbnail") return null;
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      // Should not have called immediately
      expect(mockInvoke).not.toHaveBeenCalled();

      // Fast-forward just before debounce - still should not have called
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS - 1);
        await Promise.resolve();
      });
      expect(mockInvoke).not.toHaveBeenCalled();

      // Fast-forward remaining 1ms - now should start
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });

      expect(mockInvoke).toHaveBeenCalled();
    });

    it("should reset debounce on new navigation", async () => {
      const images = Array.from({ length: 5 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStore.folder.images = images;
      mockStore.currentImage.index = 2;
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "get_cached_thumbnail") return null;
        if (cmd === "generate_thumbnail_with_dimensions") {
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        if (cmd === "set_cached_thumbnail") return null;
        return null;
      });

      const { rerender } = renderHook(() => useThumbnailGenerator());

      // Advance 250ms (half of debounce)
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
      expect(mockInvoke).not.toHaveBeenCalled();

      // Navigate to different image - should reset debounce
      mockStore.currentImage.index = 3;
      rerender();

      // Advance another 250ms (not enough for new debounce)
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
      expect(mockInvoke).not.toHaveBeenCalled();

      // Complete the new debounce
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await Promise.resolve();
      });
      expect(mockInvoke).toHaveBeenCalled();
    });
  });

  describe("priority queue building", () => {
    it("should generate thumbnails in priority order (current → +1, -1, +2, -2, ...)", async () => {
      const images = Array.from({ length: 5 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStore.folder.images = images;
      mockStore.currentImage.index = 2;

      const callOrder: string[] = [];
      mockInvoke.mockImplementation(async (cmd, args) => {
        if (cmd === "generate_thumbnail_with_dimensions") {
          const typedArgs = args as { path: string };
          callOrder.push(typedArgs.path);
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      // Trigger generation
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await Promise.resolve();
        // Allow all async operations to complete
        await vi.runAllTimersAsync();
      });

      // Priority order from index 2: [2, 3, 1, 4, 0]
      expect(callOrder).toContain("/test/image2.jpg"); // Current image first
    });

    it("should limit initial queue to THUMBNAIL_GENERATION_INITIAL_RANGE", async () => {
      // Create more images than the initial range
      const images = Array.from({ length: 30 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStore.folder.images = images;
      mockStore.currentImage.index = 15;

      let generateCount = 0;
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "generate_thumbnail_with_dimensions") {
          generateCount++;
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        return null;
      });

      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      renderHook(() => useThumbnailGenerator());

      // Trigger generation
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await Promise.resolve();
      });

      // Initial queue should be limited to ±THUMBNAIL_GENERATION_INITIAL_RANGE
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining(`±${THUMBNAIL_GENERATION_INITIAL_RANGE}`),
      );

      consoleLogSpy.mockRestore();
    });

    it("should skip already cached thumbnails in queue", async () => {
      const images = Array.from({ length: 5 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStore.folder.images = images;
      mockStore.currentImage.index = 2;

      // Pre-cache some thumbnails
      mockStore.cache.thumbnails.set("/test/image2.jpg", {
        base64: "cached",
        width: 800,
        height: 600,
      });
      mockStore.cache.thumbnails.set("/test/image3.jpg", {
        base64: "cached",
        width: 800,
        height: 600,
      });

      // Update mockGetState to return the updated cache
      mockGetState.mockReturnValue({
        folder: mockStore.folder,
        currentImage: mockStore.currentImage,
        cache: mockStore.cache,
        setCachedThumbnail: mockStore.setCachedThumbnail,
        setThumbnailGeneration: mockStore.setThumbnailGeneration,
      });

      const generatedPaths: string[] = [];
      mockInvoke.mockImplementation(async (cmd, args) => {
        if (cmd === "generate_thumbnail_with_dimensions") {
          const typedArgs = args as { path: string };
          generatedPaths.push(typedArgs.path);
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      // Trigger generation
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      // Should not generate for cached images
      expect(generatedPaths).not.toContain("/test/image2.jpg");
      expect(generatedPaths).not.toContain("/test/image3.jpg");
    });
  });

  describe("concurrent loading", () => {
    it("should process thumbnails with MAX_CONCURRENT_LOADS limit", async () => {
      const images = Array.from({ length: 10 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStore.folder.images = images;
      mockStore.currentImage.index = 5;

      let concurrentCalls = 0;
      let maxConcurrentCalls = 0;

      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "generate_thumbnail_with_dimensions") {
          concurrentCalls++;
          maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
          // Simulate some processing time
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrentCalls--;
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      // Trigger generation
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      // Max concurrent calls should not exceed MAX_CONCURRENT_LOADS
      expect(maxConcurrentCalls).toBeLessThanOrEqual(MAX_CONCURRENT_LOADS);
    });
  });

  describe("backend cache handling", () => {
    it("should use cached thumbnail from backend if available with dimensions", async () => {
      const images = [createMockImageInfo(0)];
      mockStore.folder.images = images;
      mockStore.currentImage.index = 0;

      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "get_cached_thumbnail") {
          // Return cached thumbnail with dimensions
          return ["cachedBase64", 1920, 1080];
        }
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      // Trigger generation
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      expect(mockStore.setCachedThumbnail).toHaveBeenCalledWith(
        "/test/image0.jpg",
        { base64: "cachedBase64", width: 1920, height: 1080 },
      );
      // Should not call generate_thumbnail_with_dimensions
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "generate_thumbnail_with_dimensions",
        expect.anything(),
      );
    });

    it("should regenerate thumbnail if backend cache lacks dimensions", async () => {
      const images = [createMockImageInfo(0)];
      mockStore.folder.images = images;
      mockStore.currentImage.index = 0;

      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "get_cached_thumbnail") {
          // Return cached thumbnail without dimensions
          return ["cachedBase64", null, null];
        }
        if (cmd === "generate_thumbnail_with_dimensions") {
          return {
            thumbnail_base64: "newBase64",
            original_width: 800,
            original_height: 600,
          };
        }
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      // Trigger generation
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      // Should have regenerated the thumbnail
      expect(mockInvoke).toHaveBeenCalledWith(
        "generate_thumbnail_with_dimensions",
        {
          path: "/test/image0.jpg",
          size: THUMBNAIL_SIZE,
        },
      );
    });
  });

  describe("error handling", () => {
    it("should cache error as 'error' string to prevent retry", async () => {
      const images = [createMockImageInfo(0)];
      mockStore.folder.images = images;
      mockStore.currentImage.index = 0;

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "get_cached_thumbnail") {
          return null;
        }
        if (cmd === "generate_thumbnail_with_dimensions") {
          throw new Error("Failed to generate thumbnail");
        }
        if (cmd === "set_cached_thumbnail") {
          return null;
        }
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      // Trigger generation
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      // Should cache error in backend
      expect(mockInvoke).toHaveBeenCalledWith("set_cached_thumbnail", {
        path: "/test/image0.jpg",
        thumbnail: "error",
        size: THUMBNAIL_SIZE,
        width: null,
        height: null,
      });

      // Should cache error in frontend
      expect(mockStore.setCachedThumbnail).toHaveBeenCalledWith(
        "/test/image0.jpg",
        "error",
      );

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to generate thumbnail"),
        expect.any(Error),
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe("abort controller handling", () => {
    it("should abort previous generation when navigation changes", async () => {
      const images = Array.from({ length: 10 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStore.folder.images = images;
      mockStore.currentImage.index = 2;

      let abortedPaths: string[] = [];
      mockInvoke.mockImplementation(async (cmd, args) => {
        if (cmd === "generate_thumbnail_with_dimensions") {
          // Simulate slow generation
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        return null;
      });

      const { rerender } = renderHook(() => useThumbnailGenerator());

      // Start generation
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await Promise.resolve();
      });

      // Navigate to different image before generation completes
      mockStore.currentImage.index = 5;
      rerender();

      // The hook should have aborted previous generation
      // and started new one after debounce
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await Promise.resolve();
      });

      // Previous generation should have been aborted
      // New generation should be in progress
      expect(mockInvoke).toHaveBeenCalled();
    });

    it("should cleanup on unmount", async () => {
      const images = Array.from({ length: 5 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStore.folder.images = images;
      mockStore.currentImage.index = 2;

      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "generate_thumbnail_with_dimensions") {
          // Simulate slow generation
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        return null;
      });

      const { unmount } = renderHook(() => useThumbnailGenerator());

      // Unmount before debounce completes
      unmount();

      // Fast-forward past debounce
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS + 100);
        await Promise.resolve();
      });

      // No thumbnails should have been generated
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "generate_thumbnail_with_dimensions",
        expect.anything(),
      );
    });
  });

  describe("queue expansion to full range", () => {
    it("should expand queue to full range after initial queue completes", async () => {
      const images = Array.from({ length: 30 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStore.folder.images = images;
      mockStore.currentImage.index = 15;

      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "get_cached_thumbnail") return null;
        if (cmd === "generate_thumbnail_with_dimensions") {
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        if (cmd === "set_cached_thumbnail") return null;
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      // Trigger initial generation
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      // Should have expanded to full range
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Expanding thumbnail queue"),
      );

      consoleLogSpy.mockRestore();
    });

    it("should not expand if all thumbnails already generated", async () => {
      const images = Array.from({ length: 5 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStore.folder.images = images;
      mockStore.currentImage.index = 2;

      // Pre-cache all thumbnails
      for (const img of images) {
        mockStore.cache.thumbnails.set(img.path, {
          base64: "cached",
          width: 800,
          height: 600,
        });
      }

      mockGetState.mockReturnValue({
        folder: mockStore.folder,
        currentImage: mockStore.currentImage,
        cache: mockStore.cache,
        setCachedThumbnail: mockStore.setCachedThumbnail,
        setThumbnailGeneration: mockStore.setThumbnailGeneration,
      });

      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      renderHook(() => useThumbnailGenerator());

      // Trigger generation
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      // Should set allGenerated to true since all are cached
      expect(mockStore.setThumbnailGeneration).toHaveBeenCalledWith({
        allGenerated: true,
        isGenerating: false,
      });

      consoleLogSpy.mockRestore();
    });
  });

  describe("setThumbnailGeneration state updates", () => {
    it("should set isGenerating to true when starting", async () => {
      const images = [createMockImageInfo(0)];
      mockStore.folder.images = images;
      mockStore.currentImage.index = 0;

      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "get_cached_thumbnail") return null;
        if (cmd === "generate_thumbnail_with_dimensions") {
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        if (cmd === "set_cached_thumbnail") return null;
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await Promise.resolve();
      });

      expect(mockStore.setThumbnailGeneration).toHaveBeenCalledWith({
        isGenerating: true,
        allGenerated: false,
      });
    });

    it("should update currentGeneratingPath during generation", async () => {
      const images = [createMockImageInfo(0)];
      mockStore.folder.images = images;
      mockStore.currentImage.index = 0;

      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "get_cached_thumbnail") return null;
        if (cmd === "generate_thumbnail_with_dimensions") {
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        if (cmd === "set_cached_thumbnail") return null;
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      expect(mockStore.setThumbnailGeneration).toHaveBeenCalledWith({
        currentGeneratingPath: "/test/image0.jpg",
      });
    });

    it("should set isGenerating to false when complete", async () => {
      const images = [createMockImageInfo(0)];
      mockStore.folder.images = images;
      mockStore.currentImage.index = 0;

      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "get_cached_thumbnail") return null;
        if (cmd === "generate_thumbnail_with_dimensions") {
          return {
            thumbnail_base64: "base64data",
            original_width: 800,
            original_height: 600,
          };
        }
        if (cmd === "set_cached_thumbnail") return null;
        return null;
      });

      renderHook(() => useThumbnailGenerator());

      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_GENERATION_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      expect(mockStore.setThumbnailGeneration).toHaveBeenCalledWith({
        isGenerating: false,
        currentGeneratingPath: null,
      });
    });
  });
});
