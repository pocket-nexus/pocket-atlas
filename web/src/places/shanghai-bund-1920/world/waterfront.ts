import { Color, CylinderGeometry, SphereGeometry, Vector3 } from "three";
import { Rng } from "../../../core/random";
import { cable, plane } from "../../shared/geo";
import { source } from "../../shared/provenance";
import type { DayWorld } from "../../shared/daylight/context";
import { cardsGeometry, cluster, leafMaterial, type Cards } from "../../shared/daylight/foliage";
import { bar, block, label } from "./architecture";

/** Read from 1919/1920 photographs; pavement widths are estimates, not today's rebuilt promenade. */
export const GROUND = 0.12;
function streetTree(w: DayWorld, z: number, seed: number) {
  const rng = new Rng(seed), p = source(`bund/street-tree-${seed}`, w.group(4.9, GROUND, z));
  const bark = w.lib.bark(0x9b9386), height = 7.2 + rng.next() * 1.8;
  bar(w, p, bark, [0, 0, 0], [0.16, 4.7, 0], 0.19, 7);
  const cards: Cards = { pos: [], nor: [], uv: [], idx: [] }, crown = new Vector3(0, 6.5, 0), radius = new Vector3(2.2, 2.3, 2.2);
  for (let i = 0; i < 9; i++) {
    const a = i * 2.4, tip = new Vector3(Math.cos(a) * 2.2, height - rng.next() * 2, Math.sin(a) * 2.2);
    bar(w, p, bark, [0.15, 3.2 + i * 0.16, 0], tip.toArray(), 0.065, 5);
    for (let k = 0; k < 3; k++) {
      const at = tip.clone().multiplyScalar(0.8 + k * 0.1).add(new Vector3(0, k * 0.15, 0));
      cluster(cards, rng, at, crown, radius, 0.8, 7, i % 3, 0.95, true);
    }
  }
  w.mesh(cardsGeometry(cards), leafMaterial(w), 0, 0, 0, p);
  for (const side of [-1, 1]) block(w, p, w.lib.granite(), side * 0.72, 0.025, 0, 0.14, 0.1, 1.6);
}

function quay(w: DayWorld) {
  const p = source("bund/old-quay", w.group()), stone = w.lib.cutStone(), metal = w.lib.paint(0x414743), granite = w.lib.granite([0.9, 0.87, 0.79]);
  block(w, p, w.lib.ground(), -44, -1.05, 0, 170, 2, 920);
  block(w, p, w.lib.asphalt(4, 0xb1aca1), 18, -0.05, 0, 25, 0.25, 880);
  block(w, p, granite, 3.5, 0.015, 0, 6.2, 0.3, 360);
  const turf = w.lib.ground().clone(); turf.name = "bund-quay-grass"; turf.color.set(0x8c9964);
  block(w, p, turf, 34, 0.025, 0, 7, 0.28, 390);
  block(w, p, granite, 40, 0.04, 0, 5.1, 0.3, 390);
  block(w, p, stone, 44, -1.8, 0, 3, 3.5, 420);
  for (let z = -195; z <= 195; z += 3) {
    block(w, p, granite, 43, 0.19, z, 1.1, 0.26, 2.96);
    for (const x of [6.5, 30.5, 37.7]) block(w, p, granite, x, 0.16, z, 0.27, 0.25, 2.97);
  }
  // Grass bands, a timber and chain boundary, and stone steps instead of modern flood-wall balustrades.
  for (let z = -180; z <= 180; z += 6) {
    block(w, p, w.lib.paint(0xb8b6a6), 42.65, 0.65, z, 0.13, 1.2, 0.13);
    w.mesh(new SphereGeometry(0.11, 6, 4), w.lib.paint(0xb8b6a6), 42.65, 1.27, z, p);
    if (Math.abs(z + 12) > 12) w.mesh(cable(new Vector3(42.65, 1.05, z), new Vector3(42.65, 1.05, z + 6), 0.24, 0.035, 8), metal, 0, 0, 0, p);
  }
  // Customs pontoon and receiving shed explicitly described in Darwent (1920), p. 8.
  const dock = source("bund/customs-pontoon", w.group(58, -0.36, 0));
  const timber = w.lib.stucco(0x665645), wood = w.lib.paint(0x7c7460), shed = w.lib.stucco(0xa49b83);
  block(w, dock, metal, 0, -0.7, 0, 18, 1.4, 35);
  block(w, dock, wood, 0, 0.13, 0, 18.2, 0.3, 35.2);
  for (let z = -17; z <= 17; z += 0.55) block(w, dock, timber, 0, 0.32, z, 18.2, 0.045, 0.035);
  const bridge = block(w, p, timber, 47, -0.05, -10, 14, 0.28, 4.1); bridge.rotation.z = -0.028;
  for (const z of [-12.1, -7.9]) {
    bar(w, p, metal, [40, 1.2, z], [54, 0.85, z], 0.055);
    for (let x = 40; x < 54; x += 1.5) bar(w, p, metal, [x, -0.1, z], [x, 1.12 - (x - 40) * 0.025, z], 0.04);
  }
  for (const z of [-11, 11]) for (const x of [-7.8, 7.8]) {
    w.mesh(new CylinderGeometry(0.17, 0.24, 0.6, 8), metal, x, 0.55, z, dock);
    bar(w, dock, metal, [x - 0.4, 0.83, z], [x + 0.4, 0.83, z], 0.11);
  }
  block(w, dock, shed, -2, 2, 5, 10, 3.4, 17);
  for (const x of [-4.6, 0.6]) {
    const roof = block(w, dock, w.lib.sheetRoof(0x5b5a50), x, 4.7, 5, 6.1, 0.14, 18); roof.rotation.z = (x < -2 ? 1 : -1) * 0.4;
  }
  for (let z = -2; z <= 12; z += 3.5) {
    block(w, dock, w.lib.glass("dark"), 3.06, 2.5, z, 0.08, 1.4, 1.85);
    block(w, dock, wood, 3.14, 2.5, z, 0.1, 1.4, 0.09);
  }
  label(w, dock, "shed", "CUSTOMS", 6.2, 0.8, 3.15, 3.35, 5, "#b7ae95");
  const crates = source("bund/cargo-crates", w.group());
  for (let i = 0; i < 21; i++) {
    const x = 53 + (i % 3) * 1.25, z = 13 + Math.floor(i / 3) * 0.76;
    const y = i % 5 === 0 ? 0.8 : 0.25;
    block(w, crates, timber, x, y, z, 1.1, 0.8, 0.64);
    for (const dz of [-0.23, 0.23]) block(w, crates, wood, x + 0.56, y, z + dz, 0.03, 0.86, 0.09);
  }
  for (let i = 0; i < 5; i++) {
    const barrel = w.mesh(new CylinderGeometry(0.35, 0.33, 0.9, 10), timber, 6.3, 0.65, 9 + i * 1.1, dock);
    // No brand stencils are invented for cargo from an unidentified photograph.
    barrel.name = `cargo-barrel-${i}`;
  }
}

