import type { DriveRoute, RouteSample } from "./types";

/** The portable domain simulation. Keep formulas and constants in sync with pocket3d-drive. */
export const DRIVE_STEP = 1 / 60;
export const FUEL_CAPACITY = 40;
const WHEELBASE = 2.43;
const BANK_EDGE = 5.8;
const LANE_OFFSET = -1.6;

export interface DriveInput {
  throttle: number;
  brake: number;
  /** Positive turns right. */
  steer: number;
  reverse?: boolean;
  interact?: boolean;
  recover?: boolean;
}

/** A complete versioned save. No renderer, wall clock, RNG or platform handles enter this state. */
export interface DriveState {
  version: 1;
  routeId: string;
  x: number; y: number; z: number;
  /** Three.js Y rotation, vehicle forward is local -Z. */
  yaw: number;
  /** Signed longitudinal metres/second. vx/vz retain lateral snow slip. */
  speed: number; vx: number; vz: number; steer: number;
  s: number;
  odometer: number;
  elapsed: number;
  fuel: number;
  damage: number;
  nextStop: number;
  completed: boolean;
  penaltySeconds: number;
  recoveries: number;
  checkpointS: number;
  accumulator: number;
  interactHeld: boolean;
  recoverHeld: boolean;
}

export interface RouteProjection extends RouteSample { distance: number; lateral: number; segment: number }
export interface RoadBounds { left: number; right: number; clearedLeft: number; clearedRight: number; layby: number }
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const finiteInput = (n: number, a: number, b: number) => Number.isFinite(n) ? clamp(n, a, b) : 0;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (a: number, b: number, d: number) => a < b ? Math.min(a + d, b) : Math.max(a - d, b);

/** Metres from the route centre, positive right. Scenery and collision share this apron taper. */
export function roadBounds(route: DriveRoute, s: number): RoadBounds {
  let layby = 0;
  for (const stop of route.stops) layby = Math.max(layby, clamp((44 - Math.abs(s - stop.s)) / 20, 0, 1));
  return { left: -BANK_EDGE - 7 * layby, right: BANK_EDGE, clearedLeft: -(3.3 + 9.5 * layby), clearedRight: 3.3, layby };
}

/** Compiler/save boundary validation; ordinary frame steps assume a validated route. */
export function validateRoute(route: DriveRoute): boolean {
  if (route.version !== 1 || typeof route.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route.id) || route.id.length > 80 || !Number.isFinite(route.distance_scale) || route.distance_scale <= 0 ||
      !Array.isArray(route.origin) || route.origin.length !== 2 || !route.origin.every(Number.isFinite) ||
      !Array.isArray(route.points) || route.points.length < 2 || !Array.isArray(route.stops) || !route.stops.length) return false;
  let previousS = -1, previousReal = -1;
  for (let i = 0; i < route.points.length; i++) {
    const p = route.points[i];
    if (![p.s, p.real_m, p.x, p.y, p.z].every(Number.isFinite) || p.s <= previousS || p.real_m <= previousReal ||
        (i === 0 && (p.s !== 0 || p.real_m !== 0)) || (i > 0 && Math.hypot(p.x - route.points[i - 1].x, p.z - route.points[i - 1].z) < 0.001)) return false;
    previousS = p.s; previousReal = p.real_m;
  }
  const ids = new Set<string>();
  let stopS = -1;
  for (const [i, stop] of route.stops.entries()) {
    if (!stop.id || ids.has(stop.id) || !Number.isFinite(stop.s) || stop.s < 0 || stop.s <= stopS || stop.s > previousS ||
        !Number.isFinite(stop.radius) || stop.radius < 2 || stop.radius > 100 ||
        !["delivery", "service", "finish"].includes(stop.kind) || (stop.kind === "finish") !== (i === route.stops.length - 1)) return false;
    ids.add(stop.id); stopS = stop.s;
  }
  return true;
}

function segmentSample(route: DriveRoute, i: number, t: number): RouteSample {
  const a = route.points[i], b = route.points[i + 1];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
  return {
    s: a.s + (b.s - a.s) * t, real_m: a.real_m + (b.real_m - a.real_m) * t,
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
    dx, dz, yaw: Math.atan2(-dx, -dz),
  };
}

