import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock the store
const mockOpenFileDialog = vi.fn();

vi.mock("../../store", () => ({
  useAppStore: vi.fn(() => ({
    openFileDialog: mockOpenFileDialog,
  })),
}));

import FileOpenButton from "../FileOpenButton";

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

  it("should call openFileDialog when clicked", () => {
    render(<FileOpenButton />);

    const button = screen.getByText("Open Image");
    fireEvent.click(button);

    expect(mockOpenFileDialog).toHaveBeenCalledTimes(1);
  });

  it("should have proper button attributes", () => {
    render(<FileOpenButton />);

    const button = screen.getByRole("button");
    expect(button).toBeEnabled();
    expect(button).toHaveClass("file-open-button");
  });

  it("should handle rapid clicks", () => {
    render(<FileOpenButton />);

    const button = screen.getByText("Open Image");

    // Rapid clicks
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    // Should call openFileDialog for each click
    expect(mockOpenFileDialog).toHaveBeenCalledTimes(3);
  });
});
