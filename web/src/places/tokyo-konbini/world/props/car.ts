import { CylinderGeometry, ExtrudeGeometry, Group, LatheGeometry, MeshPhysicalMaterial, Shape, Vector2, type BufferGeometry, type Material } from "three";
import { mapUV, type AtlasRect } from "../../../shared/atlas";
import { JP_SANS, LATIN } from "../../gfx/canvas";
import { box } from "../../../shared/geo";
import type { World } from "../context";
import { instance, palette, Parts, quad, rod, v3, type Kit } from "./util";

/*
 * Boxy Japanese saloon in the mould of the Toyota Crown Comfort taxi:
 * extruded side profile with wheel arches, a narrower greenhouse, flush
 * dark glass, rectangular lamps, fender mirrors. Local frame: nose toward
 * +x, ground at y = 0, centred on z.
 */

export const CAR = { length: 4.68, width: 1.69, wheelR: 0.315, axleF: 1.35, axleR: -1.33, track: 1.46 };

export interface CarLook {
  paint: Material;
  glass: Material;
  trim: Material;
  chrome: Material;
  rubber: Material;
  head: Material;
  tail: Material;
  amber: Material;
  plate: { mat: Material; front: AtlasRect; rear: AtlasRect };
  taxi?: { stripe: Material; sign: Material; lampBody: Material; roof: AtlasRect; vacant: AtlasRect; emblem: AtlasRect };
}

export interface CarRig {
  root: Group;
  /** Sprung body (pitch and bounce). */
  body: Group;
  /** Wheel groups; spin about local z (userData.spin = ±1 for handedness). */
  wheels: Group[];
}

const ARCH_R = 0.37;
const SILL = 0.24;

function arch(cx: number, n = 10): [number, number][] {
  const cy = CAR.wheelR;
  const a0 = Math.asin((cy - SILL) / ARCH_R);
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = Math.PI + a0 - (i / n) * (Math.PI + 2 * a0);
    pts.push([cx + Math.cos(a) * ARCH_R, cy + Math.sin(a) * ARCH_R]);
  }
  return pts;
}

function extrude(pts: [number, number][], width: number, bevelT: number, bevelS: number): BufferGeometry {
  const shape = new Shape(pts.map(([x, y]) => new Vector2(x, y)));
  const depth = width - 2 * bevelT;
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevelT, bevelSize: bevelS, bevelSegments: 3, curveSegments: 4 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Plane facing +z with 0..1 UVs, mapped to an atlas rect. */
function card(w: number, h: number, r: AtlasRect): BufferGeometry {
  return mapUV(quad(v3(-w / 2, -h / 2, 0), v3(w / 2, -h / 2, 0), v3(w / 2, h / 2, 0), v3(-w / 2, h / 2, 0), v3(0, 0, 1)), r);
}

// Side profile of the lower body (sill, arches, bonnet, boot).
const LOWER: [number, number][] = [
  [2.2, SILL],
  [2.3, 0.3],
  [2.34, 0.45],
  [2.34, 0.66],
  [2.3, 0.77],
  [1.9, 0.83],
  [1.15, 0.9],
  [1.1, 0.93],
  [-1.55, 0.95],
  [-1.62, 0.94],
  [-2.18, 0.93],
  [-2.3, 0.88],
  [-2.34, 0.66],
  [-2.33, 0.4],
  [-2.26, 0.27],
  [-2.18, SILL],
  ...arch(CAR.axleR),
  ...arch(CAR.axleF),
];

// Greenhouse: windscreen base, roof, rear screen base.
const WS0 = new Vector2(1.12, 0.9);
const WS1 = new Vector2(0.42, 1.42);
const RS0 = new Vector2(-0.92, 1.44);
const RS1 = new Vector2(-1.58, 0.93);
const CABIN_W = 1.5;

function wheel(look: CarLook, p: Parts): void {
  const R = CAR.wheelR;
  const prof = [
    [0.2, -0.094],
    [0.285, -0.097],
    [0.307, -0.086],
    [R, -0.05],
    [R, 0.05],
    [0.307, 0.086],
    [0.285, 0.097],
    [0.2, 0.094],
  ].map(([x, y]) => new Vector2(x, y));
  const tyre = new LatheGeometry(prof, 28);
  tyre.rotateX(Math.PI / 2);
  p.add(look.rubber, tyre);
  const well = new CylinderGeometry(0.2, 0.2, 0.17, 20, 1, true);
  well.rotateX(Math.PI / 2);
  p.add(look.rubber, well, false);
  // Hubcap on the outer (+z) face with lug bumps, so the spin reads.
  const cap = new CylinderGeometry(0.165, 0.18, 0.025, 24);
  cap.rotateX(Math.PI / 2);
  cap.translate(0, 0, 0.085);
  p.add(look.chrome, cap, false);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const lug = new CylinderGeometry(0.014, 0.014, 0.03, 6);
    lug.rotateX(Math.PI / 2);
    lug.translate(Math.cos(a) * 0.06, Math.sin(a) * 0.06, 0.1);
    p.add(look.rubber, lug, false);
  }
}

