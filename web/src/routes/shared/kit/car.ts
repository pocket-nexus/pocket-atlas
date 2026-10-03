import { BufferAttribute, BufferGeometry, CanvasTexture, Color, Group, LatheGeometry, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, SRGBColorSpace, Vector2, type Material } from "three";
import { glassMaterial } from "../../../places/shared/glass";
import { KEI, type CarState } from "../drive/vehicle";

/**
 * The car the player drives: an unbranded tall kei wagon (3.395 × 1.475 ×
 * 1.79 m, the class limits) in white, on 12 inch steel wheels and winter
 * tyres, with a mid-winter's road film up its flanks and tail, packed snow
 * in the arches and on the rear bumper and the last snowfall still on the
 * roof. Its root follows the vehicle state; the wheels are children that
 * spin, the front pair also steers. The handheld drives the same nodes by
 * name (`car`, `wheel-fl`, `wheel-fr`, `wheel-rl`, `wheel-rr`): the root is
 * annotated `driven`, so the compiler keeps the hierarchy instead of baking
 * it into the place.
 *
 * Local frame: origin on the road under the centre of mass, −Z forward,
 * +X right, y up.
 *
 * The body is one skin: a side silhouette (an upper chain over the bonnet,
 * screen, roof and tailgate, a lower chain under the bumpers and round the
 * wheel arches) swept across the width with a crown, turned into the flanks
 * through a fillet, and closed by the flanks themselves, which lean in above
 * the belt line and tuck under at the sills. Glass, lamps, seams, wipers,
 * handles and snow are patches laid on that skin a few millimetres proud.
 * Eight materials, each one draw on the handheld.
 */
export interface Car {
  root: Group;
  wheels: Group[];
  /** Lamps whose brightness follows the controls. */
  brake: MeshBasicMaterial;
  head: MeshBasicMaterial;
  /** Places the car for a vehicle state. */
  pose(c: CarState, braking: boolean): void;
}

const LENGTH = 3.395;
const WIDTH = 1.475;
const HEIGHT = 1.79;
const HW = WIDTH / 2;
/**
 * Nose and tail of the body. The vehicle model's centre of mass sits 1.1 m
 * behind the front axle; a kei's overhangs are about 0.53 m ahead of that
 * axle and 0.4 m behind the rear one, so the body lies 0.15 m further back
 * than the model's collision box (`KEI.nose`, `KEI.tail`).
 */
const FRONT = -(KEI.front + 0.53);
const REAR = FRONT + LENGTH;
const AXLE_F = -KEI.front;
const AXLE_R = KEI.rear;
/** Wheel arch radius: 6 cm of air round a 145/80R12 tyre. */
const ARCH = KEI.wheelRadius + 0.06;
/** The body's lowest line (sills, floor). */
const FLOOR = 0.2;
/** Where the bumpers reach furthest (the ends of both chains). */
const NOSE_Y = 0.47;
const TAIL_Y = 0.5;

type P2 = [number, number];
type V3 = [number, number, number];

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** A repeatable hash in 0..1. */
function hash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
/** Smooth value noise in 0..1. */
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Rounds the corners of a chain of [z, y, tangent length]: each becomes a quadratic curve of `seg` segments. */
function rounded(c: [number, number, number][], seg: number): P2[] {
  const out: P2[] = [[c[0][0], c[0][1]]];
  for (let i = 1; i + 1 < c.length; i++) {
    const [pz, py, r] = c[i];
    const a = c[i - 1];
    const b = c[i + 1];
    const la = Math.hypot(a[0] - pz, a[1] - py);
    const lb = Math.hypot(b[0] - pz, b[1] - py);
    const ta = Math.min(r, la * 0.45);
    const tb = Math.min(r, lb * 0.45);
    if (r <= 0) {
      out.push([pz, py]);
      continue;
    }
    const A: P2 = [pz + ((a[0] - pz) / la) * ta, py + ((a[1] - py) / la) * ta];
    const B: P2 = [pz + ((b[0] - pz) / lb) * tb, py + ((b[1] - py) / lb) * tb];
    for (let k = 0; k <= seg; k++) {
      const t = k / seg;
      const u = 1 - t;
      out.push([u * u * A[0] + 2 * u * t * pz + t * t * B[0], u * u * A[1] + 2 * u * t * py + t * t * B[1]]);
    }
  }
  out.push([c[c.length - 1][0], c[c.length - 1][1]]);
  return out;
}

/** Bumper, bonnet, screen, roof and tailgate, nose to tail. */
function upperChain(): P2[] {
  const f = FRONT;
  const b = REAR;
  return rounded(
    [
      [f, NOSE_Y, 0],
      [f + 0.006, 0.6, 0.05],
      [f + 0.03, 0.8, 0.05],
      // The bonnet's leading edge, then a short bonnet rising to the cowl.
      [f + 0.075, 0.935, 0.06],
      [f + 0.3, 0.995, 0.1],
      [f + 0.515, 1.045, 0.04],
      // The screen, bowed a little, to the header.
      [f + 0.793, 1.376, 0.2],
      [f + 1.09, 1.69, 0.12],
      [f + 1.4, 1.765, 0.3],
      [f + 1.95, HEIGHT, 0.5],
      [b - 0.5, 1.775, 0.3],
      // The roof's rear edge and a tailgate leaning 4 cm in a metre.
      [b - 0.13, 1.745, 0.07],
      [b - 0.075, 1.66, 0.05],
      [b - 0.04, 1.02, 0.2],
      [b - 0.012, 0.68, 0.08],
      [b, TAIL_Y, 0],
    ],
    2,
  );
}

/** Under the bumpers, along the sills and round both arches, nose to tail. */
function lowerChain(): P2[] {
  const f = FRONT;
  const b = REAR;
  const nose = rounded(
    [
      [f, NOSE_Y, 0],
      [f + 0.01, 0.36, 0.04],
      [f + 0.05, 0.25, 0.04],
      [f + 0.15, FLOOR, 0.04],
      [AXLE_F - ARCH - 0.012, FLOOR, 0],
    ],
    2,
  );
  const arch = (zc: number): P2[] => {
    const out: P2[] = [];
    const n = 9;
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * Math.PI;
      out.push([zc - ARCH * Math.cos(t), KEI.wheelRadius + ARCH * Math.sin(t)]);
    }
    out.push([zc + ARCH + 0.012, FLOOR]);
    return out;
  };
  const tail = rounded(
    [
      [AXLE_R + ARCH + 0.012, FLOOR, 0],
      [b - 0.04, 0.25, 0.015],
      [b - 0.01, 0.37, 0.04],
      [b, TAIL_Y, 0],
    ],
    2,
  );
  return [...nose, ...arch(AXLE_F), [AXLE_R - ARCH - 0.012, FLOOR], ...arch(AXLE_R), ...tail.slice(1)];
}

