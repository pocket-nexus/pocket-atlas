/**
 * Geometry as the route generators emit it: plain arrays per kit material,
 * positions relative to their cell's origin. The page turns them into
 * three.js meshes; the exporter writes them as they are for the compiler.
 * No three.js here: generators run in a worker and under Bun.
 */

/** One material's triangles in a cell. */
export interface Prim {
  /** A kit material by name (`kit/materials.ts`). */
  material: string;
  /** x, y, z relative to the cell's origin (m). */
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** sRGB tint and alpha per vertex. */
  color: Uint8Array;
  index: Uint32Array;
}

/** A cell of a streaming layer: everything a generator put there. */
export interface CellData {
  layer: number;
  ix: number;
  iz: number;
  /** World position of the cell's local origin. */
  origin: [number, number, number];
  prims: Prim[];
}

class Bucket {
  position: number[] = [];
  normal: number[] = [];
  uv: number[] = [];
  color: number[] = [];
  index: number[] = [];
  get count(): number {
    return this.position.length / 3;
  }
}

export type V3 = [number, number, number];

/** Collects triangles per material for one cell. Coordinates are world; the cell's origin is subtracted on output. */
export class MeshBuilder {
  private buckets = new Map<string, Bucket>();
  constructor(readonly origin: V3) {}

  private bucket(material: string): Bucket {
    let b = this.buckets.get(material);
    if (!b) this.buckets.set(material, (b = new Bucket()));
    return b;
  }

  /** Adds a vertex; returns its index in the material's list. */
  vertex(material: string, p: V3, n: V3, u: number, v: number, color: readonly [number, number, number, number] = WHITE): number {
    const b = this.bucket(material);
    b.position.push(p[0] - this.origin[0], p[1] - this.origin[1], p[2] - this.origin[2]);
    b.normal.push(n[0], n[1], n[2]);
    b.uv.push(u, v);
    b.color.push(color[0], color[1], color[2], color[3]);
    return b.count - 1;
  }

  tri(material: string, a: number, b: number, c: number): void {
    this.bucket(material).index.push(a, b, c);
  }

  /** A quad a→b→c→d (counter-clockwise seen from its front) with one normal. */
  quad(material: string, a: V3, b: V3, c: V3, d: V3, uv: readonly [number, number, number, number], color: readonly [number, number, number, number] = WHITE, normal?: V3): void {
    const n = normal ?? faceNormal(a, b, c);
    const [u0, v0, u1, v1] = uv;
    const i = this.vertex(material, a, n, u0, v0, color);
    this.vertex(material, b, n, u1, v0, color);
    this.vertex(material, c, n, u1, v1, color);
    this.vertex(material, d, n, u0, v1, color);
    const bk = this.bucket(material);
    bk.index.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  /**
   * An upright box on a footprint: centre, half extents along its own axes
   * (the x axis turned by `yaw` about y), base height and height. UVs span
   * `uv` on every side face; the top takes `top` when given.
   */
  box(material: string, cx: number, y0: number, cz: number, hx: number, hz: number, h: number, yaw: number, uv: readonly [number, number, number, number], color: readonly [number, number, number, number] = WHITE, top?: { material: string; uv: readonly [number, number, number, number] }): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const corner = (lx: number, lz: number, y: number): V3 => [cx + lx * c + lz * s, y, cz - lx * s + lz * c];
    const y1 = y0 + h;
    const p = [corner(-hx, hz, y0), corner(hx, hz, y0), corner(hx, -hz, y0), corner(-hx, -hz, y0)];
    const q = [corner(-hx, hz, y1), corner(hx, hz, y1), corner(hx, -hz, y1), corner(-hx, -hz, y1)];
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      this.quad(material, p[k], p[j], q[j], q[k], uv, color);
    }
    const t = top ?? { material, uv };
    this.quad(t.material, q[0], q[1], q[2], q[3], t.uv, color);
  }

  /** A vertical prism of `sides` faces around an axis from `a` to `b` (poles, posts, trunks). */
  tube(material: string, a: V3, b: V3, ra: number, rb: number, sides: number, uv: readonly [number, number, number, number], color: readonly [number, number, number, number] = WHITE): void {
    const ax: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    const w: V3 = [ax[0] / len, ax[1] / len, ax[2] / len];
    const ref: V3 = Math.abs(w[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = normalize(cross(ref, w));
    const v = cross(w, u);
    const base = this.bucket(material).count;
    for (let k = 0; k <= sides; k++) {
      const t = (k / sides) * Math.PI * 2;
      const n: V3 = [u[0] * Math.cos(t) + v[0] * Math.sin(t), u[1] * Math.cos(t) + v[1] * Math.sin(t), u[2] * Math.cos(t) + v[2] * Math.sin(t)];
      const uu = uv[0] + ((uv[2] - uv[0]) * k) / sides;
      this.vertex(material, [a[0] + n[0] * ra, a[1] + n[1] * ra, a[2] + n[2] * ra], n, uu, uv[1], color);
      this.vertex(material, [b[0] + n[0] * rb, b[1] + n[1] * rb, b[2] + n[2] * rb], n, uu, uv[3], color);
    }
    const bk = this.bucket(material);
    for (let k = 0; k < sides; k++) {
      const i = base + k * 2;
      bk.index.push(i, i + 2, i + 3, i, i + 3, i + 1);
    }
  }

  /** Vertices added so far for a material (for indexing vertices added by `vertex`). */
  count(material: string): number {
    return this.bucket(material).count;
  }

  /** The cell's primitives; empty materials are left out. */
  finish(): Prim[] {
    const out: Prim[] = [];
    for (const [material, b] of this.buckets) {
      if (!b.index.length) continue;
      out.push({ material, position: Float32Array.from(b.position), normal: Float32Array.from(b.normal), uv: Float32Array.from(b.uv), color: Uint8Array.from(b.color), index: Uint32Array.from(b.index) });
    }
    return out;
  }
}

export const WHITE: readonly [number, number, number, number] = [255, 255, 255, 255];

export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function faceNormal(a: V3, b: V3, c: V3): V3 {
  return normalize(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
}

/** Total triangles of a cell. */
export function triangles(prims: Prim[]): number {
  let n = 0;
  for (const p of prims) n += p.index.length / 3;
  return n;
}

/** The buffers of a cell, for transfer out of a worker. */
export function transferables(cell: CellData): ArrayBuffer[] {
  return cell.prims.flatMap((p) => [p.position.buffer, p.normal.buffer, p.uv.buffer, p.color.buffer, p.index.buffer] as ArrayBuffer[]);
}
