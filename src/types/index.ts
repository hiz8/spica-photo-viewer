export interface ImageInfo {
  path: string;
  filename: string;
  size: number;
  modified: number;
  created: number;
  format: "jpeg" | "png" | "webp" | "gif";
}

export interface ImageData {
  path: string;
  /** Renderable URL: a data: URL (thumbnails / legacy pipeline) or a spica-img protocol URL */
  src: string;
  width: number;
  height: number;
  format: string;
  /** Decoded tier behind this entry: display-resolution preview or full resolution. Undefined = full (legacy). */
  tier?: "preview" | "full";
}

export interface ProgressiveImageData {
  path: string;
  preview: ImageData | null;
  full: ImageData;
  is_high_resolution: boolean;
}

export interface ThumbnailWithDimensions {
  thumbnail_base64: string;
  original_width: number;
  original_height: number;
  preview_available: boolean;
}

export interface UIState {
  isLoading: boolean;
  showAbout: boolean;
  isDragOver: boolean;
  error: Error | null;
  suppressTransition: boolean;
  suppressTransitionTimeoutId: ReturnType<typeof setTimeout> | null;
  thumbnailDisplayed?: boolean; // Whether current display is thumbnail (not full resolution)
  isCheckingStartupFile: boolean; // Whether startup file check is in progress
}

export interface ImageViewState {
  zoom: number;
  panX: number;
  panY: number;
}

export interface AppState {
  currentImage: {
    path: string;
    index: number;
    data: ImageData | null;
    error: Error | null;
  };

  folder: {
    path: string;
    images: ImageInfo[];
    imagesByPath: Map<string, ImageInfo>;
  };

  view: {
    zoom: number;
    panX: number;
    panY: number;
    isFullscreen: boolean;
    isMaximized: boolean;
    thumbnailOpacity: number;
    imageLeft?: number;
    imageTop?: number;
    imageWidth?: number;
    imageHeight?: number;
  };

  cache: {
    thumbnails: Map<
      string,
      { base64: string; width: number; height: number } | "error"
    >;
    preloaded: Map<string, ImageData>;
    imageViewStates: Map<string, ImageViewState>;
    lastNavigationTime: number; // Timestamp of last navigation for detecting rapid navigation
  };

  thumbnailGeneration: ThumbnailGenerationState;

  ui: UIState;
}

export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
  isFullscreen: boolean;
  isMaximized: boolean;
  thumbnailOpacity: number;
  imageLeft?: number;
  imageTop?: number;
  imageWidth?: number;
  imageHeight?: number;
}

export interface FolderState {
  path: string;
  images: ImageInfo[];
}

export interface CurrentImageState {
  path: string;
  index: number;
  data: ImageData | null;
  error: Error | null;
}

export interface ThumbnailGenerationState {
  isGenerating: boolean;
  allGenerated: boolean;
  currentGeneratingPath: string | null;
}

export interface CacheState {
  thumbnails: Map<
    string,
    { base64: string; width: number; height: number } | "error"
  >;
  preloaded: Map<string, ImageData>;
  imageViewStates: Map<string, ImageViewState>;
  lastNavigationTime: number; // Timestamp of last navigation for detecting rapid navigation
}

export interface KeyboardShortcuts {
  ArrowLeft: () => void;
  ArrowRight: () => void;
  ArrowUp: () => void;
  ArrowDown: () => void;
  F11: () => void;
  Escape: () => void;
  "Ctrl+0": () => void;
}

export interface ZoomPanState {
  zoom: number;
  panX: number;
  panY: number;
  isDragging: boolean;
  lastMouseX: number;
  lastMouseY: number;
}

export interface WindowState {
  is_maximized: boolean;
  is_fullscreen: boolean;
}
