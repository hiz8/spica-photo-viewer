import { describe, it, expect } from "vitest";

import { THUMBNAIL_BAR_HIDE_DELAY_MS as DELAY } from "../../constants/timing";
import {
  type BarEvent,
  type BarState,
  initialBarState,
  stepBar,
} from "../thumbnailBarGesture";

type Waypoint = [x: number, y: number, t: number];

// Pointer samples at a fixed rate along straight segments between waypoints,
// the way a mouse reports a movement.
function track(points: Waypoint[], hz: number, buttons = 0): BarEvent[] {
  const events: BarEvent[] = [];
  const step = 1000 / hz;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0, t0] = points[i];
    const [x1, y1, t1] = points[i + 1];
    const n = Math.max(1, Math.round((t1 - t0) / step));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const f = k / n;
      events.push({
        type: "move",
        x: x0 + (x1 - x0) * f,
        y: y0 + (y1 - y0) * f,
        t: t0 + (t1 - t0) * f,
        buttons,
      });
    }
  }
  return events;
}

const run = (state: BarState, events: BarEvent[]) =>
  events.reduce<BarState>((s, e) => stepBar(s, e), state);

const tick = (state: BarState, t: number) =>
  stepBar(state, { type: "tick", t });

// Shown at t=0, hidden by the timer at t=DELAY.
const hidden = () => tick(initialBarState(0), DELAY);

const T = 10_000;

