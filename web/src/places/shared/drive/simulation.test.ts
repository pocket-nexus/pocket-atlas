import { describe, expect, test } from "bun:test";
import { DRIVE_STEP, initialState, projectRoute, restoreState, roadBounds, sampleRoute, stepDrive, validateRoute, type DriveInput, type DriveState } from "./simulation";
import type { DriveRoute } from "./types";

function routeFixture(angle = 0, offsetX = 0, offsetZ = 0): DriveRoute {
  const points: DriveRoute["points"] = [];
  let s = 0;
  for (let i = 0; i <= 160; i++) {
    const x = Math.sin(i / 23) * 45, z = -i * 10;
    if (i) { const p = points[i - 1]; const px = offsetX + x * Math.cos(angle) + z * Math.sin(angle), pz = offsetZ - x * Math.sin(angle) + z * Math.cos(angle); s += Math.hypot(px - p.x, pz - p.z); }
    points.push({ s, real_m: s / 0.7, x: offsetX + x * Math.cos(angle) + z * Math.sin(angle), y: Math.sin(i / 50) * 2, z: offsetZ - x * Math.sin(angle) + z * Math.cos(angle) });
  }
  return { version: 1, id: "test-rural-road", title: "Curved rural road", origin: [142, 43], distance_scale: 0.7, points,
    stops: [{ id: "parcel", name: "Parcel", s: 90, kind: "delivery", radius: 7 }, { id: "service", name: "Service", s: 470, kind: "service", radius: 7 },
      { id: "village", name: "Village", s: 1050, kind: "delivery", radius: 7 }, { id: "end", name: "Finish", s, kind: "finish", radius: 8 }], attribution: "Test geometry" };
}
const idle: DriveInput = { throttle: 0, brake: 0, steer: 0 };
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const wrap = (n: number) => Math.atan2(Math.sin(n), Math.cos(n));
const cornerCache = new WeakMap<DriveRoute, { s: number; speed: number }[]>();

/** Controller reads route/telemetry and only emits player inputs; never edits state or position. */
function controller(route: DriveRoute, state: DriveState): DriveInput {
  const pending = route.stops[state.nextStop];
  if (!pending) return idle;
  let corners = cornerCache.get(route);
  if (!corners) {
    corners = route.points.slice(1, -1).map((p, i) => {
      const a = route.points[i], b = route.points[i + 2];
      const angle = Math.abs(wrap(Math.atan2(b.x - p.x, b.z - p.z) - Math.atan2(p.x - a.x, p.z - a.z)));
      return { s: p.s, speed: Math.min(12, Math.sqrt(4.5 / Math.max(0.02, Math.tan(angle / 2)))) };
    });
    cornerCache.set(route, corners);
  }
  const look = sampleRoute(route, state.s + 3 + Math.max(0, state.speed) * 0.5);
  const tx = look.x + look.dz * 1.6, tz = look.z - look.dx * 1.6;
  const desiredYaw = Math.atan2(-(tx - state.x), -(tz - state.z));
  const error = wrap(desiredYaw - state.yaw);
  const remaining = pending.s - state.s;
  let targetSpeed = Math.min(12, Math.sqrt(Math.max(0, remaining - 2) * 4.8));
  for (const corner of corners) if (corner.s >= state.s - 6 && corner.s <= state.s + 100) {
    targetSpeed = Math.min(targetSpeed, Math.sqrt(corner.speed ** 2 + 4.8 * Math.max(0, corner.s - state.s - 12)));
  }
  const target = sampleRoute(route, pending.s);
  const inRange = Math.hypot(state.x - target.x, state.z - target.z) < pending.radius;
  const stop = inRange && remaining < 4;
  return { throttle: !stop && state.speed < targetSpeed - 0.1 ? 1 : 0,
    brake: stop || state.speed > targetSpeed + 0.15 ? 0.85 : 0,
    steer: clamp(-error * 2.8, -1, 1), interact: inRange && Math.abs(state.speed) < 0.4 };
}

