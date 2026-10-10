import { useEffect, useRef, useState } from "react";

import { ZOOM_INDICATOR_HIDE_DELAY_MS } from "../constants/timing";

/** Shown from each change of zoomOperation until the delay passes without another. */
export function useZoomIndicatorVisibility(zoomOperation: number): boolean {
  const [shown, setShown] = useState(false);
  // Compared with the mount-time count, not the last one seen: the count only
  // grows, and a re-run of the effect (StrictMode) must re-arm the timer its
  // cleanup cleared. Mounting past zero (the viewer back from an error) is
  // no zoom operation.
  const mountedAtRef = useRef(zoomOperation);

  useEffect(() => {
    if (zoomOperation === mountedAtRef.current) return;
    setShown(true);
    const timer = setTimeout(
      () => setShown(false),
      ZOOM_INDICATOR_HIDE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [zoomOperation]);

  return shown;
}
