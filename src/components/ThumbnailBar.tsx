import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  memo,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { ImageInfo } from "../types";

const THUMBNAIL_SIZE = 20;

interface ThumbnailItemProps {
  image: ImageInfo;
  index: number;
  isActive: boolean;
  onClick: (index: number) => void;
}

const ThumbnailItem: React.FC<ThumbnailItemProps> = memo(
  ({ image, index, isActive, onClick }) => {
    const [thumbnailData, setThumbnailData] = useState<string | null>(null);
    const [error, setError] = useState<boolean>(false);

    useEffect(() => {
      const loadThumbnail = async () => {
        try {
          // First, try to get from cache
          const cachedThumbnail = await invoke<string | null>(
            "get_cached_thumbnail",
            {
              path: image.path,
              size: THUMBNAIL_SIZE,
            },
          );

          if (cachedThumbnail) {
            setThumbnailData(cachedThumbnail);
            return;
          }

          // If not cached, generate new thumbnail
          const thumbnail = await invoke<string>("generate_image_thumbnail", {
            path: image.path,
            size: THUMBNAIL_SIZE,
          });

          // Cache the generated thumbnail
          await invoke("set_cached_thumbnail", {
            path: image.path,
            thumbnail,
            size: THUMBNAIL_SIZE,
          });

          setThumbnailData(thumbnail);
        } catch (err) {
          console.warn(`Failed to load thumbnail for ${image.filename}:`, err);
          setError(true);

          // Cache the error to avoid retrying
          try {
            await invoke("set_cached_thumbnail", {
              path: image.path,
              thumbnail: "error",
              size: THUMBNAIL_SIZE,
            });
          } catch (cacheErr) {
            console.warn("Failed to cache thumbnail error:", cacheErr);
          }
        }
      };

      loadThumbnail();
    }, [image.path]);

    return (
      <div
        className={`thumbnail-item ${isActive ? "active" : ""}`}
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
          <div className="thumbnail-placeholder">{error ? "❌" : "⏳"}</div>
        )}
      </div>
    );
  },
);

const ThumbnailBar: React.FC = () => {
  const { folder, currentImage, navigateToImage } = useAppStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailBarRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  const handleThumbnailClick = useCallback(
    (index: number) => {
      if (folder.images[index]) {
        navigateToImage(index);
      }
    },
    [folder.images, navigateToImage],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (e.deltaY > 0) {
        // Scroll down = next image
        const nextIndex = Math.min(
          currentImage.index + 1,
          folder.images.length - 1,
        );
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
    },
    [currentImage.index, folder.images.length, navigateToImage],
  );

  const scrollToActiveItem = useCallback(() => {
    if (containerRef.current && currentImage.index !== -1) {
      const activeItem = containerRef.current.querySelector(
        ".thumbnail-item.active",
      ) as HTMLElement;
      if (activeItem) {
        const container = containerRef.current;
        const containerWidth = container.offsetWidth;
        const itemLeft = activeItem.offsetLeft;
        const itemWidth = activeItem.offsetWidth;

        // Calculate center position
        const scrollLeft = itemLeft - containerWidth / 2 + itemWidth / 2;
        container.scrollTo({
          left: scrollLeft,
          behavior: "smooth",
        });
      }
    }
  }, [currentImage.index]);

  useEffect(() => {
    scrollToActiveItem();
  }, [scrollToActiveItem]);

  useEffect(() => {
    const thumbnailBar = thumbnailBarRef.current;
    if (!thumbnailBar) return;

    const resizeObserver = new ResizeObserver(() => {
      scrollToActiveItem();
    });

    resizeObserver.observe(thumbnailBar);

    return () => {
      resizeObserver.disconnect();
    };
  }, [scrollToActiveItem]);

  const imageInfo = useMemo(() => {
    if (!currentImage.path || !folder.images[currentImage.index]) {
      return null;
    }
    const image = folder.images[currentImage.index];
    return `${image.filename} (${image.width} × ${image.height})`;
  }, [currentImage.path, currentImage.index, folder.images]);

  if (!folder.images.length) {
    return null;
  }

  return (
    <div
      ref={thumbnailBarRef}
      className={`thumbnail-bar ${isHovered ? "hovered" : ""}`}
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

      {imageInfo && <div className="image-info">{imageInfo}</div>}
    </div>
  );
};

export default ThumbnailBar;
