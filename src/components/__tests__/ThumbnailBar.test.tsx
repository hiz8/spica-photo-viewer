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

globalThis.ResizeObserver =
  MockResizeObserver as unknown as typeof ResizeObserver;

const createMockImageInfo = (
  index: number,
  overrides: Partial<ImageInfo> = {},
): ImageInfo => ({
  path: `/test/image${index}.jpg`,
  filename: `image${index}.jpg`,
  size: 1024,
  modified: Math.floor(Date.now() / 1000) - index,
  created: Math.floor(Date.now() / 1000) - index,
  format: "jpeg",
  ...overrides,
});

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
      expect(image).toHaveAttribute("src", "data:image/jpeg;base64,base64data");
      expect(image).toHaveAttribute("alt", "image0.jpg");
    });

    it("should render an empty item (no icon, no image) when no thumbnail data", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;

      render(<ThumbnailBar />);

      // Picasa-style: a not-yet-generated thumbnail is blank space that still
      // occupies its slot (the <button> keeps layout and click target).
      const item = screen.getByRole("button");
      expect(item).toBeEmptyDOMElement();
      expect(item).not.toHaveClass("error");
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(screen.queryByText("⏳")).not.toBeInTheDocument();
    });

    it("should render error placeholder when thumbnail has error", () => {
      const images = [createMockImageInfo(0)];
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;
      mockStoreState.cache.thumbnails.set("/test/image0.jpg", "error");

      render(<ThumbnailBar />);

      expect(screen.getByText("❌")).toBeInTheDocument();
      expect(screen.getByRole("button")).toHaveClass("error");
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
      mockStoreState.currentImage.index = 2;

      render(<ThumbnailBar />);

      const nav = screen.getByRole("navigation");
      fireEvent.wheel(nav, { deltaY: 100 });

      expect(mockStoreState.navigateToImage).not.toHaveBeenCalled();
    });

    it("should not navigate before first image on wheel scroll", () => {
      const images = Array.from({ length: 3 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 0;

      render(<ThumbnailBar />);

      const nav = screen.getByRole("navigation");
      fireEvent.wheel(nav, { deltaY: -100 });

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
        src: "data:image/jpeg;base64,data",
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

      const scrollToMock = vi.fn();
      Element.prototype.scrollTo = scrollToMock;

      render(<ThumbnailBar />);

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

  describe("virtualization", () => {
    // jsdom's window.innerWidth is 1024 → visibleThumbnailRadius = 12; with
    // the render margin that is far fewer than 500 items either way.
    it("renders only the thumbnails around the current image for large folders", () => {
      mockStoreState.folder.images = Array.from({ length: 500 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.currentImage.index = 250;

      render(<ThumbnailBar />);

      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeLessThan(200);
      expect(buttons.length).toBeGreaterThanOrEqual(2 * 4 + 1);
      expect(screen.getByTitle("image250.jpg")).toHaveClass("active");

      // The omitted items are replaced by spacers of exactly their pitch, so
      // offsets (and the centering scroll) are unchanged.
      const spacers = document.querySelectorAll(".thumbnail-spacer");
      expect(spacers).toHaveLength(2);
      const first = Number(buttons[0].getAttribute("data-index"));
      const last = Number(
        buttons[buttons.length - 1].getAttribute("data-index"),
      );
      expect((spacers[0] as HTMLElement).style.width).toBe(`${first * 40}px`);
      expect((spacers[1] as HTMLElement).style.width).toBe(
        `${(499 - last) * 40}px`,
      );
    });

    it("starts the window at the first image when there is no current image", () => {
      mockStoreState.folder.images = Array.from({ length: 500 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.currentImage.index = -1;

      render(<ThumbnailBar />);

      const buttons = screen.getAllByRole("button");
      expect(buttons[0].getAttribute("data-index")).toBe("0");
      expect(buttons.length).toBeLessThan(200);
      // Nothing is omitted on the left, so only the right spacer exists.
      expect(document.querySelectorAll(".thumbnail-spacer")).toHaveLength(1);
    });
  });

  describe("memoization of ThumbnailItem", () => {
    it("should render different state for each thumbnail", () => {
      const images = Array.from({ length: 3 }, (_, i) =>
        createMockImageInfo(i),
      );
      mockStoreState.folder.images = images;
      mockStoreState.currentImage.index = 1;

      mockStoreState.cache.thumbnails.set("/test/image0.jpg", {
        base64: "data0",
        width: 800,
        height: 600,
      });
      // image1 has no cache - loading state
      mockStoreState.cache.thumbnails.set("/test/image2.jpg", "error");

      render(<ThumbnailBar />);

      const items = screen.getAllByRole("button");
      expect(screen.getByAltText("image0.jpg")).toBeInTheDocument(); // Image rendered
      expect(items[1]).toBeEmptyDOMElement(); // Loading: blank slot, no icon
      expect(screen.queryByText("⏳")).not.toBeInTheDocument();
      expect(screen.getByText("❌")).toBeInTheDocument(); // Error placeholder
      expect(items[2]).toHaveClass("error");
    });
  });
});
