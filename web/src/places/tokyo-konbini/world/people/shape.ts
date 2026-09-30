import { BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute, Vector3 } from "three";

/**
 * Geometry for the procedural figures: lofted sections for bodies, limbs and
 * shoes, parametric shells for heads and hair, and per-vertex bone weights.
 */

/** Horizontal cross-section of a loft (all values in meters). */
export interface Sec {
  y: number;
  /** Half-width along x. */
  w: number;
  /** Half-depth toward +z (front) and −z (back). */
  f: number;
  b: number;
  x?: number;
  z?: number;
  /** Superellipse exponent: 2 = ellipse, higher = squarer. */
  n?: number;
}

export const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const gauss = (v: number): number => Math.exp(-v * v);
const spow = (v: number, e: number) => Math.sign(v) * Math.abs(v) ** e;

/**
 * Indexed surface through rows of points. Closed rows get a duplicated seam
 * vertex (u is arc length in meters) whose normals are welded afterwards.
 * Winding is fixed so normals point away from `inside` (default: centroid).
 */
export function grid(rows: Vector3[][], closed: boolean, caps: { start?: boolean; end?: boolean } = {}, inside?: Vector3): BufferGeometry {
  const m = rows[0].length + (closed ? 1 : 0);
  const pos: number[] = [];
  const uv: number[] = [];
  let v = 0;
  rows.forEach((row, i) => {
    if (i > 0) {
      let d = 0;
      for (let j = 0; j < row.length; j++) d += row[j].distanceTo(rows[i - 1][j]);
      v += d / row.length;
    }
    let u = 0;
    for (let j = 0; j < m; j++) {
      const p = row[j % row.length];
      if (j > 0) u += p.distanceTo(row[(j - 1) % row.length]);
      pos.push(p.x, p.y, p.z);
      uv.push(u, v);
    }
  });
  const idx: number[] = [];
  for (let i = 0; i < rows.length - 1; i++)
    for (let j = 0; j < m - 1; j++) {
      const a = i * m + j;
      const c = a + m;
      idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  const cap = (row: Vector3[], base: number, flip: boolean) => {
    const c = new Vector3();
    for (const p of row) c.add(p);
    c.divideScalar(row.length);
    const ci = pos.length / 3;
    pos.push(c.x, c.y, c.z);
    uv.push(0, 0);
    for (let j = 0; j < m - 1; j++) flip ? idx.push(ci, base + j + 1, base + j) : idx.push(ci, base + j, base + j + 1);
  };
  if (caps.start) cap(rows[0], 0, true);
  if (caps.end) cap(rows[rows.length - 1], (rows.length - 1) * m, false);

  // Orientation: signed volume about the interior point.
  const ctr = inside ?? rows.flat().reduce((s, p) => s.add(p), new Vector3()).divideScalar(rows.length * rows[0].length);
  let vol = 0;
  const p0 = new Vector3();
  const p1 = new Vector3();
  const p2 = new Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    p0.fromArray(pos, idx[t] * 3).sub(ctr);
    p1.fromArray(pos, idx[t + 1] * 3).sub(ctr);
    p2.fromArray(pos, idx[t + 2] * 3).sub(ctr);
    vol += p0.dot(p1.cross(p2));
  }
  if (vol < 0) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];

  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (closed) {
    const n = g.getAttribute("normal");
    const a = new Vector3();
    const b = new Vector3();
    for (let i = 0; i < rows.length; i++) {
      const i0 = i * m;
      const i1 = i * m + m - 1;
      a.fromBufferAttribute(n, i0).add(b.fromBufferAttribute(n, i1)).normalize();
      n.setXYZ(i0, a.x, a.y, a.z);
      n.setXYZ(i1, a.x, a.y, a.z);
    }
  }
  return g;
}

/**
 * Tube through horizontal sections stacked along y. The ring starts at the
 * back (−z) so the seam hides behind the body. `arc` limits the ring to a
 * front-centred span (radians) for open panels such as aprons.
 */
export function loft(secs: Sec[], radial = 16, caps: { start?: boolean; end?: boolean } = {}, arc?: number): BufferGeometry {
  const rows = secs.map((s) => {
    const e = 2 / (s.n ?? 2);
    const row: Vector3[] = [];
    const count = arc ? radial + 1 : radial;
    for (let j = 0; j < count; j++) {
      const a = arc ? -arc / 2 + (j / radial) * arc : Math.PI + (j / radial) * Math.PI * 2;
      const sx = Math.sin(a);
      const cz = Math.cos(a);
      row.push(new Vector3((s.x ?? 0) + s.w * spow(sx, e), s.y, (s.z ?? 0) + (cz >= 0 ? s.f : s.b) * spow(cz, e)));
    }
    return row;
  });
  let inside: Vector3 | undefined;
  if (arc) {
    const s = secs[Math.floor(secs.length / 2)];
    inside = new Vector3(s.x ?? 0, s.y, (s.z ?? 0) - 0.5);
  }
  return grid(rows, !arc, arc ? {} : caps, inside);
}

/** Closed parametric shell: u wraps around (0 = back), v runs top to bottom. */
export function shell(nu: number, nv: number, f: (u: number, v: number, out: Vector3) => void, inside: Vector3, caps: { start?: boolean; end?: boolean } = {}): BufferGeometry {
  const rows: Vector3[][] = [];
  for (let i = 0; i <= nv; i++) {
    const row: Vector3[] = [];
    for (let j = 0; j < nu; j++) {
      const p = new Vector3();
      f(j / nu, i / nv, p);
      row.push(p);
    }
    rows.push(row);
  }
  return grid(rows, true, caps, inside);
}

/** Up to four (bone, weight) pairs per vertex. */
export type Influence = [number, number][];
export type SkinFn = (p: Vector3) => Influence;

/** Writes skinIndex/skinWeight from a weight function of the rest position. */
export function skin(g: BufferGeometry, fn: SkinFn | number): BufferGeometry {
  const pos = g.getAttribute("position");
  const n = pos.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const p = new Vector3();
  for (let i = 0; i < n; i++) {
    const inf = typeof fn === "number" ? ([[fn, 1]] as Influence) : fn(p.fromBufferAttribute(pos, i));
    const list = inf.filter((e) => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = list.reduce((s, e) => s + e[1], 0) || 1;
    list.forEach(([b, w], k) => {
      si[i * 4 + k] = b;
      sw[i * 4 + k] = w / sum;
    });
    if (!list.length) sw[i * 4] = 1;
  }
  g.setAttribute("skinIndex", new Uint16BufferAttribute(si, 4));
  g.setAttribute("skinWeight", new Float32BufferAttribute(sw, 4));
  return g;
}

/** Piecewise-linear blend between bones placed at increasing positions along `axis` (a function of the point). */
export function chain(stops: [number, number][], axis: (p: Vector3) => number): SkinFn {
  return (p) => {
    const t = axis(p);
    if (t <= stops[0][1]) return [[stops[0][0], 1]];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][1]) {
        const k = smooth(stops[i - 1][1], stops[i][1], t);
        return [
          [stops[i - 1][0], 1 - k],
          [stops[i][0], k],
        ];
      }
    }
    return [[stops[stops.length - 1][0], 1]];
  };
}
