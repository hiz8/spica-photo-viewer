import React from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { ImageInfo } from '../types';

interface FileOpenButtonProps {
  className?: string;
}

const FileOpenButton: React.FC<FileOpenButtonProps> = ({ className = '' }) => {
  const {
    setCurrentImage,
    setFolderImages,
    setError,
    setLoading,
  } = useAppStore();

  const handleOpenFile = async () => {
    try {
      setLoading(true);
      setError(null);

      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Images',
            extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif']
          }
        ]
      });

      if (selected && typeof selected === 'string') {
        // Maximize window when opening an image
        try {
          await invoke('maximize_window');
        } catch (error) {
          console.error('Failed to maximize window when opening image via file dialog:', error);
        }

        // Get folder images
        const lastSep = Math.max(selected.lastIndexOf('\\'), selected.lastIndexOf('/'));
        const folderPath = selected.substring(0, lastSep);
        const folderImages = await invoke<ImageInfo[]>('get_folder_images', {
          path: folderPath
        });

        setFolderImages(folderPath, folderImages);

        // Set current image
        const imageIndex = folderImages.findIndex(img => img.path === selected);
        if (imageIndex !== -1) {
          setCurrentImage(selected, imageIndex);
        }
      }
    } catch (error) {
      console.error('Failed to open file:', error);
      setError(new Error('Failed to open file'));
      setTimeout(() => setError(null), 3000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className={`file-open-button ${className}`}
      onClick={handleOpenFile}
    >
      Open Image
    </button>
  );
};

export default FileOpenButton;