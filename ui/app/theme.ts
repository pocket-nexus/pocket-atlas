// The look shared by every device: dark glass over the scene, white type,
// the place's own accent for what is selected.
export const INK = "#ffffff";
export const DIM = "#bcc0ccd9";
export const FAINT = "#bcc0cc8c";
export const GLASS = "#0c0e14d9";
export const GLASS_LIGHT = "#1c212ce6";
export const HAIRLINE = "#ffffff1a";
export const WASH = "#ffffff14";
export const BLUE = "#8fb4ff";

/** "#rrggbb" with an alpha in 0…1. */
export function tint(color: string, alpha: number): string {
  return color.slice(0, 7) + Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
}
