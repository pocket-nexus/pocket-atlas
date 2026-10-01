import { Vector3, type BufferGeometry } from "three";
import { carGeometry, cyclistGeometry, motoGeometry, vehicleMaterial, type CarKind } from "./cars";
import { ROAD_Y } from "./coast";
import type { KamakuraWorld } from "./context";
import { COAST, LOOP, SECTION } from "./layout";

/**
 * Route 134 traffic: five cars, a motorcycle and a road cyclist in both
 * directions at 45–52 km/h (the cyclist at 26 km/h). Nothing stops for the
 * crossing: Route 134 has no gate. Each vehicle repeats every `period`
 * seconds (a divisor of the loop): it drives from out of sight west of the
 * station to beyond the haze 500 m east (or back), then spends 0.6 s
 * underground while it returns to its start. `cross` is when it passes the
 * junction (u = 0); the eastbound kei and minivan run as a pair a few
 * seconds apart, as traffic leaves the Koshigoe lights in platoons.
 *
 * Japan keeps left: eastbound traffic uses the north lane (next to the
 * track), westbound the sea side. Each vehicle is one mesh and one shared
 * material (one draw on the handheld) and casts nothing into the static
 * shadow map.
 */

interface Vehicle {
  name: string;
  geo: () => BufferGeometry;
  east: boolean;
  /** Lane offset south of the coast line (m). */
  lane: number;
  /** Speed (m/s). */
  v: number;
  /** Seconds between appearances (divides the loop). */
  period: number;
  /** Place time at which it passes the junction. */
  cross: number;
}

const car = (k: CarKind) => () => carGeometry(k);

/** The fleet; crossing times put an eastbound pair and an oncoming SUV in the Route134 head-on shot (t ≈ 22–26). */
export const FLEET: Vehicle[] = [
  { name: "kei-white", geo: car("kei"), east: true, lane: SECTION.lanes.east + 0.15, v: 12.8, period: 60, cross: 22.0 },
  { name: "minivan-silver", geo: car("minivan"), east: true, lane: SECTION.lanes.east + 0.2, v: 13.1, period: 60, cross: 24.6 },
  { name: "sedan-pearl", geo: car("sedan"), east: true, lane: SECTION.lanes.east + 0.1, v: 13.0, period: 60, cross: 47.0 },
  { name: "suv-black", geo: car("suv"), east: false, lane: SECTION.lanes.west - 0.1, v: 13.6, period: 60, cross: 29.5 },
  { name: "van-white", geo: car("van"), east: false, lane: SECTION.lanes.west, v: 12.5, period: 60, cross: 14.0 },
  { name: "motorcycle", geo: motoGeometry, east: false, lane: SECTION.lanes.west - 0.6, v: 14.5, period: 60, cross: 41.0 },
  { name: "cyclist", geo: cyclistGeometry, east: true, lane: SECTION.road[0] + 0.45, v: 7.2, period: LOOP, cross: 70.0 },
];

/** West end of every run: beyond the platform, behind every shot that looks east. */
const WEST = -270;
/** Seconds each vehicle spends underground between runs. */
const HIDDEN = 0.6;

/** Road surface height across the carriageway (the crown of `coast.ts`). */
function roadY(s: number): number {
  const [a, b] = SECTION.road;
  return ROAD_Y + 0.05 * Math.sin((Math.PI * (s - a)) / (b - a));
}

/** Position along the road (u, + east) and height offset of a vehicle at place time t. */
export function vehicleAt(veh: Vehicle, t: number): { u: number; sink: number } {
  const run = veh.v * (veh.period - HIDDEN);
  const start = veh.east ? WEST : WEST + run;
  // Seconds since the run began; the junction is (0 − start) / v into it.
  const atJunction = Math.abs(start) / veh.v;
  const r = ((((t - veh.cross + atJunction) % veh.period) + veh.period) % veh.period);
  const ramp = 0.15;
  if (r <= veh.period - HIDDEN) {
    const u = start + (veh.east ? 1 : -1) * veh.v * r;
    const sink = r < ramp ? 1 - r / ramp : r > veh.period - HIDDEN - ramp ? 1 - (veh.period - HIDDEN - r) / ramp : 0;
    return { u, sink };
  }
  return { u: start, sink: 1 };
}

export function buildTraffic(w: KamakuraWorld): void {
  const mat = vehicleMaterial();
  const holder = w.group();
  holder.name = "traffic";
  holder.userData.dynamic = true;
  const p = new Vector3();
  const tan = new Vector3();
  let tris = 0;
  for (const veh of FLEET) {
    const node = w.group(0, 0, 0, 0, holder);
    node.name = veh.name;
    const geo = veh.geo();
    tris += geo.getAttribute("position").count / 3;
    w.mesh(geo, mat, 0, 0, 0, node, { cast: false });
    const y = roadY(veh.lane);
    w.update((_dt, t) => {
      const { u, sink } = vehicleAt(veh, t);
      COAST.offset(u, veh.lane, p);
      COAST.tangent(u, tan);
      if (!veh.east) tan.negate();
      node.position.set(p.x, y - 30 * sink, p.z);
      node.rotation.y = Math.atan2(-tan.z, tan.x);
    });
  }
  holder.userData.triangles = tris;
  console.info(`[kamakura:traffic] ${Math.round(tris)} triangles in ${FLEET.length} meshes`);
}
