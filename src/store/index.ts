import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  RAPID_NAVIGATION_THRESHOLD_MS,
  SUPPRESS_TRANSITION_MS,
} from "../constants/timing";
import type {
  AppState,
  ImageData,
  ImageInfo,
  ThumbnailGenerationState,
  ViewState,
} from "../types";
import { effectiveTier } from "../utils/bitmapCache";
import { displayTierOf } from "../utils/displayTier";
import { getFilename, getFolderPath } from "../utils/path";
import { perfEvent, perfMark } from "../utils/perf";
import {
  centeredPosition,
  fitZoom,
  viewerLayoutArea,
} from "../utils/viewerLayout";
import { windowedClientBox } from "../utils/windowedGeometry";

const layoutArea = (windowed: boolean) =>
  viewerLayoutArea(window.innerWidth, window.innerHeight, windowed);

// Maximize/fullscreen ends windowed mode. The image is re-centered above the
// bar here, with its zoom kept, because the window's resize event may have run
// before the mode flag changed and laid it out for the wrong area.
const leaveWindowedView = (
  state: AppState,
  patch: Partial<ViewState>,
): ViewState => {
  const view = { ...state.view, ...patch };
  if (!state.view.windowed) {
    return view;
  }
  const { imageWidth, imageHeight } = state.view;
  const position =
    imageWidth !== undefined && imageHeight !== undefined
      ? centeredPosition(layoutArea(false), imageWidth, imageHeight)
      : undefined;
  return {
    ...view,
    windowed: false,
    imageLeft: position?.left ?? view.imageLeft,
    imageTop: position?.top ?? view.imageTop,
  };
};

export const thumbnailToImageData = (
  path: string,
  thumbnailCache: { base64: string; width: number; height: number },
): ImageData => ({
  path,
  src: `data:jpeg;base64,${thumbnailCache.base64}`,
  width: thumbnailCache.width,
  height: thumbnailCache.height,
  format: "jpeg",
});

interface AppActions {
  setCurrentImage: (path: string, index: number) => void;
  setImageData: (data: ImageData | null) => void;
  setImageError: (error: Error | null) => void;
  setFolderImages: (path: string, images: ImageInfo[]) => void;
  setView: (view: Partial<ViewState>) => void;
  setZoom: (zoom: number) => void;
  setPan: (panX: number, panY: number) => void;
  setFullscreen: (isFullscreen: boolean) => void;
  setMaximized: (isMaximized: boolean) => void;
  setThumbnailOpacity: (opacity: number) => void;
  setLoading: (isLoading: boolean) => void;
  setDragOver: (isDragOver: boolean) => void;
  setShowAbout: (showAbout: boolean) => void;
  setThumbnailDisplayed: (displayed: boolean) => void;
  setError: (error: Error | null) => void;
  navigateToImage: (index: number) => void;
  navigateNext: () => void;
  navigatePrevious: () => void;
  resetZoom: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** `point*`: pointer offset from the image's transform origin, in screen px. */
  zoomAtPoint: (zoomFactor: number, pointX: number, pointY: number) => void;
  fitToWindow: (
    imageWidth: number,
    imageHeight: number,
    preserveZoom?: boolean,
  ) => void;
  openImageFromPath: (imagePath: string) => Promise<void>;
  setPreloadedImage: (path: string, data: ImageData) => void;
  removePreloadedImage: (path: string) => void;
  removePreloadedImages: (paths: readonly string[]) => void;
  setCachedThumbnail: (
    path: string,
    thumbnail: { base64: string; width: number; height: number } | "error",
  ) => void;
  /** Batch form of setCachedThumbnail: one Map copy and one render for all entries. */
  setCachedThumbnails: (
    entries: ReadonlyArray<
      readonly [
        string,
        { base64: string; width: number; height: number } | "error",
      ]
    >,
  ) => void;
  removeCachedThumbnail: (path: string) => void;
  removeCachedThumbnails: (paths: readonly string[]) => void;
  updateImageDimensions: (width: number, height: number) => void;
  resizeToImage: () => Promise<void>;
  openFileDialog: () => Promise<void>;
  openWithDialog: () => Promise<void>;
  setThumbnailGeneration: (state: Partial<ThumbnailGenerationState>) => void;
  setCheckingStartupFile: (checking: boolean) => void;
}

