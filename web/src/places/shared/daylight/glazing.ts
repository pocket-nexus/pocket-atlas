import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";

type Point = [number, number, number];
type Corners = [Point, Point, Point, Point];

/** Opaque frame surrounding a real opening. No hidden paint behind the pane.
 * UV bounds describe the opening within the outer quad; bow vanishes at every
 * pane edge so the glass and frame share an exact boundary on all targets. */
export function glazedPanel(corners: Corners, options: {
  left?: number; right?: number; bottom?: number; top?: number;
  bow?: number; columns?: number; rows?: number; flip?: boolean;
} = {}): { frame: BufferGeometry[]; glass: BufferGeometry } {
  const { left = .07, right = .93, bottom = .12, top = .87,
    bow = 0, columns = 1, rows = 1, flip = false } = options;
  if (!(0 < left && left < right && right < 1 && 0 < bottom && bottom < top && top < 1)
    || !Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1)
    throw new Error("Invalid glazing opening");
  const p = corners.map(c => new Vector3(...c));
  const normal = p[1].clone().sub(p[0]).cross(p[3].clone().sub(p[0])).normalize()
    .multiplyScalar(flip ? -1 : 1);
  const at = (u: number, v: number) => p[0].clone().lerp(p[1], u)
    .lerp(p[3].clone().lerp(p[2], u), v);
  const grid = (u0: number, v0: number, u1: number, v1: number,
    cols = 1, count = 1, depth = 0): BufferGeometry => {
    const pos: number[] = [], uv: number[] = [], indices: number[] = [];
    for (let y = 0; y <= count; y++) for (let x = 0; x <= cols; x++) {
      const u = x / cols, v = y / count;
      const offset = x === 0 || x === cols || y === 0 || y === count
        ? 0 : depth * Math.sin(u * Math.PI) * Math.sin(v * Math.PI);
      const point = at(u0 + (u1 - u0) * u, v0 + (v1 - v0) * v)
        .addScaledVector(normal, offset);
      pos.push(...point.toArray()); uv.push(u, v);
    }
    for (let y = 0; y < count; y++) for (let x = 0; x < cols; x++) {
      const a = y * (cols + 1) + x, b = a + 1, c = a + cols + 2, d = c - 1;
      indices.push(...(flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d]));
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    g.setIndex(indices); g.computeVertexNormals();
    return g;
  };
  return {
    frame: [grid(0, 0, 1, bottom), grid(0, top, 1, 1),
      grid(0, bottom, left, top), grid(right, bottom, 1, top)],
    glass: grid(left, bottom, right, top, columns, rows, bow),
  };
}
