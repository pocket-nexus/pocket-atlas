import { CircleGeometry, CylinderGeometry, TorusGeometry } from "three";
import { Rng } from "../../core/random";
import { box, cable } from "../shared/geo";
import { rod, v3 } from "../shared/shapes";
import { canvas, toTexture } from "../shared/canvas";
import type { DayWorld } from "../shared/daylight/context";
import { QuadBuilder } from "../shared/daylight/geometry";
import { house, houseKit, type HouseSpec } from "../shared/daylight/houses";
import { foliage } from "../shared/daylight/foliage";
import { crossingSignal, railway, safetyRail, sign } from "../shared/daylight/railway";
import { petalDrift, tree } from "../shared/daylight/trees";
import { PASS } from "./rail";

/** The railway crest is y=0; the short western lane falls away beyond it. Metres, approximate from photographs. */
export function roadY(z: number): number {
  if (z > 4.4) return -Math.min(1.5, (z - 4.4) * 0.044);
  if (z < -4.4) return -Math.min(3.2, (-z - 4.4) * 0.105);
  return 0.07;
}

export function buildGround(w: DayWorld): void {
  const asphalt = w.lib.asphalt(1.3, 0xb1adb9), curb = w.lib.concrete([0.89, 0.88, 0.86]);
  const g = new QuadBuilder();
  // The far road bends around the shuttered house; the central view remains a narrow lane.
  for (let z = -64; z < 48; z += 1) {
    const y0 = roadY(z), y1 = roadY(z + 1);
    g.quad([v3(-2.75, y0, z), v3(2.75, y0, z), v3(2.75, y1, z + 1), v3(-2.75, y1, z + 1)], v3(0, 1, 0), [[0, z], [5.5, z], [5.5, z + 1], [0, z + 1]]);
    for (const x of [-2.97, 2.97]) {
      const m = w.mesh(box(0.32, 0.15, 0.99), curb, x, (y0 + y1) / 2 + 0.03, z + 0.5);
      m.rotation.x = -Math.atan(y1 - y0);
      // Gutter seam and individual grates.
      const grate = z % 7 === 0;
      w.mesh(box(0.22, 0.012, grate ? 0.5 : 0.985), w.lib.plain(grate ? 0x535853 : 0x8e8c84, 0.87), x * 0.923, (y0 + y1) / 2 + 0.008, z + 0.5);
      if (grate) for (let dz = 0.29; dz < 0.75; dz += 0.052) w.mesh(box(0.17, 0.008, 0.019), w.lib.plain(0x222a28), x * 0.923, (y0 + y1) / 2 + 0.017, z + dz);
    }
  }
  w.mesh(g.build(), asphalt, 0, 0, 0, w.root, { cast: false });
  for (const x of [-27, 27]) {
    const side = new QuadBuilder();
    for (let z = -80; z < 65; z += 2) side.quad([v3(x - 24, roadY(z) - 0.08, z), v3(x + 24, roadY(z) - 0.08, z), v3(x + 24, roadY(z + 2) - 0.08, z + 2), v3(x - 24, roadY(z + 2) - 0.08, z + 2)], v3(0, 1, 0), [[0, 0], [48, 0], [48, 2], [0, 2]]);
    w.mesh(side.build(), w.lib.ground(), 0, 0, 0, w.root, { cast: false });
  }
  const white = w.lib.roadPaint(0xc7c4b6);
  for (const z of [-7.2, 7.4]) w.mesh(box(4.65, 0.008, 0.19), white, 0, roadY(z) + 0.022, z);
  for (const z of [-19, 18]) {
    const cover = w.mesh(new CylinderGeometry(0.28, 0.28, 0.018, 40), w.lib.plain(0x53575a, 0.82, 0.3), -0.52, roadY(z) + 0.02, z);
    cover.rotation.x = z > 0 ? 0.044 : -0.105;
    w.mesh(new TorusGeometry(0.3, 0.014, 6, 40).rotateX(Math.PI / 2), w.lib.plain(0x92918a, 0.75), -0.52, roadY(z) + 0.026, z);
    for (let j = -3; j <= 3; j++) w.mesh(box(0.37, 0.008, 0.012), w.lib.plain(0x777c7a), -0.52, roadY(z) + 0.032, z + j * 0.064);
  }
  railway(w, 0.105, 210);
  crossingSignal(w, 2.78, -4.55, -0.05, { pass: PASS, armDirection: -1 });
  crossingSignal(w, -2.83, 4.6, 0.09, { pass: PASS, armDirection: 1 });
  for (const side of [-1, 1]) for (const [za, zb] of [[5.4, 9.3], [-5.6, -8.0]]) {
    safetyRail(w, [za, (za + zb) / 2, zb].map((z) => v3(side * 2.9, roadY(z) + 0.1, z)));
  }
}

