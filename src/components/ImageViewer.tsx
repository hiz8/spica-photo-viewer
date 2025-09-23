import React, { useEffect, useRef, useState } from 'react';
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
        console.log(`Using preloaded image: ${path.split('\\').pop()}`);
        setImageData(preloadedImage);
        return;
      }

      // Load image if not preloaded
      const imageData = await invoke<ImageData>('load_image', { path });
      setImageData(imageData);

      // Add to preload cache
      cache.preloaded.set(path, imageData);
    } catch (error) {
      console.error('Failed to load image:', error);
      setImageError(error as Error);
    } finally {
      setLoading(false);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (view.zoom > 100) {
      setIsDragging(true);
      setDragStart({
        x: e.clientX,
        y: e.clientY,
      });
      e.preventDefault();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && view.zoom > 100) {
      // Calculate pan delta relative to zoom level
      const deltaX = (e.clientX - dragStart.x) / (view.zoom / 100);
      const deltaY = (e.clientY - dragStart.y) / (view.zoom / 100);

      setPan(view.panX + deltaX, view.panY + deltaY);

      // Update drag start for next move
      setDragStart({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleDoubleClick = () => {
    useAppStore.getState().resetZoom();
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();

    if (!containerRef.current) return;

    // Get cursor position relative to the container
    const rect = containerRef.current.getBoundingClientRect();
    const pointX = e.clientX - rect.left - rect.width / 2;
    const pointY = e.clientY - rect.top - rect.height / 2;

    const zoomFactor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    zoomAtPoint(zoomFactor, pointX, pointY);
  };

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

  const imageStyle: React.CSSProperties = {
    transform: `scale(${view.zoom / 100}) translate(${view.panX}px, ${view.panY}px)`,
    cursor: view.zoom > 100 ? (isDragging ? 'grabbing' : 'grab') : 'default',
    transition: isDragging ? 'none' : 'transform 0.1s ease-out',
  };

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