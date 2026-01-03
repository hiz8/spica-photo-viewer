import type React from "react";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import ImageViewer from "./components/ImageViewer";
import DropZone from "./components/DropZone";
import FileOpenButton from "./components/FileOpenButton";
import ThumbnailBar from "./components/ThumbnailBar";
import AboutDialog from "./components/AboutDialog";
import { useKeyboard } from "./hooks/useKeyboard";
// import { useFileDrop } from './hooks/useFileDrop';
import { useCacheManager } from "./hooks/useCacheManager";
import { useWindowState } from "./hooks/useWindowState";
import { useAppStore } from "./store";
import "./App.css";

const App: React.FC = () => {
  const { ui, currentImage, view, openImageFromPath, setCheckingStartupFile } =
    useAppStore();

  useKeyboard();
  // useFileDrop(); // Temporarily disabled to test thumbnails
  useCacheManager();
  useWindowState();

  // Check for startup file (from file association)
  useEffect(() => {
    const checkStartupFile = async () => {
      try {
        const startupFile = await invoke<string | null>("get_startup_file");
        if (startupFile) {
          console.log("Opening startup file:", startupFile);
          await openImageFromPath(startupFile);
        }
      } catch (error) {
        console.error("Failed to check startup file:", error);
      } finally {
        setCheckingStartupFile(false);
      }
    };

    checkStartupFile();
  }, [openImageFromPath, setCheckingStartupFile]);

  return (
    <div
      className={`photo-viewer-app ${view.isFullscreen ? "fullscreen" : ""}`}
    >
      <DropZone className="main-drop-zone">
        <ImageViewer />

        {!currentImage.path && !ui.isCheckingStartupFile && (
          <div className="welcome-overlay">
            <div className="welcome-content">
              <h1>Spica Photo Viewer</h1>
              <p>Open an image file to get started</p>
              <FileOpenButton className="welcome-button" />
            </div>
          </div>
        )}
      </DropZone>

      {ui.error && <div className="error-toast">{ui.error.message}</div>}

      <ThumbnailBar />
      <AboutDialog />
    </div>
  );
};

export default App;
