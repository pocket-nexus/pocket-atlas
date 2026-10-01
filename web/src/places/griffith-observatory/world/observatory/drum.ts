import { artRect } from "../../gfx/observatory-art";
import type { ObsLib } from "../../gfx/observatory-materials";
import { groundY } from "../dem";
import { arc, Kits, type Kit, type P2, type V3 } from "./kit";
import { DRUM, LEVEL, drumOpen } from "./plan";
import { parapet } from "./block";

/**
 * The planetarium drum and dome (p01, p03, p09, p14, p17, p23).
 *
 * Lower drum: 16 bays round a 15.3 m radius, fluted pilasters 0.45 m proud,
 * two rows of small bronze-grille windows, a Greek-key frieze and cornice
 * under the promenade parapet; on the south it falls ~20 m to the hillside.
 * Promenade: the roof deck runs round the upper drum, crossed at every
 * pilaster by a transverse wall with a round-headed arch (p23). Upper drum:
 * radius 13.0, a recessed fluted panel under a row of small arches in each
 * bay (p09), stepped pilasters rising 1 m above the cornice as blocks (p03,
 * p17). The copper dome is a hemisphere of 12.9 m whose apex is the lidar
 * roof top (371.0 m ASL), with a small crown vent.
 */

const D = LEVEL.deck;
const CX = DRUM.x;
const CZ = DRUM.z;
const KEY = [7.25, 7.61] as const;
const CORN = [7.75, 8.25] as const;
const UP_CORN = [14.0, 14.3] as const;
const PANEL = [9.9, 13.3] as const;
const ARCH = { spring: D + 2.4, top: D + 4.0 };

export interface DrumLights {
  /** Foot of each exposed lower-drum pilaster (θ, ground y). */
  lower: { t: number; y: number }[];
  /** Every upper-drum pilaster (θ) and the height its uplight sits at. */
  upper: { t: number; y: number }[];
}

const P = (r: number, t: number, y: number): V3 => [CX + Math.cos(t) * r, y, CZ + Math.sin(t) * r];

/** Pilaster angles: one on the south axis, 22.5° apart. */
function pilasterAngles(): number[] {
  return Array.from({ length: DRUM.bays }, (_, k) => DRUM.phase + (k * 2 * Math.PI) / DRUM.bays);
}

const inOpen = (t: number, [a0, a1]: [number, number], pad = 0): boolean => {
  const u = ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return u >= a0 + pad && u <= a1 - pad;
};

/**
 * A pilaster on a curved wall: a box-like fin from radius r0 out to r0 + d,
 * `w` wide (m), between y0 and y1, its face carrying the flutes cell.
 */
function roundPilaster(wall: Kit, art: Kit, r0: number, d: number, t: number, w: number, y0: number, y1: number, sv: number): void {
  const tang: V3 = [-Math.sin(t), 0, Math.cos(t)];
  const rad: V3 = [Math.cos(t), 0, Math.sin(t)];
  // Sides run radially from the wall to the face (a fin with parallel sides).
  const side = (s: number): [V3, V3] => {
    const a: V3 = [CX + Math.cos(t) * r0 + tang[0] * s, 0, CZ + Math.sin(t) * r0 + tang[2] * s];
    const b: V3 = [a[0] + rad[0] * d, 0, a[2] + rad[2] * d];
    return [a, b];
  };
  for (const s of [-w / 2, w / 2]) {
    const [a, b] = side(s);
    const n: V3 = [tang[0] * Math.sign(s), 0, tang[2] * Math.sign(s)];
    for (let j = 0; j < sv; j++) {
      const h0 = y0 + ((y1 - y0) * j) / sv;
      const h1 = y0 + ((y1 - y0) * (j + 1)) / sv;
      wall.quad([a[0], h0, a[2]], [b[0], h0, b[2]], [b[0], h1, b[2]], [a[0], h1, a[2]], n, [0, h0], [d, h0], [d, h1], [0, h1]);
    }
  }
  // Face (flat, flutes cell), strips for the light fans.
  const at = artRect("flutes");
  const [, fl] = side(-w / 2);
  const [, fr] = side(w / 2);
  for (let j = 0; j < sv; j++) {
    const h0 = y0 + ((y1 - y0) * j) / sv;
    const h1 = y0 + ((y1 - y0) * (j + 1)) / sv;
    const v0 = at.v0 + ((at.v1 - at.v0) * j) / sv;
    const v1 = at.v0 + ((at.v1 - at.v0) * (j + 1)) / sv;
    art.quad([fl[0], h0, fl[2]], [fr[0], h0, fr[2]], [fr[0], h1, fr[2]], [fl[0], h1, fl[2]], rad, [at.u0, v0], [at.u1, v0], [at.u1, v1], [at.u0, v1]);
  }
}