type AppStore = AppState & AppActions;

export const useAppStore = create<AppStore>((set, get) => ({
  currentImage: {
    path: "",
    index: -1,
    data: null,
    error: null,
  },
  folder: {
    path: "",
    images: [],
    imagesByPath: new Map(),
  },
  view: {
    zoom: 100,
    panX: 0,
    panY: 0,
    isFullscreen: false,
    isMaximized: false,
    windowed: false,
    thumbnailOpacity: 0.5,
  },
  cache: {
    thumbnails: new Map(),
    preloaded: new Map(),
    imageViewStates: new Map(),
    lastNavigationTime: 0,
  },
  thumbnailGeneration: {
    isGenerating: false,
    allGenerated: false,
    currentGeneratingPath: null,
  },
  ui: {
    isLoading: false,
    showAbout: false,
    isDragOver: false,
    error: null,
    suppressTransition: false,
    suppressTransitionTimeoutId: null,
    thumbnailDisplayed: false,
    isCheckingStartupFile: true,
  },

  setCurrentImage: (path, index) =>
    set((state) => ({
      currentImage: {
        ...state.currentImage,
        path,
        index,
        data: null,
        error: null,
      },
    })),

  setImageData: (data) =>
    set((state) => ({
      currentImage: {
        ...state.currentImage,
        data,
      },
    })),

  setImageError: (error) =>
    set((state) => ({
      currentImage: {
        ...state.currentImage,
        error,
      },
    })),

  setFolderImages: (path, images) =>
    set((state) => ({
      folder: {
        path,
        images,
        // Build imagesByPath Map for O(1) lookup performance
        imagesByPath: new Map(images.map((img) => [img.path, img])),
      },
      cache: {
        ...state.cache,
        // Clear all caches when folder changes to prevent unbounded growth
        thumbnails:
          state.folder.path !== path ? new Map() : state.cache.thumbnails,
        preloaded:
          state.folder.path !== path ? new Map() : state.cache.preloaded,
        imageViewStates:
          state.folder.path !== path ? new Map() : state.cache.imageViewStates,
      },
    })),

  setView: (viewUpdate) =>
    set((state) => ({
      view: {
        ...state.view,
        ...viewUpdate,
      },
    })),

  setZoom: (zoom) =>
    set((state) => ({
      view: {
        ...state.view,
        zoom: Math.max(10, Math.min(2000, zoom)),
        panX: 0,
        panY: 0,
      },
    })),

  setPan: (panX, panY) =>
    set((state) => ({
      view: {
        ...state.view,
        panX,
        panY,
      },
    })),

  setFullscreen: (isFullscreen) =>
    set((state) => {
      if (state.view.isFullscreen === isFullscreen) {
        return state;
      }
      return {
        view: isFullscreen
          ? leaveWindowedView(state, { isFullscreen })
          : { ...state.view, isFullscreen },
      };
    }),

  setMaximized: (isMaximized) =>
    set((state) => {
      if (state.view.isMaximized === isMaximized) {
        return state;
      }
      return {
        view: isMaximized
          ? leaveWindowedView(state, { isMaximized })
          : { ...state.view, isMaximized },
      };
    }),

  setThumbnailOpacity: (opacity) =>
    set((state) => ({
      view: {
        ...state.view,
        thumbnailOpacity: opacity,
      },
    })),

  setLoading: (isLoading) =>
    set((state) =>
      state.ui.isLoading === isLoading
        ? state
        : { ui: { ...state.ui, isLoading } },
    ),

  setDragOver: (isDragOver) =>
    set((state) =>
      state.ui.isDragOver === isDragOver
        ? state
        : { ui: { ...state.ui, isDragOver } },
    ),

  setShowAbout: (showAbout) =>
    set((state) =>
      state.ui.showAbout === showAbout
        ? state
        : { ui: { ...state.ui, showAbout } },
    ),

  setThumbnailDisplayed: (displayed) =>
    set((state) => ({
      ui: {
        ...state.ui,
        thumbnailDisplayed: displayed,
      },
    })),

  setError: (error) =>
    set((state) => ({
      ui: {
        ...state.ui,
        error,
      },
    })),

  navigateToImage: (index) => {
    const state = get();
    const images = state.folder.images;
    if (index >= 0 && index < images.length) {
      const image = images[index];

      perfMark("open:request", { path: image.path, index, trigger: "nav" });

      const now = Date.now();
      const lastNavTime = state.cache.lastNavigationTime;
      const isRapidNavigation =
        now - lastNavTime < RAPID_NAVIGATION_THRESHOLD_MS;

      const savedViewState = state.cache.imageViewStates.get(image.path);

      set((state) => {
        const newImageViewStates = new Map(state.cache.imageViewStates);

        // Only save current image's view state if NOT in rapid navigation mode
        if (state.currentImage.path && !isRapidNavigation) {
          newImageViewStates.set(state.currentImage.path, {
            zoom: state.view.zoom,
            panX: state.view.panX,
            panY: state.view.panY,
          });
        }

        // Priority 1: Check if image is already preloaded (full resolution)
        const cachedImage = state.cache.preloaded.get(image.path);
        const hit = !!(cachedImage && cachedImage.format !== "error");
        let imageData: ImageData | null = null;
        let thumbnailDisplayed = false;

        if (cachedImage && cachedImage.format !== "error") {
          // Full resolution available - use it. Label the displayed tier from
          // the bitmap actually retained for this path (the scheduler may
          // have filed an unscaled preview under the preview tier), falling
          // back to the loader's verdict, then "full".
          imageData = {
            ...cachedImage,
            tier:
              effectiveTier(
                image.path,
                cachedImage.width,
                cachedImage.height,
              ) ??
              cachedImage.tier ??
              "full",
          };
        } else {
          // Priority 2: Check if thumbnail is available for instant display
          const cachedThumbnail = state.cache.thumbnails.get(image.path);
          if (cachedThumbnail && cachedThumbnail !== "error") {
            imageData = thumbnailToImageData(image.path, cachedThumbnail);
            thumbnailDisplayed = true;
            console.log(
              `Displaying cached thumbnail instantly: ${getFilename(image.path)}`,
            );
          }
        }

        perfEvent("preload", {
          path: image.path,
          hit,
          tier: imageData?.tier ?? null,
          thumbnailFallback: thumbnailDisplayed,
        });

        const area = layoutArea(state.view.windowed);
        let viewZoom = savedViewState?.zoom ?? 100;
        if (imageData && imageData.width > 0 && !savedViewState) {
          viewZoom = fitZoom(area, imageData.width, imageData.height);
        }

        let viewImagePosition = {};
        if (imageData && imageData.width > 0) {
          const { left, top } = centeredPosition(
            area,
            imageData.width,
            imageData.height,
          );
          viewImagePosition = {
            imageLeft: left,
            imageTop: top,
            imageWidth: imageData.width,
            imageHeight: imageData.height,
          };
        }

        return {
          currentImage: {
            ...state.currentImage,
            path: image.path,
            index,
            data: imageData, // Use cached data if available for instant display, otherwise null
            error: null,
          },
          view: {
            ...state.view,
            zoom: viewZoom,
            panX: savedViewState?.panX ?? 0,
            panY: savedViewState?.panY ?? 0,
            ...viewImagePosition,
          },
          cache: {
            ...state.cache,
            imageViewStates: newImageViewStates,
            lastNavigationTime: now,
          },
          ui: {
            ...state.ui,
            suppressTransition: true,
            thumbnailDisplayed,
            // Atomically create new timeout and store ID to prevent race conditions
            suppressTransitionTimeoutId: (() => {
              if (state.ui.suppressTransitionTimeoutId !== null) {
                clearTimeout(state.ui.suppressTransitionTimeoutId);
              }
              return setTimeout(() => {
                const currentState = get();
                set({
                  ui: {
                    ...currentState.ui,
                    suppressTransition: false,
                    suppressTransitionTimeoutId: null,
                  },
                });
              }, SUPPRESS_TRANSITION_MS);
            })(),
          },
        };
      });
    }
  },

  navigateNext: () => {
    const state = get();
    let nextIndex = state.currentImage.index + 1;

    // Try to find next valid image (skip corrupted ones)
    while (nextIndex < state.folder.images.length) {
      const cachedImage = state.cache.preloaded.get(
        state.folder.images[nextIndex].path,
      );
      if (!cachedImage || cachedImage.format !== "error") {
        get().navigateToImage(nextIndex);
        return;
      }
      nextIndex++;
    }

    if (state.currentImage.index + 1 < state.folder.images.length) {
      get().navigateToImage(state.currentImage.index + 1);
    }
  },

  navigatePrevious: () => {
    const state = get();
    let prevIndex = state.currentImage.index - 1;

    // Try to find previous valid image (skip corrupted ones)
    while (prevIndex >= 0) {
      const cachedImage = state.cache.preloaded.get(
        state.folder.images[prevIndex].path,
      );
      if (!cachedImage || cachedImage.format !== "error") {
        get().navigateToImage(prevIndex);
        return;
      }
      prevIndex--;
    }

    if (state.currentImage.index - 1 >= 0) {
      get().navigateToImage(state.currentImage.index - 1);
    }
  },

  resetZoom: () => {
    const state = get();
    if (state.currentImage.data) {
      get().fitToWindow(
        state.currentImage.data.width,
        state.currentImage.data.height,
      );
    } else {
      set((state) => ({
        view: {
          ...state.view,
          zoom: 100,
          panX: 0,
          panY: 0,
        },
      }));
    }
  },

  zoomIn: () => {
    const state = get();
    const newZoom = Math.min(2000, state.view.zoom * 1.2);
    perfMark("zoom:request", {
      path: state.currentImage.path,
      zoom: newZoom,
      displayedTier: displayTierOf(
        state.currentImage.data,
        state.ui.thumbnailDisplayed,
      ),
    });
    state.setZoom(newZoom);
  },

  zoomOut: () => {
    const state = get();
    const newZoom = Math.max(10, state.view.zoom / 1.2);
    perfMark("zoom:request", {
      path: state.currentImage.path,
      zoom: newZoom,
      displayedTier: displayTierOf(
        state.currentImage.data,
        state.ui.thumbnailDisplayed,
      ),
    });
    state.setZoom(newZoom);
  },

  zoomAtPoint: (zoomFactor, pointX, pointY) => {
    const state = get();
    const currentZoom = state.view.zoom;
    const newZoom = Math.max(10, Math.min(2000, currentZoom * zoomFactor));
    perfMark("zoom:request", {
      path: state.currentImage.path,
      zoom: newZoom,
      displayedTier: displayTierOf(
        state.currentImage.data,
        state.ui.thumbnailDisplayed,
      ),
    });

    if (newZoom !== currentZoom) {
      // pan is a post-scale screen offset, so the pan that pins the image
      // point at `point` is a plain interpolation towards the pointer
      // (docs/code-rationale.md#Z1). `ratio` is derived from the CLAMPED
      // newZoom, so the anchor holds at the 10%/2000% limits too.
      const ratio = newZoom / currentZoom;

      set((state) => ({
        view: {
          ...state.view,
          zoom: newZoom,
          panX: state.view.panX * ratio + pointX * (1 - ratio),
          panY: state.view.panY * ratio + pointY * (1 - ratio),
        },
      }));
    }
  },

  fitToWindow: (imageWidth, imageHeight, preserveZoom = false) => {
    const area = layoutArea(get().view.windowed);
    const zoom = fitZoom(area, imageWidth, imageHeight);
    const { left, top } = centeredPosition(area, imageWidth, imageHeight);

    set((state) => ({
      view: {
        ...state.view,
        zoom: preserveZoom ? state.view.zoom : zoom,
        panX: preserveZoom ? state.view.panX : 0,
        panY: preserveZoom ? state.view.panY : 0,
        imageLeft: left,
        imageTop: top,
        imageWidth,
        imageHeight,
      },
    }));
  },

  openImageFromPath: async (imagePath: string) => {
    // Reopening the image already displayed (e.g. via the file-open dialog)
    // must not blank the viewer: the reset below nulls currentImage.data, and
    // ImageViewer's load effect keys on currentImage.path — unchanged on a
    // same-path reopen — so data would never reload. Nothing to do — the
    // folder and image are already loaded.
    const current = get().currentImage;
    if (
      current.path === imagePath &&
      current.data !== null &&
      current.index >= 0
    ) {
      return;
    }
    try {
      perfMark("open:request", { path: imagePath, trigger: "open" });

      const folderPath = getFolderPath(imagePath);

      // OPTIMIZATION: Immediately set the image path to hide welcome screen
      // and show loading state while folder scan happens in background
      set((state) => ({
        currentImage: {
          ...state.currentImage,
          path: imagePath,
          index: -1, // Will be updated after folder scan
          data: null,
          error: null,
        },
        ui: {
          ...state.ui,
          isLoading: true,
        },
      }));

      // Maximize window immediately (don't wait for folder scan)
      invoke("maximize_window").catch((error) => {
        console.error("Failed to maximize window when opening image:", error);
      });

      // Load all images in the folder (can take time for large folders)
      const images = await invoke<ImageInfo[]>("get_folder_images", {
        path: folderPath,
      });
      perfMark("folder:scanned", { path: imagePath, n: images.length });

      // Check for race condition: user may have navigated away during folder scan
      const currentState = get();
      if (currentState.currentImage.path !== imagePath) {
        console.log(
          "Navigation occurred during folder scan, aborting openImageFromPath",
        );
        return;
      }

      const imageIndex = images.findIndex(
        (img: ImageInfo) => img.path === imagePath,
      );

      if (imageIndex !== -1) {
        set((state) => ({
          folder: {
            ...state.folder,
            path: folderPath,
            images,
          },
          currentImage: {
            ...state.currentImage,
            // Keep path and data unchanged - only update index
            index: imageIndex,
          },
          cache: {
            ...state.cache,
            imageViewStates:
              state.folder.path !== folderPath
                ? new Map()
                : state.cache.imageViewStates,
          },
          ui: {
            ...state.ui,
            isLoading: false,
          },
        }));
      } else {
        console.error("Image not found in folder:", imagePath);
        // Still show the image even if not found in folder list
        // Reset view state since we're showing a different image than requested
        set((state) => ({
          folder: {
            ...state.folder,
            path: folderPath,
            images,
          },
          currentImage: {
            ...state.currentImage,
            index: 0,
          },
          view: {
            ...state.view,
            zoom: 100,
            panX: 0,
            panY: 0,
          },
          ui: {
            ...state.ui,
            isLoading: false,
          },
        }));
      }
    } catch (error) {
      console.error("Failed to open image from path:", error);
      set((state) => ({
        ui: {
          ...state.ui,
          isLoading: false,
          error: new Error(`Failed to open image: ${error}`),
        },
      }));
    }
  },

  setPreloadedImage: (path, data) =>
    set((state) => {
      const newPreloaded = new Map(state.cache.preloaded);
      newPreloaded.set(path, data);
      return {
        cache: {
          ...state.cache,
          preloaded: newPreloaded,
        },
      };
    }),

  removePreloadedImage: (path) =>
    set((state) => {
      const newPreloaded = new Map(state.cache.preloaded);
      newPreloaded.delete(path);
      return {
        cache: {
          ...state.cache,
          preloaded: newPreloaded,
        },
      };
    }),

  removePreloadedImages: (paths) =>
    set((state) => {
      if (paths.length === 0) return state;
      const newPreloaded = new Map(state.cache.preloaded);
      for (const path of paths) {
        newPreloaded.delete(path);
      }
      return {
        cache: {
          ...state.cache,
          preloaded: newPreloaded,
        },
      };
    }),

  setCachedThumbnail: (path, thumbnail) =>
    set((state) => {
      const newThumbnails = new Map(state.cache.thumbnails);
      newThumbnails.set(path, thumbnail);
      return {
        cache: {
          ...state.cache,
          thumbnails: newThumbnails,
        },
      };
    }),

  setCachedThumbnails: (entries) =>
    set((state) => {
      if (entries.length === 0) {
        return state;
      }
      const newThumbnails = new Map(state.cache.thumbnails);
      for (const [path, thumbnail] of entries) {
        newThumbnails.set(path, thumbnail);
      }
      return {
        cache: {
          ...state.cache,
          thumbnails: newThumbnails,
        },
      };
    }),

  removeCachedThumbnail: (path) =>
    set((state) => {
      const newThumbnails = new Map(state.cache.thumbnails);
      newThumbnails.delete(path);
      return {
        cache: {
          ...state.cache,
          thumbnails: newThumbnails,
        },
      };
    }),

  removeCachedThumbnails: (paths) =>
    set((state) => {
      if (paths.length === 0) return state;
      const newThumbnails = new Map(state.cache.thumbnails);
      for (const path of paths) {
        newThumbnails.delete(path);
      }
      return {
        cache: {
          ...state.cache,
          thumbnails: newThumbnails,
        },
      };
    }),

  updateImageDimensions: (imageWidth, imageHeight) => {
    const { left, top } = centeredPosition(
      layoutArea(get().view.windowed),
      imageWidth,
      imageHeight,
    );

    set((state) => ({
      view: {
        ...state.view,
        imageLeft: left,
        imageTop: top,
        imageWidth,
        imageHeight,
      },
    }));
  },

  resizeToImage: async () => {
    const { view, currentImage } = get();
    if (!view.isMaximized || view.isFullscreen || !currentImage.data) {
      return;
    }

    const { width, height } = currentImage.data;
    const box = windowedClientBox({
      imageWidth: width,
      imageHeight: height,
      zoom: view.zoom,
      imageLeft: view.imageLeft ?? 0,
      imageTop: view.imageTop ?? 0,
      panX: view.panX,
      panY: view.panY,
    });

    try {
      await invoke("resize_window_to_image", {
        clientLeft: box.left,
        clientTop: box.top,
        clientWidth: box.width,
        clientHeight: box.height,
      });
    } catch (error) {
      console.error("Failed to resize window to image size:", error);
      return;
    }

    // The window's resize event may fire before or after this point; either
    // way the final layout must be the whole-client-area one, so re-center
    // here as well (the event's fitToWindow sees `windowed` once it is set).
    const { left, top } = centeredPosition(layoutArea(true), width, height);
    set((state) => ({
      view: {
        ...state.view,
        isMaximized: false,
        windowed: true,
        panX: 0,
        panY: 0,
        imageLeft: left,
        imageTop: top,
      },
    }));
  },

  openFileDialog: async () => {
    try {
      set((state) => ({
        ui: {
          ...state.ui,
          isLoading: true,
          error: null,
        },
      }));

      const { open } = await import("@tauri-apps/plugin-dialog");

      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Images",
            extensions: ["jpg", "jpeg", "png", "webp", "gif"],
          },
        ],
      });

      if (selected && typeof selected === "string") {
        await get().openImageFromPath(selected);
      }
    } catch (error) {
      console.error("Failed to open file:", error);
      set((state) => ({
        ui: {
          ...state.ui,
          error: new Error("Failed to open file"),
        },
      }));
      setTimeout(() => {
        set((state) => ({
          ui: {
            ...state.ui,
            error: null,
          },
        }));
      }, 3000);
    } finally {
      set((state) => ({
        ui: {
          ...state.ui,
          isLoading: false,
        },
      }));
    }
  },

  openWithDialog: async () => {
    try {
      const state = get();

      if (!state.currentImage.path) {
        set((state) => ({
          ui: {
            ...state.ui,
            error: new Error("No image is currently loaded"),
          },
        }));
        return;
      }

      await invoke("open_with_dialog", {
        path: state.currentImage.path,
      });
    } catch (error) {
      console.error("Failed to open 'Open With' dialog:", error);
      set((state) => ({
        ui: {
          ...state.ui,
          error: new Error(`Failed to open 'Open With' dialog: ${error}`),
        },
      }));
    }
  },

  setThumbnailGeneration: (thumbnailGenerationUpdate) =>
    set((state) => ({
      thumbnailGeneration: {
        ...state.thumbnailGeneration,
        ...thumbnailGenerationUpdate,
      },
    })),

  setCheckingStartupFile: (checking) =>
    set((state) => ({
      ui: { ...state.ui, isCheckingStartupFile: checking },
    })),
}));
