import { BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, Group, Vector3, type Material } from "three";
import { merge, rod } from "../../shared/shapes";
import { enodenLivery } from "../gfx/art";
import type { KamakuraWorld } from "./context";
import type { CrossingState } from "./crossing";
import { LOOP, TRACK } from "./layout";
import { APPROACH, ARRIVE, RUN, T0, trainFront } from "./timeline";

/**
 * One Enoden train per loop: a 500-type set of two articulated two-car
 * units (four 12.5 m bodies, 50.8 m), green and cream, Fujisawa-bound. It
 * rounds the bend from Shichirigahama behind the houses at 45 km/h, eases
 * to 30 km/h through the crossing (left to right in the canonical view) and
 * brakes for the platform 107 m on, where it stops out of every shot.
 *
 * Each body is a moving node that follows the track: its ends sit on the
 * centreline (the articulation bogies), so the set bends through the curve.
 */

export const TRAIN = {
  summary: {
    type: "Enoden 500 type, 2 × 2 cars (50.8 m)",
    direction: "Fujisawa-bound (westbound)",
    frontAtCrossing: T0,
    approachSeconds: Math.round(APPROACH * 10) / 10,
    stopsAfter: Math.round(ARRIVE * 10) / 10,
    speeds: { approachKmh: Math.round(RUN.cruise * 3.6), crossingKmh: Math.round(RUN.pass * 3.6) },
    loopSeconds: LOOP,
  },
};

const BODY = 12.5;
const GAP = 0.2;
const W = 1.25;
const FLOOR = 0.95;
const ROOF = 3.66;

/** Half cross-section of the body shell, from the skirt up over the roof (y, half-width). */
const PROFILE: [number, number][] = [
  [FLOOR, 1.2],
  [1.3, W],
  [3.12, W],
  [3.42, 1.19],
  [3.56, 1.06],
  [3.63, 0.8],
  [ROOF, 0.0],
];

/**
 * Body shell along local x (−L/2 … L/2, nose at +x), sides mapped to the
 * livery's side panel; the roof strip (above 3.45 m) is a separate geometry.
 */
function shell(len: number): { sides: BufferGeometry; roof: BufferGeometry } {
  const sides: number[] = [];
  const suv: number[] = [];
  const roof: number[] = [];
  const x0 = -len / 2;
  const x1 = len / 2;
  const quad = (out: number[], a: number[], b: number[], c: number[], d: number[], uv?: number[][], uvOut?: number[]) => {
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
    if (uv && uvOut) uvOut.push(...uv[0], ...uv[1], ...uv[2], ...uv[0], ...uv[2], ...uv[3]);
  };
  const vOf = (y: number) => 0.5 + (Math.min(y, ROOF) - FLOOR) / (ROOF - FLOOR) * 0.5;
  for (const side of [1, -1]) {
    for (let i = 0; i < PROFILE.length - 1; i++) {
      const [ya, wa] = PROFILE[i];
      const [yb, wb] = PROFILE[i + 1];
      const za = side * wa;
      const zb = side * wb;
      const pa0 = [x0, ya, za];
      const pa1 = [x1, ya, za];
      const pb1 = [x1, yb, zb];
      const pb0 = [x0, yb, zb];
      // Winding outward: for side +1 (+z) a → a' → b' → b faces +z.
      const inSide = ya < 3.45;
      const target = inSide ? sides : roof;
      const uvs = side > 0 ? [[0, vOf(ya)], [1, vOf(ya)], [1, vOf(yb)], [0, vOf(yb)]] : [[1, vOf(ya)], [0, vOf(ya)], [0, vOf(yb)], [1, vOf(yb)]];
      if (side > 0) quad(target, pa0, pa1, pb1, pb0, inSide ? uvs : undefined, inSide ? suv : undefined);
      else quad(target, pa1, pa0, pb0, pb1, inSide ? [uvs[1], uvs[0], uvs[3], uvs[2]] : undefined, inSide ? suv : undefined);
    }
  }
  const s = new BufferGeometry();
  s.setAttribute("position", new Float32BufferAttribute(sides, 3));
  s.setAttribute("uv", new Float32BufferAttribute(suv, 2));
  s.computeVertexNormals();
  const r = new BufferGeometry();
  r.setAttribute("position", new Float32BufferAttribute(roof, 3));
  r.computeVertexNormals();
  return { sides: s, roof: r };
}

