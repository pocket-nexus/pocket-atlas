import { BufferGeometry, Float32BufferAttribute, Vector3, type Mesh } from "three";
import { Rng } from "../../../core/random";
import { foliageMaterial, LEAF, type Cell, type LeafCell } from "../gfx/foliage";
import type { KamakuraWorld } from "./context";

const UP = new Vector3(0, 1, 0);

/**
 * Alpha-tested plants from the leaf atlas (gfx/foliage.ts), all in one
 * vertex-coloured mesh per call site: cycads with folded pinnate fronds, fan
 * palms on fibrous trunks with a skirt of dead leaves, broadleaf shrubs as
 * card clusters shaded as a volume, grass tufts and the ragged outline of
 * the clipped hedges. One material, so a 32 m chunk draws all its plants in
 * one call.
 */
export class Greenery {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  readonly r: Rng;

  constructor(seed: number) {
    this.r = new Rng(seed);
  }

  get triangles(): number {
    return this.idx.length / 3;
  }

  private vert(p: Vector3, n: Vector3, u: number, v: number, c: [number, number, number]): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }

  /**
   * A strip `rows` × 3 (left edge, rib, right edge) across a cell: row i has
   * points [left, centre, right] mapped to v from v0 to v1 along the rows.
   */
  private strip(rows: Vector3[][], normals: Vector3[], cell: Cell, tint: [number, number, number], vFrom = 0, vTo = 1): void {
    const base = this.pos.length / 3;
    rows.forEach((row, i) => {
      const t = rows.length > 1 ? i / (rows.length - 1) : 0;
      const v = cell.v0 + (vFrom + (vTo - vFrom) * t) * (cell.v1 - cell.v0);
      const us = [cell.u0, (cell.u0 + cell.u1) / 2, cell.u1];
      row.forEach((p, k) => this.vert(p, normals[i], us[k], v, tint));
    });
    for (let i = 0; i < rows.length - 1; i++)
      for (let k = 0; k < 2; k++) {
        const a = base + i * 3 + k;
        this.idx.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
      }
  }

  /** One flat card centred on `c` with normal `n`, spun by `spin`, size s (m); shading normal `sn`. */
  private card(c: Vector3, n: Vector3, spin: number, w: number, h: number, cell: Cell, tint: [number, number, number], sn: Vector3 = n): void {
    const t = Math.abs(n.y) > 0.95 ? new Vector3(1, 0, 0) : new Vector3().crossVectors(UP, n).normalize();
    const b = new Vector3().crossVectors(n, t).normalize();
    const cs = Math.cos(spin);
    const ss = Math.sin(spin);
    const ax = t.clone().multiplyScalar(cs).addScaledVector(b, ss).multiplyScalar(w / 2);
    const ay = b.clone().multiplyScalar(cs).addScaledVector(t, -ss).multiplyScalar(h / 2);
    const base = this.pos.length / 3;
    const corners: [number, number, number, number][] = [
      [-1, -1, cell.u0, cell.v0],
      [1, -1, cell.u1, cell.v0],
      [1, 1, cell.u1, cell.v1],
      [-1, 1, cell.u0, cell.v1],
    ];
    for (const [x, y, u, v] of corners) this.vert(c.clone().addScaledVector(ax, x).addScaledVector(ay, y), sn, u, v, tint);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** A tapered trunk, `radial` sides, textured from a bark cell. */
  trunk(pts: Vector3[], r0: number, r1: number, cell: Cell, tint: [number, number, number], radial = 6): void {
    const base = this.pos.length / 3;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const r = r0 + (r1 - r0) * t;
      const v = cell.v0 + t * (cell.v1 - cell.v0);
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const d = new Vector3(Math.cos(a), 0, Math.sin(a));
        this.vert(pts[i].clone().addScaledVector(d, r), d, cell.u0 + (j / radial) * (cell.u1 - cell.u0), v, tint);
      }
    }
    for (let i = 0; i < n - 1; i++)
      for (let j = 0; j < radial; j++) {
        const a = base + i * (radial + 1) + j;
        const b = a + radial + 1;
        this.idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
  }

  private tint(lo = 0.8, hi = 1.0, warm = 0): [number, number, number] {
    const k = this.r.range(lo, hi);
    return [Math.min(1, k * (1 + warm * 0.12)), k, Math.max(0, k * (1 - warm * 0.15))];
  }

  /**
   * A frond as a folded strip: rib from `base` along azimuth `az`, rising at
   * `elev` and drooping by `droop` (fraction of its length) at the tip; the
   * two halves fold up by `fold` radians about the rib.
   */
  private frond(base: Vector3, az: number, elev: number, len: number, width: number, droop: number, fold: number, cell: Cell, tint: [number, number, number], rows = 4, vFrom = 0): void {
    const dir = new Vector3(Math.sin(az), 0, Math.cos(az));
    const side = new Vector3(dir.z, 0, -dir.x);
    const pts: Vector3[][] = [];
    const nrm: Vector3[] = [];
    for (let i = 0; i < rows; i++) {
      const t = i / (rows - 1);
      const p = base.clone().addScaledVector(dir, len * t * Math.cos(elev)).addScaledVector(UP, len * (t * Math.sin(elev) - droop * t * t));
      // Tangent of the rib, for the fold's up direction.
      const tan = dir.clone().multiplyScalar(Math.cos(elev)).addScaledVector(UP, Math.sin(elev) - 2 * droop * t).normalize();
      const up = new Vector3().crossVectors(side, tan).normalize();
      if (up.y < 0) up.negate();
      const w = (width / 2) * (vFrom > 0 && t === 0 ? 0.6 : 1);
      const l = p.clone().addScaledVector(side, -w * Math.cos(fold)).addScaledVector(up, w * Math.sin(fold));
      const rr = p.clone().addScaledVector(side, w * Math.cos(fold)).addScaledVector(up, w * Math.sin(fold));
      pts.push([l, p, rr]);
      nrm.push(up.clone().multiplyScalar(0.7).addScaledVector(dir, 0.3).normalize());
    }
    this.strip(pts, nrm, cell, tint, vFrom, 1);
  }

  /** Cycas revoluta: a short scaly trunk and a rosette of stiff arching fronds. */
  cycad(at: Vector3, size = 1): void {
    const r = this.r;
    const h = r.range(0.25, 0.7) * size;
    this.trunk([at.clone().setY(at.y - 0.1), at.clone().setY(at.y + h)], 0.2 * size, 0.17 * size, LEAF.cycadBark, this.tint(0.8, 1), 6);
    const top = at.clone().setY(at.y + h);
    const n = r.int(16, 22);
    const tint = this.tint(0.82, 1.0);
    for (let k = 0; k < n; k++) {
      const az = (k / n) * Math.PI * 2 + r.range(-0.15, 0.15);
      const len = r.range(0.85, 1.25) * size;
      const elev = r.range(0.35, 0.95);
      this.frond(top, az, elev, len, len * 0.5, r.range(0.25, 0.45), r.range(0.3, 0.5), LEAF.cycad, tint);
    }
  }

  /** Trachycarpus fan palm: a fibrous trunk, a crown of fans and a skirt of dead leaves. */
  fanPalm(at: Vector3, height: number, lean = new Vector3()): void {
    const r = this.r;
    const pts: Vector3[] = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      pts.push(at.clone().add(new Vector3(lean.x * t * t * height, height * t, lean.z * t * t * height)));
    }
    this.trunk(pts, 0.16, 0.12, LEAF.palmBark, this.tint(0.85, 1), 7);
    const top = pts[4];
    const n = r.int(20, 26);
    for (let k = 0; k < n; k++) {
      const az = (k / n) * Math.PI * 2 * 1.618 + r.range(-0.2, 0.2);
      const elev = r.range(-0.15, 1.25);
      const len = r.range(2.0, 2.5);
      this.frond(top, az, elev, len, len, 0.25 + (1.25 - elev) * 0.18, r.range(0.12, 0.3), LEAF.fan, this.tint(0.82, 1), 3);
    }
    // Skirt: dead fronds hanging against the trunk below the crown.
    for (let k = 0; k < 7; k++) {
      const az = (k / 7) * Math.PI * 2 + r.range(-0.3, 0.3);
      this.frond(top.clone().setY(top.y - 0.25), az, r.range(-1.45, -1.2), r.range(1.3, 1.7), 1.4, 0, 0.15, LEAF.fan, [0.62, 0.46, 0.26], 3);
    }
  }

  /**
   * A broadleaf shrub (or a small-leaved one): cards scattered through an
   * ellipsoid, each facing out and up, shaded with the ellipsoid's normal.
   */
  shrub(at: Vector3, radius: number, height: number, kind: "shrub" | "box" = "shrub", density = 1): void {
    const r = this.r;
    const cell = LEAF[kind];
    const c = at.clone().setY(at.y + height * 0.55);
    const R = new Vector3(radius, height * 0.55, radius);
    // Cards of about 0.6 m, enough to cover the ellipsoid's surface about twice over.
    const area = 4 * Math.PI * Math.pow((radius * radius * radius * height * 0.55) ** (1 / 3), 2);
    const size = Math.min(0.75, 0.35 + Math.min(radius, height) * 0.3);
    const count = Math.max(6, Math.round(((area * 1.6) / (size * size)) * density));
    const tint = this.tint(0.8, 1.0);
    for (let i = 0; i < count; i++) {
      const d = new Vector3(r.range(-1, 1), r.range(-0.6, 1), r.range(-1, 1));
      if (d.lengthSq() > 1) d.normalize();
      d.multiplyScalar(Math.pow(r.next(), 0.25));
      const p = c.clone().add(d.clone().multiply(R).multiplyScalar(0.85));
      const out = d.clone().divide(R).normalize();
      const n = out.clone().multiplyScalar(0.6).add(new Vector3(r.range(-0.5, 0.5), r.range(0.1, 0.8), r.range(-0.5, 0.5))).normalize();
      const s = size * r.range(0.8, 1.2);
      this.card(p, n, r.range(0, Math.PI * 2), s, s, cell, tint, n.clone().multiplyScalar(0.35).addScaledVector(out, 0.65).normalize());
    }
  }

  /** A grass tuft: crossed upright cards; `tall` for the silver-grass clumps on the banks. */
  grass(at: Vector3, h: number, kind: "grass" | "tall" = "grass"): void {
    const r = this.r;
    const cell = LEAF[kind];
    const w = kind === "tall" ? h * 0.55 : h;
    const tint = this.tint(0.82, 1.0, r.range(0, 1));
    const spin = r.range(0, Math.PI);
    for (let k = 0; k < 2; k++) {
      const a = spin + (k * Math.PI) / 2;
      const n = new Vector3(Math.sin(a), 0, Math.cos(a));
      const lean = new Vector3(r.range(-0.08, 0.08), 0, r.range(-0.08, 0.08));
      const sn = n.clone().multiplyScalar(0.4).addScaledVector(UP, 0.8).normalize();
      this.card(at.clone().setY(at.y + h / 2 - 0.03).add(lean), n, 0, w, h, cell, tint, sn);
    }
  }

  /**
   * The ragged outline of a clipped hedge running along `path` (ground
   * points), `width` × `height`: leaf mats along both top edges and the
   * crown, tilted outward, so the box reads as clipped foliage.
   */
  hedgeEdge(path: Vector3[], width: number, height: number, spacing = 0.4): void {
    const r = this.r;
    const tint = this.tint(0.8, 0.95);
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const len = a.distanceTo(b);
      const t = new Vector3().subVectors(b, a).setY(0).normalize();
      const side = new Vector3(-t.z, 0, t.x);
      for (let s = 0; s < len; s += spacing * r.range(0.7, 1.3)) {
        const p = a.clone().lerp(b, s / len);
        // Mats on both faces near the top and on the shoulders, a few on the crown: flush with the
        // box and 3–6 cm proud of it, so the outline breaks up without reading as balls.
        for (const k of [-1, 1]) {
          const face = side.clone().multiplyScalar(k);
          const out = face.clone().multiplyScalar(0.9).addScaledVector(UP, r.range(0.1, 0.45)).normalize();
          const c = p.clone().addScaledVector(face, width / 2 + r.range(0.03, 0.06)).setY(p.y + height - r.range(0.12, 0.35));
          this.card(c, out, r.range(0, Math.PI * 2), r.range(0.32, 0.45), r.range(0.32, 0.45), LEAF.hedge, tint, out);
          const sh = face.clone().multiplyScalar(0.6).addScaledVector(UP, 0.8).normalize();
          const c2 = p.clone().addScaledVector(face, width / 2 - 0.05).setY(p.y + height - 0.02);
          this.card(c2, sh, r.range(0, Math.PI * 2), r.range(0.3, 0.42), r.range(0.3, 0.42), LEAF.hedge, tint, sh);
        }
        if (r.chance(0.35)) {
          const c = p.clone().addScaledVector(side, r.range(-0.2, 0.2) * width).setY(p.y + height + 0.03);
          const n = UP.clone().addScaledVector(side, r.range(-0.3, 0.3)).normalize();
          this.card(c, n, r.range(0, Math.PI * 2), r.range(0.3, 0.45), r.range(0.3, 0.45), LEAF.hedge, tint, UP);
        }
      }
    }
  }

  /** Emits everything as one static mesh (kept out of batching, which drops vertex colours). */
  emit(w: KamakuraWorld, name: string): Mesh | null {
    if (!this.idx.length) return null;
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    const m = w.mesh(g, foliageMaterial(w.lib), 0, 0, 0, w.root, { cast: true });
    m.userData.noBatch = true;
    m.name = name;
    return m;
  }
}

export type { LeafCell };
