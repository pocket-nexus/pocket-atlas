import type { Material } from "three";
import type { AtlasRect } from "../../../shared/atlas";
import type { Ctx } from "../../gfx/canvas";
import type { MaterialLib } from "../../gfx/materials";

export { atlasPlane, cablePoint, flip, instance, merge, Parts, quad, rod, tube, v3 } from "../../../shared/shapes";

/**
 * Signage hooks for the street furniture: keyed cells in the shared world
 * atlas (each key painted once) and the two shared atlas materials, so every
 * plate, sticker and sign merges into the same batches as the buildings'.
 */
export interface Kit {
  /** Paints (once per key) a cell of w×h pixels in the shared atlas. */
  draw(key: string, w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect;
  /** Passive printed plates and retroreflective film. */
  labels: Material;
  /** Internally lit sign faces. */
  lit: Material;
}

/**
 * The few shared finishes every prop draws from. Each entry is one memoized
 * library material, so everything painted "red" (vending cabinets, post box,
 * cones, crates) collapses into a single batch.
 */
export function palette(lib: MaterialLib) {
  return {
    black: lib.plain(0x0f1011, 0.5),
    galv: lib.paint(0x80868a, 0.4),
    gray: lib.paint(0xa9aeb1, 0.38),
    dark: lib.paint(0x3c3f43, 0.45),
    white: lib.paint(0xe4e4de, 0.38),
    yellow: lib.paint(0xd6a81a, 0.45),
    red: lib.paint(0xc01b18, 0.38),
    blue: lib.paint(0x1c5ab8, 0.35),
    orange: lib.paint(0xe0611b, 0.38),
    porcelain: lib.plain(0xe6e3da, 0.22),
    screen: lib.glow(0x9fe4ff, 1.5),
    chrome: lib.chrome(),
    rubber: lib.rubber(),
  };
}
