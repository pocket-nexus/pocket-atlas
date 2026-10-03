/**
 * The roadside atlas: where every sign face, stripe and lens sits in the
 * 1024² texture of the `roadside` and `roadside-lit` materials, and the real
 * sizes and outlines of the things painted there. Plain data: the painter
 * (`kit/roadside.ts`, on the page) and the generator (`gen/roadside.ts`, in
 * the worker and under Bun) both read it.
 */

/** Atlas edge the layout is written in (pixels); the painter scales it to the kit's texture size. */
export const ATLAS_SIZE = 1024;
/** Border of edge pixels around every cell. */
export const ATLAS_PAD = 8;

/**
 * Towns a distance board or a boundary sign can name: the OSM `place-*`
 * name without its suffix, the suffix, and the romanisation the real boards
 * carry. A town the survey finds that is not listed here gets no board.
 */
export const TOWNS = [
  { key: "美瑛", suffix: "町", en: "Biei", kind: "Town" },
  { key: "上富良野", suffix: "町", en: "Kamifurano", kind: "Town" },
  { key: "中富良野", suffix: "町", en: "Nakafurano", kind: "Town" },
  { key: "富良野", suffix: "市", en: "Furano", kind: "City" },
  { key: "旭川", suffix: "市", en: "Asahikawa", kind: "City" },
] as const;

/** Speed limits a sign exists for (km/h). */
export const SPEEDS = [30, 40, 50, 60] as const;

/** Route numbers a shield exists for. */
export const SHIELDS = ["237", "38"] as const;

/** Cells: name, width, height (pixels of the 1024 atlas). */
const SIZES: [string, number, number][] = [
  // Tall cells first: the shelves pack tighter.
  ["arrow", 88, 256],
  ["stripes", 32, 256],
  ["pole", 48, 256],
  ["busPlate", 96, 152],
  ...SHIELDS.map((r): [string, number, number] => [`shield-${r}`, 192, 176]),
  ["stop", 192, 168],
  ...SPEEDS.map((v): [string, number, number] => [`speed-${v}`, 144, 144]),
  ["busDisc", 128, 128],
  ["sigTop", 64, 128],
  ["sigGo", 64, 64],
  ["sigStop", 64, 64],
  ...TOWNS.map((_, i): [string, number, number] => [`bound-${i}`, 288, 104]),
  ["slip", 256, 104],
  ["curve", 256, 104],
  ...TOWNS.map((_, i): [string, number, number] => [`name-${i}`, 208, 88]),
  ...Array.from({ length: 10 }, (_, i): [string, number, number] => [`digit-${i}`, 44, 88]),
  ["km", 72, 88],
  ["rail", 64, 64],
  ["reflWhite", 48, 48],
  ["reflOrange", 48, 48],
  ["blue", 24, 24],
  ["white", 24, 24],
  ["lamp", 24, 24],
];

export interface AtlasCell {
  /** Pixels of the 1024 atlas, y down from the top of the canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** UV rectangle (v up): u0, v0, u1, v1, half a pixel inside the cell. */
  uv: readonly [number, number, number, number];
}

function pack(): Record<string, AtlasCell> {
  const out: Record<string, AtlasCell> = {};
  const step = 8;
  let x = ATLAS_PAD;
  let y = ATLAS_PAD;
  let shelf = 0;
  for (const [name, w, h] of SIZES) {
    if (x + w + ATLAS_PAD > ATLAS_SIZE) {
      x = ATLAS_PAD;
      y += shelf + 2 * ATLAS_PAD;
      // Whole multiples of 8: the cells stay on pixel boundaries at 512 and 256.
      y = Math.ceil(y / step) * step;
      shelf = 0;
    }
    if (y + h + ATLAS_PAD > ATLAS_SIZE) throw new Error(`roadside atlas is full at ${name}`);
    out[name] = { x, y, w, h, uv: [(x + 0.5) / ATLAS_SIZE, 1 - (y + h - 0.5) / ATLAS_SIZE, (x + w - 0.5) / ATLAS_SIZE, 1 - (y + 0.5) / ATLAS_SIZE] };
    x = Math.ceil((x + w + 2 * ATLAS_PAD) / step) * step;
    shelf = Math.max(shelf, h);
  }
  return out;
}

export const CELLS: Record<string, AtlasCell> = pack();

export function cell(name: string): AtlasCell {
  const c = CELLS[name];
  if (!c) throw new Error(`no roadside atlas cell "${name}"`);
  return c;
}

/** A point of an outline in its cell: x right, y up, both −0.5..0.5 of the cell. */
export type Outline = readonly (readonly [number, number])[];

/** A triangle with its point down and rounded corners (counter-clockwise from the front). */
function roundedTriangle(top: number, bottom: number, half: number, r: number, steps: number): Outline {
  const corners: [number, number][] = [
    [-half, top],
    [0, bottom],
    [half, top],
  ];
  const out: [number, number][] = [];
  for (let i = 0; i < 3; i++) {
    const p = corners[i];
    const a = corners[(i + 2) % 3];
    const b = corners[(i + 1) % 3];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    // The corner's arc as a quadratic curve between the points `r` along each edge.
    const pa = [p[0] + ((a[0] - p[0]) * r) / la, p[1] + ((a[1] - p[1]) * r) / la];
    const pb = [p[0] + ((b[0] - p[0]) * r) / lb, p[1] + ((b[1] - p[1]) * r) / lb];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push([u * u * pa[0] + 2 * u * t * p[0] + t * t * pb[0], u * u * pa[1] + 2 * u * t * p[1] + t * t * pb[1]]);
    }
  }
  return out;
}

function disc(n: number): Outline {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    return [0.5 * Math.cos(a), 0.5 * Math.sin(a)] as const;
  });
}

/** The national-route shield ("onigiri"): a rounded triangle, point down. */
export const SHIELD_OUTLINE: Outline = roundedTriangle(0.5, -0.5, 0.5, 0.3, 3);
/** 止まれ: an inverted triangle with small corner radii. */
export const STOP_OUTLINE: Outline = roundedTriangle(0.5, -0.5, 0.5, 0.09, 1);
/** Round regulatory signs and the bus stop's disc. */
export const DISC_OUTLINE: Outline = disc(12);

/**
 * 矢羽根 (the arrow of a 固定式視線誘導柱): a chevron-striped plate with a
 * notched tail and a point, hanging point down over the edge of the
 * carriageway. The notch and the point are this fraction of the height.
 */
export const ARROW_NOTCH = 0.16;
export const ARROW_TIP = 0.24;

/**
 * Real sizes (m). Sign faces follow the Japanese sign order's standard
 * sizes; the 矢羽根 plate is an estimate from photographs until the research
 * report has the maker's figure.
 */
export const SIZE = {
  arrow: { w: 0.42, h: 1.27 },
  shield: { w: 0.8, h: 0.73 },
  stop: { w: 0.8, h: 0.7 },
  speed: 0.6,
  warn: { w: 1.3, h: 0.53 },
  bound: { w: 1.6, h: 0.56 },
  /** A row of a distance board: a name cell, two digits and "km". */
  row: { h: 0.56, name: 1.3, digit: 0.28, km: 0.47 },
  board: { w: 3.0, frame: 0.04, pad: 0.08 },
  signal: { w: 0.36, h: 1.08 },
  busDisc: 0.46,
  busPlate: { w: 0.34, h: 0.54 },
  reflector: 0.14,
} as const;
