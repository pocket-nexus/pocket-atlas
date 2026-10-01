import { Vector3 } from "three";
import type { Figure } from "./rig";
import { smooth } from "./shape";

const TAU = Math.PI * 2;
/** Fraction of the gait cycle a foot spends on the ground. */
const DUTY = 0.62;

export interface Gait {
  /** Meters covered per full cycle (two steps). */
  stride: number;
  /** Peak ankle lift in swing (m at 1.72 m). */
  lift: number;
  /** Free-arm swing amplitude (rad). */
  arm: number;
  /** Forward lean of the trunk (rad). */
  lean: number;
  /** Head pitch, positive = looking down (rad). */
  look: number;
}

interface FootState {
  z: number;
  y: number;
  pitch: number;
}

/**
 * Ankle target relative to the pelvis for gait phase q: planted and sliding
 * back at walking speed during stance (heel strike, flat foot, heel-off
 * about the ball), then an eased swing forward with the toe lifted.
 */
function foot(q: number, g: Gait, s: number, out: FootState): FootState {
  q -= Math.floor(q);
  let lift = 0;
  if (q < DUTY) {
    const t = q / DUTY;
    out.z = g.stride * DUTY * (0.5 - t);
    out.pitch = 0.26 * (1 - smooth(0, 0.16, t)) - 0.62 * smooth(0.58, 1, t);
  } else {
    const t = (q - DUTY) / (1 - DUTY);
    out.z = g.stride * DUTY * (-0.5 + smooth(0, 1, t));
    lift = g.lift * s * Math.sin(Math.PI * Math.pow(t, 0.7));
    out.pitch = -0.62 + 0.88 * smooth(0.05, 0.92, t);
  }
  const p = out.pitch;
  out.y = 0.075 * s + lift + (p < 0 ? 0.13 * s * Math.sin(-p) : 0.05 * s * Math.sin(p));
  return out;
}

const F: [FootState, FootState] = [
  { z: 0, y: 0, pitch: 0 },
  { z: 0, y: 0, pitch: 0 },
];
const V = new Vector3();
const P = new Vector3();

/**
 * Full-body walk at cycle phase `c` (left heel strikes at integer c): leg
 * IK onto planted/swinging feet, pelvis height from leg reach (the bob
 * follows), pelvis yaw/roll/sway, counter-rotating chest, head held level,
 * and a contralateral swing on the arms flagged free. Returns the pelvis
 * drop below standing height (for things carried at a fixed offset).
 */
export function walk(f: Figure, c: number, g: Gait, free: [boolean, boolean]): number {
  const d = f.d;
  const s = d.s;
  f.reset();
  const ph = TAU * c;
  foot(c, g, s, F[0]);
  foot(c + 0.5, g, s, F[1]);
  const L = (d.thigh + d.shin) * 0.994;
  let H = d.hipJ.y;
  for (const ft of F) H = Math.min(H, ft.y + Math.sqrt(Math.max(0, L * L - ft.z * ft.z)));
  const sw = Math.sin(ph - 0.35);
  const cy = Math.cos(ph);
  f.hips.position.set(0.018 * s * sw, H + d.hips.y - d.hipJ.y, d.hips.z);
  f.hips.rotation.set(g.lean * 0.4 + 0.02, -0.075 * cy, 0.04 * sw);
  f.spine.rotation.set(g.lean * 0.3 - 0.02, 0.05 * cy, -0.03 * sw);
  f.chest.rotation.set(g.lean * 0.3 + 0.008 * Math.cos(2 * ph), 0.08 * cy, -0.012 * sw);
  f.neck.rotation.set(g.look * 0.4 - g.lean * 0.5, -0.03 * cy, -0.004 * sw);
  f.head.rotation.set(g.look * 0.6 - g.lean * 0.5, -0.025 * cy, 0);
  f.sync();
  for (let i = 0; i < 2; i++) {
    const sg = i ? -1 : 1;
    const ft = F[i];
    f.step(i, V.set(sg * d.hipJ.x * 1.08, ft.y, ft.z), P.set(sg * 0.12, 0, 1));
    f.plant(i, ft.pitch, sg * 0.08);
    if (free[i]) {
      const k = sg * Math.cos(ph - 0.3);
      f.swing(i, g.arm * k, 0.06, 0.2 + 0.34 * Math.max(0, -k), 0.12);
    }
  }
  return d.hipJ.y - H;
}

export interface Stance {
  /** Ankle positions (root space). */
  feet: [Vector3, Vector3];
  /** Out-toe of each foot (rad). */
  toe: [number, number];
  /** −1…1: weight on the right … left leg. */
  weight: number;
  /** Trunk lean forward (rad) and twist toward the left (rad). */
  lean: number;
  twist: number;
  /** Breathing phase (rad). */
  breath: number;
  /** Head yaw toward the left and pitch down (rad), split over neck and head. */
  yaw: number;
  pitch: number;
  /** Pelvis offset forward (m). */
  forward?: number;
}

/**
 * Standing pose: hips shifted over the loaded leg and tipped down on the
 * free side (contrapposto), shoulders counter-tilted, the free knee bends
 * because its hip drops. Arms are left at rest for the caller.
 */
export function stand(f: Figure, st: Stance): void {
  const d = f.d;
  const s = d.s;
  f.reset();
  const shift = st.weight * 0.034 * s;
  const roll = st.weight * 0.055;
  const fwd = st.forward ?? 0;
  const L = (d.thigh + d.shin) * 0.997;
  let H = d.hipJ.y;
  st.feet.forEach((p, i) => {
    const sg = i ? -1 : 1;
    const dx = p.x - (sg * d.hipJ.x + shift);
    const dz = p.z - fwd;
    H = Math.min(H, p.y + Math.sqrt(Math.max(0, L * L - dx * dx - dz * dz)) - sg * Math.sin(roll) * d.hipJ.x);
  });
  const br = Math.sin(st.breath);
  f.hips.position.set(shift, H + d.hips.y - d.hipJ.y, d.hips.z + fwd);
  f.hips.rotation.set(st.lean * 0.3, st.twist * 0.2 - st.weight * 0.05, roll);
  f.spine.rotation.set(st.lean * 0.3 + 0.006 * br, st.twist * 0.35, -roll * 0.75);
  f.chest.rotation.set(st.lean * 0.4 - 0.012 * br, st.twist * 0.45, -roll * 0.45);
  f.neck.rotation.set(st.pitch * 0.45 - st.lean * 0.4, st.yaw * 0.4 - st.twist * 0.4, roll * 0.2);
  f.head.rotation.set(st.pitch * 0.55 - st.lean * 0.4, st.yaw * 0.6 - st.twist * 0.6, 0.02);
  f.sync();
  st.feet.forEach((p, i) => {
    const sg = i ? -1 : 1;
    f.step(i, p, P.set(sg * 0.18, 0, 1));
    f.plant(i, 0, st.toe[i]);
  });
}

/** Smooth, repeatable pseudo-random wander in [−1, 1] (sum of incommensurate sines). */
export function wander(t: number, seed: number): number {
  return (Math.sin(t * 0.37 + seed * 1.7) + 0.6 * Math.sin(t * 0.83 + seed * 4.1) + 0.3 * Math.sin(t * 1.91 + seed * 7.3)) / 1.9;
}

/** 0 → 1 → 0 envelope for an event of `len` seconds repeating every `period`, with `ease` seconds of blend. */
export function pulse(t: number, period: number, len: number, ease: number, offset = 0): number {
  const u = (((t + offset) % period) + period) % period;
  return smooth(0, ease, u) * (1 - smooth(len - ease, len, u));
}
