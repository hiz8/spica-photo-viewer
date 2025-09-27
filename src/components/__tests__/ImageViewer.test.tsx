import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockImageData, createMouseEvent, createWheelEvent } from '../../utils/testUtils';

// Mock the invoke function
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock the useImagePreloader hook
vi.mock('../../hooks/useImagePreloader', () => ({
  useImagePreloader: vi.fn(),
}));

// Mock the store
const mockStore = {
  currentImage: {
    path: '',
    data: null,
    error: null,
  },
  view: {
    zoom: 100,
    panX: 0,
    panY: 0,
  },
  cache: {
    preloaded: new Map(),
  },
  setImageData: vi.fn(),
  setImageError: vi.fn(),
  setLoading: vi.fn(),
  setPan: vi.fn(),
  zoomAtPoint: vi.fn(),
  fitToWindow: vi.fn(),
};

vi.mock('../../store', () => ({
  useAppStore: vi.fn(() => mockStore),
}));

import ImageViewer from '../ImageViewer';
import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

describe('ImageViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    mockStore.currentImage.path = '';
    mockStore.currentImage.data = null;
    mockStore.currentImage.error = null;
    mockStore.view.zoom = 100;
    mockStore.view.panX = 0;
    mockStore.view.panY = 0;
    mockStore.cache.preloaded = new Map();
  });

  describe('Empty state', () => {
    it('should render empty state when no image selected', () => {
      render(<ImageViewer />);

      expect(screen.getByText('No image selected')).toBeInTheDocument();
      expect(screen.getByText('No image selected').parentElement).toHaveClass('image-viewer-empty');
    });

    it('should apply custom className in empty state', () => {
      render(<ImageViewer className="custom-class" />);

      expect(screen.getByText('No image selected').parentElement).toHaveClass('image-viewer-empty', 'custom-class');
    });
  });

  describe('Error state', () => {
    it('should render error state when image has error', () => {
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.error = new Error('Failed to load image');

      render(<ImageViewer />);

      expect(screen.getByText('Failed to load image: Failed to load image')).toBeInTheDocument();
      expect(screen.getByText('Failed to load image: Failed to load image').parentElement).toHaveClass('image-viewer-error');
    });
  });

  describe('Loading state', () => {
    it('should render loading state when image path exists but no data', () => {
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = null;

      render(<ImageViewer />);

      expect(screen.getByText('Loading...')).toBeInTheDocument();
      expect(screen.getByText('Loading...').parentElement).toHaveClass('image-viewer-loading');
    });
  });

  describe('Image display', () => {
    beforeEach(() => {
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = mockImageData;
    });

    it('should render image when data is available', () => {
      render(<ImageViewer />);

      const image = screen.getByRole('img');
      expect(image).toBeInTheDocument();
      expect(image).toHaveAttribute('src', `data:image/${mockImageData.format};base64,${mockImageData.base64}`);
      expect(image).toHaveAttribute('alt', '/test/image.jpg');
      expect(image).toHaveAttribute('draggable', 'false');
    });

    it('should apply transform styles based on zoom and pan', () => {
      mockStore.view.zoom = 150;
      mockStore.view.panX = 50;
      mockStore.view.panY = 25;

      render(<ImageViewer />);

      const image = screen.getByRole('img');
      expect(image).toHaveStyle({
        transform: 'scale(1.5) translate(50px, 25px)',
      });
    });

    it('should show zoom indicator when zoom is not 100%', () => {
      mockStore.view.zoom = 200;

      render(<ImageViewer />);

      expect(screen.getByText('200%')).toBeInTheDocument();
      expect(screen.getByText('200%')).toHaveClass('zoom-indicator');
    });

    it('should not show zoom indicator when zoom is 100%', () => {
      mockStore.view.zoom = 100;

      render(<ImageViewer />);

      expect(screen.queryByText('100%')).not.toBeInTheDocument();
    });

    it('should apply cursor style based on dragging state', () => {
      render(<ImageViewer />);

      const image = screen.getByRole('img');
      expect(image).toHaveStyle({ cursor: 'grab' });
    });
  });

  describe('Image loading', () => {
    it('should load image on mount when path exists but no data', async () => {
      mockInvoke.mockResolvedValue(mockImageData);
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = null;

      render(<ImageViewer />);

      expect(mockStore.setLoading).toHaveBeenCalledWith(true);
      expect(mockStore.setImageError).toHaveBeenCalledWith(null);

      // Wait for async operation
      await vi.waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('load_image', { path: '/test/image.jpg' });
        expect(mockStore.setImageData).toHaveBeenCalledWith(mockImageData);
        expect(mockStore.fitToWindow).toHaveBeenCalledWith(mockImageData.width, mockImageData.height);
        expect(mockStore.setLoading).toHaveBeenCalledWith(false);
      });
    });

    it('should use preloaded image if available', () => {
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = null;
      mockStore.cache.preloaded.set('/test/image.jpg', mockImageData);

      render(<ImageViewer />);

      expect(mockStore.setImageData).toHaveBeenCalledWith(mockImageData);
      expect(mockStore.fitToWindow).toHaveBeenCalledWith(mockImageData.width, mockImageData.height);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should handle preloaded error images', () => {
      const errorImage = { ...mockImageData, format: 'error' as const };
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = null;
      mockStore.cache.preloaded.set('/test/image.jpg', errorImage);

      render(<ImageViewer />);

      expect(mockStore.setLoading).toHaveBeenCalledWith(true);
      expect(mockStore.setImageError).toHaveBeenCalledWith(expect.any(Error));
      expect(mockStore.setLoading).toHaveBeenCalledWith(false);
    });

    it('should handle image loading error', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockInvoke.mockRejectedValue(new Error('Load failed'));
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = null;

      render(<ImageViewer />);

      await vi.waitFor(() => {
        expect(mockStore.setImageError).toHaveBeenCalledWith(expect.any(Error));
        expect(mockStore.setLoading).toHaveBeenCalledWith(false);
      });

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Mouse interactions', () => {
    beforeEach(() => {
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = mockImageData;
    });

    it('should start dragging on mouse down', () => {
      render(<ImageViewer />);

      const container = screen.getByRole('img').parentElement!;
      fireEvent.mouseDown(container, { clientX: 100, clientY: 50 });

      // Image should change to grabbing cursor during drag
      const image = screen.getByRole('img');
      expect(image).toHaveStyle({ cursor: 'grabbing' });
    });

    it('should handle mouse move during drag', () => {
      render(<ImageViewer />);

      const container = screen.getByRole('img').parentElement!;

      // Start drag
      fireEvent.mouseDown(container, { clientX: 100, clientY: 50 });

      // Move mouse
      fireEvent.mouseMove(container, { clientX: 120, clientY: 70 });

      expect(mockStore.setPan).toHaveBeenCalled();
    });

    it('should stop dragging on mouse up', () => {
      render(<ImageViewer />);

      const container = screen.getByRole('img').parentElement!;

      // Start and stop drag
      fireEvent.mouseDown(container, { clientX: 100, clientY: 50 });
      fireEvent.mouseUp(container);

      const image = screen.getByRole('img');
      expect(image).toHaveStyle({ cursor: 'grab' });
    });

    it('should stop dragging on mouse leave', () => {
      render(<ImageViewer />);

      const container = screen.getByRole('img').parentElement!;

      // Start drag and leave
      fireEvent.mouseDown(container, { clientX: 100, clientY: 50 });
      fireEvent.mouseLeave(container);

      const image = screen.getByRole('img');
      expect(image).toHaveStyle({ cursor: 'grab' });
    });

    it('should render container with event handlers', () => {
      render(<ImageViewer />);

      const container = screen.getByRole('img').parentElement!;

      // Verify that the container is properly rendered and can receive events
      expect(container).toBeInTheDocument();
      expect(container).toHaveClass('image-viewer');
    });

    it('should handle wheel event for zooming', () => {
      // Mock getBoundingClientRect
      const mockGetBoundingClientRect = vi.fn(() => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
      }));

      render(<ImageViewer />);

      const container = screen.getByRole('img').parentElement!;
      container.getBoundingClientRect = mockGetBoundingClientRect;

      // Use fireEvent.wheel directly with proper event properties
      fireEvent.wheel(container, {
        deltaY: -120,
        clientX: 400,
        clientY: 300,
      });

      expect(mockStore.zoomAtPoint).toHaveBeenCalled();
    });
  });

  describe('Window resize handling', () => {
    beforeEach(() => {
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = mockImageData;
    });

    it('should refit image on window resize', () => {
      render(<ImageViewer />);

      // Clear previous calls
      mockStore.fitToWindow.mockClear();

      // Trigger resize
      fireEvent(window, new Event('resize'));

      expect(mockStore.fitToWindow).toHaveBeenCalledWith(mockImageData.width, mockImageData.height);
    });

    it('should cleanup resize listener on unmount', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = render(<ImageViewer />);
      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));

      removeEventListenerSpy.mockRestore();
    });
  });

  describe('Transition effects', () => {
    beforeEach(() => {
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = mockImageData;
    });

    it('should disable transition during drag', () => {
      render(<ImageViewer />);

      const container = screen.getByRole('img').parentElement!;
      const image = screen.getByRole('img');

      // Start drag
      fireEvent.mouseDown(container, { clientX: 100, clientY: 50 });

      expect(image).toHaveStyle({ transition: 'none' });
    });

    it('should enable transition when not dragging', () => {
      render(<ImageViewer />);

      const image = screen.getByRole('img');

      expect(image).toHaveStyle({ transition: 'transform 0.1s ease-out' });
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA roles and attributes', () => {
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = mockImageData;

      render(<ImageViewer />);

      const container = screen.getByRole('img').parentElement!;
      expect(container).toHaveClass('image-viewer');

      const image = screen.getByRole('img');
      expect(image).toHaveAttribute('alt', '/test/image.jpg');
    });

    it('should prevent default dragging behavior', () => {
      mockStore.currentImage.path = '/test/image.jpg';
      mockStore.currentImage.data = mockImageData;

      render(<ImageViewer />);

      const image = screen.getByRole('img');
      expect(image).toHaveAttribute('draggable', 'false');
    });
  });
});