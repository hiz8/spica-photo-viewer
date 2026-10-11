// Spec: docs/code-rationale.md#W7
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { perfMark } from "../utils/perf";

/** Payload of the Rust `window-transition` event: the new client size in physical px. */
export interface WindowTransition {
  id: number;
  width: number;
  height: number;
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
 * Resolves one animation frame after the viewport first matches `target`:
 * the resize event and the re-layout it triggers run before that frame's
 * rAF callbacks, so the frame that observes the size also paints the new
 * layout, and the following frame means it has been committed.
 */
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
        requestAnimationFrame(() => finish(true));
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