export function sampleRoute(route: DriveRoute, s: number): RouteSample {
  const target = clamp(Number.isFinite(s) ? s : 0, 0, route.points[route.points.length - 1].s);
  let lo = 0, hi = route.points.length - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (route.points[mid].s <= target) lo = mid; else hi = mid; }
  const a = route.points[lo], b = route.points[lo + 1];
  return segmentSample(route, lo, (target - a.s) / (b.s - a.s));
}

/** Positive raises a vehicle's local -Z nose; visual pose follows the surveyed road grade. */
export function routePitch(route: DriveRoute, s: number): number {
  const a = sampleRoute(route, s - 2), b = sampleRoute(route, s + 2);
  return Math.atan2(b.y - a.y, Math.max(0.001, Math.hypot(b.x - a.x, b.z - a.z)));
}

/** Hinted projection stays on the current branch at crossings; teleports use global fallback. */
export function projectRoute(route: DriveRoute, x: number, z: number, hintS?: number): RouteProjection {
  let best: RouteProjection | undefined;
  const search = (hint: number | undefined) => {
    for (let i = 0; i + 1 < route.points.length; i++) {
      const a = route.points[i], b = route.points[i + 1];
      if (hint !== undefined && (b.s < hint - 150 || a.s > hint + 150)) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
      const p = segmentSample(route, i, t), distance = Math.hypot(x - p.x, z - p.z);
      if (!best || distance < best.distance) best = { ...p, distance, lateral: (x - p.x) * -p.dz + (z - p.z) * p.dx, segment: i };
    }
  };
  search(hintS);
  if (!best || best.distance > 50) { best = undefined; search(undefined); }
  return best!;
}

export function initialState(route: DriveRoute): DriveState {
  if (!validateRoute(route)) throw new Error("Invalid driving route");
  const p = sampleRoute(route, 0);
  return {
    version: 1, routeId: route.id, x: p.x - p.dz * LANE_OFFSET, y: p.y, z: p.z + p.dx * LANE_OFFSET, yaw: p.yaw,
    speed: 0, vx: 0, vz: 0, steer: 0, s: 0, odometer: 0, elapsed: 0, fuel: 12, damage: 0,
    nextStop: 0, completed: false, penaltySeconds: 0, recoveries: 0, checkpointS: 0,
    accumulator: 0, interactHeld: false, recoverHeld: false,
  };
}

function recover(route: DriveRoute, state: DriveState): void {
  const pending = route.stops[state.nextStop];
  const s = Math.min(state.checkpointS, pending ? Math.max(0, pending.s - 8) : state.checkpointS);
  const p = sampleRoute(route, s);
  state.x = p.x - p.dz * LANE_OFFSET; state.y = p.y; state.z = p.z + p.dx * LANE_OFFSET;
  state.yaw = p.yaw; state.s = s; state.speed = state.vx = state.vz = state.steer = 0;
  state.fuel = Math.max(state.fuel, 5); state.damage = Math.min(state.damage, 35);
  state.penaltySeconds += 180; state.recoveries++;
}

