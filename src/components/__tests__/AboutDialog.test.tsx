import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Mock Tauri app API
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(() => Promise.resolve('1.0.0')),
}));

// Mock the store
const mockStore = {
  ui: {
    showAbout: false,
  },
  setShowAbout: vi.fn(),
};

vi.mock('../../store', () => ({
  useAppStore: vi.fn(() => mockStore),
}));

import AboutDialog from '../AboutDialog';

describe('AboutDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.ui.showAbout = false;
  });

  it('should not render when showAbout is false', async () => {
    mockStore.ui.showAbout = false;

    await act(async () => {
      render(<AboutDialog />);
    });

    expect(screen.queryByText('Spica Photo Viewer')).not.toBeInTheDocument();
  });

  it('should render when showAbout is true', async () => {
    mockStore.ui.showAbout = true;

    await act(async () => {
      render(<AboutDialog />);
    });

    expect(screen.getByText('Spica Photo Viewer')).toBeInTheDocument();
  });

  it('should display application information', async () => {
    mockStore.ui.showAbout = true;

    await act(async () => {
      render(<AboutDialog />);
    });

    // Wait for version to load
    await act(async () => {
      await vi.waitFor(() => {
        expect(screen.getByText('Version 1.0.0')).toBeInTheDocument();
      });
    });

    // Check for description
    expect(screen.getByText(/A lightweight, fast image viewer application for Windows/)).toBeInTheDocument();

    // Check for features section
    expect(screen.getByText('Features')).toBeInTheDocument();
    expect(screen.getByText(/Support for JPEG, PNG, WebP, and GIF formats/)).toBeInTheDocument();
  });

  it('should display keyboard shortcuts', async () => {
    mockStore.ui.showAbout = true;

    await act(async () => {
      render(<AboutDialog />);
    });

    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();

    // Check for some key shortcuts based on actual component
    expect(screen.getByText('←/→')).toBeInTheDocument();
    expect(screen.getByText('Navigate images')).toBeInTheDocument();

    expect(screen.getByText('↑/↓')).toBeInTheDocument();
    expect(screen.getByText('Zoom in/out')).toBeInTheDocument();

    expect(screen.getByText('F11')).toBeInTheDocument();
    expect(screen.getByText('Fullscreen')).toBeInTheDocument();

    expect(screen.getByText('Ctrl+0')).toBeInTheDocument();
    expect(screen.getByText('Reset zoom')).toBeInTheDocument();

    expect(screen.getByText('ESC')).toBeInTheDocument();
    expect(screen.getByText('Exit/Close')).toBeInTheDocument();
  });

  it('should close dialog when close button is clicked', async () => {
    mockStore.ui.showAbout = true;

    await act(async () => {
      render(<AboutDialog />);
    });

    const closeButton = screen.getByText('×');
    fireEvent.click(closeButton);

    expect(mockStore.setShowAbout).toHaveBeenCalledWith(false);
  });

  it('should close dialog when overlay is clicked', async () => {
    mockStore.ui.showAbout = true;

    await act(async () => {
      render(<AboutDialog />);
    });

    const overlay = screen.getByText('Spica Photo Viewer').closest('.about-dialog-backdrop')!;
    fireEvent.click(overlay);

    expect(mockStore.setShowAbout).toHaveBeenCalledWith(false);
  });

  it('should not close dialog when content is clicked', async () => {
    mockStore.ui.showAbout = true;

    await act(async () => {
      render(<AboutDialog />);
    });

    const content = screen.getByText('Spica Photo Viewer').closest('.about-dialog')!;
    fireEvent.click(content);

    expect(mockStore.setShowAbout).not.toHaveBeenCalled();
  });

  it('should have proper accessibility attributes', async () => {
    mockStore.ui.showAbout = true;

    await act(async () => {
      render(<AboutDialog />);
    });

    const dialog = screen.getByText('Spica Photo Viewer');
    expect(dialog).toBeInTheDocument();
  });

  it('should render dialog structure correctly', async () => {
    mockStore.ui.showAbout = true;

    await act(async () => {
      render(<AboutDialog />);
    });

    const dialogContainer = screen.getByText('Spica Photo Viewer').closest('.about-dialog-backdrop')!;
    expect(dialogContainer).toHaveClass('about-dialog-backdrop');
  });

  it('should handle rapid show/hide toggles', async () => {
    const { rerender } = render(<AboutDialog />);

    // Initially hidden
    expect(screen.queryByText('Spica Photo Viewer')).not.toBeInTheDocument();

    // Show dialog
    mockStore.ui.showAbout = true;
    await act(async () => {
      rerender(<AboutDialog />);
    });
    expect(screen.getByText('Spica Photo Viewer')).toBeInTheDocument();

    // Hide dialog
    mockStore.ui.showAbout = false;
    rerender(<AboutDialog />);
    expect(screen.queryByText('Spica Photo Viewer')).not.toBeInTheDocument();
  });

  it('should prevent event bubbling when content is clicked', async () => {
    mockStore.ui.showAbout = true;

    await act(async () => {
      render(<AboutDialog />);
    });

    const content = screen.getByText('Spica Photo Viewer').closest('.about-dialog')!;

    // Content click should not close dialog
    fireEvent.click(content);
    expect(mockStore.setShowAbout).not.toHaveBeenCalled();
  });
});