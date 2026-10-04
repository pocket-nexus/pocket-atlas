import { BufferGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group, Shape, ShapeGeometry, SphereGeometry, TorusGeometry, type Material } from "three";
import type { DayWorld } from "../../shared/daylight/context";
import { batchStatic } from "../../shared/geo";
import { source } from "../../shared/provenance";
import { bar, block } from "./architecture";

export const LOOP = 120;
const TAU = Math.PI * 2;

const hullStations = [[-0.5, 0.025], [-0.46, 0.32], [-0.4, 0.62], [-0.31, 0.83], [-0.2, 0.96], [-0.06, 1], [0.1, 0.99], [0.23, 0.92], [0.34, 0.76], [0.42, 0.56], [0.5, 0.34]];
function sheer(z: number, rise: number) { return Math.pow(Math.abs(z) * 2, 2.8) * rise * (z < 0 ? 1 : 0.82); }
/** Raked stem, tapered waterline and rising sheer, with length along Z. */
function hull(length: number, beam: number, depth: number, rise = 0.65): BufferGeometry {
  const pos: number[] = [], uv: number[] = [], indices: number[] = [];
  const section = [[-0.55, 0], [-0.9, 0.45], [-1, 1], [1, 1], [0.9, 0.45], [0.55, 0]];
  for (const [z, fullness] of hullStations) for (const [x, y] of section) {
    pos.push(x * beam / 2 * fullness, (y - 0.5) * depth + sheer(z, rise), z * length * (0.83 + 0.17 * y));
    uv.push(z * length, y * depth + x * beam / 2);
  }
  for (let j = 0; j < hullStations.length - 1; j++) for (let i = 0; i < 6; i++) {
    const a = j * 6 + i, b = j * 6 + (i + 1) % 6, c = b + 6, d = a + 6;
    indices.push(a, c, b, a, d, c);
  }
  const last = (hullStations.length - 1) * 6;
  for (let i = 1; i < 5; i++) indices.push(0, i, i + 1, last, last + i + 1, last + i);
  const g = new BufferGeometry(); g.setAttribute("position", new Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new Float32BufferAttribute(uv, 2)); g.setIndex(indices); g.computeVertexNormals(); return g;
}
function wheel(w: DayWorld, p: Group, mat: Material, x: number, y: number, z: number, r: number, spokes = 10) {
  const m = w.mesh(new TorusGeometry(r, 0.05, 5, 20), mat, x, y, z, p); m.rotation.y = Math.PI / 2;
  for (let i = 0; i < spokes; i++) {
    const a = TAU * i / spokes;
    bar(w, p, mat, [x, y, z], [x, y + Math.sin(a) * r, z + Math.cos(a) * r], 0.018, 4);
  }
}
function person(w: DayWorld, p: Group, at: [number, number, number], color: number, hat = true) {
  const g = w.group(...at, 0, p), cloth = w.lib.plain(color, 0.95), skin = w.lib.plain(0xb09377, 0.9);
  w.mesh(new CylinderGeometry(0.16, 0.23, 0.66, 7), cloth, 0, 1.07, 0, g);
  w.mesh(new SphereGeometry(0.135, 8, 6), skin, 0, 1.58, 0, g);
  for (const side of [-1, 1]) {
    bar(w, g, cloth, [side * 0.11, 0.8, 0], [side * 0.14, 0.11, side * 0.05], 0.075, 6);
    bar(w, g, cloth, [side * 0.2, 1.28, 0], [side * 0.29, 0.81, -0.04], 0.055, 6);
    block(w, g, w.lib.plain(0x342d27), side * 0.14, 0.06, -0.045, 0.15, 0.1, 0.25);
  }
  if (hat) { w.mesh(new CylinderGeometry(0.15, 0.16, 0.1, 10), w.lib.plain(0xaca18b), 0, 1.71, 0, g); w.mesh(new CylinderGeometry(0.23, 0.23, 0.022, 10), w.lib.plain(0xaca18b), 0, 1.66, 0, g); }
}
function junk(w: DayWorld, name: string, at: [number, number, number], heading: number, scale: number, phase: number) {
  const g = source(name, w.group()), wood = w.lib.paint(0x4a3929, 0.9), trim = w.lib.paint(0x847458, 0.85), rope = w.lib.plain(0x817052, 0.9);
  const L = 17 * scale, B = 4.3 * scale;
  const rise = 1.5 * scale;
  w.mesh(hull(L, B, 1.8 * scale, rise), wood, 0, 0, 0, g);
  // Raised bow and stern / curved gunwales follow the Darwent junk profiles.
  // Two rubbing strakes make the narrow waterline readable at a low quay viewpoint.
  for (const side of [-1, 1]) for (const [height, width] of [[0.9, 1], [0.47, 0.96], [0.12, 0.91]]) {
    for (let i = 0; i < hullStations.length - 1; i++) {
      const [za, wa] = hullStations[i], [zb, wb] = hullStations[i + 1];
      const rake = 0.83 + 0.17 * (height + 0.9) / 1.8;
      bar(w, g, trim, [side * B * wa * width / 2, height * scale + sheer(za, rise), za * L * rake], [side * B * wb * width / 2, height * scale + sheer(zb, rise), zb * L * rake], (height === 0.9 ? 0.075 : 0.035) * scale, 5);
    }
  }
  block(w, g, trim, 0, 0.95 * scale, -L * 0.02, B * 0.65, 0.18, L * 0.61);
  for (let z = -L * 0.31; z < L * 0.27; z += 0.42) block(w, g, wood, 0, 1.055 * scale, z, B * 0.64, 0.03, 0.03);
  // A low woven shelter, open above its timber coaming, not a rectangular cabin.
  block(w, g, trim, 0, 1.44 * scale, L * 0.24, B * 0.66, 0.74 * scale, L * 0.24);
  const roofPos: number[] = [], roofUv: number[] = [], roofIdx: number[] = [];
  const arch = (i: number): [number, number] => [(i / 10 - 0.5) * B * 0.8, (2.04 + Math.sin(i / 10 * Math.PI) * 0.58) * scale];
  for (let i = 0; i <= 10; i++) {
    const [x, y] = arch(i);
    for (const z of [L * 0.1, L * 0.39]) { roofPos.push(x, y, z); roofUv.push(x, z); }
    if (i < 10) roofIdx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3);
  }
  const canopy = new BufferGeometry(); canopy.setAttribute("position", new Float32BufferAttribute(roofPos, 3)); canopy.setAttribute("uv", new Float32BufferAttribute(roofUv, 2)); canopy.setIndex(roofIdx); canopy.computeVertexNormals();
  const canopyMat = w.lib.paint(0x75664c, 0.95).clone(); canopyMat.side = DoubleSide;
  w.mesh(canopy, canopyMat, 0, 0, 0, g);
  for (let z = L * 0.1; z <= L * 0.4; z += L * 0.0725) {
    for (let i = 0; i < 10; i++) { const [x1, y1] = arch(i), [x2, y2] = arch(i + 1); bar(w, g, wood, [x1, y1 + 0.025, z], [x2, y2 + 0.025, z], 0.025 * scale, 4); }
    for (const side of [-1, 1]) bar(w, g, wood, [side * B * 0.4, 1.17 * scale, z], [side * B * 0.4, 2.04 * scale, z], 0.045 * scale, 5);
  }
  // Battened lug sails are read from Darwent's Shanghai-junk plate. No crew/cargo identity is invented.
  const sailMat = w.lib.stucco(0x967c52).clone(); sailMat.name = "bund-junk-woven-sail"; sailMat.side = DoubleSide;
  for (const [mz, mastHeight, sw] of [[-L * 0.21, 11 * scale, 5.5 * scale], [L * 0.18, 8 * scale, 4 * scale]]) {
    bar(w, g, trim, [0, 0.8 * scale, mz], [0, mastHeight, mz], 0.13 * scale, 8);
    const s = new Shape(); s.moveTo(-sw * 0.18, 0); s.lineTo(sw * 0.85, 0.7); s.lineTo(sw * 0.72, mastHeight * 0.59); s.lineTo(-sw * 0.12, mastHeight * 0.75); s.closePath();
    const sail = w.mesh(new ShapeGeometry(s, 1), sailMat, 0, 2 * scale, mz, g); sail.rotation.y = 1.35;
    for (let i = 0; i < 8; i++) {
      const y = 2 * scale + i * mastHeight * 0.085, ww = sw * (0.85 - i * 0.02);
      bar(w, g, wood, [-sw * 0.16 * Math.cos(1.35), y, mz + sw * 0.16 * Math.sin(1.35)], [ww * Math.cos(1.35), y + 0.7, mz - ww * Math.sin(1.35)], 0.045, 4);
    }
    for (const x of [-B * 0.43, B * 0.43]) bar(w, g, rope, [x, 1, L * 0.4], [0, mastHeight * 0.93, mz], 0.025, 4);
  }
  person(w, g, [-0.4, 1.0, L * 0.26], 0x454947, false);
  batchStatic(g); g.userData.dynamic = true;
  w.update((_dt, t) => { const a = TAU * (t % LOOP) / 12 + phase; g.position.set(at[0], at[1] + Math.sin(a) * 0.045, at[2]); g.rotation.set(Math.sin(a) * 0.008, heading + Math.sin(a * 0.2) * 0.013, Math.cos(a) * 0.017); });
}
function tender(w: DayWorld) {
  const g = source("bund/steam-tender", w.group()), dark = w.lib.paint(0x242c2b), cream = w.lib.paint(0xc7be9f), wood = w.lib.paint(0x665945, 0.8), steel = w.lib.paint(0x47514d);
  w.mesh(hull(23, 5.3, 2.1), dark, 0, 0, 0, g);
  block(w, g, wood, 0, 1.02, 0, 4.2, 0.15, 17.5);
  block(w, g, cream, 0, 2.17, 0.8, 3.6, 2.1, 12.5);
  block(w, g, cream, 0, 3.37, 0.8, 4.25, 0.17, 13.5);
  for (const x of [-1.83, 1.83]) for (let z = -4.3; z < 6.5; z += 1.4) block(w, g, w.lib.glass("dark"), x, 2.42, z, 0.05, 1.05, 1.03);
  block(w, g, cream, 0, 4.2, -3.5, 2.8, 1.55, 2.5);
  block(w, g, w.lib.glass("dark"), 0, 4.4, -4.78, 2.3, 0.83, 0.04);
  block(w, g, cream, 0, 5.08, -3.5, 3.3, 0.17, 2.9);
  w.mesh(new CylinderGeometry(0.58, 0.62, 3.2, 12), w.lib.paint(0x827450), 0, 4.9, 1.4, g);
  w.mesh(new CylinderGeometry(0.65, 0.61, 0.8, 12), dark, 0, 6.15, 1.4, g);
  for (const x of [-2.05, 2.05]) {
    bar(w, g, cream, [x, 1.9, -8.5], [x, 1.9, 8.5], 0.06);
    for (let z = -8.5; z <= 8.5; z += 1.25) bar(w, g, cream, [x, 1.08, z], [x, 1.9, z], 0.045);
    for (const z of [-1, 5]) { const ring = w.mesh(new TorusGeometry(0.32, 0.08, 6, 14), w.lib.paint(0xd6c2a0), x, 2.3, z, g); ring.rotation.y = Math.PI / 2; }
  }
  bar(w, g, steel, [0, 1.4, -7.5], [0, 6.8, -7.5], 0.06);
  person(w, g, [0, 1.1, -7.5], 0x343c40);
  batchStatic(g); g.userData.dynamic = true;
  // A slow harbour turning circuit, with continuous position, tangent and bob at both loop endpoints.
  w.update((_dt, t) => { const a = TAU * (t % LOOP) / LOOP + 0.7;
    g.position.set(115 + Math.cos(a) * 28, -0.64 + Math.sin(a * 10) * 0.035, 65 * Math.sin(a));
    g.rotation.set(0, Math.atan2(28 * Math.sin(a), -65 * Math.cos(a)), Math.sin(a * 10) * 0.009);
  });
}
function tram(w: DayWorld) {
  const g = source("bund/single-deck-electric-tram", w.group()), cream = w.lib.paint(0xc5ba9a), green = w.lib.paint(0x3c544e), roof = w.lib.paint(0x6d6959), iron = w.lib.paint(0x333c39), glass = w.lib.glass("dark");
  block(w, g, iron, 0, 0.7, 0, 2.08, 0.45, 7.6);
  block(w, g, green, 0, 1.42, 0, 2.21, 1, 8.4);
  block(w, g, cream, 0, 2.62, 0, 2.15, 1.5, 6.2);
  for (const x of [-1.09, 1.09]) for (let i = 0; i < 6; i++) {
    block(w, g, glass, x, 2.65, -2.6 + i * 1.03, 0.035, 1.08, 0.8);
    block(w, g, cream, x * 1.015, 2.65, -2.6 + i * 1.03, 0.035, 1.08, 0.06);
  }
  for (const z of [-3.13, 3.13]) block(w, g, glass, 0, 2.58, z, 1.7, 1.05, 0.04);
  block(w, g, roof, 0, 3.46, 0, 2.6, 0.19, 8.65);
  block(w, g, roof, 0, 3.7, 0, 1.15, 0.36, 6.9);
  for (const z of [-3.6, 3.6]) for (const x of [-0.95, 0.95]) bar(w, g, cream, [x, 1.85, z], [x, 3.38, z], 0.055);
  for (const z of [-1.9, 1.9]) for (const x of [-0.95, 0.95]) wheel(w, g, iron, x, 0.5, z, 0.35, 0);
  for (const z of [-4.24, 4.24]) { block(w, g, cream, 0, 1.94, z, 1.98, 0.14, 0.15); const lamp = w.mesh(new CylinderGeometry(0.15, 0.15, 0.1, 10), cream, 0, 1.53, z, g); lamp.rotation.x = Math.PI / 2; }
  bar(w, g, iron, [0, 3.9, 0], [0, 7.02, 2.9], 0.05);
  // No unsupported precise route/car number: only the documented single-deck type is reconstructed.
  person(w, g, [0, 1.06, -3.5], 0x393e3b);
  batchStatic(g); g.userData.dynamic = true;
  // A 938.83 m rounded block, at 7.824 m/s. The river-facing run stays straight;
  // outside the detailed frontage it turns west and returns behind the buildings.
  // This off-scene closure is an animation convention, not a surveyed 1920 route.
  const turn = Math.PI * 5;
  const curve = (cx: number, cz: number, start: number, d: number): [number, number, number] => {
    const a = start - d / 10; return [cx + Math.cos(a) * 10, cz + Math.sin(a) * 10, -a];
  };
  const route: { length: number; at: (d: number) => [number, number, number] }[] = [
    { length: 380, at: d => [14, 190 - d, 0] },
    { length: turn, at: d => curve(4, -190, 0, d) },
    { length: 58, at: d => [4 - d, -200, Math.PI / 2] },
    { length: turn, at: d => curve(-54, -190, -Math.PI / 2, d) },
    { length: 380, at: d => [-64, -190 + d, Math.PI] },
    { length: turn, at: d => curve(-54, 190, -Math.PI, d) },
    { length: 58, at: d => [-54 + d, 200, -Math.PI / 2] },
    { length: turn, at: d => curve(4, 190, -Math.PI * 1.5, d) },
  ];
  const length = 876 + turn * 4, speed = length / LOOP;
  w.update((_dt, t) => {
    let d = (((t % LOOP) - 25) * speed + 190 + length) % length;
    for (const segment of route) {
      if (d <= segment.length) { const [x, z, yaw] = segment.at(d); g.position.set(x, 0.1, z); g.rotation.y = yaw; break; }
      d -= segment.length;
    }
    w.shadowsDirty = true;
  });
}
function rickshaw(w: DayWorld, x: number, z: number, heading: number, occupied: boolean) {
  const g = source(`bund/rickshaw-${x}-${z}`, w.group()), wood = w.lib.paint(0x604731, 0.8), black = w.lib.paint(0x302f29), cloth = w.lib.stucco(0x615e50);
  block(w, g, wood, 0, 0.79, 0, 0.92, 0.32, 0.8);
  block(w, g, wood, 0, 1.12, 0.31, 0.99, 0.56, 0.12);
  for (const side of [-1, 1]) {
    wheel(w, g, black, side * 0.64, 0.67, 0.14, 0.63, 12);
    bar(w, g, wood, [side * 0.53, 0.88, 0.5], [side * 0.45, 0.69, -2.25], 0.035);
    bar(w, g, black, [side * 0.5, 1, 0.36], [side * 0.5, 1.83, 0.36], 0.035);
  }
  block(w, g, cloth, 0, 1.84, 0.14, 1.12, 0.11, 1.15);
  if (occupied) {
    block(w, g, w.lib.plain(0x585f64), 0, 1.12, 0.02, 0.38, 0.55, 0.33);
    w.mesh(new SphereGeometry(0.13, 8, 6), w.lib.plain(0xad9074), 0, 1.53, -0.02, g);
  }
  batchStatic(g); g.position.set(x, 0.12, z); g.rotation.y = heading;
}

