/**
 * Street plan (meters, y up). A narrow two-lane backstreet runs along x; a
 * second street crosses it along z east of the konbini. Everything at ground
 * level sits on y = 0 so a single planar reflection serves the whole floor.
 *
 *            z-                      (north)
 *   ┌──────────────┬───┬─────────┐ ┌──────────
 *   │  izakaya/ramen│alley│ KONBINI │ │ coin parking
 *   └──────────────┴───┴───┬─────┘ └──────────  z = -1  north building line
 *     ─ ─ ─ ─ ─ ─ main street (x) ─ ─ ─ ─ ─ ─ ─
 *   ┌───────────────────────┐ cross  ┌──────────  z = 7.4 south building line
 *   │     south row         │ street │
 *                             x=7..13
 */
export const L = {
  /** Asphalt of the main street spans z ∈ [north, south]. */
  mainNorth: -1.0,
  mainSouth: 7.4,
  /** Painted edge lines (路側帯). */
  edgeNorth: -0.35,
  edgeSouth: 6.75,
  /** Cross street asphalt spans x ∈ [west, east]. */
  crossWest: 7.0,
  crossEast: 13.0,
  extent: 90,
  konbini: {
    x0: -5.0,
    x1: 5.4,
    z0: -16.0,
    /** Glass facade plane. */
    front: -3.0,
    height: 4.1,
    ceiling: 2.95,
    upperFloors: 5,
    upperFloorH: 2.95,
  },
  /** Paved forecourt in front of and beside the shop. */
  apron: { x0: -5.0, x1: 7.0, z0: -3.0, z1: -1.0 },
  alley: { x0: -7.0, x1: -5.0 },
};

/** The dry interior box (used to keep rain and haze out). */
export const SHOP_BOX = {
  min: [L.konbini.x0 + 0.05, 0, L.konbini.z0] as const,
  max: [L.konbini.x1 - 0.05, L.konbini.height, L.konbini.front] as const,
};
