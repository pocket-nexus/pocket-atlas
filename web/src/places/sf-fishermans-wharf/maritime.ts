import { BufferGeometry, CylinderGeometry, Float32BufferAttribute, Group, SphereGeometry, TorusGeometry } from "three";
import type { DayWorld } from "../shared/daylight/context";
import { batchStatic } from "../shared/geo";
import { source } from "../shared/provenance";
import { bar, box } from "./geometry";
import { LOOP } from "./layout";

/** Lofted working hull: sheer, flared topsides, chine and keel, not a scaled box. */
function hull(length: number, beam: number, depth: number) {
  const stations = [[-.5, .025, .32], [-.43, .55, .22], [-.28, .92, .05], [0, 1, 0], [.25, .92, .02], [.45, .66, .08], [.5, .58, .1]];
  const pos: number[] = [], idx: number[] = [];
  for (const [z, width, sheer] of stations) {
    for (const [xx, yy] of [[-1, .6], [-.84, -.22], [-.28, -.64], [0, -.77], [.28, -.64], [.84, -.22], [1, .6]]) pos.push(xx * beam * .5 * width, yy * depth + sheer * depth, z * length);
  }
  for (let j = 0; j < stations.length - 1; j++) for (let k = 0; k < 6; k++) { const a = j * 7 + k; idx.push(a, a + 7, a + 1, a + 1, a + 7, a + 8); }
  for (let j = 0; j < stations.length - 1; j++) { const a = j * 7; idx.push(a, a + 6, a + 7, a + 6, a + 13, a + 7); }
  const g = new BufferGeometry(); g.setAttribute("position", new Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new Float32BufferAttribute(pos.flatMap((_v, i) => i % 3 === 0 ? [pos[i] / 2, pos[i + 2] / 2] : []), 2)); g.setIndex(idx); g.computeVertexNormals(); return g;
}

function fishingBoat(w: DayWorld, n: number, length: number, beam: number, color: number) {
  const g = source(`fleet/working-boat-${n}`, new Group()); g.name = `Moored fishing vessel ${n + 1}`;
  const hullPaint = w.lib.plain(color, .61, .08), cream = w.lib.plain(0xd9d6c4, .73), dark = w.lib.plain(0x263532, .56), glass = w.lib.plain(0x293f42, .14, .25), rig = w.lib.plain(0x4b5146, .7, .3);
  w.mesh(hull(length, beam, 1.75), hullPaint, 0, 0, 0, g);
  box(w, [beam * .76, .1, length * .73], w.lib.plain(0x82765c, .87), [0, 1.04, .05], g);
  box(w, [beam * .59, 1.8, length * .24], cream, [0, 1.9, -length * .13], g);
  box(w, [beam * .64, .15, length * .28], cream, [0, 2.87, -length * .13], g);
  const cabinZ = -length * .25;
  for (const x of [-beam * .16, beam * .16]) box(w, [beam * .25, .7, .025], glass, [x, 2.25, cabinZ - .018], g);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) box(w, [.025, .68, length * .051], glass, [side * beam * .299, 2.25, -length * .2 + i * length * .067], g);
    for (let i = 0; i < 5; i++) {
      const z = -.36 * length + i * length * .17, x = side * beam * .4;
      bar(w, [x, 1.08, z], [x, 1.72, z], .024, cream, g, 4);
      if (i < 4) bar(w, [x, 1.72, z], [x, 1.72, z + length * .17], .025, cream, g, 4);
      if (i % 2 === 0) { const tire = w.mesh(new TorusGeometry(.26, .08, 5, 12), dark, side * beam * .46, .8, z, g); tire.rotation.y = Math.PI / 2; }
    }
  }
  bar(w, [0, 1.1, -.8], [0, 8.2, -.8], .07, rig, g, 7);
  bar(w, [-2.6, 6.5, -.8], [2.6, 6.5, -.8], .05, rig, g, 6);
  bar(w, [0, 4.8, -.8], [beam * .5, 6.1, length * .24], .062, rig, g, 6);
  for (const side of [-1, 1]) {
    bar(w, [0, 7.9, -.8], [side * beam * .4, 1.2, length * .4], .014, dark, g, 4);
    bar(w, [0, 7.9, -.8], [side * beam * .32, 1.1, -length * .4], .014, dark, g, 4);
    w.mesh(new SphereGeometry(.09, 7, 4), w.lib.plain(side < 0 ? 0x853e2f : 0x577b48), side * beam * .31, 2.98, -length * .21, g);
  }
  box(w, [1.1, .17, .3], cream, [0, 6.9, -.8], g);
  bar(w, [0, 7.8, -.8], [0, 9, -.8], .018, rig, g, 4);
  // Winch, net roller, bait crates and a short stack of crab traps.
  const winch = w.mesh(new CylinderGeometry(.35, .35, .9, 10), rig, 0, 1.5, length * .15, g); winch.rotation.z = Math.PI / 2;
  for (let i = 0; i < 3; i++) {
    box(w, [.74, .46, 1], w.lib.plain(i % 2 ? 0x507369 : 0x9b6c3f, .85), [beam * .22, 1.35 + i * .44, length * .28], g);
    for (let k = 0; k < 3; k++) box(w, [.8, .035, .05], cream, [beam * .22, 1.2 + i * .44 + k * .12, length * .28 + .51], g);
  }
  for (let i = 0; i < 2; i++) {
    w.mesh(new TorusGeometry(.56, .035, 4, 12).rotateX(Math.PI / 2), rig, -beam * .2, 1.22 + i * .42, length * .31, g);
    w.mesh(new TorusGeometry(.56, .035, 4, 12).rotateX(Math.PI / 2), rig, -beam * .2, 1.56 + i * .42, length * .31, g);
    for (let j = 0; j < 8; j++) { const a = j * Math.PI / 4; bar(w, [-beam * .2 + Math.sin(a) * .56, 1.22 + i * .42, length * .31 + Math.cos(a) * .56], [-beam * .2 + Math.sin(a) * .56, 1.56 + i * .42, length * .31 + Math.cos(a) * .56], .017, rig, g, 4); }
  }
  // Anonymous contemporary working vessels: names/registrations and precise fleet composition are not asserted.
  batchStatic(g); g.userData.dynamic = true; return g;
}