/** A chain's point at `z` (chains run nose to tail without turning back). */
function chainAt(c: P2[], z: number): P2 {
  if (z <= c[0][0]) return [c[0][0], c[0][1]];
  for (let i = 0; i + 1 < c.length; i++) {
    if (z <= c[i + 1][0]) {
      const d = c[i + 1][0] - c[i][0];
      const t = d > 1e-9 ? (z - c[i][0]) / d : 0;
      return [z, c[i][1] + (c[i + 1][1] - c[i][1]) * t];
    }
  }
  const l = c[c.length - 1];
  return [l[0], l[1]];
}

/** Half width of the body at a point of its flank: tumblehome above the belt, tuck-under at the sills, taper to nose and tail. */
function halfWidth(z: number, y: number): number {
  let w = HW;
  if (y > 0.92) {
    const t = y - 0.92;
    w -= 0.055 * t + 0.05 * t * t;
  }
  if (y < 0.62) {
    const t = (0.62 - y) / 0.42;
    w -= 0.028 * t * t;
  }
  if (z < -0.85) {
    const t = (-0.85 - z) / (-0.85 - FRONT);
    w -= 0.04 * t * t;
  }
  if (z > 1.0) {
    const t = (z - 1.0) / (REAR - 1.0);
    w -= 0.022 * t * t;
  }
  return w;
}

/** A point of the silhouette loop. */
interface Ring {
  z: number;
  y: number;
  /** Outward normal in the z–y plane. */
  nz: number;
  ny: number;
  /** Fillet radius into the flank and crown across the width. */
  r: number;
  c: number;
  /** Underside (floor and arch liners): black, and flat across. */
  under: boolean;
}

/** The silhouette as a closed loop (upper chain nose to tail, lower chain back) and the arc length to each point. */
class Skin {
  readonly ring: Ring[] = [];
  readonly cum: number[] = [];
  readonly total: number;
  /** Columns: the loop has `2 n` points; column i's top is ring[i], its bottom ring[2n − i]. */
  readonly n: number;

  constructor() {
    const up = upperChain();
    const lo = lowerChain();
    // Columns at every point of either chain.
    const zs = [...up.map((p) => p[0]), ...lo.map((p) => p[0])].sort((a, b) => a - b);
    const st: number[] = [];
    for (const z of zs) if (!st.length || z - st[st.length - 1] > 0.003) st.push(z);
    st[st.length - 1] = REAR;
    const n = st.length - 1;
    this.n = n;
    const pts: P2[] = [];
    for (let i = 0; i <= n; i++) pts.push(chainAt(up, st[i]));
    for (let i = n - 1; i >= 1; i--) pts.push(chainAt(lo, st[i]));
    const m = pts.length;
    const inArch = (z: number) => Math.abs(z - AXLE_F) < ARCH + 0.013 || Math.abs(z - AXLE_R) < ARCH + 0.013;
    for (let i = 0; i < m; i++) {
      const a = pts[(i + m - 1) % m];
      const b = pts[(i + 1) % m];
      const p = pts[i];
      // The loop runs nose → roof → tail → floor: outward is to the left of travel in (z, y).
      let tz = b[0] - a[0];
      let ty = b[1] - a[1];
      const l = Math.hypot(tz, ty) || 1;
      tz /= l;
      ty /= l;
      const nz = -ty;
      const ny = tz;
      const lower = i > n;
      let r: number;
      let c: number;
      let under = false;
      if (!lower) {
        r = 0.06 + (nz < 0 ? 0.05 : 0.03) * nz * nz;
        c = 0.02 + (nz < 0 ? 0.035 : 0.015) * nz * nz;
      } else if (p[0] < FRONT + 0.16) {
        r = 0.03 + 0.08 * nz * nz;
        c = 0.055 * nz * nz;
      } else if (p[0] > REAR - 0.045) {
        r = 0.03 + 0.06 * nz * nz;
        c = 0.035 * nz * nz;
      } else {
        r = inArch(p[0]) && p[1] > FLOOR + 0.001 ? 0.02 : 0.03;
        c = 0;
        under = true;
      }
      this.ring.push({ z: p[0], y: p[1], nz, ny, r, c, under });
    }
    let s = 0;
    for (let i = 0; i < m; i++) {
      this.cum.push(s);
      const a = pts[i];
      const b = pts[(i + 1) % m];
      s += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    this.total = s;
  }

  /** The loop at arc length `l` (wraps). */
  at(l: number): Ring {
    const m = this.ring.length;
    l = ((l % this.total) + this.total) % this.total;
    let i = 0;
    let lo = 0;
    let hi = m - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= l) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const a = this.ring[i];
    const b = this.ring[(i + 1) % m];
    const end = i + 1 < m ? this.cum[i + 1] : this.total;
    const t = end > this.cum[i] ? (l - this.cum[i]) / (end - this.cum[i]) : 0;
    let nz = a.nz + (b.nz - a.nz) * t;
    let ny = a.ny + (b.ny - a.ny) * t;
    const nl = Math.hypot(nz, ny) || 1;
    nz /= nl;
    ny /= nl;
    return { z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t, nz, ny, r: a.r + (b.r - a.r) * t, c: a.c + (b.c - a.c) * t, under: a.under };
  }

  /** Arc length of the upper chain's point at `z` (bonnet, screen, roof). */
  lz(z: number): number {
    for (let i = 0; i < this.n; i++) {
      const a = this.ring[i];
      const b = this.ring[i + 1];
      if (z <= b.z) return this.cum[i] + (this.cum[i + 1] - this.cum[i]) * clamp((z - a.z) / Math.max(1e-9, b.z - a.z), 0, 1);
    }
    return this.cum[this.n];
  }

  /** Arc length of the nose's point at height `y` (negative below the bumper's line: it wraps). */
  front(y: number): number {
    const m = this.ring.length;
    if (y >= NOSE_Y) {
      for (let i = 0; i < this.n; i++) {
        const a = this.ring[i];
        const b = this.ring[i + 1];
        if (y <= b.y) return this.cum[i] + (this.cum[i + 1] - this.cum[i]) * clamp((y - a.y) / Math.max(1e-9, b.y - a.y), 0, 1);
      }
      return this.cum[this.n];
    }
    let l = 0;
    for (let i = m; i > this.n + 1; i--) {
      const a = this.ring[i % m];
      const b = this.ring[i - 1];
      const d = Math.hypot(b.z - a.z, b.y - a.y);
      if (y >= b.y) return -(l + d * clamp((a.y - y) / Math.max(1e-9, a.y - b.y), 0, 1));
      l += d;
    }
    return -l;
  }

