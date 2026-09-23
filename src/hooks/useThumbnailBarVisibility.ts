// Spec: docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type BarEvent,
  type BarState,
  initialBarState,
  stepBar,
} from "../utils/thumbnailBarGesture";

export interface ThumbnailBarProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur: (e: React.FocusEvent<HTMLElement>) => void;
}

// jsdom's selector engine may reject :focus-visible; that counts as mouse focus.
function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** Shown again whenever showKey changes, including on mount (D3). */
export function useThumbnailBarVisibility(
  showKey: string,
  barRef: React.RefObject<HTMLElement | null>,
): {
  shown: boolean;
  barProps: ThumbnailBarProps;
} {
  const [initial] = useState(() => initialBarState(performance.now()));
  const stateRef = useRef<BarState>(initial);
  const [shown, setShown] = useState(initial.shown);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);

  const dispatch = useCallback((event: BarEvent) => {
    const prev = stateRef.current;
    const next = stepBar(prev, event);
    stateRef.current = next;
    // Every pointermove goes through here; only a flip may re-render.
    if (next.shown !== prev.shown) setShown(next.shown);

    if (next.hideAt === null) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    } else if (timerRef.current === undefined) {
      // One pending timer at most: hideAt only moves later, so the timer
      // re-arms itself from the tick instead of being reset on every move.
      timerRef.current = setTimeout(
        () => {
          timerRef.current = undefined;
          // oxlint-disable-next-line react/immutability -- self-recursion is the point: the tick re-dispatches through the same stable (useCallback([])) dispatch
          dispatch({ type: "tick", t: performance.now() });
        },
        Math.max(0, next.hideAt - performance.now()),
      );
    }
    // oxlint-disable-next-line react/memo-dependencies -- the missing dep IS dispatch itself; a callback cannot list itself
  }, []);

  const setHold = useCallback(
    (ref: { current: boolean }, value: boolean) => {
      ref.current = value;
      const held = hoverRef.current || focusRef.current;
      if (held !== stateRef.current.held) {
        dispatch({ type: "hoverChange", held, t: performance.now() });
      }
    },
    [dispatch],
  );

  useEffect(() => {
    // timeStamp, not performance.now(): moves queued behind a long decode are
    // delivered together and would read as a huge velocity.
    const onMove = (e: PointerEvent) => {
      // ThumbnailBar windows its items, so ArrowRight past the edge or a
      // folder change can unmount the focused thumbnail without firing
      // onBlur, stranding the hold; any move is a cheap place to notice.
      if (
        focusRef.current &&
        !barRef.current?.contains(document.activeElement)
      ) {
        setHold(focusRef, false);
      }
      dispatch({
        type: "move",
        x: e.clientX,
        y: e.clientY,
        t: e.timeStamp,
        buttons: e.buttons,
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [dispatch, setHold, barRef]);

  useEffect(() => {
    dispatch({ type: "forceShow", t: performance.now() });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- showKey is unread but IS the re-fire trigger (D3): a new folder must force the bar shown
  }, [showKey, dispatch]);

  const barProps: ThumbnailBarProps = {
    onMouseEnter: () => setHold(hoverRef, true),
    onMouseLeave: () => setHold(hoverRef, false),
    // Focus left on a thumbnail by a mouse click must not hold the bar (D7).
    onFocus: (e) => setHold(focusRef, isFocusVisible(e.target)),
    onBlur: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) {
        setHold(focusRef, false);
      }
    },
  };

  return { shown, barProps };
}
