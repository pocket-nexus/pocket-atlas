import { BoxGeometry, BufferAttribute, CylinderGeometry, Group, RepeatWrapping, Vector3 } from "three";
import { Rng } from "../../../core/random";
import { canvas, toTexture } from "../../shared/canvas";
import { box } from "../../shared/geo";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { paintOfficeGrid } from "../gfx/art";

const mergeBoxes = (list: BoxGeometry[]) => mergeGeometries(list, false)!;
import type { AkibaWorld } from "./context";
import { point } from "./util";

/**
 * What lies beyond the street: the Sobu Line viaduct crossing about 40 m
 * north (deck at the station's third level), the Yamanote / Keihin-Tohoku
 * viaduct 65 m east, Akiba Crossfield (Akihabara Daibiru, 31 floors, 150 m)
 * beyond the tracks, and a ring of office and shop blocks whose lit floors
 * fill the gaps between the street's buildings.
 */
export function buildFar(w: AkibaWorld): void {
  sobuViaduct(w);
  sobuTrain(w);
  eastViaduct(w);
  towers(w);
}

/** The Sobu train: ten 19.5 m cars, 0.5 m apart. */
const CARS = 10;
const CAR_L = 19.5;
const CAR_GAP = 0.5;

/**
 * Sobu Line timing on the place clock: the nose runs from x = `start` to
 * `end` (−50 m plus the train's length) during the first `run` seconds of
 * every `period`.
 */
export const SOBU_TRAIN = { period: 40, run: 20, start: -120, end: -50 + CARS * (CAR_L + CAR_GAP) };

/** x of the Sobu train's nose at place time t (≥ 0), or null while it is out of view. */
export function sobuTrainNose(t: number): number | null {
  const u = t % SOBU_TRAIN.period;
  return u < SOBU_TRAIN.run ? SOBU_TRAIN.start + ((SOBU_TRAIN.end - SOBU_TRAIN.start) * u) / SOBU_TRAIN.run : null;
}

/**
 * A ten-car Sobu Line local (stainless, canary-yellow band, lit saloon
 * windows) crossing the bridge eastbound. It crosses within the first 20 s
 * of every 40 s; the export records the first 20 s, so the device's 20 s
 * loop shows one train per loop with the train out of view at the seam.
 */
function sobuTrain(w: AkibaWorld): void {
  const lib = w.lib;
  const train = new Group();
  train.name = "sobu-train";
  train.userData.dynamic = true;
  w.root.add(train);
  const cars = CARS;
  const L = CAR_L;
  const gap = CAR_GAP;
  const body = lib.plain(0xbfc3c6, 0.3, 0.6);
  const band = lib.plain(0xd2a812, 0.55, 0);
  const lit = lib.glow(0xf2f4ff, 2.6);
  const dark = lib.plain(0x2a2c2e, 0.55, 0);
  const bodies: BoxGeometry[] = [];
  const bands: BoxGeometry[] = [];
  const windows: BoxGeometry[] = [];
  const roofs: BoxGeometry[] = [];
  for (let c = 0; c < cars; c++) {
    const x = -c * (L + gap) - L / 2;
    const b = new BoxGeometry(L, 2.9, 2.95);
    b.translate(x, 2.55, 0);
    bodies.push(b);
    for (const side of [-1, 1]) {
      const st = new BoxGeometry(L - 0.4, 0.22, 0.02);
      st.translate(x, 1.75, side * 1.485);
      bands.push(st);
      const wd = new BoxGeometry(L - 1.2, 0.9, 0.02);
      wd.translate(x, 2.55, side * 1.49);
      windows.push(wd);
    }
    const rf = new BoxGeometry(L - 1, 0.35, 2.2);
    rf.translate(x, 4.15, 0);
    roofs.push(rf);
  }
  w.mesh(mergeBoxes(bodies), body, 0, 0, 0, train);
  w.mesh(mergeBoxes(bands), band, 0, 0, 0, train);
  w.mesh(mergeBoxes(windows), lit, 0, 0, 0, train);
  w.mesh(mergeBoxes(roofs), dark, 0, 0, 0, train);
  const yaw = -Math.atan(0.0963);
  w.update((_dt, t) => {
    const x = sobuTrainNose(t) ?? SOBU_TRAIN.start - 400;
    train.position.set(x, SOBU.deck, sobuZ(x) + 1.6);
    train.rotation.y = yaw;
  });
}