describe("portable winter driving", () => {
  test("completes a curved route with ordered deliveries, service and finish from ordinary inputs", () => {
    for (const route of [routeFixture(), routeFixture(1.7, 4300, -8100)]) {
      let state = initialState(route);
      let saved = false;
      for (let frame = 0; frame < 60 * 250 && !state.completed; frame++) {
        stepDrive(route, state, controller(route, state), DRIVE_STEP);
        if (!saved && state.nextStop === 2) {
          const restored = restoreState(route, JSON.parse(JSON.stringify(state)));
          expect(restored).not.toBeNull(); state = restored!; saved = true;
        }
      }
      expect(state.completed).toBe(true);
      expect(state.nextStop).toBe(4);
      expect(state.s).toBeGreaterThan(route.points.at(-1)!.s - 8);
      expect(state.damage).toBeLessThan(1);
      expect(state.recoveries).toBe(0);
      expect(state.odometer).toBeGreaterThan(1500);
      expect(state.fuel).toBeGreaterThan(35);
      expect(saved).toBe(true);
      expect(restoreState(route, state)).not.toBeNull();
    }
  });

  test("bicycle motion permits leaving the lane, snowbank collision, braking and reverse", () => {
    const route = routeFixture();
    const state = initialState(route);
    for (let i = 0; i < 600; i++) stepDrive(route, state, { throttle: 1, brake: 0, steer: i > 180 ? 0.8 : 0 }, DRIVE_STEP);
    expect(Math.abs(projectRoute(route, state.x, state.z).lateral)).toBeGreaterThan(3.2);
    expect(state.damage).toBeGreaterThan(0);
    for (let i = 0; i < 240; i++) stepDrive(route, state, { ...idle, brake: 1 }, DRIVE_STEP);
    expect(Math.abs(state.speed)).toBeLessThan(0.03);
    stepDrive(route, state, { ...idle, recover: true }, DRIVE_STEP);
    const originS = state.s;
    // Begin away from the first endpoint, then reverse through previously traversed road.
    for (let i = 0; i < 240; i++) stepDrive(route, state, { ...idle, throttle: 1 }, DRIVE_STEP);
    const forwardS = state.s;
    for (let i = 0; i < 300; i++) stepDrive(route, state, { ...idle, throttle: 1, reverse: true }, DRIVE_STEP);
    expect(state.speed).toBeLessThan(-1);
    expect(state.s).toBeLessThan(forwardS + 5);
    expect(forwardS).toBeGreaterThan(originS + 5);
  });

  test("fixed stepping is invariant to 30/60 Hz presentation and caps resumed tabs", () => {
    const route = routeFixture(), a = initialState(route), b = initialState(route), input = { ...idle, throttle: 1 };
    for (let i = 0; i < 300; i++) stepDrive(route, a, input, 1 / 30);
    for (let i = 0; i < 600; i++) stepDrive(route, b, input, 1 / 60);
    expect(a).toEqual(b);
    const before = a.elapsed;
    stepDrive(route, a, idle, 3600);
    expect(a.elapsed - before).toBeCloseTo(0.25, 10);
    const copy = { ...a }; stepDrive(route, a, idle, NaN); expect(a).toEqual(copy);
  });

  test("delivery laybys accept parked saves and ordinary entry, with the same outer snowbank in Rust", () => {
    for (const route of [routeFixture(), routeFixture(1.7, 4300, -8100)]) {
      route.stops[0].radius = 24;
      const positioned = (s: number, lateral: number) => {
        const p = sampleRoute(route, s), state = initialState(route);
        Object.assign(state, { s, x: p.x - p.dz * lateral, y: p.y, z: p.z + p.dx * lateral, yaw: wrap(p.yaw + Math.PI / 2) });
        return state;
      };
      // A car facing into the apron starts in the traffic lane. Only inputs move it thereafter.
      const start = positioned(90, -1.6), state = { ...start }, trace: DriveState[] = [];
      const steps = [
        { input: { ...idle, throttle: 1 }, dt: DRIVE_STEP, frames: 135 },
        { input: { ...idle, brake: 1 }, dt: DRIVE_STEP, frames: 120 },
        { input: { ...idle, interact: true }, dt: DRIVE_STEP, frames: 1 },
        { input: { ...idle, throttle: 1 }, dt: DRIVE_STEP, frames: 200 },
      ];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        for (let frame = 0; frame < step.frames; frame++) stepDrive(route, state, step.input, step.dt);
        trace.push({ ...state });
        if (i === 1) {
          expect(projectRoute(route, state.x, state.z, state.s).lateral).toBeLessThan(-8);
          expect(Math.abs(state.speed)).toBeLessThan(0.03);
          expect(state.damage).toBe(0);
          const saved = JSON.parse(JSON.stringify(state));
          expect(restoreState(route, saved)).toEqual(saved);
        }
        if (i === 2) expect(state.nextStop).toBe(1);
      }
      const p = projectRoute(route, state.x, state.z, state.s), bounds = roadBounds(route, p.s);
      expect(p.lateral).toBeGreaterThanOrEqual(bounds.left - 0.02);
      expect(state.damage).toBeGreaterThan(0);
      expect(restoreState(route, state)).not.toBeNull();
      expect(restoreState(route, positioned(90, -12))).not.toBeNull();
      for (const invalid of [positioned(90, -13.2), positioned(90, 6.2), positioned(30, -8)]) expect(restoreState(route, invalid)).toBeNull();
      const result = Bun.spawnSync(["cargo", "run", "--quiet", "-p", "pocket3d-drive", "--bin", "drive-oracle"], {
        cwd: new URL("../../../../../", import.meta.url).pathname,
        stdin: new TextEncoder().encode(JSON.stringify({ route, state: start, steps, trace: true })), stdout: "pipe", stderr: "pipe",
      });
      expect(new TextDecoder().decode(result.stderr)).toBe(""); expect(result.exitCode).toBe(0);
      const native = JSON.parse(new TextDecoder().decode(result.stdout));
      for (let i = 0; i < trace.length; i++) for (const key of Object.keys(trace[i]) as (keyof DriveState)[]) {
        const a = trace[i][key], b = native.trace[i][key];
        if (typeof a === "number") expect(b).toBeCloseTo(a, 7); else expect(b).toEqual(a);
      }
    }
  }, 120_000);

  test("recovery cannot skip ordered jobs and prevents an empty-fuel/damaged softlock", () => {
    const route = routeFixture(), state = initialState(route);
    state.fuel = 0; state.damage = 100;
    for (let i = 0; i < 120; i++) stepDrive(route, state, { ...idle, throttle: 1 }, DRIVE_STEP);
    expect(state.s).toBe(0);
    for (let i = 0; i < 90; i++) stepDrive(route, state, { ...idle, recover: true }, DRIVE_STEP);
    expect(state.recoveries).toBe(1); expect(state.penaltySeconds).toBe(180);
    expect(state.fuel).toBeGreaterThan(4.9); expect(state.damage).toBe(35);
    expect(state.nextStop).toBe(0); expect(state.completed).toBe(false);
    expect(restoreState(route, state)).not.toBeNull();
  });

  test("save validation rejects foreign, malformed, nonfinite and internally inconsistent state", () => {
    const route = routeFixture(), state = initialState(route);
    for (let i = 0; i < 150; i++) stepDrive(route, state, { ...idle, throttle: 1 }, DRIVE_STEP);
    expect(restoreState(route, JSON.parse(JSON.stringify(state)))).toEqual(state);
    for (const invalid of [null, {}, { ...state, routeId: "foreign" }, { ...state, x: NaN }, { ...state, x: state.x + 300 },
      { ...state, fuel: -1 }, { ...state, nextStop: 20 }, { ...state, nextStop: 2.5 }, { ...state, completed: true },
      { ...state, checkpointS: 1000 }, { ...state, penaltySeconds: 10 }, { ...state, speed: 24 }]) expect(restoreState(route, invalid)).toBeNull();
    expect(validateRoute({ ...route, points: [route.points[0], route.points[0]] })).toBe(false);
    expect(validateRoute({ ...route, stops: [...route.stops].reverse() })).toBe(false);
    for (const id of ["../other", "Route", "a--b", "a/b", "-route", "route-", ""]) expect(validateRoute({ ...route, id })).toBe(false);
  });

  test("completes the full surveyed Hokkaido mission and replays the same inputs in Rust", async () => {
    const route = (await import("../../hokkaido-winter-drive/data/route.json")).default as DriveRoute;
    let state = initialState(route);
    const steps: { input: DriveInput; dt: number }[] = [];
    const visits: string[] = [];
    for (let frame = 0; frame < 60 * 3600 && !state.completed; frame++) {
      const previousStop = state.nextStop, input = controller(route, state);
      stepDrive(route, state, input, DRIVE_STEP); steps.push({ input, dt: DRIVE_STEP });
      if (state.nextStop !== previousStop) {
        visits.push(route.stops[previousStop].id);
        const restored = restoreState(route, JSON.parse(JSON.stringify(state)));
        expect(restored).not.toBeNull(); state = restored!;
      }
    }
    expect(state.completed).toBe(true);
    expect(visits).toEqual(route.stops.map(stop => stop.id));
    expect(state.odometer).toBeGreaterThan(23_000);
    expect(state.recoveries).toBe(0); expect(state.damage).toBe(0);
    const result = Bun.spawnSync(["cargo", "run", "--quiet", "-p", "pocket3d-drive", "--bin", "drive-oracle"], {
      cwd: new URL("../../../../../", import.meta.url).pathname,
      stdin: new TextEncoder().encode(JSON.stringify({ route, steps })), stdout: "pipe", stderr: "pipe",
    });
    expect(new TextDecoder().decode(result.stderr)).toBe(""); expect(result.exitCode).toBe(0);
    const native = JSON.parse(new TextDecoder().decode(result.stdout)).state;
    for (const key of Object.keys(state) as (keyof DriveState)[]) {
      const a = state[key], b = native[key];
      if (typeof a === "number") expect(b).toBeCloseTo(a, 7); else expect(b).toEqual(a);
    }
  }, 120_000);

  test("TS and native Rust replay agree through steering, a collision, recovery and reverse", () => {
    const route = routeFixture();
    const steps = [
      { input: { ...idle, throttle: 1 }, dt: 1 / 30, frames: 240 },
      { input: { ...idle, throttle: 1, steer: 0.8 }, dt: 1 / 60, frames: 360 },
      { input: { ...idle, recover: true }, dt: 1 / 60, frames: 1 },
      { input: { ...idle, throttle: 1 }, dt: 1 / 60, frames: 150 },
      { input: { ...idle, throttle: 1, reverse: true }, dt: 1 / 30, frames: 120 },
      { input: { ...idle, brake: 1 }, dt: 0.25, frames: 12 },
    ];
    const state = initialState(route), trace: DriveState[] = [];
    for (const step of steps) { for (let i = 0; i < step.frames; i++) stepDrive(route, state, step.input, step.dt); trace.push({ ...state }); }
    const cwd = new URL("../../../../../", import.meta.url).pathname;
    const result = Bun.spawnSync(["cargo", "run", "--quiet", "-p", "pocket3d-drive", "--bin", "drive-oracle"], {
      cwd, stdin: new TextEncoder().encode(JSON.stringify({ route, steps, trace: true })), stdout: "pipe", stderr: "pipe",
    });
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    const native = JSON.parse(new TextDecoder().decode(result.stdout));
    for (let i = 0; i < trace.length; i++) for (const key of Object.keys(trace[i]) as (keyof DriveState)[]) {
      const a = trace[i][key], b = native.trace[i][key];
      if (typeof a === "number") expect(b).toBeCloseTo(a, 7); else expect(b).toEqual(a);
    }
  }, 120_000);
});
