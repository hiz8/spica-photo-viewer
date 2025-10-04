import type React from "react";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useImagePreloader } from "../hooks/useImagePreloader";
import type { ImageData } from "../types";

interface ImageViewerProps {
  className?: string;
}

const ImageViewer: React.FC<ImageViewerProps> = ({ className = "" }) => {
  const {
    currentImage,
    view,
    cache,
    setImageData,
    setImageError,
    setLoading,
    setPan,
    zoomAtPoint,
    fitToWindow,
    updateImageDimensions,
    resizeToImage,
  } = useAppStore();

  useImagePreloader();

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (currentImage.path && !currentImage.data) {
      loadImage(currentImage.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImage.path, currentImage.data]);

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

  const loadImage = async (path: string) => {
    try {
      setLoading(true);
      setImageError(null);

      // Check if this image has saved view state
      const hasSavedState = cache.imageViewStates.has(path);

      // Check if image is already preloaded
      const preloadedImage = cache.preloaded.get(path);
      if (preloadedImage) {
        if (preloadedImage.format === "error") {
          throw new Error("Image failed to load previously");
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

      // Load image if not preloaded
      const imageData = await invoke<ImageData>("load_image", { path });
      setImageData(imageData);

      // Auto-fit or update dimensions based on saved state
      if (!hasSavedState) {
        fitToWindow(imageData.width, imageData.height);
      } else {
        updateImageDimensions(imageData.width, imageData.height);
      }

      // Add to preload cache
      cache.preloaded.set(path, imageData);
    } catch (error) {
      console.error("Failed to load image:", error);
      setImageError(error as Error);
    } finally {
      setLoading(false);
    }
  };

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
      transition: isDragging ? "none" : "transform 0.1s ease-out",
    };
  }, [
    view.zoom,
    view.panX,
    view.panY,
    view.imageLeft,
    view.imageTop,
    currentImage.data,
    isDragging,
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
    <div
      ref={containerRef}
      role="region"
      aria-label="Image viewer"
      tabIndex={0}
      className={`image-viewer ${className}`}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onClick={handleContainerClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          handleContainerClick();
        }
      }}
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
    </div>
  );
};

export default ImageViewer;
