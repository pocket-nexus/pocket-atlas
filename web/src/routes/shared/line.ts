/**
 * A road's centre line: points every few metres with their elevation, the
 * arc length along it, and the two queries everything else is built on —
 * the point at an arc length and the arc length and offset of a point.
 *
 * Offsets are positive to the right of the direction of travel (forward −Z
 * has its right at +X); traffic in Japan keeps to negative offsets.
 */
export interface LinePoint {
  x: number;
  y: number;
  z: number;
  /** Unit tangent in the ground plane. */
  tx: number;
  tz: number;
  /** Rise per metre. */
  grade: number;
}

export interface Projection {
  /** Arc length (m) of the nearest point on the line. */
  s: number;
  /** Signed offset (m), positive to the right. */
  d: number;
  /** Segment index of the nearest point. */
  i: number;
}

export class Line {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** Arc length at every point. */
  readonly s: Float64Array;
  readonly length: number;
  private cells: Map<number, number[]> | null = null;
  private static readonly HASH = 64;

  constructor(x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>) {
    this.n = x.length;
    this.x = Float64Array.from(x);
    this.y = Float64Array.from(y);
    this.z = Float64Array.from(z);
    this.s = new Float64Array(this.n);
    for (let i = 1; i < this.n; i++) this.s[i] = this.s[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
    this.length = this.s[this.n - 1];
  }

  /** Segment holding arc length `s` (binary search). */
  segment(s: number): number {
    let lo = 0;
    let hi = this.n - 2;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.s[m] <= s) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /** The point at arc length `s` (clamped to the line), its tangent and grade. */
  at(s: number, out: LinePoint = { x: 0, y: 0, z: 0, tx: 0, tz: -1, grade: 0 }): LinePoint {
    const c = Math.max(0, Math.min(this.length, s));
    const i = this.segment(c);
    const len = this.s[i + 1] - this.s[i] || 1;
    const t = (c - this.s[i]) / len;
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t;
    out.z = this.z[i] + (this.z[i + 1] - this.z[i]) * t;
    // Tangent and height through the neighbours: no kinks at the samples.
    const a = Math.max(0, i - 1);
    const b = Math.min(this.n - 1, i + 2);
    const t0x = this.x[i + 1] - this.x[a];
    const t0z = this.z[i + 1] - this.z[a];
    const t1x = this.x[b] - this.x[i];
    const t1z = this.z[b] - this.z[i];
    let tx = t0x / (Math.hypot(t0x, t0z) || 1);
    let tz = t0z / (Math.hypot(t0x, t0z) || 1);
    const ux = t1x / (Math.hypot(t1x, t1z) || 1);
    const uz = t1z / (Math.hypot(t1x, t1z) || 1);
    tx += (ux - tx) * t;
    tz += (uz - tz) * t;
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l;
    out.tz = tz / l;
    out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * t;
    out.grade = (this.y[i + 1] - this.y[i]) / len;
    return out;
  }

  private index(): Map<number, number[]> {
    if (this.cells) return this.cells;
    const cells = (this.cells = new Map());
    const h = Line.HASH;
    for (let i = 0; i + 1 < this.n; i++) {
      const x0 = Math.floor(Math.min(this.x[i], this.x[i + 1]) / h);
      const x1 = Math.floor(Math.max(this.x[i], this.x[i + 1]) / h);
      const z0 = Math.floor(Math.min(this.z[i], this.z[i + 1]) / h);
      const z1 = Math.floor(Math.max(this.z[i], this.z[i + 1]) / h);
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const k = (cx + 32768) * 65536 + (cz + 32768);
          const list = cells.get(k);
          if (list) list.push(i);
          else cells.set(k, [i]);
        }
    }
    return cells;
  }

  private onSegment(i: number, x: number, z: number, best: Projection, bestD2: number): number {
    const ax = this.x[i];
    const az = this.z[i];
    const dx = this.x[i + 1] - ax;
    const dz = this.z[i + 1] - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const ex = x - (ax + dx * t);
    const ez = z - (az + dz * t);
    const d2 = ex * ex + ez * ez;
    if (d2 < bestD2) {
      best.i = i;
      best.s = this.s[i] + Math.sqrt(l2) * t;
      // Right of travel: (−tz, tx).
      best.d = Math.sign(-dz * ex + dx * ez) * Math.sqrt(d2);
      return d2;
    }
    return bestD2;
  }

  /** Nearest point on the line within `reach` metres (hashed search); null beyond. */
  project(x: number, z: number, reach: number, out: Projection = { s: 0, d: 0, i: 0 }): Projection | null {
    const cells = this.index();
    const h = Line.HASH;
    const r = Math.ceil(reach / h);
    const cx = Math.floor(x / h);
    const cz = Math.floor(z / h);
    let best = reach * reach;
    let found = false;
    for (let ix = cx - r; ix <= cx + r; ix++)
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const list = cells.get((ix + 32768) * 65536 + (iz + 32768));
        if (!list) continue;
        for (const i of list) {
          const d2 = this.onSegment(i, x, z, out, best);
          if (d2 < best) {
            best = d2;
            found = true;
          }
        }
      }
    return found ? out : null;
  }

  /** Nearest point among the segments around `hint` (a vehicle following the line). */
  track(x: number, z: number, hint: number, span = 12, out: Projection = { s: 0, d: 0, i: 0 }): Projection {
    let best = Infinity;
    const a = Math.max(0, hint - span);
    const b = Math.min(this.n - 2, hint + span);
    for (let i = a; i <= b; i++) best = this.onSegment(i, x, z, out, best);
    return out;
  }

  /** Signed curvature (1/m, positive turning right) around arc length `s` over `span` metres. */
  curvature(s: number, span = 20): number {
    const a = this.at(s - span / 2);
    const ax = a.tx;
    const az = a.tz;
    const b = this.at(s + span / 2);
    const cross = ax * b.tz - az * b.tx;
    const dot = ax * b.tx + az * b.tz;
    return Math.atan2(cross, dot) / span;
  }
}
