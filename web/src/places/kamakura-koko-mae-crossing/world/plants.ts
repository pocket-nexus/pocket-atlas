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
    this.col.push(Math.min(1, c[0]), Math.min(1, c[1]), Math.min(1, c[2]));
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
    const h = r.range(0.2, 0.5) * size;
    this.trunk([at.clone().setY(at.y - 0.1), at.clone().setY(at.y + h * 0.6), at.clone().setY(at.y + h)], 0.15 * size, 0.12 * size, LEAF.cycadBark, this.tint(0.95, 1.0, 1), 8);
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
    // Fans about 1.1 m across on 0.6 m petioles (Trachycarpus), a dense round crown.
    const n = r.int(28, 34);
    for (let k = 0; k < n; k++) {
      const az = (k / n) * Math.PI * 2 * 1.618 + r.range(-0.2, 0.2);
      const elev = r.range(-0.2, 1.3);
      const len = r.range(1.25, 1.55);
      this.frond(top, az, elev, len, len, 0.25 + (1.25 - elev) * 0.18, r.range(0.12, 0.3), LEAF.fan, this.tint(0.82, 1), 3);
    }
    // Skirt: dead fronds hanging against the trunk below the crown.
    for (let k = 0; k < 7; k++) {
      const az = (k / 7) * Math.PI * 2 + r.range(-0.3, 0.3);
      this.frond(top.clone().setY(top.y - 0.2), az, r.range(-1.45, -1.2), r.range(1.0, 1.3), 1.1, 0, 0.15, LEAF.fan, [0.62, 0.46, 0.26], 3);
    }
  }

  /**
   * A shrub (broadleaf トベラ, or small-leaved ツツジ / ツゲ for "box"): a dark
   * core of crossed cards that stops the eye at the interior, then clumps of
   * small cards on an ellipsoid's surface, five or six cards to a clump, so
   * the outline is lumpy. Cards face out and up, shaded with the
   * ellipsoid's normal, lighter toward the top and darker toward the core
   * (vertex colour).
   */
  shrub(at: Vector3, radius: number, height: number, kind: "shrub" | "box" = "shrub", density = 1): void {
    const r = this.r;
    const c = at.clone().setY(at.y + height * 0.52);
    const R = new Vector3(radius, height * 0.52, radius);
    const base = this.tint(0.82, 1.0);
    const shade = (k: number, y: number): [number, number, number] => {
      const lift = 0.72 + 0.36 * Math.min(1, Math.max(0, (y - at.y) / height));
      return [base[0] * k * lift, base[1] * k * lift, base[2] * k * lift];
    };
    // Core: two upright cards across each other and one flat, inside the clumps.
    const spin = r.range(0, Math.PI);
    for (let k = 0; k < 2; k++) {
      const a = spin + (k * Math.PI) / 2;
      const n = new Vector3(Math.sin(a), 0, Math.cos(a));
      this.card(c.clone().setY(c.y - height * 0.06), n, 0, radius * 1.45, height * 0.85, LEAF.core, shade(0.95, c.y), UP);
    }
    this.card(c.clone().setY(c.y + height * 0.1), UP, r.range(0, Math.PI), radius * 1.4, radius * 1.4, LEAF.core, shade(1, c.y), UP);
    // Clumps over the surface, fewer underneath.
    const area = 4 * Math.PI * Math.pow((radius * radius * radius * height * 0.52) ** (1 / 3), 2);
    const size = Math.min(0.55, 0.3 + Math.min(radius, height) * 0.14) * (kind === "box" ? 0.85 : 1);
    const clumps = Math.max(5, Math.round(((area * 0.75) / (size * size * 5)) * density * 1.9));
    const cells = kind === "box" ? [LEAF.small, LEAF.small, LEAF.box] : [LEAF.shrub, LEAF.shrub2, LEAF.shrub];
    for (let i = 0; i < clumps; i++) {
      const d = new Vector3(r.range(-1, 1), r.range(-0.45, 1), r.range(-1, 1));
      if (d.lengthSq() < 0.05) d.set(0, 1, 0);
      d.normalize();
      const hub = c.clone().add(d.clone().multiply(R).multiplyScalar(0.86));
      const out = d.clone().divide(R).normalize();
      const per = r.int(4, 6);
      for (let k = 0; k < per; k++) {
        const j = new Vector3(r.range(-1, 1), r.range(-0.7, 0.7), r.range(-1, 1)).multiplyScalar(size * 0.45);
        const p = hub.clone().add(j).addScaledVector(out, r.range(-0.12, 0.08));
        const n = out.clone().multiplyScalar(0.65).add(new Vector3(r.range(-0.45, 0.45), r.range(0.15, 0.7), r.range(-0.45, 0.45))).normalize();
        const s = size * r.range(0.8, 1.15);
        // Cards nearer the core sit in its shade.
        const depth = p.clone().sub(c).divide(R).length();
        this.card(p, n, r.range(0, Math.PI * 2), s, s, r.pick(cells), shade(0.8 + 0.25 * Math.min(1, depth), p.y), n.clone().multiplyScalar(0.3).addScaledVector(out, 0.7).normalize());
      }
    }
  }

  /** A grass tuft: crossed upright cards; `tall` for the silver-grass clumps on the banks. */
  grass(at: Vector3, h: number, kind: "grass" | "tall" = "grass"): void {
    const r = this.r;
    const cell = LEAF[kind];
    const w = kind === "tall" ? h * 0.55 : h;
    const tint = kind === "tall" ? this.tint(0.82, 1.0, r.range(0, 1)) : this.tint(0.55, 0.75, r.range(0, 0.6));
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
   * points), `width` × `height`: leaf mats 2 cm proud of the upper band of
   * both faces, facing out, and mats lying flat on and just above the
   * crown, which break its outline. Nothing is tilted toward the path, so a
   * view along the hedge sees the mats edge-on instead of as slivers.
   */
  hedgeEdge(path: Vector3[], width: number, height: number, spacing = 0.3): void {
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
        for (const k of [-1, 1]) {
          const face = side.clone().multiplyScalar(k);
          const n = face.clone().addScaledVector(UP, r.range(0.05, 0.2)).normalize();
          // On the face's upper band, its top edge level with the crown; shaded like the face, a
          // little darker, so mats seen edge-on along the path do not flash.
          const mh = r.range(0.2, 0.28);
          const c = p.clone().addScaledVector(face, width / 2 + r.range(0.015, 0.03)).setY(p.y + height * 0.9 - mh / 2 + 0.03);
          this.card(c, n, r.range(-0.25, 0.25), r.range(0.3, 0.42), mh, LEAF.hedge, [tint[0] * 0.85, tint[1] * 0.85, tint[2] * 0.85], face);
        }
        if (r.chance(0.6)) {
          // On the crown, following its fall to the shoulders (slope.ts lofts the top 10 % lower there).
          const lat = r.range(-0.3, 0.3);
          const c = p.clone().addScaledVector(side, lat * width).setY(p.y + height * (1 - 0.2 * Math.abs(lat)) + 0.015);
          const n = UP.clone().addScaledVector(side, lat * 0.6).normalize();
          this.card(c, n, r.range(0, Math.PI * 2), r.range(0.24, 0.34), r.range(0.24, 0.34), LEAF.hedge, [tint[0] * 0.95, tint[1] * 0.95, tint[2] * 0.95], n);
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
    console.info(`[kamakura:plants] ${name}: ${this.triangles} triangles`);
    return m;
  }
}

export type { LeafCell };
