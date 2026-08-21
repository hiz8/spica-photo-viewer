import type { ImageData } from "../types";

/**
 * What the viewer is showing for the current image. Reported in perf marks
 * (`paint:done`.tier, `zoom:request`.displayedTier) and by the E2E status
 * hook so the bench can tell a placeholder paint from a real one without
 * inferring it. "preview" is reserved for the display-resolution tier
 * (design spec 2026-08-21 §6.4), produced once the loader fetches a
 * display-resolution preview instead of the full-resolution image.
 */
export type DisplayTier = "none" | "thumbnail" | "preview" | "full";

export const displayTierOf = (
  data: ImageData | null,
  thumbnailDisplayed: boolean | undefined,
): DisplayTier => {
  if (!data) return "none";
  if (thumbnailDisplayed) return "thumbnail";
  return data.tier === "preview" ? "preview" : "full";
};
