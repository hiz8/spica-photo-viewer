import type React from "react";

import { useZoomIndicatorVisibility } from "../hooks/useZoomIndicatorVisibility";

interface ZoomIndicatorProps {
  zoom: number;
  zoomOperation: number;
}

// Always mounted: hiding by class keeps the fade-out a CSS transition.
const ZoomIndicator: React.FC<ZoomIndicatorProps> = ({
  zoom,
  zoomOperation,
}) => {
  const shown = useZoomIndicatorVisibility(zoomOperation);

  return (
    <div
      className={`zoom-indicator${shown ? " shown" : ""}`}
      aria-hidden={!shown}
    >
      {Math.round(zoom)}%
    </div>
  );
};

export default ZoomIndicator;