export function buildFleet(w: DayWorld) {
  const boats = [
    [-67, -34, 15, 4.1, 0x416c59, .06], [-78, -40, 17, 4.5, 0x3e646e, .05], [-91, -42, 13, 3.8, 0xa79b74, .04],
    [-105, -45, 19, 4.6, 0x855443, -.06], [-121, -48, 14, 3.9, 0x4c716a, .13], [-139, -47, 17, 4.4, 0x365562, .05],
    [-152, -40, 12.5, 3.6, 0x9d9e83, .1], [-214, -44, 16, 4.2, 0x7f4d40, 1.45], [-240, -43, 20, 4.7, 0x446652, 1.5],
  ];
  boats.forEach(([x, z, len, beam, color, yaw], i) => {
    const boat = source(`fleet/working-boat-${i}`, fishingBoat(w, i, len, beam, color)); w.root.add(boat);
    w.update((_dt, t) => {
      const a = t / LOOP * Math.PI * 2;
      boat.position.set(x, -1.85 + Math.sin(a * 12 + i) * .08, z); boat.rotation.set(Math.sin(a * 8 + i) * .009, yaw, Math.sin(a * 10 + i * .6) * .016);
    });
    for (const side of [-1, 1]) bar(w, [x + side * beam * .43, -.8, z - len * .35], [x + side * (beam * .5 + 1), .05, z - len * .5 - 2], .028, w.lib.plain(0x9e9376));
  });
  // Public fishing-harbor fingers; mooring cleats and coil silhouettes are close-camera geometry.
  for (const [x, z, len] of [[-61, -38, 32], [-86, -41, 35], [-115, -44, 34], [-145, -40, 31]]) {
    box(w, [1.8, .32, len], w.lib.paint(0x887e62, .88), [x, -.6, z]);
    for (let j = 0; j < len; j += .7) box(w, [1.79, .055, .025], w.lib.plain(0x544f3e), [x, -.41, z - len / 2 + j]);
    for (const zz of [z - len / 2 + 2, z, z + len / 2 - 2]) {
      w.mesh(new CylinderGeometry(.19, .23, 3.5, 8), w.lib.paint(0x665943, .88), x + 1.06, -1.4, zz);
      bar(w, [x - .3, -.22, zz], [x + .3, -.22, zz], .06, w.lib.plain(0x545c54, .65, .55));
      w.mesh(new TorusGeometry(.33, .025, 4, 15).rotateX(Math.PI / 2), w.lib.plain(0xa39472), x, -.36, zz + .7);
    }
  }
}

