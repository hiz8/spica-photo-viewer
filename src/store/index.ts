import { create } from 'zustand';
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
    const nextIndex = state.currentImage.index + 1;
    if (nextIndex < state.folder.images.length) {
      state.navigateToImage(nextIndex);
    }
  },

  navigatePrevious: () => {
    const state = get();
    const prevIndex = state.currentImage.index - 1;
    if (prevIndex >= 0) {
      state.navigateToImage(prevIndex);
    }
  },

  resetZoom: () => {
    set((state) => ({
      view: {
        ...state.view,
        zoom: 100,
        panX: 0,
        panY: 0,
      },
    }));
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
}));