import { BoxGeometry, BufferGeometry, CylinderGeometry, Group, MeshStandardMaterial, PlaneGeometry, SphereGeometry, Vector3, type Material } from "three";
import { mapUV, type AtlasRect } from "../../shared/atlas";
import { merge, rod } from "../../shared/shapes";
import { arrowPanel, crossbuck, emergencyBox, fumikiriBox, gateArm, hazard, noEntryBoard, plate, rulesBoard, solid, vehicleBoard } from "../gfx/art";
import { Bag, type KamakuraWorld, type SOLIDS } from "./context";
import { crossingAt } from "./timeline";

/**
 * The crossing equipment (first class: lamps, bell, gates). Two warning
 * masts stand on the drivers' left of each approach: north-east of the road
 * for traffic coming down the slope (black-and-yellow striped crossbuck,
 * the orange ふみきり LED box, the emergency button) and south-west by
 * Route 134 (plain yellow-orange crossbuck with a black edge, the electronic
 * bell on top, the train-direction indicator, lamps facing west as well).
 * Each face carries two red lamps one above the other that flash in turn.
 * Four gate machines close both approaches; their striped arms stand almost
 * upright when raised. Lamps, the LED box and the indicator are tracked
 * emissive materials; the arms are moving nodes.
 */

export interface CrossingState {
  alarm: boolean;
  gate: number;
}

/** A cylinder whose UVs wrap around (u) and run up (v), mapped into an atlas cell. */
function pole(r0: number, r1: number, h: number, cell: AtlasRect, seg = 10): BufferGeometry {
  const g = new CylinderGeometry(r1, r0, h, seg, 1, true);
  mapUV(g, cell);
  return g;
}

type Add = (m: Material | keyof typeof SOLIDS, g: BufferGeometry, cast?: boolean) => void;

/** Lamp head: black housing, round lens and hood, facing +z, centred on the lens. */
function lampHead(add: Add, lens: Material, p: Vector3, yaw: number): void {
  const housing = new BoxGeometry(0.42, 0.42, 0.16);
  housing.translate(0, 0, -0.09);
  const glass = new CylinderGeometry(0.15, 0.15, 0.03, 14);
  glass.rotateX(Math.PI / 2);
  // Hood: the upper half of a short tube over the lens.
  const hood = new CylinderGeometry(0.19, 0.19, 0.28, 12, 1, true, -Math.PI / 2, Math.PI);
  hood.rotateX(Math.PI / 2);
  hood.translate(0, 0, 0.1);
  for (const [g, m] of [
    [housing, "black"],
    [glass, lens],
    [hood, "black"],
  ] as [BufferGeometry, Material | "black"][]) {
    g.rotateY(yaw);
    g.translate(p.x, p.y, p.z);
    add(m, g, m !== lens);
  }
}

