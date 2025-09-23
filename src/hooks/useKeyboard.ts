import { useEffect } from 'react';
import { useAppStore } from '../store';

export const useKeyboard = () => {
  const {
    navigateNext,
    navigatePrevious,
    zoomIn,
    zoomOut,
    resetZoom,
    setFullscreen,
    view,
  } = useAppStore();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          navigatePrevious();
          break;

        case 'ArrowRight':
          event.preventDefault();
          navigateNext();
          break;

        case 'ArrowUp':
          event.preventDefault();
          zoomIn();
          break;

        case 'ArrowDown':
          event.preventDefault();
          zoomOut();
          break;

        case 'F11':
          event.preventDefault();
          setFullscreen(!view.isFullscreen);
          break;

        case 'Escape':
          event.preventDefault();
          if (view.isFullscreen) {
            setFullscreen(false);
          } else {
            window.close();
          }
          break;

        case '0':
          if (event.ctrlKey) {
            event.preventDefault();
            resetZoom();
          }
          break;

        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    navigateNext,
    navigatePrevious,
    zoomIn,
    zoomOut,
    resetZoom,
    setFullscreen,
    view.isFullscreen,
  ]);
};