import { artRect } from "../../gfx/observatory-art";
import type { ObsLib } from "../../gfx/observatory-materials";
import { groundY } from "../dem";
import { arc, deg, Kits, type Kit, type P2, type V3 } from "./kit";
import { BLOCK, DRUM, FACADE, LEVEL, ROTUNDA, deckOutline } from "./plan";

/**
 * The main block: the north façade with its two wings and the entrance
 * pavilion, the side walls, the roof deck with its parapets, the rotunda in
 * its light well and the skylight block between the rotunda and the drum.
 *
 * The north façade (p02, p04, p05, p19): a plinth, five tall bronze-grille
 * windows a wing set 0.3 m back in plain reveals with projecting sills,
 * fluted pilasters between the bays, a Greek-key frieze under a moulded
 * cornice, the parapet of the roof deck above. The pavilion projects 3 m,
 * rises 1 m above the wings, and holds the doorway in a 2 m recess under
 * "GRIFFITH OBSERVATORY".
 */

const D = LEVEL.deck;
const PAR = D + LEVEL.parapet;
/** Frieze (Greek key) and cornice heights on the façade (est. from p04, p05, p19). */
const FRIEZE = [7.25, 7.61] as const;
const CORNICE = [7.75, 8.25] as const;
const PIL_W = 0.9;
const PIL_D = 0.16;
const REVEAL = 0.32;

/** |x| of the drum wall at a given z on its east (x > DRUM.x) side, mirrored about DRUM.x for the west. */
function drumX(z: number): number {
  return Math.sqrt(DRUM.r ** 2 - (z - DRUM.z) ** 2);
}

/** Lowest ground under a segment, a little below (walls run into the ground). */
export function footY(a: P2, b: P2, step = 2): number {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  let m = Infinity;
  for (let i = 0; i <= n; i++) m = Math.min(m, groundY(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n));
  return m - 0.6;
}

/** A parapet along a path: outer face, a rounded-off coping, the inner face (profile [out, y]). */
export function parapet(k: Kit, path: P2[], closed: boolean, y0: number, side: 1 | -1, height = LEVEL.parapet, t = 0.32, drop = D - CORNICE[1]): void {
  const y1 = y0 + height;
  k.sweep(
    path,
    closed,
    [
      [0, y0 - drop],
      [0, y1 - 0.12],
      [0.05, y1 - 0.1],
      [0.05, y1 - 0.02],
      [0, y1],
      [-t, y1],
      [-t - 0.05, y1 - 0.02],
      [-t - 0.05, y1 - 0.1],
      [-t, y1 - 0.12],
      [-t, y0],
    ],
    side,
  );
}

/** Moulded cornice band along a wall (projecting `p` m). */
function cornice(k: Kit, path: P2[], closed: boolean, y0: number, y1: number, side: 1 | -1, p = 0.32): void {
  const h = y1 - y0;
  k.sweep(
    path,
    closed,
    [
      [0, y0],
      [p * 0.35, y0 + h * 0.15],
      [p * 0.45, y0 + h * 0.4],
      [p, y0 + h * 0.62],
      [p, y1],
      [0, y1],
    ],
    side,
  );
}

/** Greek-key band on a straight wall face: one atlas quad per 1.44 m motif pair, `off` m proud. */
function keyBand(k: Kit, a: P2, b: P2, y0: number, y1: number, side: 1 | -1, off = 0.02): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.round(len / 1.44));
  const dx = (b[0] - a[0]) / len;
  const dz = (b[1] - a[1]) / len;
  const nx = dz * side;
  const nz = -dx * side;
  const at = artRect("key");
  for (let i = 0; i < n; i++) {
    const s0 = (len * i) / n;
    const s1 = (len * (i + 1)) / n;
    const P = (s: number, y: number): V3 => [a[0] + dx * s + nx * off, y, a[1] + dz * s + nz * off];
    k.quad(P(s0, y0), P(s1, y0), P(s1, y1), P(s0, y1), [nx, 0, nz], [at.u0, at.v0], [at.u1, at.v0], [at.u1, at.v1], [at.u0, at.v1]);
  }
  // Fillets above and below: tiny ledges that catch the grazing light.
}

