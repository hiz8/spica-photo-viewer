import type React from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FULL_UPGRADE_DEBOUNCE_MS } from "../constants/memory";
import { IMAGE_LOAD_DEBOUNCE_MS } from "../constants/timing";
import { useImagePreloader } from "../hooks/useImagePreloader";
import { useThumbnailGenerator } from "../hooks/useThumbnailGenerator";
import { thumbnailToImageData, useAppStore } from "../store";
import type { ImageData } from "../types";
import { effectiveTier, getRetained, setBitmap } from "../utils/bitmapCache";
import {
  loadBitmapViaProtocol,
  loadPreviewBitmap,
  retainElementAsBitmap,
} from "../utils/bitmapLoader";
import { drawBitmapToCanvas } from "../utils/canvasDraw";
import { displayTierOf } from "../utils/displayTier";
import { imageFormat, imageSrc } from "../utils/imageSrc";
import { getFilename } from "../utils/path";
import { isPerfEnabled, perfMark } from "../utils/perf";
import { currentPreviewBox } from "../utils/previewBox";
import { loadImageViaProtocol } from "../utils/protocolLoader";

/**
 * Headroom before a display-resolution preview counts as too coarse: the
 * zoom has to exceed the preview's own pixel density by 2% before the
 * full-resolution upgrade is scheduled, so fit-to-window (which is exactly
 * the preview's density, modulo rounding) never triggers one.
 */
