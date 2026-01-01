import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ImageInfo, ImageData as AppImageData } from "../../types";
import { THUMBNAIL_SCROLL_DEBOUNCE_MS } from "../../constants/timing";

// Mock ResizeObserver before component imports
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

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

// Create default mock store state
const createDefaultMockStore = () => ({
  folder: {
    images: [] as ImageInfo[],
  },
  currentImage: {
    index: -1,
    path: "",
    data: null as AppImageData | null,
  },
  cache: {
    thumbnails: new Map<
      string,
      { base64: string; width: number; height: number } | "error"
    >(),
  },
  navigateToImage: vi.fn(),
});

let mockStoreState = createDefaultMockStore();

vi.mock("../../store", () => ({
  useAppStore: vi.fn(() => mockStoreState),
}));

import ThumbnailBar from "../ThumbnailBar";

describe("ThumbnailBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState = createDefaultMockStore();
  });

  describe("empty state", () => {
    it("should render nothing when no images in folder", () => {
      mockStoreState.folder.images = [];

      const { container } = render(<ThumbnailBar />);

      expect(container.innerHTML).toBe("");
    });
  });

  describe("thumbnail rendering", () => {
    it("should render thumbnail items for all images", () => {
      const images = Array.from({ length: 5 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;

      render(<ThumbnailBar />);

      const thumbnailItems = screen.getAllByRole("button");
      expect(thumbnailItems).toHaveLength(5);
    });

    it("should render image when thumbnail data is available", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;
      mockStoreState.cache.thumbnails.set("/test/image0.jpg", {
        base64: "base64data",
        width: 800,
        height: 600,
      });

      render(<ThumbnailBar />);

      const image = screen.getByRole("img");
      expect(image).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,base64data",
      );
      expect(image).toHaveAttribute("alt", "image0.jpg");
    });

    it("should render loading placeholder when no thumbnail data", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;
      // No thumbnail in cache

      render(<ThumbnailBar />);

      expect(screen.getByText("⏳")).toBeInTheDocument();
    });

    it("should render error placeholder when thumbnail has error", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;
      mockStoreState.cache.thumbnails.set("/test/image0.jpg", "error");

      render(<ThumbnailBar />);

      expect(screen.getByText("❌")).toBeInTheDocument();
    });

    it("should apply active class to current image thumbnail", () => {
      const images = Array.from({ length: 3 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 1;

      render(<ThumbnailBar />);

      const thumbnailItems = screen.getAllByRole("button");
      expect(thumbnailItems[0]).not.toHaveClass("active");
      expect(thumbnailItems[1]).toHaveClass("active");
      expect(thumbnailItems[2]).not.toHaveClass("active");
    });
  });

  describe("user interactions", () => {
    it("should call navigateToImage when thumbnail is clicked", () => {
      const images = Array.from({ length: 3 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;

      render(<ThumbnailBar />);

      const thumbnailItems = screen.getAllByRole("button");
      fireEvent.click(thumbnailItems[2]);

      expect(mockStoreState.navigateToImage).toHaveBeenCalledWith(2);
    });

    it("should navigate to next image on wheel scroll down", () => {
      const images = Array.from({ length: 3 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 1;

      render(<ThumbnailBar />);

      const nav = screen.getByRole("navigation");
      fireEvent.wheel(nav, { deltaY: 100 });

      expect(mockStoreState.navigateToImage).toHaveBeenCalledWith(2);
    });

    it("should navigate to previous image on wheel scroll up", () => {
      const images = Array.from({ length: 3 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 1;

      render(<ThumbnailBar />);

      const nav = screen.getByRole("navigation");
      fireEvent.wheel(nav, { deltaY: -100 });

      expect(mockStoreState.navigateToImage).toHaveBeenCalledWith(0);
    });

    it("should not navigate past last image on wheel scroll", () => {
      const images = Array.from({ length: 3 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 2; // Last image

      render(<ThumbnailBar />);

      const nav = screen.getByRole("navigation");
      fireEvent.wheel(nav, { deltaY: 100 });

      // Should not call navigateToImage because already at last
      expect(mockStoreState.navigateToImage).not.toHaveBeenCalled();
    });

    it("should not navigate before first image on wheel scroll", () => {
      const images = Array.from({ length: 3 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0; // First image

      render(<ThumbnailBar />);

      const nav = screen.getByRole("navigation");
      fireEvent.wheel(nav, { deltaY: -100 });

      // Should not call navigateToImage because already at first
      expect(mockStoreState.navigateToImage).not.toHaveBeenCalled();
    });
  });

  describe("hover state", () => {
    it("should apply hovered class on mouse enter", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;

      render(<ThumbnailBar />);

      const nav = screen.getByRole("navigation");
      expect(nav).not.toHaveClass("hovered");

      fireEvent.mouseEnter(nav);
      expect(nav).toHaveClass("hovered");
    });

    it("should remove hovered class on mouse leave", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;

      render(<ThumbnailBar />);

      const nav = screen.getByRole("navigation");
      fireEvent.mouseEnter(nav);
      expect(nav).toHaveClass("hovered");

      fireEvent.mouseLeave(nav);
      expect(nav).not.toHaveClass("hovered");
    });
  });

  describe("image info display", () => {
    it("should display filename only when no image data loaded", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;
      mockStoreState.currentImage.path = "/test/image0.jpg";
      mockStoreState.currentImage.data = null;

      render(<ThumbnailBar />);

      expect(screen.getByText("image0.jpg")).toBeInTheDocument();
    });

    it("should display filename and dimensions when image data is loaded", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;
      mockStoreState.currentImage.path = "/test/image0.jpg";
      mockStoreState.currentImage.data = {
        path: "/test/image0.jpg",
        base64: "data",
        width: 1920,
        height: 1080,
        format: "jpeg",
      };

      render(<ThumbnailBar />);

      expect(screen.getByText("image0.jpg (1920 × 1080)")).toBeInTheDocument();
    });

    it("should not display info when no current image selected", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = -1;
      mockStoreState.currentImage.path = "";

      render(<ThumbnailBar />);

      expect(screen.queryByText("image0.jpg")).not.toBeInTheDocument();
    });
  });

  describe("scroll behavior", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should debounce scroll to active item", async () => {
      const images = Array.from({ length: 10 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 5;

      // Mock scrollTo
      const scrollToMock = vi.fn();
      Element.prototype.scrollTo = scrollToMock;

      render(<ThumbnailBar />);

      // Advance timers past debounce
      await act(async () => {
        vi.advanceTimersByTime(THUMBNAIL_SCROLL_DEBOUNCE_MS);
      });

      expect(scrollToMock).toHaveBeenCalled();
    });
  });

  describe("accessibility", () => {
    it("should have proper navigation role", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;

      render(<ThumbnailBar />);

      const nav = screen.getByRole("navigation");
      expect(nav).toHaveAttribute("aria-label", "Thumbnail navigation");
    });

    it("should have title attribute on thumbnail buttons", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;

      render(<ThumbnailBar />);

      const button = screen.getByRole("button");
      expect(button).toHaveAttribute("title", "image0.jpg");
    });
  });

  describe("memoization of ThumbnailItem", () => {
    it("should render different state for each thumbnail", () => {
      const images = Array.from({ length: 3 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 1;

      // Set different states for thumbnails
      mockStoreState.cache.thumbnails.set("/test/image0.jpg", {
        base64: "data0",
        width: 800,
        height: 600,
      });
      // image1 has no cache - loading state
      mockStoreState.cache.thumbnails.set("/test/image2.jpg", "error");

      render(<ThumbnailBar />);

      // Check different states are rendered
      expect(screen.getByAltText("image0.jpg")).toBeInTheDocument(); // Image rendered
      expect(screen.getByText("⏳")).toBeInTheDocument(); // Loading placeholder
      expect(screen.getByText("❌")).toBeInTheDocument(); // Error placeholder
    });
  });
});