/** Line of the Sobu Line viaduct (OSM 181579925/26): z at x. */
export const sobuZ = (x: number) => -47.3 + (x + 95) * 0.0963;
const SOBU = { bottom: 13.4, deck: 14.6, width: 11 };

function sobuViaduct(w: AkibaWorld): void {
  const lib = w.lib;
  const concrete = lib.concrete();
  // Plate girders painted pale blue-grey; the deck slab is concrete.
  const girder = lib.panel([0.62, 0.66, 0.72]);
  const g = new Group();
  g.name = "sobu-viaduct";
  w.root.add(g);
  const x0 = -110;
  const x1 = 70;
  const len = x1 - x0;
  const yaw = -Math.atan(0.0963);
  const seg = w.group((x0 + x1) / 2, 0, sobuZ((x0 + x1) / 2), yaw, g);
  // Deck slab, side girders and parapet, as one long span along the line.
  w.mesh(box(len, SOBU.deck - SOBU.bottom, SOBU.width), concrete, 0, (SOBU.bottom + SOBU.deck) / 2, 0, seg);
  for (const s of [-1, 1]) {
    w.mesh(box(len, 2.0, 0.3), girder, 0, SOBU.bottom + 0.6, s * (SOBU.width / 2 - 0.1), seg);
    w.mesh(box(len, 0.9, 0.18), girder, 0, SOBU.deck + 0.9, s * (SOBU.width / 2 - 0.2), seg);
  }
  // Stiffener ribs on the girder faces every 2.5 m.
  const rib = box(0.1, 2.0, 0.1);
  for (let x = -len / 2 + 1; x < len / 2; x += 2.5) for (const s of [-1, 1]) w.mesh(rib, girder, x, SOBU.bottom + 0.6, s * (SOBU.width / 2 + 0.06), seg);
  // Piers in pairs every 24 m (clear of the footway and Chuo-dori's lanes).
  const pier = box(1.4, SOBU.bottom, 1.4);
  for (let x = -len / 2 + 6; x < len / 2; x += 24) {
    const wx = (x0 + x1) / 2 + x * Math.cos(yaw);
    if (wx > -88.5 && wx < -63.5) continue;
    if (wx > -21.5 && wx < -16) continue;
    for (const s of [-1, 1]) w.mesh(pier, concrete, x, SOBU.bottom / 2, s * 3.6, seg);
    w.mesh(box(1.6, 1.0, SOBU.width - 1), concrete, x, SOBU.bottom - 0.5, 0, seg);
  }
  // Catenary masts on the deck.
  const mast = box(0.18, 5.5, 0.18);
  for (let x = -len / 2 + 10; x < len / 2; x += 30) {
    for (const s of [-1, 1]) w.mesh(mast, girder, x, SOBU.deck + 2.75, s * 4.8, seg);
    w.mesh(box(0.12, 0.25, SOBU.width - 1), girder, x, SOBU.deck + 5.2, 0, seg);
  }
  // Under-deck lights over the footway and Chuo-dori.
  const lamp = lib.glow(0xf4f6ff, 2.6);
  for (const x of [-84, -76, -68]) {
    const z = sobuZ(x);
    for (const dz of [-2.5, 2.5]) w.mesh(box(0.6, 0.05, 0.14), lamp, x, SOBU.bottom - 0.04, z + dz);
    point(w, 0xeef2ff, 40, 16, new Vector3(x, SOBU.bottom - 0.6, z));
  }
  for (const x of [-19.8, -17.8]) {
    const z = sobuZ(x);
    for (const dz of [-3, 3]) {
      w.mesh(box(0.9, 0.06, 0.18), lamp, x, SOBU.bottom - 0.05, z + dz);
      point(w, 0xeef2ff, 60, 14, new Vector3(x, SOBU.bottom - 0.4, z + dz));
    }
  }
  // Station platform canopies east of the footway (Sobu platforms at the third level).
  const roof = lib.plain(0x8c9296, 0.5, 0.5);
  const canopy = w.group(60, 0, sobuZ(60), yaw, g);
  w.mesh(box(140, 0.5, 26), roof, 0, 21.5, -2, canopy);
  w.mesh(box(140, 3.0, 26), lib.panel([0.78, 0.76, 0.72]), 0, SOBU.deck + 1.5, -2, canopy);
  const lights = lib.glow(0xeef4ff, 2.2);
  for (let x = -66; x < 66; x += 6) w.mesh(box(2.4, 0.06, 0.3), lights, x, 21.2, -6, canopy);
}