/** An atlas cell on a vertical quad facing (nx, nz), centred at (x, z), width w, from y0 to y1. */
export function decal(k: Kit, cell: Parameters<typeof artRect>[0], x: number, z: number, nx: number, nz: number, w: number, y0: number, y1: number, sub?: [number, number, number, number]): void {
  const at = artRect(cell);
  const [su0, sv0, su1, sv1] = sub ?? [0, 0, 1, 1];
  const u0 = at.u0 + (at.u1 - at.u0) * su0;
  const u1 = at.u0 + (at.u1 - at.u0) * su1;
  const v0 = at.v0 + (at.v1 - at.v0) * sv0;
  const v1 = at.v0 + (at.v1 - at.v0) * sv1;
  // Right of a viewer facing the decal (looking along −n): (nz, −nx).
  const rx = nz;
  const rz = -nx;
  const P = (s: number, y: number): V3 => [x + rx * s, y, z + rz * s];
  k.quad(P(-w / 2, y0), P(w / 2, y0), P(w / 2, y1), P(-w / 2, y1), [nx, 0, nz], [u0, v0], [u1, v0], [u1, v1], [u0, v1]);
}

/**
 * One wing of the north façade between x0 and x1 at z = FACADE.z: bays of
 * (pier, window), pilasters on the piers, window reveals, sills and lintels.
 * Returns the pilaster centres (the wall-washers sit at their feet).
 */
function wing(K: Kits, lib: ObsLib, x0: number, x1: number): number[] {
  const wall = K.of(lib.wall());
  const art = K.of(lib.art());
  const z = FACADE.z;
  const base = LEVEL.plaza - 0.4;
  const mid = (x0 + x1) / 2;
  const n = FACADE.windows;
  const ww = FACADE.winW;
  const centres = Array.from({ length: n }, (_, i) => mid + (i - (n - 1) / 2) * FACADE.bay);
  const piers: number[] = [x0 + 0.9, ...centres.slice(1).map((c) => c - FACADE.bay / 2), x1 - 0.9];
  // Wall face, column by column (piers full height, window columns around the opening).
  const cuts = [x0, ...centres.flatMap((c) => [c - ww / 2, c + ww / 2]), x1];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a: P2 = [cuts[i], z];
    const b: P2 = [cuts[i + 1], z];
    const isWin = i % 2 === 1;
    if (!isWin) wall.wall(a, b, base, CORNICE[1], 1, { su: Math.ceil((cuts[i + 1] - cuts[i]) / 1.2), sv: 9, u0: cuts[i] });
    else {
      wall.wall(a, b, base, FACADE.sill, 1, { u0: cuts[i], sv: 2 });
      wall.wall(a, b, FACADE.head, CORNICE[1], 1, { u0: cuts[i], sv: 4 });
    }
  }
  for (const c of centres) {
    const l = c - ww / 2;
    const r = c + ww / 2;
    // Reveals (darker: little sky reaches them), head soffit, sill.
    wall.shade = 0.72;
    wall.wall([l, z], [l, z + REVEAL], FACADE.sill, FACADE.head, -1);
    wall.wall([r, z], [r, z + REVEAL], FACADE.sill, FACADE.head, 1);
    wall.shade = 0.6;
    wall.flat([[l, z], [r, z], [r, z + REVEAL], [l, z + REVEAL]], FACADE.head, -1);
    wall.shade = 1;
    wall.box(l - 0.08, r + 0.08, FACADE.sill - 0.12, FACADE.sill, z - 0.12, z + REVEAL, "ny");
    // Bronze window in the reveal; the two outer windows of each wing a little dimmer.
    const dim = Math.abs(c - mid) > FACADE.bay * 1.5;
    decal(art, dim ? "window2" : "window", c, z + REVEAL, 0, -1, ww, FACADE.sill, FACADE.head);
    // A recessed panel over the window to the frieze.
    wall.shade = 0.9;
    wall.box(l + 0.1, r - 0.1, FACADE.head + 0.35, FRIEZE[0] - 0.3, z - 0.02, z + 0.05, "pz");
    wall.shade = 1;
  }
  // Pilasters on the piers: a stepped fin with three flutes on its face.
  for (const p of piers) pilaster(K, lib, p, z, -1, base, FRIEZE[0]);
  // Plinth, frieze, cornice.
  wall.box(x0, x1, base, LEVEL.plaza + 0.55, z - 0.1, z + 0.01, "pz");
  keyBand(art, [x0, z], [x1, z], FRIEZE[0], FRIEZE[1], 1, 0.03);
  cornice(wall, [[x0, z], [x1, z]], false, CORNICE[0], CORNICE[1], 1);
  return piers;
}

