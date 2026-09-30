import { Bone, BoxGeometry, Color, Euler, Float32BufferAttribute, Group, Matrix4, Quaternion, Skeleton, SkinnedMesh, Sphere, Vector3, type BufferGeometry, type Texture } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { flip } from "../props/util";
import { chain, gauss, grid, loft, shell, skin, smooth, type Influence, type Sec, type SkinFn } from "./shape";
import type { Wear } from "./wear";

/*
 * A procedural adult: one skeleton, one skinned mesh per material. Rest pose
 * stands facing +z with the arms slightly away from the body; the figure's
 * left is +x. Limb bones rest with identity rotation, so a pose is a set of
 * local rotations plus two-bone IK for hands and feet.
 */

/** Bone indices (skinIndex values). */
export const B = {
  hips: 0,
  spine: 1,
  chest: 2,
  neck: 3,
  head: 4,
  upperL: 5,
  foreL: 6,
  handL: 7,
  upperR: 8,
  foreR: 9,
  handR: 10,
  thighL: 11,
  shinL: 12,
  footL: 13,
  thighR: 14,
  shinR: 15,
  footR: 16,
} as const;

// Torso sections for a 1.72 m man: y, half-width, front, back, exponent,
// female width factor, female front offset, section z.
const TORSO: [number, number, number, number, number, number, number, number][] = [
  [0.79, 0.07, 0.05, 0.06, 2.2, 1.05, 0, 0],
  [0.82, 0.125, 0.08, 0.092, 2.4, 1.08, 0, 0],
  [0.87, 0.16, 0.092, 0.108, 2.5, 1.1, 0.004, 0],
  [0.93, 0.166, 0.09, 0.106, 2.5, 1.08, 0.004, 0],
  [0.99, 0.158, 0.086, 0.094, 2.4, 1.02, 0, 0],
  [1.05, 0.146, 0.084, 0.086, 2.3, 0.9, -0.006, 0],
  [1.12, 0.146, 0.088, 0.086, 2.3, 0.88, -0.006, 0],
  [1.19, 0.152, 0.098, 0.09, 2.3, 0.88, 0.006, 0],
  [1.26, 0.16, 0.108, 0.095, 2.4, 0.9, 0.016, 0],
  [1.31, 0.168, 0.108, 0.098, 2.5, 0.9, 0.006, 0],
  [1.345, 0.182, 0.1, 0.097, 2.4, 0.9, -0.002, -0.002],
  [1.375, 0.19, 0.09, 0.092, 2.3, 0.9, -0.006, -0.004],
  [1.402, 0.178, 0.078, 0.084, 2.4, 0.9, -0.006, -0.006],
  [1.428, 0.145, 0.066, 0.075, 2.5, 0.9, -0.004, -0.01],
  [1.452, 0.104, 0.055, 0.065, 2.4, 0.9, -0.002, -0.015],
  [1.47, 0.066, 0.045, 0.056, 2.2, 0.9, 0, -0.018],
];
// Leg sections below the hip joint: y, half-width, front, back.
const LEG: [number, number, number, number][] = [
  [0.87, 0.082, 0.082, 0.094],
  [0.8, 0.08, 0.08, 0.084],
  [0.7, 0.071, 0.072, 0.07],
  [0.6, 0.061, 0.062, 0.06],
  [0.51, 0.053, 0.056, 0.052],
  [0.45, 0.05, 0.052, 0.054],
  [0.36, 0.049, 0.047, 0.058],
  [0.25, 0.043, 0.042, 0.047],
  [0.15, 0.037, 0.038, 0.04],
  [0.09, 0.036, 0.042, 0.04],
];
// Arm sections down from the shoulder joint: distance, half-width, front, back.
const ARM: [number, number, number, number][] = [
  [-0.032, 0.012, 0.012, 0.012],
  [-0.022, 0.034, 0.036, 0.036],
  [0.0, 0.047, 0.05, 0.05],
  [0.04, 0.052, 0.054, 0.052],
  [0.1, 0.048, 0.051, 0.047],
  [0.18, 0.043, 0.046, 0.042],
  [0.27, 0.04, 0.041, 0.041],
  [0.31, 0.041, 0.042, 0.043],
  [0.38, 0.041, 0.04, 0.041],
  [0.47, 0.035, 0.034, 0.034],
];
// Hand sections down from the wrist: distance, thickness, front, back, z.
const HAND: [number, number, number, number, number][] = [
  [-0.012, 0.018, 0.022, 0.022, 0],
  [0.02, 0.02, 0.029, 0.028, 0.002],
  [0.058, 0.019, 0.038, 0.034, 0.004],
  [0.09, 0.017, 0.041, 0.035, 0.004],
  [0.118, 0.015, 0.038, 0.031, 0.004],
  [0.145, 0.013, 0.032, 0.026, 0.003],
  [0.166, 0.01, 0.023, 0.018, 0.001],
  [0.176, 0.004, 0.01, 0.008, 0],
];
// Shoe sections heel to toe: z from the ankle, half-width, top height.
const SHOE: [number, number, number][] = [
  [-0.079, 0.02, 0.034],
  [-0.073, 0.035, 0.074],
  [-0.05, 0.042, 0.096],
  [-0.015, 0.045, 0.102],
  [0.03, 0.048, 0.084],
  [0.08, 0.05, 0.064],
  [0.13, 0.049, 0.05],
  [0.17, 0.043, 0.042],
  [0.195, 0.029, 0.033],
  [0.207, 0.011, 0.02],
];