const FULL_UPGRADE_ZOOM_MARGIN = 1.02;

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
    setThumbnailDisplayed,
  } = useAppStore();

  // Initialize thumbnail generation and preloading
  useThumbnailGenerator();
  useImagePreloader();

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeLoadPathRef = useRef<string | null>(null);
  const fullUpgradeRef = useRef<{
    path: string;
    controller: AbortController;
  } | null>(null);

  const suppressTransition = ui.suppressTransition;

  /**
   * Display-resolution preview path (design spec 2026-08-21 §6.4): fetches
   * the preview instead of the 20MP original and paints it from the decoded
   * bitmap. Returns "failed" when the preview could not be fetched/decoded
   * (404 for a GIF or a missing preview) so the caller can fall back to the
   * full-resolution load, and "stale" when the navigation moved on.
   */
  const displayPreview = useCallback(
    async (
      path: string,
      signal: AbortSignal,
      hasSavedState: boolean,
    ): Promise<"displayed" | "stale" | "failed"> => {
      let loaded: { data: ImageData; bitmap: ImageBitmap };
      try {
        loaded = await loadPreviewBitmap(path, currentPreviewBox(), signal);
      } catch (error) {
        // loadPreviewBitmap passes the signal to fetch(), so a navigation
        // rejects it with an AbortError. That is not a missing preview:
        // falling back would decode the 20MP original for the image the
        // user already left (and emit a stray src:set mark for it).
        if (signal.aborted || activeLoadPathRef.current !== path) {
          return "stale";
        }
        console.warn(
          "Failed to load display-resolution preview, falling back to full resolution:",
          error,
        );
        return "failed";
      }

      if (signal.aborted || activeLoadPathRef.current !== path) {
        loaded.bitmap.close();
        return "stale";
      }

      const { data: previewData, bitmap } = loaded;
      // Always the preview TIER, matching the scheduler: loadPreviewBitmap
      // reports "full" when the box needed no downscaling, but the pixels
      // still came from the preview route, and filing them under the full
      // tier would make the scheduler's sweep drop them on the next pump.
      setBitmap(path, bitmap, "preview");

      // The DISPLAYED tier, on the other hand, is "full" for such an
      // unscaled preview - there is no upgrade left to schedule.
      const displayData: ImageData = {
        ...previewData,
        tier:
          effectiveTier(path, previewData.width, previewData.height) ??
          previewData.tier,
      };
      setImageData(displayData);

      // Geometry stays the natural (full-resolution) size; the canvas is
      // backed by the smaller preview bitmap and scaled up by CSS.
      if (!hasSavedState) {
        fitToWindow(previewData.width, previewData.height);
      } else {
        updateImageDimensions(previewData.width, previewData.height);
      }

      setPreloadedImage(path, displayData);
      setThumbnailDisplayed(false);
      return "displayed";
    },
    [
      setImageData,
      fitToWindow,
      updateImageDimensions,
      setPreloadedImage,
      setThumbnailDisplayed,
    ],
  );

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

        // A thumbnail cache entry for a non-GIF path proves its
        // display-resolution preview is on disk (Phase 2 invariant I1), so
        // the viewer can fetch the preview instead of the full original.
        const thumbnailEntry = currentCache.thumbnails.get(path);
        const isGif =
          (folder.imagesByPath.get(path)?.format ?? imageFormat(path)) ===
          "gif";
        const previewEligible =
          !isGif && !!thumbnailEntry && thumbnailEntry !== "error";

        // Check if we already have full resolution data (not just thumbnail)
        const hasFullResolution =
          current.path === path &&
          current.data &&
          current.data.path === path &&
          current.data.width > 0 && // Full resolution images have actual dimensions
          !currentUi.thumbnailDisplayed; // Not just a thumbnail display

        if (hasFullResolution) {
          // Full resolution already loaded by navigateToImage - skip
          return;
        }

        // FAST PATH: If thumbnail is displayed, upgrade to full resolution immediately
        // Skip debounce since something is already visible
        const isThumbnailUpgrade =
          currentUi.thumbnailDisplayed && current.path === path;

        if (isThumbnailUpgrade) {
          console.log(
            `Upgrading thumbnail to display resolution: ${getFilename(path)}`,
          );

          // Set loading state for consistent UX
          setLoading(true);
          setImageError(null);

          // Check if this image has saved view state
          const hasSavedState = currentCache.imageViewStates.has(path);

          if (previewEligible) {
            const outcome = await displayPreview(path, signal, hasSavedState);
            if (outcome !== "failed") {
              return;
            }
            // Preview missing/undecodable: fall through to the full load.
          }

          // Load full resolution directly
          const { data: loadedData, element } =
            await loadImageViaProtocol(path);

          if (signal.aborted || activeLoadPathRef.current !== path) {
            return;
          }

          const fullImageData: ImageData = { ...loadedData, tier: "full" };

          // Update with full resolution
          setImageData(fullImageData);

          // Update dimensions
          if (!hasSavedState) {
            fitToWindow(fullImageData.width, fullImageData.height);
          } else {
            updateImageDimensions(fullImageData.width, fullImageData.height);
          }

          // Add to preload cache
          setPreloadedImage(path, fullImageData);
          retainElementAsBitmap(path, element);

          // Clear thumbnail flag
          setThumbnailDisplayed(false);

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
          const cachedThumbnail = thumbnailEntry;
          if (cachedThumbnail && cachedThumbnail !== "error") {
            try {
              // PHASE 1: Display thumbnail preview immediately with cached dimensions
              // No need to call get_image_dimensions_only since thumbnail includes dimensions

              // Check if loading was cancelled
              if (signal.aborted || activeLoadPathRef.current !== path) {
                return;
              }

              setImageData(thumbnailToImageData(path, cachedThumbnail));
              // This is a placeholder, not the image: without the flag
              // displayTierOf would label it "full" (data-tier on the
              // element and the tier of its paint:done mark).
              setThumbnailDisplayed(true);

              // Fit to window or restore saved view state
              if (!hasSavedState) {
                fitToWindow(cachedThumbnail.width, cachedThumbnail.height);
              } else {
                updateImageDimensions(
                  cachedThumbnail.width,
                  cachedThumbnail.height,
                );
              }

              // PHASE 2: Load the display-resolution preview in the
              // background (full resolution only if the preview is missing).
              if (previewEligible) {
                const outcome = await displayPreview(
                  path,
                  signal,
                  hasSavedState,
                );
                if (outcome !== "failed") {
                  return;
                }
              }

              const { data: loadedData, element } =
                await loadImageViaProtocol(path);

              // Check if loading was cancelled
              if (signal.aborted || activeLoadPathRef.current !== path) {
                return;
              }

              const fullImageData: ImageData = { ...loadedData, tier: "full" };

              // Replace with full resolution
              setImageData(fullImageData);
              // The PHASE 1 placeholder is gone.
              setThumbnailDisplayed(false);

              // Update dimensions if needed
              if (!hasSavedState) {
                fitToWindow(fullImageData.width, fullImageData.height);
              } else {
                updateImageDimensions(
                  fullImageData.width,
                  fullImageData.height,
                );
              }

              // Add to preload cache
              setPreloadedImage(path, fullImageData);
              retainElementAsBitmap(path, element);
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
          const { data: loadedData, element } =
            await loadImageViaProtocol(path);

          // Check if loading was cancelled
          if (signal.aborted || activeLoadPathRef.current !== path) {
            return;
          }

          const fullImageData: ImageData = { ...loadedData, tier: "full" };

          setImageData(fullImageData);
          // No-op on the cold path; clears the PHASE 1 placeholder when the
          // two-phase branch fell through to here after an error.
          setThumbnailDisplayed(false);

          // Fit to window or update dimensions based on saved state
          if (!hasSavedState) {
            fitToWindow(fullImageData.width, fullImageData.height);
          } else {
            updateImageDimensions(fullImageData.width, fullImageData.height);
          }

          // Add to preload cache
          setPreloadedImage(path, fullImageData);
          retainElementAsBitmap(path, element);
        } else {
          // GIF files - use direct loading to preserve animation
          const imageData = (await loadImageViaProtocol(path)).data;

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
      setThumbnailDisplayed,
      displayPreview,
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
    const debounceDelay = currentUi.thumbnailDisplayed
      ? 0
      : IMAGE_LOAD_DEBOUNCE_MS;

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

  // Zoom past the preview's pixel density -> upgrade to the full-resolution
  // decode (design spec 2026-08-21 §6.4). Debounced so a wheel gesture
  // schedules one decode after the zoom settles, not one per notch.
  useEffect(() => {
    const data = currentImage.data;
    if (!data || data.path !== currentImage.path) return;
    if (data.tier !== "preview" || ui.thumbnailDisplayed) return;

    const retained = getRetained(data.path);
    if (retained?.tier !== "preview") return;
    // An unscaled preview (bitmap === natural size) has nothing to upgrade to.
    if (retained.bitmap.width >= data.width) return;

    const previewDensity = retained.bitmap.width / data.width;
    if (view.zoom / 100 <= previewDensity * FULL_UPGRADE_ZOOM_MARGIN) return;

    // An upgrade for this path is already decoding.
    if (fullUpgradeRef.current?.path === data.path) return;

    const path = data.path;
    const timeoutId = setTimeout(() => {
      const controller = new AbortController();
      fullUpgradeRef.current = { path, controller };
      void loadBitmapViaProtocol(path, controller.signal)
        .then(({ bitmap }) => {
          if (
            controller.signal.aborted ||
            useAppStore.getState().currentImage.path !== path
          ) {
            bitmap.close();
            return;
          }
          setBitmap(path, bitmap, "full");
          // The data change re-runs the draw effect, so the canvas is
          // repainted from the full bitmap and paint:done reports "full".
          const fullData: ImageData = {
            ...data,
            tier: "full",
            src: imageSrc(path),
          };
          setImageData(fullData);
          setPreloadedImage(path, fullData);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          // Keep showing the preview; the next zoom re-arms the upgrade.
          console.warn("Failed to upgrade preview to full resolution:", error);
        })
        .finally(() => {
          if (fullUpgradeRef.current?.controller === controller) {
            fullUpgradeRef.current = null;
          }
        });
    }, FULL_UPGRADE_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [
    view.zoom,
    currentImage.data,
    currentImage.path,
    ui.thumbnailDisplayed,
    setImageData,
    setPreloadedImage,
  ]);

  // Abort an in-flight full-resolution upgrade when the viewer leaves the
  // image (or unmounts). Kept apart from the effect above so a zoom change
  // does not cancel the decode it just scheduled.
  useEffect(() => {
    const displayed = currentImage.path;
    return () => {
      if (fullUpgradeRef.current?.path !== displayed) return;
      fullUpgradeRef.current.controller.abort();
      fullUpgradeRef.current = null;
    };
  }, [currentImage.path]);

  // Paint the retained bitmap before the frame is presented. The canvas owns
  // its own backing pixels afterwards, so later eviction of the bitmap is safe.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const data = currentImage.data;
    if (!canvas || !data) return;
    const retained = getRetained(data.path);
    if (retained) {
      drawBitmapToCanvas(canvas, retained.bitmap);
    }
  }, [currentImage.data]);

  // Perf instrumentation: mark decode:done / paint:done when displayed data changes.
  // Double rAF approximates the first frame actually painted with the new image.
  useEffect(() => {
    const data = currentImage.data;
    if (!data || !isPerfEnabled()) return;
    const thumbnail = !!useAppStore.getState().ui.thumbnailDisplayed;
    // Display tier of this paint (design spec 2026-08-21 §7.1). The bench
    // keeps judging "full paint" by thumbnail === false; tier is the
    // explicit label that will distinguish preview from full later.
    const tier = displayTierOf(data, thumbnail);
    let cancelled = false;

    const markPaint = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) {
            perfMark("paint:done", { path: data.path, thumbnail, tier });
          }
        });
      });
    };

    if (canvasRef.current) {
      // Canvas path: pixels are already decoded; only the paint mark applies.
      markPaint();
      return () => {
        cancelled = true;
      };
    }

    const img = imageRef.current;
    if (img?.decode) {
      img
        .decode()
        .then(() => {
          if (!cancelled)
            perfMark("decode:done", { path: data.path, thumbnail });
        })
        .catch(() => {
          /* decode() rejects for data-URL races; paint mark still fires */
        })
        .finally(markPaint);
    } else {
      markPaint();
    }

    return () => {
      cancelled = true;
    };
  }, [currentImage.data]);

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
      const isImageClick =
        e.target === imageRef.current || e.target === canvasRef.current;

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
    const isDisplayTarget =
      e.target === imageRef.current || e.target === canvasRef.current;
    if (isDisplayTarget) {
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
    const isDisplayTarget =
      e.target === imageRef.current || e.target === canvasRef.current;
    if (isDisplayTarget) {
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

  // Decide img-vs-canvas once per displayed data. A bitmap that arrives later
  // (viewer-load retention) must NOT swap the mounted <img> for a canvas: the
  // draw effect is keyed on the data, so a swap on an unrelated store-driven
  // re-render would mount a blank, never-painted canvas.
  const displayBitmap = useMemo(
    () =>
      currentImage.data &&
      currentImage.data.width > 0 &&
      !ui.thumbnailDisplayed &&
      currentImage.data.path === currentImage.path
        ? getRetained(currentImage.data.path)
        : undefined,
    // currentImage.path changes together with data on navigation; listing it
    // keeps the memo honest for the data.path === currentImage.path guard.
    [currentImage.data, ui.thumbnailDisplayed, currentImage.path],
  );

  // Stable identity keyed on the displayed data: an inline arrow function
  // here would get a new identity on every render (e.g. setPan on every
  // mousemove during drag, since ImageViewer subscribes to the whole store),
  // and React re-invokes a ref callback whose identity changed even though
  // the canvas stays mounted — reallocating the backing store and redrawing
  // the full bitmap on every unrelated re-render. Keying on currentImage.data
  // limits refires to actual data changes, which is harmless (idempotent
  // draw, and the layout effect below already covers that case).
  const canvasMountRef = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      canvasRef.current = canvas;
      if (canvas && currentImage.data) {
        const retained = getRetained(currentImage.data.path);
        if (retained) drawBitmapToCanvas(canvas, retained.bitmap);
      }
    },
    [currentImage.data],
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
      {currentImage.data && displayBitmap && (
        <canvas
          ref={canvasMountRef}
          role="img"
          aria-label={getFilename(currentImage.path) || "Current image"}
          style={imageStyle}
          data-natural-width={currentImage.data.width}
          data-natural-height={currentImage.data.height}
          data-tier={displayTierOf(currentImage.data, ui.thumbnailDisplayed)}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
        />
      )}
      {currentImage.data && !displayBitmap && (
        <img
          ref={imageRef}
          src={currentImage.data.src}
          alt={getFilename(currentImage.path) || "Current image"}
          style={imageStyle}
          data-natural-width={currentImage.data.width}
          data-natural-height={currentImage.data.height}
          data-tier={displayTierOf(currentImage.data, ui.thumbnailDisplayed)}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
          draggable={false}
        />
      )}

      {/* Loading indicator when image path is set but data not yet loaded */}
      {!currentImage.data && ui.isLoading && (
        <div className="loading-indicator">
          <div className="loading-spinner" />
          <div className="loading-text">Loading...</div>
        </div>
      )}

      {view.zoom !== 100 && (
        <div className="zoom-indicator">{Math.round(view.zoom)}%</div>
      )}
    </section>
  );
};

export default ImageViewer;
