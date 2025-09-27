import React from 'react';
import { useAppStore } from '../store';

const AboutDialog: React.FC = () => {
  const { ui, setShowAbout } = useAppStore();

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

  return (
    <div className="about-dialog-backdrop" onClick={handleBackdropClick}>
      <div className="about-dialog">
        <div className="about-dialog-header">
          <h2>Spica Photo Viewer</h2>
          <button className="about-dialog-close" onClick={handleClose}>
            ×
          </button>
        </div>

        <div className="about-dialog-content">
          <div className="about-logo">
            <div className="logo-icon">📸</div>
            <p className="version">Version 1.0.0</p>
          </div>

          <div className="about-info">
            <p className="description">
              A lightweight, fast image viewer application for Windows,
              inspired by Picasa Photo Viewer.
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
                Built with <strong>Tauri v2</strong> and <strong>React 19</strong>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AboutDialog;