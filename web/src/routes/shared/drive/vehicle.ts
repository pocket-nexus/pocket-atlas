import type { Line, LinePoint, Projection } from "../line";

/**
 * The car: a single-track ("bicycle") model with saturating tyres on packed
 * snow, driven along the route's centre line. The handheld runs the same
 * model (`vita/src/drive/vehicle.rs`); `tests/vehicle-trace.json` holds a
 * trace both must reproduce, so keep the arithmetic and its order in step.
 *
 * Frame: x east, z south, heading 0 facing −Z (north) and growing clockwise
 * seen from above (toward +X). Body axes: forward, right.
 */

/** A light four-wheel-drive kei wagon on studless tyres. */
export const KEI = {
  mass: 940,
  /** Yaw inertia (kg m²). */
  inertia: 1250,
  wheelbase: 2.46,
  /** Centre of mass to the front and rear axles (m). */
  front: 1.1,
  rear: 1.36,
  /** Half the body width (m): 1.475 m wide. */
  halfWidth: 0.74,
  /** Body length ahead of and behind the centre of mass (m): 3.395 m long. */
  nose: 1.78,
  tail: 1.615,
  wheelRadius: 0.275,
  /** Engine power at the wheels (W) and the most force the driveline gives (N). */
  power: 31_000,
  force: 3_300,
  /** Brake force at full pedal on a grippy surface (N); the tyres limit it on snow. */
  brake: 7_800,
  /** Engine braking and driveline drag (N at speed), rolling resistance coefficient on packed snow, drag area × ½ρ (N per (m/s)²). */
  engineBrake: 260,
  rolling: 0.028,
  drag: 0.52,
  /** Cornering stiffness as slip-angle gain (per radian) at the tyres' peak. */
  stiffnessFront: 9.5,
  stiffnessRear: 11.5,
  /** Steering lock (rad), how fast the wheel turns (rad/s) and the speed (m/s) at which the usable lock has halved. */
  lock: 0.56,
  steerRate: 1.5,
  steerSpeed: 9,
  /** Top speed the limiter holds (m/s): 110 km/h; reverse (m/s). */
  top: 30.5,
  reverse: 6,
} as const;

export type CarSpec = typeof KEI;

/** What the road is under the car. */
export interface Surface {
  line: Line;
  /** Ploughed half width at an arc length (m). */
  half(s: number): number;
  /** Tyre–road friction at an arc length and offset. */
  grip(s: number, d: number): number;
}

export interface Controls {
  /** −1 full left … 1 full right. */
  steer: number;
  /** 0 … 1. */
  throttle: number;
  /** 0 … 1. Held at rest it selects reverse. */
  brake: number;
}

export interface CarState {
  x: number;
  z: number;
  /** Height of the road under the car and its grade along the car's heading. */
  y: number;
  pitch: number;
  /** Radians, 0 facing −Z, clockwise positive. */
  heading: number;
  /** Body velocity: forward and to the right (m/s). */
  vx: number;
  vy: number;
  /** Yaw rate (rad/s, clockwise positive). */
  yawRate: number;
  /** Front wheel angle (rad, right positive). */
  steer: number;
  /** Arc length and offset on the route, and the segment it is on. */
  s: number;
  d: number;
  segment: number;
  /** Accelerations for the body's lean and the sound: forward and to the right (m/s²). */
  ax: number;
  ay: number;
  /** Wheel rotation (rad) and the share of grip the tyres are using (0 … 1+). */
  wheel: number;
  slip: number;
  /** Seconds since the body last touched a bank, and how hard (m/s into the bank). */
  scrape: number;
  impact: number;
  reverse: boolean;
  /** Metres driven. */
  odometer: number;
}

const G = 9.81;
const SUBSTEP = 1 / 120;

export function startState(surface: Surface, s: number, d: number): CarState {
  const p = surface.line.at(s);
  return {
    x: p.x - p.tz * d,
    z: p.z + p.tx * d,
    y: p.y,
    pitch: 0,
    heading: Math.atan2(p.tx, -p.tz),
    vx: 0,
    vy: 0,
    yawRate: 0,
    steer: 0,
    s,
    d,
    segment: surface.line.segment(s),
    ax: 0,
    ay: 0,
    wheel: 0,
    slip: 0,
    scrape: 10,
    impact: 0,
    reverse: false,
    odometer: 0,
  };
}