export function buildPampanito(w: DayWorld) {
  const g = source("museum/uss-pampanito", w.group(-59.5, -2.1, -181.3, .895)); g.name = "USS Pampanito at east side of Pier 45";
  const grey = w.lib.plain(0x686c68, .62, .18), dark = w.lib.plain(0x333b39, .75), deck = w.lib.plain(0x626257, .82);
  const hullMesh = w.mesh(new SphereGeometry(1, 16, 28), grey, 0, .1, 0, g); hullMesh.scale.set(4.15925, 4.4, 47.47895);
  box(w, [5.8, .35, 72], deck, [0, 3.24, 0], g); box(w, [2.8, 3.7, 9], grey, [0, 5.1, 2], g);
  box(w, [3.2, .22, 10], dark, [0, 7, 2], g);
  for (const z of [-1, 2.3, 4.2]) bar(w, [0, 7, z], [0, z === 2.3 ? 12.5 : 10.5, z], .13, grey, g, 7);
  for (let z = -33; z <= 33; z += 2.5) for (const side of [-1, 1]) bar(w, [side * 2.82, 3.4, z], [side * 2.82, 4.15, z], .028, grey, g, 4);
  for (const side of [-1, 1]) for (const y of [3.7, 4.15]) bar(w, [side * 2.82, y, -33], [side * 2.82, y, 33], .026, grey, g, 4);
  for (const z of [-13, 15]) {
    w.mesh(new CylinderGeometry(.7, .9, .8, 12), grey, 0, 3.9, z, g);
    bar(w, [0, 4.6, z], [.25, 4.7, z - 4], .1, dark, g, 7);
  }
  for (let z = -26; z < 27; z += 4) w.mesh(new CylinderGeometry(.48, .48, .15, 10), dark, 0, 3.47, z, g);
}

export function buildCruise(w: DayWorld) {
  const g = source("bay/sightseeing-cruise", new Group()); g.name = "Red and white sightseeing vessel";
  const red = w.lib.plain(0xb94737, .55), white = w.lib.plain(0xe0dfd3, .53), glass = w.lib.plain(0x33454a, .13, .3);
  w.mesh(hull(28, 8.2, 2.8), red, 0, 0, 0, g);
  for (const y of [2.35, 4.95]) {
    box(w, [7, 2, 20], white, [0, y, 0], g); box(w, [7.6, .15, 23], white, [0, y + 1.08, -.4], g);
    for (const side of [-1, 1]) for (let i = 0; i < 9; i++) box(w, [.06, 1.0, 1.35], glass, [side * 3.54, y + .12, -8.8 + i * 2.2], g);
    for (let i = 0; i < 4; i++) box(w, [1.25, 1, .06], glass, [-2.4 + i * 1.6, y + .12, -10.04], g);
  }
  box(w, [4.4, 1.9, 4.9], white, [0, 7.05, -4.5], g);
  for (let i = 0; i < 3; i++) box(w, [1.05, .8, .06], glass, [-1.3 + i * 1.3, 7.25, -7.0], g);
  bar(w, [0, 8.1, -3], [0, 11.5, -3], .07, white, g, 7);
  for (const side of [-1, 1]) for (let i = 0; i < 12; i++) {
    bar(w, [side * 3.6, 6.1, -11 + i * 2], [side * 3.6, 7.0, -11 + i * 2], .035, white, g, 4);
    if (i < 11) bar(w, [side * 3.6, 7.0, -11 + i * 2], [side * 3.6, 7.0, -9 + i * 2], .035, white, g, 4);
  }
  batchStatic(g); g.userData.dynamic = true; source("bay/sightseeing-cruise", g); w.root.add(g);
  w.update((_dt, t) => { const a = t / LOOP * Math.PI * 2; g.position.set(95 + Math.sin(a) * 65, -2.05 + Math.sin(a * 6) * .09, -194 - Math.cos(a) * 34); g.rotation.y = Math.atan2(-Math.cos(a) * 65, -Math.sin(a) * 34); });
}