export function buildCrossing(w: KamakuraWorld): CrossingState {
  const lib = w.lib;
  const bag = new Bag();
  const P = w.printed;
  const black = "black" as const;
  const galv = "galv" as const;
  const beige = "beige" as const;
  // Small parts paint from the printed atlas (one draw per chunk with the signs).
  const add: Add = (m, g, cast = true) => (typeof m === "string" ? bag.add(P, w.tint(g, m), cast) : bag.add(m, g, cast));
  const lampA = lib.lamp("a", 0xff2a10, 9);
  const lampB = lib.lamp("b", 0xff2a10, 9);
  const arrowLamp = lib.lamp("arrow", 0xff9a20, 6);
  // The LED box glows through its printed face.
  const led = new MeshStandardMaterial({ map: w.atlas.texture, emissiveMap: w.atlas.texture, emissive: 0xffffff, emissiveIntensity: 3.5, roughness: 0.4 });
  led.name = "lamp-led";

  const A = {
    stripe: w.draw("stripe", 512, 512, hazard),
    arm: w.draw("gate-arm", 1024, 64, gateArm),
    xStriped: w.draw("x-striped", 512, 512, (g, cw, ch) => crossbuck(g, cw, ch, true)),
    xPlain: w.draw("x-plain", 512, 512, (g, cw, ch) => crossbuck(g, cw, ch, false)),
    fumikiri: w.draw("fumikiri", 384, 128, fumikiriBox),
    emergency: w.draw("emergency", 192, 256, emergencyBox),
    arrow: w.draw("arrow-panel", 256, 128, arrowPanel),
    vehicles: w.draw("no-through", 128, 640, vehicleBoard),
    noEntry: w.draw("no-entry", 256, 448, noEntryBoard),
    rules: w.draw("rules-board", 640, 960, rulesBoard),
    cabinet: w.draw("cabinet-label", 256, 96, (g, cw, ch) => plate(g, cw, ch, "鎌高 5XK")),
    beige: w.draw("beige", 64, 64, solid("#c9bc9f")),
  };

  // ------------------------------------------------------------ masts
  const masts: { x: number; z: number; striped: boolean; faces: number[] }[] = [
    // Lamp faces as yaw (radians; 0 = +z, south).
    { x: 5.75, z: -3.3, striped: true, faces: [Math.PI, 0] },
    { x: -4.6, z: 3.4, striped: false, faces: [Math.PI, 0, -Math.PI / 2] },
  ];
  for (const m of masts) {
    const base = new Vector3(m.x, 0.05, m.z);
    add(P, place(pole(0.1, 0.09, 4.25, A.stripe), base.clone().setY(2.17)));
    add(black, place(new SphereGeometry(0.08, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), base.clone().setY(4.3)));
    // Crossbuck, centre 3.5 m up, square to the road.
    const xs = new PlaneGeometry(1.55, 1.55);
    mapUV(xs, m.striped ? A.xStriped : A.xPlain);
    add(w.cut, place(xs, base.clone().setY(3.55).add(new Vector3(0, 0, 0.09))));
    // Lamp pairs on short arms beside the pole, one per face.
    for (const yaw of m.faces) {
      const out = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const side = new Vector3(out.z, 0, -out.x);
      const arm = base.clone().addScaledVector(side, -0.42).addScaledVector(out, 0.14);
      add(black, rodBetween(base.clone().setY(2.9), arm.clone().setY(2.9), 0.03), false);
      add(black, rodBetween(base.clone().setY(2.42), arm.clone().setY(2.42), 0.03), false);
      lampHead(add, lampA, arm.clone().setY(2.98), yaw);
      lampHead(add, lampB, arm.clone().setY(2.42), yaw);
    }
    if (m.striped) {
      // ふみきり LED box (lit while ringing) and the emergency button box, facing up the slope.
      const box = new BoxGeometry(0.62, 0.22, 0.12);
      add(black, place(box, base.clone().setY(2.05).add(new Vector3(0, 0, -0.13))));
      const face = new PlaneGeometry(0.58, 0.19);
      mapUV(face, A.fumikiri);
      face.rotateY(Math.PI);
      add(led, place(face, base.clone().setY(2.05).add(new Vector3(0, 0, -0.195))), false);
      const eb = new BoxGeometry(0.28, 0.36, 0.14);
      add("white", place(eb, base.clone().setY(1.25).add(new Vector3(-0.06, 0, -0.15))));
      const ef = new PlaneGeometry(0.26, 0.34);
      mapUV(ef, A.emergency);
      ef.rotateY(Math.PI);
      add(P, place(ef, base.clone().setY(1.25).add(new Vector3(-0.06, 0, -0.222))), false);
    } else {
      // Electronic bell on top and the train-direction indicator facing the slope.
      const bell = new CylinderGeometry(0.11, 0.16, 0.22, 12);
      add(black, place(bell, base.clone().setY(4.45)));
      const ind = new BoxGeometry(0.5, 0.26, 0.12);
      add(black, place(ind, base.clone().setY(1.95).add(new Vector3(0.16, 0, -0.1))));
      const face = new PlaneGeometry(0.46, 0.22);
      mapUV(face, A.arrow);
      face.rotateY(Math.PI);
      add(P, place(face, base.clone().setY(1.95).add(new Vector3(0.16, 0, -0.165))), false);
      // The lit arrow (westbound train: pointing west, right as seen from the slope).
      const tri = new CylinderGeometry(0.09, 0.09, 0.02, 3);
      tri.rotateX(Math.PI / 2);
      tri.rotateZ(Math.PI / 2);
      add(arrowLamp, place(tri, base.clone().setY(1.95).add(new Vector3(0.05, 0, -0.17))), false);
    }
  }

  // ------------------------------------------------------------ gates
  const gates: { x: number; z: number; to: number }[] = [
    // Each arm reaches past the road's centre line; the west arms sit a hand's width outboard of the east ones.
    { x: 5.75, z: -3.55, to: -0.4 },
    { x: -4.4, z: -3.8, to: 1.6 },
    { x: 5.6, z: 3.35, to: -0.4 },
    { x: -4.6, z: 3.6, to: 1.6 },
  ];
  const arms: Group[] = [];
  const holder = w.group();
  holder.name = "gates";
  holder.userData.dynamic = true;
  for (const gt of gates) {
    const len = Math.abs(gt.to - gt.x) + 0.3;
    const dir = Math.sign(gt.to - gt.x);
    // Machine housing, striped.
    const house = new BoxGeometry(0.42, 1.0, 0.36);
    const uv = house.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setXY(i, A.stripe.u0 + uv.getX(i) * (A.stripe.u1 - A.stripe.u0), A.stripe.v0 + uv.getY(i) * (A.stripe.v1 - A.stripe.v0));
    add(P, place(house, new Vector3(gt.x, 0.55, gt.z)));
    add(black, place(new BoxGeometry(0.46, 0.06, 0.4), new Vector3(gt.x, 1.08, gt.z)));
    // The arm: pivot 0.95 m up, pointing across the road when lowered.
    const pivot = new Group();
    pivot.position.set(gt.x, 0.95, gt.z);
    pivot.rotation.y = dir > 0 ? 0 : Math.PI;
    holder.add(pivot);
    const arm = new Group();
    arm.name = "gate-arm";
    pivot.add(arm);
    // Striped arm, 0.12 m deep at the pivot, tapering to 0.07 m at the tip.
    const bar = new BoxGeometry(len, 0.12, 0.1);
    const bp = bar.getAttribute("position");
    for (let i = 0; i < bp.count; i++) if (bp.getX(i) > 0) bp.setXYZ(i, bp.getX(i), bp.getY(i) * 0.6, bp.getZ(i) * 0.7);
    const buv = bar.getAttribute("uv");
    for (let i = 0; i < buv.count; i++) buv.setXY(i, A.arm.u0 + buv.getX(i) * (A.arm.u1 - A.arm.u0), A.arm.v0 + buv.getY(i) * (A.arm.v1 - A.arm.v0));
    bar.translate(len / 2 + 0.15, 0, 0);
    // Counterweight behind the pivot, in the same mesh (one draw per arm).
    const weight = w.tint(new BoxGeometry(0.3, 0.16, 0.12), "black").translate(-0.2, 0, 0);
    w.mesh(merge([bar, weight]), P, 0, 0, 0, arm, { cast: true });
    arms.push(arm);
  }
  const state: CrossingState = { alarm: false, gate: 0 };
  const raised = (85 * Math.PI) / 180;
  w.update((_dt, t) => {
    const now = crossingAt(t);
    state.alarm = now.alarm;
    state.gate = now.gate;
    for (const a of arms) a.rotation.z = raised * (1 - now.gate);
    lampA.emissiveIntensity = now.lamp === 0 ? 9 : 0;
    lampB.emissiveIntensity = now.lamp === 1 ? 9 : 0;
    arrowLamp.emissiveIntensity = now.alarm ? 6 : 0;
    led.emissiveIntensity = now.alarm ? 3.5 : 0;
  });

  // ------------------------------------------------------------ corner fixtures
  // North-west: the rules board, the two vertical boards at the deck, cabinets, bollards.
  const board = (cell: AtlasRect, wdt: number, hgt: number, p: Vector3, yaw: number, legs = true) => {
    const g = new PlaneGeometry(wdt, hgt);
    mapUV(g, cell);
    add(P, place(g, p, yaw), false);
    const back = new PlaneGeometry(wdt, hgt);
    back.rotateY(Math.PI);
    mapUV(back, A.beige);
    add(P, place(back, p.clone().add(new Vector3(-Math.sin(yaw) * 0.01, 0, -Math.cos(yaw) * 0.01)), yaw), false);
    if (legs)
      for (const s of [-1, 1]) {
        const lp = p.clone().add(new Vector3(Math.cos(yaw) * s * wdt * 0.45, 0, -Math.sin(yaw) * s * wdt * 0.45));
        add(galv, rodBetween(lp.clone().setY(0.2), lp.clone().setY(p.y + hgt / 2), 0.025), false);
      }
  };
  board(A.rules, 0.8, 1.2, new Vector3(-7.4, 1.35, -3.9), 0.5);
  board(A.vehicles, 0.22, 1.1, new Vector3(-4.3, 1.35, -2.75), Math.PI * 0.1, false);
  add(galv, rodBetween(new Vector3(-4.3, 0.2, -2.8), new Vector3(-4.3, 2.0, -2.8), 0.03), false);
  board(A.noEntry, 0.32, 0.56, new Vector3(-4.9, 1.2, -2.9), Math.PI * 0.12, false);
  add(galv, rodBetween(new Vector3(-4.9, 0.2, -2.95), new Vector3(-4.9, 1.5, -2.95), 0.025), false);
  // Equipment cabinets: beige and grey, with a label.
  const cab = (p: Vector3, wdt: number, hgt: number, d: number, yaw: number, mat: keyof typeof SOLIDS) => {
    add(mat, place(new BoxGeometry(wdt, hgt, d), p.clone().setY(0.22 + hgt / 2), yaw));
    add(mat, place(new BoxGeometry(wdt + 0.08, 0.06, d + 0.08), p.clone().setY(0.25 + hgt), yaw));
  };
  cab(new Vector3(-8.6, 0, -5.6), 1.1, 1.55, 0.6, 0.45, beige);
  cab(new Vector3(-7.4, 0, -6.4), 0.8, 1.7, 0.55, 0.45, "grey");
  const lab = new PlaneGeometry(0.42, 0.16);
  mapUV(lab, A.cabinet);
  add(P, place(lab, new Vector3(-7.4 + Math.sin(0.45) * 0.28, 1.6, -6.4 + Math.cos(0.45) * 0.28), 0.45), false);
  for (const [x, z] of [
    [-4.2, -6.5],
    [-4.3, -8.0],
    [-4.4, -9.6],
  ])
    add(galv, place(new CylinderGeometry(0.055, 0.055, 0.85, 8), new Vector3(x, 0.24 + 0.42, z)));
  // Orange delineator posts on the Route 134 corners.
  const orange = w.draw("orange", 64, 64, solid("#e0601a"));
  for (const [x, z] of [
    [-7.0, 6.2],
    [-6.8, 7.3],
    [8.5, 6.6],
    [8.2, 7.5],
  ]) {
    add(P, place(pole(0.045, 0.04, 0.8, orange, 8), new Vector3(x, 0.21 + 0.4, z)), false);
  }

  bag.emit(w);
  return state;
}

/** Thin round bar between two points. */
export function rodBetween(a: Vector3, b: Vector3, r: number, seg = 6): BufferGeometry {
  return rod(a, b, r, seg);
}

function place(g: BufferGeometry, p: Vector3, yaw = 0): BufferGeometry {
  if (yaw) g.rotateY(yaw);
  g.translate(p.x, p.y, p.z);
  return g;
}