/** A fluted pilaster on a wall facing `facing` (−1 north, +1 south) at x, from y0 to y1. */
function pilaster(K: Kits, lib: ObsLib, x: number, z: number, facing: 1 | -1, y0: number, y1: number): void {
  const wall = K.of(lib.wall());
  const art = K.of(lib.art());
  const zf = z + facing * PIL_D;
  const hw = PIL_W / 2;
  const sv = Math.ceil((y1 - y0) / 0.8);
  // Sides.
  wall.wall([x - hw, z], [x - hw, zf], y0, y1, facing === -1 ? 1 : -1, { sv });
  wall.wall([x + hw, z], [x + hw, zf], y0, y1, facing === -1 ? -1 : 1, { sv });
  // Face: the flutes cell stretched along it (uniform in v), in strips for the light fans.
  const at = artRect("flutes");
  const nz = facing;
  for (let j = 0; j < sv; j++) {
    const h0 = y0 + ((y1 - y0) * j) / sv;
    const h1 = y0 + ((y1 - y0) * (j + 1)) / sv;
    const P = (s: number, y: number): V3 => [x + s, y, zf];
    const v0 = at.v0 + ((at.v1 - at.v0) * j) / sv;
    const v1 = at.v0 + ((at.v1 - at.v0) * (j + 1)) / sv;
    art.quad(P(-hw, h0), P(hw, h0), P(hw, h1), P(-hw, h1), [0, 0, nz], [at.u0, v0], [at.u1, v0], [at.u1, v1], [at.u0, v1]);
  }
  // Capital block under the cornice.
  wall.box(x - hw - 0.05, x + hw + 0.05, y1 - 0.35, y1, Math.min(z, zf - 0.05 * facing), Math.max(z, zf - 0.05 * facing), facing === -1 ? "pz" : "nz");
}

/** The entrance pavilion: corner blocks, the recess with the doorway and lettering, steps. */
function pavilion(K: Kits, lib: ObsLib): void {
  const wall = K.of(lib.wall());
  const art = K.of(lib.art());
  const bronze = K.of(lib.bronze());
  const { pav, recess } = FACADE;
  const top = pav.top;
  const base = LEVEL.plaza - 0.4;
  const back = FACADE.z + 2.0;
  // Corner blocks: fronts, outer sides, inner sides into the recess.
  for (const [a, b] of [
    [pav.x0, recess.x0],
    [recess.x1, pav.x1],
  ] as [number, number][]) {
    wall.wall([a, pav.z], [b, pav.z], base, top, 1, { su: 6, sv: 12, u0: a });
    // Two fluted pilasters on each block face (p05).
    const m = (a + b) / 2;
    for (const s of [-1, 1]) pilaster(K, lib, m + s * 1.35, pav.z, -1, base, 8.6);
    keyBand(art, [a, pav.z], [b, pav.z], 8.95, 9.31, 1, 0.03);
  }
  wall.wall([pav.x0, pav.z], [pav.x0, back], base, top, -1, { su: 2, sv: 10 });
  wall.wall([pav.x1, pav.z], [pav.x1, back], base, top, 1, { su: 2, sv: 10 });
  wall.wall([recess.x0, pav.z], [recess.x0, recess.z], LEVEL.plaza, top, 1, { sv: 8 });
  wall.wall([recess.x1, pav.z], [recess.x1, recess.z], LEVEL.plaza, top, -1, { sv: 8 });
  // Recess wall with the door opening.
  const cx = (recess.x0 + recess.x1) / 2;
  const dw = 3.6;
  const dTop = LEVEL.floor + 5.6;
  wall.wall([recess.x0, recess.z], [cx - dw / 2 - 0.5, recess.z], LEVEL.floor, top, 1, { sv: 8 });
  wall.wall([cx + dw / 2 + 0.5, recess.z], [recess.x1, recess.z], LEVEL.floor, top, 1, { sv: 8 });
  wall.wall([cx - dw / 2 - 0.5, recess.z], [cx + dw / 2 + 0.5, recess.z], dTop + 0.5, top, 1, { sv: 4 });
  // Stepped bronze surround round the doorway, the doors 0.45 m back.
  bronze.box(cx - dw / 2 - 0.5, cx - dw / 2, LEVEL.floor, dTop + 0.5, recess.z - 0.06, recess.z + 0.45, "pz");
  bronze.box(cx + dw / 2, cx + dw / 2 + 0.5, LEVEL.floor, dTop + 0.5, recess.z - 0.06, recess.z + 0.45, "pz");
  bronze.box(cx - dw / 2, cx + dw / 2, dTop, dTop + 0.5, recess.z - 0.06, recess.z + 0.45, "pz");
  decal(art, "door", cx, recess.z + 0.45, 0, -1, dw, LEVEL.floor, dTop);
  // Lettering high on the recess wall (p04, p05), and the frieze over it.
  decal(art, "letters", cx, recess.z - 0.02, 0, -1, 8.6, 8.55, 9.15);
  keyBand(art, [recess.x0, recess.z], [recess.x1, recess.z], 9.45, 9.81, 1, 0.02);
  // Pavilion crown: cornice and parapet coping, flat top (a little above the deck).
  cornice(wall, [[pav.x0, back], [pav.x0, pav.z], [recess.x0, pav.z], [recess.x0, recess.z], [recess.x1, recess.z], [recess.x1, pav.z], [pav.x1, pav.z], [pav.x1, back]], false, top - 0.7, top - 0.3, 1, 0.22);
  wall.box(pav.x0 - 0.05, pav.x1 + 0.05, top - 0.3, top, pav.z - 0.05, back, "ny");
  wall.wall([pav.x0, back], [pav.x1, back], D, top, -1, { su: 8 });
}

