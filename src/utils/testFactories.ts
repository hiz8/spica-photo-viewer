import { vi } from "vitest";
import type { ImageData, ImageInfo } from "../types";

// Image data factories
export const createImageData = (
  overrides: Partial<ImageData> = {},
): ImageData => ({
  path: "/test/image.jpg",
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  width: 800,
  height: 600,
  format: "jpeg",
  ...overrides,
});

export const createImageInfo = (
  overrides: Partial<ImageInfo> = {},
): ImageInfo => ({
  path: "/test/image.jpg",
  filename: "image.jpg",
  size: 1024,
  modified: Date.now(),
  format: "jpeg",
  ...overrides,
});

export const createImageList = (
  count: number = 3,
  baseName: string = "image",
): ImageInfo[] => {
  return Array.from({ length: count }, (_, index) =>
    createImageInfo({
      path: `/test/${baseName}${index + 1}.jpg`,
      filename: `${baseName}${index + 1}.jpg`,
      modified: Date.now() - (count - index) * 1000,
    }),
  );
};

export const createErrorImageData = (
  path: string = "/test/error.jpg",
): ImageData => ({
  path,
  base64: "",
  width: 0,
  height: 0,
  format: "error",
});

// Mock factories
export const createMockTauriApi = () => ({
  invoke: vi.fn(),
  open: vi.fn(),
  getVersion: vi.fn(() => Promise.resolve("1.0.0")),
  getCurrentWindow: vi.fn(() => ({
    isFullscreen: vi.fn(),
    setFullscreen: vi.fn(),
    close: vi.fn(),
  })),
});

// Store state factories
export const createImageViewerState = (
  overrides: Record<string, unknown> = {},
) => ({
  currentImage: {
    path: "/test/image.jpg",
    index: 0,
    data: createImageData(),
    error: null,
  },
  folder: {
    path: "/test",
    images: createImageList(),
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
  ...overrides,
});

export const createEmptyViewerState = () => ({
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
});

export const createErrorViewerState = (error: Error) => ({
  ...createEmptyViewerState(),
  currentImage: {
    path: "/test/image.jpg",
    index: 0,
    data: null,
    error,
  },
});

export const createLoadingViewerState = () => ({
  ...createEmptyViewerState(),
  currentImage: {
    path: "/test/image.jpg",
    index: 0,
    data: null,
    error: null,
  },
  ui: {
    isLoading: true,
    showAbout: false,
    isDragOver: false,
    error: null,
  },
});

// Common test scenarios
export const createTestScenario = {
  withImage: () => createImageViewerState(),
  empty: () => createEmptyViewerState(),
  loading: () => createLoadingViewerState(),
  withError: (message: string = "Test error") =>
    createErrorViewerState(new Error(message)),
  withAboutDialog: () =>
    createImageViewerState({
      ui: {
        isLoading: false,
        showAbout: true,
        isDragOver: false,
        error: null,
      },
    }),
};