/**
 * Surface of one garment or body part: sRGB colour, roughness and (indoors)
 * how strongly it carries the shop light. Plain paints become vertex colours
 * on a shared per-roughness material, so a figure costs one draw call per
 * roughness class rather than one per garment; mapped paints (stripes) get
 * their own material.
 */
export interface Paint {
  hex: number;
  rough: number;
  lit?: number;
  map?: Texture;
}

export interface Look {
  skin: Paint;
  hair: Paint;
  top: Paint;
  bottom: Paint;
  shoes: Paint;
  shirt?: Paint;
  tie?: Paint;
  apron?: Paint;
  badge?: Paint;
  mask?: Paint;
  cap?: Paint;
  scarf?: Paint;
}

/** Roughness classes shared by all figures (paints snap to the nearest). */
const ROUGH = [0.3, 0.55, 0.75];
const LIT = 0.8;

export interface Build {
  height: number;
  fem?: number;
  hair: "short" | "bob";
  /** Outer layer: thickness, hem height (1.72 m scale), flare per meter below the hips, cuff overhang. */
  top: { t: number; hem: number; flare?: number; cuff?: number; hood?: boolean; vneck?: boolean };
  legs?: { loose?: number; tights?: boolean };
  shoe?: "shoe" | "sneaker" | "boot";
  cast?: boolean;
}

export interface Dims {
  s: number;
  hs: number;
  fem: number;
  height: number;
  hips: Vector3;
  shoulder: Vector3;
  hipJ: Vector3;
  upper: number;
  fore: number;
  thigh: number;
  shin: number;
  abd: number;
  headC: Vector3;
  headR: { w: number; h: number; f: number; b: number };
  torso: Sec[];
}

export interface Limb {
  upper: Bone;
  lower: Bone;
  end: Bone;
  a: number;
  b: number;
  /** Limb direction at rest (parent frame). */
  rest: Vector3;
  /** Axis (rest frame) about which a positive angle bends the lower bone. */
  flex: Vector3;
  sign: number;
}

function dims(height: number, fem: number): Dims {
  const s = height / 1.72;
  const hs = (1 - (1 - s) * 0.5) * (1 - 0.035 * fem);
  const headR = { w: 0.078 * hs, h: 0.114 * hs, f: 0.099 * hs, b: 0.104 * hs };
  const torso = TORSO.map(([y, w, f, b, n, fw, ff, z]) => ({ y: y * s, w: w * s * (1 + (fw - 1) * fem), f: (f + ff * fem) * s, b: b * s, n, z: z * s }));
  return {
    s,
    hs,
    fem,
    height,
    hips: new Vector3(0, 0.95 * s, -0.005 * s),
    shoulder: new Vector3(0.17 * s * (1 - 0.08 * fem), 1.38 * s, -0.012 * s),
    hipJ: new Vector3(0.088 * s * (1 + 0.04 * fem), 0.89 * s, 0),
    upper: 0.29 * s,
    fore: 0.265 * s,
    thigh: 0.41 * s,
    shin: 0.405 * s,
    abd: 0.1,
    headC: new Vector3(0, height - headR.h, 0.012 * hs),
    headR,
    torso,
  };
}

/** Torso section at height y (interpolated), for hanging panels on the body. */
function torsoAt(d: Dims, y: number): Sec {
  const T = d.torso;
  if (y <= T[0].y) return T[0];
  for (let i = 1; i < T.length; i++) {
    if (y <= T[i].y) {
      const k = (y - T[i - 1].y) / (T[i].y - T[i - 1].y);
      const a = T[i - 1];
      const b = T[i];
      const l = (p: number, q: number) => p + (q - p) * k;
      return { y, w: l(a.w, b.w), f: l(a.f, b.f), b: l(a.b, b.b), n: l(a.n ?? 2, b.n ?? 2), z: l(a.z ?? 0, b.z ?? 0) };
    }
  }
  return T[T.length - 1];
}

/** Surface z of a section's front at lateral offset x. */
function frontZ(s: Sec, x: number): number {
  const n = s.n ?? 2;
  const r = Math.min(1, Math.abs(x) / s.w);
  return (s.z ?? 0) + s.f * Math.pow(Math.max(0, 1 - Math.pow(r, n)), 1 / n);
}

const grow = (s: Sec, t: number, tf = t): Sec => ({ ...s, w: s.w + t, f: s.f + tf, b: s.b + t });

/**
 * Head surface: u wraps from the back (0) through the left side, v runs crown
 * to chin. `feat` scales the nose, brow and cheek relief (kept low).
 */