  /** Arc length of the tail's point at height `y`. */
  rear(y: number): number {
    const n = this.n;
    if (y >= TAIL_Y) {
      for (let i = n; i > 0; i--) {
        const a = this.ring[i];
        const b = this.ring[i - 1];
        if (y <= b.y) return this.cum[i] - (this.cum[i] - this.cum[i - 1]) * clamp((y - a.y) / Math.max(1e-9, b.y - a.y), 0, 1);
      }
      return 0;
    }
    for (let i = n; i + 1 < this.ring.length; i++) {
      const a = this.ring[i];
      const b = this.ring[i + 1];
      if (y >= b.y) return this.cum[i] + (this.cum[i + 1] - this.cum[i]) * clamp((a.y - y) / Math.max(1e-9, a.y - b.y), 0, 1);
    }
    return this.cum[n];
  }

  /** The swept skin at arc length `l` and `d` metres across from the centre line (past the flat part it turns down the fillet). */
  sweep(l: number, d: number): V3 {
    return sweepPoint(this.at(l), d);
  }
}

function sweepPoint(k: Ring, d: number): V3 {
  const qz = k.z - k.nz * k.r;
  const qy = k.y - k.ny * k.r;
  const flat = halfWidth(qz, qy) - k.r;
  const a = Math.abs(d);
  if (a <= flat) {
    const t = d / flat;
    const c = k.c * (1 - t * t);
    return [d, k.y + k.ny * c, k.z + k.nz * c];
  }
  const th = Math.min((a - flat) / k.r, Math.PI / 2);
  const x = flat + k.r * Math.sin(th);
  return [Math.sign(d) * x, qy + k.ny * k.r * Math.cos(th), qz + k.nz * k.r * Math.cos(th)];
}

/** Triangles of one material: positions, normals and UVs as they will be uploaded. */
class Part {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  get count(): number {
    return this.pos.length / 3;
  }
  vertex(p: V3, n: V3, u = 0, v = 0): number {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    return this.count - 1;
  }
  /** A triangle wound to face its vertices' normals. */
  tri(a: number, b: number, c: number): void {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3];
    const uy = p[b * 3 + 1] - p[a * 3 + 1];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vy = p[c * 3 + 1] - p[a * 3 + 1];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    if (fx * fx + fy * fy + fz * fz < 1e-14) return;
    const n = this.nrm;
    const d = fx * (n[a * 3] + n[b * 3] + n[c * 3]) + fy * (n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1]) + fz * (n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2]);
    if (d >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }
  /** Replaces the normals of the vertices from `base` on with those of the faces from index `first` on (a relief laid on a surface). */
  smooth(base: number, first: number): void {
    const p = this.pos;
    const acc = new Float64Array((this.count - base) * 3);
    for (let t = first; t < this.idx.length; t += 3) {
      const [a, b, c] = [this.idx[t], this.idx[t + 1], this.idx[t + 2]];
      const ux = p[b * 3] - p[a * 3];
      const uy = p[b * 3 + 1] - p[a * 3 + 1];
      const uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3];
      const vy = p[c * 3 + 1] - p[a * 3 + 1];
      const vz = p[c * 3 + 2] - p[a * 3 + 2];
      const f = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      for (const v of [a, b, c]) for (let k = 0; k < 3; k++) acc[(v - base) * 3 + k] += f[k];
    }
    for (let v = base; v < this.count; v++) {
      const o = (v - base) * 3;
      const l = Math.hypot(acc[o], acc[o + 1], acc[o + 2]);
      if (l > 1e-12) for (let k = 0; k < 3; k++) this.nrm[v * 3 + k] = acc[o + k] / l;
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(Float32Array.from(this.pos), 3));
    g.setAttribute("normal", new BufferAttribute(Float32Array.from(this.nrm), 3));
    g.setAttribute("uv", new BufferAttribute(Float32Array.from(this.uv), 2));
    g.setIndex(this.idx);
    return g;
  }
}

type Surf = (a: number, b: number) => V3;
type MatName = "paint" | "trim" | "glass" | "brake" | "head" | "snow";

/** Where the paint's road film is looked up: side elevation over 0.7 of the width, the tail's own strip beyond. */
function paintUv(p: V3, n: V3): [number, number] {
  const zn = clamp((p[2] - FRONT) / LENGTH, 0, 1);
  const tail = Math.max(n[2], 0);
  return [clamp(0.7 * zn + 0.3 * (1 - Math.abs(p[0]) / HW) * tail * tail, 0.002, 0.998), clamp(p[1] / 1.8, 0.002, 0.998)];
}
/** A clean spot of the paint texture, and the plate's yellow in its corner. */
const UV_CLEAN: [number, number] = [0.33, 0.92];
const UV_PLATE: [number, number] = [0.03, 0.97];
/**
 * Snow in the same texture, in the strip beside the plate (above anything
 * the nose reaches): clean at its left end, then dirtier and dirtier slush.
 */
const SNOW_BOX = { u0: 36 / 512, u1: 112 / 512, v0: 1 - 14 / 256, v1: 1 };
const UV_SNOW: [number, number] = [SNOW_BOX.u0 + 4 / 512, 1 - 7 / 256];
/** A spot of the snow strip: `dirt` 0 clean … 1 slush, `k` across the strip's height. */
const snowUv = (dirt: number, k: number): [number, number] => [SNOW_BOX.u0 + (10 + 62 * clamp(dirt, 0, 1)) / 512, SNOW_BOX.v0 + ((2 + 10 * clamp(k, 0, 1)) / 256)];

class Builder {
  readonly skin = new Skin();
  readonly parts: Record<MatName, Part> = { paint: new Part(), trim: new Part(), glass: new Part(), brake: new Part(), head: new Part(), snow: new Part() };

  /** The swept skin, by arc length and metres across. */
  readonly top: Surf = (l, d) => this.skin.sweep(l, d);
  /** A flank, by z and y. */
  side(sign: number): Surf {
    return (z, y) => [sign * halfWidth(z, y), y, z];
  }

