import { BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Vector2, Vector3 } from "three";
import { glassMaterial } from "../../shared/glass";
import { merge, rod } from "../../shared/shapes";
import { ENO, enoden500Maps, faceUV, halfWidth, PROFILE, PROFILE_S, rectUV, SIDE, solidUV, stripUV, WINDSCREEN, type CabKind, type RectName, type SolidName } from "../gfx/livery";
import type { KamakuraWorld } from "./context";
import { CATENARY, LOOP, TRACK } from "./layout";
import { APPROACH, ARRIVE, RUN, T0, trainFront } from "./timeline";

/**
 * One Enoden train per loop: a 500-type set of two articulated two-car
 * units (502 + 552, 501 + 551; 4 × 12.45 m bodies, 50.8 m), green and cream,
 * Fujisawa-bound. It rounds the bend from Shichirigahama behind the houses
 * at 45 km/h, eases to 30 km/h through the crossing (left to right in the
 * canonical view) and brakes for the platform 107 m on, where it stops out
 * of every shot.
 *
 * Each body is a moving node whose ends sit on the track centreline, so the
 * set follows the curve. A body is two meshes (two draws on the handheld):
 * the painted shell with its running gear and roof equipment in one
 * atlas-mapped material, and the window glass (glass kind) over the saloon
 * painted behind it. Nothing on the train casts into the sun's shadow map,
 * which renders once for the static scene.
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

const { L, W, RC, BOW, BOT, TOP, RAKE, JOINT, NOSES } = ENO;
/** Where the flat side meets the cab corner (local x). */
const XS = L / 2 - RC - BOW;
/** Top of the pantograph's contact strips: the contact wire (world/wires.ts strings it at this height). */
const WIRE = CATENARY.contact;
const WHEEL_R = 0.33;

type V3 = [number, number, number];

// ------------------------------------------------------------ helpers

/**
 * Indexed grid of rows × cols points, wound so its faces point along
 * `outward` (checked over the whole grid), with smooth normals.
 */
function grid(rows: number, cols: number, pos: (i: number, j: number) => V3, uv: (i: number, j: number) => [number, number], outward: (p: Vector3) => Vector3): BufferGeometry {
  const P: number[] = [];
  const U: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      P.push(...pos(i, j));
      U.push(...uv(i, j));
    }
  for (let i = 0; i < rows - 1; i++)
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      idx.push(a, a + 1, a + cols + 1, a, a + cols + 1, a + cols);
    }
  let score = 0;
  const A = new Vector3();
  const B = new Vector3();
  const C = new Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    A.fromArray(P, idx[t] * 3);
    B.fromArray(P, idx[t + 1] * 3);
    C.fromArray(P, idx[t + 2] * 3);
    const n = B.clone().sub(A).cross(C.clone().sub(A));
    const c = A.clone().add(B).add(C).multiplyScalar(1 / 3);
    score += n.dot(outward(c));
  }
  if (score < 0) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(P, 3));
  g.setAttribute("uv", new Float32BufferAttribute(U, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Every UV of `g` at one point (a flat colour cell). */
function solid(g: BufferGeometry, name: SolidName): BufferGeometry {
  const [u, v] = solidUV(name);
  const n = g.getAttribute("position").count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    a[i * 2] = u;
    a[i * 2 + 1] = v;
  }
  g.setAttribute("uv", new Float32BufferAttribute(a, 2));
  return g;
}

/** Remaps a primitive's 0..1 UVs into a named atlas panel. */
function panel(g: BufferGeometry, name: RectName): BufferGeometry {
  const uv = g.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) {
    const [u, v] = rectUV(name, uv.getX(i), uv.getY(i));
    uv.setXY(i, u, v);
  }
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Cylinder along z (wheels, axles). */
function cylZ(r: number, len: number, seg: number, x: number, y: number, z: number): BufferGeometry {
  const g = new CylinderGeometry(r, r, len, seg);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** Quad from four corners (counter-clockwise seen from the front) with given UVs. */
function quad(p: V3[], uv: [number, number][]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3]], 3));
  g.setAttribute("uv", new Float32BufferAttribute([...uv[0], ...uv[1], ...uv[2], ...uv[0], ...uv[2], ...uv[3]], 2));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- shell