function headPoint(d: Dims, u: number, v: number, g: number, feat: number, out: Vector3): Vector3 {
  const R = d.headR;
  const a = Math.PI + u * Math.PI * 2;
  const sa = Math.sin(a);
  const ca = Math.cos(a);
  const phi = v * Math.PI;
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const low = smooth(0.55, 1, v);
  const hw = R.w * (1 - 0.3 * low) + g;
  const hf = R.f * (1 - 0.14 * low) + g;
  const hb = R.b * (1 - 0.62 * low) + g;
  let x = sp * sa * hw;
  let z = sp * ca * (ca >= 0 ? hf : hb) + 0.012 * d.hs * low * Math.max(0, ca);
  const y = cp * (R.h + g) * (cp > 0 ? 0.96 : 1);
  if (feat > 0 && ca > 0) {
    const front = ca ** 3;
    const hs = d.hs;
    const nose = smooth(0.43, 0.6, v) * (1 - smooth(0.6, 0.665, v));
    z += feat * front * 0.022 * hs * nose * gauss(x / (0.011 * hs));
    z += feat * front * 0.006 * hs * gauss((v - 0.44) / 0.035) * gauss(x / (0.05 * hs));
    z -= feat * front * 0.007 * hs * gauss((v - 0.5) / 0.04) * gauss((Math.abs(x) - 0.031 * hs) / (0.013 * hs));
    z += feat * front * 0.004 * hs * gauss((v - 0.66) / 0.05) * gauss((Math.abs(x) - 0.04 * hs) / (0.02 * hs));
    x *= 1 + feat * 0.02 * gauss((v - 0.62) / 0.08);
  }
  return out.set(d.headC.x + x, d.headC.y + y, d.headC.z + z);
}

/**
 * Soft tonal cues on the face as vertex colours (multiplying the skin):
 * brows, eye sockets and a faint lip line. No eyes are drawn; at street
 * distances this reads as a face in shadow instead of a blank mannequin.
 */
function faceTone(d: Dims, g: BufferGeometry): Float32Array {
  const pos = g.getAttribute("position");
  const col = new Float32Array(pos.count * 3);
  const hs = d.hs;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) - d.headC.x;
    const y = pos.getY(i) - d.headC.y;
    const z = pos.getZ(i) - d.headC.z;
    const v = Math.acos(Math.max(-1, Math.min(1, y / (d.headR.h * 0.98)))) / Math.PI;
    const front = Math.max(0, z / Math.max(1e-4, Math.hypot(x, z))) ** 2;
    const ax = Math.abs(x) / hs;
    const brow = gauss((v - 0.445) / 0.018) * gauss((ax - 0.03) / 0.02) * front;
    const eye = gauss((v - 0.5) / 0.036) * gauss((ax - 0.03) / 0.017) * front;
    const lip = gauss((v - 0.735) / 0.016) * gauss(x / (0.02 * hs)) * front * front;
    const jaw = smooth(0.8, 0.97, v) * 0.25;
    const k = (1 - 0.62 * brow) * (1 - 0.45 * eye) * (1 - jaw);
    col[i * 3] = k * (1 - 0.08 * lip);
    col[i * 3 + 1] = k * (1 - 0.24 * lip);
    col[i * 3 + 2] = k * (1 - 0.2 * lip);
  }
  return col;
}

const _m = new Matrix4();
const _A = new Matrix4();
const _Bm = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _t = new Vector3();
const _p = new Vector3();
const _u = new Vector3();
const _v = new Vector3();
const _e = new Vector3();
const _n = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _eu = new Euler(0, 0, 0, "YXZ");

export class Figure {
  readonly root = new Group();
  readonly bones: Bone[] = [];
  readonly hips: Bone;
  readonly spine: Bone;
  readonly chest: Bone;
  readonly neck: Bone;
  readonly head: Bone;
  readonly arms: Limb[];
  readonly legs: Limb[];
  readonly d: Dims;
  readonly meshes: SkinnedMesh[] = [];