  /** Outward normal of a surface at a point, from differences. */
  private normal(s: Surf, a: number, b: number): V3 {
    const e = 0.004;
    const p0 = s(a - e, b);
    const p1 = s(a + e, b);
    const q0 = s(a, b - e);
    const q1 = s(a, b + e);
    const u: V3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const v: V3 = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]];
    let n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / l, n[1] / l, n[2] / l];
    // Outward: away from the cabin's middle.
    const p = s(a, b);
    if (n[0] * p[0] + n[1] * (p[1] - 0.85) + n[2] * (p[2] - 0.1) < 0) n = [-n[0], -n[1], -n[2]];
    return n;
  }

  /**
   * A four-cornered patch on a surface, `lift` metres proud of it, with its
   * corners rounded to `radius` metres. Corners are the surface's own
   * coordinates, in order round the patch; `na` × `nb` cells between the
   * rounded corners. `lift` may vary over the patch (s, t in 0..1 and the
   * distance to its edge in the same units).
   */
  patch(mat: MatName, s: Surf, corners: [P2, P2, P2, P2], radius: number, na: number, nb: number, lift: number | ((u: number, v: number, edge: number) => number), uv?: [number, number] | ((u: number, v: number) => [number, number])): void {
    const [c0, c1, c2, c3] = corners;
    const la = (Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) + Math.hypot(c2[0] - c3[0], c2[1] - c3[1])) / 2;
    const lb = (Math.hypot(c3[0] - c0[0], c3[1] - c0[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1])) / 2;
    const ra = Math.min(0.45, radius / Math.max(1e-6, la));
    const rb = Math.min(0.45, radius / Math.max(1e-6, lb));
    const lines = (r: number, n: number): number[] => {
      const out = r > 0 ? [0, r / 2, r] : [0];
      for (let k = 1; k < n; k++) out.push(r + ((1 - 2 * r) * k) / n);
      if (r > 0) out.push(1 - r, 1 - r / 2, 1);
      else out.push(1);
      return out;
    };
    const us = lines(ra, na);
    const vs = lines(rb, nb);
    // A corner cell's square becomes a quarter disc.
    const round = (u: number, r: number, v: number, q: number): [number, number] => {
      if (r <= 0 || q <= 0) return [u, v];
      const cu = u < r ? (r - u) / r : u > 1 - r ? (u - (1 - r)) / r : 0;
      const cv = v < q ? (q - v) / q : v > 1 - q ? (v - (1 - q)) / q : 0;
      if (cu <= 0 || cv <= 0) return [u, v];
      const k = Math.max(cu, cv) / Math.hypot(cu, cv);
      const nu = cu * k;
      const nv = cv * k;
      return [u < 0.5 ? r - nu * r : 1 - r + nu * r, v < 0.5 ? q - nv * q : 1 - q + nv * q];
    };
    const part = this.parts[mat];
    const base = part.count;
    const first = part.idx.length;
    for (let j = 0; j < vs.length; j++)
      for (let i = 0; i < us.length; i++) {
        const [u, v] = round(us[i], ra, vs[j], rb);
        const a = (c0[0] * (1 - u) + c1[0] * u) * (1 - v) + (c3[0] * (1 - u) + c2[0] * u) * v;
        const b = (c0[1] * (1 - u) + c1[1] * u) * (1 - v) + (c3[1] * (1 - u) + c2[1] * u) * v;
        const p = s(a, b);
        const n = this.normal(s, a, b);
        const rim = i === 0 || j === 0 || i === us.length - 1 || j === vs.length - 1;
        const edge = rim ? 0 : Math.min(u * la, (1 - u) * la, v * lb, (1 - v) * lb);
        const h = typeof lift === "number" ? lift : lift(u, v, edge);
        const w: V3 = [p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h];
        const t = typeof uv === "function" ? uv(u, v) : (uv ?? (mat === "paint" ? paintUv(w, n) : [u, v]));
        part.vertex(w, n, t[0], t[1]);
      }
    const nu = us.length;
    for (let j = 0; j + 1 < vs.length; j++)
      for (let i = 0; i + 1 < nu; i++) {
        const a = base + j * nu + i;
        part.tri(a, a + 1, a + nu + 1);
        part.tri(a, a + nu + 1, a + nu);
      }
    if (typeof lift !== "number") part.smooth(base, first);
  }

  /** A line drawn on a surface: a strip `width` metres wide along a path in the surface's coordinates. */
  strip(mat: MatName, s: Surf, path: P2[], width: number, lift: number, steps = 1): void {
    const pts: P2[] = [];
    for (let i = 0; i + 1 < path.length; i++) for (let k = 0; k < steps; k++) pts.push([path[i][0] + ((path[i + 1][0] - path[i][0]) * k) / steps, path[i][1] + ((path[i + 1][1] - path[i][1]) * k) / steps]);
    pts.push(path[path.length - 1]);
    const part = this.parts[mat];
    const base = part.count;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      const l = Math.hypot(tx, ty) || 1;
      tx /= l;
      ty /= l;
      for (const side of [-1, 1]) {
        const qa = pts[i][0] - ty * side * width * 0.5;
        const qb = pts[i][1] + tx * side * width * 0.5;
        const p = s(qa, qb);
        const n = this.normal(s, qa, qb);
        part.vertex([p[0] + n[0] * lift, p[1] + n[1] * lift, p[2] + n[2] * lift], n, UV_CLEAN[0], UV_CLEAN[1]);
      }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = base + i * 2;
      part.tri(a, a + 1, a + 3);
      part.tri(a, a + 3, a + 2);
    }
  }

  /** An ellipsoid (mirror housings, wiper pivots). */
  blob(mat: MatName, c: V3, r: V3, seg = 8, rings = 5): void {
    const part = this.parts[mat];
    const base = part.count;
    for (let j = 0; j <= rings; j++) {
      const ph = (j / rings) * Math.PI;
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        const n: V3 = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
        const nn: V3 = [n[0] / r[0], n[1] / r[1], n[2] / r[2]];
        const l = Math.hypot(nn[0], nn[1], nn[2]) || 1;
        part.vertex([c[0] + n[0] * r[0], c[1] + n[1] * r[1], c[2] + n[2] * r[2]], [nn[0] / l, nn[1] / l, nn[2] / l], UV_CLEAN[0], UV_CLEAN[1]);
      }
    }
    for (let j = 0; j < rings; j++)
      for (let i = 0; i < seg; i++) {
        const a = base + j * (seg + 1) + i;
        part.tri(a, a + 1, a + seg + 2);
        part.tri(a, a + seg + 2, a + seg + 1);
      }
  }

  /** The body's skin: the sweep, the fillets and both flanks, in paint, with the underside and arch liners in black. */
  body(): void {
    const { ring, n } = this.skin;
    const m = ring.length;
    const ARC = 2;
    const FLAT = 6;
    // Vertices shared across the skin; normals come from the faces.
    const pos: number[] = [];
    const add = (p: V3): number => {
      pos.push(p[0], p[1], p[2]);
      return pos.length / 3 - 1;
    };
    /** Faces as a, b, c and the direction each should face. */
    const faces: { paint: [number, number, number, V3][]; trim: [number, number, number, V3][] } = { paint: [], trim: [] };
    /** Per ring point: its vertices left to right (fillet, the flat part edge to edge, fillet). */
    const rows: number[][] = [];
    for (let i = 0; i < m; i++) {
      const k = ring[i];
      const flat = halfWidth(k.z - k.nz * k.r, k.y - k.ny * k.r) - k.r;
      const arcLen = (k.r * Math.PI) / 2;
      const row: number[] = [];
      for (let a = ARC; a >= 1; a--) row.push(add(sweepPoint(k, -(flat + (arcLen * a) / ARC))));
      const seg = k.c < 1e-5 ? 1 : FLAT;
      for (let j = 0; j <= seg; j++) row.push(add(sweepPoint(k, -flat + (2 * flat * j) / seg)));
      for (let a = 1; a <= ARC; a++) row.push(add(sweepPoint(k, flat + (arcLen * a) / ARC)));
      rows.push(row);
    }
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ra = rows[i];
      const rb = rows[j];
      const ka = ring[i];
      const kb = ring[j];
      const up: V3 = [0, ka.ny + kb.ny, ka.nz + kb.nz];
      const mid = ka.under || kb.under ? faces.trim : faces.paint;
      // Fillets: always paint (the sill's roll, the arch's lip).
      for (let a = 0; a < ARC; a++) {
        for (const sign of [-1, 1]) {
          const ia = sign < 0 ? a : ra.length - 1 - a;
          const ib = sign < 0 ? a : rb.length - 1 - a;
          const step = sign < 0 ? 1 : -1;
          const w: V3 = [sign * 1.5, up[1], up[2]];
          faces.paint.push([ra[ia], ra[ia + step], rb[ib + step], w]);
          faces.paint.push([ra[ia], rb[ib + step], rb[ib], w]);
        }
      }
      const fa = ra.slice(ARC, ra.length - ARC);
      const fb = rb.slice(ARC, rb.length - ARC);
      if (fa.length === fb.length) {
        for (let q = 0; q + 1 < fa.length; q++) {
          mid.push([fa[q], fa[q + 1], fb[q + 1], up]);
          mid.push([fa[q], fb[q + 1], fb[q], up]);
        }
      } else {
        // A flat row meets a crowned one: fans from the flat row's two ends.
        const few = fa.length < fb.length ? fa : fb;
        const many = fa.length < fb.length ? fb : fa;
        const half = (many.length - 1) >> 1;
        for (let q = 0; q < half; q++) mid.push([few[0], many[q], many[q + 1], up]);
        mid.push([few[0], many[half], few[1], up]);
        for (let q = half; q + 1 < many.length; q++) mid.push([few[1], many[q], many[q + 1], up]);
      }
    }
    // Flanks: columns from the lower chain's fillet to the upper one's, rows at fixed heights.
    const LEVELS = [0.34, 0.5, 0.72, 0.96, 1.2, 1.45];
    for (const sign of [-1, 1]) {
      const cols: number[][] = [];
      for (let i = 0; i <= n; i++) {
        const topRow = rows[i];
        const botRow = rows[(m - i) % m];
        const top = sign < 0 ? topRow[0] : topRow[topRow.length - 1];
        const bot = sign < 0 ? botRow[0] : botRow[botRow.length - 1];
        const ty = pos[top * 3 + 1];
        const tz = pos[top * 3 + 2];
        const by = pos[bot * 3 + 1];
        const bz = pos[bot * 3 + 2];
        const col = [bot];
        for (const y of LEVELS) {
          if (i === 0 || i === n || y <= by + 0.004) col.push(bot);
          else if (y >= ty - 0.004) col.push(top);
          else col.push(add([sign * halfWidth(bz + ((tz - bz) * (y - by)) / (ty - by), y), y, bz + ((tz - bz) * (y - by)) / (ty - by)]));
        }
        col.push(top);
        cols.push(col);
      }
      const w: V3 = [sign, 0, 0];
      for (let i = 0; i < n; i++)
        for (let q = 0; q + 1 < cols[i].length; q++) {
          const a = cols[i][q];
          const b = cols[i + 1][q];
          const c = cols[i + 1][q + 1];
          const d = cols[i][q + 1];
          if (a !== b && b !== c && a !== c) faces.paint.push([a, b, c, w]);
          if (a !== c && c !== d && a !== d) faces.paint.push([a, c, d, w]);
        }
    }
    // Wind every face outward, then smooth normals per material over the shared vertices.
    for (const name of ["paint", "trim"] as const) {
      const acc = new Float64Array(pos.length);
      const out: number[] = [];
      for (const [a, b0, c0, w] of faces[name]) {
        let b = b0;
        let c = c0;
        const ux = pos[b * 3] - pos[a * 3];
        const uy = pos[b * 3 + 1] - pos[a * 3 + 1];
        const uz = pos[b * 3 + 2] - pos[a * 3 + 2];
        const vx = pos[c * 3] - pos[a * 3];
        const vy = pos[c * 3 + 1] - pos[a * 3 + 1];
        const vz = pos[c * 3 + 2] - pos[a * 3 + 2];
        let fx = uy * vz - uz * vy;
        let fy = uz * vx - ux * vz;
        let fz = ux * vy - uy * vx;
        if (fx * fx + fy * fy + fz * fz < 1e-14) continue;
        if (fx * w[0] + fy * w[1] + fz * w[2] < 0) {
          [b, c] = [c, b];
          fx = -fx;
          fy = -fy;
          fz = -fz;
        }
        out.push(a, b, c);
        for (const v of [a, b, c]) {
          acc[v * 3] += fx;
          acc[v * 3 + 1] += fy;
          acc[v * 3 + 2] += fz;
        }
      }
      const part = this.parts[name];
      const map = new Map<number, number>();
      for (const v of out) {
        let k = map.get(v);
        if (k === undefined) {
          const l = Math.hypot(acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]) || 1;
          const p: V3 = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
          const nn: V3 = [acc[v * 3] / l, acc[v * 3 + 1] / l, acc[v * 3 + 2] / l];
          const t = name === "paint" ? paintUv(p, nn) : [0, 0];
          k = part.vertex(p, nn, t[0], t[1]);
          map.set(v, k);
        }
        part.idx.push(k);
      }
    }
  }

  /** Snow packed into an arch: a slab against the liner between two angles (0 at the front of the arch, π at the back). */
  archSnow(zc: number, sign: number, t0: number, t1: number, thick: number, seed: number): void {
    const part = this.parts.snow;
    const steps = 9;
    const inner: number[] = [];
    const face: number[] = [];
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const th = t0 + (t1 - t0) * u;
      const cz = -Math.cos(th);
      const cy = Math.sin(th);
      const t = thick * Math.sin(Math.PI * u) ** 0.7 * (0.35 + 0.6 * vnoise(u * 5.3 + seed, seed * 1.7) + 0.4 * vnoise(u * 11.7 + seed * 3.1, 0.5));
      const z0 = zc + ARCH * cz;
      const y0 = KEI.wheelRadius + ARCH * cy;
      const z1 = zc + (ARCH - t) * cz;
      const y1 = KEI.wheelRadius + (ARCH - t) * cy;
      const x1 = halfWidth(z0, y0) - 0.006;
      const x0 = x1 - 0.17;
      // The face seen from the side, and the underside seen from behind and below.
      const [su, sv] = snowUv(0.35 + 0.5 * vnoise(u * 6.1 + seed, 2.5), u);
      face.push(part.vertex([sign * x1, y0, z0], [sign, 0, 0], su, sv), part.vertex([sign * x1, y1, z1], [sign, 0, 0], su, sv));
      inner.push(part.vertex([sign * x1, y1, z1], [0, -cy, -cz], su, sv), part.vertex([sign * x0, y1, z1], [0, -cy, -cz], su, sv));
    }
    for (let k = 0; k < steps; k++) {
      part.tri(face[k * 2], face[k * 2 + 1], face[k * 2 + 3]);
      part.tri(face[k * 2], face[k * 2 + 3], face[k * 2 + 2]);
      part.tri(inner[k * 2], inner[k * 2 + 1], inner[k * 2 + 3]);
      part.tri(inner[k * 2], inner[k * 2 + 3], inner[k * 2 + 2]);
    }
  }
}

