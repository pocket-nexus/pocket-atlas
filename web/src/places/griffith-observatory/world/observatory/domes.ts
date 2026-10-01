import { artRect } from "../../gfx/observatory-art";
import type { ObsLib } from "../../gfx/observatory-materials";
import { groundY } from "../dem";
import { arc, deg, Kits, type Kit, type P2, type V3 } from "./kit";
import { DOMES, LEVEL } from "./plan";
import { parapet } from "./block";

/**
 * The two telescope domes at the façade's corners (p02, p04, p17–p20). Each
 * drum rises from the ground to 11.6 m with horizontal rustication grooves
 * low down, a Greek-key band and a cornice at its top; the copper dome sits
 * on a vertical skirt with brackets. The west (coelostat) dome is shut; the
 * east (12-inch Zeiss) dome has its shutter open for public viewing, the
 * slit glowing with the warm-lit interior (p20). A curved stair with a
 * solid parapet climbs round each drum from the entrance plaza to the roof
 * deck (p17, p19; OSM steps 1360680905 and the path round the east dome).
 */

export interface DomeLights {
  /** Interior light of the open Zeiss dome (position) and the slit's direction (unit, horizontal). */
  slit: { pos: V3; dir: V3 };
  /** Wall-washer feet round the drums' exposed sides (position, aim). */
  washers: { pos: V3; aim: V3 }[];
}

/** Bearing of the Zeiss dome's open slit (toward the south-south-west evening sky, est.). */
const SLIT_BEARING = 200;

function drum(K: Kits, lib: ObsLib, c: { x: number; z: number }, exposed: [number, number]): void {
  const wall = K.of(lib.wall());
  const art = K.of(lib.art());
  const r = DOMES.drumR;
  const [a0, a1] = exposed;
  const seg = 40;
  for (let i = 0; i < seg; i++) {
    const t0 = a0 + ((a1 - a0) * i) / seg;
    const t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
    const g = Math.min(groundY(c.x + Math.cos(t0) * (r + 0.5), c.z + Math.sin(t0) * (r + 0.5)), groundY(c.x + Math.cos(t1) * (r + 0.5), c.z + Math.sin(t1) * (r + 0.5)));
    wall.cyl(c.x, c.z, r, g - 0.6, DOMES.drumTop - 0.55, t0, t1, 1, { sv: 8 });
    // Rustication: shallow grooves (darker rings) every 0.9 m up to the sill line (p19).
    wall.shade = 0.8;
    for (let y = LEVEL.plaza + 0.9; y < 4.2; y += 0.9) wall.cyl(c.x, c.z, r + 0.008, y - 0.03, y + 0.03, t0, t1, 1);
    wall.shade = 1;
  }
  // Above the deck the drum shows all round.
  wall.cyl(c.x, c.z, r, LEVEL.deck - 0.2, DOMES.drumTop - 0.55, a1, a0 + Math.PI * 2, 24, { sv: 2 });
  // Top band: Greek key under a cornice.
  const n = Math.round((2 * Math.PI * r) / 1.44);
  const at = artRect("key");
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * Math.PI * 2;
    const t1 = ((i + 1) / n) * Math.PI * 2;
    const P = (t: number, y: number): V3 => [c.x + Math.cos(t) * (r + 0.01), y, c.z + Math.sin(t) * (r + 0.01)];
    const n0: V3 = [Math.cos(t0), 0, Math.sin(t0)];
    const n1: V3 = [Math.cos(t1), 0, Math.sin(t1)];
    art.quadN(P(t0, DOMES.drumTop - 0.95), P(t1, DOMES.drumTop - 0.95), P(t1, DOMES.drumTop - 0.59), P(t0, DOMES.drumTop - 0.59), n0, n1, n1, n0, [at.u0, at.v0], [at.u1, at.v0], [at.u1, at.v1], [at.u0, at.v1]);
  }
  wall.lathe(
    c.x,
    c.z,
    [
      [r, DOMES.drumTop - 0.55],
      [r + 0.12, DOMES.drumTop - 0.45],
      [r + 0.25, DOMES.drumTop - 0.2],
      [r + 0.25, DOMES.drumTop],
      [DOMES.domeR - 0.05, DOMES.drumTop],
    ],
    0,
    Math.PI * 2,
    48,
    { hard: true },
  );
}