  constructor(build: Build, look: Look, wear: Wear) {
    const d = (this.d = dims(build.height, build.fem ?? 0));
    const { s } = d;
    this.root.userData.dynamic = true;

    // ------------------------------------------------------------ skeleton
    const abs: Vector3[] = [];
    const add = (parent: number, p: Vector3): Bone => {
      const b = new Bone();
      b.position.copy(p);
      if (parent >= 0) {
        b.position.sub(abs[parent]);
        this.bones[parent].add(b);
      } else this.root.add(b);
      abs.push(p.clone());
      this.bones.push(b);
      return b;
    };
    this.hips = add(-1, d.hips);
    this.spine = add(B.hips, new Vector3(0, 1.06 * s, -0.012 * s));
    this.chest = add(B.spine, new Vector3(0, 1.25 * s, -0.015 * s));
    this.neck = add(B.chest, new Vector3(0, 1.455 * s, -0.02 * s));
    this.head = add(B.neck, new Vector3(0, d.headC.y - 0.058 * d.hs, d.headC.z - 0.03 * d.hs));
    const armRest = (sg: number) => new Vector3(sg * Math.sin(d.abd), -Math.cos(d.abd), 0);
    const arm = (sg: number): Limb => {
      const S = d.shoulder.clone().setX(sg * d.shoulder.x);
      const rest = armRest(sg);
      const upper = add(B.chest, S);
      const lower = add(this.bones.length - 1, S.clone().addScaledVector(rest, d.upper));
      const end = add(this.bones.length - 1, S.clone().addScaledVector(rest, d.upper + d.fore));
      return { upper, lower, end, a: d.upper, b: d.fore, rest, flex: new Vector3().crossVectors(rest, new Vector3(0, 0, 1)).normalize(), sign: sg };
    };
    const leg = (sg: number): Limb => {
      const H = d.hipJ.clone().setX(sg * d.hipJ.x);
      const upper = add(B.hips, H);
      const lower = add(this.bones.length - 1, H.clone().setY(0.48 * s));
      const end = add(this.bones.length - 1, H.clone().setY(0.075 * s));
      const rest = new Vector3(0, -1, 0);
      return { upper, lower, end, a: H.y - 0.48 * s, b: 0.405 * s, rest, flex: new Vector3(1, 0, 0), sign: sg };
    };
    this.arms = [arm(1), arm(-1)];
    this.legs = [leg(1), leg(-1)];

    // ------------------------------------------------------------ geometry
    const parts = new Map<string, { paint: Paint; rough: number; geos: BufferGeometry[] }>();
    const col = new Color();
    const put = (paint: Paint | undefined, g: BufferGeometry, fn: SkinFn | number, tone?: Float32Array) => {
      if (!paint) return;
      skin(g, fn);
      const n = g.getAttribute("position").count;
      if (paint.map) col.setRGB(1, 1, 1);
      else col.set(paint.hex).multiplyScalar((paint.lit ?? LIT) / LIT);
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        c[i * 3] = col.r * (tone ? tone[i * 3] : 1);
        c[i * 3 + 1] = col.g * (tone ? tone[i * 3 + 1] : 1);
        c[i * 3 + 2] = col.b * (tone ? tone[i * 3 + 2] : 1);
      }
      g.setAttribute("color", new Float32BufferAttribute(c, 3));
      const rough = ROUGH.reduce((a, b) => (Math.abs(b - paint.rough) < Math.abs(a - paint.rough) ? b : a));
      const key = paint.map ? `map-${paint.map.uuid}-${paint.rough}-${paint.lit ?? LIT}` : `r-${rough}`;
      const e = parts.get(key) ?? { paint, rough, geos: [] };
      e.geos.push(g);
      parts.set(key, e);
    };
    const top = build.top;
    const t = top.t;
    const clampX = (x: number, r: number) => Math.max(-1, Math.min(1, x / r));

    // Torso weights: pelvis → waist → chest, shoulders lean on the arms,
    // and anything hanging below the hips is pushed by the thighs.
    const spineChain = chain(
      [
        [B.hips, 0.95 * s],
        [B.spine, 1.08 * s],
        [B.chest, 1.24 * s],
      ],
      (p) => p.y,
    );
    const bodySkin =
      (thighs: number): SkinFn =>
      (p) => {
        const base = spineChain(p);
        const ka = 0.45 * smooth(0.12 * s, 0.19 * s, Math.abs(p.x)) * smooth(1.3 * s, 1.39 * s, p.y);
        const kk = thighs * smooth(0.92 * s, 0.5 * s, p.y);
        const lr = clampX(p.x, 0.1 * s);
        const out: Influence = base.map(([b, w]) => [b, w * (1 - ka - kk)]);
        out.push([p.x > 0 ? B.upperL : B.upperR, ka], [B.thighL, kk * (0.5 + 0.5 * lr)], [B.thighR, kk * (0.5 - 0.5 * lr)]);
        return out;
      };

    // Outer garment: torso to the hem, hanging straight past the hips.
    const hip = d.torso[3];
    const hemY = top.hem * s;
    const secs: Sec[] = [];
    const skirt = (y: number): Sec => {
      const k = Math.max(0, hip.y - y);
      const fl = (top.flare ?? 0) * k;
      const src = y >= d.torso[1].y ? torsoAt(d, y) : hip;
      return { y, w: Math.max(hip.w, src.w) + t + fl, f: Math.max(hip.f, src.f) + t + fl * 0.8, b: Math.max(hip.b + 0.002, src.b) + t + fl * 0.9, n: 2.4 };
    };
    if (hemY < hip.y) {
      const steps = Math.max(1, Math.ceil((hip.y - hemY) / (0.075 * s)));
      for (let i = steps; i >= 1; i--) secs.push(skirt(hemY + ((hip.y - hemY) * (steps - i)) / steps));
    }
    for (const sec of d.torso) if (sec.y >= Math.max(hip.y, hemY)) secs.push(grow(sec, t));
    const coat = hemY < 0.75 * s;
    const outer = loft(secs, 28, { end: true });
    put(look.top, outer, bodySkin(coat ? 0.8 : 0.25));
    if (hemY < 0.85 * s) {
      // Lining so the hem reads as cloth from below.
      const lining = loft(secs.slice(0, 3).map((q) => grow(q, -0.004)), 28);
      put(look.top, flip(lining), bodySkin(coat ? 0.8 : 0.25));
    }

