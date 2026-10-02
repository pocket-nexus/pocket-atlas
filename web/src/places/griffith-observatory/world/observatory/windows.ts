import type { ObsLib } from "../../gfx/observatory-materials";
import type { Kits, V3 } from "./kit";

/**
 * The tall bronze windows (p02, p04, p05, p19) as the camera sees them close
 * up: a bronze grille in relief — frame, two mullions, transoms, a solid
 * spandrel at the gallery floor — in front of two panes of the shared
 * `interiorWindow` material, whose traced rooms give the lit halls depth
 * behind the glass. The lower pane is 2.3 m and the upper 0.6 m, both inside
 * the room tracer's 2.6 m ceiling. The rooms are seeded from `SEEDS`: each
 * seed was chosen so the room is lit, by a warm lamp, bright, with a wooden
 * floor, warm walls and no curtain or blind (the tracer's hashes evaluated
 * in double precision with ≥ 0.05 margin on every threshold).
 */

/** (x, y) room seeds: lit, warm lamp, bright, wooden floor, warm walls, open (no curtain, no blind, no television). */
const SEEDS: [number, number][] = [
  [89, 31],
  [205, 31],
  [67, 33],
  [175, 34],
  [250, 37],
  [140, 38],
  [255, 40],
  [193, 43],
  [226, 43],
  [87, 44],
  [65, 46],
  [134, 49],
];

let next = 0;

/**
 * A grille window `w` × `h` m whose panes sit in the plane through (cx, y0,
 * cz) facing (nx, nz); the grille stands 6 cm proud of them.
 */
export function grilleWindow(K: Kits, lib: ObsLib, cx: number, cz: number, nx: number, nz: number, w: number, y0: number, y1: number): void {
  const bronze = K.of(lib.bronze());
  const pane = K.of(lib.interior());
  const rx = nz;
  const rz = -nx;
  const n: V3 = [nx, 0, nz];
  const P = (s: number, y: number, d: number): V3 => [cx + rx * s + nx * d, y, cz + rz * s + nz * d];
  const [sx, sy] = SEEDS[next++ % SEEDS.length];
  // Panes: lower 0–74 % of the inner height, upper 80–100 %, the same room.
  const fx = 0.09;
  const fy = 0.1;
  const ix0 = -w / 2 + fx;
  const ix1 = w / 2 - fx;
  const iy0 = y0 + fy;
  const iy1 = y1 - fy;
  const ih = iy1 - iy0;
  const split0 = iy0 + ih * 0.74;
  const split1 = iy0 + ih * 0.8;
  for (const [a, b] of [
    [iy0, split0],
    [split1, iy1],
  ]) {
    const u = (t: number) => sx + 0.002 + t * 0.996;
    const v = (t: number) => sy + 0.002 + t * 0.996;
    pane.quad(P(ix0, a, 0), P(ix1, a, 0), P(ix1, b, 0), P(ix0, b, 0), n, [u(0), v(0)], [u(1), v(0)], [u(1), v(1)], [u(0), v(1)]);
  }
  // Bronze: a bar is a box from (s0, ya) to (s1, yb), from the pane plane to `d` proud.
  const bar = (s0: number, s1: number, ya: number, yb: number, d: number) => {
    const q = (s: number, y: number, dd: number) => P(s, y, dd);
    bronze.quad(q(s0, ya, d), q(s1, ya, d), q(s1, yb, d), q(s0, yb, d), n, [s0, ya], [s1, ya], [s1, yb], [s0, yb]);
    const side = (sa: number, sign: number) => bronze.face(q(sa, ya, -0.02), q(sa, ya, d), q(sa, yb, d), q(sa, yb, -0.02), [rx * sign, 0, rz * sign], [0, ya], [d, ya], [d, yb], [0, yb]);
    side(s0, -1);
    side(s1, 1);
    bronze.face(q(s0, yb, -0.02), q(s1, yb, -0.02), q(s1, yb, d), q(s0, yb, d), [0, 1, 0], [s0, 0], [s1, 0], [s1, d], [s0, d]);
    bronze.face(q(s0, ya, -0.02), q(s1, ya, -0.02), q(s1, ya, d), q(s0, ya, d), [0, -1, 0], [s0, 0], [s1, 0], [s1, d], [s0, d]);
  };
  // Frame.
  bar(-w / 2, w / 2, y0, iy0, 0.08);
  bar(-w / 2, w / 2, iy1, y1, 0.08);
  bar(-w / 2, ix0, iy0, iy1, 0.08);
  bar(ix1, w / 2, iy0, iy1, 0.08);
  // Mullions (3 lights across), transoms (4 lights in the lower pane, 2 in the upper), the spandrel.
  const iw = ix1 - ix0;
  for (const t of [1 / 3, 2 / 3]) bar(ix0 + iw * t - 0.025, ix0 + iw * t + 0.025, iy0, iy1, 0.05);
  for (const t of [0.185, 0.37, 0.555, 0.9]) bar(ix0, ix1, iy0 + ih * t - 0.022, iy0 + ih * t + 0.022, 0.04);
  bar(ix0, ix1, split0, split1, 0.06);
}
