import { CylinderGeometry, LatheGeometry, Vector2, type Object3D } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mapUV } from "../../gfx/atlas";
import { JP_SANS, LATIN } from "../../gfx/canvas";
import { box } from "../../gfx/geo";
import type { World } from "../context";
import { acUnit } from "../konbini";
import { L } from "../layout";
import { BIKE_COLORS, bicycleFactory } from "./bicycle";
import { Foliage } from "./foliage";
import { hazardStripes } from "./poles";
import { atlasPlane, palette, rod, tube, v3, type Kit } from "./util";

/** Parked bicycles: by the ramen shop, against the konbini glass, and a row on the south side. */
export function placeBicycles(w: World): void {
  const bike = bicycleFactory(w);
  const root = w.group();
  root.name = "bicycles";
  const [cream, navy, burgundy] = BIKE_COLORS;
  // North side, on the road-edge strip in front of the ramen shop.
  bike(root, -9.62, -0.58, Math.PI - 0.1, { color: navy, steer: 0.38, roll: 0.03 });
  bike(root, -12.2, -0.55, 0.14, { color: cream, steer: -0.45, roll: -0.03 });
  // Leaning on the konbini glass beside the west pillar.
  bike(root, -3.72, L.konbini.front + 0.47, Math.PI, { color: burgundy, steer: -0.2, roll: 0.13 });
  // South side, nosed in toward the shopfronts at an angle.
  bike(root, -7.45, 6.78, -0.46, { color: burgundy, steer: 0.3, roll: -0.03 });
  bike(root, -6.15, 6.8, -0.42, { color: cream, steer: -0.22, roll: 0.02 });
  bike(root, -4.85, 6.76, -0.5, { color: navy, steer: 0.5, roll: -0.02 });
}

