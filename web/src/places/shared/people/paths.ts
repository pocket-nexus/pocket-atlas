import { Vector3 } from "three";

/** A closed walking circuit, parametrised by distance. */
export interface Path {
  length: number;
  /** Writes the position at distance d along the loop (wrapped); returns the heading (rotation.y). */
  at(d: number, out: Vector3): number;
}

/**
 * Back-and-forth beat along one axis: out on lane l0, a tight U-turn beyond
 * `b`, back on lane l1, U-turn beyond `a`. `swerve` offsets the lane (e.g. to
 * pass parked bicycles). Positions are at y = 0; the heading is analytic.
 */
export function patrol(axis: "x" | "z", a: number, b: number, l0: number, l1: number, swerve: (s: number) => number = () => 0): Path {
  const r = (l0 - l1) / 2;
  const ar = Math.abs(r);
  const qc = (l0 + l1) / 2;
  const run = b - a;
  const turn = Math.PI * ar;
  const length = 2 * run + 2 * turn;
  const put = (s: number, q: number, ds: number, dq: number, out: Vector3) => {
    if (axis === "x") {
      out.set(s, 0, q);
      return Math.atan2(ds, dq);
    }
    out.set(q, 0, s);
    return Math.atan2(dq, ds);
  };
  const slope = (s: number) => (swerve(s + 0.05) - swerve(s - 0.05)) / 0.1;
  return {
    length,
    at(d, out) {
      d = ((d % length) + length) % length;
      if (d < run) {
        const s = a + d;
        return put(s, l0 + swerve(s), 1, slope(s), out);
      }
      d -= run;
      if (d < turn) {
        const p = d / ar;
        return put(b + ar * Math.sin(p), qc + r * Math.cos(p), ar * Math.cos(p), -r * Math.sin(p), out);
      }
      d -= turn;
      if (d < run) {
        const s = b - d;
        return put(s, l1 + swerve(s), -1, -slope(s), out);
      }
      d -= run;
      const p = d / ar;
      return put(a - ar * Math.sin(p), qc - r * Math.cos(p), -ar * Math.cos(p), r * Math.sin(p), out);
    },
  };
}

/**
 * A planar path carried through a map from its (x, z) plane into the world
 * (e.g. along a curved coast line). The heading follows the mapped path,
 * taken over the next `step` metres.
 */
export function mapPath(path: Path, map: (x: number, z: number, out: Vector3) => Vector3, step = 0.05): Path {
  const p = new Vector3();
  const q = new Vector3();
  const m = new Vector3();
  return {
    length: path.length,
    at(d, out) {
      path.at(d, p);
      path.at(d + step, q);
      map(p.x, p.z, out);
      map(p.x, p.z, m);
      map(q.x, q.z, q);
      return Math.atan2(q.x - m.x, q.z - m.z);
    },
  };
}
