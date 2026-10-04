import { expect, test } from "bun:test";
import { BoxGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, ShaderMaterial, Texture, Vector3 } from "three";
import { record } from "../src/places/shared/export";
import { validateExportMaterial, validateExportObject } from "../src/places/shared/export-contract";

const world = () => {
  const root = new Group(), actor = new Group(); actor.name = "moving-actor"; actor.userData.dynamic = true; root.add(actor);
  return { root, actor, fogLights: [], updaters: [(dt: number) => { actor.position.x += dt * 3; }] };
};
test("fresh stateful actors start at zero and fixed-step warmup is independent of wall time", () => {
  const first = world(), second = world();
  const a = record(first, 1, 10, 2), b = record(second, 1, 10, 2);
  expect(a.tracks[0].pos).toEqual(b.tracks[0].pos);
  expect(a.tracks[0].pos[0]).toBeCloseTo(6);
  expect(a.tracks[0].pos[27]).toBeCloseTo(8.7);
  expect(first.actor.position.x).toBeCloseTo(6); // exported rest pose matches first sampled frame
  expect(record(world(), 1, 10, 0).tracks[0].pos[0]).toBe(0);
});
test("animated scale cannot disappear into position/rotation-only native tracks", () => {
  const w = world(); w.updaters = [(dt: number) => { w.actor.scale.x += dt; }];
  expect(() => record(w, 1, 10, 0)).toThrow("Animated scale");
});
test("the exported rest state includes first-frame emission and vertical fog-light motion", () => {
  const w=world(), material=new MeshStandardMaterial(); w.root.add(new Mesh(new BoxGeometry(),material));
  const light={position:new Vector3(),color:new Color(),radius:2,gain:0};
  const scene={...w,fogLights:[light],updaters:[(_dt:number,t:number)=>{material.emissiveIntensity=t+1;light.position.y=t*2;light.gain=t+0.5;}]};
  const result=record(scene,1,10,2);
  expect(result.fogs[0].moved).toBe(true);
  expect(light.position.y).toBeCloseTo(4);expect(light.gain).toBeCloseTo(2.5);expect(material.emissiveIntensity).toBeCloseTo(3);
  w.updaters=[()=>{w.actor.position.x=NaN;}];
  expect(()=>record(w,1,10,0)).toThrow("Non-finite");
});
test("unsupported shaders, physical extensions, morph targets and displacement fail with an actionable contract error", () => {
  validateExportMaterial(new MeshStandardMaterial());
  validateExportMaterial(new MeshBasicMaterial());
  validateExportMaterial(new MeshPhysicalMaterial({ clearcoat: 1, clearcoatRoughness: 0.12 }));
  expect(() => validateExportMaterial(new ShaderMaterial())).toThrow("Unsupported material");
  expect(() => validateExportMaterial(new MeshPhysicalMaterial({ transmission: 1 }))).toThrow("physical extension");
  const patched = new MeshStandardMaterial(); patched.onBeforeCompile = () => {};
  expect(() => validateExportMaterial(patched)).toThrow("Unannotated shader");
  patched.userData.pocketAtlas = { wet: { planar: true } }; validateExportMaterial(patched);
  patched.userData.pocketAtlas = { emissionShade: { normal: [0.12, 0.4, 0, 0.6], height: [0.05, 1.45, 0.62, 1] } };
  validateExportMaterial(patched);
  const displaced = new MeshStandardMaterial({ displacementMap: new Texture() });
  expect(() => validateExportMaterial(displaced)).toThrow("displacement");
  const geometry = new BoxGeometry(); geometry.morphAttributes.position = [new Float32BufferAttribute([0,0,0],3)];
  expect(() => validateExportObject(new Mesh(geometry, new MeshStandardMaterial()))).toThrow("Morph targets");
});
