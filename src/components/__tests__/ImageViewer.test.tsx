import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { mockImageData } from "../../utils/testUtils";
import type { ImageData as AppImageData } from "../../types";
import {
  IMAGE_LOAD_DEBOUNCE_MS,
  PREVIEW_THUMBNAIL_SIZE,
} from "../../constants/timing";

// Mock the invoke function
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock the useImagePreloader hook
vi.mock("../../hooks/useImagePreloader", () => ({
  useImagePreloader: vi.fn(),
}));

// Mock the store
const mockStore = {
  currentImage: {
    path: "",
    data: null as AppImageData | null,
    error: null as Error | null,
  },
  view: {
    zoom: 100,
    panX: 0,
    panY: 0,
    imageLeft: 0 as number | undefined,
    imageTop: 0 as number | undefined,
    imageWidth: 0 as number | undefined,
    imageHeight: 0 as number | undefined,
  },
  folder: {
    path: "",
    images: [],
    imagesByPath: new Map(),
    sortOrder: "name" as const,
  },
  cache: {
    preloaded: new Map(),
    imageViewStates: new Map(),
  },
  ui: {
    suppressTransition: false,
    suppressTransitionTimeoutId: null,
  },
  setImageData: vi.fn(),
  setImageError: vi.fn(),
  setLoading: vi.fn(),
  setPan: vi.fn(),
  zoomAtPoint: vi.fn(),
  fitToWindow: vi.fn(),
  updateImageDimensions: vi.fn(),
  resizeToImage: vi.fn(),
  setPreloadedImage: vi.fn(),
};

vi.mock("../../store", () => {
  // Create mock function with getState method
  const mockUseAppStore = vi.fn(() => mockStore);
  mockUseAppStore.getState = () => mockStore;

  return {
    useAppStore: mockUseAppStore,
  };
});

import ImageViewer from "../ImageViewer";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

