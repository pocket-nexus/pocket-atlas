import { artRect } from "../../gfx/observatory-art";
import { LEAF, type LeafCell } from "../../gfx/observatory-foliage";
import type { ObsLib } from "../../gfx/observatory-materials";
import { Rng } from "../../../../core/random";
import { groundY } from "../dem";
import { deg, type Kit, type Kits, type P2, type V3 } from "./kit";

/**
 * Props of the grounds, built into material kits: the Art Deco lamp posts,
 * the Astronomers Monument, the James Dean bust, pipe railings, coin-op
 * binocular viewers, planters, and the planting (Italian cypresses,
 * chaparral shrubs, oaks, pines, yucca, agave, dry grass) as leaf cards.
 */

// ------------------------------------------------------------------ lamps

/** Lamp post height to the globe's centre (est. ~4 m, p04, p05, p21). */
export const LAMP_H = 3.9;
export const GLOBE_R = 0.24;

/**
 * Art Deco lamp post: square plinth, fluted round shaft with a ringed collar
 * and capital, white glass globe with a small finial (p04, p05, p21).
 */
export function lampPost(K: Kits, lib: ObsLib, x: number, z: number, globe: Kit): V3 {
  const wall = K.of(lib.wall());
  const steel = K.of(lib.steel());
  const y = groundY(x, z);
  wall.box(x - 0.24, x + 0.24, y - 0.2, y + 0.5, z - 0.24, z + 0.24, "ny");
  wall.box(x - 0.2, x + 0.2, y + 0.5, y + 0.62, z - 0.2, z + 0.2, "ny");
  // Fluted shaft: 16 facets with every other one set back (reads as flutes under the light).
  // Twelve facets read as flutes under the grazing lamp light.
  const prof: P2[] = [
    [0.16, y + 0.62],
    [0.12, y + 0.84],
    [0.105, y + 3.2],
    [0.14, y + 3.32],
    [0.1, y + 3.42],
    [0.17, y + 3.6],
  ];
  wall.lathe(x, z, prof, 0, Math.PI * 2, 12, { hard: true });
  steel.lathe(x, z, [[0.13, y + 3.6], [0.13, y + LAMP_H - GLOBE_R * 0.8]], 0, Math.PI * 2, 8, { hard: true });
  const g: P2[] = [];
  for (let i = 0; i <= 5; i++) {
    const e = -Math.PI / 2 + (i / 5) * Math.PI;
    g.push([Math.max(0.001, Math.cos(e) * GLOBE_R), y + LAMP_H + Math.sin(e) * GLOBE_R]);
  }
  globe.lathe(x, z, g, 0, Math.PI * 2, 8);
  steel.lathe(x, z, [[0.05, y + LAMP_H + GLOBE_R - 0.02], [0.001, y + LAMP_H + GLOBE_R + 0.2]], 0, Math.PI * 2, 5, { hard: true });
  return [x, y + LAMP_H, z];
}

// ------------------------------------------------------------------ monument

/**
 * The Astronomers Monument (1934, PWAP): a 11.4 m concrete shaft on a
 * stepped base in a planted ring, six astronomers (Hipparchus, Copernicus,
 * Galileo, Kepler, Newton, Herschel) in relief round its foot, an armillary
 * sphere (30 in) on top. Plan est. hexagonal from p21; heights est.
 */