/** A small block cap on a pilaster top (projecting 5 cm all round). */
function cap(wall: Kit, r0: number, d: number, t: number, w: number, y0: number, y1: number): void {
  const tang: V3 = [-Math.sin(t), 0, Math.cos(t)];
  const rad: V3 = [Math.cos(t), 0, Math.sin(t)];
  const c: V3 = [CX + rad[0] * (r0 + d / 2), 0, CZ + rad[2] * (r0 + d / 2)];
  const hw = w / 2 + 0.05;
  const hd = d / 2 + 0.05;
  const corner = (a: number, b: number, y: number): V3 => [c[0] + tang[0] * a + rad[0] * b, y, c[2] + tang[2] * a + rad[2] * b];
  const quads: [number, number, number, number, V3][] = [
    [-hw, hd, hw, hd, rad],
    [hw, -hd, -hw, -hd, [-rad[0], 0, -rad[2]]],
    [-hw, -hd, -hw, hd, [-tang[0], 0, -tang[2]]],
    [hw, hd, hw, -hd, tang],
  ];
  for (const [a0, b0, a1, b1, n] of quads) wall.face(corner(a0, b0, y0), corner(a1, b1, y0), corner(a1, b1, y1), corner(a0, b0, y1), n, [0, y0], [1, y0], [1, y1], [0, y1]);
  wall.face(corner(-hw, -hd, y1), corner(hw, -hd, y1), corner(hw, hd, y1), corner(-hw, hd, y1), [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
}

/** Curved Greek-key band at radius r over [a0, a1]: one quad per motif pair. */
function keyArc(art: Kit, r: number, a0: number, a1: number, y0: number, y1: number): void {
  const n = Math.max(1, Math.round(((a1 - a0) * r) / 1.44));
  const at = artRect("key");
  for (let i = 0; i < n; i++) {
    const t0 = a0 + ((a1 - a0) * i) / n;
    const t1 = a0 + ((a1 - a0) * (i + 1)) / n;
    const n0: V3 = [Math.cos(t0), 0, Math.sin(t0)];
    const n1: V3 = [Math.cos(t1), 0, Math.sin(t1)];
    art.quadN(P(r, t0, y0), P(r, t1, y0), P(r, t1, y1), P(r, t0, y1), n0, n1, n1, n0, [at.u0, at.v0], [at.u1, at.v0], [at.u1, at.v1], [at.u0, at.v1]);
  }
}

/** Moulded cornice ring at radius r over [a0, a1]. */
function corniceArc(wall: Kit, r: number, a0: number, a1: number, y0: number, y1: number, p = 0.3, seg = 64): void {
  const h = y1 - y0;
  wall.lathe(
    CX,
    CZ,
    [
      [r, y0],
      [r + p * 0.35, y0 + h * 0.15],
      [r + p * 0.45, y0 + h * 0.4],
      [r + p, y0 + h * 0.62],
      [r + p, y1],
    ],
    a0,
    a1,
    seg,
    { hard: true },
  );
  wall.annulus(CX, CZ, r - 0.01, r + p, y1, a0, a1, seg, 1);
}

/**
 * Transverse wall across the promenade at angle t, from the pilaster face
 * (r0) to the outer parapet (r1), with a round-headed arch (p23).
 */
function archWall(wall: Kit, art: Kit, t: number, r0: number, r1: number): void {
  const th = 0.6;
  const tang: V3 = [-Math.sin(t), 0, Math.cos(t)];
  const rad: V3 = [Math.cos(t), 0, Math.sin(t)];
  const at = (r: number, s: number, y: number): V3 => [CX + rad[0] * r + tang[0] * s, y, CZ + rad[2] * r + tang[2] * s];
  const o0 = r0 + 0.14;
  const o1 = r1 - 0.14;
  const ar = (o1 - o0) / 2;
  const om = (o0 + o1) / 2;
  const segs = 8;
  // Arch outline (in r, y): up the inner jamb, over the semicircle, down the outer jamb.
  const hole: P2[] = [[o0, D]];
  for (let i = 0; i <= segs; i++) {
    const a = Math.PI - (i / segs) * Math.PI;
    hole.push([om + Math.cos(a) * ar, ARCH.spring + Math.sin(a) * ar]);
  }
  hole.push([o1, D]);
  const top = ARCH.top;
  // Both faces: the wall area above and beside the arch, as strips between the outline and the top.
  for (const s of [-th / 2, th / 2]) {
    const n: V3 = [tang[0] * Math.sign(s), 0, tang[2] * Math.sign(s)];
    // Jambs.
    wall.face(at(r0, s, D), at(o0, s, D), at(o0, s, top), at(r0, s, top), n, [r0, D], [o0, D], [o0, top], [r0, top]);
    wall.face(at(o1, s, D), at(r1, s, D), at(r1, s, top), at(o1, s, top), n, [o1, D], [r1, D], [r1, top], [o1, top]);
    // Over the arch.
    for (let i = 1; i + 1 < hole.length - 1; i++) {
      const [ra, ya] = hole[i];
      const [rb, yb] = hole[i + 1];
      wall.face(at(ra, s, ya), at(rb, s, yb), at(rb, s, top), at(ra, s, top), n, [ra, ya], [rb, yb], [rb, top], [ra, top]);
    }
  }
  // Intrados (the arch's underside) and the jamb faces, shaded.
  wall.shade = 0.75;
  for (let i = 0; i + 1 < hole.length; i++) {
    const [ra, ya] = hole[i];
    const [rb, yb] = hole[i + 1];
    const mr = (ra + rb) / 2 - om;
    const my = (ya + yb) / 2 - ARCH.spring;
    const out: V3 = [-rad[0] * mr, -Math.max(0, my), -rad[2] * mr];
    wall.face(at(ra, -th / 2, ya), at(rb, -th / 2, yb), at(rb, th / 2, yb), at(ra, th / 2, ya), i === 0 || i === hole.length - 2 ? [-rad[0] * Math.sign(mr), 0, -rad[2] * Math.sign(mr)] : out, [0, ya], [1, yb], [1, yb], [0, ya]);
  }
  wall.shade = 1;
  // Top with a cap, and a Greek-key band on both faces just under it.
  wall.face(at(r0, -th / 2 - 0.05, top), at(r1 + 0.05, -th / 2 - 0.05, top), at(r1 + 0.05, th / 2 + 0.05, top), at(r0, th / 2 + 0.05, top), [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  wall.face(at(r1, -th / 2, D - 0.3), at(r1, th / 2, D - 0.3), at(r1, th / 2, top), at(r1, -th / 2, top), rad, [0, D], [1, D], [1, top], [0, top]);
  const k = artRect("key");
  for (const s of [-th / 2 - 0.01, th / 2 + 0.01]) {
    const n: V3 = [tang[0] * Math.sign(s), 0, tang[2] * Math.sign(s)];
    art.quad(at(r0, s, top - 0.6), at(r1, s, top - 0.6), at(r1, s, top - 0.24), at(r0, s, top - 0.24), n, [k.u0, k.v0], [k.u1, k.v0], [k.u1, k.v1], [k.u0, k.v1]);
  }
}

export function buildDrum(K: Kits, lib: ObsLib): DrumLights {
  const wall = K.of(lib.wall());
  const art = K.of(lib.art());
  const copper = K.of(lib.copper());
  const open = drumOpen();
  const [a0, a1] = open;
  const R = DRUM.r;
  const lights: DrumLights = { lower: [], upper: [] };

  // ---------------------------------------------------------------- lower drum
  const facet = (2.5 * Math.PI) / 180;
  const nf = Math.ceil((a1 - a0) / facet);
  for (let i = 0; i < nf; i++) {
    const t0 = a0 + ((a1 - a0) * i) / nf;
    const t1 = a0 + ((a1 - a0) * (i + 1)) / nf;
    const g = Math.min(groundY(CX + Math.cos(t0) * (R + 0.6), CZ + Math.sin(t0) * (R + 0.6)), groundY(CX + Math.cos(t1) * (R + 0.6), CZ + Math.sin(t1) * (R + 0.6)));
    const y0 = g - 0.6;
    wall.cyl(CX, CZ, R, y0, CORN[1], t0, t1, 1, { sv: Math.max(2, Math.ceil((CORN[1] - y0) / 1.3)) });
  }
  keyArc(art, R + 0.02, a0, a1, KEY[0], KEY[1]);
  corniceArc(wall, R, a0, a1, CORN[0], CORN[1], 0.3, nf);
  parapet(wall, arc(CX, CZ, R, a0, a1, nf), false, D, 1, LEVEL.parapet, 0.32);

  const angles = pilasterAngles();
  for (const t of angles) {
    if (!inOpen(t, open, 0.06)) continue;
    const gx = CX + Math.cos(t) * (R + 1.2);
    const gz = CZ + Math.sin(t) * (R + 1.2);
    const g = groundY(gx, gz);
    const y0 = g - 0.5;
    const y1 = D + LEVEL.parapet + 0.25;
    roundPilaster(wall, art, R, 0.45, t, 1.4, y0, y1, Math.max(4, Math.ceil((y1 - y0) / 0.7)));
    cap(wall, R, 0.45, t, 1.4, y1, y1 + 0.18);
    lights.lower.push({ t, y: g });
  }
  // Two rows of small windows in each bay where the drum stands clear of the hill.
  for (const t of angles) {
    const tb = t + Math.PI / DRUM.bays;
    if (!inOpen(tb, open, 0.12)) continue;
    const g = groundY(CX + Math.cos(tb) * (R + 1), CZ + Math.sin(tb) * (R + 1));
    const rows: [number, number, boolean][] = [
      [4.3, 5.8, true],
      [0.2, 1.7, false],
      [-3.9, -2.4, true],
    ];
    for (const [y0, y1, lit] of rows) {
      if (y0 < g + 0.6) continue;
      const half = 0.55 / R;
      wall.shade = 1;
      art.cyl(CX, CZ, R + 0.015, y0, y1, tb - half, tb + half, 1, { atlas: artRect(lit && Math.sin(tb * 7) > -0.4 ? "drumWin" : "drumDark") });
    }
  }

  // ---------------------------------------------------------------- upper drum
  const ru = DRUM.rUpper;
  const bay = (2 * Math.PI) / DRUM.bays;
  const pw = 3.4 / ru;
  for (const t of angles) {
    const b0 = t;
    const b1 = t + bay;
    const pm = t + bay / 2;
    const p0 = pm - pw / 2;
    const p1 = pm + pw / 2;
    wall.cyl(CX, CZ, ru, D - 0.2, UP_CORN[1], b0, p0, 2, { sv: 6 });
    wall.cyl(CX, CZ, ru, D - 0.2, UP_CORN[1], p1, b1, 2, { sv: 6 });
    wall.cyl(CX, CZ, ru, D - 0.2, PANEL[0], p0, p1, 4, { sv: 1 });
    wall.cyl(CX, CZ, ru, PANEL[1], UP_CORN[1], p0, p1, 4, { sv: 1 });
    art.cyl(CX, CZ, ru, PANEL[0], PANEL[1], p0, p1, 4, { atlas: artRect("panel") });
  }
  corniceArc(wall, ru, 0, Math.PI * 2, UP_CORN[0], UP_CORN[1], 0.3, 96);
  // Ring roof between the cornice and the dome.
  const domeC = DRUM.domeTop - DRUM.domeR;
  const rAt = Math.sqrt(DRUM.domeR ** 2 - (UP_CORN[1] - domeC) ** 2);
  wall.shade = 0.85;
  wall.annulus(CX, CZ, rAt - 0.05, ru + 0.02, UP_CORN[1] + 0.005, 0, Math.PI * 2, 96, 1);
  wall.shade = 1;
  // Stepped pilasters: a broad fin and a narrower face fin, blocks above the cornice.
  for (const t of angles) {
    roundPilaster(wall, art, ru, 0.5, t, 1.6, D - 0.2, UP_CORN[0], 8);
    roundPilaster(wall, art, ru + 0.5, 0.18, t, 0.8, D - 0.2, UP_CORN[1] + 0.85, 9);
    cap(wall, ru + 0.05, 0.6, t, 1.2, UP_CORN[1] + 0.85, UP_CORN[1] + 1.05);
    const onPromenade = inOpen(t, open, 0.06);
    lights.upper.push({ t, y: onPromenade ? ARCH.top + 0.1 : D + 0.1 });
    if (onPromenade) archWall(wall, art, t, ru + 0.68, R - 0.32);
  }

  // ---------------------------------------------------------------- dome
  const prof: P2[] = [];
  const n = 16;
  const e0 = Math.asin((UP_CORN[1] - 0.15 - domeC) / DRUM.domeR);
  for (let i = 0; i <= n; i++) {
    const e = e0 + ((Math.PI / 2 - e0) * i) / n;
    prof.push([Math.cos(e) * DRUM.domeR, domeC + Math.sin(e) * DRUM.domeR]);
  }
  prof[n] = [0.001, DRUM.domeTop];
  copper.lathe(CX, CZ, prof, 0, Math.PI * 2, 72, { uPer: 16 / (2 * Math.PI), vPer: 1 / 5 });
  // Crown vent (p17): a short drum and a cap.
  copper.lathe(
    CX,
    CZ,
    [
      [0.9, DRUM.domeTop - 0.05],
      [0.75, DRUM.domeTop + 0.3],
      [0.85, DRUM.domeTop + 0.35],
      [0.6, DRUM.domeTop + 0.55],
      [0.001, DRUM.domeTop + 0.62],
    ],
    0,
    Math.PI * 2,
    16,
    { hard: true },
  );
  return lights;
}

/** World position on the drum (for the light builders). */
export function drumPoint(r: number, t: number, y: number): V3 {
  return P(r, t, y);
}