/**
 * The copper: a vertical skirt with 16 brackets and a hemisphere. `slit`
 * (bearing) opens the shutter: the lit interior band from the skirt over the
 * zenith, the two shutter leaves parted either side (p19, p20); without it
 * the closed shutter is a raised band along the same great circle.
 */
function dome(K: Kits, lib: ObsLib, c: { x: number; z: number }, slitBearing: number, open: boolean): void {
  const copper = K.of(lib.copper());
  const art = K.of(lib.art());
  const R = DOMES.domeR;
  const y0 = DOMES.drumTop;
  const ys = DOMES.skirtTop;
  // UVs: 8 tiles round (64 pans), courses of 0.9 m.
  const uPer = 8 / (2 * Math.PI);
  copper.lathe(c.x, c.z, [
    [R + 0.08, y0],
    [R + 0.08, y0 + 0.15],
    [R, y0 + 0.22],
    [R, ys],
  ], 0, Math.PI * 2, 40, { uPer, vPer: 1 / 3.6, hard: true });
  const prof: P2[] = [];
  for (let i = 0; i <= 10; i++) {
    const e = (i / 10) * (Math.PI / 2);
    prof.push([Math.max(0.001, Math.cos(e) * R), ys + Math.sin(e) * R]);
  }
  copper.lathe(c.x, c.z, prof, 0, Math.PI * 2, 40, { uPer, vPer: 1 / 3.6 });
  // Brackets round the skirt.
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * Math.PI * 2 + 0.1;
    const rad: V3 = [Math.cos(t), 0, Math.sin(t)];
    const tang: V3 = [-Math.sin(t), 0, Math.cos(t)];
    const b = (s: number, d: number, y: number): V3 => [c.x + rad[0] * (R + d) + tang[0] * s, y, c.z + rad[2] * (R + d) + tang[2] * s];
    copper.face(b(-0.12, 0.2, y0 + 0.35), b(0.12, 0.2, y0 + 0.35), b(0.12, 0.2, ys - 0.15), b(-0.12, 0.2, ys - 0.15), rad, [0, 0], [0.1, 0], [0.1, 0.3], [0, 0.3]);
    copper.face(b(-0.12, 0, y0 + 0.35), b(-0.12, 0.2, y0 + 0.35), b(-0.12, 0.2, ys - 0.15), b(-0.12, 0, ys - 0.15), [-tang[0], 0, -tang[2]], [0, 0], [0.1, 0], [0.1, 0.3], [0, 0.3]);
    copper.face(b(0.12, 0, y0 + 0.35), b(0.12, 0.2, y0 + 0.35), b(0.12, 0.2, ys - 0.15), b(0.12, 0, ys - 0.15), tang, [0, 0], [0.1, 0], [0.1, 0.3], [0, 0.3]);
  }
  // Shutter frame: along the great circle through the zenith in the slit's bearing.
  const az = deg(slitBearing);
  const dir: V3 = [Math.sin(az), 0, -Math.cos(az)];
  const side: V3 = [Math.cos(az), 0, Math.sin(az)];
  /** Point on (or `lift` above) the sphere: β from the zenith toward `dir`, offset s along `side` (a small circle parallel to the slit's great circle). */
  const S = (beta: number, s: number, lift: number): V3 => {
    const k = Math.sqrt(Math.max(0, R * R - s * s));
    const sc = 1 + lift / R;
    return [c.x + (k * Math.sin(beta) * dir[0] + s * side[0]) * sc, ys + k * Math.cos(beta) * sc, c.z + (k * Math.sin(beta) * dir[2] + s * side[2]) * sc];
  };
  const steps = 14;
  const b0 = Math.PI / 2 - 0.02;
  const b1 = -0.32;
  if (open) {
    // The slit: lit interior seen through it, from the skirt top over the zenith.
    const w = 1.2;
    const sl = artRect("slit");
    for (let i = 0; i < steps; i++) {
      const ba = b0 + ((b1 - b0) * i) / steps;
      const bb = b0 + ((b1 - b0) * (i + 1)) / steps;
      const va = sl.v0 + ((sl.v1 - sl.v0) * i) / steps;
      const vb = sl.v0 + ((sl.v1 - sl.v0) * (i + 1)) / steps;
      const n = (beta: number): V3 => [dir[0] * Math.sin(beta), Math.cos(beta), dir[2] * Math.sin(beta)];
      art.quadN(S(ba, -w, 0.03), S(ba, w, 0.03), S(bb, w, 0.03), S(bb, -w, 0.03), n(ba), n(ba), n(bb), n(bb), [sl.u0, va], [sl.u1, va], [sl.u1, vb], [sl.u0, vb]);
    }
    // The slit through the skirt below it.
    const tA = Math.atan2(dir[2], dir[0]);
    const half = 1.2 / R;
    art.cyl(c.x, c.z, R + 0.03, y0 + 0.22, ys, tA - half, tA + half, 2, { atlas: sl });
    // Parted shutter leaves: two raised ribbed bands either side, higher over the zenith (p19).
    for (const sgn of [-1, 1]) shutterBand(copper, S, sgn * 1.25, sgn * 2.45, b0 * 0.55, b1 - 0.05, 0.38, steps);
  } else {
    shutterBand(copper, S, -1.3, 1.3, b0, b1, 0.1, steps);
  }
}