export function monument(K: Kits, lib: ObsLib, x: number, z: number): { top: V3; base: number } {
  const wall = K.of(lib.wall());
  const art = K.of(lib.art());
  const bronze = K.of(lib.bronze());
  const y = groundY(x, z) + 0.05;
  const hex = (r: number, y0: number, y1: number, r1 = r) => {
    wall.lathe(x, z, [[r, y0], [r1, y1]], deg(30), deg(390), 6, { hard: true });
    return y1;
  };
  hex(2.6, y - 0.3, y + 0.35);
  wall.lathe(x, z, [[2.6, y + 0.35], [2.25, y + 0.35]], deg(30), deg(390), 6, { hard: true });
  hex(2.25, y + 0.35, y + 0.7);
  wall.lathe(x, z, [[2.25, y + 0.7], [1.75, y + 0.7]], deg(30), deg(390), 6, { hard: true });
  // Pedestal with the figures on its six faces.
  const p0 = y + 0.7;
  const p1 = y + 3.6;
  hex(1.75, p0, p1, 1.6);
  for (let i = 0; i < 6; i++) {
    const t = deg(60 * i);
    const rr = 1.68 * Math.cos(deg(30)) + 0.06;
    const nx = Math.cos(t);
    const nz = Math.sin(t);
    const cx = x + nx * rr;
    const cz = z + nz * rr;
    const at = artRect(i % 2 ? "astro2" : "astro");
    const rx = nz;
    const rz = -nx;
    const w = 1.05;
    const P = (s: number, yy: number): V3 => [cx + rx * s, yy, cz + rz * s];
    art.quad(P(-w / 2, p0 + 0.15), P(w / 2, p0 + 0.15), P(w / 2, p1 - 0.1), P(-w / 2, p1 - 0.1), [nx, 0.05, nz], [at.u0, at.v0], [at.u1, at.v0], [at.u1, at.v1], [at.u0, at.v1]);
  }
  wall.lathe(x, z, [[1.6, p1], [1.75, p1 + 0.15], [1.75, p1 + 0.3], [1.15, p1 + 0.35]], deg(30), deg(390), 6, { hard: true });
  // Shaft tapering to a pyramidion.
  const s1 = y + 10.7;
  wall.lathe(x, z, [[1.1, p1 + 0.35], [0.62, s1], [0.68, s1 + 0.08], [0.001, s1 + 0.55]], deg(30), deg(390), 6, { hard: true });
  // Armillary sphere: three bronze rings and a polar rod on a short stem.
  const cy = s1 + 0.95;
  const R = 0.38;
  bronze.lathe(x, z, [[0.06, s1 + 0.45], [0.04, cy - R]], 0, Math.PI * 2, 6, { hard: true });
  const ring = (axis: "y" | "x" | "t", tilt: number) => {
    const n = 20;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const P = (a: number, r: number): V3 => {
        const u = Math.cos(a) * r;
        const v = Math.sin(a) * r;
        if (axis === "y") return [x + u, cy, z + v];
        if (axis === "x") return [x, cy + u, z + v];
        return [x + u * Math.cos(tilt), cy + u * Math.sin(tilt), z + v];
      };
      const c0 = P(a0, R);
      const c1 = P(a1, R);
      const d0 = P(a0, R - 0.05);
      const d1 = P(a1, R - 0.05);
      const out: V3 = [(c0[0] + c1[0]) / 2 - x, (c0[1] + c1[1]) / 2 - cy, (c0[2] + c1[2]) / 2 - z];
      bronze.face(d0, c0, c1, d1, axis === "y" ? [0, 1, 0] : out, [0, 0], [1, 0], [1, 1], [0, 1]);
      bronze.face(d0, c0, c1, d1, axis === "y" ? [0, -1, 0] : [-out[0], -out[1], -out[2]], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  };
  ring("y", 0);
  ring("x", 0);
  ring("t", deg(23.4));
  return { top: [x, cy, z], base: y };
}

/** James Dean bust (Kenneth Kendall, 1988): bronze on a concrete pedestal (OSM node 6725257273). */
export function bust(K: Kits, lib: ObsLib, x: number, z: number, facing: number): void {
  const wall = K.of(lib.wall());
  const bronze = K.of(lib.bronze());
  const y = groundY(x, z);
  wall.box(x - 0.42, x + 0.42, y - 0.2, y + 0.2, z - 0.42, z + 0.42, "ny");
  wall.box(x - 0.3, x + 0.3, y + 0.2, y + 1.35, z - 0.3, z + 0.3, "ny");
  wall.box(x - 0.36, x + 0.36, y + 1.35, y + 1.45, z - 0.36, z + 0.36, "ny");
  // Shoulders and chest, neck, head (a slightly forward-set ovoid).
  const fx = Math.sin(facing) * 0.04;
  const fz = -Math.cos(facing) * 0.04;
  bronze.lathe(x, z, [[0.2, y + 1.45], [0.27, y + 1.6], [0.25, y + 1.78], [0.1, y + 1.86]], 0, Math.PI * 2, 10);
  bronze.lathe(x + fx, z + fz, [[0.06, y + 1.84], [0.06, y + 1.93], [0.1, y + 1.98], [0.11, y + 2.08], [0.1, y + 2.17], [0.06, y + 2.23], [0.001, y + 2.25]], 0, Math.PI * 2, 10);
}

// ------------------------------------------------------------------ railings

/** Pipe railing along a polyline on the ground (posts every ~2 m, top and mid rails), on a low kerb wall if `kerb` > 0. */
export function railing(K: Kits, lib: ObsLib, line: P2[], opts: { kerb?: number; height?: number; base?: (x: number, z: number) => number } = {}): void {
  const steel = K.of(lib.steel());
  const wall = K.of(lib.wall());
  const kerb = opts.kerb ?? 0;
  const H = opts.height ?? 1.07;
  const base = opts.base ?? groundY;
  const r = 0.025;
  const pipe = (a: V3, b: V3) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    // Square section turned to the segment (4 faces): enough for 5 cm pipe.
    const ux = -dz / Math.hypot(dx, dz || 1e-6);
    const uz = dx / Math.hypot(dx, dz || 1e-6);
    const side: V3 = Math.abs(dy) > 0.9 * l ? [r, 0, 0] : [ux * r, 0, uz * r];
    const upv: V3 = Math.abs(dy) > 0.9 * l ? [0, 0, r] : [0, r, 0];
    for (const [s, u] of [
      [side, upv],
      [upv, [-side[0], -side[1], -side[2]] as V3],
      [[-side[0], -side[1], -side[2]] as V3, [-upv[0], -upv[1], -upv[2]] as V3],
      [[-upv[0], -upv[1], -upv[2]] as V3, side],
    ] as [V3, V3][]) {
      const p0: V3 = [a[0] + s[0], a[1] + s[1], a[2] + s[2]];
      const p1: V3 = [b[0] + s[0], b[1] + s[1], b[2] + s[2]];
      const p2: V3 = [b[0] + u[0], b[1] + u[1], b[2] + u[2]];
      const p3: V3 = [a[0] + u[0], a[1] + u[1], a[2] + u[2]];
      steel.face(p0, p1, p2, p3, [s[0] + u[0], s[1] + u[1], s[2] + u[2]], [0, 0], [l, 0], [l, 1], [0, 1]);
    }
  };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / 2.2));
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const t1 = (k + 1) / n;
      const p0: P2 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1: P2 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      const y0 = base(p0[0], p0[1]) + kerb;
      const y1 = base(p1[0], p1[1]) + kerb;
      if (kerb > 0) {
        const g0 = groundY(p0[0], p0[1]) - 0.2;
        const g1 = groundY(p1[0], p1[1]) - 0.2;
        const dx = (p1[0] - p0[0]) / (len / n);
        const dz = (p1[1] - p0[1]) / (len / n);
        const ox = -dz * 0.15;
        const oz = dx * 0.15;
        for (const sgn of [-1, 1]) {
          wall.face([p0[0] + ox * sgn, g0, p0[1] + oz * sgn], [p1[0] + ox * sgn, g1, p1[1] + oz * sgn], [p1[0] + ox * sgn, y1, p1[1] + oz * sgn], [p0[0] + ox * sgn, y0, p0[1] + oz * sgn], [ox * sgn, 0, oz * sgn], [0, g0], [1, g1], [1, y1], [0, y0]);
        }
        wall.face([p0[0] - ox, y0, p0[1] - oz], [p1[0] - ox, y1, p1[1] - oz], [p1[0] + ox, y1, p1[1] + oz], [p0[0] + ox, y0, p0[1] + oz], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
      }
      pipe([p0[0], y0, p0[1]], [p0[0], y0 + H, p0[1]]);
      pipe([p0[0], y0 + H, p0[1]], [p1[0], y1 + H, p1[1]]);
      pipe([p0[0], y0 + H * 0.5, p0[1]], [p1[0], y1 + H * 0.5, p1[1]]);
    }
    if (i + 2 === line.length) {
      const y = base(b[0], b[1]) + kerb;
      pipe([b[0], y, b[1]], [b[0], y + H, b[1]]);
    }
  }
}

