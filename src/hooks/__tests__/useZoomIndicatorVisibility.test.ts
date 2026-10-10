import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZOOM_INDICATOR_HIDE_DELAY_MS as DELAY } from "../../constants/timing";
import { useZoomIndicatorVisibility } from "../useZoomIndicatorVisibility";

describe("useZoomIndicatorVisibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const render = () =>
    renderHook(({ operation }) => useZoomIndicatorVisibility(operation), {
      initialProps: { operation: 0 },
    });

  it("stays hidden until the first zoom operation", () => {
    const { result } = render();

    expect(result.current).toBe(false);
  });

  it("shows on a zoom operation and hides after the delay", () => {
    const { result, rerender } = render();

    rerender({ operation: 1 });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(DELAY - 1);
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it("restarts the delay on every operation", () => {
    const { result, rerender } = render();

    rerender({ operation: 1 });
    act(() => {
      vi.advanceTimersByTime(DELAY - 100);
    });
    rerender({ operation: 2 });
    act(() => {
      vi.advanceTimersByTime(DELAY - 1);
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it("shows again when operated after hiding", () => {
    const { result, rerender } = render();

    rerender({ operation: 1 });
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    rerender({ operation: 2 });

    expect(result.current).toBe(true);
  });

  it("does not show when mounted after operations already happened", () => {
    const { result } = renderHook(() => useZoomIndicatorVisibility(5));

    expect(result.current).toBe(false);
  });

  it("clears its timer on unmount", () => {
    const { rerender, unmount } = render();

    rerender({ operation: 1 });
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
