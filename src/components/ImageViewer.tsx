/**
 * Spec: docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md
 */
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
   * Display-resolution preview path (§6.5 route (2)): fetches the preview
   * instead of the 20MP original and paints it from the decoded bitmap.
   * Returns "failed" when the preview could not be fetched/decoded (404 for
   * a GIF or a missing preview) so the caller falls back to the
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

  // New images: fitToWindow(); returning to a viewed image: updateImageDimensions()
  // to preserve its saved pan/zoom (.claude/rules/zustand-store.md).
  const applyFitOrUpdate = useCallback(
    (hasSavedState: boolean, width: number, height: number) => {
      if (!hasSavedState) {
        fitToWindow(width, height);
      } else {
        updateImageDimensions(width, height);
      }
    },
    [fitToWindow, updateImageDimensions],
  );

  const loadFullResolution = useCallback(
    async (
      path: string,
      signal: AbortSignal,
    ): Promise<
      | { status: "aborted" }
      | {
          status: "loaded";
          fullImageData: ImageData;
          element: HTMLImageElement;
        }
    > => {
      const { data: loadedData, element } = await loadImageViaProtocol(path);
      if (signal.aborted || activeLoadPathRef.current !== path) {
        return { status: "aborted" };
      }
      return {
        status: "loaded",
        fullImageData: { ...loadedData, tier: "full" },
        element,
      };
    },
    [],
  );

  const loadImage = useCallback(
    async (path: string, signal: AbortSignal) => {
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
        // display-resolution preview is on disk (I1), so the viewer can
        // fetch the preview instead of the full original.
        const thumbnailEntry = currentCache.thumbnails.get(path);
        const isGif =
          (folder.imagesByPath.get(path)?.format ?? imageFormat(path)) ===
          "gif";
        const previewEligible =
          !isGif && !!thumbnailEntry && thumbnailEntry !== "error";

        const hasFullResolution =
          current.path === path &&
          current.data &&
          current.data.path === path &&
          current.data.width > 0 &&
          !currentUi.thumbnailDisplayed;

        if (hasFullResolution) {
          // Already loaded by navigateToImage.
          return;
        }

        // Fast path: thumbnail already visible, so skip the debounce and
        // upgrade to full resolution immediately.
        const isThumbnailUpgrade =
          currentUi.thumbnailDisplayed && current.path === path;

        if (isThumbnailUpgrade) {
          console.log(
            `Upgrading thumbnail to display resolution: ${getFilename(path)}`,
          );

          setLoading(true);
          setImageError(null);

          const hasSavedState = currentCache.imageViewStates.has(path);

          if (previewEligible) {
            const outcome = await displayPreview(path, signal, hasSavedState);
            if (outcome !== "failed") {
              return;
            }
            // Preview missing/undecodable: fall through to the full load.
          }

          const loadResult = await loadFullResolution(path, signal);
          if (loadResult.status === "aborted") {
            return;
          }

          const { fullImageData, element } = loadResult;

          setImageData(fullImageData);

          applyFitOrUpdate(
            hasSavedState,
            fullImageData.width,
            fullImageData.height,
          );

          setPreloadedImage(path, fullImageData);
          retainElementAsBitmap(path, element);

          setThumbnailDisplayed(false);

          return;
        }

        const hasSavedState = currentCache.imageViewStates.has(path);

        const preloadedImage = currentCache.preloaded.get(path);
        if (preloadedImage) {
          if (preloadedImage.format === "error") {
            throw new Error("Image failed to load previously");
          }

          if (signal.aborted || activeLoadPathRef.current !== path) {
            return;
          }

          setImageData(preloadedImage);
          applyFitOrUpdate(
            hasSavedState,
            preloadedImage.width,
            preloadedImage.height,
          );
          return;
        }

        setLoading(true);
        setImageError(null);

        const imageInfo = folder.imagesByPath.get(path);

        // GIFs skip two-phase loading to preserve their animation.
        const skipProgressive = imageInfo?.format === "gif";

        if (!skipProgressive) {
          const cachedThumbnail = thumbnailEntry;
          if (cachedThumbnail && cachedThumbnail !== "error") {
            try {
              // Phase 1: thumbnail already carries dimensions, so no
              // separate get_image_dimensions_only call is needed.
              if (signal.aborted || activeLoadPathRef.current !== path) {
                return;
              }

              setImageData(thumbnailToImageData(path, cachedThumbnail));
              // Not the real image yet: without this flag, displayTierOf
              // would call it "full" (both the element's data-tier and the
              // paint:done mark).
              setThumbnailDisplayed(true);
              applyFitOrUpdate(
                hasSavedState,
                cachedThumbnail.width,
                cachedThumbnail.height,
              );

              // Phase 2: preview in the background; falls through to full
              // resolution only if the preview failed.
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

              const loadResult = await loadFullResolution(path, signal);
              if (loadResult.status === "aborted") {
                return;
              }

              const { fullImageData, element } = loadResult;

              setImageData(fullImageData);
              // The phase-1 placeholder is gone.
              setThumbnailDisplayed(false);

              applyFitOrUpdate(
                hasSavedState,
                fullImageData.width,
                fullImageData.height,
              );

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

          const loadResult = await loadFullResolution(path, signal);
          if (loadResult.status === "aborted") {
            return;
          }

          const { fullImageData, element } = loadResult;

          setImageData(fullImageData);
          // No-op on the cold path; clears the phase-1 placeholder when the
          // two-phase branch fell through to here after an error.
          setThumbnailDisplayed(false);

          applyFitOrUpdate(
            hasSavedState,
            fullImageData.width,
            fullImageData.height,
          );

          setPreloadedImage(path, fullImageData);
          retainElementAsBitmap(path, element);
        } else {
          // GIFs: direct load preserves animation.
          const imageData = (await loadImageViaProtocol(path)).data;

          if (signal.aborted || activeLoadPathRef.current !== path) {
            return;
          }

          if (!imageData) {
            throw new Error("Failed to load image: No data returned");
          }

          setImageData(imageData);
          applyFitOrUpdate(hasSavedState, imageData.width, imageData.height);

          setPreloadedImage(path, imageData);
        }
      } catch (error) {
        if (!signal.aborted && activeLoadPathRef.current === path) {
          console.error("Failed to load image:", error);
          setImageError(error as Error);
        }
      } finally {
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
      setThumbnailDisplayed,
      displayPreview,
      applyFitOrUpdate,
      loadFullResolution,
    ],
  );

  // Load image with debounce to handle rapid navigation
  useEffect(() => {
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
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      if (signal.aborted) return;

      await loadImage(currentImage.path, signal);
    }, debounceDelay);

    return () => {
      clearTimeout(timeoutId);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [currentImage.path, loadImage]);

  // Zoom past the preview's pixel density -> upgrade to the full-resolution
  // decode (§6.5 (I4)). Debounced so a wheel gesture schedules one decode
  // after the zoom settles, not one per notch.
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
    // Display tier of this paint (§7.1). The bench keeps judging "full
    // paint" by thumbnail === false; tier is the explicit label that will
    // distinguish preview from full later.
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
      const isImageClick =
        e.target === imageRef.current || e.target === canvasRef.current;

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
        const deltaX = (e.clientX - dragStart.x) / (view.zoom / 100);
        const deltaY = (e.clientY - dragStart.y) / (view.zoom / 100);

        setPan(view.panX + deltaX, view.panY + deltaY);

        setDragStart({ x: e.clientX, y: e.clientY });
      }
    },
    [isDragging, dragStart, view.zoom, view.panX, view.panY, setPan],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
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

      const rect = containerRef.current.getBoundingClientRect();
      const containerCenterX = rect.left + rect.width / 2;
      const containerCenterY = rect.top + rect.height / 2;

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
    const imageWidth = currentImage.data?.width || 0;
    const imageHeight = currentImage.data?.height || 0;

    const baseLeft = view.imageLeft ?? 0;
    const baseTop = view.imageTop ?? 0;

    return {
      left: baseLeft,
      top: baseTop,
      width: imageWidth,
      height: imageHeight,
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