/**
 * A solid parapet on a retaining wall that follows the ground along a
 * polyline (the loading road's outer wall, the service yard's edge; p14,
 * p17): its face runs `drop` m down the slope side, 1 m above the walk.
 */
export function groundParapet(K: Kits, lib: ObsLib, line: P2[], drop = 2.5): void {
  const wall = K.of(lib.wall());
  const t = 0.3;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / 3));
    const dx = (b[0] - a[0]) / len;
    const dz = (b[1] - a[1]) / len;
    const ox = -dz * t * 0.5;
    const oz = dx * t * 0.5;
    for (let k = 0; k < n; k++) {
      const p0: P2 = [a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)];
      const p1: P2 = [a[0] + (b[0] - a[0]) * ((k + 1) / n), a[1] + (b[1] - a[1]) * ((k + 1) / n)];
      const g0 = groundY(p0[0], p0[1]);
      const g1 = groundY(p1[0], p1[1]);
      const top0 = g0 + 1.0;
      const top1 = g1 + 1.0;
      for (const s of [-1, 1]) {
        const d0 = s < 0 ? g0 - drop : g0 - 0.3;
        const d1 = s < 0 ? g1 - drop : g1 - 0.3;
        wall.face([p0[0] + ox * s, d0, p0[1] + oz * s], [p1[0] + ox * s, d1, p1[1] + oz * s], [p1[0] + ox * s, top1, p1[1] + oz * s], [p0[0] + ox * s, top0, p0[1] + oz * s], [ox * s, 0, oz * s], [0, d0], [len / n, d1], [len / n, top1], [0, top0]);
      }
      wall.face([p0[0] - ox * 1.2, top0, p0[1] - oz * 1.2], [p1[0] - ox * 1.2, top1, p1[1] - oz * 1.2], [p1[0] + ox * 1.2, top1, p1[1] + oz * 1.2], [p0[0] + ox * 1.2, top0, p0[1] + oz * 1.2], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }
}

