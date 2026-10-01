import { BoxGeometry, BufferGeometry, CircleGeometry, CylinderGeometry, Float32BufferAttribute, Group, PlaneGeometry, SphereGeometry, Vector3, type BufferAttribute, type Material } from "three";
import { flip, rod } from "../../shared/shapes";
import type { CellKey } from "../gfx/equip";
import { Bag, type KamakuraWorld } from "./context";
import { CROSSING } from "./layout";
import { crossingAt } from "./timeline";

/**
 * The crossing equipment (first class: lamps, bell, gates). Two warning
 * masts stand on the drivers' left of each approach: north-east of the road
 * for traffic coming down the slope (black-and-yellow striped crossbuck,
 * the orange ふみきり LED panel, the emergency button box) and south-west by
 * Route 134 (plain yellow-orange crossbuck with a black edge, the electronic
 * bell on top, the train-direction indicator, lamps facing west as well).
 * Each face carries two red LED lamps, one above the other, on a bracket
 * beside the pole; each lamp is a black back plate, a housing, a domed lens
 * in a bezel and a hood. Four gate machines close both approaches; their
 * striped FRP arms stand almost upright when raised and drop to 0.95 m.
 *
 * Every static part paints from the equipment atlas (gfx/equip.ts) and
 * merges into one mesh per shadow flag; the lenses, the LED panel and the
 * lit arrow are tracked emissive materials; the four arms are moving nodes.
 */

/** Warning masts (x, z on the ground) and their height; the south-west one carries the bell. */
const MAST_NE = { x: 5.75, z: -3.3 };
const MAST_SW = { x: -4.6, z: 3.4 };
const MAST_BASE = 0.06;
const MAST_TOP = 4.42;

/** Centre of the electronic bell's speaker grille, on top of the south-west mast. */
export const BELL_AT = new Vector3(MAST_SW.x, MAST_BASE + MAST_TOP + 0.24, MAST_SW.z);

export interface CrossingState {
  alarm: boolean;
  gate: number;
}

/** Lit emissive intensities (the albedo of the lens cells times these). */
const PEAK = { lamp: 13, arrow: 8, led: 6 };

type Put = (g: BufferGeometry, cell: CellKey, cast?: boolean, sub?: [number, number, number, number]) => void;

/** Rotates a +z-facing piece to face `yaw` (0 = +z, south) and moves it to p. */
function place(g: BufferGeometry, p: Vector3, yaw = 0): BufferGeometry {
  if (yaw) g.rotateY(yaw);
  g.translate(p.x, p.y, p.z);
  return g;
}

/** Planar UVs across a disc of radius r lying in the xy plane (lens and sign faces). */
function discUV(g: BufferGeometry, r: number): BufferGeometry {
  const pos = g.getAttribute("position");
  const uv = g.getAttribute("uv") as BufferAttribute;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / (2 * r) + 0.5, pos.getY(i) / (2 * r) + 0.5);
  return g;
}