/** Row of the cab front at height y: half width, depth ahead of XS, corner radius, bow. */
function cabRow(y: number): { hw: number; dp: number; r: number; bow: number } {
  const hw = halfWidth(y);
  const ws = WINDSCREEN;
  const rake = y <= ws.y0 ? 0 : RAKE * Math.min(1, (y - ws.y0) / (ws.y1 - ws.y0));
  let dp = RC - rake;
  if (y > 3.05) dp *= Math.sqrt(Math.max(0, 1 - ((y - 3.05) / (TOP - 3.05)) ** 2));
  const r = Math.max(0, Math.min(RC, dp, hw));
  return { hw, dp, r, bow: BOW * (dp / RC) };
}

/** x of the cab surface at (y, z) for |z| ≤ half width. */
function frontX(y: number, z: number): number {
  const { hw, dp, r, bow } = cabRow(y);
  const half = hw - r;
  const az = Math.abs(z);
  if (az <= half) return XS + dp + (half > 1e-4 ? bow * (1 - (z / half) ** 2) : 0);
  const dz = Math.min(r, az - half);
  return XS + dp - r + Math.sqrt(Math.max(0, r * r - dz * dz));
}

const CAB_ROWS = [0.8, 0.92, 1.05, 1.3, 1.6, 1.86, 2.2, 2.55, 2.93, 3.05, 3.22, 3.36, 3.47, 3.56, 3.63, 3.675, 3.7];
const FACE_T = [0.66, 0.33, 0, -0.33, -0.66];
const ARC = [0, 0.25, 0.5, 0.75, 1].map((k) => (k * Math.PI) / 2);

/** Cab front point at row y, column j (arc on +z, face, arc on −z). */
function cabPoint(y: number, j: number): V3 {
  const { hw, dp, r, bow } = cabRow(y);
  const half = hw - r;
  if (j < 5) {
    const f = ARC[j];
    return [XS + dp - r + r * Math.sin(f), y, half + r * Math.cos(f)];
  }
  if (j < 10) {
    const t = FACE_T[j - 5];
    return [XS + dp + bow * (1 - t * t), y, half * t];
  }
  const f = ARC[14 - j];
  return [XS + dp - r + r * Math.sin(f), y, -(half + r * Math.cos(f))];
}