/** Coin-op binocular viewer on a post (p14, p15, p23), facing `bearing` (deg). */
export function binoculars(K: Kits, lib: ObsLib, x: number, y: number, z: number, bearing: number): void {
  const steel = K.of(lib.steel());
  steel.lathe(x, z, [[0.09, y], [0.07, y + 0.12], [0.05, y + 0.14], [0.05, y + 1.05], [0.08, y + 1.1]], 0, Math.PI * 2, 8, { hard: true });
  const a = deg(bearing);
  const fx = Math.sin(a);
  const fz = -Math.cos(a);
  const rx = Math.cos(a);
  const rz = Math.sin(a);
  // Head: a box body with two short barrels toward the view.
  const c: V3 = [x, y + 1.25, z];
  const B = (f: number, s: number, h: number): V3 => [c[0] + fx * f + rx * s, c[1] + h, c[2] + fz * f + rz * s];
  const quads: [V3, V3, V3, V3, V3][] = [
    [B(0.18, -0.2, -0.14), B(0.18, 0.2, -0.14), B(0.18, 0.2, 0.14), B(0.18, -0.2, 0.14), [fx, 0, fz]],
    [B(-0.18, 0.2, -0.14), B(-0.18, -0.2, -0.14), B(-0.18, -0.2, 0.14), B(-0.18, 0.2, 0.14), [-fx, 0, -fz]],
    [B(-0.18, -0.2, 0.14), B(0.18, -0.2, 0.14), B(0.18, 0.2, 0.14), B(-0.18, 0.2, 0.14), [0, 1, 0]],
    [B(-0.18, -0.2, -0.14), B(0.18, -0.2, -0.14), B(0.18, -0.2, 0.14), B(-0.18, -0.2, 0.14), [-rx, 0, -rz]],
    [B(0.18, 0.2, -0.14), B(-0.18, 0.2, -0.14), B(-0.18, 0.2, 0.14), B(0.18, 0.2, 0.14), [rx, 0, rz]],
  ];
  for (const [p0, p1, p2, p3, n] of quads) steel.face(p0, p1, p2, p3, n, [0, 0], [1, 0], [1, 1], [0, 1]);
}