    // Trousers / skirt base: pelvis block.
    const tb = build.legs?.tights ? 0.002 : 0.006;
    const pelvis = loft(
      d.torso.filter((q) => q.y <= 1.0 * s).map((q) => grow(q, tb)),
      24,
      { start: true, end: true },
    );
    put(look.bottom, pelvis, (p) => {
      const kk = 0.5 * smooth(0.86 * s, 0.79 * s, p.y);
      const lr = clampX(p.x, 0.08 * s);
      return [
        [B.hips, 1 - kk],
        [B.thighL, kk * (0.5 + 0.5 * lr)],
        [B.thighR, kk * (0.5 - 0.5 * lr)],
      ];
    });

    // Legs.
    const loose = build.legs?.loose ?? 0.004;
    for (const l of this.legs) {
      const x0 = l.sign * d.hipJ.x;
      const ls: Sec[] = LEG.map(([y, w, f, b]) => {
        const k = 1 - 0.05 * d.fem;
        const lower = y < 0.5;
        const r = (v: number) => (build.legs?.tights ? v * k + 0.002 : lower ? Math.max(v * k + tb, 0.045 + loose) : v * k + tb + loose * 0.5);
        return { y: y * s, x: x0 - l.sign * (y > 0.8 ? 0.008 * s : 0), w: r(w) * s, f: r(f) * s, b: r(b) * s, n: 2.1 };
      }).reverse();
      const thighB = l === this.legs[0] ? B.thighL : B.thighR;
      put(
        look.bottom,
        loft(ls, 16, { start: true, end: true }),
        chain(
          [
            [thighB + 1, 0.455 * s],
            [thighB, 0.515 * s],
            [thighB, 0.8 * s],
            [B.hips, 0.885 * s],
          ],
          (p) => p.y,
        ),
      );

      // Shoes.
      const kind = build.shoe ?? "shoe";
      const bw = kind === "sneaker" ? 0.006 : 0;
      const bh = kind === "sneaker" ? 0.01 : 0;
      const ss: Sec[] = SHOE.map(([z, w, h], i) => {
        let hh = h + bh;
        if (kind === "boot" && i > 0 && i < 5) hh = Math.max(hh, 0.16);
        const hw = (w + bw) * (1 - 0.06 * d.fem);
        return { y: z * s, w: hw * s, f: (hh / 2) * s, b: (hh / 2) * s, z: (-hh / 2) * s, n: 3 };
      });
      const shoe = loft(ss, 18, { start: true, end: true });
      shoe.rotateX(Math.PI / 2);
      shoe.translate(x0, 0, 0.01 * s);
      put(look.shoes, shoe, thighB + 2);
    }

    // Arms: sleeves in the top material, then hands.
    const cuff = top.cuff ?? 0.006;
    for (const l of this.arms) {
      const S = d.shoulder.clone().setX(l.sign * d.shoulder.x);
      const k = 1 - 0.1 * d.fem;
      const end = (d.upper + d.fore) / s + 0.012;
      // Cloth thickness fades out over the shoulder cap so garments do not build shoulder pads.
      const tk = (a: number) => t * 0.8 * smooth(-0.032, 0.04, a);
      const as: Sec[] = ARM.map(([a, w, f, b]) => ({ y: -a * s, w: (w * k + tk(a)) * s, f: (f * k + tk(a)) * s, b: (b * k + tk(a)) * s }));
      as.push({ y: -end * s, w: (0.033 * k + t * 0.8 + cuff) * s, f: (0.035 * k + t * 0.8 + cuff) * s, b: (0.035 * k + t * 0.8 + cuff) * s });
      const sleeve = loft(as.reverse(), 16, { start: true, end: true });
      sleeve.rotateZ(l.sign * d.abd);
      sleeve.translate(S.x, S.y, S.z);
      const upperB = l === this.arms[0] ? B.upperL : B.upperR;
      const along = (p: Vector3) => _t.subVectors(p, S).dot(l.rest);
      put(
        look.top,
        sleeve,
        chain(
          [
            [B.chest, -0.05 * s],
            [upperB, 0.012 * s],
            [upperB, 0.255 * s],
            [upperB + 1, 0.315 * s],
          ],
          along,
        ),
      );

      // Hand: palm toward the thigh, fingers relaxed and curled a little.
      const hsz = s * (1 - 0.08 * d.fem);
      const hsec: Sec[] = HAND.map(([a, w, f, b, z]) => ({ y: -a * hsz, x: -l.sign * 0.03 * hsz * smooth(0.08, 0.18, a) ** 1.5, w: w * hsz, f: f * hsz, b: b * hsz, z: (z + 0.004 * smooth(0.12, 0.19, a)) * hsz })).reverse();
      const hand = loft(hsec, 12, { start: true, end: true });
      const thumb = loft(
        [
          { y: -0.066 * hsz, w: 0.004 * hsz, f: 0.004 * hsz, b: 0.004 * hsz },
          { y: -0.056 * hsz, w: 0.009 * hsz, f: 0.009 * hsz, b: 0.009 * hsz },
          { y: -0.03 * hsz, w: 0.011 * hsz, f: 0.011 * hsz, b: 0.011 * hsz },
          { y: 0, w: 0.012 * hsz, f: 0.013 * hsz, b: 0.012 * hsz },
        ],
        8,
        { start: true, end: true },
      );
      thumb.rotateX(-0.5);
      thumb.rotateZ(-l.sign * 0.25);
      thumb.translate(-l.sign * 0.006 * hsz, -0.022 * hsz, 0.024 * hsz);
      const hg = mergeGeometries([hand, thumb], false)!;
      hg.rotateZ(l.sign * d.abd);
      const W = S.clone().addScaledVector(l.rest, d.upper + d.fore);
      hg.translate(W.x, W.y, W.z);
      put(look.skin, hg, upperB + 2);
    }

