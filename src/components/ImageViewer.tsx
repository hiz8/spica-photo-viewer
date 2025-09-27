import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { useImagePreloader } from '../hooks/useImagePreloader';
import { ImageData } from '../types';

interface ImageViewerProps {
  className?: string;
}

const ImageViewer: React.FC<ImageViewerProps> = ({ className = '' }) => {
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
  }, [currentImage.path]);

  // Handle window resize to re-fit image
  useEffect(() => {
    const handleResize = () => {
      if (currentImage.data) {
        fitToWindow(currentImage.data.width, currentImage.data.height);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [currentImage.data, fitToWindow]);

  const loadImage = async (path: string) => {
    try {
      setLoading(true);
      setImageError(null);

      // Check if image is already preloaded
      const preloadedImage = cache.preloaded.get(path);
      if (preloadedImage) {
        if (preloadedImage.format === 'error') {
          throw new Error('Image failed to load previously');
        }
        console.log(`Using preloaded image: ${path.split(/[\\/]/).pop()}`);
        setImageData(preloadedImage);

        // Auto-fit image to window
        fitToWindow(preloadedImage.width, preloadedImage.height);
        return;
      }

      // Load image if not preloaded
      const imageData = await invoke<ImageData>('load_image', { path });
      setImageData(imageData);

      // Auto-fit image to window
      fitToWindow(imageData.width, imageData.height);

      // Add to preload cache
      cache.preloaded.set(path, imageData);
    } catch (error) {
      console.error('Failed to load image:', error);
      setImageError(error as Error);
    } finally {
      setLoading(false);
    }
  };

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({
      x: e.clientX,
      y: e.clientY,
    });
    e.preventDefault();
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      // Calculate pan delta relative to zoom level
      const deltaX = (e.clientX - dragStart.x) / (view.zoom / 100);
      const deltaY = (e.clientY - dragStart.y) / (view.zoom / 100);

      setPan(view.panX + deltaX, view.panY + deltaY);

      // Update drag start for next move
      setDragStart({ x: e.clientX, y: e.clientY });
    }
  }, [isDragging, dragStart, view.zoom, view.panX, view.panY, setPan]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDoubleClick = useCallback(() => {
    useAppStore.getState().resetZoom();
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
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
  }, [zoomAtPoint]);

  const imageStyle: React.CSSProperties = useMemo(() => ({
    transform: `scale(${view.zoom / 100}) translate(${view.panX}px, ${view.panY}px)`,
    cursor: isDragging ? 'grabbing' : 'grab',
    transition: isDragging ? 'none' : 'transform 0.1s ease-out',
  }), [view.zoom, view.panX, view.panY, isDragging]);

  if (!currentImage.path) {
    return (
      <div className={`image-viewer-empty ${className}`}>
        <div className="no-image-message">
          No image selected
        </div>
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

  if (!currentImage.data) {
    return (
      <div className={`image-viewer-loading ${className}`}>
        <div className="loading-message">
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`image-viewer ${className}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
    >
      <img
        ref={imageRef}
        src={`data:image/${currentImage.data.format};base64,${currentImage.data.base64}`}
        alt={currentImage.path}
        style={imageStyle}
        draggable={false}
      />

      {view.zoom !== 100 && (
        <div className="zoom-indicator">
          {Math.round(view.zoom)}%
        </div>
      )}

    </div>
  );
};

export default ImageViewer;