/** Everything laid on the skin. */
function details(b: Builder): void {
  const k = b.skin;
  const top = b.top;
  const f = FRONT;
  const r = REAR;
  const F = (y: number) => k.front(y);
  const R = (y: number) => k.rear(y);
  const Z = (z: number) => k.lz(z);
  const SEAM = 0.008;

  // ── Nose: lamps, grille, intake, plate, the bonnet's shut lines.
  for (const sx of [-1, 1]) {
    b.patch("head", top, [[F(0.7), sx * 0.34], [F(0.7), sx * 0.71], [F(0.865), sx * 0.7], [F(0.865), sx * 0.3]], 0.03, 3, 1, 0.006);
    b.strip("trim", top, [[F(0.91), sx * 0.61], [Z(f + 0.5), sx * 0.625]], SEAM, 0.003, 5);
  }
  b.patch("trim", top, [[F(0.735), -0.28], [F(0.735), 0.28], [F(0.84), 0.28], [F(0.84), -0.28]], 0.02, 4, 1, 0.004);
  b.patch("trim", top, [[F(0.28), -0.46], [F(0.28), 0.46], [F(0.425), 0.46], [F(0.425), -0.46]], 0.03, 4, 2, 0.004);
  b.patch("paint", top, [[F(0.495), -0.165], [F(0.495), 0.165], [F(0.66), 0.165], [F(0.66), -0.165]], 0.008, 2, 1, 0.012, UV_PLATE);
  b.strip("trim", top, [[F(0.91), -0.61], [F(0.91), 0.61]], SEAM, 0.003, 6);

  // ── Screen: cowl, glass, two wipers parked along its foot.
  b.patch("trim", top, [[Z(f + 0.47), -0.625], [Z(f + 0.47), 0.625], [Z(f + 0.56), 0.625], [Z(f + 0.56), -0.625]], 0.02, 4, 1, 0.003);
  b.patch("glass", top, [[Z(f + 0.545), -0.605], [Z(f + 0.545), 0.605], [Z(f + 1.065), 0.545], [Z(f + 1.065), -0.545]], 0.05, 6, 4, 0.006);
  b.strip("trim", top, [[Z(f + 0.575), 0.52], [Z(f + 0.6), 0.03]], 0.022, 0.018, 4);
  b.strip("trim", top, [[Z(f + 0.575), -0.06], [Z(f + 0.6), -0.53]], 0.022, 0.018, 4);
  b.strip("trim", top, [[Z(f + 0.535), 0.3], [Z(f + 0.588), 0.25]], 0.012, 0.02, 1);
  b.strip("trim", top, [[Z(f + 0.535), -0.28], [Z(f + 0.588), -0.31]], 0.012, 0.02, 1);

  // ── Roof: what the last snowfall left, thinned at the front by the wind.
  b.patch("snow", top, [[Z(f + 1.2), -0.6], [Z(f + 1.2), 0.6], [Z(r - 0.16), 0.585], [Z(r - 0.16), -0.585]], 0.1, 7, 9, (u, v, edge) => {
    if (edge < 1e-5) return 0.001;
    const lump = vnoise(u * 5.1 + 3.7, v * 7.3 + 1.1);
    return 0.008 + (0.03 + 0.045 * smooth(0.0, 0.45, v) + 0.03 * lump) * smooth(0, 0.06, edge) ** 0.6;
  }, UV_SNOW);

  // ── Tail: window, lamps, plate, the gate's shut lines, wiper, the bumper's black foot and the snow packed on it.
  b.patch("glass", top, [[R(1.1), -0.535], [R(1.1), 0.535], [R(1.6), 0.505], [R(1.6), -0.505]], 0.05, 5, 3, 0.006);
  b.patch("brake", top, [[R(1.56), -0.12], [R(1.56), 0.12], [R(1.587), 0.12], [R(1.587), -0.12]], 0.006, 1, 1, 0.01);
  for (const sx of [-1, 1]) {
    b.patch("brake", top, [[R(0.93), sx * 0.575], [R(0.93), sx * 0.725], [R(1.42), sx * 0.69], [R(1.42), sx * 0.56]], 0.025, 2, 4, 0.006);
    b.strip("trim", top, [[R(1.09), sx * 0.57], [R(1.09), sx * 0.73]], 0.012, 0.009, 2);
    b.strip("trim", top, [[R(1.25), sx * 0.565], [R(1.25), sx * 0.725]], 0.012, 0.009, 2);
    b.strip("trim", top, [[R(0.62), sx * 0.555], [R(1.69), sx * 0.525]], SEAM, 0.003, 8);
    // The bumper's joint with the body, round the corner to the arch.
    b.strip("trim", top, [[R(0.61), sx * 0.555], [R(0.61), sx * 0.77]], SEAM, 0.003, 4);
  }
  b.strip("trim", top, [[R(0.62), -0.555], [R(0.62), 0.555]], SEAM, 0.003, 6);
  b.patch("paint", top, [[R(0.71), -0.165], [R(0.71), 0.165], [R(0.875), 0.165], [R(0.875), -0.165]], 0.008, 2, 1, 0.012, UV_PLATE);
  b.patch("trim", top, [[R(0.9), -0.26], [R(0.9), 0.26], [R(0.95), 0.26], [R(0.95), -0.26]], 0.015, 3, 1, 0.012);
  b.strip("trim", top, [[R(1.135), 0.03], [R(1.17), -0.36]], 0.02, 0.018, 3);
  b.patch("trim", top, [[R(0.265), -0.52], [R(0.265), 0.52], [R(0.4), 0.52], [R(0.4), -0.52]], 0.03, 4, 2, 0.004);
  // Caked over the bumper up to the gate's sill, thickest at the corners where the wheels throw it.
  b.patch("snow", top, [[R(0.275), -0.73], [R(0.275), 0.73], [R(0.59), 0.74], [R(0.59), -0.74]], 0.05, 12, 3, (u, v, edge) => {
    if (edge < 1e-5) return 0.001;
    const lump = vnoise(u * 13.1 + 0.4, v * 3.3 + 5.2);
    const corner = Math.abs(u - 0.5) * 2;
    return 0.004 + (0.004 + (0.012 + 0.03 * corner * corner) * lump * lump * 2 + 0.012 * vnoise(u * 31.0, v * 9.0)) * smooth(0, 0.035, edge) * (1 - 0.55 * v);
  }, (u, v) => snowUv(0.25 + 0.75 * vnoise(u * 9.0 + 2.2, v * 2.5 + 0.7) - 0.3 * v, v));

  // ── Flanks: glass, shut lines, handles, the sliding door's rail, mirrors, snow in the arches.
  for (const sx of [-1, 1]) {
    const s = b.side(sx);
    b.patch("glass", s, [[-0.975, 1.035], [-0.1, 1.035], [-0.1, 1.62], [-0.47, 1.62]], 0.04, 3, 3, 0.005);
    b.patch("glass", s, [[-0.02, 1.035], [0.88, 1.035], [0.88, 1.62], [-0.02, 1.62]], 0.04, 3, 3, 0.005);
    b.patch("glass", s, [[0.96, 1.035], [1.53, 1.035], [1.5, 1.62], [0.96, 1.62]], 0.04, 2, 3, 0.005);
    b.strip("trim", s, [[-0.735, 0.25], [-0.735, 1.0]], SEAM, 0.003, 4);
    b.strip("trim", s, [[-0.06, 0.25], [-0.06, 1.645]], SEAM, 0.003, 7);
    b.strip("trim", s, [[0.92, 0.25], [0.92, 1.645]], SEAM, 0.003, 7);
    b.strip("trim", s, [[-0.735, 0.25], [0.92, 0.25]], SEAM, 0.003, 4);
    b.strip("trim", s, [[0.95, 0.99], [1.6, 0.99]], 0.014, 0.003, 3);
    b.patch("trim", s, [[-0.23, 0.925], [-0.09, 0.925], [-0.09, 0.965], [-0.23, 0.965]], 0.012, 1, 1, 0.014);
    b.patch("trim", s, [[-0.03, 0.925], [0.11, 0.925], [0.11, 0.965], [-0.03, 0.965]], 0.012, 1, 1, 0.014);
    const mx = halfWidth(-0.94, 1.1);
    b.blob("trim", [sx * (mx + 0.115), 1.115, -0.94], [0.095, 0.065, 0.045]);
    b.blob("trim", [sx * (mx + 0.02), 1.075, -0.95], [0.05, 0.02, 0.03], 6, 4);
    b.archSnow(AXLE_F, sx, Math.PI * 0.58, Math.PI * 0.97, 0.05, 1.3 + sx);
    b.archSnow(AXLE_F, sx, Math.PI * 0.06, Math.PI * 0.28, 0.03, 4.1 + sx);
    b.archSnow(AXLE_R, sx, Math.PI * 0.6, Math.PI * 0.97, 0.055, 7.7 + sx);
    b.archSnow(AXLE_R, sx, Math.PI * 0.05, Math.PI * 0.3, 0.035, 9.2 + sx);
  }
  // Fuel flap, on the left.
  const left = b.side(-1);
  b.strip("trim", left, [[1.13, 0.8], [1.27, 0.8], [1.27, 0.93], [1.13, 0.93], [1.13, 0.8]], 0.006, 0.003, 1);
}