/** Cylinder along +z (from z0 to z1), radii at each end, optional partial sweep (θ = 0 points down). */
function tubeZ(r0: number, r1: number, z0: number, z1: number, seg: number, open = true, theta?: [number, number]): BufferGeometry {
  const g = new CylinderGeometry(r1, r0, z1 - z0, seg, 1, open, theta?.[0] ?? 0, theta?.[1] ?? Math.PI * 2);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

/**
 * Crossing lamp (警報灯) facing +z, centred on the lens: back plate,
 * housing, bezel, domed lens and a flared hood over the top two thirds.
 */
function lamp(put: Put, add: (m: Material, g: BufferGeometry, cast?: boolean) => void, lens: Material, p: Vector3, yaw: number): void {
  const parts: [BufferGeometry, CellKey | Material][] = [];
  parts.push([tubeZ(0.19, 0.19, -0.1, -0.075, 22, false), "black"]);
  parts.push([tubeZ(0.15, 0.135, -0.075, 0.02, 16, true), "black"]);
  parts.push([tubeZ(0.128, 0.128, 0.0, 0.035, 16, true), "blackMatte"]);
  const dome = new SphereGeometry(0.12, 14, 3, 0, Math.PI * 2, 0, 0.55);
  dome.rotateX(Math.PI / 2);
  dome.scale(1, 1, 0.55);
  dome.translate(0, 0, -0.03);
  discUV(dome, 0.12);
  parts.push([dome, lens]);
  const hood: [number, number] = [Math.PI - 2.15, 4.3];
  parts.push([tubeZ(0.145, 0.175, 0.02, 0.24, 14, true, hood), "black"]);
  parts.push([flip(tubeZ(0.138, 0.168, 0.02, 0.24, 14, true, hood)), "blackMatte"]);
  for (const [g, m] of parts) {
    place(g, p, yaw);
    if (typeof m === "string") put(g, m, true);
    else add(m, g, false);
  }
}

export function buildCrossing(w: KamakuraWorld): CrossingState {
  const E = w.equip;
  const bag = new Bag();
  const put: Put = (g, cell, cast = true, sub) => bag.add(E.material, E.map(g, cell, sub), cast);
  const add = (m: Material, g: BufferGeometry, cast = true) => bag.add(m, g, cast);
  const lampA = E.lens("lamp-a", PEAK.lamp, 0xff5a40);
  const lampB = E.lens("lamp-b", PEAK.lamp, 0xff5a40);
  const arrowLamp = E.lens("lamp-arrow", PEAK.arrow);
  const led = E.lens("lamp-led", PEAK.led);

  // ------------------------------------------------------------ masts
  // Lamp faces as yaw (0 = +z, south); `side` is the bracket's direction from the pole.
  const masts: { x: number; z: number; striped: boolean; faces: { yaw: number; side: number }[] }[] = [
    // North-east: back-to-back pairs on a bracket east of the pole, facing up the slope and over the track.
    { ...MAST_NE, striped: true, faces: [{ yaw: Math.PI, side: Math.PI / 2 }, { yaw: 0, side: Math.PI / 2 }] },
    // South-west: north and south pairs on a bracket west of the pole; the west pair on the south side.
    { ...MAST_SW, striped: false, faces: [{ yaw: Math.PI, side: -Math.PI / 2 }, { yaw: 0, side: -Math.PI / 2 }, { yaw: -Math.PI / 2, side: 0 }] },
  ];
  for (const m of masts) {
    const base = new Vector3(m.x, MAST_BASE, m.z);
    const top = MAST_TOP;
    const pole = new CylinderGeometry(0.07, 0.076, top, 14, 1, true);
    pole.translate(base.x, base.y + top / 2, base.z);
    put(pole, "mast");
    put(place(new SphereGeometry(0.075, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), base.clone().setY(base.y + top)), "black");
    put(place(new BoxGeometry(0.46, 0.16, 0.46), base.clone().setY(0.04)), "footing");
    put(place(new CylinderGeometry(0.11, 0.12, 0.12, 12), base.clone().setY(0.16)), "mast", true, [0, 0, 1, 0.03]);
    // Crossbuck: two 1.3 × 0.2 m boards crossing 3.5 m up on the pole's north face (painted both sides), on a clamp plate.
    const xc = base.clone().setY(3.5);
    for (const s of [1, -1]) {
      const b = new BoxGeometry(1.3, 0.2, 0.028);
      b.rotateZ((s * Math.PI) / 4);
      b.translate(0, 0, -0.1 - (s > 0 ? 0 : 0.03));
      put(place(b, xc), m.striped ? "xStriped" : "xPlain");
    }
    put(place(new BoxGeometry(0.16, 0.16, 0.05), xc.clone().add(new Vector3(0, 0, -0.06))), "black");
    for (const dz of [-0.15, 0]) put(place(tubeZ(0.035, 0.035, -0.02, 0.02, 8, false), xc.clone().add(new Vector3(0, 0, dz))), "galv");
    // Pole bands (clamps) where brackets attach.
    for (const y of [2.42, 2.92, 3.5, 1.95]) put(place(new CylinderGeometry(0.085, 0.085, 0.06, 12, 1, true), base.clone().setY(y)), "galv");
    // Lamp pairs on brackets, one bracket per face direction.
    for (const f of m.faces) {
      const out = new Vector3(Math.sin(f.yaw), 0, Math.cos(f.yaw));
      const side = new Vector3(Math.sin(f.side), 0, Math.cos(f.side));
      const sameSide = Math.abs(out.dot(side)) > 0.9;
      // A face pointing along its bracket hangs at the bracket's end; others sit 0.36 m out, back-to-back.
      const reach = sameSide ? 0.24 : 0.36;
      const c = base.clone().addScaledVector(side, reach).addScaledVector(out, sameSide ? 0 : 0.1);
      for (const [y, mat] of [
        [2.92, lampA],
        [2.42, lampB],
      ] as const) {
        const arm0 = base.clone().setY(y);
        const arm1 = c.clone().setY(y).addScaledVector(out, -0.09);
        put(rod(arm0, arm1, 0.024, 6), "galv", false);
        lamp(put, add, mat, c.clone().setY(y), f.yaw);
      }
    }
    if (m.striped) {
      // ふみきり LED panel (lit while ringing) and the emergency button box, facing up the slope.
      const yaw = Math.PI;
      const fwd = new Vector3(0, 0, -1);
      const ledC = base.clone().setY(2.02).addScaledVector(fwd, 0.14);
      put(place(new BoxGeometry(0.64, 0.24, 0.12), ledC.clone()), "black");
      put(place(new BoxGeometry(0.68, 0.025, 0.17), ledC.clone().add(new Vector3(0, 0.13, -0.02))), "black");
      const face = new PlaneGeometry(0.58, 0.18);
      E.map(face, "ledFace");
      add(led, place(face, ledC.clone().addScaledVector(fwd, 0.062), yaw), false);
      const eb = base.clone().setY(1.35).addScaledVector(fwd, 0.15);
      put(place(new BoxGeometry(0.27, 0.4, 0.14), eb.clone()), "white");
      put(place(new BoxGeometry(0.3, 0.025, 0.18), eb.clone().add(new Vector3(0, 0.21, -0.02))), "white");
      put(place(new PlaneGeometry(0.25, 0.37), eb.clone().addScaledVector(fwd, 0.072), yaw), "emergency", false);
      put(rod(base.clone().setY(1.35), eb.clone().addScaledVector(fwd, -0.05), 0.02, 5), "galv", false);
    } else {
      // Electronic bell on top: a black can with a speaker grille and a cap.
      const bt = base.clone().setY(base.y + top + 0.04);
      put(place(new CylinderGeometry(0.03, 0.03, 0.08, 8), bt.clone().add(new Vector3(0, 0.04, 0))), "black");
      put(place(new CylinderGeometry(0.11, 0.11, 0.24, 14, 1, true), bt.clone().add(new Vector3(0, 0.2, 0))), "grille");
      put(place(new CylinderGeometry(0.06, 0.13, 0.06, 14), bt.clone().add(new Vector3(0, 0.35, 0))), "black");
      put(place(new CylinderGeometry(0.11, 0.11, 0.02, 14), bt.clone().add(new Vector3(0, 0.08, 0))), "black");
      // Train-direction indicator facing the slope, under the lamps.
      const fwd = new Vector3(0, 0, -1);
      const ic = base.clone().setY(2.0).addScaledVector(fwd, 0.13);
      put(place(new BoxGeometry(0.56, 0.28, 0.12), ic.clone()), "black");
      put(place(new BoxGeometry(0.6, 0.025, 0.18), ic.clone().add(new Vector3(0, 0.15, -0.03))), "black");
      put(place(new PlaneGeometry(0.54, 0.26), ic.clone().addScaledVector(fwd, 0.062), Math.PI), "arrowFace", false);
      // The lit arrow: westbound train, so it points west (right as seen from the slope).
      const tri = new BufferGeometry().setFromPoints([new Vector3(-0.09, 0, 0), new Vector3(0.045, 0.085, 0), new Vector3(0.045, -0.085, 0)]);
      tri.setAttribute("uv", new Float32BufferAttribute(new Float32Array(6), 2));
      tri.setIndex([0, 2, 1]);
      tri.computeVertexNormals();
      const ap = ic.clone().addScaledVector(fwd, 0.064).add(new Vector3(-0.13, 0, 0));
      const triG = place(tri, ap);
      const tuv = triG.getAttribute("uv") as BufferAttribute;
      const r = E.rect("arrowLens");
      for (let i = 0; i < 3; i++) tuv.setXY(i, r.u0 + (r.u1 - r.u0) * [0.1, 0.9, 0.9][i], r.v0 + (r.v1 - r.v0) * [0.5, 0.95, 0.05][i]);
      add(arrowLamp, triG, false);
    }
  }

  // ------------------------------------------------------------ gates
  // Gate machines (しゃ断機): the two entrance gates sit at the masts; the exit gates on their own posts.
  // East machines just off the carriageway, west ones beyond the pedestrian strip. Each arm
  // reaches past the road's centre line; the west arms sit a hand's width outboard of the east ones.
  const east = CROSSING.road[1];
  const west = CROSSING.strip[0];
  const gates: { x: number; z: number; to: number; face: number; lift: number; post: boolean }[] = [
    { x: east + 0.42, z: CROSSING.gateNorth, to: 0.5, face: Math.PI, lift: 86, post: false },
    { x: west - 0.62, z: CROSSING.gateNorth - 0.24, to: 1.0, face: Math.PI, lift: 84, post: true },
    { x: east + 0.45, z: CROSSING.gateSouth, to: 0.5, face: 0, lift: 85, post: true },
    { x: west - 0.6, z: CROSSING.gateSouth + 0.26, to: 1.0, face: 0, lift: 87, post: false },
  ];
  const arms: { node: Group; raised: number }[] = [];
  const holder = w.group();
  holder.name = "gates";
  holder.userData.dynamic = true;
  const armBag = new Bag();
  for (const gt of gates) {
    const len = Math.abs(gt.to - gt.x) + 0.3;
    const dir = Math.sign(gt.to - gt.x);
    const c = new Vector3(gt.x, 0, gt.z);
    // Post and footing, the striped housing, its roof and the number plate facing the approach.
    if (gt.post) {
      put(place(new BoxGeometry(0.42, 0.14, 0.42), c.clone().setY(0.05)), "footing");
      put(rod(c.clone().setY(0.1), c.clone().setY(0.55), 0.06, 10), "mast", true, [0, 0, 1, 0.1]);
    } else put(rod(c.clone().setY(0.1), c.clone().setY(0.55), 0.05, 8), "galv");
    put(place(new BoxGeometry(0.38, 0.6, 0.34), c.clone().setY(0.84)), "hazard");
    put(place(new BoxGeometry(0.42, 0.04, 0.38), c.clone().setY(1.16)), "black");
    put(place(new PlaneGeometry(0.11, 0.14), c.clone().setY(0.98).add(new Vector3(Math.sin(gt.face) * 0.172, 0, Math.cos(gt.face) * 0.172)), gt.face), "plate2", false);
    // Hub on the road side.
    const hub = c.clone().setY(0.95).add(new Vector3(dir * 0.21, 0, 0));
    const hg = new CylinderGeometry(0.08, 0.08, 0.08, 12);
    hg.rotateZ(Math.PI / 2);
    put(place(hg, hub), "black");
    // The arm: pivot at the hub, pointing across the road when lowered.
    const pivot = new Group();
    pivot.position.copy(hub).add(new Vector3(dir * 0.05, 0, 0));
    pivot.rotation.y = dir > 0 ? 0 : Math.PI;
    holder.add(pivot);
    const arm = new Group();
    arm.name = "gate-arm";
    pivot.add(arm);
    // Tapered FRP tube with the band film (u along the arm), a root clamp and the counterweight behind the pivot.
    const tube = new CylinderGeometry(0.028, 0.048, len, 8, 1, true);
    const uv = tube.getAttribute("uv") as BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 1 - uv.getY(i), uv.getX(i));
    tube.rotateZ(-Math.PI / 2);
    tube.translate(len / 2 + 0.1, 0, 0);
    armBag.add(E.material, E.map(tube, "arm"));
    armBag.add(E.material, E.map(new BoxGeometry(0.26, 0.13, 0.1).translate(0.1, 0, 0), "black"));
    armBag.add(E.material, E.map(new BoxGeometry(0.34, 0.2, 0.09).translate(-0.3, -0.02, 0), "black"));
    armBag.add(E.material, E.map(new BoxGeometry(0.06, 0.05, 0.1).translate(-0.1, 0.07, 0), "galv"));
    for (const mesh of armBag.emit(w, arm)) mesh.castShadow = false;
    arms.push({ node: arm, raised: (gt.lift * Math.PI) / 180 });
  }
  const state: CrossingState = { alarm: false, gate: 0 };
  w.update((_dt, t) => {
    const now = crossingAt(t);
    state.alarm = now.alarm;
    state.gate = now.gate;
    for (const a of arms) a.node.rotation.z = a.raised * (1 - now.gate);
    lampA.emissiveIntensity = now.lamp === 0 ? PEAK.lamp : 0;
    lampB.emissiveIntensity = now.lamp === 1 ? PEAK.lamp : 0;
    arrowLamp.emissiveIntensity = now.alarm ? PEAK.arrow : 0;
    led.emissiveIntensity = now.alarm ? PEAK.led : 0;
  });

  corner(put);
  bag.emit(w);
  return state;
}

