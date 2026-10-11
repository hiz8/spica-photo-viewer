// Spec: docs/code-rationale.md#W7
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { useAppStore } from "../store";
import { perfMark } from "../utils/perf";

/** Payload of the Rust `window-transition` event: the new client size in physical px. */
export interface WindowTransition {
  id: number;
  width: number;
  height: number;
  /**
   * Tauri 2 has no maximize event; without this the store learns the state
   * from a get_window_state round trip after the resize, and the image laid
   * out for the wrong area jumps once more after the cover is gone.
   */
  maximized: boolean;
}

/** DPI scaling rounds the CSS viewport to within a pixel of the physical client. */
const SIZE_TOLERANCE_PX = 2;

/**
 * The resize event normally lands within a frame or two of the Rust event; a
 * page that never sees it (hidden, or the size was corrected again) must
 * still release the cover, which is a frozen picture of the old layout.
 */
export const LAYOUT_TIMEOUT_MS = 300;

export const viewportMatches = (
  innerWidth: number,
  innerHeight: number,
  devicePixelRatio: number,
  target: { width: number; height: number },
): boolean =>
  Math.abs(Math.round(innerWidth * devicePixelRatio) - target.width) <=
    SIZE_TOLERANCE_PX &&
  Math.abs(Math.round(innerHeight * devicePixelRatio) - target.height) <=
    SIZE_TOLERANCE_PX;

/**
 * Frames to let pass after the viewport first matches `target`. The resize
 * event and the re-layout it triggers run before that frame's rAF callbacks,
 * so the frame that observes the size also lays out the new content. One
 * more frame only proves that layout was committed: Chromium lets the main
 * thread run a frame ahead of the compositor, and a maximize re-rasterizes
 * the image at the new size, so the committed frame can still be in raster
 * when the next rAF fires (seen as the old windowed frame at the top-left
 * once the cover was gone). The compositor cannot fall two frames behind, so
 * the second extra frame means it was drawn.
 */
const SETTLE_FRAMES = 2;

/** Resolves `SETTLE_FRAMES` animation frames after the viewport first matches `target`. */
const waitForLayout = (
  target: WindowTransition,
  isLive: () => boolean,
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (matched: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(matched);
    };
    const timer = setTimeout(() => finish(false), LAYOUT_TIMEOUT_MS);
    const settle = (framesLeft: number) => {
      if (framesLeft === 0) {
        finish(true);
      } else {
        requestAnimationFrame(() => settle(framesLeft - 1));
      }
    };
    const tick = () => {
      if (settled || !isLive()) return;
      if (
        viewportMatches(
          window.innerWidth,
          window.innerHeight,
          window.devicePixelRatio,
          target,
        )
      ) {
        settle(SETTLE_FRAMES);
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });

/**
 * Tells Rust when the layout for a new client size is on screen, so it can
 * drop the cover holding the previous pixels (W7).
 */
export const useWindowTransition = () => {
  useEffect(() => {
    let live = true;
    const isLive = () => live;

    const onTransition = async (payload: WindowTransition) => {
      const started = performance.now();
      useAppStore.getState().setMaximized(payload.maximized);
      const matched = await waitForLayout(payload, isLive);
      if (!live) return;
      perfMark("window:transition_painted", {
        id: payload.id,
        matched,
        ms: performance.now() - started,
      });
      try {
        await invoke("end_window_transition", { id: payload.id });
      } catch (error) {
        console.error("Failed to end the window transition:", error);
      }
    };

    const unlisten = getCurrentWindow().listen<WindowTransition>(
      "window-transition",
      (event) => {
        void onTransition(event.payload);
      },
    );

    return () => {
      live = false;
      void unlisten.then((fn) => fn());
    };
  }, []);
};