function tramway(w: DayWorld) {
  const p = source("bund/tramway", w.group()), steel = w.lib.paint(0x787b74, 0.35), iron = w.lib.paint(0x424b48);
  for (const x of [12 - 0.7175, 12 + 0.7175, 16 - 0.7175, 16 + 0.7175]) block(w, p, steel, x, 0.101, 0, 0.08, 0.04, 860);
  for (let z = -200; z <= 200; z += 28) {
    w.mesh(new CylinderGeometry(0.075, 0.17, 8.2, 8), iron, 6.8, 4.2, z, p);
    for (const x of [12, 16]) {
      bar(w, p, iron, [6.8, 7.8, z], [x + 0.5, 7.35, z], 0.05);
      w.mesh(cable(new Vector3(x, 7.25, z), new Vector3(x, 7.25, z + 28), 0.23, 0.038, 8), iron, 0, 0, 0, p);
      w.mesh(new CylinderGeometry(0.1, 0.1, 0.18, 6), w.lib.plain(0xd0c6ad), x, 7.3, z, p);
    }
  }
  // Slim gas/electric-era lantern silhouette; individual pole model is an interpretation.
  for (let z = -155; z <= 160; z += 35) {
    const g = w.group(37.8, 0.12, z, 0, p);
    w.mesh(new CylinderGeometry(0.065, 0.14, 4.8, 8), iron, 0, 2.4, 0, g);
    block(w, g, w.lib.glass("frosted"), 0, 5.1, 0, 0.55, 0.72, 0.55);
    for (const x of [-0.28, 0.28]) for (const zz of [-0.28, 0.28]) bar(w, g, iron, [x, 4.75, zz], [x, 5.5, zz], 0.04);
    w.mesh(new CylinderGeometry(0, 0.47, 0.45, 4), iron, 0, 5.68, 0, g, { ry: Math.PI / 4 });
    block(w, g, iron, 0, 4.73, 0, 0.67, 0.08, 0.67);
  }
}

export function buildWaterfront(w: DayWorld) {
  quay(w); tramway(w);
  for (const [i, z] of [-145, -123, -98, -75, -48, -25, 27, 66, 88, 112, 141].entries()) streetTree(w, z, 192000 + i);
  const water = w.water({ name: "huangpu-silted-river", waves: [{ repeatsPerMetre: 0.025, scroll: [1 / 3, 0] }, { repeatsPerMetre: 0.05, scroll: [0, 1 / 6] }], slope: 0.055,
    roughness: 0.22, distanceRoughness: 0.00045, mask: 0.16, body: new Color(0.105, 0.092, 0.048), envMapIntensity: 0.52 }, { seed: 192003, heading: 0.9, size: 512, strength: 0.2 });
  const river = source("bund/huangpu-river", w.mesh(plane(1000, 1400, 12, 16), water.material, 545, -1.15, 0, w.root, { cast: false, receive: false }));
  river.rotation.x = -Math.PI / 2;
  // Historic Pudong warehouses at a restrained, hazed scale. Their exact individual positions are unknown.
  const far = source("bund/pudong-warehouse-silhouette", w.group());
  for (let i = 0; i < 17; i++) {
    const z = -420 + i * 51, h = 6 + (i % 4) * 1.7;
    block(w, far, w.lib.stucco(0x817c6c), 535 + (i % 3) * 10, h / 2 - 1, z, 45, h, 46);
    block(w, far, w.lib.sheetRoof(0x555850), 535 + (i % 3) * 10, h - 0.6, z, 47, 0.6, 49);
  }
  for (let i = 0; i < 3; i++) w.mesh(new CylinderGeometry(1.2, 2.1, 32 + i * 5, 10), w.lib.stucco(0x746354), 566, 15 + i * 2.5, -165 + i * 145, far);
}