describe("thumbnailBarGesture", () => {
  it("starts shown and hides after the delay", () => {
    const s = initialBarState(0);
    expect(s.shown).toBe(true);
    expect(tick(s, DELAY - 1).shown).toBe(true);
    expect(tick(s, DELAY).shown).toBe(false);
  });

  describe.each([60, 144, 1000])("activation at %iHz", (hz) => {
    it("shows on a fast 240px downward flick", () => {
      const s = run(
        hidden(),
        track(
          [
            [0, 0, T],
            [0, 240, T + 240],
          ],
          hz,
        ),
      );
      expect(s.shown).toBe(true);
    });

    it("ignores a slow downward movement however long", () => {
      const s = run(
        hidden(),
        track(
          [
            [0, 0, T],
            [0, 600, T + 6000],
          ],
          hz,
        ),
      );
      expect(s.shown).toBe(false);
    });

    it("ignores a fast downward movement shorter than 150px", () => {
      const s = run(
        hidden(),
        track(
          [
            [0, 0, T],
            [0, 100, T + 50],
          ],
          hz,
        ),
      );
      expect(s.shown).toBe(false);
    });

    it("ignores a flick tilted more than 45° from vertical", () => {
      const s = run(
        hidden(),
        track(
          [
            [0, 0, T],
            [300, 200, T + 250],
          ],
          hz,
        ),
      );
      expect(s.shown).toBe(false);
    });

    it("accepts a diagonal flick within 45° of vertical", () => {
      const s = run(
        hidden(),
        track(
          [
            [0, 0, T],
            [150, 240, T + 240],
          ],
          hz,
        ),
      );
      expect(s.shown).toBe(true);
    });

    it("ignores movement with a button held (pan drag)", () => {
      const s = run(
        hidden(),
        track(
          [
            [0, 0, T],
            [0, 240, T + 240],
          ],
          hz,
          1,
        ),
      );
      expect(s.shown).toBe(false);
    });

    it("breaks the stroke at a 120ms pause", () => {
      const first = track(
        [
          [0, 0, T],
          [0, 100, T + 100],
        ],
        hz,
      );
      const second = track(
        [
          [0, 100, T + 220],
          [0, 200, T + 320],
        ],
        hz,
      );
      expect(run(hidden(), [...first, ...second]).shown).toBe(false);
    });

    it("tolerates a 3px step back within a stroke", () => {
      const s = run(
        hidden(),
        track(
          [
            [0, 0, T],
            [0, 120, T + 60],
            [0, 117, T + 61],
            [0, 177, T + 91],
          ],
          hz,
        ),
      );
      expect(s.shown).toBe(true);
    });

    // A break must reset accumulated distance to 0 (§4.3): down 100px, up
    // past the 4px backtrack tolerance, then down again must not sum the two
    // downward runs into one 150px+ stroke.
    it("breaks the stroke on a reversal (20px up)", () => {
      const s = run(
        hidden(),
        track(
          [
            [0, 0, T],
            [0, 100, T + 40],
            [0, 80, T + 48],
            [0, 170, T + 84],
          ],
          hz,
        ),
      );
      expect(s.shown).toBe(false);
    });

    it("breaks the stroke on a reversal (40px up)", () => {
      const s = run(
        hidden(),
        track(
          [
            [0, 0, T],
            [0, 100, T + 40],
            [0, 60, T + 56],
            [0, 150, T + 92],
          ],
          hz,
        ),
      );
      expect(s.shown).toBe(false);
    });
  });

  describe("while shown", () => {
    it("stays shown while moving down slower than activation but above keep-alive", () => {
      const s = run(
        initialBarState(0),
        track(
          [
            [0, 0, 1000],
            [0, 800, 5000],
          ],
          60,
        ),
      );
      expect(tick(s, 5000 + DELAY - 1).shown).toBe(true);
      expect(tick(s, 5000 + DELAY).shown).toBe(false);
    });

    it("does not extend on downward movement below keep-alive speed", () => {
      const s = run(
        initialBarState(0),
        track(
          [
            [0, 0, 1000],
            [0, 400, 5000],
          ],
          60,
        ),
      );
      expect(tick(s, 5000).shown).toBe(false);
    });

    it("does not extend on slow upward movement", () => {
      const s = run(
        initialBarState(0),
        track(
          [
            [0, 800, 1000],
            [0, 0, 5000],
          ],
          60,
        ),
      );
      expect(tick(s, 5000).shown).toBe(false);
    });

    it.each([
      ["slow", 1000],
      ["fast", 4000],
    ])("does not extend on %s horizontal movement", (_, dx) => {
      const s = run(
        initialBarState(0),
        track(
          [
            [0, 0, 500],
            [dx, 0, 2500],
          ],
          60,
        ),
      );
      expect(tick(s, 2500).shown).toBe(false);
    });

    it("hides at once on a fast 200px upward flick", () => {
      const s = run(
        initialBarState(0),
        track(
          [
            [0, 500, 100],
            [0, 300, 300],
          ],
          60,
        ),
      );
      expect(s.shown).toBe(false);
    });

    it("stays shown on a fast 200px upward flick while held", () => {
      const held = stepBar(initialBarState(0), {
        type: "hoverChange",
        held: true,
        t: 0,
      });
      const s = run(
        held,
        track(
          [
            [0, 500, 100],
            [0, 300, 300],
          ],
          60,
        ),
      );
      expect(s.shown).toBe(true);
    });

    it("stays shown on a fast upward flick shorter than 150px", () => {
      const s = run(
        initialBarState(0),
        track(
          [
            [0, 500, 100],
            [0, 400, 200],
          ],
          60,
        ),
      );
      expect(s.shown).toBe(true);
    });
  });

  describe("hover and keyboard focus", () => {
    it("shows the hidden bar and pauses the timer while held", () => {
      let s = stepBar(hidden(), { type: "hoverChange", held: true, t: T });
      expect(s.shown).toBe(true);
      expect(tick(s, T + 60_000).shown).toBe(true);

      s = stepBar(s, { type: "hoverChange", held: false, t: T + 60_000 });
      expect(tick(s, T + 60_000 + DELAY - 1).shown).toBe(true);
      expect(tick(s, T + 60_000 + DELAY).shown).toBe(false);
    });

    // The hook feeds `move` events on event.timeStamp but `hoverChange` on
    // performance.now(): the two clocks aren't guaranteed to interleave, so a
    // keep-alive move can carry an earlier `t` than the hideAt it should
    // extend. hideAt must never move earlier regardless (BarState invariant).
    it("does not let an out-of-order keep-alive move earlier hideAt", () => {
      let s = stepBar(hidden(), { type: "hoverChange", held: true, t: 500 });
      s = stepBar(s, { type: "hoverChange", held: false, t: 1000 });
      expect(s.hideAt).toBe(3000);

      s = run(
        s,
        track(
          [
            [0, 0, 950],
            [0, 20, 999],
          ],
          60,
        ),
      );
      expect(s.hideAt).toBe(3000);
    });
  });

  it("forceShow shows the bar and restarts the delay", () => {
    const s = stepBar(hidden(), { type: "forceShow", t: T });
    expect(s.shown).toBe(true);
    expect(tick(s, T + DELAY - 1).shown).toBe(true);
    expect(tick(s, T + DELAY).shown).toBe(false);
  });

  it("does not mutate its input", () => {
    const s = hidden();
    const snapshot = structuredClone(s);
    run(
      s,
      track(
        [
          [0, 0, T],
          [0, 240, T + 240],
        ],
        60,
      ),
    );
    expect(s).toEqual(snapshot);
  });
});
