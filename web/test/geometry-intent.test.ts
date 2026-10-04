import { expect, test } from "bun:test";
import { BoxGeometry, Group, InstancedMesh, Mesh, MeshStandardMaterial } from "three";
import { geometryAlternatives, geometryIntent } from "../src/places/shared/geometry-intent";
import { batchStatic } from "../src/places/shared/geo";
import { identifySources } from "../src/places/shared/provenance";
import { validateExportObject } from "../src/places/shared/export-contract";

test("compiler export preserves prototype identity, instance count and per-object intent", () => {
  const root = new Group(), geometry = new BoxGeometry(), material = new MeshStandardMaterial();
  const a = geometryIntent(new Mesh(geometry, material), { role: "protected", maxErrorMeters: 0 });
  const b = geometryIntent(new Mesh(geometry, material), { role: "detail", maxErrorMeters: 0.01 });
  const instances = new InstancedMesh(geometry, material, 4);
  b.position.x = 3; root.add(a, b, instances);
  batchStatic(root, { preserveObjects: true });
  identifySources(root);
  expect(root.children).toEqual([a, b, instances]);
  expect(a.geometry).toBe(b.geometry);
  expect(instances.count).toBe(4);
  expect(a.userData.pocketAtlas.geometry.role).toBe("protected");
  expect(a.userData.pocketAtlas.sourceId).not.toBe(b.userData.pocketAtlas.sourceId);
});

test("Web displays only the reference, export keeps both representations and strict metadata", () => {
  const reference = new Group(), compact = new Group();
  const root = geometryAlternatives("railing", { role: "structure", maxErrorMeters: 0.01 }, [
    { id: "reference", errorMeters: 0, object: reference }, { id: "surface", errorMeters: 0.004, object: compact },
  ]);
  expect(reference.visible).toBe(true); expect(compact.visible).toBe(false);
  expect(root.userData.dynamic).toBeUndefined();
  expect(root.children).toHaveLength(2);
  expect(() => validateExportObject(root)).not.toThrow();
  expect(() => geometryIntent(root, { role: "protected", maxErrorMeters: 0.1 })).toThrow();
  expect(() => geometryAlternatives("bad", { role: "detail", maxErrorMeters: 0.1 }, [
    { id: "reference", errorMeters: 0.1, object: new Group() }, { id: "surface", errorMeters: 0.2, object: new Group() },
  ])).toThrow();
});

test("static alternatives retain visibility and world UVs without acquiring motion intent", () => {
  const build = () => {
    const material = new MeshStandardMaterial(); material.userData.worldUV = true;
    const reference = new Mesh(new BoxGeometry(), material), compact = new Mesh(new BoxGeometry(), material);
    reference.position.x = compact.position.x = 4;
    const root = geometryAlternatives("wall", { role: "structure", maxErrorMeters: 0.01 }, [
      { id: "reference", errorMeters: 0, object: reference }, { id: "surface", errorMeters: 0.004, object: compact },
    ]);
    return { root, reference, compact };
  };
  const web = build(), exported = build();
  batchStatic(web.root); batchStatic(exported.root, { preserveObjects: true });
  expect(web.root.children).toEqual([web.reference, web.compact]);
  expect(web.reference.visible).toBe(true); expect(web.compact.visible).toBe(false);
  expect(web.root.userData.dynamic).toBeUndefined();
  expect(Array.from(web.reference.geometry.getAttribute("uv").array)).toEqual(Array.from(exported.reference.geometry.getAttribute("uv").array));
});

test("unbatched export preserves the Web world-UV mapping and leaves moving/instanced UVs alone", () => {
  const build = () => {
    const root = new Group(), material = new MeshStandardMaterial(); material.userData.worldUV = true;
    const mesh = new Mesh(new BoxGeometry(2, 3, 4), material); mesh.position.set(3, 2, 1); root.add(mesh);
    return { root, mesh, material };
  };
  const web = build(), exported = build();
  batchStatic(web.root); batchStatic(exported.root, { preserveObjects: true });
  expect(Array.from(exported.mesh.geometry.getAttribute("uv").array)).toEqual(Array.from((web.root.children[0] as Mesh).geometry.getAttribute("uv").array));
  const moving = build(), instanced = new InstancedMesh(new BoxGeometry(), moving.material, 2);
  moving.root.userData.dynamic = true; moving.root.add(instanced);
  const original = moving.mesh.geometry, instanceGeometry = instanced.geometry;
  batchStatic(moving.root, { preserveObjects: true });
  expect(moving.mesh.geometry).toBe(original); expect(instanced.geometry).toBe(instanceGeometry);
});
