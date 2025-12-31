import type React from "react";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useThumbnailGenerator } from "../hooks/useThumbnailGenerator";
import { useImagePreloader } from "../hooks/useImagePreloader";
import type {
  ImageData as AppImageData,
} from "../types";
import {
  IMAGE_LOAD_DEBOUNCE_MS,
} from "../constants/timing";

interface ImageViewerProps {
  className?: string;
}

const ImageViewer: React.FC<ImageViewerProps> = ({ className = "" }) => {
  const {
    currentImage,
    view,
    ui,
    setImageData,
    setImageError,
    setLoading,
    setPan,
    zoomAtPoint,
    fitToWindow,
    updateImageDimensions,
    resizeToImage,
    setPreloadedImage,
  } = useAppStore();

  // Initialize thumbnail generation and preloading
  useThumbnailGenerator();
  useImagePreloader();

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeLoadPathRef = useRef<string | null>(null);

  const suppressTransition = ui.suppressTransition;

  const loadImage = useCallback(
    async (path: string, signal: AbortSignal) => {
      // Mark this path as actively loading
      activeLoadPathRef.current = path;

      try {
        // Get fresh cache state to avoid dependency on volatile Maps
        const {
          cache: currentCache,
          folder,
          currentImage: current,
          ui: currentUi,
        } = useAppStore.getState();

        // Check if we already have full resolution data (not just thumbnail)
        const hasFullResolution =
          current.path === path &&
          current.data &&
          current.data.path === path &&
          current.data.width > 0 && // Thumbnails have width=0 initially
          !currentUi.thumbnailDisplayed; // Not just a thumbnail display

        if (hasFullResolution) {
          // Full resolution already loaded by navigateToImage - skip
          return;
        }

        // FAST PATH: If thumbnail is displayed, upgrade to full resolution immediately
        // Skip debounce since something is already visible
        const isThumbnailUpgrade = currentUi.thumbnailDisplayed && current.path === path;

        if (isThumbnailUpgrade) {
          console.log(`Upgrading thumbnail to full resolution: ${path.split(/[\\/]/).pop()}`);

          // Load full resolution directly
          const fullImageData = await invoke<AppImageData>("load_image", { path });

          if (signal.aborted || activeLoadPathRef.current !== path) {
            return;
          }

          // Update with full resolution
          setImageData(fullImageData);

          // Check if this image has saved view state
          const hasSavedState = currentCache.imageViewStates.has(path);

          // Update dimensions
          if (!hasSavedState) {
            fitToWindow(fullImageData.width, fullImageData.height);
          } else {
            updateImageDimensions(fullImageData.width, fullImageData.height);
          }

          // Add to preload cache
          setPreloadedImage(path, fullImageData);

          // Clear thumbnail flag
          useAppStore.setState((state) => ({
            ui: { ...state.ui, thumbnailDisplayed: false },
          }));

          return;
        }

        // Check if this image has saved view state
        const hasSavedState = currentCache.imageViewStates.has(path);

        // Check if image is already preloaded
        const preloadedImage = currentCache.preloaded.get(path);
        if (preloadedImage) {
          if (preloadedImage.format === "error") {
            throw new Error("Image failed to load previously");
          }

          // Check if loading was cancelled or navigation changed
          if (signal.aborted || activeLoadPathRef.current !== path) {
            return;
          }

          setImageData(preloadedImage);

          // Auto-fit or update dimensions based on saved state
          if (!hasSavedState) {
            fitToWindow(preloadedImage.width, preloadedImage.height);
          } else {
            updateImageDimensions(preloadedImage.width, preloadedImage.height);
          }
          return;
        }

        // Image not preloaded - set loading state before invoking backend
        setLoading(true);
        setImageError(null);

        // Get image info from folder to determine format (O(1) lookup)
        const imageInfo = folder.imagesByPath.get(path);

        // Use two-phase loading for all images except GIFs (to preserve animation)
        const skipProgressive = imageInfo?.format === "gif";

        // Two-phase loading for non-GIF images
        if (!skipProgressive) {
          // Try to use cached thumbnail as preview
          const cachedThumbnail = currentCache.thumbnails.get(path);
          if (cachedThumbnail && cachedThumbnail !== "error") {
            try {
              // PHASE 1: Display thumbnail preview immediately with cached dimensions
              // No need to call get_image_dimensions_only since thumbnail includes dimensions

              // Check if loading was cancelled
              if (signal.aborted || activeLoadPathRef.current !== path) {
                return;
              }

              // Display cached thumbnail as preview with correct dimensions
              const previewData: AppImageData = {
                path,
                base64: cachedThumbnail.base64,
                width: cachedThumbnail.width,
                height: cachedThumbnail.height,
                format: "jpeg",
              };
              setImageData(previewData);

              // Fit to window or restore saved view state
              if (!hasSavedState) {
                fitToWindow(cachedThumbnail.width, cachedThumbnail.height);
              } else {
                updateImageDimensions(cachedThumbnail.width, cachedThumbnail.height);
              }

              // PHASE 2: Load full resolution image in background
              const fullImageData = await invoke<AppImageData>("load_image", { path });

              // Check if loading was cancelled
              if (signal.aborted || activeLoadPathRef.current !== path) {
                return;
              }

              // Replace with full resolution
              setImageData(fullImageData);

              // Update dimensions if needed
              if (!hasSavedState) {
                fitToWindow(fullImageData.width, fullImageData.height);
              } else {
                updateImageDimensions(fullImageData.width, fullImageData.height);
              }

              // Add to preload cache
              setPreloadedImage(path, fullImageData);
              return;
            } catch (error) {
              console.warn(
                "Failed to use cached thumbnail preview, loading full image directly:",
                error,
              );
              // Fall through to direct load
            }
          }

          // Direct load (no cached thumbnail)
          const fullImageData = await invoke<AppImageData>("load_image", {
            path,
          });

          // Check if loading was cancelled
          if (signal.aborted || activeLoadPathRef.current !== path) {
            return;
          }

          setImageData(fullImageData);

          // Fit to window or update dimensions based on saved state
          if (!hasSavedState) {
            fitToWindow(fullImageData.width, fullImageData.height);
          } else {
            updateImageDimensions(fullImageData.width, fullImageData.height);
          }

          // Add to preload cache
          setPreloadedImage(path, fullImageData);
        } else {
          // GIF files - use direct loading to preserve animation
          const imageData = await invoke<AppImageData>("load_image", { path });

          // Check if loading was cancelled
          if (signal.aborted || activeLoadPathRef.current !== path) {
            return;
          }

          if (!imageData) {
            throw new Error("Failed to load image: No data returned");
          }

          setImageData(imageData);

          // Auto-fit or update dimensions based on saved state
          if (!hasSavedState) {
            fitToWindow(imageData.width, imageData.height);
          } else {
            updateImageDimensions(imageData.width, imageData.height);
          }

          // Add to preload cache
          setPreloadedImage(path, imageData);
        }
      } catch (error) {
        // Don't log errors if the load was cancelled or navigation changed
        if (!signal.aborted && activeLoadPathRef.current === path) {
          console.error("Failed to load image:", error);
          setImageError(error as Error);
        }
      } finally {
        // Only clear loading if this request is still active
        if (activeLoadPathRef.current === path) {
          setLoading(false);
        }
      }
    },
    [
      setLoading,
      setImageError,
      setImageData,
      setPreloadedImage,
      fitToWindow,
      updateImageDimensions,
    ],
  );

  // Load image with debounce to handle rapid navigation
  useEffect(() => {
    // Cancel any pending image load
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    if (!currentImage.path) return;

    // Skip debounce if thumbnail is already displayed - upgrade immediately
    const { ui: currentUi } = useAppStore.getState();
    const debounceDelay = currentUi.thumbnailDisplayed ? 0 : IMAGE_LOAD_DEBOUNCE_MS;

    // Debounce image loading to avoid loading intermediate images during rapid navigation
    const timeoutId = setTimeout(async () => {
      // Create new AbortController for this load
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      if (signal.aborted) return;

      // Load the image with the specific signal for this request
      await loadImage(currentImage.path, signal);
    }, debounceDelay);

    return () => {
      // Clear the timeout and abort any ongoing load when path changes
      clearTimeout(timeoutId);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [currentImage.path, loadImage]);

  // Handle window resize to re-fit image
  useEffect(() => {
    const handleResize = () => {
      if (currentImage.data) {
        fitToWindow(currentImage.data.width, currentImage.data.height, true);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [currentImage.data, fitToWindow]);

  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      // Check if click was on the image element
      const isImageClick = e.target === imageRef.current;

      // Only handle clicks outside the image
      if (
        !isImageClick &&
        view.isMaximized &&
        !view.isFullscreen &&
        currentImage.data
      ) {
        resizeToImage();
      }
    },
    [view.isMaximized, view.isFullscreen, currentImage.data, resizeToImage],
  );

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (view.isMaximized && !view.isFullscreen && currentImage.data) {
          resizeToImage();
        }
      }
    },
    [view.isMaximized, view.isFullscreen, currentImage.data, resizeToImage],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only allow dragging on the image itself
    if (e.target === imageRef.current) {
      setIsDragging(true);
      setDragStart({
        x: e.clientX,
        y: e.clientY,
      });
      e.preventDefault();
    }
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) {
        // Calculate pan delta relative to zoom level
        const deltaX = (e.clientX - dragStart.x) / (view.zoom / 100);
        const deltaY = (e.clientY - dragStart.y) / (view.zoom / 100);

        setPan(view.panX + deltaX, view.panY + deltaY);

        // Update drag start for next move
        setDragStart({ x: e.clientX, y: e.clientY });
      }
    },
    [isDragging, dragStart, view.zoom, view.panX, view.panY, setPan],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    // Only reset zoom on image double-click
    if (e.target === imageRef.current) {
      useAppStore.getState().resetZoom();
    }
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();

      if (!containerRef.current) return;

      // Get cursor position relative to the container center
      const rect = containerRef.current.getBoundingClientRect();
      const containerCenterX = rect.left + rect.width / 2;
      const containerCenterY = rect.top + rect.height / 2;

      // Mouse position relative to container center
      const mouseX = e.clientX - containerCenterX;
      const mouseY = e.clientY - containerCenterY;

      const zoomFactor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      zoomAtPoint(zoomFactor, mouseX, mouseY);
    },
    [zoomAtPoint],
  );

  const imageStyle: React.CSSProperties = useMemo(() => {
    // Always use original image dimensions for width/height
    const imageWidth = currentImage.data?.width || 0;
    const imageHeight = currentImage.data?.height || 0;

    // Use calculated position from fitToWindow for initial positioning
    const baseLeft = view.imageLeft ?? 0;
    const baseTop = view.imageTop ?? 0;

    return {
      left: baseLeft,
      top: baseTop,
      width: imageWidth, // Original image width
      height: imageHeight, // Original image height
      transform: `scale(${view.zoom / 100}) translate(${view.panX}px, ${view.panY}px)`,
      cursor: isDragging ? "grabbing" : "grab",
      transition:
        isDragging || suppressTransition ? "none" : "transform 0.1s ease-out",
      opacity: suppressTransition && currentImage.data === null ? 0 : 1,
    };
  }, [
    view.zoom,
    view.panX,
    view.panY,
    view.imageLeft,
    view.imageTop,
    currentImage.data,
    isDragging,
    suppressTransition,
  ]);

  if (!currentImage.path) {
    return (
      <div className={`image-viewer-empty ${className}`}>
        <div className="no-image-message">No image selected</div>
      </div>
    );
  }

  if (currentImage.error) {
    return (
      <div className={`image-viewer-error ${className}`}>
        <div className="error-message">
          Failed to load image: {currentImage.error.message}
        </div>
      </div>
    );
  }

  return (
    <section
      ref={containerRef}
      aria-label="Image viewer"
      className={`image-viewer ${className}`}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onClick={handleContainerClick}
      onKeyDown={handleContainerKeyDown}
    >
      {currentImage.data && (
        <img
          ref={imageRef}
          src={`data:${currentImage.data.format};base64,${currentImage.data.base64}`}
          alt={currentImage.path.split(/[\\/]/).pop() || "Current image"}
          style={imageStyle}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
          draggable={false}
        />
      )}

      {view.zoom !== 100 && (
        <div className="zoom-indicator">{Math.round(view.zoom)}%</div>
      )}
    </section>
  );
};

export default ImageViewer;
