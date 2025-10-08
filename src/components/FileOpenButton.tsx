import type React from "react";
import { useAppStore } from "../store";

interface FileOpenButtonProps {
  className?: string;
}

const FileOpenButton: React.FC<FileOpenButtonProps> = ({ className = "" }) => {
  const { openFileDialog } = useAppStore();

  return (
    <button
      type="button"
      className={`file-open-button ${className}`}
      onClick={openFileDialog}
    >
      Open Image
    </button>
  );
};

export default FileOpenButton;
