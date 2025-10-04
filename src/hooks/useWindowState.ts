import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import type { WindowState } from "../types";

export const useWindowState = () => {
  const { setMaximized, setFullscreen } = useAppStore();

  useEffect(() => {
    let isMonitoring = true;

    const checkWindowState = async () => {
      try {
        const windowState = await invoke<WindowState>("get_window_state");
        if (isMonitoring) {
          setMaximized(windowState.is_maximized);
          setFullscreen(windowState.is_fullscreen);
        }
      } catch (error) {
        console.error("Failed to get window state:", error);
      }
    };

    // Check initial state
    checkWindowState();

    // Listen for window resize events
    const handleResize = () => {
      checkWindowState();
    };

    // Use Tauri's window events for more accurate state tracking
    const setupWindowListeners = async () => {
      try {
        const window = getCurrentWindow();

        const unlistenResize = await window.listen(
          "tauri://resize",
          handleResize,
        );
        const unlistenMaximize = await window.listen("tauri://maximize", () => {
          if (isMonitoring) {
            setMaximized(true);
          }
        });
        const unlistenUnmaximize = await window.listen(
          "tauri://unmaximize",
          () => {
            if (isMonitoring) {
              setMaximized(false);
            }
          },
        );

        // Cleanup function
        return () => {
          unlistenResize();
          unlistenMaximize();
          unlistenUnmaximize();
        };
      } catch (error) {
        console.error("Failed to setup window listeners:", error);
        // Fallback to regular resize listener
        window.addEventListener("resize", handleResize);
        return () => {
          window.removeEventListener("resize", handleResize);
        };
      }
    };

    let cleanup: (() => void) | undefined;
    setupWindowListeners().then((fn) => {
      cleanup = fn;
    });

    return () => {
      isMonitoring = false;
      if (cleanup) {
        cleanup();
      }
    };
  }, [setMaximized, setFullscreen]);
};
