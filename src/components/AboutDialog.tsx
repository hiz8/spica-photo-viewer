import type React from "react";
import { useState, useEffect, useId } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "../store";

const AboutDialog: React.FC = () => {
  const { ui, setShowAbout } = useAppStore();
  const [version, setVersion] = useState<string>("");
  const titleId = useId();

  useEffect(() => {
    const loadVersion = async () => {
      try {
        const appVersion = await getVersion();
        setVersion(appVersion);
      } catch (error) {
        console.error("Failed to get app version:", error);
        setVersion("Unknown");
      }
    };

    loadVersion();
  }, []);

  if (!ui.showAbout) {
    return null;
  }

  const handleClose = () => {
    setShowAbout(false);
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  const handleBackdropKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.target === e.currentTarget) {
        handleClose();
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="about-dialog-backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleBackdropKeyDown}
    >
      <div className="about-dialog">
        <div className="about-dialog-header">
          <h2 id={titleId}>Spica Photo Viewer</h2>
          <button
            type="button"
            className="about-dialog-close"
            onClick={handleClose}
          >
            ×
          </button>
        </div>

        <div className="about-dialog-content">
          <div className="about-logo">
            <div className="logo-icon">📸</div>
            <p className="version">Version {version}</p>
          </div>

          <div className="about-info">
            <p className="description">
              A lightweight, fast image viewer application for Windows, inspired
              by Picasa Photo Viewer.
            </p>

            <div className="features">
              <h3>Features</h3>
              <ul>
                <li>Support for JPEG, PNG, WebP, and GIF formats</li>
                <li>Thumbnail navigation with auto-scroll</li>
                <li>Smooth zoom and pan capabilities</li>
                <li>Fullscreen mode (F11)</li>
                <li>Keyboard shortcuts for navigation</li>
                <li>Intelligent image preloading</li>
                <li>Thumbnail caching system</li>
              </ul>
            </div>

            <div className="shortcuts">
              <h3>Keyboard Shortcuts</h3>
              <div className="shortcut-list">
                <div className="shortcut-item">
                  <kbd>←/→</kbd>
                  <span>Navigate images</span>
                </div>
                <div className="shortcut-item">
                  <kbd>↑/↓</kbd>
                  <span>Zoom in/out</span>
                </div>
                <div className="shortcut-item">
                  <kbd>Ctrl+0</kbd>
                  <span>Reset zoom</span>
                </div>
                <div className="shortcut-item">
                  <kbd>Ctrl+O</kbd>
                  <span>Open file</span>
                </div>
                <div className="shortcut-item">
                  <kbd>Ctrl+Shift+O</kbd>
                  <span>Open with app</span>
                </div>
                <div className="shortcut-item">
                  <kbd>F11</kbd>
                  <span>Fullscreen</span>
                </div>
                <div className="shortcut-item">
                  <kbd>ESC</kbd>
                  <span>Exit/Close</span>
                </div>
              </div>
            </div>

            <div className="tech-info">
              <p className="built-with">
                Built with <strong>Tauri v2</strong> and{" "}
                <strong>React 19</strong>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AboutDialog;