function fixedStep(route: DriveRoute, state: DriveState, input: DriveInput): void {
  const interact = !!input.interact && !state.interactHeld, recovery = !!input.recover && !state.recoverHeld;
  state.interactHeld = !!input.interact; state.recoverHeld = !!input.recover;
  if (state.completed) return;
  state.elapsed += DRIVE_STEP;
  if (recovery) { recover(route, state); return; }
  const before = projectRoute(route, state.x, state.z, state.s);
  const cleared = roadBounds(route, before.s);
  const offroad = clamp(Math.max(cleared.clearedLeft - before.lateral, before.lateral - cleared.clearedRight) / 1.8, 0, 1);
  const throttle = finiteInput(input.throttle, 0, 1), brake = finiteInput(input.brake, 0, 1);
  const steering = finiteInput(input.steer, -1, 1);
  state.steer = approach(state.steer, steering, DRIVE_STEP * 2.2);
  const forwardX = -Math.sin(state.yaw), forwardZ = -Math.cos(state.yaw);
  const rightX = Math.cos(state.yaw), rightZ = -Math.sin(state.yaw);
  let longitudinal = state.vx * forwardX + state.vz * forwardZ;
  let lateral = state.vx * rightX + state.vz * rightZ;
  const gear = input.reverse ? -1 : 1;
  const gearBrake = longitudinal * gear < -0.25 ? throttle : 0;
  const engine = state.fuel > 0 && state.damage < 100 && gearBrake === 0 ? throttle * gear * (2.6 - Math.min(1.8, Math.abs(longitudinal) * 0.06)) * (1 - state.damage * 0.006) : 0;
  const rolling = 0.17 + 0.0045 * longitudinal * longitudinal + offroad * (1.1 + Math.abs(longitudinal) * 0.28);
  longitudinal += engine * DRIVE_STEP;
  longitudinal = approach(longitudinal, 0, (rolling + Math.max(brake, gearBrake) * 4.2) * DRIVE_STEP);
  longitudinal = clamp(longitudinal, -7, 27);
  if (Math.abs(longitudinal) < 0.025 && throttle === 0) longitudinal = 0;
  // Snow tyres have finite lateral force: high-speed steering slides instead of following a rail.
  const wheelAngle = state.steer * 0.48 / (1 + Math.abs(longitudinal) * 0.035);
  const requestedYawRate = -longitudinal * Math.tan(wheelAngle) / WHEELBASE;
  const gripAcceleration = 3.5 - offroad * 1.9;
  const yawRate = clamp(requestedYawRate, -gripAcceleration / Math.max(Math.abs(longitudinal), 1), gripAcceleration / Math.max(Math.abs(longitudinal), 1));
  lateral = approach(lateral, 0, gripAcceleration * DRIVE_STEP);
  state.vx = forwardX * longitudinal + rightX * lateral;
  state.vz = forwardZ * longitudinal + rightZ * lateral;
  state.yaw = wrap(state.yaw + yawRate * DRIVE_STEP);
  const oldX = state.x, oldZ = state.z;
  state.x += state.vx * DRIVE_STEP; state.z += state.vz * DRIVE_STEP;
  let p = projectRoute(route, state.x, state.z, state.s);
  const bounds = roadBounds(route, p.s);
  const excess = p.lateral - clamp(p.lateral, bounds.left, bounds.right);
  if (excess !== 0) {
    const side = Math.sign(excess), nx = -p.dz * side, nz = p.dx * side;
    const impact = Math.max(0, state.vx * nx + state.vz * nz);
    state.x -= nx * Math.abs(excess);
    state.z -= nz * Math.abs(excess);
    state.vx -= nx * impact * 1.15; state.vz -= nz * impact * 1.15;
    state.vx *= 0.72; state.vz *= 0.72;
    state.damage = Math.min(100, state.damage + Math.max(0, impact - 0.6) * 3.5);
    p = projectRoute(route, state.x, state.z, state.s);
  }
  // Route endpoints are snowed-in forecourts; the playable corridor cannot be escaped longitudinally.
  const endBounds = roadBounds(route, p.s), edge = p.lateral < 0 ? -endBounds.left : endBounds.right;
  if (p.distance > edge + 1) {
    const distance = Math.hypot(state.x - p.x, state.z - p.z);
    const scale = edge / distance;
    state.x = p.x + (state.x - p.x) * scale; state.z = p.z + (state.z - p.z) * scale;
    state.vx *= -0.1; state.vz *= -0.1;
  }
  state.speed = state.vx * -Math.sin(state.yaw) + state.vz * -Math.cos(state.yaw);
  state.s = p.s; state.y = p.y;
  const travelled = Math.hypot(state.x - oldX, state.z - oldZ);
  state.odometer += travelled;
  state.fuel = Math.max(0, state.fuel - (travelled * 0.00012 + DRIVE_STEP * 0.00008) * (1 + offroad));
  const pending = route.stops[state.nextStop];
  if (pending && Math.abs(state.speed) < 0.75 && Math.hypot(state.vx, state.vz) < 0.9 && interact) {
    const target = sampleRoute(route, pending.s);
    if (Math.hypot(state.x - target.x, state.z - target.z) <= pending.radius) {
      if (pending.kind === "service") { state.fuel = FUEL_CAPACITY; state.damage = 0; }
      state.nextStop++;
      state.checkpointS = pending.s;
      if (pending.kind === "finish") { state.completed = true; state.speed = state.vx = state.vz = 0; }
    }
  }
  const next = route.stops[state.nextStop];
  const checkpoint = Math.floor(state.s / 250) * 250;
  if (Math.abs(p.lateral) < 3 && checkpoint > state.checkpointS && (!next || checkpoint < next.s - 8)) state.checkpointS = checkpoint;
}

