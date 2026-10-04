import { describe, expect, test } from "bun:test";
import { Box3, Mesh, MeshStandardMaterial } from "three";
import { readParams, type GeometryProfile } from "../src/core/params";
import { FORMATION } from "../src/places/sangubashi-crossing/rail";
import { commuter } from "../src/places/shared/daylight/commuter";
import type { DayWorld } from "../src/places/shared/daylight/context";
import { Parts } from "../src/places/shared/shapes";
import { record } from "../src/places/shared/export";

function rollingStock(profile: GeometryProfile, compilerSource = false) {
  const materials = new Map<string, MeshStandardMaterial>();
  const material = (name: string) => {
    if (!materials.has(name)) {
      const m = new MeshStandardMaterial(); m.name = name; materials.set(name, m);
    }
    return materials.get(name)!;
  };
  // Geometry verification does not require a WebGL renderer or painted atlases.
  const world = {
    geometry: profile, compilerSource,
    lib: new Proxy({}, { get: (_, name) => (...args: unknown[]) => material(`${String(name)}:${args.join(",")}`) }),
    printed: material("printed"), lit: material("lit"), draw: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }),
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
  test("one compiler source retains both train representations with matching labels and wheel articulation", () => {
    const source = rollingStock("full", true);
    expect(source.root.children.map(c => c.name)).toEqual(["reference", "surface"]);
    expect(source.wheels).toHaveLength(64);
    const [reference, compact] = source.root.children;
    expect(reference.visible).toBe(true); expect(compact.visible).toBe(false);
    expect(reference.children.map(c => c.name)).toEqual(compact.children.map(c => c.name));
    const labels = (root: typeof reference) => {
      const result: number[][] = [];
      root.traverse(o => {
        if (o instanceof Mesh && !Array.isArray(o.material) && ["printed", "lit"].includes(o.material.name))
          result.push(Array.from(o.geometry.getAttribute("position").array));
      });
      return result;
    };
    expect(labels(compact)).toEqual(labels(reference));
    for (let i = 0; i < 32; i++) {
      const a = source.wheels[i], b = source.wheels[i + 32];
      expect(b.name).toBe(a.name); expect(b.position.toArray()).toEqual(a.position.toArray());
      expect(b.parent!.rotation.y).toBe(a.parent!.rotation.y);
    }
    const motion = record({ root: source.root, fogLights: [], updaters: [(_dt, t) => {
      source.root.position.x = t * 2;
      for (const wheel of source.wheels) wheel.rotation.z = t;
    }] }, 1, 4, 0);
    expect(motion.tracks.find(t => t.node === source.root)?.pos).toEqual([0, 0, 0, 0.5, 0, 0, 1, 0, 0, 1.5, 0, 0]);
    expect(motion.tracks.filter(t => source.wheels.includes(t.node as typeof source.wheels[number]))).toHaveLength(64);
    source.root.traverse(o => { if (o instanceof Mesh) o.geometry.dispose(); });
  });
  test("the full train stays unchanged; handheld retains every piece and all 32 wheelsets", () => {
    const full = rollingStock("full"), handheld = rollingStock("handheld");
    expect(full.triangles).toBe(365224);
    expect(handheld.triangles).toBeLessThanOrEqual(105000);
    expect(full.wheels).toHaveLength(32);
    expect(handheld.wheels.map(w => w.name)).toEqual(full.wheels.map(w => w.name));
    expect(handheld.root.children.map(c => c.name)).toEqual(full.root.children.map(c => c.name));
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
