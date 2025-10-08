import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockImageData, mockImageList } from "../../utils/testUtils";

// Mock the invoke function before importing the store
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { useAppStore } from "../index";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

describe("AppStore", () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useAppStore.setState({
      currentImage: {
        path: "",
        index: -1,
        data: null,
        error: null,
      },
      folder: {
        path: "",
        images: [],
        sortOrder: "name",
      },
      view: {
        zoom: 100,
        panX: 0,
        panY: 0,
        isFullscreen: false,
        isMaximized: false,
        thumbnailOpacity: 0.5,
      },
      cache: {
        thumbnails: new Map(),
        preloaded: new Map(),
        imageViewStates: new Map(),
      },
      ui: {
        isLoading: false,
        showAbout: false,
        isDragOver: false,
        error: null,
      },
    });
    vi.clearAllMocks();
  });

  describe("Initial State", () => {
    it("should have correct initial state", () => {
      const state = useAppStore.getState();

      expect(state.currentImage.path).toBe("");
      expect(state.currentImage.index).toBe(-1);
      expect(state.currentImage.data).toBeNull();
      expect(state.currentImage.error).toBeNull();

      expect(state.folder.path).toBe("");
      expect(state.folder.images).toEqual([]);
      expect(state.folder.sortOrder).toBe("name");

      expect(state.view.zoom).toBe(100);
      expect(state.view.panX).toBe(0);
      expect(state.view.panY).toBe(0);
      expect(state.view.isFullscreen).toBe(false);
      expect(state.view.thumbnailOpacity).toBe(0.5);
    });
  });

  describe("setCurrentImage", () => {
    it("should set current image path and index", () => {
      const { setCurrentImage } = useAppStore.getState();

      setCurrentImage("/test/image.jpg", 5);

      const state = useAppStore.getState();
      expect(state.currentImage.path).toBe("/test/image.jpg");
      expect(state.currentImage.index).toBe(5);
      expect(state.currentImage.error).toBeNull();
    });

    it("should reset error when setting new image", () => {
      const { setCurrentImage, setImageError } = useAppStore.getState();

      // Set an error first
      setImageError(new Error("Test error"));
      expect(useAppStore.getState().currentImage.error).not.toBeNull();

      // Setting new image should clear error
      setCurrentImage("/test/new-image.jpg", 0);
      expect(useAppStore.getState().currentImage.error).toBeNull();
    });


    it("should clear image data when setting new image", () => {
      const { setCurrentImage, setImageData } = useAppStore.getState();

      // Set initial image with data
      setCurrentImage("/test/image1.jpg", 0);
      setImageData(mockImageData);

      const stateWithData = useAppStore.getState();
      expect(stateWithData.currentImage.data).not.toBeNull();
      expect(stateWithData.currentImage.path).toBe("/test/image1.jpg");

      // Setting new image should clear data
      setCurrentImage("/test/image2.jpg", 1);

      const stateAfter = useAppStore.getState();
      expect(stateAfter.currentImage.path).toBe("/test/image2.jpg");
      expect(stateAfter.currentImage.index).toBe(1);
      expect(stateAfter.currentImage.data).toBeNull();
    });
  });

  describe("setFolderImages", () => {
    it("should set folder path and images", () => {
      const { setFolderImages } = useAppStore.getState();

      setFolderImages("/test/folder", mockImageList);

      const state = useAppStore.getState();
      expect(state.folder.path).toBe("/test/folder");
      expect(state.folder.images).toEqual(mockImageList);
    });

    it("should clear imageViewStates when changing to a different folder", () => {
      const {
        setFolderImages,
        navigateToImage,
        setZoom,
        setPan,
        setCurrentImage,
      } = useAppStore.getState();

      // Set up first folder with images and view states
      setFolderImages("/test/folder1", mockImageList);
      setCurrentImage(mockImageList[0].path, 0);
      setZoom(150);
      setPan(100, 50);

      // Navigate to save the state
      navigateToImage(1);

      // Verify state was saved
      let state = useAppStore.getState();
      expect(state.cache.imageViewStates.has(mockImageList[0].path)).toBe(true);

      // Change to a different folder
      setFolderImages("/test/folder2", mockImageList);

      // imageViewStates should be cleared
      state = useAppStore.getState();
      expect(state.cache.imageViewStates.size).toBe(0);
    });

    it("should preserve imageViewStates when setting the same folder", () => {
      const {
        setFolderImages,
        navigateToImage,
        setZoom,
        setPan,
        setCurrentImage,
      } = useAppStore.getState();

      // Set up folder with images and view states
      setFolderImages("/test/folder", mockImageList);
      setCurrentImage(mockImageList[0].path, 0);
      setZoom(150);
      setPan(100, 50);

      // Navigate to save the state
      navigateToImage(1);

      // Verify state was saved
      let state = useAppStore.getState();
      expect(state.cache.imageViewStates.has(mockImageList[0].path)).toBe(true);
      const savedState = state.cache.imageViewStates.get(mockImageList[0].path);

      // Set the same folder again (e.g., refresh)
      setFolderImages("/test/folder", mockImageList);

      // imageViewStates should be preserved
      state = useAppStore.getState();
      expect(state.cache.imageViewStates.has(mockImageList[0].path)).toBe(true);
      expect(state.cache.imageViewStates.get(mockImageList[0].path)).toEqual(
        savedState,
      );
    });
  });

  describe("setZoom", () => {
    it("should set zoom within valid range (10-2000)", () => {
      const { setZoom } = useAppStore.getState();

      setZoom(150);
      expect(useAppStore.getState().view.zoom).toBe(150);
    });

    it("should clamp zoom to minimum 10", () => {
      const { setZoom } = useAppStore.getState();

      setZoom(5);
      expect(useAppStore.getState().view.zoom).toBe(10);
    });

    it("should clamp zoom to maximum 2000", () => {
      const { setZoom } = useAppStore.getState();

      setZoom(3000);
      expect(useAppStore.getState().view.zoom).toBe(2000);
    });

    it("should reset pan when setting zoom", () => {
      const { setPan, setZoom } = useAppStore.getState();

      // Set some pan values
      setPan(100, 50);
      expect(useAppStore.getState().view.panX).toBe(100);
      expect(useAppStore.getState().view.panY).toBe(50);

      // Setting zoom should reset pan
      setZoom(200);
      expect(useAppStore.getState().view.panX).toBe(0);
      expect(useAppStore.getState().view.panY).toBe(0);
    });
  });

  describe("navigateToImage", () => {
    beforeEach(() => {
      const { setFolderImages } = useAppStore.getState();
      setFolderImages("/test", mockImageList);
    });

    it("should navigate to valid image index", () => {
      const { navigateToImage } = useAppStore.getState();

      navigateToImage(1);

      const state = useAppStore.getState();
      expect(state.currentImage.path).toBe(mockImageList[1].path);
      expect(state.currentImage.index).toBe(1);
      expect(state.currentImage.data).toBeNull();
      expect(state.currentImage.error).toBeNull();
    });

    it("should reset view when navigating to new image without saved state", () => {
      const { navigateToImage, setZoom, setPan } = useAppStore.getState();

      // Set some view state
      setZoom(200);
      setPan(50, 25);

      navigateToImage(0);

      const state = useAppStore.getState();
      expect(state.view.zoom).toBe(100);
      expect(state.view.panX).toBe(0);
      expect(state.view.panY).toBe(0);
    });

    it("should save current image view state when navigating away", () => {
      const { navigateToImage, setZoom, setPan, setCurrentImage } =
        useAppStore.getState();

      // Set current image
      setCurrentImage(mockImageList[0].path, 0);

      // Set some view state
      setZoom(150);
      setPan(100, 50);

      // Navigate to another image
      navigateToImage(1);

      // Check that the view state was saved for the first image
      const state = useAppStore.getState();
      const savedState = state.cache.imageViewStates.get(mockImageList[0].path);
      expect(savedState).toBeDefined();
      expect(savedState?.zoom).toBe(150);
      expect(savedState?.panX).toBe(100);
      expect(savedState?.panY).toBe(50);
    });

    it("should restore saved view state when navigating back to previously viewed image", () => {
      const { navigateToImage, setZoom, setPan, setCurrentImage } =
        useAppStore.getState();

      // Set current image and view state
      setCurrentImage(mockImageList[0].path, 0);
      setZoom(180);
      setPan(75, 40);

      // Navigate to another image
      navigateToImage(1);

      // Navigate back to the first image
      navigateToImage(0);

      // View state should be restored
      const state = useAppStore.getState();
      expect(state.view.zoom).toBe(180);
      expect(state.view.panX).toBe(75);
      expect(state.view.panY).toBe(40);
    });

    it("should handle multiple image navigations and preserve individual states", () => {
      const { navigateToImage, setZoom, setPan, setCurrentImage } =
        useAppStore.getState();

      // Image 0: zoom 120, pan (10, 20)
      setCurrentImage(mockImageList[0].path, 0);
      setZoom(120);
      setPan(10, 20);

      // Navigate to image 1: zoom 150, pan (30, 40)
      navigateToImage(1);
      setZoom(150);
      setPan(30, 40);

      // Navigate to image 2: zoom 200, pan (50, 60)
      navigateToImage(2);
      setZoom(200);
      setPan(50, 60);

      // Go back to image 0
      navigateToImage(0);
      let state = useAppStore.getState();
      expect(state.view.zoom).toBe(120);
      expect(state.view.panX).toBe(10);
      expect(state.view.panY).toBe(20);

      // Go to image 1
      navigateToImage(1);
      state = useAppStore.getState();
      expect(state.view.zoom).toBe(150);
      expect(state.view.panX).toBe(30);
      expect(state.view.panY).toBe(40);

      // Go to image 2
      navigateToImage(2);
      state = useAppStore.getState();
      expect(state.view.zoom).toBe(200);
      expect(state.view.panX).toBe(50);
      expect(state.view.panY).toBe(60);
    });

    it("should not navigate to invalid index", () => {
      const { navigateToImage } = useAppStore.getState();
      const initialState = useAppStore.getState().currentImage;

      navigateToImage(-1);
      expect(useAppStore.getState().currentImage).toEqual(initialState);

      navigateToImage(999);
      expect(useAppStore.getState().currentImage).toEqual(initialState);
    });
  });

  describe("navigateNext", () => {
    beforeEach(() => {
      const { setFolderImages, setCurrentImage } = useAppStore.getState();
      setFolderImages("/test", mockImageList);
      setCurrentImage(mockImageList[0].path, 0);
    });

    it("should navigate to next image", () => {
      const { navigateNext } = useAppStore.getState();

      navigateNext();

      const state = useAppStore.getState();
      expect(state.currentImage.index).toBe(1);
      expect(state.currentImage.path).toBe(mockImageList[1].path);
    });

    it("should not navigate beyond last image", () => {
      const { navigateNext, setCurrentImage } = useAppStore.getState();

      // Go to last image
      setCurrentImage(mockImageList[2].path, 2);

      navigateNext();

      // Should stay at last image
      expect(useAppStore.getState().currentImage.index).toBe(2);
    });

    it("should skip corrupted images", () => {
      const { navigateNext, setPreloadedImage } = useAppStore.getState();

      // Mark second image as corrupted
      setPreloadedImage(mockImageList[1].path, {
        ...mockImageData,
        path: mockImageList[1].path,
        format: "error",
      });

      navigateNext();

      // Should skip to third image
      const state = useAppStore.getState();
      expect(state.currentImage.index).toBe(2);
      expect(state.currentImage.path).toBe(mockImageList[2].path);
    });
  });

  describe("navigatePrevious", () => {
    beforeEach(() => {
      const { setFolderImages, setCurrentImage } = useAppStore.getState();
      setFolderImages("/test", mockImageList);
      setCurrentImage(mockImageList[2].path, 2);
    });

    it("should navigate to previous image", () => {
      const { navigatePrevious } = useAppStore.getState();

      navigatePrevious();

      const state = useAppStore.getState();
      expect(state.currentImage.index).toBe(1);
      expect(state.currentImage.path).toBe(mockImageList[1].path);
    });

    it("should not navigate before first image", () => {
      const { navigatePrevious, setCurrentImage } = useAppStore.getState();

      // Go to first image
      setCurrentImage(mockImageList[0].path, 0);

      navigatePrevious();

      // Should stay at first image
      expect(useAppStore.getState().currentImage.index).toBe(0);
    });

    it("should skip corrupted images", () => {
      const { navigatePrevious, setPreloadedImage } = useAppStore.getState();

      // Mark second image as corrupted
      setPreloadedImage(mockImageList[1].path, {
        ...mockImageData,
        path: mockImageList[1].path,
        format: "error",
      });

      navigatePrevious();

      // Should skip to first image
      const state = useAppStore.getState();
      expect(state.currentImage.index).toBe(0);
      expect(state.currentImage.path).toBe(mockImageList[0].path);
    });
  });

  describe("zoom operations", () => {
    it("should zoom in correctly", () => {
      const { zoomIn } = useAppStore.getState();

      zoomIn();

      expect(useAppStore.getState().view.zoom).toBe(120); // 100 * 1.2
    });

    it("should zoom out correctly", () => {
      const { zoomOut, setZoom } = useAppStore.getState();

      setZoom(120);
      zoomOut();

      expect(useAppStore.getState().view.zoom).toBe(100); // 120 / 1.2
    });

    it("should respect zoom limits when zooming in", () => {
      const { zoomIn, setZoom } = useAppStore.getState();

      setZoom(1900);
      zoomIn();

      expect(useAppStore.getState().view.zoom).toBe(2000); // Clamped to max
    });

    it("should respect zoom limits when zooming out", () => {
      const { zoomOut, setZoom } = useAppStore.getState();

      setZoom(12);
      zoomOut();

      expect(useAppStore.getState().view.zoom).toBe(10); // Clamped to min
    });

    it("should reset zoom correctly", () => {
      const { resetZoom, setZoom, setPan } = useAppStore.getState();

      setZoom(200);
      setPan(50, 25);

      resetZoom();

      const state = useAppStore.getState();
      expect(state.view.zoom).toBe(100);
      expect(state.view.panX).toBe(0);
      expect(state.view.panY).toBe(0);
    });
  });

  describe("zoomAtPoint", () => {
    it("should zoom at specific point correctly", () => {
      const { zoomAtPoint } = useAppStore.getState();

      zoomAtPoint(1.5, 100, 50);

      const state = useAppStore.getState();
      expect(state.view.zoom).toBe(150); // 100 * 1.5
      // Pan values should be calculated to keep point under cursor
      expect(typeof state.view.panX).toBe("number");
      expect(typeof state.view.panY).toBe("number");
    });

    it("should not change zoom if factor results in same zoom", () => {
      const { zoomAtPoint } = useAppStore.getState();
      const initialState = useAppStore.getState().view;

      zoomAtPoint(1.0, 100, 50);

      const state = useAppStore.getState().view;
      expect(state.zoom).toBe(initialState.zoom);
      expect(state.panX).toBe(initialState.panX);
      expect(state.panY).toBe(initialState.panY);
    });

    it("should respect zoom limits", () => {
      const { zoomAtPoint, setZoom } = useAppStore.getState();

      setZoom(1800);
      zoomAtPoint(2.0, 100, 50); // Would be 3600, but clamped to 2000

      expect(useAppStore.getState().view.zoom).toBe(2000);
    });
  });

  describe("fitToWindow", () => {
    it("should calculate correct zoom for image smaller than window", () => {
      const { fitToWindow } = useAppStore.getState();

      // Mock window size
      Object.defineProperty(window, "innerWidth", {
        value: 1920,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 1080,
        configurable: true,
      });

      fitToWindow(800, 600);

      // Should stay at 100% for smaller images
      expect(useAppStore.getState().view.zoom).toBe(100);
    });

    it("should calculate correct zoom for image larger than window", () => {
      const { fitToWindow } = useAppStore.getState();

      // Mock smaller window
      Object.defineProperty(window, "innerWidth", {
        value: 800,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 600,
        configurable: true,
      });

      fitToWindow(1600, 1200);

      // Should zoom out to fit
      const state = useAppStore.getState();
      expect(state.view.zoom).toBeLessThan(100);
      expect(state.view.panX).toBe(0);
      expect(state.view.panY).toBe(0);
    });

    it("should store original image dimensions in view state", () => {
      const { fitToWindow } = useAppStore.getState();

      Object.defineProperty(window, "innerWidth", {
        value: 1920,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 1080,
        configurable: true,
      });

      fitToWindow(2000, 1500);

      const state = useAppStore.getState();
      // Should store original dimensions, not scaled dimensions
      expect(state.view.imageWidth).toBe(2000);
      expect(state.view.imageHeight).toBe(1500);
    });

    it("should calculate correct positioning for centered image", () => {
      const { fitToWindow } = useAppStore.getState();

      Object.defineProperty(window, "innerWidth", {
        value: 1000,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 800,
        configurable: true,
      });

      fitToWindow(400, 300);

      const state = useAppStore.getState();
      // Image should be centered: (containerWidth - imageWidth) / 2
      // containerWidth = 1000, imageWidth = 400
      const expectedLeft = (1000 - 400) / 2; // 300
      // containerHeight = 800 - 80 (thumbnail bar) = 720, imageHeight = 300
      const expectedTop = (720 - 300) / 2; // 210

      expect(state.view.imageLeft).toBe(expectedLeft);
      expect(state.view.imageTop).toBe(expectedTop);
    });

    it("should handle extreme aspect ratios correctly", () => {
      const { fitToWindow } = useAppStore.getState();

      Object.defineProperty(window, "innerWidth", {
        value: 1920,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 1080,
        configurable: true,
      });

      // Very wide image
      fitToWindow(4000, 500);

      const state = useAppStore.getState();
      expect(state.view.zoom).toBeLessThan(100);
      expect(state.view.imageWidth).toBe(4000);
      expect(state.view.imageHeight).toBe(500);
    });

    it("should handle very large images by scaling down appropriately", () => {
      const { fitToWindow } = useAppStore.getState();

      Object.defineProperty(window, "innerWidth", {
        value: 1920,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 1080,
        configurable: true,
      });

      // 8K image
      fitToWindow(7680, 4320);

      const state = useAppStore.getState();
      expect(state.view.zoom).toBeLessThan(50); // Should be significantly scaled down
      expect(state.view.zoom).toBeGreaterThan(10); // But not below minimum
    });

    it("should handle tiny images by keeping them at 100%", () => {
      const { fitToWindow } = useAppStore.getState();

      Object.defineProperty(window, "innerWidth", {
        value: 1920,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 1080,
        configurable: true,
      });

      // Very small image
      fitToWindow(64, 64);

      const state = useAppStore.getState();
      expect(state.view.zoom).toBe(100); // Should stay at 100%
      expect(state.view.imageWidth).toBe(64);
      expect(state.view.imageHeight).toBe(64);
    });

    it("should handle edge case: image exactly fits window", () => {
      const { fitToWindow } = useAppStore.getState();

      Object.defineProperty(window, "innerWidth", {
        value: 800,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 600,
        configurable: true,
      });

      // Image that exactly fits available space (800-40)x(600-80-40) = 760x480
      fitToWindow(760, 480);

      const state = useAppStore.getState();
      expect(state.view.zoom).toBe(100); // Should stay at 100%
      expect(state.view.imageWidth).toBe(760);
      expect(state.view.imageHeight).toBe(480);
    });

    it("should respect minimum zoom limit for extremely large images", () => {
      const { fitToWindow } = useAppStore.getState();

      Object.defineProperty(window, "innerWidth", {
        value: 1920,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 1080,
        configurable: true,
      });

      // Extremely large image that would require <10% zoom
      fitToWindow(50000, 30000);

      const state = useAppStore.getState();
      expect(state.view.zoom).toBe(10); // Should be clamped to minimum
      expect(state.view.imageWidth).toBe(50000);
      expect(state.view.imageHeight).toBe(30000);
    });

    it("should handle portrait vs landscape orientation correctly", () => {
      const { fitToWindow } = useAppStore.getState();

      Object.defineProperty(window, "innerWidth", {
        value: 1000,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 800,
        configurable: true,
      });

      // Portrait image (height > width)
      fitToWindow(600, 1200);

      const state = useAppStore.getState();
      // Should be constrained by height: available height = 800 - 80 - 40 = 680
      // Scale factor = 680 / 1200 ≈ 0.567 = 56.7%
      expect(state.view.zoom).toBeCloseTo(56.67, 1);
      expect(state.view.imageWidth).toBe(600);
      expect(state.view.imageHeight).toBe(1200);
    });

    it("should handle zero-sized window gracefully", () => {
      const { fitToWindow } = useAppStore.getState();

      Object.defineProperty(window, "innerWidth", {
        value: 0,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 0,
        configurable: true,
      });

      fitToWindow(1000, 800);

      const state = useAppStore.getState();
      // Should clamp to minimum zoom even with zero window size
      expect(state.view.zoom).toBe(10);
    });
  });

  describe("openImageFromPath", () => {
    it("should open image and load folder", async () => {
      mockInvoke.mockResolvedValue(mockImageList);

      const { openImageFromPath } = useAppStore.getState();

      await openImageFromPath("/test/image2.png");

      const state = useAppStore.getState();
      expect(state.folder.path).toBe("/test");
      expect(state.folder.images).toEqual(mockImageList);
      expect(state.currentImage.path).toBe("/test/image2.png");
      expect(state.currentImage.index).toBe(1); // Second image in the list
    });

    it("should handle error when image not found in folder", async () => {
      mockInvoke.mockResolvedValue(mockImageList);

      const { openImageFromPath } = useAppStore.getState();

      await openImageFromPath("/test/nonexistent.jpg");

      // Should not change current image if not found
      expect(useAppStore.getState().currentImage.path).toBe("");
    });

    it("should handle invoke error", async () => {
      mockInvoke.mockRejectedValue(new Error("Failed to load folder"));

      const { openImageFromPath } = useAppStore.getState();

      await openImageFromPath("/test/image.jpg");

      const state = useAppStore.getState();
      expect(state.ui.error).not.toBeNull();
      expect(state.ui.error?.message).toContain("Failed to open image");
    });
  });

  describe("cache management", () => {
    it("should set preloaded image", () => {
      const { setPreloadedImage } = useAppStore.getState();

      setPreloadedImage("/test/image.jpg", mockImageData);

      const state = useAppStore.getState();
      expect(state.cache.preloaded.get("/test/image.jpg")).toEqual(
        mockImageData,
      );
    });

    it("should remove preloaded image", () => {
      const { setPreloadedImage, removePreloadedImage } =
        useAppStore.getState();

      setPreloadedImage("/test/image.jpg", mockImageData);
      expect(
        useAppStore.getState().cache.preloaded.has("/test/image.jpg"),
      ).toBe(true);

      removePreloadedImage("/test/image.jpg");
      expect(
        useAppStore.getState().cache.preloaded.has("/test/image.jpg"),
      ).toBe(false);
    });
  });

  describe("UI state management", () => {
    it("should set loading state", () => {
      const { setLoading } = useAppStore.getState();

      setLoading(true);
      expect(useAppStore.getState().ui.isLoading).toBe(true);

      setLoading(false);
      expect(useAppStore.getState().ui.isLoading).toBe(false);
    });

    it("should set fullscreen state", () => {
      const { setFullscreen } = useAppStore.getState();

      setFullscreen(true);
      expect(useAppStore.getState().view.isFullscreen).toBe(true);

      setFullscreen(false);
      expect(useAppStore.getState().view.isFullscreen).toBe(false);
    });

    it("should set About dialog state", () => {
      const { setShowAbout } = useAppStore.getState();

      setShowAbout(true);
      expect(useAppStore.getState().ui.showAbout).toBe(true);

      setShowAbout(false);
      expect(useAppStore.getState().ui.showAbout).toBe(false);
    });

    it("should set drag over state", () => {
      const { setDragOver } = useAppStore.getState();

      setDragOver(true);
      expect(useAppStore.getState().ui.isDragOver).toBe(true);

      setDragOver(false);
      expect(useAppStore.getState().ui.isDragOver).toBe(false);
    });

    it("should set thumbnail opacity", () => {
      const { setThumbnailOpacity } = useAppStore.getState();

      setThumbnailOpacity(1.0);
      expect(useAppStore.getState().view.thumbnailOpacity).toBe(1.0);

      setThumbnailOpacity(0.3);
      expect(useAppStore.getState().view.thumbnailOpacity).toBe(0.3);
    });
  });
});
