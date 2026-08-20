/**
 * Memory constants for the decoded-bitmap cache (hypothesis C).
 * A 20MP RGBA bitmap is ~80MB; the retained set (current image plus
 * BITMAP_WINDOW_SIZE neighbors) must stay inside the budget.
 */
export const BITMAP_CACHE_BUDGET_BYTES = 500 * 1024 * 1024;

/**
 * Neighbors kept decoded around the current image (in addition to it).
 * With the current image this is 5 x ~80MB = ~400MB for the large corpus.
 */
export const BITMAP_WINDOW_SIZE = 4;
