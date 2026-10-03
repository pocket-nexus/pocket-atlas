/**
 * The structures atlas: where the concrete, the painted plate, the lattice
 * pylons and the station name boards sit in the 1024² texture of the
 * `structure` and `structure-cut` materials. Plain data: the painter
 * (`kit/structures.ts`, on the page) and the generator
 * (`gen/structures.ts`, in the worker and under Bun) both read it.
 */

/** Atlas edge the layout is written in (pixels); the painter scales it to the kit's texture size. */
export const ATLAS_SIZE = 1024;
/** Border of edge pixels around every opaque cell. */
export const ATLAS_PAD = 8;

/**
 * Stations of the JR Furano Line (and Furano on the Nemuro Main Line) by
 * their OSM name, with the reading and romanisation a name board carries.
 */
export const STATIONS = [
  { key: "緑が丘", kana: "みどりがおか", en: "Midorigaoka" },
  { key: "西御料", kana: "にしごりょう", en: "Nishi-Goryō" },
  { key: "西瑞穂", kana: "にしみずほ", en: "Nishi-Mizuho" },
  { key: "西神楽", kana: "にしかぐら", en: "Nishi-Kagura" },
  { key: "西聖和", kana: "にしせいわ", en: "Nishi-Seiwa" },
  { key: "千代ヶ岡", kana: "ちよがおか", en: "Chiyogaoka" },
  { key: "北美瑛", kana: "きたびえい", en: "Kita-Biei" },
  { key: "美瑛", kana: "びえい", en: "Biei" },
  { key: "美馬牛", kana: "びばうし", en: "Bibaushi" },
  { key: "上富良野", kana: "かみふらの", en: "Kami-Furano" },
  { key: "西中", kana: "にしなか", en: "Nishinaka" },
  { key: "ラベンダー畑", kana: "らべんだーばたけ", en: "Lavender-Batake" },
  { key: "中富良野", kana: "なかふらの", en: "Naka-Furano" },
  { key: "鹿討", kana: "しかうち", en: "Shikauchi" },
  { key: "学田", kana: "がくでん", en: "Gakuden" },
  { key: "富良野", kana: "ふらの", en: "Furano" },
] as const;

/** Stations with a staffed building and a long platform; the rest are halts with a 45 m platform. */
export const MAIN_STATIONS: readonly string[] = ["美瑛", "上富良野", "中富良野", "富良野", "西神楽"];

/** A name board: 1.5 m × 0.86 m (JR Hokkaido's standard board is about this size; estimated). */
export const BOARD = { w: 1.5, h: 0.86 };

export interface AtlasCell {
  /** Pixels of the 1024 atlas, y down from the top of the canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** UV rectangle (v up): u0, v0, u1, v1, half a pixel inside the cell. */
  uv: readonly [number, number, number, number];
}

function at(x: number, y: number, w: number, h: number): AtlasCell {
  return { x, y, w, h, uv: [(x + 0.5) / ATLAS_SIZE, 1 - (y + h - 0.5) / ATLAS_SIZE, (x + w - 0.5) / ATLAS_SIZE, 1 - (y + 0.5) / ATLAS_SIZE] };
}

/**
 *   plain      white: everything coloured by its vertices alone
 *   concrete   4 m of board-formed concrete (laid mirrored, never repeated)
 *   plate      a painted plate girder, 5 m long: stiffeners and flanges, near white (the paint is the vertex colour)
 *   pylon      a lattice transmission tower seen across the line (cut-out)
 *   pylonSide  the same tower seen along the line, and a lattice mast (cut-out)
 *   board-N    the name board of STATIONS[N]
 */
export const CELLS: Record<string, AtlasCell> = {
  plain: at(8, 8, 48, 48),
  concrete: at(72, 8, 240, 240),
  plate: at(328, 8, 240, 112),
  pylonSide: at(648, 8, 112, 752),
  pylon: at(776, 8, 240, 752),
  ...Object.fromEntries(STATIONS.map((_, i) => [`board-${i}`, at(8 + (i % 3) * 208, 264 + Math.floor(i / 3) * 126, 192, 110)])),
};

export function cell(name: string): AtlasCell {
  const c = CELLS[name];
  if (!c) throw new Error(`no structures atlas cell "${name}"`);
  return c;
}

/** Cells that are alpha-tested cut-outs (cleared to transparent, not edge-extended). */
export const CUT_CELLS: readonly string[] = ["pylon", "pylonSide"];

/**
 * A lattice tower as the painter draws it and the generator hangs wires on
 * it, in fractions of its height: the body's half width at the foot and at
 * the waist, the cross-arms' heights and half spans. The `pylon` cell is
 * `PYLON.width` of the height wide.
 */
export const PYLON = {
  width: 240 / 752,
  sideWidth: 112 / 752,
  foot: 0.085,
  waist: 0.022,
  waistAt: 0.62,
  arms: [
    { y: 0.66, half: 0.142 },
    { y: 0.78, half: 0.128 },
    { y: 0.9, half: 0.112 },
  ],
} as const;