    // Neck.
    const nk = 1.08 - 0.14 * d.fem;
    const neck = loft(
      [
        { y: 1.42 * s, w: 0.053 * s * nk, f: 0.05 * s * nk, b: 0.054 * s * nk, z: -0.022 * s },
        { y: 1.5 * s, w: 0.05 * s * nk, f: 0.047 * s * nk, b: 0.05 * s * nk, z: -0.014 * s },
        { y: d.headC.y - 0.03 * d.hs, w: 0.048 * s * nk, f: 0.045 * s * nk, b: 0.05 * s * nk, z: -0.008 * s },
      ],
      14,
    );
    put(
      look.skin,
      neck,
      chain(
        [
          [B.chest, 1.43 * s],
          [B.neck, 1.48 * s],
          [B.head, d.headC.y - 0.04 * d.hs],
        ],
        (p) => p.y,
      ),
    );

    // Head and ears.
    const hc = d.headC;
    const headGeo = shell(40, 28, (u, v, o) => headPoint(d, u, v, 0, 1, o), hc);
    put(look.skin, headGeo, B.head, faceTone(d, headGeo));
    for (const sg of [1, -1]) {
      const R = d.headR;
      const ear = loft(
        [
          { y: -0.028, w: 0.003, f: 0.006, b: 0.005 },
          { y: -0.02, w: 0.008, f: 0.013, b: 0.01 },
          { y: 0.015, w: 0.009, f: 0.015, b: 0.012 },
          { y: 0.028, w: 0.004, f: 0.008, b: 0.006 },
        ].map((q) => ({ ...q, y: q.y * d.hs, w: q.w * d.hs, f: q.f * d.hs, b: q.b * d.hs })),
        8,
        { start: true, end: true },
      );
      ear.rotateX(0.18);
      ear.translate(sg * (R.w - 0.001), hc.y - 0.012 * d.hs, hc.z - 0.012 * d.hs);
      put(look.skin, ear, B.head);
    }

    // Hair: a shell over the skull, cut at a hairline that drops toward the
    // nape; long styles fall straight from the widest ring.
    const style =
      build.hair === "bob" ? { front: 0.4, side: 0.98, back: 1, top: 0.02, g: 0.011, fall: 0.135 } : { front: 0.31, side: 0.5, back: 0.68, top: 0.022, g: 0.009, fall: 0 };
    const hairPt = (u: number, v: number, o: Vector3) => {
      const ca = Math.cos(Math.PI + u * Math.PI * 2);
      const vmax = (ca > 0 ? style.front * ca + style.side * (1 - ca) : style.back * -ca + style.side * (1 + ca)) + 0.006 * Math.sin(u * Math.PI * 2 * 9) + 0.004 * Math.sin(u * Math.PI * 2 * 23) + 0.02 * Math.max(0, ca) ** 8;
      const vv = v * vmax;
      const g = style.g * d.hs + style.top * d.hs * Math.sqrt(Math.max(0, 1 - (vv / 0.55) ** 2)) + 0.0015 * Math.sin(u * Math.PI * 2 * 11 + vv * 9);
      if (vv <= 0.5 || style.fall === 0) return headPoint(d, u, Math.min(vv, 0.999), g, 0, o);
      headPoint(d, u, 0.5, g, 0, o);
      const k = (vv - 0.5) / 0.5;
      o.x = hc.x + (o.x - hc.x) * (1 - 0.08 * k);
      o.z = hc.z + (o.z - hc.z) * (1 - 0.1 * k) - 0.01 * k * d.hs;
      o.y -= k * style.fall * d.hs;
      return o;
    };
    put(look.hair, shell(36, 16, hairPt, hc), B.head);

    if (look.cap) {
      const capPt = (u: number, v: number, o: Vector3) => headPoint(d, u, v * 0.42, 0.014 * d.hs + 0.006 * d.hs * (1 - v), 0, o);
      put(look.cap, shell(32, 8, capPt, hc), B.head);
      // Brim: two faces of a curved visor.
      const rows: Vector3[][] = [[], []];
      for (let j = 0; j <= 12; j++) {
        const u = 0.5 + (j / 12 - 0.5) * 0.46;
        const p = capPt(u, 1, new Vector3());
        const dir = _t.set(p.x - hc.x, 0, p.z - hc.z).normalize();
        rows[0].push(p.clone());
        rows[1].push(p.clone().addScaledVector(dir, 0.078 * d.hs * (0.3 + 0.7 * Math.cos((j / 12 - 0.5) * Math.PI))).add(new Vector3(0, -0.016 * d.hs, 0)));
      }
      put(look.cap, grid(rows, false, {}, new Vector3(hc.x, hc.y - 1, hc.z)), B.head);
      put(look.cap, grid(rows.map((r) => r.map((p) => p.clone().setY(p.y - 0.004))), false, {}, new Vector3(hc.x, hc.y + 1, hc.z)), B.head);
    }