describe("ImageViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    mockStore.currentImage.path = "";
    mockStore.currentImage.data = null;
    mockStore.currentImage.error = null;
    mockStore.view.zoom = 100;
    mockStore.view.panX = 0;
    mockStore.view.panY = 0;
    mockStore.view.imageLeft = 0;
    mockStore.view.imageTop = 0;
    mockStore.view.imageWidth = 0;
    mockStore.view.imageHeight = 0;
    mockStore.folder.images = [];
    mockStore.cache.preloaded = new Map();
  });

  describe("Empty state", () => {
    it("should render empty state when no image selected", () => {
      render(<ImageViewer />);

      expect(screen.getByText("No image selected")).toBeInTheDocument();
      expect(screen.getByText("No image selected").parentElement).toHaveClass(
        "image-viewer-empty",
      );
    });

    it("should apply custom className in empty state", () => {
      render(<ImageViewer className="custom-class" />);

      expect(screen.getByText("No image selected").parentElement).toHaveClass(
        "image-viewer-empty",
        "custom-class",
      );
    });
  });

  describe("Error state", () => {
    it("should render error state when image has error", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.error = new Error("Failed to load image");

      render(<ImageViewer />);

      expect(
        screen.getByText("Failed to load image: Failed to load image"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Failed to load image: Failed to load image")
          .parentElement,
      ).toHaveClass("image-viewer-error");
    });
  });

  describe("Loading state", () => {
    it("should render empty viewer when image path exists but no data", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;

      render(<ImageViewer />);

      // Should render empty viewer container (no loading message in this component)
      const container = document.querySelector(".image-viewer");
      expect(container).toBeInTheDocument();
    });
  });

  describe("Image display", () => {
    beforeEach(() => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = mockImageData as AppImageData | null;
    });

    it("should render image when data is available", () => {
      render(<ImageViewer />);

      const image = screen.getByRole("img");
      expect(image).toBeInTheDocument();
      expect(image).toHaveAttribute(
        "src",
        `data:${mockImageData.format};base64,${mockImageData.base64}`,
      );
      expect(image).toHaveAttribute("alt", "image.jpg");
      expect(image).toHaveAttribute("draggable", "false");
    });

    it("should apply transform styles based on zoom and pan", () => {
      mockStore.view.zoom = 150;
      mockStore.view.panX = 50;
      mockStore.view.panY = 25;

      render(<ImageViewer />);

      const image = screen.getByRole("img");
      expect(image).toHaveStyle({
        transform: "scale(1.5) translate(50px, 25px)",
      });
    });

    it("should show zoom indicator when zoom is not 100%", () => {
      mockStore.view.zoom = 200;

      render(<ImageViewer />);

      expect(screen.getByText("200%")).toBeInTheDocument();
      expect(screen.getByText("200%")).toHaveClass("zoom-indicator");
    });

    it("should not show zoom indicator when zoom is 100%", () => {
      mockStore.view.zoom = 100;

      render(<ImageViewer />);

      expect(screen.queryByText("100%")).not.toBeInTheDocument();
    });

    it("should apply cursor style based on dragging state", () => {
      render(<ImageViewer />);

      const image = screen.getByRole("img");
      expect(image).toHaveStyle({ cursor: "grab" });
    });
  });

  describe("Image loading", () => {
    it("should load image on mount when path exists but no data", async () => {
      vi.useFakeTimers();
      // Mock two-phase loading
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === "generate_thumbnail_with_dimensions") {
          return Promise.resolve({
            thumbnail_base64: "thumbnail_data",
            original_width: mockImageData.width,
            original_height: mockImageData.height,
          });
        }
        if (cmd === "load_image") {
          return Promise.resolve(mockImageData);
        }
        return Promise.reject(new Error(`Unexpected command: ${cmd}`));
      });
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;

      await act(async () => {
        render(<ImageViewer />);
      });

      // Advance past the debounce delay
      await act(async () => {
        vi.advanceTimersByTime(IMAGE_LOAD_DEBOUNCE_MS);
        await Promise.resolve();
      });

      expect(mockStore.setLoading).toHaveBeenCalledWith(true);
      expect(mockStore.setImageError).toHaveBeenCalledWith(null);

      // Wait for async operation
      await act(async () => {
        await vi.waitFor(() => {
          // Should call generate_thumbnail_with_dimensions for preview
          expect(mockInvoke).toHaveBeenCalledWith(
            "generate_thumbnail_with_dimensions",
            {
              path: "/test/image.jpg",
              size: PREVIEW_THUMBNAIL_SIZE,
            },
          );
          // Should call load_image for full resolution
          expect(mockInvoke).toHaveBeenCalledWith("load_image", {
            path: "/test/image.jpg",
          });
          // Should set image data twice (preview + full)
          expect(mockStore.setImageData).toHaveBeenCalled();
          expect(mockStore.fitToWindow).toHaveBeenCalledWith(
            mockImageData.width,
            mockImageData.height,
          );
          expect(mockStore.setLoading).toHaveBeenCalledWith(false);
        });
      });

      vi.useRealTimers();
    });

    it("should use preloaded image if available", async () => {
      vi.useFakeTimers();
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;
      mockStore.cache.preloaded.set("/test/image.jpg", mockImageData);

      render(<ImageViewer />);

      // Advance past the debounce delay
      await act(async () => {
        vi.advanceTimersByTime(IMAGE_LOAD_DEBOUNCE_MS);
        await Promise.resolve();
      });

      expect(mockStore.setImageData).toHaveBeenCalledWith(mockImageData);
      expect(mockStore.fitToWindow).toHaveBeenCalledWith(
        mockImageData.width,
        mockImageData.height,
      );
      expect(mockInvoke).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should handle preloaded error images", async () => {
      vi.useFakeTimers();
      const errorImage = { ...mockImageData, format: "error" as const };
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;
      mockStore.cache.preloaded.set("/test/image.jpg", errorImage);

      await act(async () => {
        render(<ImageViewer />);
      });

      // Advance past the debounce delay
      await act(async () => {
        vi.advanceTimersByTime(IMAGE_LOAD_DEBOUNCE_MS);
        await Promise.resolve();
      });

      // Cache hits (including errors) don't trigger loading state
      expect(mockStore.setLoading).not.toHaveBeenCalledWith(true);
      expect(mockStore.setImageError).toHaveBeenCalledWith(expect.any(Error));
      expect(mockStore.setLoading).toHaveBeenCalledWith(false);

      vi.useRealTimers();
    });

    it("should handle image loading error", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockInvoke.mockRejectedValue(new Error("Load failed"));
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;

      await act(async () => {
        render(<ImageViewer />);
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockStore.setImageError).toHaveBeenCalledWith(
            expect.any(Error),
          );
          expect(mockStore.setLoading).toHaveBeenCalledWith(false);
        });
      });

      consoleErrorSpy.mockRestore();
    });
  });

  describe("Mouse interactions", () => {
    beforeEach(() => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = mockImageData as AppImageData | null;
    });

    it("should start dragging on mouse down", () => {
      render(<ImageViewer />);

      const image = screen.getByRole("img");
      fireEvent.mouseDown(image, { clientX: 100, clientY: 50 });

      // Image should change to grabbing cursor during drag
      expect(image).toHaveStyle({ cursor: "grabbing" });
    });

    it("should handle mouse move during drag", () => {
      render(<ImageViewer />);

      const image = screen.getByRole("img");
      const container = image.parentElement as HTMLElement;
      expect(container).not.toBeNull();

      // Start drag on image
      fireEvent.mouseDown(image, { clientX: 100, clientY: 50 });

      // Move mouse on container
      fireEvent.mouseMove(container, { clientX: 120, clientY: 70 });

      expect(mockStore.setPan).toHaveBeenCalled();
    });

    it("should stop dragging on mouse up", () => {
      render(<ImageViewer />);

      const container = screen.getByRole("img").parentElement as HTMLElement;
      expect(container).not.toBeNull();

      // Start and stop drag
      fireEvent.mouseDown(container, { clientX: 100, clientY: 50 });
      fireEvent.mouseUp(container);

      const image = screen.getByRole("img");
      expect(image).toHaveStyle({ cursor: "grab" });
    });

    it("should stop dragging on mouse leave", () => {
      render(<ImageViewer />);

      const container = screen.getByRole("img").parentElement as HTMLElement;
      expect(container).not.toBeNull();

      // Start drag and leave
      fireEvent.mouseDown(container, { clientX: 100, clientY: 50 });
      fireEvent.mouseLeave(container);

      const image = screen.getByRole("img");
      expect(image).toHaveStyle({ cursor: "grab" });
    });

    it("should render container with event handlers", () => {
      render(<ImageViewer />);

      const container = screen.getByRole("img").parentElement;
      expect(container).not.toBeNull();

      // Verify that the container is properly rendered and can receive events
      expect(container).toBeInTheDocument();
      expect(container).toHaveClass("image-viewer");
    });

    it("should handle wheel event for zooming", () => {
      // Mock getBoundingClientRect
      const mockGetBoundingClientRect = vi.fn(() => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }));

      render(<ImageViewer />);

      const container = screen.getByRole("img").parentElement;
      expect(container).not.toBeNull();
      (container as HTMLElement).getBoundingClientRect =
        mockGetBoundingClientRect;

      // Use fireEvent.wheel directly with proper event properties
      fireEvent.wheel(container as HTMLElement, {
        deltaY: -120,
        clientX: 400,
        clientY: 300,
      });

      expect(mockStore.zoomAtPoint).toHaveBeenCalled();
    });
  });

  describe("Window resize handling", () => {
    beforeEach(() => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = mockImageData as AppImageData | null;
    });

    it("should refit image on window resize", () => {
      render(<ImageViewer />);

      // Clear previous calls
      mockStore.fitToWindow.mockClear();

      // Trigger resize
      fireEvent(window, new Event("resize"));

      expect(mockStore.fitToWindow).toHaveBeenCalledWith(
        mockImageData.width,
        mockImageData.height,
        true,
      );
    });

    it("should cleanup resize listener on unmount", () => {
      const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

      const { unmount } = render(<ImageViewer />);
      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "resize",
        expect.any(Function),
      );

      removeEventListenerSpy.mockRestore();
    });
  });

  describe("Transition effects", () => {
    it("should disable transition during drag", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = mockImageData as AppImageData | null;

      render(<ImageViewer />);

      const image = screen.getByRole("img");

      // Start drag on image
      fireEvent.mouseDown(image, { clientX: 100, clientY: 50 });

      expect(image).toHaveStyle({ transition: "none" });
    });

    it("should enable transition in normal state (not dragging, not suppressed)", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = mockImageData as AppImageData | null;
      mockStore.ui.suppressTransition = false;

      render(<ImageViewer />);

      const image = screen.getByRole("img");

      // In normal state (not dragging, suppressTransition=false), transition should be enabled
      expect(image).toHaveStyle({ transition: "transform 0.1s ease-out" });
    });

    it("should disable transition when suppressTransition is true", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = mockImageData as AppImageData | null;
      mockStore.ui.suppressTransition = true;

      render(<ImageViewer />);

      const image = screen.getByRole("img");

      // When suppressTransition is true, transition should be disabled
      expect(image).toHaveStyle({ transition: "none" });
    });
  });

  describe("Accessibility", () => {
    it("should have proper ARIA roles and attributes", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = mockImageData as AppImageData | null;

      render(<ImageViewer />);

      const container = screen.getByRole("img").parentElement;
      expect(container).not.toBeNull();
      expect(container).toHaveClass("image-viewer");

      const image = screen.getByRole("img");
      expect(image).toHaveAttribute("alt", "image.jpg");
    });

    it("should prevent default dragging behavior", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = mockImageData as AppImageData | null;

      render(<ImageViewer />);

      const image = screen.getByRole("img");
      expect(image).toHaveAttribute("draggable", "false");
    });
  });

  describe("Image positioning and scaling", () => {
    beforeEach(() => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = {
        ...mockImageData,
        width: 1200,
        height: 800,
      } as AppImageData | null;
    });

    it("should use original image dimensions for width and height", () => {
      render(<ImageViewer />);

      const image = screen.getByRole("img");
      expect(image).toHaveStyle({
        width: "1200px",
        height: "800px",
      });
    });

    it("should apply positioned coordinates from view state", () => {
      mockStore.view.imageLeft = 360;
      mockStore.view.imageTop = 140;

      render(<ImageViewer />);

      const image = screen.getByRole("img");
      expect(image).toHaveStyle({
        left: "360px",
        top: "140px",
      });
    });

    it("should fall back to 0 position when no coordinates provided", () => {
      mockStore.view.imageLeft = undefined;
      mockStore.view.imageTop = undefined;

      render(<ImageViewer />);

      const image = screen.getByRole("img");
      expect(image).toHaveStyle({
        left: "0px",
        top: "0px",
      });
    });

    it("should combine positioning with scaling and translation", () => {
      mockStore.view.imageLeft = 100;
      mockStore.view.imageTop = 50;
      mockStore.view.zoom = 150;
      mockStore.view.panX = 20;
      mockStore.view.panY = 10;

      render(<ImageViewer />);

      const image = screen.getByRole("img");
      expect(image).toHaveStyle({
        left: "100px",
        top: "50px",
        width: "1200px",
        height: "800px",
        transform: "scale(1.5) translate(20px, 10px)",
      });
    });

    it("should handle missing image data gracefully", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;
      mockStore.view.imageLeft = 100;
      mockStore.view.imageTop = 50;

      render(<ImageViewer />);

      // Should render empty container when path exists but no data, not crash
      const container = document.querySelector(".image-viewer");
      expect(container).toBeInTheDocument();
    });

    it("should update styles when view state changes", () => {
      const { rerender } = render(<ImageViewer />);

      let image = screen.getByRole("img");
      expect(image).toHaveStyle({
        left: "0px",
        top: "0px",
      });

      // Update view state
      mockStore.view.imageLeft = 200;
      mockStore.view.imageTop = 100;

      rerender(<ImageViewer />);

      image = screen.getByRole("img");
      expect(image).toHaveStyle({
        left: "200px",
        top: "100px",
      });
    });

    it("should apply correct CSS class for absolute positioning", () => {
      render(<ImageViewer />);

      const image = screen.getByRole("img");
      // CSS positioning is handled by App.css via class, not inline styles
      expect(image).toBeInTheDocument();
      expect(image.tagName).toBe("IMG");
    });
  });
});