/** Body shell of one car in its own frame (cab at +x): sides and roof, cab front, articulated end, floor. */
function shell(kind: CabKind, num: CarSpec["num"]): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const axis = (p: Vector3) => new Vector3(0, p.y - 2.2, p.z);
  // Sides and roof: the profile from the −z skirt over the roof to the +z skirt, along x.
  const Q: [number, number, number][] = [];
  for (let i = 0; i < PROFILE.length; i++) Q.push([PROFILE[i][0], -PROFILE[i][1], PROFILE_S[i]]);
  for (let i = PROFILE.length - 2; i >= 0; i--) Q.push([PROFILE[i][0], PROFILE[i][1], PROFILE_S[i]]);
  const xs = [-L / 2, -L / 2 + 2.2, -1.6, 1.6, XS - 2.0, XS];
  out.push(
    grid(
      Q.length,
      xs.length,
      (i, j) => [xs[j], Q[i][0], Q[i][1]],
      (i, j) => stripUV(XS - xs[j], Q[i][2]),
      axis,
    ),
  );
  // Cab front: rows by height, columns around the rounded corners and across the bowed face.
  out.push(
    grid(
      CAB_ROWS.length,
      15,
      (i, j) => cabPoint(CAB_ROWS[i], j),
      (i, j) => {
        const p = cabPoint(CAB_ROWS[i], j);
        return faceUV(kind, p[2], p[1]);
      },
      (p) => new Vector3(p.x - (XS - 1.5), p.y - 2.2, p.z),
    ),
  );
  // Articulated end: a flat cap over the profile.
  {
    const pos: number[] = [];
    const uv: number[] = [];
    const c: V3 = [-L / 2, 2.2, 0];
    for (let i = 0; i < Q.length - 1; i++) {
      for (const p of [c, [-L / 2, Q[i + 1][0], Q[i + 1][1]] as V3, [-L / 2, Q[i][0], Q[i][1]] as V3]) {
        pos.push(...p);
        uv.push(...faceUV("end", -p[2], p[1]));
      }
    }
    const end = new BufferGeometry();
    end.setAttribute("position", new Float32BufferAttribute(pos, 3));
    end.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    end.computeVertexNormals();
    out.push(end);
  }
  // Floor: the underside from the articulated end to the cab front's bottom edge.
  {
    const ring: V3[] = [[-L / 2, BOT, -halfWidth(BOT)]];
    for (let j = 14; j >= 0; j--) ring.push(cabPoint(BOT, j));
    ring.push([-L / 2, BOT, halfWidth(BOT)]);
    const pos: number[] = [];
    const c: V3 = [0, BOT, 0];
    for (let i = 0; i < ring.length; i++) pos.push(...c, ...ring[i], ...ring[(i + 1) % ring.length]);
    const floor = new BufferGeometry();
    floor.setAttribute("position", new Float32BufferAttribute(pos, 3));
    floor.computeVertexNormals();
    // Wound to face down.
    if (floor.getAttribute("normal").getY(0) > 0) {
      for (let t = 0; t < pos.length; t += 9) for (let k = 0; k < 3; k++) [pos[t + 3 + k], pos[t + 6 + k]] = [pos[t + 6 + k], pos[t + 3 + k]];
      floor.setAttribute("position", new Float32BufferAttribute(pos, 3));
      floor.computeVertexNormals();
    }
    out.push(solid(floor, "dark"));
  }
  // Side emblems and car numbers behind the cab corner (decals 5 mm off the skin, reading forward on both sides).
  const decals: [RectName, readonly [number, number], readonly [number, number]][] = [
    ["emblem", SIDE.emblem, SIDE.emblemY],
    [`num${num}`, SIDE.number, SIDE.numberY],
  ];
  for (const [cell, [d0, d1], [y0, y1]] of decals)
  for (const s of [1, -1]) {
    const z = s * (halfWidth((y0 + y1) / 2) + 0.005);
    const xa = XS - d1;
    const xb = XS - d0;
    const uvs: [number, number][] = s > 0 ? [rectUV(cell, 0, 0), rectUV(cell, 1, 0), rectUV(cell, 1, 1), rectUV(cell, 0, 1)] : [rectUV(cell, 1, 0), rectUV(cell, 0, 0), rectUV(cell, 0, 1), rectUV(cell, 1, 1)];
    const p: V3[] = [
      [xa, y0, z],
      [xb, y0, z],
      [xb, y1, z],
      [xa, y1, z],
    ];
    const g = s > 0 ? quad(p, uvs) : quad([p[1], p[0], p[3], p[2]], [uvs[1], uvs[0], uvs[3], uvs[2]]);
    out.push(g);
  }
  return out;
}

/** Window glass of one car: side windows, door windows and the windscreen (1.2 cm proud of the skin). */
function glazing(): BufferGeometry {
  const out: BufferGeometry[] = [];
  const zero: [number, number][] = [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  const pane = (d0: number, d1: number, y0: number, y1: number) => {
    for (const s of [1, -1]) {
      const z = s * (W + 0.012);
      const a = XS - d1 + 0.015;
      const b = XS - d0 - 0.015;
      const p: V3[] = [
        [a, y0 + 0.015, z],
        [b, y0 + 0.015, z],
        [b, y1 - 0.015, z],
        [a, y1 - 0.015, z],
      ];
      out.push(s > 0 ? quad(p, zero) : quad([p[1], p[0], p[3], p[2]], zero));
    }
  };
  for (const [a, b] of SIDE.windows) pane(a, b, SIDE.winY[0], SIDE.winY[1]);
  for (const [a] of SIDE.doors) pane(a + SIDE.doorWin[0], a + SIDE.doorWin[1], SIDE.doorWinY[0], SIDE.doorWinY[1]);
  const ws = WINDSCREEN;
  const zs = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1].map((k) => k * (ws.z - 0.03));
  const ys = [ws.y0 + 0.03, (ws.y0 + ws.y1) / 2, ws.y1 - 0.03];
  out.push(
    grid(
      ys.length,
      zs.length,
      (i, j) => [frontX(ys[i], zs[j]) + 0.012, ys[i], zs[j]],
      () => [0, 0],
      () => new Vector3(1, 0, 0),
    ),
  );
  return merge(out);
}

// --------------------------------------------------------- running gear

