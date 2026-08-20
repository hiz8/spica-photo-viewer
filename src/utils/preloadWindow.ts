import { BITMAP_WINDOW_SIZE } from "../constants/memory";

/**
 * Priority-ordered neighbor indices to keep decoded around `index`
 * (order = decode order). Forward: [i+1, i+2, i+3, i-1], then further
 * ahead, then further behind; backward is the mirror. 3 steps of lead at
 * the 250ms navigation floor gives ~750ms, enough for a ~400ms decode at
 * MAX_CONCURRENT_LOADS parallelism. See the design spec
 * (docs/superpowers/specs/2026-08-16-nav-rapid-bitmap-window-design.md).
 */
export const computeWindow = (
  index: number,
  direction: 1 | -1,
  length: number,
  size: number = BITMAP_WINDOW_SIZE,
): number[] => {
  const candidates: number[] = [
    index + direction,
    index + 2 * direction,
    index + 3 * direction,
    index - direction,
  ];
  for (let k = 4; k < length; k++) candidates.push(index + k * direction);
  for (let k = 2; k < length; k++) candidates.push(index - k * direction);

  const result: number[] = [];
  for (const i of candidates) {
    if (i >= 0 && i < length && i !== index && !result.includes(i)) {
      result.push(i);
    }
    if (result.length === size) break;
  }
  return result;
};
