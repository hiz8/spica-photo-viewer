import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setTitle = vi.fn<(title: string) => Promise<void>>();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTitle }),
}));

import { useAppStore } from "../../store";
import { useWindowTitle } from "../useWindowTitle";

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("useWindowTitle", () => {
  beforeEach(() => {
    setTitle.mockReset();
    setTitle.mockResolvedValue(undefined);
    useAppStore.getState().setCurrentImage("", -1);
    document.title = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows only the app name while no image is open", () => {
    renderHook(() => useWindowTitle());

    expect(setTitle).toHaveBeenLastCalledWith("Spica Photo Viewer");
    expect(document.title).toBe("Spica Photo Viewer");
  });

  it("prefixes the current file name, extension included, Picasa-style", () => {
    renderHook(() => useWindowTitle());

    act(() => {
      useAppStore.getState().setCurrentImage("C:\\photos\\IMG_1439.JPG", 0);
    });

    expect(setTitle).toHaveBeenLastCalledWith(
      "IMG_1439.JPG - Spica Photo Viewer",
    );
    expect(document.title).toBe("IMG_1439.JPG - Spica Photo Viewer");
  });

  it("takes the file name after a forward-slash separator too", () => {
    renderHook(() => useWindowTitle());

    act(() => {
      useAppStore.getState().setCurrentImage("/photos/sunset.png", 0);
    });

    expect(setTitle).toHaveBeenLastCalledWith(
      "sunset.png - Spica Photo Viewer",
    );
  });

  it("follows navigation to another image", () => {
    renderHook(() => useWindowTitle());

    act(() => {
      useAppStore.getState().setCurrentImage("C:\\photos\\a.jpg", 0);
    });
    act(() => {
      useAppStore.getState().setCurrentImage("C:\\photos\\b.jpg", 1);
    });

    expect(setTitle).toHaveBeenLastCalledWith("b.jpg - Spica Photo Viewer");
  });

  it("drops back to the app name when the image path is cleared", () => {
    renderHook(() => useWindowTitle());

    act(() => {
      useAppStore.getState().setCurrentImage("C:\\photos\\a.jpg", 0);
    });
    act(() => {
      useAppStore.getState().setCurrentImage("", -1);
    });

    expect(setTitle).toHaveBeenLastCalledWith("Spica Photo Viewer");
    expect(document.title).toBe("Spica Photo Viewer");
  });

  it("does not re-set the title when unrelated state changes", () => {
    renderHook(() => useWindowTitle());
    act(() => {
      useAppStore.getState().setCurrentImage("C:\\photos\\a.jpg", 0);
    });
    setTitle.mockClear();

    act(() => {
      useAppStore.getState().setZoom(2);
    });

    expect(setTitle).not.toHaveBeenCalled();
  });

  it("logs and survives a rejected setTitle", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    setTitle.mockRejectedValue(new Error("no permission"));

    renderHook(() => useWindowTitle());
    await flush();

    expect(consoleError).toHaveBeenCalledWith(
      "Failed to set window title:",
      expect.any(Error),
    );
  });
});