/**
 * The paint's colour over the body: clean white above, a brown-grey road
 * film rising from the sills, thickest behind each wheel and over the whole
 * tail (the right-hand 0.3 of the texture: the tail seen from behind, edge
 * to centre line), with snow dust caught in it. The plate's yellow sits in
 * the top left corner, where the nose never reaches.
 */
function paintTexture(): CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const w = 512;
  const h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const img = g.createImageData(w, h);
  const clean = [214, 216, 217];
  const grime = [128, 119, 107];
  const dust = [236, 239, 243];
  const fb = (x: number, y: number) => 0.5 * vnoise(x, y) + 0.3 * vnoise(x * 2.1 + 7, y * 2.1 + 3) + 0.2 * vnoise(x * 4.3 + 1, y * 4.3 + 9);
  for (let py = 0; py < h; py++) {
    const y = (1 - (py + 0.5) / h) * 1.8;
    for (let px = 0; px < w; px++) {
      const u = (px + 0.5) / w;
      let d: number;
      let snow = 0;
      if (u < 0.7) {
        const z = FRONT + (u / 0.7) * LENGTH;
        // The film: heavy under the belt's lower third, spray fans behind the wheels drawn back by the air.
        d = 0.7 * (1 - smooth(0.22, 0.75, y)) + 0.14 * (1 - smooth(0.6, 1.25, y));
        for (const zc of [AXLE_F, AXLE_R]) {
          const back = z - zc;
          d += 0.5 * smooth(-0.15, 0.3, back) * Math.exp(-Math.max(back, 0) / 0.75) * (1 - smooth(0.35, 1.0 + 0.25 * Math.exp(-Math.max(back, 0) / 0.4), y));
        }
        // Toward the tail the eddy lifts it higher.
        d += 0.3 * smooth(0.9, 1.75, z) * (1 - smooth(0.6, 1.5, y));
        // Streaks along the flow.
        d *= 0.62 + 0.76 * fb(z * 2.2, y * 13);
        snow = smooth(0.52, 0.8, fb(z * 6 + 11, y * 9)) * (1 - smooth(0.2, 0.5, y));
      } else {
        const x = (u - 0.7) / 0.3;
        d = 0.7 * (1 - smooth(0.3, 0.95, y)) + 0.26 * (1 - smooth(0.9, 1.75, y)) + 0.05;
        d *= 0.7 + 0.6 * fb(x * 5 + 20, y * 6);
        // Finger-wide runs of meltwater under the window and the lamps.
        d *= 0.95 + 0.1 * vnoise(x * 30, y * 1.5);
        snow = smooth(0.5, 0.75, fb(x * 7 + 3, y * 8 + 1)) * (1 - smooth(0.3, 0.75, y));
      }
      d = clamp(d, 0, 0.92);
      const speck = hash(px, py);
      d = clamp(d + (speck - 0.5) * 0.08 * d, 0, 1);
      const o = (py * w + px) * 4;
      for (let k = 0; k < 3; k++) {
        let v = clean[k] + (grime[k] - clean[k]) * d;
        v += (dust[k] - v) * snow * 0.75;
        img.data[o + k] = v;
      }
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Kei private plate: yellow, blank.
  g.fillStyle = "#e3bd2c";
  g.fillRect(0, 0, 32, 16);
  // The snow strip: white, then slush with the road's grit in it.
  const sx0 = Math.round(SNOW_BOX.u0 * w);
  const sx1 = Math.round(SNOW_BOX.u1 * w);
  const strip = g.createImageData(sx1 - sx0, 14);
  for (let py = 0; py < 14; py++)
    for (let px = 0; px < sx1 - sx0; px++) {
      const dirt = clamp((px - 10) / 62, 0, 1);
      const m = dirt * (0.45 + 0.75 * fb(px * 0.21, py * 0.5 + 40)) + 0.04 * (hash(px + 77, py) - 0.5);
      const o = (py * (sx1 - sx0) + px) * 4;
      const white = [236, 239, 245];
      const slush = [150, 143, 133];
      for (let k = 0; k < 3; k++) strip.data[o + k] = white[k] + (slush[k] - white[k]) * clamp(m, 0, 1);
      strip.data[o + 3] = 255;
    }
  g.putImageData(strip, sx0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  t.minFilter = LinearMipmapLinearFilter;
  t.name = "car-paint";
  return t;
}

/** A 145/80R12 winter tyre on a plain steel wheel; its axle is x, `side` the way its face looks. */
function wheel(tyre: Material, hub: Material, side: number): Group {
  const g = new Group();
  const R = KEI.wheelRadius;
  // Profiles as (radius, along the axle toward the face), turned about the axle.
  const tyreProfile: P2[] = [
    [0.15, 0.064],
    [0.215, 0.074],
    [R - 0.008, 0.058],
    [R, 0.04],
    [R, -0.04],
    [R - 0.008, -0.058],
    [0.15, -0.066],
    [0.06, -0.05],
  ];
  // A steel wheel: the rim's lip, a deep well, the dished centre and its cap.
  const hubProfile: P2[] = [
    [0.16, 0.058],
    [0.153, 0.066],
    [0.142, 0.05],
    [0.136, 0.012],
    [0.075, 0.04],
    [0.045, 0.058],
    [0.0, 0.06],
  ];
  const lathe = (pts: P2[], seg: number): BufferGeometry => {
    // LatheGeometry turns (x = radius, y = height) about y; points run from the face inward so normals face out.
    const geo = new LatheGeometry(
      pts.map((p) => new Vector2(p[0], p[1])),
      seg,
    );
    geo.rotateZ(side > 0 ? -Math.PI / 2 : Math.PI / 2);
    return geo;
  };
  g.add(new Mesh(lathe(tyreProfile, 16), tyre), new Mesh(lathe(hubProfile, 12), hub));
  return g;
}

export function buildCar(): Car {
  const root = new Group();
  root.name = "car";
  root.userData.dynamic = true;
  root.userData.pocketAtlas = { driven: true };

  const film = paintTexture();
  const paint = new MeshPhysicalMaterial({ color: new Color(1, 1, 1), map: film, roughness: 0.5, metalness: 0.0, clearcoat: 0.45, clearcoatRoughness: 0.25 });
  if (!film) paint.color.setRGB(0.76, 0.77, 0.77);
  paint.name = "car-paint";
  const trim = new MeshStandardMaterial({ color: new Color(0.035, 0.036, 0.04), roughness: 0.72 });
  trim.name = "car-trim";
  const tyre = new MeshStandardMaterial({ color: new Color(0.03, 0.03, 0.032), roughness: 0.94 });
  tyre.name = "car-tyre";
  const hub = new MeshStandardMaterial({ color: new Color(0.33, 0.34, 0.35), roughness: 0.55, metalness: 0.55 });
  hub.name = "car-hub";
  const glass = glassMaterial({ color: new Color(0.012, 0.016, 0.02), roughness: 0.08, metalness: 0, opacity: 0.93 });
  glass.name = "car-glass";
  const brake = new MeshBasicMaterial({ color: new Color(0.62, 0.02, 0.014) });
  brake.name = "car-brake";
  const head = new MeshBasicMaterial({ color: new Color(5.2, 4.9, 4.3) });
  head.name = "car-head";
  // The snow on the car shares the paint's texture (its snow strip): one image for the whole car.
  const snow = new MeshStandardMaterial({ color: new Color(0.9, 0.9, 0.92), map: film, roughness: 0.95 });
  snow.name = "car-snow";

  const b = new Builder();
  b.body();
  details(b);
  const mats: Record<MatName, Material> = { paint, trim, glass, brake, head, snow };
  for (const name of Object.keys(mats) as MatName[]) {
    const mesh = new Mesh(b.parts[name].geometry(), mats[name]);
    mesh.name = `car-${name}`;
    if (name === "glass") mesh.renderOrder = 2;
    root.add(mesh);
  }

  const wheels: Group[] = [];
  // Half the track: the tyres' faces sit a centimetre inside the sills.
  const track = HW - 0.105;
  const places: [string, number, number][] = [
    ["wheel-fl", -track, AXLE_F],
    ["wheel-fr", track, AXLE_F],
    ["wheel-rl", -track, AXLE_R],
    ["wheel-rr", track, AXLE_R],
  ];
  for (const [name, x, z] of places) {
    const w = wheel(tyre, hub, Math.sign(x));
    w.name = name;
    w.position.set(x, KEI.wheelRadius, z);
    root.add(w);
    wheels.push(w);
  }
  root.traverse((o) => {
    o.userData.dynamic = true;
  });

  return {
    root,
    wheels,
    brake,
    head,
    pose(c, braking) {
      root.position.set(c.x, c.y, c.z);
      // Heading is clockwise from −Z seen from above; three.js yaw is counter-clockwise.
      const roll = Math.max(-0.06, Math.min(0.06, c.ay * 0.012));
      const dive = Math.max(-0.04, Math.min(0.04, c.ax * 0.008));
      root.rotation.set(c.pitch + dive, -c.heading, roll, "YXZ");
      for (let i = 0; i < 4; i++) wheels[i].rotation.set(-c.wheel, i < 2 ? -c.steer : 0, 0, "YXZ");
      // Tail lamps burn with the headlamps; the brakes take them well past white's level so they bloom.
      brake.color.setRGB(braking ? 5 : 0.62, braking ? 0.16 : 0.02, braking ? 0.1 : 0.014);
    },
  };
}

export const CAR_SIZE = { length: LENGTH, width: WIDTH, height: HEIGHT };