export function buildMotion(w: DayWorld) {
  junk(w, "bund/moored-junk-south", [78, -0.6, 39], 0.17, 1, 0);
  junk(w, "bund/moored-junk-north", [86, -0.66, -47], -0.3, 0.8, 1.1);
  junk(w, "bund/offshore-junk", [184, -0.7, 131], 0.32, 1.35, 2.2);
  tender(w); tram(w);
  rickshaw(w, 8.1, 32, 0.05, false); rickshaw(w, 8.5, 37, 0.08, true);
  rickshaw(w, 26, -33, Math.PI * 0.95, false);
  const people = source("bund/ordinary-passers-by", w.group());
  person(w, people, [38.5, 0.2, 21], 0x57584f);
  person(w, people, [4, 0.2, 42], 0x444c50, false);
  person(w, people, [28.2, 0.2, -34], 0x5e6154, false);
  person(w, people, [39.1, 0.2, -8], 0x494a47, false);
  person(w, people, [37.6, 0.2, 45], 0x605c4f);
  person(w, people, [7.5, 0.2, 35], 0x747263, false);
  person(w, people, [3.2, 0.2, -3.5], 0x454e52);
  person(w, people, [4.8, 0.2, -70], 0x6b6353);
  person(w, people, [32.7, 0.2, 79], 0x3d484d, false);
}