export function buildNeighbourhood(w: DayWorld): void {
  const l = w.lib, kit = houseKit(w);
  const cream = l.siding(0xe3e1d6), white = l.stucco(0xe8e7e0), grey = l.siding(0xb7bbb8);
  const tile = l.tileRoof(0x5c6267), roof = l.sheetRoof(0x5b6567);
  const add = (spec: HouseSpec) => house(w, kit, spec);
  // Photo-matched principal masses: balcony villa left; white shuttered house ahead.
  add({ x0: -11.5, x1: -4.35, z0: -18.2, z1: -7.1, base: -0.5, foot: -2, floors: 3, floorH: 2.48, wall: cream, roof: { kind: "flat", mat: l.concrete() }, faces: { "+z": { balcony: 2, dense: 2 }, "+x": { door: true, dense: 3 }, "-z": {} }, seed: 177 });
  add({ x0: 5.9, x1: 13, z0: -19.1, z1: -7.2, base: -0.8, foot: -2, floors: 2, wall: white, roof: { kind: "gable", ridge: "z", mat: tile, pitch: 0.36 }, faces: { "+z": { dense: 2 }, "-x": { door: true }, "+x": {} }, seed: 83 });
  add({ x0: -1, x1: 6.8, z0: -38, z1: -30, base: -3.05, foot: -3.5, floors: 2, floorH: 2.5, wall: cream, roof: { kind: "hip", mat: roof, pitch: 0.33 }, faces: { "+z": { floors: [1], balcony: 1, dense: 2 }, "-x": { door: true }, "+x": {} }, seed: 617 });
  // Roller shutter, dark lintel, narrow external stairs and frosted balcony match the lane end.
  w.mesh(box(4.15, 2.13, 0.06), l.sheetRoof(0xa6b4ac), 3.0, -1.54, -29.96);
  for (const x of [0.87, 5.12]) w.mesh(box(0.14, 2.35, 0.2), l.concrete(), x, -1.5, -29.89);
  w.mesh(box(4.5, 0.19, 0.24), l.concrete(), 3, -0.4, -29.89);
  for (let i = 0; i < 14; i++) {
    const z = -29.1 - i * 0.28, y = -3.03 + i * 0.185;
    w.mesh(box(1, 0.185 * (i + 1), 0.282), l.concrete([0.66, 0.8, 0.78]), -1.73, -3.03 + 0.185 * (i + 1) / 2, z);
    if (i % 3 === 0) for (const x of [-2.26, -1.2]) w.mesh(rod(v3(x, y, z), v3(x, y + 0.86, z), 0.022), l.paint(0x677d75));
  }
  for (const x of [-2.26, -1.2]) w.mesh(rod(v3(x, -2.17, -29.1), v3(x, 0.24, -32.74), 0.025), l.paint(0x677d75));
  sign(w, "代々木五丁目\n47", 0.28, 0.63, l.paint(0x657b78), v3(0.68, -1.4, -29.72), "#47676a", "#e3eadf");
  // Foreground homes make reverse angles and free orbit a complete place.
  add({ x0: -12.8, x1: -4.3, z0: 7.1, z1: 17, base: -0.3, floors: 2, wall: l.stucco(0xc6b9a4), roof: { kind: "gable", mat: tile, ridge: "z" }, faces: { "+x": { door: true, balcony: 1 }, "-z": { dense: 2 }, "+z": {} }, seed: 611 });
  add({ x0: 4.8, x1: 12.1, z0: 6.3, z1: 16, base: -0.4, floors: 2, wall: l.stucco(0xd9d5c9), roof: { kind: "hip", mat: roof }, faces: { "-x": { door: true }, "-z": { balcony: 1 }, "+z": {} }, seed: 422 });
  const r = new Rng(533);
  const far = new Rng(9137);
  // Close the longer railway corridor behind a full-length formation, away from the focal street.
  for (const side of [-1, 1]) for (let x = -200; x <= 200; x += 15) {
    if (Math.abs(x) < 60) continue;
    const z = x * 0.105 + side * far.range(12, 16);
    add({ x0: x - 5.8, x1: x + 5.8, z0: z - 4.8, z1: z + 4.8, base: -0.4, floors: far.pick([2, 2, 3]), wall: far.pick([cream, white, grey]), roof: { kind: far.pick(["hip", "gable"]), mat: roof }, faces: { [side < 0 ? "+z" : "-z"]: {} }, seed: far.int(1, 99999), detail: "mid" });
  }
  for (const side of [-1, 1]) for (const z of [-69, -58, -46, -29, 24, 35, 47]) {
    if (z === -29 && side === 1) continue;
    const x = side * r.range(8, 10), width = r.range(6, 8);
    add({ x0: x - width / 2, x1: x + width / 2, z0: z - 4.3, z1: z + 4.3, base: roadY(z), floors: r.pick([2, 2, 3]), wall: r.pick([cream, white, grey, l.stucco(0xc3b3a4)]), roof: { kind: r.pick(["gable", "hip", "flat"]), mat: r.pick([tile, roof]) }, faces: { [side < 0 ? "+x" : "-x"]: { door: true, balcony: 1 }, "+z": { dense: 2 }, "-z": {} }, seed: r.int(1, 9999) });
  }
  for (const side of [-1, 1]) for (let row = 0; row < 3; row++) for (let i = 0; i < 8; i++) {
    const x = side * (21 + row * 12), z = -59 + i * 15;
    if (Math.abs(z) < 7) continue;
    add({ x0: x - 4.4, x1: x + 4.4, z0: z - 5, z1: z + 5, base: roadY(z) - 0.1, floors: r.pick([2, 2, 3, 4]), wall: r.pick([cream, grey, white]), roof: { kind: r.pick(["hip", "flat", "gable"]), mat: roof }, faces: { "+z": {}, "-z": {}, [side < 0 ? "+x" : "-x"]: {} }, seed: r.int(1, 99999), detail: "mid" });
  }
  // A bend beyond the explorable street closes the reverse view with neighbourhood, not the sky dome.
  add({ x0: -1.5, x1: 7.5, z0: 58, z1: 66, base: roadY(58), floors: 3, wall: grey, roof: { kind: "hip", mat: tile }, faces: { "-z": { balcony: 1, dense: 2 }, "-x": {} }, seed: 963 });
  // Retaining walls are in short courses following the grade, with coping and recessed gates.
  for (const side of [-1, 1]) for (const [a, b] of [[-27, -7], [9.5, 42]]) for (let z = a; z < b; z += 1.9) {
    const h = side === -1 ? 1.07 : 0.82;
    w.mesh(box(0.2, h, 1.87), l.block(), side * 3.65, roadY(z) + h / 2, z);
    w.mesh(box(0.29, 0.085, 1.88), l.concrete(), side * 3.65, roadY(z) + h + 0.045, z);
  }
}

