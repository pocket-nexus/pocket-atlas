import { fbm2 } from "../noise";

/**
 * Where everything sits in the `plants` atlas, and what kind of wood stands
 * where: plain data shared by the painter (`kit/plants.ts`), the generator
 * (`gen/plants.ts`) and the terrain's tints (`gen/terrain.ts`).
 *
 * The atlas is 1024² with every cell inset by `PAD` (the painter extends the
 * cell's edge pixels over the padding, so mips do not pull in a neighbour).
 * A tree's trunk stands on the middle of its cell's bottom edge.
 */
export const ATLAS = 1024;
export const PAD = 6;

/** Cells in pixels: x, y (from the top), width, height. */
export const CELLS = {
  // Bare larch (カラマツ): a straight trunk, whorls of level branches, an ochre twig haze.
  larchA: [0, 0, 192, 448],
  larchB: [192, 0, 192, 448],
  larchC: [384, 0, 176, 448],
  // White birch (シラカバ): white trunk and limbs, a fine dark crown.
  birchA: [560, 0, 160, 448],
  birchB: [720, 0, 144, 448],
  // Lombardy poplar: a column of steep branches.
  poplar: [864, 0, 112, 448],
  // Bark strips for trunk prisms (opaque).
  barkLarch: [976, 0, 48, 150],
  barkBirch: [976, 150, 48, 149],
  barkDark: [976, 299, 48, 149],
  // Sakhalin fir and Yezo spruce (トドマツ, エゾマツ) with snow on the boughs.
  spruceA: [0, 448, 160, 352],
  spruceB: [160, 448, 160, 352],
  // A bare broadleaf of the mixed woods (oak, elm): a round crown on a stout trunk.
  oak: [320, 448, 272, 352],
  // Stands seen as a mass: several trees and the rows behind them.
  clumpLarch: [592, 448, 432, 352],
  clumpMixed: [0, 800, 352, 224],
  clumpConifer: [352, 800, 320, 224],
  // Willow scrub, reeds through the snow, a snow-capped garden evergreen.
  shrub: [672, 800, 176, 224],
  reeds: [848, 800, 176, 100],
  bush: [848, 900, 176, 124],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export type CellName = keyof typeof CELLS;

/** A cell's drawn rectangle (inside its padding), in pixels. */
export function inner(name: CellName): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = CELLS[name];
  return { x: x + PAD, y: y + PAD, w: w - 2 * PAD, h: h - 2 * PAD };
}

/** A cell's UV rectangle: u0, v0 (bottom), u1, v1 (top). The canvas' top row is v = 1. */
export function uvOf(name: CellName): [number, number, number, number] {
  const r = inner(name);
  return [r.x / ATLAS, 1 - (r.y + r.h) / ATLAS, (r.x + r.w) / ATLAS, 1 - r.y / ATLAS];
}

/** Width over height of a cell's drawn rectangle: a card `h` metres tall is `h * aspect` wide. */
export function aspect(name: CellName): number {
  const r = inner(name);
  return r.w / r.h;
}

/** The stands of a wood: the survey's woods carry no leaf type, so the mix is placed by low-frequency noise (estimated). */
export const LARCH = 0;
export const MIXED = 1;
export const CONIFER = 2;
export type Stand = typeof LARCH | typeof MIXED | typeof CONIFER;

/**
 * Which stand a wooded point belongs to: larch plantations and conifer
 * plantations in blocks a few hundred metres across, mixed broadleaf and
 * birch between them.
 */
export function stand(x: number, z: number): Stand {
  const v = fbm2(x / 420 + 31.7, z / 420 - 12.3, 2, 23);
  return v < 0.43 ? LARCH : v > 0.6 ? CONIFER : MIXED;
}

/**
 * Snow under each stand as it reads from a distance, as a tint of the snow
 * material (sRGB): what the terrain shows where woods are too far to draw
 * as trees. `FLOOR` is the snow between trees that are drawn.
 * Estimated from winter views of the Biei and Furano hills under cloud.
 */
export const STAND_TINT: readonly (readonly [number, number, number])[] = [
  // Bare larch: a brown-grey haze.
  [136, 121, 110],
  // Mixed bare broadleaf and birch: grey with a violet cast.
  [124, 120, 126],
  // Fir and spruce with snow on them.
  [78, 90, 90],
];
export const STAND_FLOOR: readonly (readonly [number, number, number])[] = [
  [216, 213, 212],
  [212, 213, 219],
  [186, 194, 200],
];
