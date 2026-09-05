import type React from "react";
import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { useAppStore } from "../store";
import type { ImageInfo } from "../types";
import {
  THUMBNAIL_ITEM_PITCH_PX,
  THUMBNAIL_RENDER_MARGIN,
} from "../constants/memory";
import { THUMBNAIL_SCROLL_DEBOUNCE_MS } from "../constants/timing";
import { isPerfEnabled, perfMark } from "../utils/perf";
import { visibleThumbnailRadius } from "../utils/preloadWindow";

interface ThumbnailItemProps {
  image: ImageInfo;
  index: number;
  isActive: boolean;
  onClick: (index: number) => void;
  thumbnailData: string | null;
}

const ThumbnailItem: React.FC<ThumbnailItemProps> = memo(
  ({ image, index, isActive, onClick, thumbnailData }) => {
    const isError = thumbnailData === "error";
    const hasData = thumbnailData && !isError;

    // A thumbnail that has not been generated yet renders as a blank slot
    // (no icon, no background) like Picasa Photo Viewer; the <button> keeps
    // its size so layout, centering and the click target are unchanged.
    let content: React.ReactNode = null;
    if (hasData) {
      content = (
        <img
          src={`data:image/jpeg;base64,${thumbnailData}`}
          alt={image.filename}
          className="thumbnail-image"
        />
      );
    } else if (isError) {
      content = <div className="thumbnail-placeholder">❌</div>;
    }

    const className = [
      "thumbnail-item",
      isActive && "active",
      isError && "error",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        type="button"
        className={className}
        onClick={() => onClick(index)}
        title={image.filename}
        data-index={index}
      >
        {content}
      </button>
    );
  },
);

const ThumbnailBar: React.FC = () => {
  const { folder, currentImage, cache, navigateToImage } = useAppStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailBarRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  const getThumbnailData = useCallback(
    (imagePath: string): string | null => {
      const thumbnail = cache.thumbnails.get(imagePath);
      if (!thumbnail) {
        return null;
      }
      if (thumbnail === "error") {
        return "error";
      }
      return thumbnail.base64;
    },
    [cache.thumbnails],
  );

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
        const nextIndex = Math.min(
          currentImage.index + 1,
          folder.images.length - 1,
        );
        if (nextIndex !== currentImage.index) {
          navigateToImage(nextIndex);
        }
      } else {
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

        const scrollLeft = itemLeft - containerWidth / 2 + itemWidth / 2;
        container.scrollTo({
          left: scrollLeft,
          behavior: "auto", // Instant scroll - syncs with ImageInfo
        });
      }
    }
  }, [currentImage.index]);

  useEffect(() => {
    // Debounce: skip intermediate scrolls during rapid navigation
    const timeoutId = setTimeout(() => {
      scrollToActiveItem();
    }, THUMBNAIL_SCROLL_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [scrollToActiveItem]);

  // Perf instrumentation: first commit of the bar with items, and the frame
  // that actually paints it.
  const imageCount = folder.images.length;
  useEffect(() => {
    if (!imageCount || !isPerfEnabled()) return;
    perfMark("thumbbar:committed", { n: imageCount });
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) perfMark("thumbbar:painted", { n: imageCount });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [imageCount]);

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

    if (currentImage.data?.width && currentImage.data.height) {
      return `${image.filename} (${currentImage.data.width} × ${currentImage.data.height})`;
    }

    // currentImage.data is null only in the brief window right after
    // navigation, before any tier has painted; the thumbnail placeholder and
    // preview tiers both already carry width/height, so this branch is not
    // reached once either one has loaded.
    return image.filename;
  }, [currentImage.path, currentImage.index, currentImage.data, folder.images]);

  if (!folder.images.length) {
    return null;
  }

  // Only the thumbnails that can be on screen (plus a margin) are in the
  // DOM: a 2000-image folder otherwise costs ~90ms to mount and ~10ms of
  // re-render per arriving thumbnail. The omitted items on each side are
  // replaced by one spacer of exactly their total pitch, so offsetLeft,
  // centering and scrolling behave as if every item were rendered.
  const count = folder.images.length;
  const radius =
    visibleThumbnailRadius(window.innerWidth) + THUMBNAIL_RENDER_MARGIN;
  const center = Math.max(0, currentImage.index);
  const start = Math.max(0, center - radius);
  const end = Math.min(count - 1, center + radius);

  return (
    <nav
      ref={thumbnailBarRef}
      aria-label="Thumbnail navigation"
      className={`thumbnail-bar ${isHovered ? "hovered" : ""}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onWheel={handleWheel}
    >
      <div className="thumbnail-container" ref={containerRef}>
        {start > 0 && (
          <div
            className="thumbnail-spacer"
            aria-hidden="true"
            style={{ width: start * THUMBNAIL_ITEM_PITCH_PX }}
          />
        )}
        {folder.images.slice(start, end + 1).map((image, offset) => {
          const index = start + offset;
          return (
            <ThumbnailItem
              key={image.path}
              image={image}
              index={index}
              isActive={index === currentImage.index}
              onClick={handleThumbnailClick}
              thumbnailData={getThumbnailData(image.path)}
            />
          );
        })}
        {end < count - 1 && (
          <div
            className="thumbnail-spacer"
            aria-hidden="true"
            style={{ width: (count - 1 - end) * THUMBNAIL_ITEM_PITCH_PX }}
          />
        )}
      </div>

      {imageInfo && <div className="image-info">{imageInfo}</div>}
    </nav>
  );
};

export default ThumbnailBar;