/** Plain side walls of the block below the deck, with a row of windows and the cornice. */
function sideWalls(K: Kits, lib: ObsLib): void {
  const wall = K.of(lib.wall());
  const art = K.of(lib.art());
  type Side = { a: P2; b: P2; side: 1 | -1; windows?: number; small?: boolean };
  // Walls round the block (outward side given explicitly), where they are open to the air.
  const sides: Side[] = [
    { a: [BLOCK.eastWing.x1, -23.9], b: [BLOCK.eastWing.x1, BLOCK.eastWing.z1], side: 1, windows: 4 },
    { a: [BLOCK.eastWing.x0, BLOCK.eastWing.z1], b: [BLOCK.eastWing.x1, BLOCK.eastWing.z1], side: -1, windows: 3 },
    { a: [BLOCK.eastShoulder.x1, BLOCK.eastShoulder.z0], b: [BLOCK.eastShoulder.x1, BLOCK.eastShoulder.z1], side: 1, windows: 2, small: true },
    { a: [DRUM.x + drumX(2.0) - 0.2, 2.0], b: [BLOCK.eastShoulder.x1, 2.0], side: -1 },
    { a: [BLOCK.westShoulder.x0, 2.1], b: [DRUM.x - drumX(2.1) + 0.2, 2.1], side: -1 },
    { a: [BLOCK.westShoulder.x0, -8.1], b: [BLOCK.westShoulder.x0, 2.1], side: -1, windows: 2, small: true },
    { a: [BLOCK.westShoulder.x0, -8.1], b: [-15.2, -8.1], side: 1 },
    { a: [-15.3, -21.7], b: [-15.2, -8.1], side: -1, windows: 3 },
    { a: [-31.3, -21.7], b: [-15.3, -21.7], side: -1, windows: 4 },
    { a: [-31.3, -24.3], b: [-31.3, -21.7], side: -1 },
  ];
  for (const s of sides) {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    const foot = footY(s.a, s.b);
    wall.wall(s.a, s.b, foot, CORNICE[1], s.side, { su: Math.ceil(len / 2), sv: Math.ceil((CORNICE[1] - foot) / 1.2) });
    cornice(wall, [s.a, s.b], false, CORNICE[0], CORNICE[1], s.side);
    keyBand(art, s.a, s.b, FRIEZE[0], FRIEZE[1], s.side, 0.03);
    if (s.windows) {
      const dx = (s.b[0] - s.a[0]) / len;
      const dz = (s.b[1] - s.a[1]) / len;
      const nx = dz * s.side;
      const nz = -dx * s.side;
      for (let i = 0; i < s.windows; i++) {
        const t = (i + 0.5) / s.windows;
        const x = s.a[0] + dx * len * t + nx * 0.03;
        const z = s.a[1] + dz * len * t + nz * 0.03;
        if (s.small) {
          decal(art, "drumWin", x, z, nx, nz, 1.0, 4.4, 5.9);
          decal(art, "drumDark", x, z, nx, nz, 1.0, 0.6, 2.1);
        } else decal(art, "window2", x, z, nx, nz, 1.4, 2.4, 5.2);
      }
    }
  }
}