/** Advances the car by `dt` seconds in fixed substeps. */
export function stepCar(c: CarState, input: Controls, surface: Surface, dt: number, spec: CarSpec = KEI): void {
  let left = Math.min(dt, 0.1);
  while (left > 1e-6) {
    const h = Math.min(SUBSTEP, left);
    substep(c, input, surface, h, spec);
    left -= h;
  }
}

const proj: Projection = { s: 0, d: 0, i: 0 };
const point: LinePoint = { x: 0, y: 0, z: 0, tx: 0, tz: -1, grade: 0 };

function substep(c: CarState, input: Controls, surface: Surface, h: number, k: CarSpec): void {
  const line = surface.line;
  // Steering: less lock at speed, the wheel turns at a finite rate.
  const speed = Math.abs(c.vx);
  const lock = k.lock / (1 + (speed / k.steerSpeed) * (speed / k.steerSpeed));
  const want = Math.max(-1, Math.min(1, input.steer)) * lock;
  const turn = k.steerRate * h;
  c.steer += Math.max(-turn, Math.min(turn, want - c.steer));

  // Gear: braking at rest selects reverse, throttle at rest selects forward.
  if (speed < 0.3) {
    if (input.brake > 0.5 && input.throttle < 0.1) c.reverse = true;
    else if (input.throttle > 0.1) c.reverse = false;
  }
  const dir = c.reverse ? -1 : 1;
  const throttle = c.reverse ? input.brake : input.throttle;
  const brake = c.reverse ? input.throttle : input.brake;

  const mu = surface.grip(c.s, c.d);
  const weight = k.mass * G;
  const fzf = (weight * k.rear) / k.wheelbase;
  const fzr = (weight * k.front) / k.wheelbase;

  // Longitudinal force at the tyres, limited by what the surface holds.
  const limit = c.reverse ? k.reverse : k.top;
  const along = c.vx * dir;
  let drive = throttle * Math.min(k.force, k.power / Math.max(along, 2.5));
  if (along > limit) drive = 0;
  let fx = dir * drive;
  if (brake > 0 && speed > 0.05) fx -= Math.sign(c.vx) * brake * k.brake;
  const grip = mu * weight;
  const fxUse = Math.max(-grip, Math.min(grip, fx));
  const spin = Math.abs(fx) > grip ? 1 : Math.abs(fx) / grip;
  // What is left of the friction circle for cornering.
  const side = Math.sqrt(Math.max(0.05, 1 - spin * spin * 0.85));

  // Slip angles and lateral forces.
  const vxs = Math.max(speed, 1.2);
  const sgn = c.vx < 0 ? -1 : 1;
  const af = Math.atan2(c.vy + k.front * c.yawRate, vxs) - c.steer * sgn;
  const ar = Math.atan2(c.vy - k.rear * c.yawRate, vxs);
  const fyf = -mu * fzf * side * Math.tanh(k.stiffnessFront * af);
  const fyr = -mu * fzr * side * Math.tanh(k.stiffnessRear * ar);
  c.slip = Math.max(spin, Math.abs(Math.tanh(k.stiffnessFront * af)), Math.abs(Math.tanh(k.stiffnessRear * ar)));

  // Resistances: engine braking off the throttle, rolling, air, and the grade.
  line.at(c.s, point);
  const hx = Math.sin(c.heading);
  const hz = -Math.cos(c.heading);
  const slope = point.grade * (hx * point.tx + hz * point.tz);
  let resist = k.rolling * weight + k.drag * c.vx * c.vx + (throttle < 0.05 ? k.engineBrake : 0);
  // Loose snow by the bank drags the wheels on that side.
  const half = surface.half(c.s);
  const room = half - k.halfWidth - Math.abs(c.d);
  const loose = Math.max(0, Math.min(1, 1 - room / 0.5));
  resist += loose * 0.05 * weight;
  const fxNet = fxUse - (speed > 0.05 ? Math.sign(c.vx) * resist : 0) - weight * slope;

  const cs = Math.cos(c.steer);
  const sn = Math.sin(c.steer);
  let ax = (fxNet - fyf * sn) / k.mass + c.vy * c.yawRate;
  let ay = (fyf * cs + fyr) / k.mass - c.vx * c.yawRate;
  let yawAcc = (k.front * fyf * cs - k.rear * fyr) / k.inertia;
  // The loose snow pulls the car toward the bank it runs along.
  yawAcc += loose * Math.sign(c.d) * 0.25 * Math.min(1, speed / 8);

  // At a crawl the tyres do not slide: the car follows its front wheels.
  const crawl = Math.max(0, 1 - speed / 2.5);
  if (crawl > 0) {
    const kin = (c.vx * Math.tan(c.steer)) / k.wheelbase;
    c.yawRate += (kin - c.yawRate) * crawl * Math.min(1, h * 12);
    c.vy += (0 - c.vy) * crawl * Math.min(1, h * 12);
    yawAcc *= 1 - crawl;
    ay *= 1 - crawl;
  }
  c.vx += ax * h;
  c.vy += ay * h;
  c.yawRate += yawAcc * h;
  // Brakes hold the car instead of pushing it backwards.
  if (brake > 0 && Math.abs(c.vx) < 0.15 && throttle < 0.05) c.vx = 0;
  if (speed < 0.05 && throttle < 0.02 && Math.abs(slope) < 0.03) c.vx = 0;
  c.heading += c.yawRate * h;

  // Body velocity into the world.
  const rx = -hz;
  const rz = hx;
  const wx = hx * c.vx + rx * c.vy;
  const wz = hz * c.vx + rz * c.vy;
  c.x += wx * h;
  c.z += wz * h;
  c.odometer += Math.abs(c.vx) * h;
  c.wheel += (c.vx / k.wheelRadius) * h;

  // Where that is on the road, and the banks.
  line.track(c.x, c.z, c.segment, 12, proj);
  c.segment = proj.i;
  c.s = proj.s;
  c.d = proj.d;
  c.scrape += h;
  c.impact = 0;
  const maxD = half - k.halfWidth;
  if (Math.abs(c.d) > maxD) {
    line.at(c.s, point);
    const nx = -point.tz * Math.sign(c.d);
    const nz = point.tx * Math.sign(c.d);
    const over = Math.abs(c.d) - maxD;
    c.x -= nx * over;
    c.z -= nz * over;
    c.d = Math.sign(c.d) * maxD;
    // Velocity into the bank is lost in the snow; sliding along it scrubs speed.
    const into = wx * nx + wz * nz;
    if (into > 0) {
      const tx = wx - nx * into;
      const tz = wz - nz * into;
      const keep = Math.max(0, 1 - 0.9 * h - Math.min(0.5, into * 0.06));
      const ux = tx * keep;
      const uz = tz * keep;
      c.vx = hx * ux + hz * uz;
      c.vy = rx * ux + rz * uz;
      // The nose is turned back along the bank.
      const alongBank = Math.atan2(point.tx, -point.tz) + (c.vx < 0 ? Math.PI : 0);
      let off = alongBank - c.heading;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      if (Math.abs(off) < 1.2) {
        c.heading += off * Math.min(1, h * 2.5);
        c.yawRate *= Math.max(0, 1 - h * 6);
      }
      c.scrape = 0;
      c.impact = into;
    }
  }
  // The ends of the road.
  if (c.s <= 0.5 && wx * point.tx + wz * point.tz < 0) {
    c.vx = Math.max(0, c.vx);
  }
  line.at(c.s, point);
  c.y = point.y - 0.02 * Math.abs(c.d);
  c.pitch = Math.atan(point.grade * (hx * point.tx + hz * point.tz));
  c.ax = ax - c.vy * c.yawRate;
  c.ay = ay + c.vx * c.yawRate;
}
