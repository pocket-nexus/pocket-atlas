import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2, type Material, type Mesh, type Object3D } from "three";
import type { AtlasRect } from "../../../shared/atlas";
import type { GriffithWorld } from "../context";

/**
 * Geometry kit for the observatory: one `Kit` per material collects
 * triangles with positions, normals, UVs in metres (or atlas UVs) and vertex
 * colours (a grey shade for baked occlusion, times a tint), turning every
 * face to the normal it was asked for. Angles round a centre follow
 * x = cx + r·cos θ, z = cz + r·sin θ: θ = 0 east, π/2 south, π west, −π/2 north.
 */

export type V3 = [number, number, number];
export type P2 = [number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export class Kit {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  /** Vertex colour of the next faces (RGB, linear). */
  tint: V3 = [1, 1, 1];
  /** Occlusion shade multiplied into the tint (1 = open). */
  shade = 1;

  get triangles(): number {
    return this.pos.length / 9;
  }

  private push(p: V3, n: V3, u: number, v: number, s: number): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    const k = this.shade * s;
    this.col.push(this.tint[0] * k, this.tint[1] * k, this.tint[2] * k);
  }

  /**
   * Triangle with per-vertex normals; turned so its face points along the
   * mean normal. `s` are per-vertex extra shades.
   */
  tri(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, ua: P2, ub: P2, uc: P2, s: V3 = [1, 1, 1]): void {
    const f = cross(sub(b, a), sub(c, a));
    const m: V3 = [na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]];
    if (dot(f, m) >= 0) {
      this.push(a, na, ua[0], ua[1], s[0]);
      this.push(b, nb, ub[0], ub[1], s[1]);
      this.push(c, nc, uc[0], uc[1], s[2]);
    } else {
      this.push(a, na, ua[0], ua[1], s[0]);
      this.push(c, nc, uc[0], uc[1], s[2]);
      this.push(b, nb, ub[0], ub[1], s[1]);
    }
  }

  /** Quad a-b-c-d (in order round its edge) with one normal, UVs given per corner. */
  quad(a: V3, b: V3, c: V3, d: V3, n: V3, ua: P2, ub: P2, uc: P2, ud: P2, s: [number, number, number, number] = [1, 1, 1, 1]): void {
    this.tri(a, b, c, n, n, n, ua, ub, uc, [s[0], s[1], s[2]]);
    this.tri(a, c, d, n, n, n, ua, uc, ud, [s[0], s[2], s[3]]);
  }

  /** Quad with per-corner normals (curved surfaces). */
  quadN(a: V3, b: V3, c: V3, d: V3, na: V3, nb: V3, nc: V3, nd: V3, ua: P2, ub: P2, uc: P2, ud: P2): void {
    this.tri(a, b, c, na, nb, nc, ua, ub, uc);
    this.tri(a, c, d, na, nc, nd, ua, uc, ud);
  }

  /** Flat quad whose normal is computed and oriented toward `out`. */
  face(a: V3, b: V3, c: V3, d: V3, out: V3, ua: P2, ub: P2, uc: P2, ud: P2): void {
    let n = norm(cross(sub(b, a), sub(c, a)));
    if (dot(n, out) < 0) n = [-n[0], -n[1], -n[2]];
    this.quad(a, b, c, d, n, ua, ub, uc, ud);
  }

  // ------------------------------------------------------------- walls

  /**
   * Vertical wall from a to b (x, z) between y0 and y1, facing `side`
   * (+1: the left of a→b seen from above with north up, i.e. normal
   * (dz, −dx); −1 the other side). UVs: u = metres along (from `u0`), v = y.
   * `su`/`sv` subdivide it (for baked light fans).
   */
  wall(a: P2, b: P2, y0: number, y1: number, side: 1 | -1 = 1, opts: { su?: number; sv?: number; u0?: number; atlas?: AtlasRect } = {}): void {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-4 || y1 - y0 < 1e-4) return;
    const n: V3 = [(dz / len) * side, 0, (-dx / len) * side];
    const su = Math.max(1, opts.su ?? 1);
    const sv = Math.max(1, opts.sv ?? 1);
    const u0 = opts.u0 ?? 0;
    const at = opts.atlas;
    for (let i = 0; i < su; i++)
      for (let j = 0; j < sv; j++) {
        const t0 = i / su;
        const t1 = (i + 1) / su;
        const h0 = y0 + ((y1 - y0) * j) / sv;
        const h1 = y0 + ((y1 - y0) * (j + 1)) / sv;
        const p = (t: number, h: number): V3 => [a[0] + dx * t, h, a[1] + dz * t];
        const uvp = (t: number, h: number): P2 => (at ? [at.u0 + (at.u1 - at.u0) * t, at.v0 + ((at.v1 - at.v0) * (h - y0)) / (y1 - y0)] : [u0 + len * t, h]);
        this.quad(p(t0, h0), p(t1, h0), p(t1, h1), p(t0, h1), n, uvp(t0, h0), uvp(t1, h0), uvp(t1, h1), uvp(t0, h1));
      }
  }

  /** Axis box, UVs in metres per face; `skip` names faces to leave out ("px", "nx", "py", "ny", "pz", "nz"). */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, skip = ""): void {
    const has = (f: string) => !skip.includes(f);
    if (has("pz")) this.wall([x0, z1], [x1, z1], y0, y1, -1, { u0: x0 });
    if (has("nz")) this.wall([x0, z0], [x1, z0], y0, y1, 1, { u0: -x1 });
    if (has("px")) this.wall([x1, z0], [x1, z1], y0, y1, 1, { u0: z0 });
    if (has("nx")) this.wall([x0, z0], [x0, z1], y0, y1, -1, { u0: -z1 });
    if (has("py")) this.flat([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], y1, 1);
    if (has("ny")) this.flat([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], y0, -1);
  }

  /** Horizontal polygon (with optional holes) at height y facing up (+1) or down (−1); UVs = (x, −z). */
  flat(outline: P2[], y: number, dir: 1 | -1 = 1, holes: P2[][] = []): void {
    const contour = outline.map(([x, z]) => new Vector2(x, z));
    const hs = holes.map((h) => h.map(([x, z]) => new Vector2(x, z)));
    const tris = ShapeUtils.triangulateShape(contour, hs);
    const all = [...contour, ...hs.flat()];
    const n: V3 = [0, dir, 0];
    for (const [i, j, k] of tris) {
      const P = (v: Vector2): V3 => [v.x, y, v.y];
      const U = (v: Vector2): P2 => [v.x, -v.y];
      this.tri(P(all[i]), P(all[j]), P(all[k]), n, n, n, U(all[i]), U(all[j]), U(all[k]));
    }
  }

  /** Vertical walls round a closed polygon (x, z), facing outward (or inward). UVs continue round the ring. */
  ring(pts: P2[], y0: number, y1: number, outward = true, opts: { sv?: number; maxSeg?: number } = {}): void {
    const area = signedArea(pts);
    // signedArea > 0: counter-clockwise in (x, z) = clockwise seen from above (north up);
    // the wall normal (dz, −dx) then points out.
    const side: 1 | -1 = (area > 0) === outward ? 1 : -1;
    let u = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const su = opts.maxSeg ? Math.ceil(len / opts.maxSeg) : 1;
      this.wall(a, b, y0, y1, side, { su, sv: opts.sv, u0: u });
      u += len;
    }
  }

  // ------------------------------------------------------------- round

  /**
   * Cylinder wall of radius r between y0 and y1 over θ ∈ [a0, a1], `seg`
   * facets, `sv` rows; outward or inward. UVs: u = r·θ, v = y (metres).
   */
  cyl(cx: number, cz: number, r: number, y0: number, y1: number, a0: number, a1: number, seg: number, opts: { sv?: number; inward?: boolean; atlas?: AtlasRect; uScale?: number } = {}): void {
    const sv = opts.sv ?? 1;
    const s = opts.inward ? -1 : 1;
    const at = opts.atlas;
    for (let i = 0; i < seg; i++) {
      const t0 = a0 + ((a1 - a0) * i) / seg;
      const t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
      const n0: V3 = [Math.cos(t0) * s, 0, Math.sin(t0) * s];
      const n1: V3 = [Math.cos(t1) * s, 0, Math.sin(t1) * s];
      for (let j = 0; j < sv; j++) {
        const h0 = y0 + ((y1 - y0) * j) / sv;
        const h1 = y0 + ((y1 - y0) * (j + 1)) / sv;
        const p = (t: number, h: number): V3 => [cx + Math.cos(t) * r, h, cz + Math.sin(t) * r];
        const U = (k: number, h: number): P2 => (at ? [at.u0 + (at.u1 - at.u0) * k, at.v0 + ((at.v1 - at.v0) * (h - y0)) / (y1 - y0)] : [(k ? t1 : t0) * r * (opts.uScale ?? 1), h]);
        this.quadN(p(t0, h0), p(t1, h0), p(t1, h1), p(t0, h1), n0, n1, n1, n0, U(0, h0), U(1, h0), U(1, h1), U(0, h1));
      }
    }
  }

  /** Flat ring (annulus sector) r0..r1 at height y, facing up or down; UVs = (x, −z). */
  annulus(cx: number, cz: number, r0: number, r1: number, y: number, a0: number, a1: number, seg: number, dir: 1 | -1 = 1): void {
    const n: V3 = [0, dir, 0];
    for (let i = 0; i < seg; i++) {
      const t0 = a0 + ((a1 - a0) * i) / seg;
      const t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
      const p = (r: number, t: number): V3 => [cx + Math.cos(t) * r, y, cz + Math.sin(t) * r];
      const U = (q: V3): P2 => [q[0], -q[2]];
      const a = p(r0, t0);
      const b = p(r1, t0);
      const c = p(r1, t1);
      const d = p(r0, t1);
      if (r0 < 1e-4) this.tri(b, c, a, n, n, n, U(b), U(c), U(a));
      else this.quad(a, b, c, d, n, U(a), U(b), U(c), U(d));
    }
  }

  /**
   * Surface of revolution of a profile [r, y] (bottom to top) over θ ∈
   * [a0, a1]. Normals from the profile's slope (smooth along it unless
   * `hard`). UVs: u = θ·`uPer` (tiles round), v = arc length·`vPer`.
   */
  lathe(cx: number, cz: number, prof: P2[], a0: number, a1: number, seg: number, opts: { uPer?: number; vPer?: number; hard?: boolean; inward?: boolean } = {}): void {
    const uPer = opts.uPer ?? 1;
    const vPer = opts.vPer ?? 1;
    const s = opts.inward ? -1 : 1;
    // Profile normals (outward in the r–y plane) and arc lengths.
    const segN: P2[] = [];
    for (let k = 0; k + 1 < prof.length; k++) {
      const dr = prof[k + 1][0] - prof[k][0];
      const dy = prof[k + 1][1] - prof[k][1];
      const l = Math.hypot(dr, dy) || 1;
      segN.push([dy / l, -dr / l]);
    }
    const arc: number[] = [0];
    for (let k = 1; k < prof.length; k++) arc.push(arc[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]));
    for (let k = 0; k + 1 < prof.length; k++) {
      const nA: P2 = opts.hard || k === 0 ? segN[k] : avg(segN[k - 1], segN[k]);
      const nB: P2 = opts.hard || k + 2 >= prof.length ? segN[k] : avg(segN[k], segN[k + 1]);
      for (let i = 0; i < seg; i++) {
        const t0 = a0 + ((a1 - a0) * i) / seg;
        const t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
        const P = (q: P2, t: number): V3 => [cx + Math.cos(t) * q[0], q[1], cz + Math.sin(t) * q[0]];
        const N = (q: P2, t: number): V3 => [Math.cos(t) * q[0] * s, q[1] * s, Math.sin(t) * q[0] * s];
        const U = (t: number, kk: number): P2 => [t * uPer, arc[kk] * vPer];
        this.quadN(P(prof[k], t0), P(prof[k], t1), P(prof[k + 1], t1), P(prof[k + 1], t0), N(nA, t0), N(nA, t1), N(nB, t1), N(nB, t0), U(t0, k), U(t1, k), U(t1, k + 1), U(t0, k + 1));
      }
    }
  }

  /**
   * A standing-seam dome: `pans` flat copper pans between the meridian seams
   * of the surface of revolution `prof` ([r, y], bottom to top), each pan ×
   * course one flat facet, so the pans catch the floodlight and the sky one by
   * one; the seams themselves are the facet edges and the copper texture's
   * raised lines. UVs: u = pan / 8 (the copper tile holds 8 pans), v = arc
   * length · vPer.
   */
  pannedDome(cx: number, cz: number, prof: P2[], pans: number, vPer: number, a0 = 0): void {
    const arcs: number[] = [0];
    for (let k = 1; k < prof.length; k++) arcs.push(arcs[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]));
    const S = (t: number, q: P2): V3 => [cx + Math.cos(t) * q[0], q[1], cz + Math.sin(t) * q[0]];
    for (let i = 0; i < pans; i++) {
      const t0 = a0 + (i / pans) * Math.PI * 2;
      const t1 = a0 + ((i + 1) / pans) * Math.PI * 2;
      const tm = (t0 + t1) / 2;
      const u0 = i / 8;
      const u1 = (i + 1) / 8;
      for (let k = 0; k + 1 < prof.length; k++) {
        const [r0, y0] = prof[k];
        const [r1, y1] = prof[k + 1];
        const out: V3 = [Math.cos(tm) * (y1 - y0), r0 - r1, Math.sin(tm) * (y1 - y0)];
        const a = S(t0, prof[k]);
        const b = S(t1, prof[k]);
        const c = S(t1, prof[k + 1]);
        const d = S(t0, prof[k + 1]);
        if (r1 < 0.01) {
          const n = norm(cross(sub(b, a), sub(c, a)));
          const m: V3 = dot(n, out) < 0 ? [-n[0], -n[1], -n[2]] : n;
          this.tri(a, b, c, m, m, m, [u0, arcs[k] * vPer], [u1, arcs[k] * vPer], [(u0 + u1) / 2, arcs[k + 1] * vPer]);
        } else this.face(a, b, c, d, out, [u0, arcs[k] * vPer], [u1, arcs[k] * vPer], [u1, arcs[k + 1] * vPer], [u0, arcs[k + 1] * vPer]);
      }
    }
  }

  /**
   * Sweeps a cross-section along a polyline in plan: `prof` is [out, y]
   * (out = metres toward the path's outer side, which is the left of travel
   * for side = 1), joined at mitred corners. For cornices, copings, plinths.
   */
  sweep(path: P2[], closed: boolean, prof: P2[], side: 1 | -1 = 1): void {
    const n = path.length;
    const frames: { p: P2; o: P2 }[] = [];
    for (let i = 0; i < n; i++) {
      const prev = path[(i - 1 + n) % n];
      const cur = path[i];
      const next = path[(i + 1) % n];
      const d0 = i > 0 || closed ? unit([cur[0] - prev[0], cur[1] - prev[1]]) : null;
      const d1 = i < n - 1 || closed ? unit([next[0] - cur[0], next[1] - cur[1]]) : null;
      const o0 = d0 ? ([d0[1] * side, -d0[0] * side] as P2) : null;
      const o1 = d1 ? ([d1[1] * side, -d1[0] * side] as P2) : null;
      let o: P2 = o0 && o1 ? unit([o0[0] + o1[0], o0[1] + o1[1]]) : (o0 ?? o1)!;
      const k = o0 && o1 ? 1 / Math.max(0.3, o[0] * o1[0] + o[1] * o1[1]) : 1;
      o = [o[0] * k, o[1] * k];
      frames.push({ p: cur, o });
    }
    const segs = closed ? n : n - 1;
    let u = 0;
    for (let i = 0; i < segs; i++) {
      const A = frames[i];
      const B = frames[(i + 1) % n];
      const len = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]);
      for (let k = 0; k + 1 < prof.length; k++) {
        const q0 = prof[k];
        const q1 = prof[k + 1];
        const P = (F: { p: P2; o: P2 }, q: P2): V3 => [F.p[0] + F.o[0] * q[0], q[1], F.p[1] + F.o[1] * q[0]];
        const a = P(A, q0);
        const b = P(B, q0);
        const c = P(B, q1);
        const d = P(A, q1);
        // Outward of this facet: the profile segment's normal in (out, y), mapped to world.
        const dr = q1[0] - q0[0];
        const dy = q1[1] - q0[1];
        const mid: P2 = unit([A.o[0] + B.o[0], A.o[1] + B.o[1]]);
        const out: V3 = [mid[0] * dy, -dr, mid[1] * dy];
        const vl = Math.hypot(dr, dy);
        if (vl < 1e-5) continue;
        this.face(a, b, c, d, out, [u, q0[1]], [u + len, q0[1]], [u + len, q0[1] + vl], [u, q0[1] + vl]);
      }
      u += len;
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }

  /** Adds the kit's triangles to the world as one static mesh (batched later by material). */
  emit(w: GriffithWorld, mat: Material, parent?: Object3D, cast = true): Mesh | null {
    if (!this.pos.length) return null;
    const m = w.mesh(this.geometry(), mat, 0, 0, 0, parent ?? w.root, { cast });
    return m;
  }
}

