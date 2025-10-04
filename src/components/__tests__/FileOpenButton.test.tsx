import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock Tauri APIs
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock the store
const mockStore = {
  setCurrentImage: vi.fn(),
  setFolderImages: vi.fn(),
  setError: vi.fn(),
  setLoading: vi.fn(),
};

vi.mock("../../store", () => ({
  useAppStore: vi.fn(() => mockStore),
}));

import FileOpenButton from "../FileOpenButton";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

const mockOpen = vi.mocked(open);
const mockInvoke = vi.mocked(invoke);

describe("FileOpenButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render open button", () => {
    render(<FileOpenButton />);

    expect(screen.getByText("Open Image")).toBeInTheDocument();
  });

  it("should apply custom className when provided", () => {
    render(<FileOpenButton className="custom-class" />);

    const button = screen.getByText("Open Image");
    expect(button).toHaveClass("custom-class");
  });

  it("should open file dialog when clicked", async () => {
    mockOpen.mockResolvedValue("/test/image.jpg");

    render(<FileOpenButton />);

    const button = screen.getByText("Open Image");
    fireEvent.click(button);

    expect(mockOpen).toHaveBeenCalledWith({
      multiple: false,
      filters: [
        {
          name: "Images",
          extensions: ["jpg", "jpeg", "png", "webp", "gif"],
        },
      ],
    });
  });

  it("should open image when file is selected", async () => {
    const mockFolderImages = [
      {
        path: "/test/selected-image.jpg",
        name: "selected-image.jpg",
        size: 1024,
        modified: Date.now(),
      },
    ];

    mockOpen.mockResolvedValue("/test/selected-image.jpg");
    mockInvoke.mockResolvedValue(mockFolderImages);

    render(<FileOpenButton />);

    const button = screen.getByText("Open Image");
    fireEvent.click(button);

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_folder_images", {
        path: "/test",
      });
      expect(mockStore.setFolderImages).toHaveBeenCalledWith(
        "/test",
        mockFolderImages,
      );
      expect(mockStore.setCurrentImage).toHaveBeenCalledWith(
        "/test/selected-image.jpg",
        0,
      );
    });
  });

  it("should handle dialog cancellation gracefully", async () => {
    mockOpen.mockResolvedValue(null);

    render(<FileOpenButton />);

    const button = screen.getByText("Open Image");
    fireEvent.click(button);

    await vi.waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
    });

    // Should not call invoke when no file selected
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockStore.setCurrentImage).not.toHaveBeenCalled();
  });

  it("should handle dialog error gracefully", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockOpen.mockRejectedValue(new Error("Dialog failed"));

    render(<FileOpenButton />);

    const button = screen.getByText("Open Image");
    fireEvent.click(button);

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to open file:",
        expect.any(Error),
      );
      expect(mockStore.setError).toHaveBeenCalledWith(expect.any(Error));
    });

    expect(mockStore.setCurrentImage).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("should have proper button attributes", () => {
    render(<FileOpenButton />);

    const button = screen.getByRole("button");
    expect(button).toBeEnabled();
    expect(button).toHaveClass("file-open-button");
  });

  it("should handle rapid clicks", async () => {
    const mockFolderImages = [
      {
        path: "/test/image.jpg",
        name: "image.jpg",
        size: 1024,
        modified: Date.now(),
      },
    ];

    mockOpen.mockResolvedValue("/test/image.jpg");
    mockInvoke.mockResolvedValue(mockFolderImages);

    render(<FileOpenButton />);

    const button = screen.getByText("Open Image");

    // Rapid clicks
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    // Should call dialog for each click
    expect(mockOpen).toHaveBeenCalledTimes(3);
  });

  it("should support different image formats in filter", () => {
    render(<FileOpenButton />);

    const button = screen.getByText("Open Image");
    fireEvent.click(button);

    expect(mockOpen).toHaveBeenCalledWith({
      multiple: false,
      filters: [
        {
          name: "Images",
          extensions: ["jpg", "jpeg", "png", "webp", "gif"],
        },
      ],
    });
  });
});
