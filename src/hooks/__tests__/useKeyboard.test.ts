import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createKeyboardEvent } from '../../utils/testUtils';

// Mock Tauri window API
const mockWindow = {
  isFullscreen: vi.fn(),
  setFullscreen: vi.fn(),
  close: vi.fn(),
};

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => mockWindow),
}));

// Mock the store
const mockStore = {
  navigateNext: vi.fn(),
  navigatePrevious: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  resetZoom: vi.fn(),
  setFullscreen: vi.fn(),
  setShowAbout: vi.fn(),
  view: {
    isFullscreen: false,
  },
  ui: {
    showAbout: false,
  },
};

vi.mock('../../store', () => ({
  useAppStore: vi.fn(() => mockStore),
}));

import { useKeyboard } from '../useKeyboard';

describe('useKeyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.view.isFullscreen = false;
    mockStore.ui.showAbout = false;

    // Reset window API mocks
    mockWindow.isFullscreen.mockResolvedValue(false);
    mockWindow.setFullscreen.mockResolvedValue(undefined);
    mockWindow.close.mockResolvedValue(undefined);
  });

  it('should handle arrow left key for previous navigation', () => {
    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('ArrowLeft');
    document.dispatchEvent(event);

    expect(mockStore.navigatePrevious).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('should handle arrow right key for next navigation', () => {
    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('ArrowRight');
    document.dispatchEvent(event);

    expect(mockStore.navigateNext).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('should handle arrow up key for zoom in', () => {
    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('ArrowUp');
    document.dispatchEvent(event);

    expect(mockStore.zoomIn).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('should handle arrow down key for zoom out', () => {
    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('ArrowDown');
    document.dispatchEvent(event);

    expect(mockStore.zoomOut).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('should handle F11 key for fullscreen toggle', async () => {
    mockWindow.isFullscreen.mockResolvedValue(false);

    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('F11');
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    // Wait for async operation
    await vi.waitFor(() => {
      expect(mockWindow.isFullscreen).toHaveBeenCalledOnce();
    });
  });

  it('should handle F11 key to exit fullscreen when already fullscreen', async () => {
    mockWindow.isFullscreen.mockResolvedValue(true);

    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('F11');
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    await vi.waitFor(() => {
      expect(mockWindow.isFullscreen).toHaveBeenCalledOnce();
      expect(mockWindow.setFullscreen).toHaveBeenCalledWith(false);
      expect(mockStore.setFullscreen).toHaveBeenCalledWith(false);
    });
  });

  it('should handle F11 key to enter fullscreen when not fullscreen', async () => {
    mockWindow.isFullscreen.mockResolvedValue(false);

    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('F11');
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    await vi.waitFor(() => {
      expect(mockWindow.isFullscreen).toHaveBeenCalledOnce();
      expect(mockWindow.setFullscreen).toHaveBeenCalledWith(true);
      expect(mockStore.setFullscreen).toHaveBeenCalledWith(true);
    });
  });

  it('should handle F1 key to show About dialog', () => {
    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('F1');
    document.dispatchEvent(event);

    expect(mockStore.setShowAbout).toHaveBeenCalledWith(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('should handle Ctrl+0 for zoom reset', () => {
    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('0', true); // Ctrl key pressed
    document.dispatchEvent(event);

    expect(mockStore.resetZoom).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('should not handle 0 key without Ctrl modifier', () => {
    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('0', false);
    document.dispatchEvent(event);

    expect(mockStore.resetZoom).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  describe('Escape key behavior', () => {
    it('should close About dialog when About is shown', async () => {
      mockStore.ui.showAbout = true;

      renderHook(() => useKeyboard());

      const event = createKeyboardEvent('Escape');
      document.dispatchEvent(event);

      expect(mockStore.setShowAbout).toHaveBeenCalledWith(false);
      expect(event.defaultPrevented).toBe(true);
    });

    it('should exit fullscreen when in fullscreen mode and About not shown', async () => {
      mockStore.view.isFullscreen = true;
      mockStore.ui.showAbout = false;

      renderHook(() => useKeyboard());

      const event = createKeyboardEvent('Escape');
      document.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);

      await vi.waitFor(() => {
        expect(mockWindow.setFullscreen).toHaveBeenCalledWith(false);
        expect(mockStore.setFullscreen).toHaveBeenCalledWith(false);
      });
    });

    it('should close application when not in fullscreen and About not shown', async () => {
      mockStore.view.isFullscreen = false;
      mockStore.ui.showAbout = false;

      renderHook(() => useKeyboard());

      const event = createKeyboardEvent('Escape');
      document.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);

      await vi.waitFor(() => {
        expect(mockWindow.close).toHaveBeenCalledOnce();
      });
    });
  });

  it('should ignore unhandled keys', () => {
    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('Space');
    document.dispatchEvent(event);

    // Should not call any store methods
    expect(mockStore.navigateNext).not.toHaveBeenCalled();
    expect(mockStore.navigatePrevious).not.toHaveBeenCalled();
    expect(mockStore.zoomIn).not.toHaveBeenCalled();
    expect(mockStore.zoomOut).not.toHaveBeenCalled();
    expect(mockStore.resetZoom).not.toHaveBeenCalled();
    expect(mockStore.setFullscreen).not.toHaveBeenCalled();
    expect(mockStore.setShowAbout).not.toHaveBeenCalled();

    // Should not prevent default
    expect(event.defaultPrevented).toBe(false);
  });

  it('should cleanup event listener on unmount', () => {
    const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

    const { unmount } = renderHook(() => useKeyboard());

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

    removeEventListenerSpy.mockRestore();
  });

  it('should handle fullscreen API errors gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockWindow.setFullscreen.mockRejectedValue(new Error('Fullscreen API error'));

    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('F11');
    document.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to toggle fullscreen:', expect.any(Error));
    });

    consoleSpy.mockRestore();
  });

  it('should handle window close API errors gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockWindow.close.mockRejectedValue(new Error('Close API error'));
    mockStore.view.isFullscreen = false;
    mockStore.ui.showAbout = false;

    renderHook(() => useKeyboard());

    const event = createKeyboardEvent('Escape');
    document.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to close application:', expect.any(Error));
    });

    consoleSpy.mockRestore();
  });

  it('should handle multiple sequential key presses correctly', () => {
    renderHook(() => useKeyboard());

    // Simulate rapid key presses
    const leftEvent = createKeyboardEvent('ArrowLeft');
    const rightEvent = createKeyboardEvent('ArrowRight');
    const upEvent = createKeyboardEvent('ArrowUp');

    document.dispatchEvent(leftEvent);
    document.dispatchEvent(rightEvent);
    document.dispatchEvent(upEvent);

    expect(mockStore.navigatePrevious).toHaveBeenCalledTimes(1);
    expect(mockStore.navigateNext).toHaveBeenCalledTimes(1);
    expect(mockStore.zoomIn).toHaveBeenCalledTimes(1);

    expect(leftEvent.defaultPrevented).toBe(true);
    expect(rightEvent.defaultPrevented).toBe(true);
    expect(upEvent.defaultPrevented).toBe(true);
  });
});