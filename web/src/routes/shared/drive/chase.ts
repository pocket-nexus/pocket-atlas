import type { CarState } from "./vehicle";

/**
 * The driving cameras, as plain numbers: where the eye is and what it looks
 * at for a car state. `chase` trails the car and swings behind it with a
 * lag; `hood` rides on the bonnet. The handheld uses the same rig
 * (`vita/src/drive/chase.rs`).
 */
export type DriveView = "chase" | "hood";

export interface Eye {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface ChaseState {
  /** The heading the camera trails along (rad, the car's convention). */
  yaw: number;
  /** Smoothed speed (m/s) for the pull-back and the field of view. */
  speed: number;
  ready: boolean;
}

export function newChase(): ChaseState {
  return { yaw: 0, speed: 0, ready: false };
}

export function stepChase(k: ChaseState, c: CarState, view: DriveView, dt: number, out: Eye): Eye {
  if (!k.ready) {
    k.yaw = c.heading;
    k.speed = Math.abs(c.vx);
    k.ready = true;
  }
  // Trail the direction of travel rather than the nose: a slide shows as a slide.
  const drift = Math.abs(c.vx) > 2 ? Math.atan2(c.vy, Math.abs(c.vx)) * 0.5 : 0;
  let off = c.heading + drift - k.yaw;
  off = Math.atan2(Math.sin(off), Math.cos(off));
  k.yaw += off * (1 - Math.exp(-dt * 3.4));
  k.speed += (Math.abs(c.vx) - k.speed) * (1 - Math.exp(-dt * 1.5));
  const fx = Math.sin(k.yaw);
  const fz = -Math.cos(k.yaw);
  const hx = Math.sin(c.heading);
  const hz = -Math.cos(c.heading);
  if (view === "hood") {
    out.pos[0] = c.x + hx * 0.15;
    out.pos[1] = c.y + 1.32;
    out.pos[2] = c.z + hz * 0.15;
    out.target[0] = c.x + hx * 30;
    out.target[1] = c.y + 1.32 + Math.sin(c.pitch) * 30 - 1.4;
    out.target[2] = c.z + hz * 30;
    out.fov = 58 + Math.min(8, k.speed * 0.25);
    return out;
  }
  const back = 5.4 + Math.min(1.6, k.speed * 0.05);
  out.pos[0] = c.x - fx * back;
  out.pos[1] = c.y + 2.25 + Math.sin(c.pitch) * -back * 0.4;
  out.pos[2] = c.z - fz * back;
  out.target[0] = c.x + fx * 7;
  out.target[1] = c.y + 1.05 + Math.sin(c.pitch) * 7;
  out.target[2] = c.z + fz * 7;
  out.fov = 50 + Math.min(9, k.speed * 0.3);
  return out;
}
