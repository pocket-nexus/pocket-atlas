import type { Line } from "../line";
import { KEI, type CarSpec, type CarState, type Controls } from "./vehicle";

/**
 * A driver for captures, measurements and the attract loop: pure pursuit
 * of a point ahead in the lane, at a speed held below what the bends allow
 * on snow. The handheld has the same driver (`pocket3d-drive`,
 * `autopilot.rs`).
 */
export function autopilot(c: CarState, line: Line, speed: number, lane: number, k: CarSpec = KEI, out: Controls = { steer: 0, throttle: 0, brake: 0 }): Controls {
  const v = Math.abs(c.vx);
  const look = 7 + v * 0.9;
  const p = line.at(c.s + look);
  const tx = p.x - p.tz * lane;
  const tz = p.z + p.tx * lane;
  let err = Math.atan2(tx - c.x, -(tz - c.z)) - c.heading;
  err = Math.atan2(Math.sin(err), Math.cos(err));
  // The wheel angle whose arc passes through the point.
  const wheel = Math.atan((2 * k.wheelbase * Math.sin(err)) / Math.max(look, 1));
  const lock = k.lock / (1 + (v / k.steerSpeed) * (v / k.steerSpeed));
  out.steer = Math.max(-1, Math.min(1, wheel / lock));
  // The bend ahead: heading change over the next 60 m.
  const a = line.at(c.s + 10);
  const ax = a.tx;
  const az = a.tz;
  const b = line.at(c.s + 70);
  const turn = Math.abs(Math.atan2(ax * b.tz - az * b.tx, ax * b.tx + az * b.tz)) / 60;
  const bend = turn > 1e-5 ? Math.sqrt((0.16 * 9.81) / turn) : Infinity;
  const e = Math.min(speed, bend) - c.vx;
  out.throttle = Math.max(0, Math.min(1, e * 0.6));
  out.brake = c.vx > 1 ? Math.max(0, Math.min(1, -e * 0.35 - 0.1)) : 0;
  return out;
}