// ------------------------------------------------------------------ planting

/** A leaf card: a quad of `w` × `h` at `p` (bottom centre), turned to azimuth `a`, tilted back by `tilt`. */
function card(k: Kit, cell: LeafCell, p: V3, w: number, h: number, a: number, tilt = 0, flip = false): void {
  const at = LEAF[cell];
  const rx = Math.cos(a);
  const rz = Math.sin(a);
  const nx = -rz;
  const nz = rx;
  const up: V3 = [nx * Math.sin(tilt), Math.cos(tilt), nz * Math.sin(tilt)];
  const P = (s: number, t: number): V3 => [p[0] + rx * s * w + up[0] * t * h, p[1] + up[1] * t * h, p[2] + rz * s * w + up[2] * t * h];
  const [u0, u1] = flip ? [at.u1, at.u0] : [at.u0, at.u1];
  k.quad(P(-0.5, 0), P(0.5, 0), P(0.5, 1), P(-0.5, 1), [nx, 0.35, nz], [u0, at.v0], [u1, at.v0], [u1, at.v1], [u0, at.v1]);
}

/** A flat card facing up (crown tops, ground litter). */
function topCard(k: Kit, cell: LeafCell, p: V3, s: number, a: number): void {
  const at = LEAF[cell];
  const c = Math.cos(a) * s * 0.5;
  const d = Math.sin(a) * s * 0.5;
  k.quad([p[0] - c + d, p[1], p[2] - d - c], [p[0] + c + d, p[1], p[2] + d - c], [p[0] + c - d, p[1], p[2] + d + c], [p[0] - c - d, p[1], p[2] - d + c], [0, 1, 0], [at.u0, at.v0], [at.u1, at.v0], [at.u1, at.v1], [at.u0, at.v1]);
}

/** Italian cypress: a narrow flame of crossed cypress cards round a dark core (p02, p04, p05). */
export function cypress(K: Kits, lib: ObsLib, x: number, y: number, z: number, h: number, r: Rng): void {
  const leaf = K.of(lib.foliage());
  leaf.tint = [0.55, 0.62, 0.5];
  const w = h * 0.16;
  for (let i = 0; i < 5; i++) card(leaf, "cypress", [x, y, z], w, h, (i / 5) * Math.PI + r.range(-0.1, 0.1), 0, i % 2 === 1);
  leaf.tint = [0.35, 0.4, 0.32];
  for (let i = 0; i < 3; i++) card(leaf, "cypress", [x, y + h * 0.05, z], w * 0.7, h * 0.9, (i / 3) * Math.PI + 0.4);
  leaf.tint = [1, 1, 1];
}