function eastViaduct(w: AkibaWorld): void {
  const lib = w.lib;
  const concrete = lib.concrete();
  // Yamanote / Keihin-Tohoku tracks on a deck at the second level, x ≈ 64 … 92.
  w.mesh(box(28, 2.2, 260), concrete, 78, 9.1, -10);
  for (let z = -130; z < 120; z += 18) for (const x of [66, 78, 90]) w.mesh(box(1.4, 8, 1.4), concrete, x, 4, z);
  w.mesh(box(28, 1.2, 260), lib.plain(0x5f6a66, 0.55, 0.45), 78, 10.8, -10);
  // The station building under the tracks, its lit ground floor toward the plaza.
  w.mesh(box(16, 8, 28), lib.panel([0.82, 0.8, 0.76]), 72, 4, 8);
  w.mesh(box(0.1, 3.4, 18), lib.glow(0xf4f6ff, 1.4, false), 63.95, 1.8, 8);
}

/** Lit office floors: a tileable texture of 16 bays × 12 floors; the far blocks share three of them (seeds 1–3). */
function officeTexture(seed: number) {
  const { c, g } = canvas(256, 256);
  paintOfficeGrid(g, 256, 256, 16, 12, seed, 0.72);
  const t = toTexture(c, true);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.name = `office-${seed}`;
  return t;
}

/** Box with office-grid faces: UVs count bays (1.8 m) and floors (4 m), shifted by `shift` tiles. */
function officeBox(width: number, height: number, depth: number, shift = 0): BoxGeometry {
  const g = new BoxGeometry(width, height, depth);
  const uv = g.getAttribute("uv") as BufferAttribute;
  const faces: [number, number][] = [
    [depth, height],
    [depth, height],
    [0, 0],
    [0, 0],
    [width, height],
    [width, height],
  ];
  for (let f = 0; f < 6; f++)
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * faces[f][0]) / (1.8 * 16) + shift * (f + 1) * 0.37, (uv.getY(i) * faces[f][1]) / (4.0 * 12) + shift * 0.53);
    }
  g.translate(0, height / 2, 0);
  return g;
}

function towers(w: AkibaWorld): void {
  const lib = w.lib;
  const offices = [officeTexture(1), officeTexture(2), officeTexture(3)];
  const mats = offices.map((t, i) => {
    const m = lib.lit(t, 0.85, `office-${i}`);
    m.name = `office-${i}`;
    return m;
  });
  // Akiba Crossfield: Akihabara Daibiru (31 F, 150 m) with its podium block south of it, and UDX to its west.
  w.mesh(officeBox(36, 32, 22), mats[0], -2, 0, -103);
  w.mesh(officeBox(42, 150, 34), mats[1], 6, 0, -131);
  w.mesh(box(43, 3, 35), lib.plain(0x3a3f44, 0.5, 0.4), 6, 151.5, -131);
  const beacon = lib.glow(0xff2a1a, 14);
  for (const [x, z] of [[-14, -115], [26, -115], [-14, -147], [26, -147]]) w.mesh(new CylinderGeometry(0.4, 0.4, 0.6, 8), beacon, x, 153.3, z);
  w.mesh(officeBox(60, 105, 40), mats[0], -70, 0, -175);
  // Blocks beyond the street in every direction (they show between the street's buildings).
  const r = new Rng(808);
  const ring: [number, number, number, number, number][] = [
    // x, z, width, depth, height
    [-10, 75, 30, 26, 38],
    [-40, 80, 26, 22, 46],
    [20, 85, 26, 24, 34],
    [50, 70, 20, 30, 42],
    [-70, 120, 30, 30, 55],
    [10, 140, 40, 30, 62],
    [-130, 40, 30, 30, 40],
    [-140, -10, 26, 30, 52],
    [-150, -60, 30, 28, 44],
    [-120, -110, 30, 30, 60],
    [-60, -90, 26, 26, 36],
    [-50, -130, 30, 26, 48],
    [60, -110, 28, 30, 40],
    [130, -60, 30, 40, 58],
    [140, 20, 30, 40, 46],
    [120, 90, 30, 30, 52],
    [-200, 60, 50, 40, 70],
    [-220, -80, 50, 40, 85],
  ];
  for (const [x, z, wd, dp, h] of ring) {
    w.mesh(officeBox(wd, h, dp, r.next()), mats[r.int(0, mats.length - 1)], x, 0, z, w.root, { ry: r.range(-0.08, 0.08) });
    w.mesh(box(wd + 0.4, 1.2, dp + 0.4), lib.plain(0x2a2d31, 0.6), x, h + 0.6, z);
  }
}