function avg(a: P2, b: P2): P2 {
  return unit([a[0] + b[0], a[1] + b[1]]);
}

export function unit(a: P2): P2 {
  const l = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
}

/** Signed area of a polygon in (x, z): positive when counter-clockwise in x–z axes. */
export function signedArea(pts: P2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

/** Points on an arc (θ from a0 to a1, n segments → n + 1 points). */
export function arc(cx: number, cz: number, r: number, a0: number, a1: number, n: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(t) * r, cz + Math.sin(t) * r]);
  }
  return out;
}

/** Degrees to radians. */
export const deg = (d: number) => (d * Math.PI) / 180;

/** A set of kits keyed by material (one per material a part uses). */
export class Kits {
  private m = new Map<Material, Kit>();
  of(mat: Material): Kit {
    let k = this.m.get(mat);
    if (!k) this.m.set(mat, (k = new Kit()));
    return k;
  }
  emit(w: GriffithWorld, parent?: Object3D): number {
    let tris = 0;
    for (const [mat, k] of this.m) {
      tris += k.triangles;
      k.emit(w, mat, parent);
    }
    this.m.clear();
    return tris;
  }

  /** Triangles per material so far (for the budget log). */
  tally(): string {
    return [...this.m].map(([mat, k]) => `${mat.name.replace("griffith-", "")} ${k.triangles}`).join(", ");
  }
}