/** Gas and electric meters, pipes and an AC unit on the konbini's alley wall. */
function alleyServices(w: World, kit: Kit): void {
  const lib = w.lib;
  // Group on the konbini's west wall (outer face x = −5), local +z pointing into the alley (−x).
  const g = w.group(L.konbini.x0, 0, 0, -Math.PI / 2);
  const P = palette(lib);
  const gasPipe = P.yellow;
  const gray = P.gray;
  const pvc = P.galv;
  // Gas meter (local x = world z).
  const mz = -2.55;
  w.mesh(new RoundedBoxGeometry(0.3, 0.36, 0.17, 2, 0.02), gray, mz, 1.35, 0.1, g);
  const dial = kit.draw("gasmeter", 64, 64, (c, cw, ch) => {
    c.fillStyle = "#e8e8e4";
    c.fillRect(0, 0, cw, ch);
    c.fillStyle = "#101010";
    c.fillRect(cw * 0.12, ch * 0.2, cw * 0.76, ch * 0.24);
    c.fillStyle = "#e8e8e4";
    c.font = `700 ${ch * 0.18}px ${LATIN}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("0 4 7 1 2", cw / 2, ch * 0.33);
    c.fillStyle = "#1f4fa3";
    c.font = `800 ${ch * 0.14}px ${JP_SANS}`;
    c.fillText("ガスメーター", cw / 2, ch * 0.7);
  });
  w.mesh(atlasPlane(0.2, 0.2, dial), kit.labels, mz, 1.38, 0.187, g, { cast: false });
  w.mesh(tube([v3(mz - 0.08, 0.02, 0.08), v3(mz - 0.08, 0.9, 0.08), v3(mz - 0.08, 1.12, 0.1), v3(mz - 0.08, 1.17, 0.1)], 0.018, 6), gasPipe, 0, 0, 0, g);
  w.mesh(tube([v3(mz + 0.08, 1.53, 0.1), v3(mz + 0.08, 1.7, 0.1), v3(mz + 0.08, 2.35, 0.06), v3(mz + 0.4, 2.42, 0.05), v3(mz + 1.2, 2.42, 0.05)], 0.018, 6), gasPipe, 0, 0, 0, g);
  // Electric smart meter and conduit to the eaves.
  const ez = -3.35;
  w.mesh(new RoundedBoxGeometry(0.18, 0.28, 0.11, 2, 0.015), P.white, ez, 1.75, 0.06, g);
  w.mesh(box(0.08, 0.035, 0.01), P.screen, ez, 1.8, 0.118, g, { cast: false });
  w.mesh(rod(v3(ez, 1.89, 0.05), v3(ez, 4.0, 0.05), 0.02, 6), pvc, 0, 0, 0, g);
  // Rain leader (雨樋) and brackets.
  const dz = -1.55;
  w.mesh(rod(v3(dz, 0.05, 0.07), v3(dz, 4.05, 0.07), 0.042, 10), pvc, 0, 0, 0, g);
  for (const y of [0.9, 2.1, 3.3]) w.mesh(box(0.1, 0.03, 0.08), pvc, dz, y, 0.035, g, { cast: false });
  // AC outdoor unit on the alley floor with its insulated line set.
  const ac = w.group(-6.2, 0.06, 0.16, 0, g);
  acUnit(w, ac);
  w.mesh(tube([v3(-5.85, 0.4, 0.06), v3(-5.75, 0.6, 0.04), v3(-5.75, 2.6, 0.04), v3(-5.6, 2.8, 0.02)], 0.03, 6), P.white, 0, 0, 0, g);
  // Beer crates stacked in the alley.
  crates(w, g, -8.2, 0.3, 4, 0);
}

/** A stack of plastic beer crates (ビールケース). */
function crates(w: World, parent: Object3D, x: number, z: number, n: number, ry: number): void {
  const lib = w.lib;
  const P = palette(lib);
  const cols = [P.yellow, P.red];
  const bottles = P.black;
  const g = w.group(x, 0, z, ry, parent);
  for (let i = 0; i < n; i++) {
    const col = cols[i % 3 === 2 ? 1 : 0];
    const y = i * 0.3;
    const dx = (i % 2) * 0.03 - 0.015;
    // Open-top crate: floor, four walls with a hand slot band.
    w.mesh(box(0.46, 0.03, 0.34), col, dx, y + 0.015, 0, g);
    w.mesh(box(0.46, 0.28, 0.02), col, dx, y + 0.14, 0.16, g);
    w.mesh(box(0.46, 0.28, 0.02), col, dx, y + 0.14, -0.16, g);
    w.mesh(box(0.02, 0.28, 0.34), col, dx + 0.22, y + 0.14, 0, g);
    w.mesh(box(0.02, 0.28, 0.34), col, dx - 0.22, y + 0.14, 0, g);
    if (i === n - 1) for (let b = 0; b < 6; b++) w.mesh(new CylinderGeometry(0.03, 0.03, 0.24, 8), bottles, dx - 0.15 + (b % 3) * 0.15, y + 0.15, b < 3 ? -0.07 : 0.07, g, { cast: false });
  }
}

/** Potted plants (植木鉢) lined up along a facade. */
function pots(w: World, foliage: Foliage, x0: number, z: number, count: number, seed: number): void {
  const lib = w.lib;
  const r = w.rng;
  const P = palette(lib);
  const clay = [lib.plain(0x7e4128, 0.85), P.blue, P.dark];
  const soil = lib.plain(0x1c1510, 0.9);
  const foam = P.white;
  let x = x0;
  for (let i = 0; i < count; i++) {
    const rad = r.range(0.11, 0.2);
    const h = rad * r.range(1.0, 1.4);
    const zz = z + r.range(-0.08, 0.08);
    if ((i + seed) % 4 === 3) {
      // Styrofoam fish box turned planter, overgrown with fern.
      w.mesh(box(0.56, 0.24, 0.34), foam, x + 0.28, 0.12, zz, w.root);
      w.mesh(box(0.52, 0.02, 0.3), soil, x + 0.28, 0.235, zz, w.root, { cast: false });
      for (let k = 0; k < 2; k++) w.mesh(foliage.clump(r, 3, 0.3, 0.42, 16), foliage.material, x + 0.16 + k * 0.24, 0.24, zz, w.root, { ry: r.range(0, 6) });
      x += 0.66;
      continue;
    }
    w.mesh(new CylinderGeometry(rad, rad * 0.75, h, 16), clay[(i + seed) % 3], x + rad, h / 2, zz, w.root);
    w.mesh(new CylinderGeometry(rad * 0.94, rad * 0.94, 0.02, 16), soil, x + rad, h - 0.02, zz, w.root, { cast: false });
    const kind = (((i * 7 + seed) % 3) as 0 | 1 | 2);
    const size = rad * (kind === 1 ? 3.2 : 2.4);
    w.mesh(foliage.clump(r, kind, size, size * (kind === 1 ? 1.6 : 1.1), kind === 2 ? 34 : 22), foliage.material, x + rad, h - 0.03, zz, w.root, { ry: r.range(0, 6) });
    x += rad * 2 + r.range(0.04, 0.12);
  }
}

/** Traffic cones with a striped cone bar closing the fifth parking bay. */
function cones(w: World, kit: Kit, ax: number, bx: number, z: number): void {
  const lib = w.lib;
  const P = palette(lib);
  const red = P.red;
  const white = P.white;
  const prof = [
    [0, 0.03],
    [0.13, 0.03],
    [0.05, 0.68],
    [0.03, 0.7],
    [0, 0.7],
  ].map(([a, b]) => new Vector2(a, b));
  const cone = new LatheGeometry(prof, 16);
  for (const x of [ax, bx]) {
    w.mesh(cone, red, x, 0, z, w.root);
    w.mesh(box(0.36, 0.03, 0.36), P.black, x, 0.015, z, w.root);
    for (const [y0, y1] of [
      [0.36, 0.44],
      [0.53, 0.58],
    ]) {
      const r0 = 0.13 - (0.08 * (y0 - 0.03)) / 0.65 + 0.003;
      const r1 = 0.13 - (0.08 * (y1 - 0.03)) / 0.65 + 0.003;
      w.mesh(new CylinderGeometry(r1, r0, y1 - y0, 16, 1, true), white, x, (y0 + y1) / 2, z, w.root, { cast: false });
    }
  }
  const cell = kit.draw("guard", 32, 320, (g, cw, ch) => hazardStripes(g, cw, ch, cw));
  const bar = mapUV(rod(v3(ax, 0.66, z), v3(bx, 0.66, z), 0.024, 8), cell);
  w.mesh(bar, kit.labels, 0, 0, 0, w.root);
}

/** Red post box (郵便差出箱) on a leg, beside the konbini's east pillar. */
function postBox(w: World, kit: Kit, x: number, z: number): void {
  const lib = w.lib;
  const P = palette(lib);
  const red = P.red;
  const g = w.group(x, 0, z, 0);
  w.mesh(box(0.14, 0.7, 0.14), red, 0, 0.35, 0, g);
  w.mesh(box(0.4, 0.2, 0.3), P.black, 0, 0.02, 0, g, { cast: false });
  w.mesh(new RoundedBoxGeometry(0.44, 0.56, 0.36, 2, 0.03), red, 0, 0.98, 0, g);
  const roof = box(0.48, 0.04, 0.4);
  roof.rotateX(-0.12);
  w.mesh(roof, red, 0, 1.28, 0, g);
  // Twin slots and the front plate.
  for (const sx of [-0.1, 0.1]) w.mesh(box(0.15, 0.025, 0.01), P.black, sx, 1.15, 0.182, g, { cast: false });
  const plate = kit.draw("postbox", 96, 96, (c, cw, ch) => {
    c.fillStyle = "#f4f2ea";
    c.fillRect(0, 0, cw, ch);
    c.fillStyle = "#c8161d";
    c.font = `900 ${ch * 0.42}px ${JP_SANS}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("〒", cw / 2, ch * 0.32);
    c.fillStyle = "#222";
    c.font = `700 ${ch * 0.12}px ${JP_SANS}`;
    c.fillText("取集時刻", cw / 2, ch * 0.62);
    c.font = `700 ${ch * 0.11}px ${LATIN}`;
    c.fillText("10:30  15:00", cw / 2, ch * 0.78);
    c.fillText("SAT 11:00", cw / 2, ch * 0.9);
  });
  w.mesh(atlasPlane(0.22, 0.22, plate), kit.labels, 0, 0.93, 0.182, g, { cast: false });
}

