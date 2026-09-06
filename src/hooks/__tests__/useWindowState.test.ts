import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Captures the window event handlers so a test can fire them.
const listeners = new Map<string, () => void>();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: async (event: string, handler: () => void) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { useWindowState } from "../useWindowState";

const mockInvoke = vi.mocked(invoke);
const reply = (isMaximized: boolean) => ({
  is_maximized: isMaximized,
  is_fullscreen: false,
});
// The hook registers its listeners across several awaits; a macrotask lets
// all of them (and any pending replies) settle.
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("useWindowState", () => {
  beforeEach(() => {
    listeners.clear();
    mockInvoke.mockReset();
    useAppStore.getState().setMaximized(false);
    useAppStore.getState().setFullscreen(false);
  });

  it("applies only the latest window-state reply", async () => {
    mockInvoke.mockResolvedValueOnce(reply(true));
    renderHook(() => useWindowState());
    await flush();
    expect(useAppStore.getState().view.isMaximized).toBe(true);
    const onResize = listeners.get("tauri://resize");
    expect(onResize).toBeDefined();

    // A query dispatched while the window was still maximized whose reply
    // lands after the restore's own reply must not win.
    let settleStale: (value: unknown) => void = () => {};
    mockInvoke.mockReturnValueOnce(
      new Promise((resolve) => {
        settleStale = resolve;
      }),
    );
    act(() => onResize?.());
    mockInvoke.mockResolvedValueOnce(reply(false));
    act(() => onResize?.());
    await flush();
    expect(useAppStore.getState().view.isMaximized).toBe(false);

    settleStale(reply(true));
    await flush();
    expect(useAppStore.getState().view.isMaximized).toBe(false);
  });
});