/**
 * End wall at x (facing +x when `dir` = 1): the cab front (a gently raked
 * windscreen above the waist) or the gangway end, mapped to the livery's
 * lower half (cab: u 0–0.5, gangway end: u 0.5–1).
 */
function endWall(x: number, dir: 1 | -1, cab: boolean): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const u0 = cab ? 0 : 0.5;
  const fy = (y: number) => ((y - 0.6) / 3.1) * 0.5;
  // Cross-section outline (half widths by height), and the rake: the face leans back above 1.95 m.
  const rows: [number, number, number][] = cab
    ? [
        [0.6, 1.15, 0.25],
        [1.05, 1.2, 0.2],
        [1.95, 1.22, 0.12],
        [3.2, 1.1, -0.12],
        [3.55, 0.95, -0.25],
        [3.66, 0.0, -0.3],
      ]
    : [
        [0.95, 1.2, 0],
        [3.45, 1.19, 0],
        [3.66, 0.0, 0],
      ];
  for (let i = 0; i < rows.length - 1; i++) {
    const [ya, wa, ra] = rows[i];
    const [yb, wb, rb] = rows[i + 1];
    const xa = x + dir * ra;
    const xb = x + dir * rb;
    const ua = (zz: number, w: number) => u0 + (0.5 * (zz / Math.max(w, 1e-3) + 1)) / 2;
    const L = [xa, ya, -wa];
    const Rr = [xa, ya, wa];
    const Lb = [xb, yb, -wb];
    const Rb = [xb, yb, wb];
    // Face toward +x·dir: order so the normal points along dir.
    const tri = (p: number[][], t: number[][]) => {
      const a = new Vector3(...(p[0] as [number, number, number]));
      const b = new Vector3(...(p[1] as [number, number, number]));
      const c = new Vector3(...(p[2] as [number, number, number]));
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      const ok = n.x * dir >= 0;
      const order = ok ? [0, 1, 2] : [0, 2, 1];
      for (const k of order) {
        pos.push(...p[k]);
        uv.push(...t[k]);
      }
    };
    tri([L, Rr, Rb], [[ua(-wa, wa), fy(ya)], [ua(wa, wa), fy(ya)], [ua(wb, Math.max(wb, 1e-3)), fy(yb)]]);
    tri([L, Rb, Lb], [[ua(-wa, wa), fy(ya)], [ua(wb, Math.max(wb, 1e-3)), fy(yb)], [ua(-wb, Math.max(wb, 1e-3)), fy(yb)]]);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Bogie: frame, two axles' wheels, under body station x. */
function bogie(x: number, out: BufferGeometry[]): void {
  const frame = new BoxGeometry(2.2, 0.32, 2.0);
  frame.translate(x, 0.62, 0);
  out.push(frame);
  for (const ax of [-0.9, 0.9])
    for (const s of [-1, 1]) {
      const w = new CylinderGeometry(0.33, 0.33, 0.12, 10);
      w.rotateX(Math.PI / 2);
      w.translate(x + ax, 0.33, s * 0.6);
      out.push(w);
    }
}

/** Single-arm pantograph raised to the contact wire (5.0 m above the rail). */
function pantograph(x: number, out: BufferGeometry[]): void {
  const base = new BoxGeometry(1.2, 0.12, 1.0);
  base.translate(x, ROOF + 0.1, 0);
  out.push(base);
  const knee = new Vector3(x - 0.75, ROOF + 0.85, 0);
  const foot = new Vector3(x + 0.3, ROOF + 0.18, 0);
  const head = new Vector3(x - 0.05, 4.92, 0);
  for (const [a, b] of [
    [foot, knee],
    [knee, head],
  ] as [Vector3, Vector3][])
    for (const s of [-0.18, 0.18]) out.push(rod(a.clone().setZ(s), b.clone().setZ(s), 0.025, 5));
  const pan = new BoxGeometry(0.25, 0.05, 1.6);
  pan.translate(head.x, head.y, 0);
  out.push(pan);
}

export function buildTrain(w: KamakuraWorld, _crossing: CrossingState): void {
  const lib = w.lib;
  const liveryTex = enodenLivery();
  const livery = lib.printed("enoden", liveryTex, 0.45);
  const head = lib.glow(0xfff0d8, 6);
  const tail = lib.glow(0xff2010, 3);
  const holder = w.group();
  holder.name = "enoden";
  holder.userData.dynamic = true;

  const bodies: Group[] = [];
  /** Sets every UV of a part to one flat patch of the livery texture. */
  const patch = (g: BufferGeometry, u: number, v: number): BufferGeometry => {
    const n = g.getAttribute("position").count;
    g.setAttribute("uv", new Float32BufferAttribute(new Float32Array(n * 2).map((_, i) => (i % 2 ? v : u)), 2));
    return g;
  };
  const ROOF_UV: [number, number] = [0.971, 0.43];
  const DARK_UV: [number, number] = [0.971, 0.373];
  for (let k = 0; k < 4; k++) {
    const g = new Group();
    g.name = `enoden-car-${k}`;
    holder.add(g);
    bodies.push(g);
    // One mesh per body (livery, roof and running gear in one texture): one draw on the handheld.
    const parts: BufferGeometry[] = [];
    const sh = shell(BODY);
    parts.push(sh.sides, patch(sh.roof, ...ROOF_UV));
    // Nose at local +x for the leading body, tail cab at −x for the last.
    const front = k === 0;
    const rear = k === 3;
    parts.push(endWall(BODY / 2, 1, front), endWall(-BODY / 2, -1, rear));
    const under: BufferGeometry[] = [];
    const eq = new BoxGeometry(BODY - 4.2, 0.42, 2.1);
    eq.translate(0, 0.72, 0);
    under.push(eq);
    bogie(BODY / 2 - 1.3, under);
    bogie(-BODY / 2 + 1.3, under);
    if (k === 1 || k === 3) pantograph(-BODY / 2 + 2.6, under);
    for (const u of under) parts.push(patch(u, ...DARK_UV));
    // Roof equipment: the air-conditioning shroud.
    const ac = new BoxGeometry(3.2, 0.32, 1.6);
    ac.translate(BODY * 0.12, ROOF + 0.14, 0);
    parts.push(patch(ac, ...ROOF_UV));
    w.mesh(merge(parts), livery, 0, 0, 0, g);
    const lamps = (x: number, dir: number, mat: Material) => {
      const l: BufferGeometry[] = [];
      for (const s of [-0.85, 0.85]) {
        const c = new CylinderGeometry(0.1, 0.1, 0.04, 10);
        c.rotateZ(Math.PI / 2);
        c.translate(x + dir * 0.24, 1.45, s);
        l.push(c);
      }
      w.mesh(merge(l), mat, 0, 0, 0, g, { cast: false });
    };
    if (front) lamps(BODY / 2, 1, head);
    if (rear) lamps(-BODY / 2, -1, tail);
  }

  const a = new Vector3();
  const b = new Vector3();
  w.update((_dt, t) => {
    const f = trainFront(t);
    for (let k = 0; k < 4; k++) {
      // Westbound: the nose is at the smallest u; body k spans [u0, u0 + BODY] behind it.
      const u0 = f.u + k * (BODY + GAP);
      TRACK.point(u0, a);
      TRACK.point(u0 + BODY, b);
      const g = bodies[k];
      g.position.set((a.x + b.x) / 2, f.y, (a.z + b.z) / 2);
      // Local +x toward the nose (from b to a).
      g.rotation.y = Math.atan2(-(a.z - b.z), a.x - b.x);
    }
  });
}