/** A raised band on the dome between offsets s0 and s1 along `side`, from β0 to β1, `lift` m proud, with its edges closed. */
function shutterBand(k: Kit, S: (beta: number, s: number, lift: number) => V3, s0: number, s1: number, beta0: number, beta1: number, lift: number, steps: number): void {
  const [a, b] = s0 < s1 ? [s0, s1] : [s1, s0];
  for (let i = 0; i < steps; i++) {
    const ba = beta0 + ((beta1 - beta0) * i) / steps;
    const bb = beta0 + ((beta1 - beta0) * (i + 1)) / steps;
    const up = (p: V3, q: V3): V3 => {
      const m: V3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      return m;
    };
    const top0 = S(ba, a, lift);
    const top1 = S(ba, b, lift);
    const top2 = S(bb, b, lift);
    const top3 = S(bb, a, lift);
    const mid = up(top0, top2);
    const base0 = S(ba, a, 0);
    const base3 = S(bb, a, 0);
    const base1 = S(ba, b, 0);
    const base2 = S(bb, b, 0);
    // Outward = away from the dome's centre (approximately the midpoint direction from below).
    const out: V3 = [mid[0] - (base0[0] + base2[0]) / 2, mid[1] - (base0[1] + base2[1]) / 2 + 0.001, mid[2] - (base0[2] + base2[2]) / 2];
    k.face(top0, top1, top2, top3, out, [a, i], [b, i], [b, i + 1], [a, i + 1]);
    // Side walls.
    const sa: V3 = [top0[0] - top1[0], 0, top0[2] - top1[2]];
    k.face(base0, top0, top3, base3, sa, [0, i], [0.2, i], [0.2, i + 1], [0, i + 1]);
    k.face(base1, top1, top2, base2, [-sa[0], 0, -sa[2]], [0, i], [0.2, i], [0.2, i + 1], [0, i + 1]);
  }
}

/**
 * Curved stair round a drum from the plaza (at θ = t0) to the deck (t1):
 * treads, a solid outer parapet rising with it, the wall under it to the
 * ground, and the inner face against the drum.
 */