/** Bogie centred at local x: wheels, outside frames, axle boxes and coil springs, bolster, motor. */
function bogie(x: number, out: BufferGeometry[]): void {
  const wb = 1.9;
  for (const ax of [-wb / 2, wb / 2]) {
    for (const s of [-1, 1]) {
      out.push(solid(cylZ(WHEEL_R, 0.13, 14, x + ax, WHEEL_R, s * 0.6), "steel"));
      out.push(solid(cylZ(WHEEL_R * 0.72, 0.02, 10, x + ax, WHEEL_R, s * 0.675), "bogie"));
      out.push(panel(box(0.3, 0.2, 0.16, x + ax, WHEEL_R + 0.02, s * 0.84), "bogie"));
      out.push(solid(new CylinderGeometry(0.075, 0.075, 0.2, 6).translate(x + ax + (ax > 0 ? -0.22 : 0.22), WHEEL_R + 0.22, s * 0.84), "dark"));
    }
    out.push(solid(cylZ(0.08, 1.15, 6, x + ax, WHEEL_R, 0), "bogie"));
  }
  for (const s of [-1, 1]) {
    out.push(panel(box(wb + 0.75, 0.24, 0.12, x, 0.58, s * 0.86), "bogie"));
    out.push(panel(box(wb * 0.55, 0.14, 0.12, x, 0.42, s * 0.86), "bogie"));
  }
  out.push(panel(box(0.42, 0.2, 1.75, x, 0.68, 0), "bogie"));
  out.push(panel(box(0.8, 0.34, 0.9, x, 0.4, 0.15), "under"));
}

/** Underfloor equipment between the bogies (control, compressor, batteries). */
function underframe(out: BufferGeometry[]): void {
  const boxes: [number, number, number, number, number][] = [
    // x centre, length, height, depth, z
    [-2.6, 1.8, 0.42, 1.7, 0.05],
    [-0.4, 1.4, 0.36, 1.2, -0.25],
    [1.3, 1.1, 0.46, 1.8, 0],
    [2.9, 0.9, 0.3, 0.9, 0.35],
  ];
  for (const [x, l, h, d, z] of boxes) out.push(panel(box(l, h, d, x, BOT - h / 2 - 0.02, z), "under"));
  // Cable trays along both sides.
  for (const s of [-1, 1]) out.push(solid(box(L - 5.5, 0.06, 0.08, -0.5, BOT - 0.05, s * 1.0), "black"));
}

/** Silver skirt under the cab front with the opening for the coupler, and the coupler. */
function skirt(out: BufferGeometry[]): void {
  const y0 = 0.2;
  const y1 = BOT + 0.04;
  // Plan contour of one half (from the side, around the corner, to the coupler opening).
  const half: [number, number][] = [];
  half.push([XS - 0.55, W - 0.08]);
  const r = 0.32;
  for (let k = 0; k <= 4; k++) {
    const f = (k / 4) * (Math.PI / 2);
    half.push([XS + RC - 0.06 - r + r * Math.sin(f), W - 0.08 - r + r * Math.cos(f)]);
  }
  half.push([XS + RC + 0.0, 0.42]);
  for (const s of [1, -1]) {
    const pts = half.map(([x, z]) => [x, s * z] as [number, number]);
    const pos: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const a0: V3 = [ax, y0, az];
      const b0: V3 = [bx, y0, bz];
      const b1: V3 = [bx, y1, bz];
      const a1: V3 = [ax, y1, az];
      // Both faces (the inside shows through the coupler opening).
      pos.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
      pos.push(...a0, ...b1, ...b0, ...a0, ...a1, ...b1);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    out.push(solid(g, "silver"));
    // Lower lip of the skirt.
    out.push(solid(box(0.5, 0.06, 0.5, XS + RC - 0.25, y0 + 0.03, s * 0.75), "silver"));
  }
  // Coupler: draw gear, shank and the tight-lock head.
  out.push(solid(box(0.7, 0.18, 0.22, XS + RC - 0.15, 0.55, 0), "dark"));
  out.push(solid(box(0.28, 0.26, 0.36, XS + RC + 0.2, 0.55, 0), "bogie"));
  out.push(solid(box(0.12, 0.08, 0.5, XS + RC + 0.05, 0.36, 0), "black"));
}

// ------------------------------------------------------------------ roof