/**
 * The north-west corner: the vertical warning boards by the gate, the
 * round 非常ボタン plate, a galvanised pipe fence round the equipment with
 * the multilingual rules board on its north side, the beige, grey and
 * brown cabinets, stainless bollards on the sidewalk, and the orange
 * delineator posts on the Route 134 corners.
 */
function corner(put: Put): void {
  const facing = (yaw: number) => new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  /** A board face with a galvanised back, centred at p, facing yaw. */
  const board = (cell: CellKey, wdt: number, hgt: number, p: Vector3, yaw: number, depth = 0.02) => {
    const f = facing(yaw);
    put(place(new PlaneGeometry(wdt, hgt), p.clone().addScaledVector(f, depth / 2 + 0.002), yaw), cell, false);
    put(place(new BoxGeometry(wdt, hgt, depth), p.clone(), yaw), "signBack");
  };
  const post = (x: number, z: number, h: number, r = 0.03) => put(rod(new Vector3(x, 0.05, z), new Vector3(x, h, z), r, 8), "galv");
  const ne = Math.PI * 0.92;
  // Vertical boards and the 非常ボタン plate by the north-west gate.
  post(-4.62, -4.3, 2.35, 0.032);
  board("vehicles", 0.24, 1.5, new Vector3(-4.62, 1.45, -4.36), ne);
  put(place(new CylinderGeometry(0.16, 0.16, 0.02, 20).rotateX(Math.PI / 2), new Vector3(-4.62, 2.42, -4.34), ne), "signBack");
  const es = new CircleGeometry(0.155, 20);
  put(place(es, new Vector3(-4.62, 2.42, -4.34).addScaledVector(facing(ne), 0.012), ne), "emergencySign", false);
  post(-4.22, -4.15, 1.4);
  board("noEntry", 0.38, 0.66, new Vector3(-4.22, 1.0, -4.21), ne);
  // Pipe fence round the equipment (two rails, posts every ~1.6 m) with the rules board on its north side.
  const fence: [number, number][] = [
    [-4.95, -4.0],
    [-4.95, -6.3],
    [-8.4, -6.55],
    [-8.4, -4.4],
  ];
  for (let i = 0; i < fence.length - 1; i++) {
    const a = new Vector3(fence[i][0], 0, fence[i][1]);
    const b = new Vector3(fence[i + 1][0], 0, fence[i + 1][1]);
    const n = Math.max(1, Math.round(a.distanceTo(b) / 1.6));
    for (let k = 0; k <= n; k++) {
      if (i > 0 && k === 0) continue;
      const p = a.clone().lerp(b, k / n);
      put(rod(p.clone().setY(0.05), p.clone().setY(1.12), 0.024, 6), "galv");
      put(place(new SphereGeometry(0.03, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), p.clone().setY(1.12)), "galv", false);
    }
    for (const y of [0.5, 1.08]) put(rod(a.clone().setY(y), b.clone().setY(y), 0.021, 6), "galv", false);
  }
  const rb = new Vector3(-6.0, 1.3, -6.42);
  board("rules", 0.8, 1.2, rb, Math.PI - 0.06, 0.025);
  for (const s of [-0.36, 0.36]) put(rod(new Vector3(rb.x + s, 0.05, rb.z + 0.03), new Vector3(rb.x + s, 1.9, rb.z + 0.03), 0.028, 6), "galv");
  // Cabinets: front door art on the face, plain paint elsewhere, a plinth.
  const cab = (p: Vector3, wdt: number, hgt: number, d: number, yaw: number, door: CellKey, paint: CellKey) => {
    put(place(new BoxGeometry(wdt + 0.1, 0.18, d + 0.1), p.clone().setY(0.09), yaw), "footing");
    put(place(new BoxGeometry(wdt, hgt, d), p.clone().setY(0.18 + hgt / 2), yaw), paint);
    put(place(new BoxGeometry(wdt + 0.06, 0.05, d + 0.08), p.clone().setY(0.2 + hgt), yaw), paint);
    put(place(new PlaneGeometry(wdt * 0.96, hgt * 0.96), p.clone().setY(0.18 + hgt / 2).addScaledVector(facing(yaw), d / 2 + 0.004), yaw), door, false);
  };
  cab(new Vector3(-6.5, 0, -4.95), 1.05, 1.55, 0.6, Math.PI * 0.95, "cabBeige", "beige");
  cab(new Vector3(-9.4, 0, -6.2), 0.8, 1.75, 0.55, Math.PI / 2, "cabGrey", "greyPaint");
  cab(new Vector3(-9.6, 0, -3.95), 0.75, 1.3, 0.5, 0.15, "cabBrown", "brownPaint");
  // Stainless bollards on the west sidewalk.
  for (const [x, z] of [
    [-4.05, -6.9],
    [-4.15, -8.3],
    [-4.25, -9.7],
  ]) {
    put(place(new CylinderGeometry(0.055, 0.058, 0.85, 12, 1, true), new Vector3(x, 0.05 + 0.425, z)), "steel");
    put(place(new SphereGeometry(0.055, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), new Vector3(x, 0.9, z)), "steel");
  }
  // Orange delineator posts on the Route 134 corners.
  for (const [x, z] of [
    [-7.0, 6.2],
    [-6.8, 7.3],
    [8.5, 6.6],
    [8.2, 7.5],
  ]) {
    put(place(new CylinderGeometry(0.04, 0.045, 0.8, 10, 1, true), new Vector3(x, 0.21 + 0.4, z)), "delineator");
    put(place(new CylinderGeometry(0.1, 0.1, 0.04, 10), new Vector3(x, 0.23, z)), "blackMatte");
  }
}