function stair(K: Kits, lib: ObsLib, c: { x: number; z: number }, t0: number, t1: number): void {
  const wall = K.of(lib.wall());
  const deck = K.of(lib.deck());
  const ri = DOMES.drumR + 0.05;
  const ro = DOMES.drumR + 1.55;
  const y0 = LEVEL.plaza;
  const y1 = LEVEL.deck;
  const len = Math.abs(t1 - t0) * (ri + ro) * 0.5;
  const n = Math.max(8, Math.round((y1 - y0) / 0.16));
  const rise = (y1 - y0) / n;
  for (let i = 0; i < n; i++) {
    const ta = t0 + ((t1 - t0) * i) / n;
    const tb = t0 + ((t1 - t0) * (i + 1)) / n;
    const y = y0 + rise * (i + 1);
    // Tread and riser.
    deck.annulus(c.x, c.z, ri, ro, y, ta, tb, 1, 1);
    const P = (r: number, t: number, yy: number): V3 => [c.x + Math.cos(t) * r, yy, c.z + Math.sin(t) * r];
    const tn: V3 = [-Math.sin(ta) * Math.sign(t0 - t1), 0, Math.cos(ta) * Math.sign(t0 - t1)];
    wall.face(P(ri, ta, y - rise), P(ro, ta, y - rise), P(ro, ta, y), P(ri, ta, y), tn, [ri, y - rise], [ro, y - rise], [ro, y], [ri, y]);
  }
  // Outer wall from the ground up to the stair, then the parapet above it (sloping coping).
  const seg = Math.max(12, Math.round(len / 0.8));
  for (let i = 0; i < seg; i++) {
    const ta = t0 + ((t1 - t0) * i) / seg;
    const tb = t0 + ((t1 - t0) * (i + 1)) / seg;
    const ya = y0 + ((y1 - y0) * i) / seg;
    const yb = y0 + ((y1 - y0) * (i + 1)) / seg;
    const ga = groundY(c.x + Math.cos(ta) * ro, c.z + Math.sin(ta) * ro) - 0.4;
    const gb = groundY(c.x + Math.cos(tb) * ro, c.z + Math.sin(tb) * ro) - 0.4;
    const P = (r: number, t: number, yy: number): V3 => [c.x + Math.cos(t) * r, yy, c.z + Math.sin(t) * r];
    const na: V3 = [Math.cos(ta), 0, Math.sin(ta)];
    const nb: V3 = [Math.cos(tb), 0, Math.sin(tb)];
    const top = 1.0;
    wall.quadN(P(ro + 0.3, ta, ga), P(ro + 0.3, tb, gb), P(ro + 0.3, tb, yb + top), P(ro + 0.3, ta, ya + top), na, nb, nb, na, [ta * ro, ga], [tb * ro, gb], [tb * ro, yb + top], [ta * ro, ya + top]);
    wall.quadN(P(ro, tb, yb), P(ro, ta, ya), P(ro, ta, ya + top), P(ro, tb, yb + top), [-nb[0], 0, -nb[2]], [-na[0], 0, -na[2]], [-na[0], 0, -na[2]], [-nb[0], 0, -nb[2]], [0, yb], [1, ya], [1, ya + top], [0, yb + top]);
    wall.face(P(ro, ta, ya + top), P(ro + 0.3, ta, ya + top), P(ro + 0.3, tb, yb + top), P(ro, tb, yb + top), [0, 1, 0], [0, 0], [0.3, 0], [0.3, 1], [0, 1]);
  }
}

export function buildDomes(K: Kits, lib: ObsLib): DomeLights {
  const W = DOMES.west;
  const E = DOMES.east;
  // A tall bronze window on each drum's lawn side, level with the façade's (p04: lit at the east wing's curved end).
  const art = K.of(lib.art());
  for (const [c, t] of [
    [E, deg(-62)],
    [W, deg(-118)],
  ] as [{ x: number; z: number }, number][]) {
    const half = 0.8 / DOMES.drumR;
    art.cyl(c.x, c.z, DOMES.drumR + 0.012, 2.4, 5.6, t - half, t + half, 3, { atlas: artRect("window") });
  }
  // Exposed sides: the west drum from the façade's end round the west to the south-west, the east one likewise.
  drum(K, lib, W, [deg(-100), deg(-258)]);
  drum(K, lib, E, [deg(-80), deg(78)]);
  dome(K, lib, W, 205, false);
  dome(K, lib, E, SLIT_BEARING, true);
  stair(K, lib, W, deg(-104), deg(-250));
  stair(K, lib, E, deg(-50), deg(80));
  const wall = K.of(lib.wall());
  // Short parapet runs where the stairs land on the deck.
  parapet(wall, arc(W.x, W.z, DOMES.drumR + 1.85, deg(-250), deg(-262), 3), false, LEVEL.deck, 1);
  const az = deg(SLIT_BEARING);
  const dir: V3 = [Math.sin(az), 0, -Math.cos(az)];
  const washers: { pos: V3; aim: V3 }[] = [];
  for (const [c, t] of [
    [W, deg(-160)],
    [W, deg(-200)],
    [E, deg(-20)],
    [E, deg(20)],
  ] as [{ x: number; z: number }, number][]) {
    const r = DOMES.drumR + 2.2;
    const x = c.x + Math.cos(t) * r;
    const z = c.z + Math.sin(t) * r;
    washers.push({ pos: [x, groundY(x, z) + 0.15, z], aim: [c.x + Math.cos(t) * DOMES.drumR, 6.5, c.z + Math.sin(t) * DOMES.drumR] });
  }
  return {
    slit: { pos: [E.x + dir[0] * 1.2, DOMES.skirtTop + 1.4, E.z + dir[2] * 1.2], dir },
    washers,
  };
}