    if (look.mask) {
      const rows: Vector3[][] = [];
      for (let i = 0; i <= 8; i++) {
        const v = 0.52 + (i / 8) * 0.36;
        const row: Vector3[] = [];
        for (let j = 0; j <= 14; j++) {
          const u = 0.5 + (j / 14 - 0.5) * 0.44;
          const p = headPoint(d, u, v, 0.006 * d.hs, 0.45, new Vector3());
          row.push(p);
        }
        rows.push(row);
      }
      put(look.mask, grid(rows, false, {}, hc), B.head);
    }

    // Collars, ties, aprons, scarves.
    const outerAt = (y: number): Sec => (y >= hip.y ? grow(torsoAt(d, y), t) : skirt(y));
    const panel = (mat: Paint | undefined, y0: number, y1: number, half: (y: number) => number, off: number, cx = 0, fn: SkinFn = bodySkin(coat ? 0.8 : 0.25), rowsN = 8, cols = 6) => {
      if (!mat) return;
      const rows: Vector3[][] = [];
      for (let i = 0; i <= rowsN; i++) {
        const y = y0 + ((y1 - y0) * i) / rowsN;
        const sec = outerAt(y);
        const hw = half(y);
        const row: Vector3[] = [];
        for (let j = 0; j <= cols; j++) {
          const x = cx + (j / cols - 0.5) * 2 * hw;
          row.push(new Vector3(x, y, frontZ(sec, x) + off));
        }
        rows.push(row);
      }
      put(mat, grid(rows, false, {}, new Vector3(cx, (y0 + y1) / 2, -0.5)), fn);
    };
    if (top.vneck) {
      panel(look.shirt, 1.235 * s, 1.44 * s, (y) => 0.004 * s + (y - 1.235 * s) * 0.3, 0.002);
      panel(look.tie, 1.24 * s, 1.43 * s, (y) => (0.016 + (1.43 * s - y) * 0.07) * s, 0.005);
    }
    if (look.shirt) {
      const collar = loft(
        [
          { y: 1.415 * s, w: 0.068 * s, f: 0.064 * s, b: 0.066 * s, z: -0.016 * s },
          { y: 1.47 * s, w: 0.062 * s, f: 0.058 * s, b: 0.062 * s, z: -0.014 * s },
        ],
        16,
      );
      put(look.shirt, collar, B.chest);
    }
    if (look.apron) {
      panel(look.apron, 0.7 * s, 1.33 * s, (y) => (y > 1.12 * s ? 0.155 - ((y - 1.12 * s) / (0.21 * s)) * 0.045 : 0.158) * s, 0.012, 0, bodySkin(0.7), 12, 8);
      for (const sg of [1, -1]) panel(look.apron, 1.32 * s, 1.445 * s, () => 0.014 * s, 0.013, sg * 0.098 * s, bodySkin(0), 4, 2);
      if (look.badge) {
        const bg = new BoxGeometry(0.07 * s, 0.024 * s, 0.004);
        const y = 1.25 * s;
        bg.rotateX(-0.25);
        bg.translate(0.075 * s, y, frontZ(outerAt(y), 0.075 * s) + 0.016);
        put(look.badge, bg, B.chest);
      }
    }
    if (look.scarf) {
      const scarf = loft(
        [
          { y: 1.37 * s, w: 0.098 * s, f: 0.088 * s, b: 0.08 * s, z: -0.006 * s },
          { y: 1.395 * s, w: 0.112 * s, f: 0.1 * s, b: 0.09 * s, z: -0.01 * s },
          { y: 1.435 * s, w: 0.104 * s, f: 0.092 * s, b: 0.088 * s, z: -0.012 * s },
          { y: 1.475 * s, w: 0.082 * s, f: 0.076 * s, b: 0.076 * s, z: -0.01 * s },
          { y: 1.5 * s, w: 0.068 * s, f: 0.064 * s, b: 0.068 * s, z: -0.008 * s },
        ],
        20,
        { start: true, end: true },
      );
      put(look.scarf, scarf, (p) => [
        [B.chest, 1 - 0.4 * smooth(1.44 * s, 1.5 * s, p.y)],
        [B.neck, 0.4 * smooth(1.44 * s, 1.5 * s, p.y)],
      ]);
    }
    if (top.hood) {
      const hood = loft(
        [
          { y: 1.39 * s, w: 0.09 * s, f: 0.03 * s, b: 0.1 * s, z: -0.02 * s },
          { y: 1.44 * s, w: 0.112 * s, f: 0.058 * s, b: 0.12 * s, z: -0.022 * s },
          { y: 1.482 * s, w: 0.092 * s, f: 0.05 * s, b: 0.1 * s, z: -0.03 * s },
          { y: 1.505 * s, w: 0.06 * s, f: 0.036 * s, b: 0.066 * s, z: -0.03 * s },
        ],
        20,
        { start: true, end: true },
      );
      put(look.top, hood, B.chest);
    }