/** Mutates and returns state. Pauses/stalls cannot inject more than 250 ms of simulation. */
export function stepDrive(route: DriveRoute, state: DriveState, input: DriveInput, dt: number): DriveState {
  if (!Number.isFinite(dt) || dt <= 0) return state;
  state.accumulator += Math.min(dt, 0.25);
  while (state.accumulator + 1e-12 >= DRIVE_STEP) {
    fixedStep(route, state, input);
    state.accumulator = Math.max(0, state.accumulator - DRIVE_STEP);
  }
  return state;
}

/** Invalid/cross-route/inconsistent saves are rejected, never partially installed. */
export function restoreState(route: DriveRoute, value: unknown): DriveState | null {
  if (!validateRoute(route) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as DriveState;
  const fields = [s.x, s.y, s.z, s.yaw, s.speed, s.vx, s.vz, s.steer, s.s, s.odometer, s.elapsed, s.fuel, s.damage,
    s.nextStop, s.penaltySeconds, s.recoveries, s.checkpointS, s.accumulator];
  if (s.version !== 1 || s.routeId !== route.id || !fields.every(n => typeof n === "number" && Number.isFinite(n)) ||
      typeof s.completed !== "boolean" || typeof s.interactHeld !== "boolean" || typeof s.recoverHeld !== "boolean") return null;
  const end = route.points[route.points.length - 1].s;
  if (s.s < 0 || s.s > end || s.checkpointS < 0 || s.checkpointS > end || s.odometer < 0 || s.elapsed < 0 ||
      s.fuel < 0 || s.fuel > FUEL_CAPACITY || s.damage < 0 || s.damage > 100 || Math.abs(s.steer) > 1 ||
      Math.abs(s.yaw) > Math.PI + 1e-9 || Math.abs(s.speed) > 28 || Math.hypot(s.vx, s.vz) > 29 ||
      s.accumulator < 0 || s.accumulator >= DRIVE_STEP || s.penaltySeconds < 0 || !Number.isInteger(s.recoveries) || s.recoveries < 0 ||
      !Number.isInteger(s.nextStop) || s.nextStop < 0 || s.nextStop > route.stops.length ||
      s.completed !== (s.nextStop === route.stops.length) || s.penaltySeconds !== s.recoveries * 180) return null;
  const p = projectRoute(route, s.x, s.z, s.s);
  const bounds = roadBounds(route, p.s), edge = p.lateral < 0 ? -bounds.left : bounds.right;
  if (p.lateral < bounds.left - 0.15 || p.lateral > bounds.right + 0.15 || p.distance > edge + 1.1 || Math.abs(p.s - s.s) > 1 || Math.abs(p.y - s.y) > 1 ||
      Math.abs(s.speed - (s.vx * -Math.sin(s.yaw) + s.vz * -Math.cos(s.yaw))) > 0.01 ||
      (s.nextStop < route.stops.length && s.checkpointS > route.stops[s.nextStop].s) ||
      (s.nextStop > 0 && s.checkpointS < route.stops[s.nextStop - 1].s) ||
      (s.completed && Math.abs(s.s - route.stops[route.stops.length - 1].s) > route.stops[route.stops.length - 1].radius + 1)) return null;
  return { ...s };
}