/** Roof deck with holes for the rotunda well and the upper drum; parapets on the open edges. */
function deck(K: Kits, lib: ObsLib): void {
  const deckK = K.of(lib.deck());
  const wall = K.of(lib.wall());
  const outline = deckOutline();
  const well = octagon(ROTUNDA.x, ROTUNDA.z, ROTUNDA.r + 0.9);
  const drumHole = arc(DRUM.x, DRUM.z, DRUM.rUpper, 0, Math.PI * 2, 64).slice(0, 64);
  deckK.flat(outline, D, 1, [well, drumHole]);
  // Deck slab edge visible from below on the open sides is covered by the walls; parapets:
  const north = FACADE.z;
  // Façade parapets (wings).
  parapet(wall, [[FACADE.west, north], [FACADE.pav.x0, north]], false, D, 1, PAR - D, 0.35);
  parapet(wall, [[FACADE.pav.x1, north], [FACADE.east, north]], false, D, 1, PAR - D, 0.35);
  // East and west parapets of the wings, the south parapets of the block.
  const open: P2[][] = [
    [
      [BLOCK.eastWing.x1, -23.9],
      [BLOCK.eastWing.x1, BLOCK.eastWing.z1],
      [BLOCK.eastWing.x0, BLOCK.eastWing.z1],
      [BLOCK.eastShoulder.x1, BLOCK.eastShoulder.z1],
      [DRUM.x + drumX(2.0) - 0.3, 2.0],
    ],
    [
      [DRUM.x - drumX(2.1) + 0.3, 2.1],
      [BLOCK.westShoulder.x0, 2.1],
      [BLOCK.westShoulder.x0, -8.1],
      [-15.2, -8.1],
      [-15.3, -21.7],
      [-31.3, -21.7],
      [-31.3, -24.3],
    ],
  ];
  // Clockwise outline (north up): the outer side is the left of travel → side 1 for the east run, which runs south.
  parapet(wall, open[0], false, D, 1, PAR - D, 0.32);
  parapet(wall, open[1], false, D, 1, PAR - D, 0.32);
  // Rotunda well: a low parapet round it.
  parapet(wall, well, true, D, -1, 0.9, 0.25, 0.2);
}

/** Octagon (flat sides facing the axes) of circumradius r. */
export function octagon(cx: number, cz: number, r: number): P2[] {
  return Array.from({ length: 8 }, (_, i) => {
    const t = deg(22.5 + i * 45);
    return [cx + Math.cos(t) * r, cz + Math.sin(t) * r] as P2;
  });
}

/** The rotunda: octagonal drum in its light well, green copper roof, lantern (p02, p17). */
function rotunda(K: Kits, lib: ObsLib): void {
  const wall = K.of(lib.wall());
  const art = K.of(lib.art());
  const pat = K.of(lib.patina());
  const deckK = K.of(lib.deck());
  const { x, z, r } = ROTUNDA;
  const floor = D - 2.0;
  const well = octagon(x, z, r + 0.9);
  // Well walls (inside faces) and floor.
  wall.shade = 0.7;
  wall.ring(well, floor, D, false);
  wall.shade = 1;
  deckK.shade = 0.6;
  deckK.flat(well, floor, 1, [octagon(x, z, r)]);
  deckK.shade = 1;
  // Octagonal drum with a clerestory window on each face.
  const oct = octagon(x, z, r);
  wall.ring(oct, floor, ROTUNDA.wallTop, true, { sv: 3 });
  for (let i = 0; i < 8; i++) {
    const a = oct[i];
    const b = oct[(i + 1) % 8];
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    const t = deg(45 + i * 45);
    const nx = Math.cos(t);
    const nz = Math.sin(t);
    decal(art, "window2", mx + nx * 0.03, mz + nz * 0.03, nx, nz, 1.5, D + 0.1, ROTUNDA.wallTop - 0.6, [0, 0.35, 1, 1]);
  }
  cornice(wall, oct, true, ROTUNDA.wallTop - 0.45, ROTUNDA.wallTop, 1, 0.3);
  // Green roof: eight flat facets with a slight bell, then the lantern and its cap.
  const prof: P2[] = [
    [r + 0.35, ROTUNDA.wallTop],
    [r + 0.35, ROTUNDA.wallTop + 0.25],
    [r - 0.1, ROTUNDA.wallTop + 0.55],
    [r * 0.62, ROTUNDA.wallTop + 1.45],
    [r * 0.3, ROTUNDA.roofTop - 0.25],
    [1.25, ROTUNDA.roofTop],
  ];
  facetLathe(pat, x, z, prof, 8, deg(22.5));
  wall.ring(octagon(x, z, 1.2), ROTUNDA.roofTop, ROTUNDA.lanternTop - 0.3, true);
  facetLathe(
    pat,
    x,
    z,
    [
      [1.45, ROTUNDA.lanternTop - 0.3],
      [1.45, ROTUNDA.lanternTop - 0.15],
      [0.6, ROTUNDA.lanternTop + 0.15],
      [0.12, ROTUNDA.lanternTop + 0.45],
    ],
    8,
    deg(22.5),
  );
}

