import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { AppState, ImageInfo, ImageData, ViewState } from '../types';

interface AppActions {
  setCurrentImage: (path: string, index: number) => void;
  setImageData: (data: ImageData | null) => void;
  setImageError: (error: Error | null) => void;
  setFolderImages: (path: string, images: ImageInfo[]) => void;
  setView: (view: Partial<ViewState>) => void;
  setZoom: (zoom: number) => void;
  setPan: (panX: number, panY: number) => void;
  setFullscreen: (isFullscreen: boolean) => void;
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
  fitToWindow: (imageWidth: number, imageHeight: number) => void;
  openImageFromPath: (imagePath: string) => Promise<void>;
  setPreloadedImage: (path: string, data: ImageData) => void;
  removePreloadedImage: (path: string) => void;
}

type AppStore = AppState & AppActions;

export const useAppStore = create<AppStore>((set, get) => ({
  // Initial state
  currentImage: {
    path: '',
    index: -1,
    data: null,
    error: null,
  },
  folder: {
    path: '',
    images: [],
    sortOrder: 'name',
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
    set(() => ({
      folder: {
        path,
        images,
        sortOrder: 'name',
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
      set((state) => ({
        currentImage: {
          ...state.currentImage,
          path: image.path,
          index,
          data: null,
          error: null,
        },
        view: {
          ...state.view,
          zoom: 100,
          panX: 0,
          panY: 0,
        },
      }));
    }
  },

  navigateNext: () => {
    const state = get();
    let nextIndex = state.currentImage.index + 1;

    // Try to find next valid image (skip corrupted ones)
    while (nextIndex < state.folder.images.length) {
      const cachedImage = state.cache.preloaded.get(state.folder.images[nextIndex].path);
      if (!cachedImage || cachedImage.format !== 'error') {
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
      const cachedImage = state.cache.preloaded.get(state.folder.images[prevIndex].path);
      if (!cachedImage || cachedImage.format !== 'error') {
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
      state.fitToWindow(state.currentImage.data.width, state.currentImage.data.height);
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
      const imageX = (pointX / currentScale) - state.view.panX;
      const imageY = (pointY / currentScale) - state.view.panY;

      // Calculate new pan so that the same image point stays under the mouse
      const newScale = newZoom / 100;
      const newPanX = (pointX / newScale) - imageX;
      const newPanY = (pointY / newScale) - imageY;

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

  fitToWindow: (imageWidth, imageHeight) => {
    const THUMBNAIL_BAR_HEIGHT = 80;
    const MARGIN = 20;

    // Calculate available display area
    const availableWidth = window.innerWidth - (MARGIN * 2);
    const availableHeight = window.innerHeight - THUMBNAIL_BAR_HEIGHT - (MARGIN * 2);

    // Calculate scale factors for both dimensions
    const scaleX = availableWidth / imageWidth;
    const scaleY = availableHeight / imageHeight;

    // Use the smaller scale to ensure both dimensions fit
    const fitScale = Math.min(scaleX, scaleY);

    // Don't zoom in beyond 100% (only zoom out if necessary)
    const fitZoom = Math.min(100, fitScale * 100);

    // Calculate the actual displayed image dimensions after scaling
    const displayedWidth = imageWidth * (fitZoom / 100);
    const displayedHeight = imageHeight * (fitZoom / 100);

    // Calculate center position within the container
    const containerWidth = window.innerWidth;
    const containerHeight = window.innerHeight - THUMBNAIL_BAR_HEIGHT;

    // Position image at center of available space
    const centerX = (containerWidth - displayedWidth) / 2;
    const centerY = (containerHeight - displayedHeight) / 2;

    set((state) => ({
      view: {
        ...state.view,
        zoom: fitZoom,
        panX: 0,
        panY: 0,
        // Store positioning data for the ImageViewer component
        imageLeft: centerX,
        imageTop: centerY,
        imageWidth: displayedWidth,
        imageHeight: displayedHeight,
      },
    }));
  },

  openImageFromPath: async (imagePath: string) => {
    try {
      // Get the folder containing the image (handle both \ and / separators)
      const lastSlashIndex = Math.max(imagePath.lastIndexOf('\\'), imagePath.lastIndexOf('/'));
      const folderPath = imagePath.substring(0, lastSlashIndex);

      // Load all images in the folder
      const images = await invoke<ImageInfo[]>('get_folder_images', { path: folderPath });

      // Find the index of the specific image
      const imageIndex = images.findIndex((img: ImageInfo) => img.path === imagePath);

      if (imageIndex !== -1) {
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
        }));
      } else {
        console.error('Image not found in folder:', imagePath);
      }
    } catch (error) {
      console.error('Failed to open image from path:', error);
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
}));