import { CylinderGeometry, ExtrudeGeometry, Group, Shape, SphereGeometry, TorusGeometry, Vector2, Vector3, type BufferGeometry, type Material, type Object3D } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { box } from "../../../shared/geo";
import type { World } from "../context";
import { instance, palette, Parts, rod, tube, v3 } from "./util";

/** Drops the end caps of a thin rod (never seen on wires this fine). */
function open(g: BufferGeometry): BufferGeometry {
  const idx = g.index;
  if (idx) g.setIndex(Array.from(idx.array).slice(0, (g.groups[0]?.count ?? idx.count)));
  g.clearGroups();
  return g;
}

/*
 * Mamachari (ママチャリ): step-through city bike with a front wire basket,
 * full chain case, rear carrier, mudguards and a two-legged rear stand.
 * Local frame: front toward +x, rider's right toward +z, ground at y = 0.
 */

const REAR = v3(-0.54, 0.335, 0);
const FRONT = v3(0.56, 0.335, 0);
const BB = v3(-0.03, 0.27, 0);
const SEAT = v3(-0.2, 0.8, 0);
const HEAD_TOP = v3(0.36, 0.86, 0);
const HEAD_BOT = v3(0.415, 0.64, 0);

type Baked = ReturnType<Parts["bake"]>;
/** Baked parts per frame colour: the frame-fixed rear and the steering front. */
interface BikeKit {
  rear: Baked[];
  front: Baked[];
  axis: Vector3;
}

interface BikeMats {
  rubber: Material;
  case: Material;
  chrome: Material;
  silver: Material;
  reflector: Material;
}

/** Wheel: tyre, rim, hub and 20 spokes laced with a little offset. */
function wheel(p: Parts, m: BikeMats, c: Vector3): void {
  const tyre = new TorusGeometry(0.314, 0.021, 5, 30);
  tyre.translate(c.x, c.y, c.z);
  p.add(m.rubber, tyre);
  const rim = new TorusGeometry(0.292, 0.01, 3, 30);
  rim.translate(c.x, c.y, c.z);
  p.add(m.chrome, rim, false);
  const hub = new CylinderGeometry(0.026, 0.026, 0.1, 10);
  hub.rotateX(Math.PI / 2);
  hub.translate(c.x, c.y, c.z);
  p.add(m.chrome, hub, false);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const side = i % 2 ? 1 : -1;
    const ra = a + side * 0.22;
    const h0 = v3(c.x + Math.cos(a) * 0.024, c.y + Math.sin(a) * 0.024, side * 0.035);
    const h1 = v3(c.x + Math.cos(ra) * 0.288, c.y + Math.sin(ra) * 0.288, 0);
    p.add(m.chrome, open(rod(h0, h1, 0.0022, 3)), false);
  }
}

/** Open arc (mudguard) around a wheel centre: θ measured from the ground point, forward positive. */
function guard(c: Vector3, start: number, len: number): BufferGeometry {
  const g = new CylinderGeometry(0.352, 0.352, 0.062, 18, 1, true, start, len);
  g.rotateX(Math.PI / 2);
  g.translate(c.x, c.y, c.z);
  return g;
}

/** Rectangle loop of wire at height y (basket rings). */
function ring(p: Parts, mat: Material, x0: number, x1: number, z0: number, z1: number, y: number, r: number): void {
  const a = v3(x0, y, z0);
  const b = v3(x1, y, z0);
  const c = v3(x1, y, z1);
  const d = v3(x0, y, z1);
  for (const [s, e] of [
    [a, b],
    [b, c],
    [c, d],
    [d, a],
  ])
    p.add(mat, open(rod(s, e, r, 3)), false);
}