/** Surface of revolution with `n` flat facets (an octagonal roof), each face flat-shaded. */
export function facetLathe(k: Kit, cx: number, cz: number, prof: P2[], n: number, rot: number): void {
  for (let i = 0; i < n; i++) {
    const t0 = rot + (i * 2 * Math.PI) / n;
    const t1 = rot + ((i + 1) * 2 * Math.PI) / n;
    const tm = (t0 + t1) / 2;
    let v = 0;
    for (let j = 0; j + 1 < prof.length; j++) {
      const [r0, y0] = prof[j];
      const [r1, y1] = prof[j + 1];
      const P = (r: number, y: number, t: number): V3 => [cx + Math.cos(t) * r, y, cz + Math.sin(t) * r];
      const seg = Math.hypot(r1 - r0, y1 - y0);
      const out: V3 = [Math.cos(tm) * (y1 - y0), r0 - r1, Math.sin(tm) * (y1 - y0)];
      const w0 = 2 * r0 * Math.sin(Math.PI / n);
      const w1 = 2 * r1 * Math.sin(Math.PI / n);
      k.face(P(r0, y0, t0), P(r0, y0, t1), P(r1, y1, t1), P(r1, y1, t0), out, [-w0 / 2, v], [w0 / 2, v], [w1 / 2, v + seg], [-w1 / 2, v + seg]);
      v += seg;
    }
  }
}

/** The skylight block between the rotunda and the drum (p17): a low box with a hipped glazed roof. */
function skylight(K: Kits, lib: ObsLib): void {
  const wall = K.of(lib.wall());
  const deckK = K.of(lib.deck());
  const x0 = -6.5;
  const x1 = 6.5;
  const z0 = -19.6;
  const z1 = -14.0;
  wall.box(x0, x1, D, D + 1.5, z0, z1, "py ny");
  cornice(wall, [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], true, D + 1.25, D + 1.5, 1, 0.15);
  const y = D + 1.5;
  const top = y + 0.9;
  const m = 1.4;
  deckK.shade = 0.8;
  deckK.face([x0, y, z0], [x1, y, z0], [x1 - m, top, z0 + m], [x0 + m, top, z0 + m], [0, 1, -1], [x0, 0], [x1, 0], [x1 - m, 1], [x0 + m, 1]);
  deckK.face([x0, y, z1], [x1, y, z1], [x1 - m, top, z1 - m], [x0 + m, top, z1 - m], [0, 1, 1], [x0, 0], [x1, 0], [x1 - m, 1], [x0 + m, 1]);
  deckK.face([x0, y, z0], [x0 + m, top, z0 + m], [x0 + m, top, z1 - m], [x0, y, z1], [-1, 1, 0], [z0, 0], [z0 + m, 1], [z1 - m, 1], [z1, 0]);
  deckK.face([x1, y, z0], [x1 - m, top, z0 + m], [x1 - m, top, z1 - m], [x1, y, z1], [1, 1, 0], [z0, 0], [z0 + m, 1], [z1 - m, 1], [z1, 0]);
  deckK.flat([[x0 + m, z0 + m], [x1 - m, z0 + m], [x1 - m, z1 - m], [x0 + m, z1 - m]], top, 1);
  deckK.shade = 1;
}

/** The main block. Returns the façade pilaster positions (x) for the wall-washers. */
export function buildBlock(K: Kits, lib: ObsLib): { piers: number[] } {
  const piers = [...wing(K, lib, FACADE.west, FACADE.pav.x0), ...wing(K, lib, FACADE.pav.x1, FACADE.east)];
  pavilion(K, lib);
  sideWalls(K, lib);
  deck(K, lib);
  rotunda(K, lib);
  skylight(K, lib);
  return { piers };
}
