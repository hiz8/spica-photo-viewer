import type React from "react";
import { render, type RenderOptions, act } from "@testing-library/react";
import { vi } from "vitest";
import type { ImageData, ImageInfo } from "../types";

// Test utilities for common test scenarios

// Sample test data
export const mockImageData: ImageData = {
  path: "/test/image.jpg",
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  width: 800,
  height: 600,
  format: "jpeg",
};

export const mockImageInfo: ImageInfo = {
  path: "/test/image.jpg",
  filename: "image.jpg",
  width: 800,
  height: 600,
  size: 1024,
  modified: Date.now(),
  format: "jpeg",
};

export const mockImageList: ImageInfo[] = [
  {
    path: "/test/image1.jpg",
    filename: "image1.jpg",
    width: 800,
    height: 600,
    size: 1024,
    modified: Date.now() - 3000,
    format: "jpeg",
  },
  {
    path: "/test/image2.png",
    filename: "image2.png",
    width: 1024,
    height: 768,
    size: 2048,
    modified: Date.now() - 2000,
    format: "png",
  },
  {
    path: "/test/image3.gif",
    filename: "image3.gif",
    width: 400,
    height: 300,
    size: 512,
    modified: Date.now() - 1000,
    format: "gif",
  },
];

// Custom render function that can include providers
export const renderWithProviders = (
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) => {
  return render(ui, options);
};

// Async render helper that wraps components in act()
export const renderAsync = async (
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) => {
  let result: any;
  await act(async () => {
    result = render(ui, options);
  });
  return result;
};

// Store mock factory
export const createMockStore = (overrides: any = {}) => ({
  currentImage: {
    path: "",
    index: -1,
    data: null,
    error: null,
  },
  folder: {
    path: "",
    images: [],
    sortOrder: "name" as const,
  },
  view: {
    zoom: 100,
    panX: 0,
    panY: 0,
    isFullscreen: false,
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
  // Mock functions
  setCurrentImage: vi.fn(),
  setImageData: vi.fn(),
  setImageError: vi.fn(),
  setFolderImages: vi.fn(),
  setView: vi.fn(),
  setZoom: vi.fn(),
  setPan: vi.fn(),
  setFullscreen: vi.fn(),
  setThumbnailOpacity: vi.fn(),
  setLoading: vi.fn(),
  setDragOver: vi.fn(),
  setShowAbout: vi.fn(),
  setError: vi.fn(),
  navigateToImage: vi.fn(),
  navigateNext: vi.fn(),
  navigatePrevious: vi.fn(),
  resetZoom: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  zoomAtPoint: vi.fn(),
  fitToWindow: vi.fn(),
  openImageFromPath: vi.fn(),
  setPreloadedImage: vi.fn(),
  removePreloadedImage: vi.fn(),
  updateImageDimensions: vi.fn(),
  resizeToImage: vi.fn(),
  ...overrides,
});

// Wait for async operations with act wrapper
export const waitForAsync = async (callback: () => void | Promise<void>) => {
  await act(async () => {
    if (typeof callback === "function") {
      await callback();
    }
  });
};

// Standardized async test patterns
export const asyncTestPatterns = {
  // Render component with async operations
  renderWithAsyncOps: async (
    ui: React.ReactElement,
    options?: Omit<RenderOptions, "wrapper">,
  ) => {
    let result: any;
    await act(async () => {
      result = render(ui, options);
    });
    return result;
  },

  // Wait for component to settle after async operations
  waitForComponentToSettle: async (callback?: () => void | Promise<void>) => {
    await act(async () => {
      if (callback) {
        await callback();
      }
      // Give React time to process all updates
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  },

  // Execute async action and wait for completion
  executeAsyncAction: async (action: () => void | Promise<void>) => {
    await act(async () => {
      await action();
    });
  },

  // Wait for expectations with act wrapper
  waitForExpectations: async (expectations: () => void | Promise<void>) => {
    await act(async () => {
      await vi.waitFor(async () => {
        await expectations();
      });
    });
  },
};

// Mock window resize helper
export const mockWindowResize = (width: number, height: number) => {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    writable: true,
    configurable: true,
    value: height,
  });
  window.dispatchEvent(new Event("resize"));
};

// Mock mouse event helpers
export const createMouseEvent = (
  type: string,
  clientX: number = 0,
  clientY: number = 0,
  button: number = 0,
): MouseEvent => {
  return new MouseEvent(type, {
    clientX,
    clientY,
    button,
    bubbles: true,
    cancelable: true,
  });
};

// Mock wheel event helper
export const createWheelEvent = (
  deltaY: number,
  clientX: number = 0,
  clientY: number = 0,
): WheelEvent => {
  return new WheelEvent("wheel", {
    deltaY,
    clientX,
    clientY,
    bubbles: true,
    cancelable: true,
  });
};

// Mock keyboard event helper
export const createKeyboardEvent = (
  key: string,
  ctrlKey: boolean = false,
): KeyboardEvent => {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey,
    bubbles: true,
    cancelable: true,
  });
};
