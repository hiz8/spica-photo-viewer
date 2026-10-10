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

// 1px/ms straight up at 60Hz: a flick for the state machine.
function flickUp(distance: number) {
  for (let y = distance; y >= 0; y -= 16) {
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

// No focus is ever held while a pointermove fires in the tests that use
// this, so the focused-element-gone check (fix 2) never engages.
const noBar: React.RefObject<HTMLElement | null> = { current: null };

describe("useThumbnailBarVisibility", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts shown and hides after the delay", () => {
    const { result } = renderHook(() => useThumbnailBarVisibility("/a", noBar));
    expect(result.current.shown).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(result.current.shown).toBe(false);
  });

  it("shows again on a fast downward flick", () => {
    const { result } = renderHook(() => useThumbnailBarVisibility("/a", noBar));
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
      return useThumbnailBarVisibility("/a", noBar);
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
    const { result } = renderHook(() => useThumbnailBarVisibility("/a", noBar));
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
    const { result } = renderHook(() => useThumbnailBarVisibility("/a", noBar));
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

  it("keeps the bar shown on an upward flick while held via keyboard focus (fix 1)", () => {
    // A real ancestor of document.activeElement: contains() reads true for
    // the whole test, so the focused-element-gone check (fix 2) never fires
    // and the flick is the only thing under test here.
    const barRef: React.RefObject<HTMLElement | null> = {
      current: document.documentElement,
    };
    const { result } = renderHook(() =>
      useThumbnailBarVisibility("/a", barRef),
    );
    act(() => result.current.barProps.onFocus(focusEvent(true)));
    flickUp(240);
    expect(result.current.shown).toBe(true);
  });

  it("clears a stale keyboard-focus hold once the focused element is gone (fix 2)", () => {
    // A real, unattached element: document.activeElement (the default
    // <body>) is never inside it, simulating a focused thumbnail that
    // unmounted without firing onBlur.
    const barRef: React.RefObject<HTMLElement | null> = {
      current: document.createElement("nav"),
    };
    const { result } = renderHook(() =>
      useThumbnailBarVisibility("/a", barRef),
    );
    act(() => result.current.barProps.onFocus(focusEvent(true)));
    expect(result.current.shown).toBe(true);

    move(0, 0);
    act(() => {
      vi.advanceTimersByTime(DELAY - 1);
    });
    expect(result.current.shown).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.shown).toBe(false);
  });

  it("shows again when showKey changes (D3)", () => {
    const { result, rerender } = renderHook(
      ({ key }) => useThumbnailBarVisibility(key, noBar),
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
    const { unmount } = renderHook(() =>
      useThumbnailBarVisibility("/a", noBar),
    );
    unmount();
    expect(remove).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    remove.mockRestore();
  });
});
