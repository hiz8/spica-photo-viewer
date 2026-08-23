import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { mockImageData } from "../../utils/testUtils";
import type { ImageData as AppImageData } from "../../types";
import { IMAGE_LOAD_DEBOUNCE_MS } from "../../constants/timing";
import { FULL_UPGRADE_DEBOUNCE_MS } from "../../constants/memory";

// Mock the invoke function (ImageViewer no longer calls it directly, but the
// mock keeps any transitive Tauri IPC out of jsdom).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// jsdom never fetches resources nor fires load/error events for an <img>, so
// the protocol loader is mocked at the import boundary. The real network path
// is covered by E2E (e2e/specs/smoke.e2e.ts).
const PROTOCOL_SRC = (path: string) =>
  `http://spica-img.localhost/${encodeURIComponent(path)}`;
const PREVIEW_BOX = "1920x1080";
const PREVIEW_SRC = (path: string) =>
  `http://spica-img.localhost/preview/${PREVIEW_BOX}/${encodeURIComponent(path)}`;

vi.mock("../../utils/protocolLoader", () => ({
  loadImageViaProtocol: vi.fn(async (path: string) => ({
    data: {
      path,
      src: `http://spica-img.localhost/${encodeURIComponent(path)}`,
      width: 800,
      height: 600,
      format: "jpg",
    },
    element: new Image(),
  })),
}));

vi.mock("../../utils/canvasDraw", () => ({
  drawBitmapToCanvas: vi.fn(),
}));

// The bitmap loader talks to the spica-img protocol (fetch + createImageBitmap),
// neither of which jsdom provides. The real bitmapCache is kept so the tests
// exercise the actual retention/tier bookkeeping.
vi.mock("../../utils/bitmapLoader", () => ({
  loadPreviewBitmap: vi.fn(),
  loadBitmapViaProtocol: vi.fn(),
  retainElementAsBitmap: vi.fn(),
}));

// One deterministic screen box, so preview URLs/arguments are assertable.
vi.mock("../../utils/previewBox", () => ({
  currentPreviewBox: () => "1920x1080",
}));

