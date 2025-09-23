import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { ImageInfo } from '../types';

interface ThumbnailItemProps {
  image: ImageInfo;
  index: number;
  isActive: boolean;
  onClick: (index: number) => void;
}

const ThumbnailItem: React.FC<ThumbnailItemProps> = ({ image, index, isActive, onClick }) => {
  const [thumbnailData, setThumbnailData] = useState<string | null>(null);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    const generateThumbnail = async () => {
      try {
        const thumbnail = await invoke<string>('generate_image_thumbnail', {
          path: image.path,
          size: 30
        });
        setThumbnailData(thumbnail);
      } catch (err) {
        console.error('Failed to generate thumbnail:', err);
        setError(true);
      }
    };

    generateThumbnail();
  }, [image.path]);

  return (
    <div
      className={`thumbnail-item ${isActive ? 'active' : ''}`}
      onClick={() => onClick(index)}
      title={image.filename}
    >
      {thumbnailData && !error ? (
        <img
          src={`data:image/jpeg;base64,${thumbnailData}`}
          alt={image.filename}
          className="thumbnail-image"
        />
      ) : (
        <div className="thumbnail-placeholder">
          {error ? '❌' : '⏳'}
        </div>
      )}
    </div>
  );
};

const ThumbnailBar: React.FC = () => {
  const { folder, currentImage, navigateToImage } = useAppStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  const handleThumbnailClick = (index: number) => {
    if (folder.images[index]) {
      navigateToImage(index);
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY > 0) {
      // Scroll down = next image
      const nextIndex = Math.min(currentImage.index + 1, folder.images.length - 1);
      if (nextIndex !== currentImage.index) {
        navigateToImage(nextIndex);
      }
    } else {
      // Scroll up = previous image
      const prevIndex = Math.max(currentImage.index - 1, 0);
      if (prevIndex !== currentImage.index) {
        navigateToImage(prevIndex);
      }
    }
  };

  useEffect(() => {
    if (containerRef.current && currentImage.index !== -1) {
      const activeItem = containerRef.current.querySelector('.thumbnail-item.active') as HTMLElement;
      if (activeItem) {
        const container = containerRef.current;
        const containerWidth = container.offsetWidth;
        const itemLeft = activeItem.offsetLeft;
        const itemWidth = activeItem.offsetWidth;

        // Calculate center position
        const scrollLeft = itemLeft - (containerWidth / 2) + (itemWidth / 2);
        container.scrollTo({
          left: scrollLeft,
          behavior: 'smooth'
        });
      }
    }
  }, [currentImage.index]);

  if (!folder.images.length) {
    return null;
  }

  return (
    <div
      className={`thumbnail-bar ${isHovered ? 'hovered' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onWheel={handleWheel}
    >
      <div className="thumbnail-container" ref={containerRef}>
        {folder.images.map((image, index) => (
          <ThumbnailItem
            key={image.path}
            image={image}
            index={index}
            isActive={index === currentImage.index}
            onClick={handleThumbnailClick}
          />
        ))}
      </div>

      {currentImage.path && (
        <div className="image-info">
          {folder.images[currentImage.index]?.filename}
          {folder.images[currentImage.index] && (
            ` (${folder.images[currentImage.index].width} × ${folder.images[currentImage.index].height})`
          )}
        </div>
      )}
    </div>
  );
};

export default ThumbnailBar;