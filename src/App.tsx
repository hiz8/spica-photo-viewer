import React from 'react';
import ImageViewer from './components/ImageViewer';
import DropZone from './components/DropZone';
import { useKeyboard } from './hooks/useKeyboard';
import { useAppStore } from './store';
import './App.css';

const App: React.FC = () => {
  const { ui } = useAppStore();

  useKeyboard();

  return (
    <div className="photo-viewer-app">
      <DropZone className="main-drop-zone">
        <ImageViewer />
      </DropZone>

      {ui.error && (
        <div className="error-toast">
          {ui.error.message}
        </div>
      )}
    </div>
  );
};

export default App;