// Mock the useThumbnailGenerator hook
vi.mock("../../hooks/useThumbnailGenerator", () => ({
  useThumbnailGenerator: vi.fn(),
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
    thumbnails: new Map(),
    preloaded: new Map(),
    imageViewStates: new Map(),
  },
  ui: {
    suppressTransition: false,
    suppressTransitionTimeoutId: null,
    thumbnailDisplayed: false,
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
  setThumbnailDisplayed: vi.fn(),
};

vi.mock("../../store", () => {
  // Create mock function with getState method (Object.assign keeps the added
  // property visible to TypeScript, which a plain assignment on Mock does not).
  const mockUseAppStore = Object.assign(
    vi.fn(() => mockStore),
    { getState: () => mockStore },
  );

  return {
    useAppStore: mockUseAppStore,
    // Pure helper - use the real shape so the two-phase (thumbnail preview)
    // branch is exercised instead of throwing on an undefined import.
    thumbnailToImageData: (
      path: string,
      thumbnailCache: { base64: string; width: number; height: number },
    ) => ({
      path,
      src: `data:jpeg;base64,${thumbnailCache.base64}`,
      width: thumbnailCache.width,
      height: thumbnailCache.height,
      format: "jpeg",
    }),
  };
});

import ImageViewer from "../ImageViewer";
import { loadImageViaProtocol } from "../../utils/protocolLoader";
import { drawBitmapToCanvas } from "../../utils/canvasDraw";
import { clearBitmaps, getRetained, setBitmap } from "../../utils/bitmapCache";
import {
  loadBitmapViaProtocol,
  loadPreviewBitmap,
} from "../../utils/bitmapLoader";
import { _setPerfEnabledForTests } from "../../utils/perf";

const mockLoadImageViaProtocol = vi.mocked(loadImageViaProtocol);
const mockLoadPreviewBitmap = vi.mocked(loadPreviewBitmap);
const mockLoadBitmapViaProtocol = vi.mocked(loadBitmapViaProtocol);

const fakeBitmap = (width: number, height: number) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

/**
 * Default preview response: a 400x300 decode of an 800x600 original, i.e.
 * the display-resolution tier the /preview/<box>/ route serves.
 */
const previewResult = (
  path: string,
  bitmap: ImageBitmap,
  natural = { width: 800, height: 600 },
) => ({
  data: {
    path,
    src: PREVIEW_SRC(path),
    width: natural.width,
    height: natural.height,
    format: "jpg",
    tier:
      bitmap.width === natural.width && bitmap.height === natural.height
        ? ("full" as const)
        : ("preview" as const),
  },
  bitmap,
});

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
    mockStore.folder.imagesByPath = new Map();
    mockStore.cache.thumbnails = new Map();
    mockStore.cache.preloaded = new Map();
    mockStore.cache.imageViewStates = new Map();
    mockStore.ui.thumbnailDisplayed = false;
    clearBitmaps();
    // Default: the preview route serves a downscaled display-resolution
    // decode. Individual tests override this (unscaled preview, 404, ...).
    mockLoadPreviewBitmap.mockImplementation(async (path: string) =>
      previewResult(path, fakeBitmap(400, 300)),
    );
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
      expect(image).toHaveAttribute("src", mockImageData.src);
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
      // No thumbnail in cache, so this takes the direct-load branch
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;
      // No thumbnail in cache
      mockStore.cache.thumbnails = new Map();

      const { rerender } = render(<ImageViewer />);

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
          // Should load via the spica-img protocol (no thumbnail cached)
          expect(mockLoadImageViaProtocol).toHaveBeenCalledWith(
            "/test/image.jpg",
          );
          // Should set image data carrying the protocol URL
          expect(mockStore.setImageData).toHaveBeenCalledWith(
            expect.objectContaining({
              path: "/test/image.jpg",
              src: PROTOCOL_SRC("/test/image.jpg"),
              width: 800,
              height: 600,
            }),
          );
          expect(mockStore.fitToWindow).toHaveBeenCalledWith(800, 600);
          expect(mockStore.setLoading).toHaveBeenCalledWith(false);
        });
      });

      // The store is mocked, so feed the produced data back in to prove the
      // rendered <img> ends up pointing at the protocol URL.
      mockStore.currentImage.data = mockStore.setImageData.mock
        .calls[0][0] as AppImageData;
      rerender(<ImageViewer />);
      expect(screen.getByRole("img")).toHaveAttribute(
        "src",
        PROTOCOL_SRC("/test/image.jpg"),
      );

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
      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();

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
      // A rejected decode() (404 / corrupt file) must surface as an error
      mockLoadImageViaProtocol.mockRejectedValueOnce(new Error("boom"));
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;

      const { rerender } = render(<ImageViewer />);

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockStore.setImageError).toHaveBeenCalledWith(
            expect.objectContaining({ message: "boom" }),
          );
          expect(mockStore.setLoading).toHaveBeenCalledWith(false);
        });
      });

      // Feed the error back into the mocked store to prove it is displayed
      mockStore.currentImage.error = new Error("boom");
      rerender(<ImageViewer />);
      expect(screen.getByText("Failed to load image: boom")).toHaveClass(
        "error-message",
      );

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

  describe("Opacity behavior", () => {
    it("should not render image element when suppressTransition is true and no data", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;
      mockStore.ui.suppressTransition = true;

      render(<ImageViewer />);

      // Image element won't be rendered when data is null
      const viewer = screen.getByRole("region", { name: /image viewer/i });
      expect(viewer).toBeInTheDocument();
      // Note: Cannot test opacity value since image element is not rendered when data is null
    });

    it("should set opacity to 1 when suppressTransition is true but data exists (instant display)", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = mockImageData as AppImageData | null;
      mockStore.ui.suppressTransition = true;

      render(<ImageViewer />);

      const image = screen.getByRole("img");
      // When suppressTransition is true but data exists, opacity should be 1 for instant display
      expect(image).toHaveStyle({ opacity: "1" });
    });

    it("should set opacity to 1 when suppressTransition is false (normal state)", () => {
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = mockImageData as AppImageData | null;
      mockStore.ui.suppressTransition = false;

      render(<ImageViewer />);

      const image = screen.getByRole("img");
      // In normal state (suppressTransition=false), opacity should always be 1
      expect(image).toHaveStyle({ opacity: "1" });
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

  describe("cached preview display", () => {
    it("should display cached thumbnail preview when available", async () => {
      vi.useFakeTimers();
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;
      mockStore.cache.thumbnails.set("/test/image.jpg", {
        base64: "thumbnailBase64",
        width: 800,
        height: 600,
      });

      await act(async () => {
        render(<ImageViewer />);
      });

      // Advance past debounce
      await act(async () => {
        vi.advanceTimersByTime(IMAGE_LOAD_DEBOUNCE_MS);
        await Promise.resolve();
      });

      // PHASE 1: the cached thumbnail is shown first
      expect(mockStore.setImageData).toHaveBeenCalled();
      expect(mockStore.setImageData.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          path: "/test/image.jpg",
          src: "data:jpeg;base64,thumbnailBase64",
        }),
      );

      // PHASE 2: the display-resolution preview arrives over the protocol
      // (the 20MP original is NOT fetched)
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockStore.setImageData).toHaveBeenCalledWith(
            expect.objectContaining({
              path: "/test/image.jpg",
              src: PREVIEW_SRC("/test/image.jpg"),
              tier: "preview",
            }),
          );
        });
      });
      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should skip debounce when thumbnail already displayed", async () => {
      vi.useFakeTimers();
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = {
        path: "/test/image.jpg",
        src: "data:jpeg;base64,thumbnailBase64",
        width: 800,
        height: 600,
        format: "jpeg",
      };
      mockStore.ui.thumbnailDisplayed = true;
      mockStore.cache.thumbnails.set("/test/image.jpg", {
        base64: "thumbnailBase64",
        width: 800,
        height: 600,
      });

      await act(async () => {
        render(<ImageViewer />);
      });

      // Should load the display-resolution preview immediately (skipping
      // debounce); the full-resolution original is left alone.
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockLoadPreviewBitmap).toHaveBeenCalledWith(
            "/test/image.jpg",
            PREVIEW_BOX,
            expect.anything(),
          );
        });
      });
      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();
      expect(mockStore.setThumbnailDisplayed).toHaveBeenCalledWith(false);

      vi.useRealTimers();
    });

    it("should upgrade from thumbnail to the display-resolution preview", async () => {
      vi.useFakeTimers();
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;
      mockStore.ui.thumbnailDisplayed = false;
      mockStore.cache.thumbnails.set("/test/image.jpg", {
        base64: "thumbnailBase64",
        width: 800,
        height: 600,
      });

      await act(async () => {
        render(<ImageViewer />);
      });

      // Advance past debounce
      await act(async () => {
        vi.advanceTimersByTime(IMAGE_LOAD_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      // Wait for async operations
      await act(async () => {
        await vi.waitFor(() => {
          // Should have called setImageData (thumbnail then preview)
          expect(mockStore.setImageData).toHaveBeenCalledWith(
            expect.objectContaining({ src: PREVIEW_SRC("/test/image.jpg") }),
          );
        });
      });
      expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
        "/test/image.jpg",
        expect.objectContaining({ src: PREVIEW_SRC("/test/image.jpg") }),
      );

      vi.useRealTimers();
    });
  });

  describe("dimension-based layout optimization", () => {
    it("should call fitToWindow with cached thumbnail dimensions", async () => {
      vi.useFakeTimers();
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;
      mockStore.cache.thumbnails.set("/test/image.jpg", {
        base64: "thumbnailBase64",
        width: 3840,
        height: 2160,
      });

      await act(async () => {
        render(<ImageViewer />);
      });

      // Advance past debounce
      await act(async () => {
        vi.advanceTimersByTime(IMAGE_LOAD_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      // fitToWindow should have been called with the cached thumbnail's
      // dimensions before the full-resolution load resolves
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockStore.fitToWindow).toHaveBeenCalledWith(3840, 2160);
        });
      });

      vi.useRealTimers();
    });

    it("should use updateImageDimensions for images with saved view state", async () => {
      vi.useFakeTimers();
      mockStore.currentImage.path = "/test/image.jpg";
      mockStore.currentImage.data = null;
      mockStore.cache.preloaded.set("/test/image.jpg", {
        path: "/test/image.jpg",
        src: PROTOCOL_SRC("/test/image.jpg"),
        width: 1920,
        height: 1080,
        format: "jpeg",
      });
      // Simulate saved view state
      mockStore.cache.imageViewStates.set("/test/image.jpg", {
        zoom: 150,
        panX: 50,
        panY: 30,
      });

      await act(async () => {
        render(<ImageViewer />);
      });

      // Advance past debounce
      await act(async () => {
        vi.advanceTimersByTime(IMAGE_LOAD_DEBOUNCE_MS);
        await Promise.resolve();
      });

      // updateImageDimensions should be called for images with saved state
      expect(mockStore.updateImageDimensions).toHaveBeenCalledWith(1920, 1080);

      vi.useRealTimers();
    });
  });

  describe("Canvas hit path (decoded bitmap window)", () => {
    const path = "C:\\photos\\hit.jpg";
    const data = {
      path,
      src: PROTOCOL_SRC(path),
      width: 800,
      height: 600,
      format: "jpg",
    };

    it("renders a canvas and draws the retained bitmap when available", () => {
      setBitmap(path, fakeBitmap(800, 600));
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = data;

      const { container } = render(<ImageViewer />);

      expect(container.querySelector("canvas")).toBeInTheDocument();
      expect(container.querySelector("img")).not.toBeInTheDocument();
      // Both the mount ref callback (belt-and-braces) and the data-keyed
      // useLayoutEffect draw on this initial mount; double-drawing is
      // idempotent and expected exactly twice here.
      expect(drawBitmapToCanvas).toHaveBeenCalledTimes(2);
    });

    it("falls back to <img> when no bitmap is cached", () => {
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = data;

      const { container } = render(<ImageViewer />);

      expect(container.querySelector("img")).toBeInTheDocument();
      expect(container.querySelector("canvas")).not.toBeInTheDocument();
    });

    it("falls back to <img> while a thumbnail placeholder is displayed", () => {
      setBitmap(path, fakeBitmap(800, 600));
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = data;
      mockStore.ui.thumbnailDisplayed = true;

      const { container } = render(<ImageViewer />);

      expect(container.querySelector("img")).toBeInTheDocument();
      expect(container.querySelector("canvas")).not.toBeInTheDocument();
    });

    it("does not swap <img> for <canvas> when a bitmap lands later without a data change", () => {
      // No bitmap cached yet: first render must display the <img>.
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = data;

      const { container, rerender } = render(<ImageViewer />);

      expect(container.querySelector("img")).toBeInTheDocument();
      expect(container.querySelector("canvas")).not.toBeInTheDocument();

      // Bitmap retention lands asynchronously into the module-level cache
      // (non-reactive) and some unrelated store-driven update (e.g. a
      // neighbor's preload:done) triggers a re-render WITHOUT
      // currentImage.data changing identity.
      setBitmap(path, fakeBitmap(800, 600));
      rerender(<ImageViewer />);

      // The <img> must still be displayed: swapping to <canvas> here would
      // mount an undrawn canvas, since the draw effect is keyed on
      // currentImage.data, which did not change.
      expect(container.querySelector("img")).toBeInTheDocument();
      expect(container.querySelector("canvas")).not.toBeInTheDocument();
    });

    it("does not redraw the canvas on an unrelated re-render while mounted", () => {
      // Canvas is already mounted and drawn with a bitmap in place.
      setBitmap(path, fakeBitmap(800, 600));
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = data;

      const { container, rerender } = render(<ImageViewer />);

      expect(container.querySelector("canvas")).toBeInTheDocument();
      const callsAfterMount = vi.mocked(drawBitmapToCanvas).mock.calls.length;

      // Simulate an unrelated store-driven re-render (e.g. setPan on every
      // mousemove during drag) with currentImage.data UNCHANGED. The ref
      // callback's identity must stay stable so React does not re-invoke it
      // (which would reallocate the canvas backing store and redraw the full
      // bitmap on every such re-render).
      rerender(<ImageViewer />);

      expect(container.querySelector("canvas")).toBeInTheDocument();
      expect(vi.mocked(drawBitmapToCanvas).mock.calls.length).toBe(
        callsAfterMount,
      );
    });

    it("emits a full-resolution paint:done from the canvas path", async () => {
      _setPerfEnabledForTests(true);
      window.__PERF__ = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
      setBitmap(path, fakeBitmap(800, 600));
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = data;

      render(<ImageViewer />);

      const paint = (window.__PERF__ ?? []).find(
        (e) => e.name === "paint:done",
      );
      expect(paint?.detail).toEqual({ path, thumbnail: false, tier: "full" });
      vi.unstubAllGlobals();
      _setPerfEnabledForTests(null);
      window.__PERF__ = [];
    });

    it("tags a thumbnail placeholder paint with tier 'thumbnail'", async () => {
      _setPerfEnabledForTests(true);
      window.__PERF__ = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
      // No retained bitmap and thumbnailDisplayed=true: the <img> placeholder
      // path. jsdom's <img> has no decode(), so the paint mark fires through
      // the synchronous fallback.
      mockStore.ui.thumbnailDisplayed = true;
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = { ...data, src: "data:jpeg;base64,AAAA" };

      const { container } = render(<ImageViewer />);
      expect(container.querySelector("img")).toBeInTheDocument();

      try {
        await vi.waitFor(() => {
          const paint = (window.__PERF__ ?? []).find(
            (e) => e.name === "paint:done",
          );
          expect(paint?.detail).toEqual({
            path,
            thumbnail: true,
            tier: "thumbnail",
          });
        });
      } finally {
        mockStore.ui.thumbnailDisplayed = false;
        vi.unstubAllGlobals();
        _setPerfEnabledForTests(null);
        window.__PERF__ = [];
      }
    });
  });

  describe("display-resolution preview (bitmap miss path)", () => {
    const path = "/test/image.jpg";
    const thumbnailData: AppImageData = {
      path,
      src: "data:jpeg;base64,thumbnailBase64",
      width: 800,
      height: 600,
      format: "jpeg",
    };

    const cacheThumbnail = () =>
      mockStore.cache.thumbnails.set(path, {
        base64: "thumbnailBase64",
        width: 800,
        height: 600,
      });

    it("upgrades a displayed thumbnail with the preview, not the original", async () => {
      vi.useFakeTimers();
      const previewBitmap = fakeBitmap(400, 300);
      mockLoadPreviewBitmap.mockImplementation(async (p: string) =>
        previewResult(p, previewBitmap),
      );
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = thumbnailData;
      mockStore.ui.thumbnailDisplayed = true;
      cacheThumbnail();

      const { container, rerender } = render(<ImageViewer />);

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(mockLoadPreviewBitmap).toHaveBeenCalledWith(
        path,
        PREVIEW_BOX,
        expect.anything(),
      );
      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();
      // Retained under the preview TIER even though the loader may say
      // otherwise, matching the preload scheduler.
      expect(getRetained(path)).toEqual({
        bitmap: previewBitmap,
        tier: "preview",
      });
      expect(mockStore.setImageData).toHaveBeenCalledWith(
        expect.objectContaining({
          path,
          src: PREVIEW_SRC(path),
          width: 800,
          height: 600,
          tier: "preview",
        }),
      );
      // Geometry is the natural size, not the preview bitmap's size.
      expect(mockStore.fitToWindow).toHaveBeenCalledWith(800, 600);
      expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
        path,
        expect.objectContaining({ tier: "preview" }),
      );
      expect(mockStore.setThumbnailDisplayed).toHaveBeenCalledWith(false);

      // Feed the produced data back into the mocked store: the viewer must
      // now paint the preview bitmap on a canvas.
      mockStore.currentImage.data = mockStore.setImageData.mock.calls.at(
        -1,
      )?.[0] as AppImageData;
      mockStore.ui.thumbnailDisplayed = false;
      rerender(<ImageViewer />);

      expect(container.querySelector("canvas")).toBeInTheDocument();
      expect(container.querySelector("img")).not.toBeInTheDocument();
      expect(drawBitmapToCanvas).toHaveBeenCalledWith(
        expect.anything(),
        previewBitmap,
      );

      vi.useRealTimers();
    });

    it("labels an unscaled preview as full resolution", async () => {
      vi.useFakeTimers();
      const unscaled = fakeBitmap(800, 600);
      mockLoadPreviewBitmap.mockImplementation(async (p: string) =>
        previewResult(p, unscaled),
      );
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = thumbnailData;
      mockStore.ui.thumbnailDisplayed = true;
      cacheThumbnail();

      render(<ImageViewer />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(mockStore.setImageData).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "full" }),
      );
      // ...but the pixels stay filed under the preview tier.
      expect(getRetained(path)).toEqual({ bitmap: unscaled, tier: "preview" });

      vi.useRealTimers();
    });

    it("falls back to the full-resolution original when the preview is missing", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockLoadPreviewBitmap.mockRejectedValue(new Error("404"));
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = thumbnailData;
      mockStore.ui.thumbnailDisplayed = true;
      cacheThumbnail();

      render(<ImageViewer />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(warnSpy).toHaveBeenCalled();
      expect(mockLoadImageViaProtocol).toHaveBeenCalledWith(path);
      expect(mockStore.setImageData).toHaveBeenCalledWith(
        expect.objectContaining({
          src: PROTOCOL_SRC(path),
          width: 800,
          height: 600,
          tier: "full",
        }),
      );
      expect(mockStore.setThumbnailDisplayed).toHaveBeenCalledWith(false);

      warnSpy.mockRestore();
      vi.useRealTimers();
    });

    it("treats an aborted preview as stale instead of falling back", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Hold the preview load open so it can be rejected AFTER the viewer
      // has navigated away (which aborts the load's signal).
      let rejectPreview: (reason: unknown) => void = () => {};
      mockLoadPreviewBitmap.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectPreview = reject;
          }),
      );
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = thumbnailData;
      mockStore.ui.thumbnailDisplayed = true;
      cacheThumbnail();

      const { unmount } = render(<ImageViewer />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(mockLoadPreviewBitmap).toHaveBeenCalledTimes(1);

      // Navigating away aborts the in-flight load; fetch then rejects with
      // an AbortError.
      unmount();
      await act(async () => {
        rejectPreview(new DOMException("aborted", "AbortError"));
        await vi.runAllTimersAsync();
      });

      // No 20MP decode for the image the user already left, and no warning.
      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();
      expect(mockStore.setImageData).not.toHaveBeenCalled();
      expect(mockStore.setPreloadedImage).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      vi.useRealTimers();
    });

    it("shows the thumbnail first and then the preview in the two-phase path", async () => {
      vi.useFakeTimers();
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = null;
      cacheThumbnail();

      render(<ImageViewer />);
      await act(async () => {
        vi.advanceTimersByTime(IMAGE_LOAD_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      // PHASE 1 is the cached thumbnail, PHASE 2 the preview - the
      // full-resolution original is never fetched.
      expect(mockStore.setImageData.mock.calls[0][0]).toEqual(
        expect.objectContaining({ src: "data:jpeg;base64,thumbnailBase64" }),
      );
      expect(mockStore.setImageData.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ src: PREVIEW_SRC(path), tier: "preview" }),
      );
      expect(mockLoadImageViaProtocol).not.toHaveBeenCalled();
      // The PHASE 1 placeholder must be flagged as a thumbnail (so its
      // data-tier / paint:done say "thumbnail"), then cleared by PHASE 2.
      expect(
        mockStore.setThumbnailDisplayed.mock.calls.map((c) => c[0]),
      ).toEqual([true, false]);

      vi.useRealTimers();
    });

    it("keeps GIFs on the full-resolution path (no preview request)", async () => {
      vi.useFakeTimers();
      const gifPath = "/test/anim.gif";
      mockStore.currentImage.path = gifPath;
      mockStore.currentImage.data = null;
      mockStore.folder.imagesByPath.set(gifPath, {
        path: gifPath,
        filename: "anim.gif",
        format: "gif",
      });
      mockStore.cache.thumbnails.set(gifPath, {
        base64: "gifThumb",
        width: 320,
        height: 240,
      });

      render(<ImageViewer />);
      await act(async () => {
        vi.advanceTimersByTime(IMAGE_LOAD_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      expect(mockLoadPreviewBitmap).not.toHaveBeenCalled();
      expect(mockLoadImageViaProtocol).toHaveBeenCalledWith(gifPath);

      vi.useRealTimers();
    });

    it("loads the original directly when no thumbnail is cached (cold path)", async () => {
      vi.useFakeTimers();
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = null;
      mockStore.cache.thumbnails = new Map();

      render(<ImageViewer />);
      await act(async () => {
        vi.advanceTimersByTime(IMAGE_LOAD_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
      });

      expect(mockLoadPreviewBitmap).not.toHaveBeenCalled();
      expect(mockLoadImageViaProtocol).toHaveBeenCalledWith(path);

      vi.useRealTimers();
    });
  });

  describe("zoom-driven full-resolution upgrade", () => {
    const path = "C:\\photos\\big.jpg";
    // A 1620x1080 preview of a 5472x3648 original: fit-to-window is ~29.6%.
    const previewData: AppImageData = {
      path,
      src: PREVIEW_SRC(path),
      width: 5472,
      height: 3648,
      format: "jpg",
      tier: "preview",
    };

    const showPreview = (bitmapWidth = 1620, bitmapHeight = 1080) => {
      setBitmap(path, fakeBitmap(bitmapWidth, bitmapHeight), "preview");
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = previewData;
    };

    it("decodes the full resolution once the zoom passes the preview density", async () => {
      vi.useFakeTimers();
      const fullBitmap = fakeBitmap(5472, 3648);
      mockLoadBitmapViaProtocol.mockResolvedValue({
        data: { ...previewData, src: PROTOCOL_SRC(path), tier: "full" },
        bitmap: fullBitmap,
      });
      showPreview();
      mockStore.view.zoom = 35;

      render(<ImageViewer />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(FULL_UPGRADE_DEBOUNCE_MS);
      });

      expect(mockLoadBitmapViaProtocol).toHaveBeenCalledTimes(1);
      expect(mockLoadBitmapViaProtocol.mock.calls[0][0]).toBe(path);
      expect(getRetained(path)).toEqual({ bitmap: fullBitmap, tier: "full" });
      expect(mockStore.setImageData).toHaveBeenCalledWith(
        expect.objectContaining({
          path,
          src: PROTOCOL_SRC(path),
          width: 5472,
          height: 3648,
          tier: "full",
        }),
      );
      expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
        path,
        expect.objectContaining({ tier: "full" }),
      );

      vi.useRealTimers();
    });

    it("does not upgrade at fit-to-window zoom", async () => {
      vi.useFakeTimers();
      showPreview();
      mockStore.view.zoom = 29;

      render(<ImageViewer />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FULL_UPGRADE_DEBOUNCE_MS * 4);
      });

      expect(mockLoadBitmapViaProtocol).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("does not upgrade an unscaled preview", async () => {
      vi.useFakeTimers();
      showPreview(5472, 3648);
      mockStore.view.zoom = 400;

      render(<ImageViewer />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FULL_UPGRADE_DEBOUNCE_MS * 4);
      });

      expect(mockLoadBitmapViaProtocol).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("does not upgrade when the path changes during the debounce", async () => {
      vi.useFakeTimers();
      showPreview();
      mockStore.view.zoom = 200;

      const { rerender } = render(<ImageViewer />);

      // Navigate away before the debounce elapses.
      mockStore.currentImage.path = "/test/other.jpg";
      mockStore.currentImage.data = null;
      rerender(<ImageViewer />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(FULL_UPGRADE_DEBOUNCE_MS * 4);
      });

      expect(mockLoadBitmapViaProtocol).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("natural size / tier data attributes", () => {
    const path = "C:\\photos\\attrs.jpg";

    it("exposes the natural size and tier on the <img>", () => {
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = {
        path,
        src: PROTOCOL_SRC(path),
        width: 5472,
        height: 3648,
        format: "jpg",
      };

      render(<ImageViewer />);

      const img = screen.getByRole("img");
      expect(img.tagName).toBe("IMG");
      expect(img).toHaveAttribute("data-natural-width", "5472");
      expect(img).toHaveAttribute("data-natural-height", "3648");
      expect(img).toHaveAttribute("data-tier", "full");
    });

    it("exposes the natural size and preview tier on the <canvas>", () => {
      setBitmap(path, fakeBitmap(1620, 1080), "preview");
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = {
        path,
        src: PREVIEW_SRC(path),
        width: 5472,
        height: 3648,
        format: "jpg",
        tier: "preview",
      };

      const { container } = render(<ImageViewer />);

      const canvas = container.querySelector("canvas");
      expect(canvas).toHaveAttribute("data-natural-width", "5472");
      expect(canvas).toHaveAttribute("data-natural-height", "3648");
      expect(canvas).toHaveAttribute("data-tier", "preview");
    });

    it("reports the thumbnail tier while a placeholder is displayed", () => {
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = {
        path,
        src: "data:jpeg;base64,AAAA",
        width: 5472,
        height: 3648,
        format: "jpeg",
      };
      mockStore.ui.thumbnailDisplayed = true;

      render(<ImageViewer />);

      expect(screen.getByRole("img")).toHaveAttribute("data-tier", "thumbnail");
    });
  });
});