/** Air-conditioner housing: sloped sides, louvred top. */
function airCon(x: number, out: BufferGeometry[]): void {
  const l = 4.1;
  const w = 1.86;
  const h = 0.34;
  // Base where the roof curve is 0.93 m off the centreline.
  const y0 = 3.57;
  const inset = 0.12;
  const b: V3[] = [
    [x - l / 2, y0, -w / 2],
    [x + l / 2, y0, -w / 2],
    [x + l / 2, y0, w / 2],
    [x - l / 2, y0, w / 2],
  ];
  const t: V3[] = [
    [x - l / 2 + inset, y0 + h, -w / 2 + inset],
    [x + l / 2 - inset, y0 + h, -w / 2 + inset],
    [x + l / 2 - inset, y0 + h, w / 2 - inset],
    [x - l / 2 + inset, y0 + h, w / 2 - inset],
  ];
  out.push(quad([t[3], t[2], t[1], t[0]], [rectUV("acTop", 0, 1), rectUV("acTop", 1, 1), rectUV("acTop", 1, 0), rectUV("acTop", 0, 0)]));
  for (let k = 0; k < 4; k++) {
    const a = b[k];
    const c = b[(k + 1) % 4];
    const ta = t[k];
    const tc = t[(k + 1) % 4];
    out.push(quad([a, c, tc, ta], [rectUV("acSide", 0, 0), rectUV("acSide", 1, 0), rectUV("acSide", 1, 1), rectUV("acSide", 0, 1)]));
  }
}

/** Single-arm pantograph raised to the contact wire, on four insulators. */
function pantograph(x: number, out: BufferGeometry[]): void {
  const y0 = TOP - 0.02;
  for (const dx of [-0.55, 0.55])
    for (const dz of [-0.42, 0.42]) out.push(solid(new CylinderGeometry(0.05, 0.065, 0.2, 6).translate(x + dx, y0 + 0.1, dz), "insulator"));
  const by = y0 + 0.22;
  for (const dz of [-0.42, 0.42]) out.push(solid(rod(new Vector3(x - 0.62, by, dz), new Vector3(x + 0.62, by, dz), 0.035, 4), "dark"));
  for (const dx of [-0.6, 0.6]) out.push(solid(rod(new Vector3(x + dx, by, -0.44), new Vector3(x + dx, by, 0.44), 0.035, 4), "dark"));
  const hinge = new Vector3(x + 0.45, by + 0.05, 0);
  const knee = new Vector3(x - 0.9, by + 0.62, 0);
  const head = new Vector3(x - 0.02, WIRE - 0.06, 0);
  for (const dz of [-0.24, 0.24]) out.push(solid(rod(hinge.clone().setZ(dz), knee.clone().setZ(dz * 0.15), 0.035, 5), "silver"));
  for (const dz of [-0.16, 0.16]) out.push(solid(rod(knee.clone().setZ(dz * 0.2), head.clone().setZ(dz), 0.022, 5), "silver"));
  out.push(solid(rod(new Vector3(x + 0.2, by + 0.04, 0), knee.clone().add(new Vector3(0.25, -0.05, 0)), 0.012, 4), "dark"));
  // Collector head: two carbon strips with bent horns.
  for (const dx of [-0.12, 0.12]) {
    out.push(solid(box(0.06, 0.05, 1.24, head.x + dx, WIRE - 0.025, 0), "copper"));
    for (const s of [-1, 1]) out.push(solid(rod(new Vector3(head.x + dx, WIRE - 0.03, s * 0.62), new Vector3(head.x + dx, WIRE - 0.16, s * 0.86), 0.018, 4), "silver"));
  }
  out.push(solid(rod(new Vector3(head.x - 0.12, WIRE - 0.07, 0), new Vector3(head.x + 0.12, WIRE - 0.07, 0), 0.02, 4), "silver"));
  for (const dz of [-0.16, 0.16]) out.push(solid(rod(head.clone().setZ(dz), new Vector3(head.x, WIRE - 0.05, dz * 2.5), 0.015, 4), "silver"));
}

/** Roof conduits and the small boxes beside the pantograph. */
function roofKit(withPan: boolean, out: BufferGeometry[]): void {
  for (const s of [-1, 1]) {
    const z = s * 0.66;
    const y = TOP - 0.02;
    out.push(solid(rod(new Vector3(withPan ? XS - 3.4 : XS - 1.2, y, z), new Vector3(-L / 2 + 0.6, y - 0.02, z), 0.03, 4), "dark"));
  }
  if (withPan) {
    out.push(solid(box(0.5, 0.18, 0.4, XS - 3.5, TOP + 0.06, 0.55), "acGrey"));
    out.push(solid(new CylinderGeometry(0.05, 0.05, 0.3, 6).translate(XS - 3.6, TOP + 0.15, -0.5), "insulator"));
  }
  // Radio antenna above the cab.
  out.push(solid(box(0.3, 0.06, 0.12, XS - 0.4, TOP + 0.01, -0.3), "dark"));
  out.push(solid(rod(new Vector3(XS - 0.45, TOP + 0.04, -0.3), new Vector3(XS - 0.5, TOP + 0.32, -0.3), 0.012, 3), "black"));
}

