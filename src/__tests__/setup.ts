import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    isFullscreen: vi.fn(),
    setFullscreen: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

// Mock window methods for fullscreen and resize
Object.defineProperty(window, "innerWidth", {
  writable: true,
  configurable: true,
  value: 1920,
});

Object.defineProperty(window, "innerHeight", {
  writable: true,
  configurable: true,
  value: 1080,
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Suppress console warnings during tests
const originalConsoleWarn = console.warn;
console.warn = (...args: unknown[]) => {
  // Suppress specific React warnings that don't affect functionality
  if (
    typeof args[0] === "string" &&
    (args[0].includes("Warning: ReactDOM.render is no longer supported") ||
      args[0].includes("Warning: validateDOMNesting"))
  ) {
    return;
  }
  originalConsoleWarn.apply(console, args);
};