export function buildCar(look: CarLook): CarRig {
  const root = new Group();
  const body = new Group();
  root.add(body);
  const p = new Parts();
  const halfW = CAR.width / 2;

  // Shell.
  p.add(look.paint, extrude(LOWER, CAR.width, 0.045, 0.035));
  p.add(look.paint, extrude([[WS0.x, WS0.y], [WS1.x, WS1.y], [RS0.x, RS0.y], [RS1.x, RS1.y]], CABIN_W, 0.04, 0.03));

  // Glass: windscreen and rear screen sit just proud of the bevelled shell.
  const slant = (a: Vector2, b: Vector2, t0: number, t1: number, zHalf: number, out: number) => {
    const d = b.clone().sub(a);
    const n = new Vector2(d.y, -d.x).normalize();
    if (n.y < 0) n.negate();
    const pa = a.clone().addScaledVector(d, t0).addScaledVector(n, out);
    const pb = a.clone().addScaledVector(d, t1).addScaledVector(n, out);
    return { q: quad(v3(pa.x, pa.y, -zHalf), v3(pa.x, pa.y, zHalf), v3(pb.x, pb.y, zHalf), v3(pb.x, pb.y, -zHalf), v3(n.x, n.y, 0)), n, pa };
  };
  const ws = slant(WS0, WS1, 0.04, 0.95, 0.68, 0.034);
  p.add(look.glass, ws.q, false);
  p.add(look.glass, slant(RS1, RS0, 0.06, 0.93, 0.64, 0.034).q, false);
  // Side windows (front door, rear door) on both flanks.
  const zs = CABIN_W / 2 + 0.003;
  const side = (pts: [number, number][]) => {
    for (const s of [1, -1]) {
      const [a, b, c, d] = pts.map(([x, y]) => v3(x, y, s * zs));
      p.add(look.glass, quad(a, b, c, d, v3(0, 0, s)), false);
    }
  };
  side([
    [0.98, 0.97],
    [-0.2, 0.97],
    [-0.2, 1.36],
    [0.46, 1.36],
  ]);
  side([
    [-0.3, 0.97],
    [-1.3, 0.99],
    [-0.9, 1.37],
    [-0.3, 1.37],
  ]);
  // Rain gutters along the roof edge.
  for (const s of [1, -1]) p.add(look.trim, rod(v3(0.44, 1.43, s * (CABIN_W / 2 + 0.01)), v3(-0.93, 1.45, s * (CABIN_W / 2 + 0.01)), 0.01, 4), false);

  // Bumpers, grille, lamps.
  for (const sx of [1, -1]) {
    p.add(look.trim, box(0.16, 0.2, 1.72).translate(sx * 2.32, 0.36, 0));
    p.add(look.chrome, box(0.012, 0.03, 1.6).translate(sx * 2.402, 0.41, 0), false);
  }
  p.add(look.trim, box(0.02, 0.15, 0.6).translate(2.38, 0.6, 0), false);
  for (const y of [0.56, 0.6, 0.64]) p.add(look.chrome, box(0.024, 0.012, 0.6).translate(2.387, y, 0), false);
  p.add(look.chrome, box(0.02, 0.17, 0.64).translate(2.376, 0.6, 0), false);
  for (const s of [1, -1]) {
    p.add(look.chrome, box(0.02, 0.17, 0.32).translate(2.376, 0.6, s * 0.5), false);
    p.add(look.head, box(0.024, 0.13, 0.28).translate(2.384, 0.6, s * 0.5), false);
    p.add(look.amber, box(0.02, 0.05, 0.14).translate(2.405, 0.33, s * 0.62), false);
    p.add(look.tail, box(0.024, 0.22, 0.26).translate(-2.382, 0.66, s * 0.62), false);
    p.add(look.chrome, box(0.02, 0.06, 0.1).translate(-2.38, 0.5, s * 0.62), false);
    p.add(look.amber, box(0.022, 0.06, 0.1).translate(-2.382, 0.81, s * 0.62), false);
    // Door seams, handles, mud flaps.
    for (const x of [1.02, -0.25, -1.45]) p.add(look.trim, box(0.008, 0.6, 0.006).translate(x, 0.62, s * (halfW + 0.001)), false);
    for (const x of [0.52, -0.78]) p.add(look.chrome, box(0.12, 0.025, 0.02).translate(x, 0.84, s * (halfW + 0.006)), false);
    for (const x of [CAR.axleF - 0.42, CAR.axleR - 0.42]) p.add(look.trim, box(0.02, 0.16, 0.2).translate(x, 0.31, s * 0.72), false);
  }
  // Number plates.
  const pf = card(0.33, 0.165, look.plate.front);
  pf.rotateY(Math.PI / 2);
  p.add(look.plate.mat, pf.translate(2.403, 0.37, 0), false);
  const pr = card(0.33, 0.165, look.plate.rear);
  pr.rotateY(-Math.PI / 2);
  p.add(look.plate.mat, pr.translate(-2.384, 0.56, 0), false);

  if (look.taxi) {
    const t = look.taxi;
    // Fender mirrors: the unmistakable taxi detail.
    for (const s of [1, -1]) {
      p.add(look.trim, rod(v3(1.86, 0.84, s * 0.7), v3(1.83, 1.0, s * 0.74), 0.008, 5), false);
      p.add(look.trim, box(0.06, 0.08, 0.05).translate(1.82, 1.03, s * 0.75));
    }
    // Belt stripe along both flanks.
    for (const s of [1, -1]) p.add(t.stripe, box(4.46, 0.05, 0.004).translate(0, 0.745, s * (halfW + 0.002)), false);
    // Roof lamp (行灯) with lit faces front and back.
    p.add(look.trim, box(0.22, 0.03, 0.34).translate(-0.18, 1.49, 0));
    p.add(t.lampBody, box(0.13, 0.13, 0.44).translate(-0.18, 1.57, 0), false);
    for (const s of [1, -1]) {
      const f = card(0.42, 0.12, t.roof);
      f.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
      p.add(t.sign, f.translate(-0.18 + s * 0.067, 1.57, 0), false);
    }
    // 空車 (vacant) LED behind the windscreen, passenger side.
    const vac = card(0.2, 0.07, t.vacant);
    vac.rotateY(Math.PI / 2);
    const n = ws.n;
    vac.rotateZ(Math.atan2(n.y, n.x));
    const vp = WS0.clone().lerp(WS1, 0.16).addScaledVector(n, 0.037);
    p.add(t.sign, vac.translate(vp.x, vp.y, -0.36), false);
    // Company emblem on the rear doors.
    for (const s of [1, -1]) {
      const e = card(0.5, 0.12, t.emblem);
      if (s < 0) e.rotateY(Math.PI);
      p.add(look.plate.mat, e.translate(-0.85, 0.6, s * (halfW + 0.004)), false);
    }
  }
  instance(p.bake(), body);

  // Wheels.
  const wp = new Parts();
  wheel(look, wp);
  const baked = wp.bake();
  const wheels: Group[] = [];
  for (const x of [CAR.axleF, CAR.axleR])
    for (const s of [1, -1]) {
      const g = new Group();
      g.position.set(x, CAR.wheelR, s * (CAR.track / 2));
      if (s < 0) g.rotation.y = Math.PI;
      g.userData.spin = s;
      instance(baked, g);
      root.add(g);
      wheels.push(g);
    }
  return { root, body, wheels };
}