/** A chaparral shrub (or a tree's crown clump): two crossed cards and a top card, `s` wide, `h` tall, of `cell`. */
export function shrub(k: Kit, cell: LeafCell, x: number, y: number, z: number, s: number, h: number, r: Rng, tint: V3): void {
  k.tint = tint;
  const a0 = r.range(0, Math.PI);
  for (let i = 0; i < 2; i++) card(k, cell, [x, y - 0.1, z], s, h, a0 + (i * Math.PI) / 2 + r.range(-0.15, 0.15), r.range(-0.12, 0.12), r.chance(0.5));
  k.tint = [tint[0] * 0.8, tint[1] * 0.8, tint[2] * 0.8];
  topCard(k, cell, [x, y + h * 0.72, z], s * 0.85, r.range(0, Math.PI));
  k.tint = [1, 1, 1];
}

/**
 * Coast live oak (broad, low-branching, dense rounded crown) or a pine
 * (Aleppo / stone: a tall trunk under an open umbrella crown): a tapered
 * trunk and five crown clumps.
 */
export function tree(K: Kits, lib: ObsLib, x: number, z: number, h: number, kind: "oak" | "pine", r: Rng): void {
  const leaf = K.of(lib.foliage());
  const bark = K.of(lib.bark());
  const y = groundY(x, z);
  const at = LEAF.bark;
  const trunkTop = y + h * (kind === "pine" ? 0.6 : 0.3);
  const lean: P2 = [r.range(-0.5, 0.5), r.range(-0.5, 0.5)];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * Math.PI * 2;
    const t1 = ((i + 1) / n) * Math.PI * 2;
    const r0 = h * 0.03;
    const r1 = h * 0.018;
    const P = (t: number, rr: number, yy: number, k: number): V3 => [x + lean[0] * k + Math.cos(t) * rr, yy, z + lean[1] * k + Math.sin(t) * rr];
    bark.quadN(P(t0, r0, y - 0.3, 0), P(t1, r0, y - 0.3, 0), P(t1, r1, trunkTop, 1), P(t0, r1, trunkTop, 1), [Math.cos(t0), 0, Math.sin(t0)], [Math.cos(t1), 0, Math.sin(t1)], [Math.cos(t1), 0, Math.sin(t1)], [Math.cos(t0), 0, Math.sin(t0)], [at.u0, at.v0], [at.u1, at.v0], [at.u1, at.v1], [at.u0, at.v1]);
  }
  const cx = x + lean[0];
  const cz = z + lean[1];
  const crownR = h * (kind === "pine" ? 0.38 : 0.52);
  const tint: V3 = kind === "pine" ? [0.6, 0.68, 0.56] : [0.52, 0.58, 0.48];
  // One central clump and four round it, the crown's mass in the middle.
  for (let i = 0; i < 5; i++) {
    const a = (i / 4) * Math.PI * 2 + r.range(-0.4, 0.4);
    const d = i === 0 ? 0 : crownR * r.range(0.45, 0.7);
    const cy = trunkTop - h * 0.05 + (i === 0 ? h * 0.12 : r.range(-0.05, 0.12) * h);
    const s = crownR * (i === 0 ? 1.5 : r.range(0.95, 1.2));
    shrub(leaf, kind === "pine" ? "pine" : "oak", cx + Math.cos(a) * d, cy, cz + Math.sin(a) * d, s, s * (kind === "pine" ? 0.6 : 0.8), r, tint);
  }
}

/** Yucca or agave rosette: radiating sword leaves. */
export function rosette(k: Kit, cell: "yucca" | "agave", x: number, y: number, z: number, s: number, r: Rng): void {
  const n = cell === "yucca" ? 14 : 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r.range(-0.2, 0.2);
    const tilt = cell === "yucca" ? r.range(0.15, 0.75) : r.range(0.5, 1.0);
    const ax = Math.cos(a);
    const az = Math.sin(a);
    // Card plane through the leaf's axis, turned edge-on to the rosette centre.
    card(k, cell, [x + ax * 0.05, y, z + az * 0.05], s * (cell === "yucca" ? 0.16 : 0.32), s, a + Math.PI / 2, -tilt);
  }
}
