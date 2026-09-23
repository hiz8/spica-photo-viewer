import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { THUMBNAIL_BAR_HIDE_DELAY_MS as DELAY } from "../../constants/timing";
import { useThumbnailBarVisibility } from "../useThumbnailBarVisibility";

// jsdom stamps events with Date.now(); the hook reads timeStamp on the
// performance.now() clock like WebView2 does.
function move(x: number, y: number, buttons = 0) {
  const ev = new MouseEvent("pointermove", { clientX: x, clientY: y, buttons });
  Object.defineProperty(ev, "timeStamp", { value: performance.now() });
  act(() => {
    window.dispatchEvent(ev);
  });
}

// 1px/ms straight down at 60Hz: a flick for the state machine.
function flickDown(distance: number) {
  for (let y = 0; y <= distance; y += 16) {
    move(0, y);
    act(() => {
      vi.advanceTimersByTime(16);
    });
  }
}

const focusEvent = (focusVisible: boolean) =>
  ({
    target: { matches: () => focusVisible },
  }) as unknown as React.FocusEvent<HTMLElement>;

const blurEvent = () =>
  ({
    currentTarget: { contains: () => false },
    relatedTarget: null,
  }) as unknown as React.FocusEvent<HTMLElement>;

describe("useThumbnailBarVisibility", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts shown and hides after the delay", () => {
    const { result } = renderHook(() => useThumbnailBarVisibility("/a"));
    expect(result.current.shown).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(result.current.shown).toBe(false);
  });

  it("shows again on a fast downward flick", () => {
    const { result } = renderHook(() => useThumbnailBarVisibility("/a"));
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    flickDown(240);
    expect(result.current.shown).toBe(true);
  });

  it("re-renders only when shown flips", () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useThumbnailBarVisibility("/a");
    });
    const before = renders;
    for (let i = 0; i < 100; i++) {
      move(i * 5, 300);
      act(() => {
        vi.advanceTimersByTime(8);
      });
    }
    expect(renders).toBe(before);
  });

  it("holds while hovered and hides after leaving", () => {
    const { result } = renderHook(() => useThumbnailBarVisibility("/a"));
    act(() => result.current.barProps.onMouseEnter());
    act(() => {
      vi.advanceTimersByTime(DELAY * 5);
    });
    expect(result.current.shown).toBe(true);

    act(() => result.current.barProps.onMouseLeave());
    act(() => {
      vi.advanceTimersByTime(DELAY - 1);
    });
    expect(result.current.shown).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.shown).toBe(false);
  });

  it("holds on keyboard focus but not on mouse focus (D7)", () => {
    const { result } = renderHook(() => useThumbnailBarVisibility("/a"));
    act(() => result.current.barProps.onFocus(focusEvent(false)));
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(result.current.shown).toBe(false);

    act(() => result.current.barProps.onFocus(focusEvent(true)));
    expect(result.current.shown).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DELAY * 5);
    });
    expect(result.current.shown).toBe(true);

    act(() => result.current.barProps.onBlur(blurEvent()));
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(result.current.shown).toBe(false);
  });

  it("shows again when showKey changes (D3)", () => {
    const { result, rerender } = renderHook(
      ({ key }) => useThumbnailBarVisibility(key),
      { initialProps: { key: "/a" } },
    );
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(result.current.shown).toBe(false);

    rerender({ key: "/b" });
    expect(result.current.shown).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(result.current.shown).toBe(false);
  });

  it("removes its listener and timer on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useThumbnailBarVisibility("/a"));
    unmount();
    expect(remove).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    remove.mockRestore();
  });
});
