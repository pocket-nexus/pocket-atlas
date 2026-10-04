import { describe, expect, test } from "bun:test";
import { Box3, Mesh, MeshStandardMaterial } from "three";
import { readParams, type GeometryProfile } from "../src/core/params";
import { FORMATION } from "../src/places/sangubashi-crossing/rail";
import { commuter } from "../src/places/shared/daylight/commuter";
import type { DayWorld } from "../src/places/shared/daylight/context";
import { Parts } from "../src/places/shared/shapes";

function rollingStock(profile: GeometryProfile) {
  const materials = new Map<string, MeshStandardMaterial>();
  const material = (name: string) => {
    if (!materials.has(name)) {
      const m = new MeshStandardMaterial(); m.name = name; materials.set(name, m);
    }
    return materials.get(name)!;
  };
  // Geometry verification does not require a WebGL renderer or painted atlases.
  const world = {
    geometry: profile,
    lib: new Proxy({}, { get: (_, name) => (...args: unknown[]) => material(`${String(name)}:${args.join(",")}`) }),
    printed: material("printed"), decal: material("decal"), lit: material("lit"), draw: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }),
  } as unknown as DayWorld;
  const pieces: { material: string; bounds: Box3 }[] = [];
  const add = Parts.prototype.add;
  Parts.prototype.add = function (mat, geometry, cast) {
    geometry.computeBoundingBox();
    pieces.push({ material: mat.name.replace(/-thin-band$/, ""), bounds: geometry.boundingBox!.clone() });
    return add.call(this, mat, geometry, cast);
  };
  try {
    const train = commuter(world, FORMATION);
    let triangles = 0;
    train.root.traverse(o => {
      if (o instanceof Mesh) triangles += (o.geometry.index?.count ?? o.geometry.getAttribute("position").count) / 3;
    });
    return { ...train, pieces, triangles, bounds: new Box3().setFromObject(train.root) };
  } finally {
    Parts.prototype.add = add;
  }
}

describe("handheld authoring geometry", () => {
  test("geometry is opt-in and independent of the ultra lighting preset", () => {
    expect(readParams("?q=ultra").geometry).toBe("full");
    expect(readParams("?q=ultra&geometry=unknown").geometry).toBe("full");
    const p = readParams("?q=ultra&geometry=handheld&export");
    expect(p.geometry).toBe("handheld");
    expect(p.quality).toBe("ultra");
    expect(p.exporting).toBe(true);
  });
  test("handheld retains the full train's feature inventory, silhouette and all 32 wheelsets", () => {
    const full = rollingStock("full"), handheld = rollingStock("handheld");
    // Correctness fixes can replace intersecting shells with pierced panels.
    // Protect their components and bounds below instead of an obsolete count.
    expect(full.triangles).toBeGreaterThan(handheld.triangles * 2);
    expect(handheld.triangles).toBeLessThanOrEqual(105000);
    expect(full.wheels).toHaveLength(32);
    expect(handheld.wheels.map(w => w.name)).toEqual(full.wheels.map(w => w.name));
    expect(handheld.root.children.map(c => c.name)).toEqual(full.root.children.map(c => c.name));
    expect(full.root.children.map(c => c.name)).toEqual(FORMATION.cars.map(c => `car-${c.number}`));
    for (const train of [full, handheld]) for (const car of train.root.children) {
      const names = new Set<string>();
      car.traverse(o => { if (o instanceof Mesh) names.add((o.material as MeshStandardMaterial).name.replace(/-thin-band$/, "")); });
      for (const feature of ["stainless:", "clearGlass:", "printed", "decal", "lit"]) expect(names.has(feature)).toBe(true);
    }
    expect(handheld.pieces).toHaveLength(full.pieces.length);
    for (let i = 0; i < full.pieces.length; i++) {
      const a = full.pieces[i], b = handheld.pieces[i];
      expect(b.material).toBe(a.material);
      // Tessellation may move a curved edge by millimetres; it cannot replace
      // a window, roof, cabinet or bogie with a different shape or location.
      expect(a.bounds.min.distanceTo(b.bounds.min)).toBeLessThan(0.075);
      expect(a.bounds.max.distanceTo(b.bounds.max)).toBeLessThan(0.075);
    }
    expect(full.bounds.min.distanceTo(handheld.bounds.min)).toBeLessThan(0.01);
    expect(full.bounds.max.distanceTo(handheld.bounds.max)).toBeLessThan(0.01);
    for (const train of [full, handheld]) {
      train.root.traverse(o => { if (o instanceof Mesh) o.geometry.dispose(); });
    }
  });
});
