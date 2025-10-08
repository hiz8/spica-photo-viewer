import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AppState, ImageInfo, ImageData, ViewState } from "../types";

// Constants
const THUMBNAIL_BAR_HEIGHT = 80;

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
  setError: (error: Error | null) => void;
  navigateToImage: (index: number) => void;
  navigateNext: () => void;
  navigatePrevious: () => void;
  resetZoom: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomAtPoint: (zoomFactor: number, pointX: number, pointY: number) => void;
  fitToWindow: (
    imageWidth: number,
    imageHeight: number,
    preserveZoom?: boolean,
  ) => void;
  openImageFromPath: (imagePath: string) => Promise<void>;
  setPreloadedImage: (path: string, data: ImageData) => void;
  removePreloadedImage: (path: string) => void;
  updateImageDimensions: (width: number, height: number) => void;
  resizeToImage: () => Promise<void>;
  openFileDialog: () => Promise<void>;
  openWithDialog: () => Promise<void>;
}

type AppStore = AppState & AppActions;

export const useAppStore = create<AppStore>((set, get) => ({
  // Initial state
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

  // Actions
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
        sortOrder: "name",
      },
      cache: {
        ...state.cache,
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
    set((state) => ({
      view: {
        ...state.view,
        isFullscreen,
      },
    })),

  setMaximized: (isMaximized) =>
    set((state) => ({
      view: {
        ...state.view,
        isMaximized,
      },
    })),

  setThumbnailOpacity: (opacity) =>
    set((state) => ({
      view: {
        ...state.view,
        thumbnailOpacity: opacity,
      },
    })),

  setLoading: (isLoading) =>
    set((state) => ({
      ui: {
        ...state.ui,
        isLoading,
      },
    })),

  setDragOver: (isDragOver) =>
    set((state) => ({
      ui: {
        ...state.ui,
        isDragOver,
      },
    })),

  setShowAbout: (showAbout) =>
    set((state) => ({
      ui: {
        ...state.ui,
        showAbout,
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

      // Restore saved view state for the new image, or use default
      const savedViewState = state.cache.imageViewStates.get(image.path);

      set((state) => {
        // Create new imageViewStates Map with current image's state saved
        const newImageViewStates = new Map(state.cache.imageViewStates);
        if (state.currentImage.path) {
          newImageViewStates.set(state.currentImage.path, {
            zoom: state.view.zoom,
            panX: state.view.panX,
            panY: state.view.panY,
          });
        }

        return {
          currentImage: {
            ...state.currentImage,
            path: image.path,
            index,
            data: null,
            error: null,
          },
          view: {
            ...state.view,
            zoom: savedViewState?.zoom ?? 100,
            panX: savedViewState?.panX ?? 0,
            panY: savedViewState?.panY ?? 0,
          },
          cache: {
            ...state.cache,
            imageViewStates: newImageViewStates,
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

    // If no valid image found, try the regular navigation
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

    // If no valid image found, try the regular navigation
    if (state.currentImage.index - 1 >= 0) {
      get().navigateToImage(state.currentImage.index - 1);
    }
  },

  resetZoom: () => {
    const state = get();
    if (state.currentImage.data) {
      // Reset to fit-to-window when resetting zoom
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
    state.setZoom(newZoom);
  },

  zoomOut: () => {
    const state = get();
    const newZoom = Math.max(10, state.view.zoom / 1.2);
    state.setZoom(newZoom);
  },

  zoomAtPoint: (zoomFactor, pointX, pointY) => {
    const state = get();
    const currentZoom = state.view.zoom;
    const newZoom = Math.max(10, Math.min(2000, currentZoom * zoomFactor));

    if (newZoom !== currentZoom) {
      // Convert screen coordinates to image coordinates before zoom
      const currentScale = currentZoom / 100;
      const imageX = pointX / currentScale - state.view.panX;
      const imageY = pointY / currentScale - state.view.panY;

      // Calculate new pan so that the same image point stays under the mouse
      const newScale = newZoom / 100;
      const newPanX = pointX / newScale - imageX;
      const newPanY = pointY / newScale - imageY;

      set((state) => ({
        view: {
          ...state.view,
          zoom: newZoom,
          panX: newPanX,
          panY: newPanY,
        },
      }));
    }
  },

  fitToWindow: (imageWidth, imageHeight, preserveZoom = false) => {
    const MARGIN = 20;

    // Calculate available display area with proper margins
    const availableWidth = window.innerWidth - MARGIN * 2;
    const availableHeight =
      window.innerHeight - THUMBNAIL_BAR_HEIGHT - MARGIN * 2;

    // Calculate scale factors for both dimensions
    const scaleX = availableWidth / imageWidth;
    const scaleY = availableHeight / imageHeight;

    // Use the smaller scale to ensure both dimensions fit within available space
    const fitScale = Math.min(scaleX, scaleY);

    // Only scale down if the image is larger than available space (fitScale < 1)
    // Keep images at 100% if they fit within the window (fitScale >= 1)
    const fitZoom = fitScale >= 1 ? 100 : Math.max(10, fitScale * 100);

    // Calculate center position for the original image (before CSS scaling)
    // CSS transform will scale from the center (transform-origin: center)
    const containerWidth = window.innerWidth;
    const containerHeight = window.innerHeight - THUMBNAIL_BAR_HEIGHT;

    // Position the original image so its center aligns with container center
    const centerX = (containerWidth - imageWidth) / 2;
    const centerY = (containerHeight - imageHeight) / 2;

    set((state) => ({
      view: {
        ...state.view,
        zoom: preserveZoom ? state.view.zoom : fitZoom,
        panX: preserveZoom ? state.view.panX : 0,
        panY: preserveZoom ? state.view.panY : 0,
        // Store original image dimensions and calculated position
        imageLeft: centerX,
        imageTop: centerY,
        imageWidth, // Original image width
        imageHeight, // Original image height
      },
    }));
  },

  openImageFromPath: async (imagePath: string) => {
    try {
      // Get the folder containing the image (handle both \\ and / separators)
      const lastSlashIndex = Math.max(
        imagePath.lastIndexOf("\\"),
        imagePath.lastIndexOf("/"),
      );
      const folderPath = imagePath.substring(0, lastSlashIndex);

      // Load all images in the folder
      const images = await invoke<ImageInfo[]>("get_folder_images", {
        path: folderPath,
      });

      // Find the index of the specific image
      const imageIndex = images.findIndex(
        (img: ImageInfo) => img.path === imagePath,
      );

      if (imageIndex !== -1) {
        // Maximize window when opening an image
        try {
          await invoke("maximize_window");
        } catch (error) {
          console.error("Failed to maximize window when opening image:", error);
        }

        set((state) => ({
          folder: {
            ...state.folder,
            path: folderPath,
            images,
          },
          currentImage: {
            ...state.currentImage,
            path: imagePath,
            index: imageIndex,
            data: null,
            error: null,
          },
          view: {
            ...state.view,
            zoom: 100,
            panX: 0,
            panY: 0,
          },
          cache: {
            ...state.cache,
            imageViewStates:
              state.folder.path !== folderPath
                ? new Map()
                : state.cache.imageViewStates,
          },
        }));
      } else {
        console.error("Image not found in folder:", imagePath);
      }
    } catch (error) {
      console.error("Failed to open image from path:", error);
      set((state) => ({
        ui: {
          ...state.ui,
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

  updateImageDimensions: (imageWidth, imageHeight) => {
    const containerWidth = window.innerWidth;
    const containerHeight = window.innerHeight - THUMBNAIL_BAR_HEIGHT;
    const centerX = (containerWidth - imageWidth) / 2;
    const centerY = (containerHeight - imageHeight) / 2;

    set((state) => ({
      view: {
        ...state.view,
        imageLeft: centerX,
        imageTop: centerY,
        imageWidth,
        imageHeight,
      },
    }));
  },

  resizeToImage: async () => {
    try {
      const state = get();

      // Check if conditions are met for resizing
      if (
        !state.view.isMaximized ||
        state.view.isFullscreen ||
        !state.currentImage.data
      ) {
        return;
      }

      const { width, height } = state.currentImage.data;
      const currentZoom = state.view.zoom;

      // Get image element to calculate its actual screen position
      const imageElement = document.querySelector(
        ".image-viewer img",
      ) as HTMLImageElement;
      if (imageElement) {
        const rect = imageElement.getBoundingClientRect();

        // Calculate center of the image on screen
        const imageScreenCenterX = rect.left + rect.width / 2;
        const imageScreenCenterY = rect.top + rect.height / 2;

        await invoke("resize_window_to_image", {
          imageWidth: width,
          imageHeight: height,
          zoomPercent: currentZoom,
          imageScreenCenterX: imageScreenCenterX,
          imageScreenCenterY: imageScreenCenterY,
          disableAnimation: true,
        });

        // Update maximized state and reset pan values to center the image in new window
        set((state) => ({
          view: {
            ...state.view,
            isMaximized: false,
            panX: 0,
            panY: 0,
          },
        }));
      } else {
        console.error("Could not find image element for positioning");
      }
    } catch (error) {
      console.error("Failed to resize window to image size:", error);
    }
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
        // Use openImageFromPath to handle the rest
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

      // Check if there's a current image loaded
      if (!state.currentImage.path) {
        set((state) => ({
          ui: {
            ...state.ui,
            error: new Error("No image is currently loaded"),
          },
        }));
        return;
      }

      // Call the Tauri command to open the "Open With" dialog
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
}));
