import { expect, test } from "bun:test";
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import { Rng } from "../../../core/random";
import { cluster, limb, type Cards } from "./foliage";
import { removeEnclosedTriangles, type SolidBox } from "./geometry";
import { PETAL_OUTLINE, petalGeometry } from "./trees";

const solid: SolidBox = { min: [-1, -1, -1], max: [1, 1, 1] };

test("solid culling keeps its own exterior and removes an enclosed object", () => {
  const shell = new BoxGeometry(2, 2, 2);
  const original = Array.from(shell.index!.array);
  removeEnclosedTriangles(shell, [solid]);
  expect(Array.from(shell.index!.array)).toEqual(original);
  const inside = new BoxGeometry(1, 1, 1);
  removeEnclosedTriangles(inside, [solid]);
  expect(inside.index!.count).toBe(0);
});

test("partial and coplanar triangles remain; containing boxes cannot be combined", () => {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([
    -2, 0, 0, 2, 0, 0, 0, 0.5, 0, // intersects the solid
    -0.5, 1, 0, 0.5, 1, 0, 0, 1, 0.5, // lies on its exterior
    -1.5, 0, 0, 1.5, 0, 0, 0, 0.5, 0, // vertices in different boxes
  ], 3));
  const positions = Array.from(g.getAttribute("position").array);
  removeEnclosedTriangles(g, [solid, { min: [-2, -1, -1], max: [-1, 1, 1] }, { min: [1, -1, -1], max: [2, 1, 1] }]);
  expect(g.index).toBeNull();
  expect(Array.from(g.getAttribute("position").array)).toEqual(positions);
});

test("interior foliage thinning preserves outer cards and the random stream", () => {
  const make = (): Cards => ({ pos: [], nor: [], uv: [], idx: [] });
  const full = make(), thin = make(), a = new Rng(154), b = new Rng(154);
  const crown = new Vector3(), radius = new Vector3(1, 1, 1);
  cluster(full, a, crown, crown, radius, 1.1, 80, 2, 0.5);
  cluster(thin, b, crown, crown, radius, 1.1, 80, 2, 0.5, true);
  expect(a.next()).toBe(b.next());
  expect(thin.pos.length).toBeLessThan(full.pos.length);
  const kept = new Set(Array.from({ length: thin.pos.length / 12 }, (_, i) => JSON.stringify(thin.pos.slice(i * 12, i * 12 + 12))));
  let outer = 0;
  for (let i = 0; i < full.pos.length; i += 12) {
    const center = new Vector3();
    for (let j = 0; j < 4; j++) center.add(new Vector3(...full.pos.slice(i + j * 3, i + j * 3 + 3)));
    center.multiplyScalar(0.25);
    if (center.length() >= 0.9) {
      outer++;
      expect(kept.has(JSON.stringify(full.pos.slice(i, i + 12)))).toBe(true);
    }
  }
  expect(outer).toBeGreaterThan(0);
});

test("a straight twig keeps its endpoints with fewer segments and no zero-area tip faces", () => {
  const points = [new Vector3(), new Vector3(0, 1, 0), new Vector3(0, 2, 0)];
  const full = limb(points, 0.03, 0, 3, 3);
  const adaptive = limb(points, 0.03, 0, 3, 3, 0.01);
  expect(adaptive.index!.count).toBeLessThan(full.index!.count);
  const position = adaptive.getAttribute("position"), index = adaptive.index!;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    expect(b.sub(a).cross(c.sub(a)).lengthSq()).toBeGreaterThan(0);
  }
  adaptive.computeBoundingBox();
  expect(adaptive.boundingBox!.min.y).toBe(0);
  expect(adaptive.boundingBox!.max.y).toBe(2);
});

test("petal card retains the outline projection and normal facing within 2 mm fold error", () => {
  const full = petalGeometry(), card = petalGeometry(true);
  expect(full.index!.count / 3).toBe(6);
  expect(card.index!.count / 3).toBe(2);
  full.computeBoundingBox(); card.computeBoundingBox();
  expect(card.boundingBox).toEqual(full.boundingBox);
  const normal = card.getAttribute("normal");
  expect(normal.getZ(0)).toBeLessThan(0);
  expect(full.getAttribute("normal").getZ(0)).toBeLessThan(0);
  for (const [x, y, z] of PETAL_OUTLINE) {
    const u = (x + 0.45) / 0.9;
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(1);
    // Both surfaces are linear within each original triangle; checking its
    // vertices bounds the difference over the entire original surface.
    expect(Math.abs(z - 0.25 * y) * 0.057).toBeLessThanOrEqual(0.002);
  }
});