/** World-space helper: headlight/taillight anchor points in the car's local frame. */
export const LAMPS = {
  head: [v3(2.4, 0.6, 0.5), v3(2.4, 0.6, -0.5)],
  tail: v3(-2.45, 0.66, 0),
};


/** Static private cars (white plates) parked in the coin-parking lot; merged by the batcher. */
export function parkedCars(w: World, kit: Kit, cars: { x: number; z: number; ry: number; color: number; plate: string }[]): void {
  const P = palette(w.lib);
  const glass = new MeshPhysicalMaterial({ color: 0x05080b, metalness: 0, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.3 });
  for (const c of cars) {
    const plate = kit.draw(`plate-${c.plate}`, 128, 64, (g, cw, ch) => {
      g.fillStyle = "#f2f2ec";
      g.fillRect(0, 0, cw, ch);
      g.strokeStyle = "#1c6a3c";
      g.lineWidth = 2;
      g.strokeRect(3, 3, cw - 6, ch - 6);
      g.fillStyle = "#1c6a3c";
      g.textAlign = "center";
      g.textBaseline = "middle";
      const [top, kana, num] = c.plate.split("|");
      g.font = `700 ${ch * 0.24}px ${JP_SANS}`;
      g.fillText(top, cw / 2, ch * 0.24);
      g.font = `700 ${ch * 0.2}px ${JP_SANS}`;
      g.fillText(kana, cw * 0.14, ch * 0.68);
      g.font = `800 ${ch * 0.5}px ${LATIN}`;
      g.fillText(num, cw * 0.58, ch * 0.68);
    });
    const rig = buildCar({
      paint: new MeshPhysicalMaterial({ color: c.color, metalness: 0.3, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }),
      glass,
      trim: P.black,
      chrome: P.chrome,
      rubber: P.rubber,
      head: P.chrome,
      tail: P.red,
      amber: P.yellow,
      plate: { mat: kit.labels, front: plate, rear: plate },
    });
    rig.root.position.set(c.x, 0, c.z);
    rig.root.rotation.y = c.ry;
    w.root.add(rig.root);
  }
}
