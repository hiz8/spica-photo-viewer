import type React from "react";
import { useCallback } from "react";
import { useAppStore } from "../store";

interface DropZoneProps {
  className?: string;
  children?: React.ReactNode;
}

const DropZone: React.FC<DropZoneProps> = ({ className = "", children }) => {
  const { ui, setDragOver, setError } = useAppStore();

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(true);
    },
    [setDragOver],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX;
      const y = e.clientY;

      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        setDragOver(false);
      }
    },
    [setDragOver],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);

      const items = Array.from(e.dataTransfer.items);

      if (items.length === 0) {
        return;
      }

      const item = items[0];

      if (item.kind !== "file" || !item.type.startsWith("image/")) {
        setError(new Error("Please drop image files only"));
        setTimeout(() => setError(null), 3000);
        return;
      }

      // For now, show a message that drag & drop from file system is not yet implemented
      setError(
        new Error(
          "File drag & drop from file system not yet implemented. Please use a file dialog instead.",
        ),
      );
      setTimeout(() => setError(null), 3000);
    },
    [setDragOver, setError],
  );

  return (
    <div
      role="region"
      className={`drop-zone ${className} ${ui.isDragOver ? "drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}

      {ui.isDragOver && (
        <div className="drop-overlay">
          <div className="drop-message">
            <div className="drop-icon">📁</div>
            <div className="drop-text">Drop image here</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DropZone;
