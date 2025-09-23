import React from 'react';
import ImageViewer from './components/ImageViewer';
import DropZone from './components/DropZone';
import FileOpenButton from './components/FileOpenButton';
import ThumbnailBar from './components/ThumbnailBar';
import { useKeyboard } from './hooks/useKeyboard';
// import { useFileDrop } from './hooks/useFileDrop';
import { useCacheManager } from './hooks/useCacheManager';
import { useAppStore } from './store';
import './App.css';

const App: React.FC = () => {
  const { ui, currentImage } = useAppStore();

  useKeyboard();
  // useFileDrop(); // Temporarily disabled to test thumbnails
  useCacheManager();

  return (
    <div className="photo-viewer-app">
      <DropZone className="main-drop-zone">
        <ImageViewer />

        {!currentImage.path && (
          <div className="welcome-overlay">
            <div className="welcome-content">
              <h1>Spica Photo Viewer</h1>
              <p>Open an image file to get started</p>
              <FileOpenButton className="welcome-button" />
            </div>
          </div>
        )}
      </DropZone>

      {ui.error && (
        <div className="error-toast">
          {ui.error.message}
        </div>
      )}

      <ThumbnailBar />
    </div>
  );
};

export default App;
