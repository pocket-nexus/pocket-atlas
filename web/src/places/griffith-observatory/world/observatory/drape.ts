import { ShapeUtils, Vector2 } from "three";
import { groundY } from "../dem";
import type { Kit, P2, V3 } from "./kit";

/**
 * Ground-hugging surfaces: a polygon laid on the DEM, cut along a square grid
 * (each cell's piece triangulated, its corners sampled from `groundY`) so it
 * follows the ground as closely as the site terrain does. UVs are world
 * metres (x, −z); normals come from the ground's slope.
 */

/** Ground normal from central differences of `groundY` (1 m apart). */
export function groundNormal(x: number, z: number, h = 0.5): V3 {
  const dx = (groundY(x + h, z) - groundY(x - h, z)) / (2 * h);
  const dz = (groundY(x, z + h) - groundY(x, z - h)) / (2 * h);
  const l = Math.hypot(dx, 1, dz);
  return [-dx / l, 1 / l, -dz / l];
}

/** Sutherland–Hodgman: the part of `poly` inside the axis rectangle (convex window; concave subjects come out in one piece). */
export function clipRect(poly: P2[], x0: number, z0: number, x1: number, z1: number): P2[] {
  let out = poly;
  const edges: [(p: P2) => boolean, (a: P2, b: P2) => P2][] = [
    [(p) => p[0] >= x0, (a, b) => lerpX(a, b, x0)],
    [(p) => p[0] <= x1, (a, b) => lerpX(a, b, x1)],
    [(p) => p[1] >= z0, (a, b) => lerpZ(a, b, z0)],
    [(p) => p[1] <= z1, (a, b) => lerpZ(a, b, z1)],
  ];
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i];
      const b = src[(i + 1) % src.length];
      const ia = inside(a);
      const ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

function lerpX(a: P2, b: P2, x: number): P2 {
  const t = (x - a[0]) / (b[0] - a[0]);
  return [x, a[1] + (b[1] - a[1]) * t];
}

function lerpZ(a: P2, b: P2, z: number): P2 {
  const t = (z - a[1]) / (b[1] - a[1]);
  return [a[0] + (b[0] - a[0]) * t, z];
}

/** Point-in-polygon (even–odd). */
export function inside(poly: P2[], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/**
 * Lays `poly` on the ground `lift` m above it, cut on a `cell` m grid aligned
 * to (ox, oz). `height` replaces the ground (flat terraces, ramps).
 */
export function drape(k: Kit, poly: P2[], opts: { cell?: number; lift?: number; ox?: number; oz?: number; height?: (x: number, z: number) => number; flat?: boolean } = {}): void {
  const cell = opts.cell ?? 2;
  const lift = opts.lift ?? 0.04;
  const ox = opts.ox ?? 0;
  const oz = opts.oz ?? 0;
  const H = opts.height ?? groundY;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const [x, z] of poly) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  const i0 = Math.floor((x0 - ox) / cell);
  const i1 = Math.ceil((x1 - ox) / cell);
  const j0 = Math.floor((z0 - oz) / cell);
  const j1 = Math.ceil((z1 - oz) / cell);
  const up: V3 = [0, 1, 0];
  for (let i = i0; i < i1; i++)
    for (let j = j0; j < j1; j++) {
      const cx0 = ox + i * cell;
      const cz0 = oz + j * cell;
      const piece = clipRect(poly, cx0, cz0, cx0 + cell, cz0 + cell);
      if (piece.length < 3) continue;
      const contour = piece.map(([x, z]) => new Vector2(x, z));
      let tris: number[][];
      try {
        tris = ShapeUtils.triangulateShape(contour, []);
      } catch {
        continue;
      }
      const P = (v: Vector2): V3 => [v.x, H(v.x, v.y) + lift, v.y];
      const N = (v: Vector2): V3 => (opts.flat ? up : groundNormal(v.x, v.y));
      for (const [a, b, c] of tris) {
        const A = contour[a];
        const B = contour[b];
        const C = contour[c];
        k.tri(P(A), P(B), P(C), N(A), N(B), N(C), [A.x, -A.y], [B.x, -B.y], [C.x, -C.y]);
      }
    }
}

/** A strip `width` m wide along a polyline (roads, walks), as a polygon. */
export function buffer(line: P2[], width: number): P2[] {
  const left: P2[] = [];
  const right: P2[] = [];
  const h = width / 2;
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    left.push([line[i][0] + nx * h, line[i][1] + nz * h]);
    right.push([line[i][0] - nx * h, line[i][1] - nz * h]);
  }
  return [...left, ...right.reverse()];
}
