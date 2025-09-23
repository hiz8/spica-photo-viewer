import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { ImageData } from '../types';

interface ImageViewerProps {
  className?: string;
}

const ImageViewer: React.FC<ImageViewerProps> = ({ className = '' }) => {
  const {
    currentImage,
    view,
    setImageData,
    setImageError,
    setLoading,
    setPan,
  } = useAppStore();

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

      const imageData = await invoke<ImageData>('load_image', { path });
      setImageData(imageData);
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
        x: e.clientX - view.panX,
        y: e.clientY - view.panY,
      });
      e.preventDefault();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && view.zoom > 100) {
      const newPanX = e.clientX - dragStart.x;
      const newPanY = e.clientY - dragStart.y;
      setPan(newPanX, newPanY);
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

    if (e.deltaY < 0) {
      useAppStore.getState().zoomIn();
    } else {
      useAppStore.getState().zoomOut();
    }
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