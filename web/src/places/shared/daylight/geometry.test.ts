import { expect, test } from "bun:test";
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3, type Material } from "three";
import { Rng } from "../../../core/random";
import { cluster, limb, type Cards } from "./foliage";
import { cutRectangles, openedFace, removeEnclosedTriangles, type SolidBox } from "./geometry";
import { PETAL_OUTLINE, petalGeometry } from "./trees";
import { house, type HouseKit } from "./houses";
import { commuter } from "./commuter";
import type { DayWorld } from "./context";

const solid: SolidBox = { min: [-1, -1, -1], max: [1, 1, 1] };

test("wall apertures remove the union of overlaps and keep continuous metre UVs", () => {
  const face = { x0: 0, x1: 10, y0: 0, y1: 6 };
  const cuts = [{ x0: 2, x1: 4, y0: 1, y1: 5 }, { x0: 3, x1: 6, y0: 2, y1: 4 }];
  const pieces = cutRectangles(face, cuts);
  expect(pieces.reduce((area, r) => area + (r.x1 - r.x0) * (r.y1 - r.y0), 0)).toBe(48);
  for (const r of pieces) for (const hole of cuts) {
    expect(Math.min(r.x1, hole.x1) <= Math.max(r.x0, hole.x0) || Math.min(r.y1, hole.y1) <= Math.max(r.y0, hole.y0)).toBe(true);
  }
  const g = openedFace(face, cuts), p = g.getAttribute("position"), uv = g.getAttribute("uv");
  for (let i = 0; i < p.count; i++) { expect(uv.getX(i)).toBe(p.getX(i)); expect(uv.getY(i)).toBe(p.getY(i)); }
});

test("near and far house panes have actual wall openings on every facade", () => {
  const plain = new MeshBasicMaterial(), glass = new MeshBasicMaterial(), wall = new MeshBasicMaterial();
  const kit: HouseKit = { frameBronze: plain, frameSilver: plain, glassDark: glass, glassCurtain: glass,
    glassFrosted: glass, trim: plain, dark: plain, shutter: glass, foundation: plain, slab: plain,
    door: plain, ac: plain, bars: plain, panel: plain, pv: plain, laundry: [plain] };
  for (const detail of ["near", "mid"] as const) {
    const root = new Group();
    const world = { root, mesh(g: BufferGeometry, m: Material) { const mesh = new Mesh(g, m); root.add(mesh); return mesh; } } as unknown as DayWorld;
    house(world, kit, { x0: -4, x1: 4, z0: -5, z1: 5, base: -3, floors: 2, wall,
      roof: { kind: "flat", mat: plain }, faces: { "+z": {}, "-z": {}, "+x": {}, "-x": {} }, seed: 617, detail });
    root.updateMatrixWorld(true);
    const walls = root.children.filter(m => (m as Mesh).material === wall), ray = new Raycaster();
    let panes = 0;
    for (const object of root.children) {
      const mesh = object as Mesh; if (mesh.material !== glass) continue;
      const p = mesh.geometry.getAttribute("position"), n = mesh.geometry.getAttribute("normal");
      for (let i = 0; i < p.count; i += 3) {
        const center = new Vector3(); for (let j = 0; j < 3; j++) center.add(new Vector3().fromBufferAttribute(p, i + j)); center.multiplyScalar(1 / 3);
        const normal = new Vector3().fromBufferAttribute(n, i);
        ray.set(center.clone().addScaledVector(normal, 0.1), normal.negate()); ray.near = 0; ray.far = 0.15;
        expect(ray.intersectObjects(walls, false)).toHaveLength(0); panes++;
      }
    }
    expect(panes).toBeGreaterThan(10);
  }
});

test("commuter side skin and door leaves have one face at seams and real rounded apertures", () => {
  const steel = new MeshBasicMaterial(), plain = new MeshBasicMaterial();
  const lib = { stainless: () => steel, plain: () => plain, paint: () => plain, clearGlass: () => plain, glow: () => plain };
  for (const geometry of ["full", "handheld"] as const) {
    const world = { geometry, lib, printed: plain, decal: plain, lit: plain, draw: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }) } as unknown as DayWorld;
    const train = commuter(world, { cars: [{ number: "1" }], stripe: 0x0088aa, destination: "A", service: "B", destinationLatin: "A", serviceLatin: "B" });
    // Inspect in each car's local frame, before the train animation transforms.
    const body = train.root.children[0], meshes = body.children.filter(m => (m as Mesh).material === steel);
    const ray = new Raycaster(); ray.near = 0; ray.far = 0.3;
    for (const s of [-1, 1]) {
      for (const [x, y, count] of [[-7.4, 2.065, 1], [-7.4, 3.125, 1], [-4.3, 2.59, 0], [-6.867, 2.65, 0], [-6.567, 2.25, 1], [-6.567, 3.075, 1]] as const) {
        ray.set(new Vector3(x, y, s * 1.65), new Vector3(0, 0, -s));
        const hits = ray.intersectObjects(meshes, false);
        expect(hits).toHaveLength(count);
      }
    }
  }
});

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
