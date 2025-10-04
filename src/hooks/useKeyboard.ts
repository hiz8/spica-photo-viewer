import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";

export const useKeyboard = () => {
  const {
    navigateNext,
    navigatePrevious,
    zoomIn,
    zoomOut,
    resetZoom,
    setFullscreen,
    setShowAbout,
    view,
    ui,
  } = useAppStore();

  const toggleFullscreen = async () => {
    try {
      const window = getCurrentWindow();
      const isCurrentlyFullscreen = await window.isFullscreen();

      if (isCurrentlyFullscreen) {
        await window.setFullscreen(false);
        setFullscreen(false);
      } else {
        await window.setFullscreen(true);
        setFullscreen(true);
      }
    } catch (error) {
      console.error("Failed to toggle fullscreen:", error);
    }
  };

  const exitFullscreen = async () => {
    try {
      const window = getCurrentWindow();
      await window.setFullscreen(false);
      setFullscreen(false);
    } catch (error) {
      console.error("Failed to exit fullscreen:", error);
    }
  };

  const closeApplication = async () => {
    try {
      const window = getCurrentWindow();
      await window.close();
    } catch (error) {
      console.error("Failed to close application:", error);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          navigatePrevious();
          break;

        case "ArrowRight":
          event.preventDefault();
          navigateNext();
          break;

        case "ArrowUp":
          event.preventDefault();
          zoomIn();
          break;

        case "ArrowDown":
          event.preventDefault();
          zoomOut();
          break;

        case "F11":
          event.preventDefault();
          toggleFullscreen();
          break;

        case "Escape":
          event.preventDefault();
          if (ui.showAbout) {
            setShowAbout(false);
          } else if (view.isFullscreen) {
            exitFullscreen();
          } else {
            closeApplication();
          }
          break;

        case "F1":
          event.preventDefault();
          setShowAbout(true);
          break;

        case "0":
          if (event.ctrlKey) {
            event.preventDefault();
            resetZoom();
          }
          break;

        default:
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    navigateNext,
    navigatePrevious,
    zoomIn,
    zoomOut,
    resetZoom,
    setFullscreen,
    setShowAbout,
    view.isFullscreen,
    ui.showAbout,
  ]);
};
