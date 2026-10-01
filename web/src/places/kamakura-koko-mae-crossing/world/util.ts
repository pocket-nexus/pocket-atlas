import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import type { AtlasRect } from "../../shared/atlas";
import type { Line } from "./layout";

/** Sample positions along a line between u0 and u1: fine near the crossing, coarse far away. */
export function stations(u0: number, u1: number, fine = 2, mid = 8, far = 30): number[] {
  const out: number[] = [];
  let u = u0;
  while (u < u1) {
    out.push(u);
    const a = Math.abs(u);
    u += a < 120 ? fine : a < 400 ? mid : far;
  }
  out.push(u1);
  return out;
}

/**
 * A ribbon along `line` across offsets `ss` (metres right of the line) with
 * heights `y(u, s)`. Faces up when the offsets increase to the right; UVs are
 * (u, s) in metres unless an atlas cell is given (then mapped once across).
 */
export function ribbon(line: Line, us: number[], ss: number[], y: (u: number, s: number) => number, opts: { flip?: boolean; atlas?: AtlasRect } = {}): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const p = new Vector3();
  const n = ss.length;
  const len = us[us.length - 1] - us[0] || 1;
  for (let i = 0; i < us.length; i++) {
    for (let j = 0; j < n; j++) {
      line.offset(us[i], ss[j], p);
      pos.push(p.x, y(us[i], ss[j]), p.z);
      if (opts.atlas) {
        const a = opts.atlas;
        const fu = (us[i] - us[0]) / len;
        const fv = (ss[j] - ss[0]) / (ss[n - 1] - ss[0] || 1);
        uv.push(a.u0 + fu * (a.u1 - a.u0), a.v1 - fv * (a.v1 - a.v0));
      } else uv.push(us[i], ss[j]);
    }
  }
  for (let i = 0; i < us.length - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      if (opts.flip) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A vertical wall along `line` at offset s, from y0(u) up to y1(u), facing
 * toward increasing s (`facing = 1`) or decreasing s (`-1`). UVs: (u, y).
 */
export function wallAlong(line: Line, us: number[], s: number, y0: (u: number) => number, y1: (u: number) => number, facing: 1 | -1): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const p = new Vector3();
  for (let i = 0; i < us.length; i++) {
    line.offset(us[i], s, p);
    const a = y0(us[i]);
    const b = y1(us[i]);
    pos.push(p.x, a, p.z, p.x, b, p.z);
    uv.push(us[i], a, us[i], b);
  }
  for (let i = 0; i < us.length - 1; i++) {
    const a = i * 2;
    if (facing > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Orients a +z-facing piece to face `yaw` (radians about y) and moves it to p. */
export function place(g: BufferGeometry, p: Vector3, yaw = 0): BufferGeometry {
  if (yaw) g.rotateY(yaw);
  g.translate(p.x, p.y, p.z);
  return g;
}
