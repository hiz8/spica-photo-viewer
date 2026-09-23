import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

import { ZOOM_INDICATOR_HIDE_DELAY_MS as DELAY } from "../../constants/timing";
import ZoomIndicator from "../ZoomIndicator";

describe("ZoomIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the rounded zoom, hidden from view and from assistive tech", () => {
    render(<ZoomIndicator zoom={172.8} zoomOperation={0} />);

    const indicator = screen.getByText("173%");
    expect(indicator).toHaveClass("zoom-indicator");
    expect(indicator).not.toHaveClass("shown");
    expect(indicator).toHaveAttribute("aria-hidden", "true");
  });

  it("is shown after a zoom operation until the delay passes", () => {
    const { rerender } = render(<ZoomIndicator zoom={100} zoomOperation={0} />);

    rerender(<ZoomIndicator zoom={120} zoomOperation={1} />);
    const indicator = screen.getByText("120%");
    expect(indicator).toHaveClass("shown");
    expect(indicator).toHaveAttribute("aria-hidden", "false");

    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(indicator).not.toHaveClass("shown");
  });
});
