/**
 * Writes the drive every device must reproduce: the web's car, trip and
 * chase camera stepped through a scripted set of controls on a synthetic
 * line (a straight, a bend, a hill), sampled every half second.
 *
 *   bun scripts/vehicle-trace.ts   # → ../crates/pocket3d-drive/tests/vehicle-trace.json
 *
 * `cargo test -p pocket3d-drive` replays it against the handheld's port.
 * Regenerate it when the model changes, in the same commit as the port.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { autopilot } from "../src/routes/shared/drive/autopilot";
import { newChase, stepChase, type Eye } from "../src/routes/shared/drive/chase";
import { newTraffic, stepTraffic } from "../src/routes/shared/drive/traffic";
import { newTrip, stepTrip } from "../src/routes/shared/drive/trip";
import { KEI, startState, stepCar, type Controls, type Surface } from "../src/routes/shared/drive/vehicle";
import { Line } from "../src/routes/shared/line";

// 3 km: 600 m straight north, a right-hand bend of 220 m radius through 70°, then straight, climbing 4 % over the last kilometre.
const xs: number[] = [];
const ys: number[] = [];
const zs: number[] = [];
let [x, z, heading] = [0, 0, 0];
for (let s = 0; s <= 3000; s += 5) {
  xs.push(x);
  zs.push(z);
  ys.push(200 + Math.max(0, s - 2000) * 0.04);
  if (s >= 600 && s < 600 + (220 * 70 * Math.PI) / 180) heading += 5 / 220;
  x += Math.sin(heading) * 5;
  z -= Math.cos(heading) * 5;
}
const line = new Line(xs, ys, zs);
const surface: Surface = { line, half: () => 3.6, grip: (s, d) => 0.34 + 0.06 * Math.sin(s * 0.013) * Math.sin(s * 0.0031 + d) };
const stops = [
  { name: "A", native: "A", s: 0 },
  { name: "B", native: "B", s: 1500 },
  { name: "C", native: "C", s: line.length },
];

const car = startState(surface, 12, -1.65);
const trip = newTrip();
const chase = newChase();
const traffic = newTraffic(car.s, line.length);
let hits = 0;
const eye: Eye = { pos: [0, 0, 0], target: [0, 0, 0], fov: 50 };
const dt = 1 / 30;
const frames: number[][] = [];
const inputs: number[][] = [];
const auto: Controls = { steer: 0, throttle: 0, brake: 0 };
for (let f = 0; f < 30 * 150; f++) {
  const t = f * dt;
  // Scripted: pull away, weave, brake hard, reverse, then the autopilot, then a swerve into the bank.
  let c: Controls;
  if (t < 12) c = { steer: 0, throttle: 1, brake: 0 };
  else if (t < 20) c = { steer: Math.sin(t * 1.3) * 0.6, throttle: 0.6, brake: 0 };
  else if (t < 26) c = { steer: 0.1, throttle: 0, brake: 1 };
  else if (t < 30) c = { steer: -0.3, throttle: 0, brake: 1 };
  else if (t < 34) c = { steer: 0, throttle: 1, brake: 0 };
  else if (t < 110) c = autopilot(car, line, 22, -1.65, KEI, auto);
  else if (t < 114) c = { steer: 1, throttle: 0.8, brake: 0 };
  else c = autopilot(car, line, 30, -1.65, KEI, auto);
  inputs.push([c.steer, c.throttle, c.brake]);
  const before = car.odometer;
  stepCar(car, c, surface, dt);
  stepTrip(trip, car, stops, dt, car.odometer - before, car.scrape === 0 && car.impact > 1.5);
  if (stepTraffic(traffic, car, line.length, dt)) {
    hits++;
    car.vx = 0;
    car.vy = 0;
    car.yawRate = 0;
  }
  stepChase(chase, car, "chase", dt, eye);
  if (f % 15 === 14) frames.push([f, car.x, car.z, car.y, car.heading, car.vx, car.vy, car.yawRate, car.steer, car.s, car.d, car.odometer, trip.reached, trip.scrapes, trip.metres, eye.pos[0], eye.pos[1], eye.pos[2], eye.fov, car.reverse ? 1 : 0, hits, ...traffic.cars.flatMap((c) => [c.s, c.v, c.body])]);
}
const out = join(import.meta.dir, "../../crates/pocket3d-drive/tests/vehicle-trace.json");
writeFileSync(out, JSON.stringify({ note: "web/scripts/vehicle-trace.ts", dt, spec: KEI, line: { x: xs, y: ys, z: zs, half: 3.6 }, stops: stops.map((s) => s.s), inputs, columns: "frame x z y heading vx vy yawRate steer s d odometer reached scrapes metres eyeX eyeY eyeZ fov reverse hits (traffic s v body)×5", frames }) + "\n");
console.log(`${frames.length} samples; the car ends at s = ${car.s.toFixed(1)} m, ${trip.scrapes} scrapes, ${hits} traffic hits, phase ${trip.phase}`);