/** Bellows between the two bodies of a unit (hung on the leading body's articulated end). */
function bellows(out: BufferGeometry[]): void {
  const x0 = -L / 2 - JOINT - 0.02;
  const x1 = -L / 2 + 0.02;
  // Full-width rubber diaphragm: the joint reads as a dark gap, as on the real units.
  const g = new BoxGeometry(x1 - x0, 2.5, 2.38);
  g.translate((x0 + x1) / 2, 2.15, 0);
  out.push(panel(g, "bellows"));
}

// ------------------------------------------------------------------ build

interface CarSpec {
  kind: CabKind;
  num: "502" | "552" | "501" | "551";
  /** Cab toward −x (trailing car of a unit). */
  flipped: boolean;
  pan: boolean;
  /** Carries the shared articulation bogie and the bellows. */
  joint: boolean;
}

const CARS: CarSpec[] = [
  { kind: "lead", num: "502", flipped: false, pan: true, joint: true },
  { kind: "coupledA", num: "552", flipped: true, pan: false, joint: false },
  { kind: "coupledB", num: "501", flipped: false, pan: true, joint: true },
  { kind: "tail", num: "551", flipped: true, pan: false, joint: false },
];

/** Front of each body measured back from the train's nose (m). */
const OFFSETS = [0, L + JOINT, 2 * L + JOINT + NOSES, 3 * L + 2 * JOINT + NOSES];

function carBody(spec: CarSpec): { body: BufferGeometry; glass: BufferGeometry } {
  const parts: BufferGeometry[] = [...shell(spec.kind, spec.num)];
  bogie(XS + RC - 2.0, parts);
  if (spec.joint) bogie(-L / 2 - JOINT / 2, parts);
  underframe(parts);
  skirt(parts);
  airCon(spec.pan ? -1.9 : -0.6, parts);
  if (spec.pan) pantograph(XS - 2.0, parts);
  roofKit(spec.pan, parts);
  if (spec.joint) bellows(parts);
  const body = merge(parts);
  const glass = glazing();
  if (spec.flipped) {
    body.rotateY(Math.PI);
    glass.rotateY(Math.PI);
  }
  return { body, glass };
}

export function buildTrain(w: KamakuraWorld): void {
  const maps = enoden500Maps();
  const paint = new MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normal,
    normalScale: new Vector2(0.7, 0.7),
    roughnessMap: maps.orm,
    metalnessMap: maps.orm,
    roughness: 1,
    metalness: 1,
    emissiveMap: maps.emissive,
    emissive: 0xffffff,
    emissiveIntensity: 6,
    envMapIntensity: 1.0,
  });
  paint.name = "enoden-500";
  const glass = glassMaterial({ color: 0x0b1115, roughness: 0.04, metalness: 0, opacity: 0.36, envMapIntensity: 1.3 });
  glass.name = "enoden-glass";

  const holder = w.group();
  holder.name = "enoden";
  holder.userData.dynamic = true;
  const bodies: Group[] = [];
  CARS.forEach((spec, k) => {
    const g = new Group();
    g.name = `enoden-car-${k}`;
    holder.add(g);
    bodies.push(g);
    const { body, glass: pane } = carBody(spec);
    w.mesh(body, paint, 0, 0, 0, g, { cast: false });
    const gm = w.mesh(pane, glass, 0, 0, 0, g, { cast: false, receive: false });
    gm.renderOrder = 2;
  });

  const a = new Vector3();
  const b = new Vector3();
  w.update((_dt, t) => {
    const f = trainFront(t);
    for (let k = 0; k < 4; k++) {
      // Westbound: the nose is at the smallest u; body k spans [u0, u0 + L] behind it.
      const u0 = f.u + OFFSETS[k];
      TRACK.point(u0, a);
      TRACK.point(u0 + L, b);
      const g = bodies[k];
      g.position.set((a.x + b.x) / 2, f.y, (a.z + b.z) / 2);
      // Local +x toward the nose (from b to a).
      g.rotation.y = Math.atan2(-(a.z - b.z), a.x - b.x);
    }
  });
}
