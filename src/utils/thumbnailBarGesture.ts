// Spec: docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md
import { THUMBNAIL_BAR_HIDE_DELAY_MS } from "../constants/timing";

/** Starting values to be tuned by hand on the device (§4.5). Speeds are px/ms. */
export const THUMBNAIL_BAR_GESTURE = {
  strokeDistancePx: 150,
  activateSpeed: 0.8,
  keepAliveSpeed: 0.15,
  speedWindowMs: 60,
  pauseMs: 100,
  maxTiltDeg: 45,
  backtrackTolerancePx: 4,
} as const;

interface Sample {
  x: number;
  y: number;
  t: number;
}

interface Stroke {
  dir: 1 | -1;
  originY: number;
  extremeY: number;
}

export interface BarState {
  shown: boolean;
  /** Null while hidden or held; otherwise only ever moves later. */
  hideAt: number | null;
  /** Hovered or keyboard-focused (§4.1, D7). */
  held: boolean;
  samples: readonly Sample[];
  stroke: Stroke | null;
}

export type BarEvent =
  | { type: "move"; x: number; y: number; t: number; buttons: number }
  | { type: "tick"; t: number }
  | { type: "hoverChange"; held: boolean; t: number }
  | { type: "forceShow"; t: number };

const G = THUMBNAIL_BAR_GESTURE;
const TILT_RATIO = Math.tan((G.maxTiltDeg * Math.PI) / 180);

export const initialBarState = (t: number): BarState => ({
  shown: true,
  hideAt: t + THUMBNAIL_BAR_HIDE_DELAY_MS,
  held: false,
  samples: [],
  stroke: null,
});

const show = (s: BarState, t: number): BarState => ({
  ...s,
  shown: true,
  hideAt: s.held ? null : t + THUMBNAIL_BAR_HIDE_DELAY_MS,
});

const hide = (s: BarState): BarState => ({
  ...s,
  shown: false,
  hideAt: null,
  stroke: null,
});

export function stepBar(s: BarState, e: BarEvent): BarState {
  switch (e.type) {
    case "tick":
      return s.shown && s.hideAt !== null && e.t >= s.hideAt ? hide(s) : s;
    case "hoverChange":
      if (e.held) return { ...s, held: true, shown: true, hideAt: null };
      return {
        ...s,
        held: false,
        hideAt: s.shown ? e.t + THUMBNAIL_BAR_HIDE_DELAY_MS : null,
      };
    case "forceShow":
      return show(s, e.t);
    case "move":
      return move(s, e);
  }
}

function move(s: BarState, e: Extract<BarEvent, { type: "move" }>): BarState {
  // A held button is a pan drag, not a gesture (D6).
  if (e.buttons !== 0) return { ...s, samples: [], stroke: null };

  const sample = { x: e.x, y: e.y, t: e.t };
  const prev = s.samples.at(-1);
  if (!prev || e.t - prev.t >= G.pauseMs) {
    return { ...s, samples: [sample], stroke: null };
  }

  // Velocity over ~speedWindowMs rather than between two events, so 60Hz and
  // 1000Hz mice read the same (§4.3).
  const samples = [...s.samples, sample];
  while (samples.length > 2 && e.t - samples[1].t >= G.speedWindowMs) {
    samples.shift();
  }
  const base = samples[0];
  const dt = e.t - base.t;
  if (dt <= 0) return { ...s, samples };

  const vx = (e.x - base.x) / dt;
  const vy = (e.y - base.y) / dt;
  const vertical = Math.abs(vx) <= Math.abs(vy) * TILT_RATIO;
  const fast = vertical && Math.abs(vy) >= G.activateSpeed;
  const stroke = nextStroke(s.stroke, fast, vy > 0 ? 1 : -1, base.y, e.y);

  // A break (ended or flipped direction) is only trustworthy once the window
  // no longer spans it: until then, base/vy still blend in samples from
  // before the break, which would seed the next stroke's originY from there
  // instead of the true reversal point (§4.3). Reset like the pause path so
  // the next event starts a clean window.
  if (s.stroke && (!stroke || stroke.dir !== s.stroke.dir)) {
    return { ...s, samples: [sample], stroke: null };
  }

  let next: BarState = { ...s, samples, stroke };
  if (next.shown && !next.held && vertical && vy >= G.keepAliveSpeed) {
    next = {
      ...next,
      hideAt: Math.max(
        next.hideAt ?? -Infinity,
        e.t + THUMBNAIL_BAR_HIDE_DELAY_MS,
      ),
    };
  }
  if (
    stroke &&
    stroke.dir * (stroke.extremeY - stroke.originY) >= G.strokeDistancePx
  ) {
    if (stroke.dir === 1 && !next.shown) return show(next, e.t);
    // Hides even while held/hovered: §4.4 carves no exception for the
    // upward-flick transition.
    if (stroke.dir === -1 && next.shown) return hide(next);
  }
  return next;
}

function nextStroke(
  stroke: Stroke | null,
  fast: boolean,
  dir: 1 | -1,
  baseY: number,
  y: number,
): Stroke | null {
  if (!fast) return null;
  if (!stroke || stroke.dir !== dir)
    return { dir, originY: baseY, extremeY: y };
  if (dir * (y - stroke.extremeY) >= 0) return { ...stroke, extremeY: y };
  return dir * (stroke.extremeY - y) > G.backtrackTolerancePx ? null : stroke;
}