export function buildStreetDetails(w: DayWorld): void {
  const l = w.lib;
  const dark = l.plain(0x303a38, 0.72), metal = l.plain(0x82928d, 0.4, 0.6);
  // Street pole series: transformers, junction boxes, service drops and sagging bundles.
  const positions = [[-3.75, 11.6], [-3.65, -10.8], [-3.4, -29], [-3.5, -52], [3.9, 34.7]];
  for (const [x, z] of positions) {
    const y = roadY(z), top = y + 8.7;
    w.mesh(rod(v3(x, y, z), v3(x, top, z), 0.14, 14, 0.08), l.concrete([0.73, 0.74, 0.68]));
    w.mesh(rod(v3(x - 0.74, top - 0.9, z), v3(x + 0.74, top - 0.9, z), 0.033), metal);
    for (const dx of [-0.6, 0, 0.6]) for (let h = 0; h < 4; h++) w.mesh(new CylinderGeometry(0.066, 0.061, 0.036, 10), l.plain(0xd8e0d1), x + dx, top - 0.83 + h * 0.053, z);
    w.mesh(new CylinderGeometry(0.22, 0.21, 0.62, 16), metal, x - 0.23, top - 1.9, z);
    w.mesh(box(0.24, 0.4, 0.19), l.paint(0xa6b2a3), x, y + 2.3, z + 0.18);
    for (let yy = y + 2.8; yy < top - 1.1; yy += 0.46) w.mesh(rod(v3(x - 0.18, yy, z), v3(x + 0.18, yy, z), 0.012), dark);
    w.mesh(rod(v3(x, top - 2.5, z), v3(x + 0.65, top - 2.35, z), 0.027), metal);
    w.mesh(box(0.48, 0.09, 0.18), l.paint(0xc6cfc8), x + 0.68, top - 2.38, z);
    w.mesh(box(0.43, 0.014, 0.14), l.plain(0xe5eddf), x + 0.68, top - 2.434, z);
    for (const yy of [y + 0.6, y + 1.6]) w.mesh(new CylinderGeometry(0.151, 0.151, 0.12, 12), l.paint(0xc7b73d), x, yy, z);
  }
  for (let i = 1; i < positions.length - 1; i++) {
    const [ax, az] = positions[i - 1], [bx, bz] = positions[i];
    for (let j = 0; j < 6; j++) {
      const dx = j < 3 ? (j - 1) * 0.57 : (j - 4) * 0.09;
      const h = j < 3 ? 7.97 : 6.5 - (j - 3) * 0.14;
      w.mesh(cable(v3(ax + dx, roadY(az) + h, az), v3(bx + dx, roadY(bz) + h, bz), 0.4 + j * 0.08, j < 3 ? 0.011 : 0.022), dark);
    }
  }
  for (const z of [-12, 13, -29, 35]) for (const dy of [0, 0.22]) w.mesh(cable(v3(-3.6, roadY(z) + 6.1 + dy, z), v3(11, roadY(z) + 6.8 + dy, z - 7), 0.6, 0.012), dark);
  // Convex road mirror, orange post, white rim and rain hood.
  const mx = 0.72, mz = -23.2, my = roadY(mz);
  w.mesh(rod(v3(mx, my, mz), v3(mx, my + 3.22, mz), 0.035), l.paint(0xc97a43));
  const { c, g } = canvas(256, 256);
  const gradient = g.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, "#708eac"); gradient.addColorStop(0.47, "#c8e0e3"); gradient.addColorStop(0.49, "#606d70"); gradient.addColorStop(1, "#a7aaa1");
  g.fillStyle = gradient; g.fillRect(0, 0, 256, 256);
  g.fillStyle = "#59716a"; g.beginPath(); g.moveTo(0, 75); g.lineTo(70, 95); g.lineTo(118, 230); g.lineTo(0, 220); g.fill();
  g.fillStyle = "#b7c4b9"; g.fillRect(150, 85, 97, 83);
  const mirror = w.mesh(new CircleGeometry(0.34, 48), l.printed("convex-mirror", toTexture(c), 0.17), mx, my + 3.04, mz + 0.03); mirror.rotation.y = -0.17;
  w.mesh(new TorusGeometry(0.348, 0.026, 8, 48), l.paint(0xd6d4c9), mx, my + 3.04, mz + 0.045);
  const hood = w.mesh(new CylinderGeometry(0.38, 0.38, 0.14, 32, 1, true, 0, Math.PI), l.paint(0xbf794d), mx, my + 3.045, mz - 0.01); hood.rotation.x = Math.PI / 2;
  sign(w, "とまれ\n踏切", 0.47, 0.72, l.paint(0x5a6059), v3(-3.2, 1.3, 8.5));
  sign(w, "参宮橋３号踏切", 0.92, 0.25, l.paint(0x626c65), v3(3.48, 0.58, -5.2), "#eeeee0", "#3b4948");
  // Utility enclosure and short mesh fence behind the right signal.
  w.mesh(box(0.75, 1.35, 0.47), l.paint(0xa4aaa0), 4.2, 0.67, -5.3);
  w.mesh(box(0.78, 0.05, 0.5), metal, 4.2, 1.36, -5.3);
  for (let y = 0.7; y < 1.13; y += 0.06) w.mesh(box(0.48, 0.018, 0.012), dark, 4.2, y, -5.058);
  // Domestic details below the greenery: terracotta pots, a mailbox, rainwater pipes.
  for (const [x, z] of [[-3.25, -13], [-3.21, -14.1], [3.24, -18], [3.28, 18.5]]) {
    w.mesh(new CylinderGeometry(0.23, 0.16, 0.33, 14), l.plain(0x946854, 0.91), x, roadY(z) + 0.17, z);
    w.mesh(new CylinderGeometry(0.204, 0.2, 0.018, 14), l.ground(), x, roadY(z) + 0.34, z);
  }
  w.mesh(box(0.35, 0.32, 0.14), l.paint(0x4d655f), -3.49, roadY(-18) + 1.31, -18);
  w.mesh(box(0.28, 0.03, 0.02), dark, -3.49, roadY(-18) + 1.4, -17.92);
}

