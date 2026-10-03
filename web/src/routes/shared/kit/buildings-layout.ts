/**
 * Where things sit in the two building atlases. Plain data: the painter
 * (`kit/buildings.ts`, on the page) and the generator (`gen/buildings.ts`,
 * in the worker and under Bun) both read it.
 *
 *   building       1024², lit: wall and roof strips that repeat in u, and
 *                  cells for windows, doors and shutters
 *   building-lit    512², unlit: lit windows, a shop front seen through its
 *                  glass, lit sign faces
 *
 * Strips span the atlas width and stand for `WALL_TILE` metres, so a wall
 * of any length repeats them in u; in v a strip covers `metres` of height
 * and a taller wall is cut into bands. Pixel rectangles are canvas
 * coordinates (y down); `stripV` and `cellUV` turn them into UVs (v up).
 */

export const ATLAS = 1024;
export const LIT_ATLAS = 512;
/** Metres of wall per repeat of a strip in u. */
export const WALL_TILE = 8;

export interface Strip {
  y: number;
  h: number;
  /** Height the strip covers (m); 0: uniform in v, stretch freely. */
  metres: number;
}

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Size of what is drawn (m). */
  mw: number;
  mh: number;
}

/** Gap between neighbours in an atlas, filled by edge extrusion (px). */
export const PAD = 4;

export const STRIPS = {
  /** Horizontal metal lap siding, 19 cm boards. */
  lap: { y: 4, h: 144, metres: 3 },
  /** Ceramic siding panels (窯業系): a stretcher pattern of 45 × 15 cm blocks. */
  ceramic: { y: 156, h: 128, metres: 3 },
  /** A storey of a block (school, flats, offices): three windows per repeat. */
  band: { y: 292, h: 144, metres: 3.4 },
  /** Vertical ribbed metal (角波), 12.5 cm ribs; also corrugated arches. */
  rib: { y: 444, h: 32, metres: 0 },
  /** Standing-seam roof metal, seams 50 cm apart running down the slope. */
  seam: { y: 484, h: 32, metres: 0 },
  /** Cast concrete: plinths, silos, chimneys. */
  concrete: { y: 524, h: 32, metres: 0 },
  /** Smooth painted metal: trims, fascias, tanks, posts. */
  plain: { y: 564, h: 24, metres: 0 },
  /**
   * A storey of a house seen from beyond 45 m, its windows painted in: at
   * that distance the handheld shows 17 cm or more per pixel, so siding is
   * a flat tint and a window is a few dark pixels. `rowA` stands directly
   * over `rowB`: a wall of two storeys takes both in one quad.
   */
  rowA: { y: 596, h: 64, metres: 2.7 },
  rowB: { y: 668, h: 64, metres: 2.7 },
} as const satisfies Record<string, Strip>;

/** The windows of the `band` strip, per repeat (m from the repeat's left edge and the storey's floor). */
export const BAND = { period: WALL_TILE / 3, x: 0.46, w: 1.75, sill: 0.95, h: 1.5 } as const;

/**
 * The windows of the `row` strips: left edge, width, sill, height (m), and
 * whether it is lit. Walls start and end in the gaps between them.
 */
export const ROWS = {
  rowA: [
    [0.9, 1.7, 0.95, 1.15, 0],
    [3.9, 0.75, 0.95, 1.3, 0],
    [5.6, 1.7, 0.95, 1.15, 1],
  ],
  rowB: [
    [0.6, 2.5, 0.7, 1.35, 0],
    [3.9, 0.7, 1.5, 0.55, 0],
    [5.6, 1.7, 0.95, 1.15, 0],
  ],
} as const;
/** Where a wall may start or end along the `row` strips (m, modulo `WALL_TILE`): clear of every window of both. */
export const ROW_GAPS: readonly [number, number][] = [
  [3.25, 3.75],
  [4.8, 5.45],
  [7.45, 8.45],
];