/** 駐輪禁止 plate on the konbini's west pillar (right above the bike leaning there). */
function noBikeSign(w: World, kit: Kit): void {
  const cell = kit.draw("nobike", 96, 128, (c, cw, ch) => {
    c.fillStyle = "#f7f6f0";
    c.fillRect(0, 0, cw, ch);
    c.strokeStyle = "#d8201a";
    c.lineWidth = 5;
    c.beginPath();
    c.arc(cw / 2, ch * 0.3, cw * 0.22, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(cw / 2 - cw * 0.15, ch * 0.3 - cw * 0.15);
    c.lineTo(cw / 2 + cw * 0.15, ch * 0.3 + cw * 0.15);
    c.stroke();
    // Bicycle pictogram under the slash.
    c.strokeStyle = "#222";
    c.lineWidth = 2;
    const cy = ch * 0.33;
    for (const dx of [-0.09, 0.09]) {
      c.beginPath();
      c.arc(cw / 2 + cw * dx, cy, cw * 0.055, 0, Math.PI * 2);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(cw / 2 - cw * 0.09, cy);
    c.lineTo(cw / 2, cy - cw * 0.08);
    c.lineTo(cw / 2 + cw * 0.09, cy);
    c.moveTo(cw / 2 - cw * 0.02, cy - cw * 0.1);
    c.lineTo(cw / 2 + cw * 0.05, cy - cw * 0.1);
    c.stroke();
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillStyle = "#d8201a";
    c.font = `900 ${cw * 0.2}px ${JP_SANS}`;
    c.fillText("駐輪禁止", cw / 2, ch * 0.66);
    c.fillStyle = "#333";
    c.font = `700 ${cw * 0.085}px ${JP_SANS}`;
    c.fillText("自転車を置かないで下さい", cw / 2, ch * 0.82);
    c.fillText("ポケットマート", cw / 2, ch * 0.92);
  });
  w.mesh(atlasPlane(0.27, 0.36, cell), kit.labels, L.konbini.x0 + 0.19, 1.45, L.konbini.front + 0.006, w.root, { cast: false });
}

export function buildClutter(w: World, kit: Kit): void {
  alleyServices(w, kit);
  // Potted plants along the south shopfronts and by the izakaya.
  const foliage = new Foliage(w.lib.wet);
  pots(w, foliage, -14.3, L.mainSouth - 0.28, 7, 0);
  pots(w, foliage, -1.2, L.mainSouth - 0.26, 3, 2);
  pots(w, foliage, -20.6, L.mainNorth + 0.24, 5, 1);
  // Crates against the konbini's east wall on the side strip.
  crates(w, w.root, L.konbini.x1 + 0.3, -7.3, 3, Math.PI / 2);
  crates(w, w.root, L.konbini.x1 + 0.3, -7.85, 2, Math.PI / 2 + 0.08);
  cones(w, kit, 19.55, 21.35, -1.55);
  postBox(w, kit, L.konbini.x1 + 0.55, L.konbini.front + 0.3);
  noBikeSign(w, kit);
}