export function buildGardens(w: DayWorld): void {
  // Main composition: leafy villa on the left; pale spreading cherries above the right-hand signal.
  const trees: [number, number, number, number, boolean, number, number][] = [
    [-3.99, -9.1, 7.1, 3.7, false, 0.35, -0.3],
    [-4.03, -18.7, 8.4, 3.5, false, 0.25, 0],
    [5.6, -10.7, 9.3, 5.1, true, -1.25, 0.4],
    [6.1, -21.2, 8, 4.3, true, -0.8, 0],
    [-6.1, -26, 6.5, 3.5, true, 0.4, 0],
    [4.15, 12.1, 8.4, 4.2, true, -0.65, 0],
    [-6.5, 18.4, 7.5, 3.6, true, 0.2, 0],
    [-12.4, -8.2, 9.4, 3.7, true, -0.15, 0],
    [11.5, -33, 8.6, 4.1, true, 0, 0],
    [-9, -44, 6.5, 3.2, false, 0, 0],
    [9, 37, 6.6, 3.4, false, 0, 0],
  ];
  trees.forEach(([x, z, height, radius, bloom, lx, lz], i) => tree(w, { at: [x, roadY(z), z], height, radius, bloom, lean: [lx, lz], seed: 580 + i * 67 }));
  const f = foliage(w), cards = f.begin(), r = new Rng(782);
  for (const side of [-1, 1]) for (const [za, zb] of [[-27, -7], [10, 32]]) for (let z = za; z < zb; z += 0.66) {
    const radius = r.range(0.42, 0.8);
    f.clump(cards, r, v3(side * r.range(3.8, 4.4), roadY(z) + r.range(0.8, 1.2), z), radius, 15);
  }
  // Ivy on the villa's fence and front wall (with irregular uncovered gaps).
  for (let i = 0; i < 95; i++) {
    const z = r.range(-16.7, -7.8), y = r.range(0.4, 5.8);
    if (r.chance(0.23)) continue;
    f.clump(cards, r, v3(-4.25 + r.range(-0.08, 0.12), roadY(z) + y, z), r.range(0.22, 0.52), 8);
  }
  for (let i = 0; i < 150; i++) {
    const x = r.range(-9.8, -4.4), y = r.range(0.4, 6.2);
    if (Math.sin(x * 2 + y * 0.6) < -0.2) continue;
    f.clump(cards, r, v3(x, y - 0.2, -6.85 + r.range(-0.1, 0.18)), r.range(0.3, 0.62), 10);
  }
  for (const [x, z] of [[-3.25, -13], [-3.21, -14.1], [3.24, -18], [3.28, 18.5]]) f.clump(cards, r, v3(x, roadY(z) + 0.59, z), 0.3, 14);
  f.end(cards);
  petalDrift(w, roadY);
}