function convexHull(pts: Vector2[]): Vector2[] {
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Vector2, a: Vector2, b: Vector2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vector2[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vector2[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function buildKit(frame: Material[], m: BikeMats): BikeKit {
  // ------------------------------------------------ rear (frame-fixed) part
  const rear = new Parts();
  const FR = frame[0];
  wheel(rear, m, REAR);
  // Step-through down tube sweeping low to the bottom bracket.
  rear.add(FR, tube([v3(0.405, 0.73, 0), v3(0.33, 0.52, 0), v3(0.17, 0.34, 0), v3(0.04, 0.285, 0), BB], 0.024, 8));
  rear.add(FR, tube([v3(0.395, 0.66, 0), v3(0.3, 0.46, 0), v3(0.14, 0.33, 0), v3(0.02, 0.3, 0)], 0.012, 6));
  rear.add(FR, rod(BB, SEAT, 0.018, 8));
  rear.add(FR, rod(HEAD_BOT.clone().setY(0.62), HEAD_TOP.clone().setY(0.88), 0.024, 10));
  for (const s of [-1, 1]) {
    rear.add(FR, rod(BB.clone().setZ(s * 0.03), REAR.clone().setZ(s * 0.055), 0.0105, 6));
    rear.add(FR, rod(SEAT.clone().add(v3(-0.01, -0.03, s * 0.018)), REAR.clone().setZ(s * 0.055), 0.0095, 6));
  }
  // Seat post, saddle with springs.
  rear.add(m.chrome, rod(SEAT, v3(-0.245, 0.95, 0), 0.0125, 8));
  rear.add(m.rubber, new RoundedBoxGeometry(0.27, 0.075, 0.2, 1, 0.03).translate(-0.265, 0.99, 0));
  for (const s of [-1, 1]) rear.add(m.chrome, new CylinderGeometry(0.014, 0.014, 0.05, 6).translate(-0.34, 0.935, s * 0.06), false);
  // Chain case over the chainring and rear sprocket (right side).
  const pts: Vector2[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    pts.push(new Vector2(BB.x + Math.cos(a) * 0.118, BB.y + Math.sin(a) * 0.118));
    pts.push(new Vector2(REAR.x + Math.cos(a) * 0.062, REAR.y + Math.sin(a) * 0.062));
  }
  const case_ = new ExtrudeGeometry(new Shape(convexHull(pts)), { depth: 0.03, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1, curveSegments: 4 });
  case_.translate(0, 0, 0.05);
  rear.add(m.case, case_);
  // Cranks and pedals.
  for (const s of [-1, 1]) {
    const tip = v3(BB.x + s * 0.08, BB.y - s * 0.14, s * 0.1);
    rear.add(m.chrome, rod(v3(BB.x, BB.y, s * 0.085), tip, 0.011, 5));
    rear.add(m.rubber, box(0.1, 0.022, 0.085).translate(tip.x, tip.y, tip.z + s * 0.05));
  }
  // Rear mudguard, carrier with stays, stand, ring lock, reflector.
  rear.add(m.silver, guard(REAR, 2.4, 2.75));
  for (const s of [-1, 1]) {
    rear.add(m.chrome, rod(v3(-0.3, 0.76, s * 0.075), v3(-0.82, 0.76, s * 0.075), 0.007, 5));
    rear.add(m.chrome, rod(v3(-0.78, 0.76, s * 0.075), REAR.clone().setZ(s * 0.06), 0.006, 5));
    rear.add(m.chrome, rod(v3(-0.32, 0.76, s * 0.075), SEAT.clone().add(v3(-0.02, -0.05, s * 0.02)), 0.006, 5));
    rear.add(m.chrome, rod(REAR.clone().setZ(s * 0.065), v3(-0.64, 0.004, s * 0.17), 0.009, 5));
  }
  for (const x of [-0.36, -0.5, -0.64, -0.8]) rear.add(m.chrome, rod(v3(x, 0.762, -0.075), v3(x, 0.762, 0.075), 0.005, 4), false);
  rear.add(m.chrome, rod(v3(-0.64, 0.01, -0.17), v3(-0.64, 0.01, 0.17), 0.009, 5));
  rear.add(m.silver, box(0.05, 0.1, 0.11).translate(-0.42, 0.5, 0));
  rear.add(m.reflector, box(0.012, 0.05, 0.075).translate(-0.83, 0.71, 0), false);

  // ------------------------------------------------ front (steering) part
  const front = new Parts();
  wheel(front, m, FRONT);
  for (const s of [-1, 1]) front.add(FR, tube([v3(0.415, 0.64, s * 0.03), v3(0.455, 0.5, s * 0.052), v3(0.52, 0.39, s * 0.055), FRONT.clone().setZ(s * 0.055)], 0.011, 6));
  front.add(FR, box(0.07, 0.03, 0.13).translate(0.415, 0.635, 0));
  // Stem and swept-back handlebar with grips, levers and bell.
  front.add(m.chrome, rod(HEAD_TOP, v3(0.345, 1.0, 0), 0.014, 8));
  front.add(m.chrome, tube([v3(0.17, 0.975, -0.3), v3(0.27, 0.995, -0.25), v3(0.335, 1.0, -0.1), v3(0.345, 1.0, 0), v3(0.335, 1.0, 0.1), v3(0.27, 0.995, 0.25), v3(0.17, 0.975, 0.3)], 0.011, 6));
  for (const s of [-1, 1]) {
    front.add(m.rubber, rod(v3(0.17, 0.975, s * 0.3), v3(0.07, 0.965, s * 0.31), 0.017, 8));
    front.add(m.chrome, rod(v3(0.26, 0.99, s * 0.24), v3(0.14, 0.955, s * 0.22), 0.006, 4), false);
  }
  front.add(m.chrome, new SphereGeometry(0.028, 10, 6).translate(0.29, 1.02, -0.17), false);
  // Wire basket over the front wheel, on stays to the axle.
  const bx0 = 0.5;
  const bx1 = 0.86;
  const bz = 0.17;
  const by0 = 0.72;
  const by1 = 0.99;
  ring(front, m.chrome, bx0, bx1, -bz, bz, by0, 0.004);
  ring(front, m.chrome, bx0, bx1, -bz, bz, 0.81, 0.003);
  ring(front, m.chrome, bx0, bx1, -bz, bz, 0.9, 0.003);
  ring(front, m.chrome, bx0 - 0.004, bx1 + 0.004, -bz - 0.004, bz + 0.004, by1, 0.0055);
  for (let x = bx0; x <= bx1 + 1e-6; x += 0.045)
    for (const z of [-bz, bz]) front.add(m.chrome, open(rod(v3(x, by0, z), v3(x, by1, z), 0.0028, 3)), false);
  for (let z = -bz + 0.0425; z < bz - 0.01; z += 0.0425)
    for (const x of [bx0, bx1]) front.add(m.chrome, open(rod(v3(x, by0, z), v3(x, by1, z), 0.0028, 3)), false);
  for (let z = -bz; z <= bz + 1e-6; z += 0.085) front.add(m.chrome, open(rod(v3(bx0, by0, z), v3(bx1, by0, z), 0.003, 3)), false);
  for (const s of [-1, 1]) front.add(m.chrome, rod(v3(0.64, by0, s * 0.08), FRONT.clone().setZ(s * 0.062), 0.006, 5));
  front.add(m.chrome, rod(v3(bx0, 0.86, 0), v3(0.37, 0.84, 0), 0.008, 5));
  // Front mudguard and dynamo lamp.
  front.add(m.silver, guard(FRONT, 0.7, 2.6));
  const lamp = new CylinderGeometry(0.036, 0.03, 0.085, 12);
  lamp.rotateZ(Math.PI / 2);
  lamp.translate(0.52, 0.66, 0);
  front.add(m.silver, lamp);

  const axis = HEAD_TOP.clone().sub(HEAD_BOT).normalize();
  // Steering pivots about the head tube: bake the front part around HEAD_BOT.
  const fb = front.bake();
  for (const b of fb) b.geo.translate(-HEAD_BOT.x, -HEAD_BOT.y, -HEAD_BOT.z);
  // Frame colour variants share everything except the frame material.
  const rb = rear.bake();
  return {
    rear: frame.map((mat) => rb.map((b) => (b.mat === FR ? { ...b, mat } : b))),
    front: frame.map((mat) => fb.map((b) => (b.mat === FR ? { ...b, mat } : b))),
    axis,
  };
}

export interface BikeOpts {
  color: number;
  steer?: number;
  /** Lean about the bike's long axis (+ tips toward its right side). */
  roll?: number;
}

export const BIKE_COLORS = [0xd8d6cc, 0x23324a, 0x7a1d24];

/**
 * Builds the shared bicycle parts once; returns a function that places a
 * bike (group at x, z facing `ry`, where ry = 0 faces +x).
 */
export function bicycleFactory(w: World): (parent: Object3D, x: number, z: number, ry: number, o: BikeOpts) => Group {
  const lib = w.lib;
  const frames = BIKE_COLORS.map((c) => lib.paint(c, 0.3));
  const P = palette(lib);
  const m: BikeMats = {
    rubber: P.rubber,
    case: P.dark,
    chrome: P.chrome,
    silver: P.gray,
    reflector: P.red,
  };
  const kit = buildKit(frames, m);
  return (parent, x, z, ry, o) => {
    const vi = Math.max(0, BIKE_COLORS.indexOf(o.color));
    const g = new Group();
    g.position.set(x, 0, z);
    g.rotation.order = "YXZ";
    g.rotation.y = ry;
    g.rotation.x = o.roll ?? 0;
    parent.add(g);
    instance(kit.rear[vi], g);
    const f = new Group();
    f.position.copy(HEAD_BOT);
    f.quaternion.setFromAxisAngle(kit.axis, o.steer ?? 0);
    g.add(f);
    instance(kit.front[vi], f);
    return g;
  };
}
