import type { CarState } from "./vehicle";

/**
 * Other vehicles on the driven road: a few oncoming in the right-hand lane
 * (as the driver sees it) and now and then a slower one ahead in the
 * driver's own. They keep to their lane at a steady speed and are placed
 * again, further on, once the driver has left them behind. Meeting one
 * stops both. The handheld runs the same traffic (`pocket3d-drive`,
 * `traffic.rs`) from the same seed.
 */
export interface TrafficCar {
  /** Arc length and offset on the driven line (m). */
  s: number;
  d: number;
  /** Speed along the line (m/s): negative for oncoming. */
  v: number;
  /** Which of the kit's traffic bodies it wears. */
  body: number;
  /** Seconds it still waits after a collision. */
  wait: number;
}

export interface Traffic {
  cars: TrafficCar[];
  seed: number;
}

/** Vehicles alive at once, and the kit's traffic bodies. */
export const TRAFFIC_CARS = 5;
export const TRAFFIC_BODIES = 4;
/** Lane centre (m from the centre line) and the window around the driver traffic lives in. */
const LANE = 1.7;
const BEHIND = 260;
const AHEAD = 1500;

function rnd(t: Traffic): number {
  let s = t.seed | 0;
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  t.seed = s;
  return (s >>> 0) / 4294967296;
}

function place(t: Traffic, c: TrafficCar, driver: number, length: number, first: boolean): void {
  const oncoming = rnd(t) < 0.72;
  const far = first ? 250 + rnd(t) * (AHEAD - 250) : AHEAD - rnd(t) * 300;
  c.d = oncoming ? LANE : -LANE;
  c.v = oncoming ? -(11 + rnd(t) * 5) : 8.5 + rnd(t) * 3;
  c.body = Math.floor(rnd(t) * TRAFFIC_BODIES) % TRAFFIC_BODIES;
  c.wait = 0;
  // Near the end of the road nothing more sets out: the car is parked off it (s < 0).
  c.s = driver + far > length - 60 ? -1 : driver + far;
}

export function newTraffic(driver: number, length: number): Traffic {
  const t: Traffic = { cars: [], seed: 0x51ed270b };
  for (let i = 0; i < TRAFFIC_CARS; i++) {
    const c: TrafficCar = { s: 0, d: 0, v: 0, body: 0, wait: 0 };
    place(t, c, driver, length, true);
    t.cars.push(c);
  }
  return t;
}

/** Advances the traffic; returns true when the driver has just run into one of them (the caller stops the driver). */
export function stepTraffic(t: Traffic, driver: CarState, length: number, dt: number): boolean {
  let hit = false;
  for (const c of t.cars) {
    if (c.s < 0) continue;
    if (c.wait > 0) c.wait -= dt;
    else c.s += c.v * dt;
    const ds = c.s - driver.s;
    if (Math.abs(ds) < 3.5 && Math.abs(c.d - driver.d) < 1.5 && c.wait <= 0 && Math.abs(driver.vx - c.v) > 1) {
      hit = true;
      c.wait = 4;
    }
    if (ds < -BEHIND || ds > AHEAD + 100 || c.s < 20 || c.s > length - 20) place(t, c, driver.s, length, false);
  }
  return hit;
}