export const CELLS = {
  /** Two-pane sliding window, dark bronze frame. */
  winSlide: { x: 4, y: 744, w: 108, h: 74, mw: 1.7, mh: 1.15 },
  winTall: { x: 120, y: 744, w: 48, h: 84, mw: 0.75, mh: 1.3 },
  winSmall: { x: 176, y: 744, w: 44, h: 36, mw: 0.7, mh: 0.55 },
  /** Living-room window: fixed pane and sliders. */
  winWide: { x: 228, y: 744, w: 160, h: 86, mw: 2.5, mh: 1.35 },
  door: { x: 396, y: 744, w: 60, h: 128, mw: 0.95, mh: 2.0 },
  /** One glazed panel of a 風除室 (aluminium frame, glass, a rail at waist height). */
  porch: { x: 464, y: 744, w: 64, h: 128, mw: 1.0, mh: 2.05 },
  /** Roller shutter of a house garage. */
  shutter: { x: 536, y: 744, w: 172, h: 132, mw: 2.7, mh: 2.1 },
  /** Shop glazing, unlit: mullions, dark glass, a low kick panel. */
  shopGlass: { x: 716, y: 744, w: 192, h: 132, mw: 3.0, mh: 2.2 },
  /** Hanging barn door with braces. */
  barnDoor: { x: 4, y: 888, w: 128, h: 128, mw: 3.0, mh: 3.0 },
  /** Roller shutter of a warehouse. */
  bigShutter: { x: 140, y: 888, w: 144, h: 128, mw: 4.0, mh: 3.6 },
  /** Two-pane sliding window, white frame. */
  winWhite: { x: 292, y: 888, w: 108, h: 74, mw: 1.7, mh: 1.15 },
  /** Louvred vent / FF heater flue plate. */
  vent: { x: 408, y: 888, w: 32, h: 32, mw: 0.4, mh: 0.4 },
  /** A painted sign board, unlit. */
  board: { x: 448, y: 888, w: 256, h: 64, mw: 4.0, mh: 1.0 },
} as const satisfies Record<string, Cell>;

export const LIT_STRIPS = {
  /** A shop seen through its glass front: 6 m per repeat, 2.5 m high. */
  store: { y: 100, h: 160, metres: 2.5 },
  /** A lit fascia: white acrylic with panel joints; coloured by the vertices. */
  fascia: { y: 268, h: 32, metres: 0 },
} as const satisfies Record<string, Strip>;
/** Metres per repeat of the lit strips in u. */
export const STORE_TILE = 6;

export const LIT_CELLS = {
  winSlide: { x: 4, y: 4, w: 108, h: 74, mw: 1.7, mh: 1.15 },
  winTall: { x: 120, y: 4, w: 48, h: 84, mw: 0.75, mh: 1.3 },
  winSmall: { x: 176, y: 4, w: 44, h: 36, mw: 0.7, mh: 0.55 },
  winWide: { x: 228, y: 4, w: 160, h: 86, mw: 2.5, mh: 1.35 },
  /** A lit window of the `band` strip. */
  winBand: { x: 396, y: 4, w: 100, h: 86, mw: 1.75, mh: 1.5 },
  /** Lit sign faces (lettering only, no marks). */
  sign0: { x: 4, y: 308, w: 160, h: 64, mw: 2.5, mh: 1.0 },
  sign1: { x: 172, y: 308, w: 160, h: 64, mw: 2.5, mh: 1.0 },
  sign2: { x: 340, y: 308, w: 160, h: 64, mw: 2.5, mh: 1.0 },
  /** A canopy's ceiling lamp panel. */
  lamp: { x: 4, y: 380, w: 48, h: 48, mw: 1.2, mh: 1.2 },
  /** Pump price display / vending glow. */
  panel: { x: 60, y: 380, w: 64, h: 96, mw: 0.9, mh: 1.4 },
} as const satisfies Record<string, Cell>;

/** A strip's v range: bottom, top. */
export function stripV(s: Strip, size = ATLAS): [number, number] {
  return [1 - (s.y + s.h) / size, 1 - s.y / size];
}

/** A cell's UV rectangle: u0, v0 (bottom-left), u1, v1 (top-right). */
export function cellUV(c: Cell, size = ATLAS): [number, number, number, number] {
  return [c.x / size, 1 - (c.y + c.h) / size, (c.x + c.w) / size, 1 - c.y / size];
}
