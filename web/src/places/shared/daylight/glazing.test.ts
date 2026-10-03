import { expect, test } from "bun:test";
import { BufferGeometry, Ray, Vector3 } from "three";
import { glazedPanel } from "./glazing";

function hits(g: BufferGeometry, ray: Ray): boolean {
  const p = g.getAttribute("position"), ix = g.index!;
  const v = (i: number) => new Vector3().fromBufferAttribute(p, ix.getX(i));
  for (let i = 0; i < ix.count; i += 3)
    if (ray.intersectTriangle(v(i), v(i + 1), v(i + 2), false, new Vector3())) return true;
  return false;
}

test("sloped glazing has an open frame, closed seam and no paint competing for depth", () => {
  // Two different cabin slopes and both face orientations. Rays sample the
  // window interior, where closed cabin quads used to fight the moving glass.
  for (const slope of [.35, .8]) for (const flip of [false, true]) {
    const { frame, glass } = glazedPanel([
      [-1, 0, 1], [1, 0, 1], [.8, 1, 1 - slope], [-.8, 1, 1 - slope],
    ], { bow: .068, columns: 8, rows: 4, flip });
    for (const x of [-.45, 0, .45]) for (const y of [.25, .5, .75]) {
      const ray = new Ray(new Vector3(x, y, 4), new Vector3(0, 0, -1));
      expect(hits(glass, ray)).toBe(true);
      expect(frame.some(g => hits(g, ray))).toBe(false);
    }
    expect(frame.some(g => hits(g, new Ray(new Vector3(0, .04, 4), new Vector3(0, 0, -1))))).toBe(true);
    const pos = glass.getAttribute("position");
    for (let y = 0; y <= 4; y++) for (let x = 0; x <= 8; x++) {
      if (x !== 0 && x !== 8 && y !== 0 && y !== 4) continue;
      const i = y * 9 + x;
      expect(Math.abs(pos.getZ(i) - (1 - slope * pos.getY(i)))).toBeLessThan(1e-6);
    }
    [...frame, glass].forEach(g => g.dispose());
  }
});