    // ------------------------------------------------------------ meshes
    this.root.updateMatrixWorld(true);
    const skeleton = new Skeleton(this.bones);
    const bound = new Sphere(new Vector3(0, d.height * 0.5, 0), d.height * 0.8);
    for (const { paint, rough, geos } of parts.values()) {
      const g = geos.length > 1 ? mergeGeometries(geos, false)! : geos[0];
      const mat = paint.map ? wear.cloth(0xffffff, paint.rough, paint.lit ?? LIT, paint.map) : wear.body(rough);
      const m = new SkinnedMesh(g, mat);
      m.castShadow = build.cast ?? false;
      m.receiveShadow = true;
      this.root.add(m);
      m.bind(skeleton);
      m.boundingSphere = bound.clone();
      this.meshes.push(m);
    }
  }

  /** Rest pose. */
  reset(): void {
    for (const b of this.bones) b.quaternion.identity();
    this.hips.position.copy(this.d.hips);
  }

  /** Refreshes world matrices below the root (before IK). */
  sync(): void {
    this.root.updateMatrixWorld(true);
  }

  /**
   * Two-bone IK: places the limb's end joint at `target` (root space) with
   * the middle joint bending toward `pole` (root-space direction).
   */
  private solve(l: Limb, target: Vector3, pole: Vector3): void {
    const parent = l.upper.parent!;
    _m.copy(parent.matrixWorld).invert().multiply(this.root.matrixWorld);
    _t.copy(target).applyMatrix4(_m);
    _p.copy(pole).transformDirection(_m);
    const S = l.upper.position;
    _u.subVectors(_t, S);
    const { a, b } = l;
    const d = Math.min(Math.max(_u.length(), Math.abs(a - b) + 1e-3), (a + b) * 0.9995);
    _u.normalize();
    _v.copy(_p).addScaledVector(_u, -_p.dot(_u));
    if (_v.lengthSq() < 1e-8) _v.set(0, 0, 1).addScaledVector(_u, -_u.z);
    _v.normalize();
    const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
    _e.copy(_u).multiplyScalar(cosA).addScaledVector(_v, Math.sqrt(1 - cosA * cosA));
    _n.crossVectors(_v, _u).normalize();
    _A.makeBasis(l.rest, l.flex, _x.crossVectors(l.rest, l.flex));
    _Bm.makeBasis(_e, _n, _y.crossVectors(_e, _n));
    _Bm.multiply(_A.transpose());
    l.upper.quaternion.setFromRotationMatrix(_Bm);
    const cosI = Math.min(1, Math.max(-1, (a * a + b * b - d * d) / (2 * a * b)));
    l.lower.quaternion.setFromAxisAngle(l.flex, Math.PI - Math.acos(cosI));
    l.end.quaternion.identity();
    l.upper.updateMatrixWorld(true);
  }

  /** Wrist to `target` (root space); elbow toward `pole`. */
  reach(side: number, target: Vector3, pole: Vector3): void {
    this.solve(this.arms[side], target, pole);
  }

  /** Ankle to `target` (root space); knee toward `pole`. */
  step(side: number, target: Vector3, pole: Vector3): void {
    this.solve(this.legs[side], target, pole);
  }

  /** Sets a limb end's orientation in root space (Euler YXZ: yaw, pitch, roll). */
  orient(l: Limb, pitch: number, yaw: number, roll = 0): void {
    l.lower.getWorldQuaternion(_q).invert();
    this.root.getWorldQuaternion(_q2);
    l.end.quaternion.copy(_q).multiply(_q2).multiply(new Quaternion().setFromEuler(_eu.set(pitch, yaw, roll)));
  }

  /** Foot flat on the ground plane with toe `pitch` (positive = toe up) and out-toe `yaw`. */
  plant(side: number, pitch: number, yaw: number): void {
    this.orient(this.legs[side], -pitch, yaw);
  }

  /** Points the hand from the wrist toward `p` (root space). */
  aim(side: number, p: Vector3): void {
    const l = this.arms[side];
    _m.copy(l.lower.matrixWorld).invert().multiply(this.root.matrixWorld);
    _t.copy(p).applyMatrix4(_m).sub(l.end.position).normalize();
    l.end.quaternion.setFromUnitVectors(l.rest, _t);
  }

  /** Forward kinematics for a hanging arm: swing back (+) / forward (−), outward, elbow bend. */
  swing(side: number, back: number, out: number, bend: number, wrist = 0): void {
    const l = this.arms[side];
    l.upper.rotation.set(back, 0, l.sign * out);
    l.lower.quaternion.setFromAxisAngle(l.flex, bend);
    l.end.quaternion.setFromAxisAngle(l.flex, wrist);
  }

  /** Root-space position of a point given in a bone's local frame. */
  toRoot(bone: Bone, p: Vector3, out: Vector3): Vector3 {
    _m.copy(this.root.matrixWorld).invert().multiply(bone.matrixWorld);
    return out.copy(p).applyMatrix4(_m);
  }
}
