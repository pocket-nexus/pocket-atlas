import { Color } from "three";
import { Rng } from "../../../core/random";
import type { ObsLib } from "../gfx/observatory-materials";
import type { GriffithWorld } from "./context";
import { groundY } from "./dem";
import { buffer, drape, inside } from "./observatory/drape";
import { arc, Kits, type P2, type V3 } from "./observatory/kit";
import { K3000, point, spot } from "./observatory/lights";
import { DRUM, FACADE, GROUND, LEVEL, WEST } from "./observatory/plan";
import { binoculars, bust, cypress, groundParapet, lampPost, monument, railing, rosette, shrub } from "./observatory/props";
import { GARDENS, GRASS, RETAINING, WALLS } from "./observatory/survey";

/**
 * The grounds (p02, p03, p04, p05, p16, p17, p21): the paved precinct
 * (entrance plaza and steps, the walks round the lawn panels, the upper west
 * terrace over the Gottlieb Transit Corridor and the café terrace below it),
 * the lawn panels and the Astronomers Monument in its planted ring, the
 * James Dean bust, Art Deco lamp posts with white globes, pipe railings
 * along the terrace edges, the planters and cypresses along the façade, the
 * horseshoe drive round the turnaround island, the parking, the loading road
 * and the lower east terrace.
 */

/** Warm-white lamp globes (est. ~3200 K LED behind opal glass). */
const GLOBE = new Color(1.0, 0.78, 0.55);

/** Lamp posts (est. from p02, p04, p05, p21): the entrance pair, the walks either side of the inner lawn panels, the west walk and terrace, the drive. */
const LAMPS: P2[] = [
  [-7.2, -46.6],
  [8.8, -46.6],
  [-14.7, -56],
  [-14.7, -76],
  [-14.7, -96],
  [15.8, -56],
  [15.8, -76],
  [15.8, -96],
  [-22.5, -107.5],
  [-33.6, -85.5],
  [-44.6, -58],
  [-44.6, -38],
  [-44.6, -19],
  [-11.5, -120.5],
  [13.0, -120.5],
  // The service yard and the loading road east of the drum (p14, p17).
  [21.5, 8.5],
  [31.4, -2.0],
  [38.6, -22.0],
];

/** Entrance steps (DEM: plaza 0.75 at z −46.4, landing 1.8 from z −42, the doors at 2.15). */
const STEPS = { x0: -8.6, x1: 10.2, z0: -46.4, z1: -42.0, landing: 1.82 };

function inEntrance(x: number, z: number): boolean {
  return x > STEPS.x0 - 0.2 && x < STEPS.x1 + 0.2 && z > STEPS.z0 - 0.2 && z < FACADE.z;
}

export function buildGrounds(w: GriffithWorld, lib: ObsLib): { triangles: number; lights: number } {
  const K = new Kits();
  const r = new Rng(2015);
  const walk = K.of(lib.walk());
  const lawn = K.of(lib.lawn());
  const asphalt = K.of(lib.asphalt());
  const deck = K.of(lib.deck());
  const wall = K.of(lib.wall());
  const soil = K.of(lib.hillside());
  const leaf = K.of(lib.foliage());
  let lights = 0;

  // ------------------------------------------------------------ surfaces
  const precinctY = (x: number, z: number) => (inEntrance(x, z) ? Math.min(groundY(x, z), 0.9) : groundY(x, z));
  drape(walk, GROUND.precinct, { cell: 4, lift: 0.06, height: precinctY });
  for (const ring of Object.values(GRASS)) drape(lawn, ring, { cell: 4, lift: 0.1 });
  drape(asphalt, GROUND.drive, { cell: 4, lift: 0.05 });
  drape(asphalt, GROUND.parking, { cell: 8, lift: 0.05 });
  drape(asphalt, buffer(GROUND.eastRoad, 6.5), { cell: 8, lift: 0.05 });
  drape(asphalt, buffer(GROUND.westRoad, 6.5), { cell: 8, lift: 0.055 });
  drape(asphalt, buffer(GROUND.loading, 4.5), { cell: 4, lift: 0.05 });
  drape(walk, GROUND.eastTerrace, { cell: 4, lift: 0.06 });
  // Lower west level (DEM −3.8): the café's outdoor seating and the Gottlieb corridor beside it.
  const cafe = WEST.cafe;
  const cor = WEST.corridor;
  deck.flat([[cafe.x0, cafe.z0], [cor.x1, cafe.z0], [cor.x1, cafe.z1], [cafe.x0, cafe.z1]], LEVEL.cafe, 1);

  // ------------------------------------------------------------ entrance steps
  const { x0, x1, z0, z1, landing } = STEPS;
  const n = 6;
  for (let i = 0; i < n; i++) {
    const y = 0.75 + ((landing - 0.75) * (i + 1)) / n;
    const zs = z0 + ((z1 - z0) * i) / n;
    walk.box(x0, x1, 0.3, y, zs, FACADE.pav.z, "ny");
  }
  walk.box(x0, x1, 0.3, landing, z1, FACADE.pav.z, "ny");
  for (let i = 0; i < 2; i++) {
    const y = landing + ((LEVEL.floor - landing) * (i + 1)) / 2;
    walk.box(FACADE.recess.x0, FACADE.recess.x1, landing - 0.2, y, FACADE.pav.z + i * 0.45, FACADE.recess.z + 0.5, "ny");
  }
  // Cheek walls either side of the flight.
  wall.box(x0 - 0.45, x0, 0.3, landing + 0.45, z0, FACADE.pav.z, "ny");
  wall.box(x1, x1 + 0.45, 0.3, landing + 0.45, z0, FACADE.pav.z, "ny");

  // ------------------------------------------------------------ planters, cypresses, gardens
  for (const key of ["w481608926", "w481608932"]) {
    const ring = GARDENS[key];
    const xs = ring.map((p) => p[0]);
    const zs = ring.map((p) => p[1]);
    const bx0 = Math.min(...xs);
    const bx1 = Math.max(...xs);
    const bz0 = Math.min(...zs);
    const bz1 = Math.max(...zs) - 0.05;
    const top = 1.55;
    wall.box(bx0, bx1, 0.6, top, bz0, bz0 + 0.3, "ny");
    wall.box(bx0, bx0 + 0.3, 0.6, top, bz0, bz1, "ny");
    wall.box(bx1 - 0.3, bx1, 0.6, top, bz0, bz1, "ny");
    soil.shade = 0.55;
    soil.flat([[bx0 + 0.3, bz0 + 0.3], [bx1 - 0.3, bz0 + 0.3], [bx1 - 0.3, bz1], [bx0 + 0.3, bz1]], top - 0.15, 1);
    soil.shade = 1;
    for (let x = bx0 + 1.0; x < bx1 - 0.8; x += 1.4) shrub(leaf, r.chance(0.5) ? "shrub2" : "sage", x + r.range(-0.3, 0.3), top - 0.2, (bz0 + bz1) / 2 + r.range(-0.3, 0.3), r.range(0.9, 1.3), r.range(0.6, 0.9), r, [0.75, 0.8, 0.7]);
  }
  cypress(K, lib, FACADE.pav.x0 - 0.9, 1.4, -36.3, 8.2, r);
  cypress(K, lib, FACADE.pav.x1 + 0.9, 1.4, -36.3, 8.0, r);
  // Crescent gardens round the telescope drums (yucca, agave, sage; p19).
  for (const key of ["w481608925", "w481608934", "w481608935", "w481608924"]) {
    const ring = GARDENS[key];
    const xs = ring.map((p) => p[0]);
    const zs = ring.map((p) => p[1]);
    for (let k = 0; k < 40; k++) {
      const x = r.range(Math.min(...xs), Math.max(...xs));
      const z = r.range(Math.min(...zs), Math.max(...zs));
      if (!inside(ring, x, z)) continue;
      const y = groundY(x, z);
      const pick = r.next();
      if (pick < 0.3) rosette(leaf, "yucca", x, y, z, r.range(0.7, 1.1), r);
      else if (pick < 0.5) rosette(leaf, "agave", x, y, z, r.range(0.5, 0.8), r);
      else shrub(leaf, r.chance(0.5) ? "sage" : "shrub", x, y, z, r.range(0.8, 1.3), r.range(0.6, 1.0), r, [0.8, 0.82, 0.72]);
    }
  }

  // ------------------------------------------------------------ the monument, its ring, the bust
  const MX = 0.6;
  const MZ = -87.9;
  const mon = monument(K, lib, MX, MZ);
  for (let k = 0; k < 26; k++) {
    const a = (k / 26) * Math.PI * 2 + r.range(-0.08, 0.08);
    const d = r.range(3.0, 4.1);
    const x = MX + Math.cos(a) * d;
    const z = MZ + Math.sin(a) * d;
    shrub(leaf, r.chance(0.6) ? "shrub2" : "sage", x, groundY(x, z) + 0.08, z, r.range(0.7, 1.0), r.range(0.45, 0.7), r, [0.75, 0.8, 0.7]);
  }
  // Floodlights in the ring's planting, wide enough to wash the shaft to its top (p02: the monument reads white).
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.5;
    const p: V3 = [MX + Math.cos(a) * 4.6, mon.base + 0.2, MZ + Math.sin(a) * 4.6];
    spot(w, K3000, 260, 22, 0.42, 0.8, p, [MX, mon.base + 5.5, MZ]);
    lights++;
  }
  bust(K, lib, -43.5, -67.9, (130 * Math.PI) / 180);

  // ------------------------------------------------------------ lamp posts
  const globe = K.of(lib.glow(GLOBE, 3.2, "globe"));
  for (const [x, z] of LAMPS) {
    const g = lampPost(K, lib, x, z, globe);
    point(w, GLOBE, 18, 15, [g[0], g[1], g[2]]);
    lights++;
  }

  // ------------------------------------------------------------ railings and edges
  railing(K, lib, [[-18.4, -118.1], [-38.6, -76.5], [-41.7, -70.2], [-46.1, -70.2], [-46.0, -63.4], [-50.7, -63.4], [-50.7, -60.6], [-49.4, -60.6]], { kerb: 0.45 });
  railing(K, lib, [[-46.0, -11.7], [-35.3, -11.7], [-35.2, -7.7], [-19.2, -7.7], [-19.2, -2.2], [-17.5, -2.2]], { kerb: 0.45 });
  railing(K, lib, [[17.6, -117.0], [17.2, -56.0], [18.7, -51.6], [21.1, -49.6]], { kerb: 0.35 });
  railing(K, lib, [[-18.4, -118.1], [-18.3, -140.8], [-18.9, -158.5], [-19.9, -161.8], [-22.3, -167.7], [-26.8, -172.0]], { height: 1.2 });
  // Café terrace: its outer wall and railing; the Gottlieb Transit Corridor (p03): a glass wall
  // with steel mullions facing the café, a flat roof a little below the upper terrace, the
  // retaining wall of the upper terrace behind it; stairs down at its north end.
  const cy = LEVEL.cafe;
  railing(K, lib, [[cafe.x0, cafe.z0], [cafe.x0, cafe.z1]], { kerb: 0.5, base: () => cy });
  {
    const roof = 0.55;
    const steel = K.of(lib.steel());
    const glass = K.of(lib.glazing());
    const z0 = -51.6;
    const z1 = cor.z1;
    const n = 18;
    glass.wall([cor.x0, z0], [cor.x0, z1], cy, roof, 1, { su: n });
    for (let i = 0; i <= n; i++) {
      const z = z0 + ((z1 - z0) * i) / n;
      steel.box(cor.x0 - 0.07, cor.x0 + 0.05, cy, roof, z - 0.06, z + 0.06, "ny");
    }
    wall.box(cor.x0 - 0.15, cor.x1, roof, roof + 0.35, z0 - 0.2, z1 + 0.2, "");
    wall.wall([cor.x1, -60.6], [cor.x1, z1], cy - 0.2, 1.15, -1, { su: 12, sv: 2 });
    railing(K, lib, [[cor.x1 + 0.2, -60.4], [cor.x1 + 0.2, z1]], { kerb: 0.3 });
    // North stairs from the lawn level down into the corridor (way 481608929).
    const steps = 26;
    for (let i = 0; i < steps; i++) {
      const y = 1.0 - ((1.0 - cy) * (i + 1)) / steps;
      const za = -60.4 + ((-51.6 - -60.4) * i) / steps;
      walk.box(cor.x0, cor.x1, cy - 0.3, y + (1.0 - cy) / steps, za, za + (-51.6 - -60.4) / steps, "ny");
    }
    wall.box(cor.x0 - 0.3, cor.x0, cy, 1.4, -60.6, -51.6, "ny");
  }
  // Retaining wall faces under the café terrace and down from the west terrace.
  wall.wall([cafe.x0, cafe.z0], [cafe.x0, cafe.z1], -8, cy, -1, { su: 10, sv: 2 });
  wall.wall([cafe.x0, cafe.z1], [-35.3, -9.7], -8, groundY(-40, -12) + 0.1, -1, { su: 8, sv: 2 });

  // Outer wall of the loading road round the east dome and the service yard's south edge (p14, p17).
  groundParapet(K, lib, RETAINING.w427734993.slice().reverse());
  groundParapet(K, lib, RETAINING.w377705458.slice().reverse());
  groundParapet(K, lib, WALLS.w377705408, 1.5);
  for (const [x, z] of [
    [24.0, 11.3],
    [29.6, 11.0],
  ] as P2[])
    binoculars(K, lib, x, groundY(x, z), z, 180);

  // ------------------------------------------------------------ binocular viewers
  for (const t of [40, 68, 112, 140]) {
    const a = (t * Math.PI) / 180;
    const rr = DRUM.r - 0.75;
    binoculars(K, lib, DRUM.x + Math.cos(a) * rr, LEVEL.deck, DRUM.z + Math.sin(a) * rr, 90 + t);
  }
  binoculars(K, lib, -45.6, groundY(-45.6, -24), -24, 270);
  binoculars(K, lib, -45.6, groundY(-45.6, -42), -42, 270);
  // East deck's south parapet (p14): viewers and warm uplights at the parapet's foot lighting the visitors.
  for (const x of [20.5, 25.0, 29.5]) {
    binoculars(K, lib, x, LEVEL.deck, -8.95, 180);
    point(w, K3000, 22, 6, [x + 1.6, LEVEL.deck + 0.25, -8.75]);
    lights++;
  }

  // ------------------------------------------------------------ turnaround island, median
  const I = GROUND.island;
  const isl = arc(I.x, I.z, I.r, 0, Math.PI * 2, 32).slice(0, 32);
  const iy = groundY(I.x, I.z) + 0.15;
  wall.ring(isl, iy - 0.4, iy, true);
  soil.shade = 0.6;
  soil.flat(isl, iy - 0.05, 1);
  soil.shade = 1;
  for (let k = 0; k < 18; k++) {
    const a = r.range(0, Math.PI * 2);
    const d = Math.sqrt(r.next()) * (I.r - 0.8);
    shrub(leaf, r.chance(0.5) ? "shrub" : "shrub2", I.x + Math.cos(a) * d, iy - 0.05, I.z + Math.sin(a) * d, r.range(0.9, 1.5), r.range(0.6, 1.0), r, [0.75, 0.8, 0.7]);
  }
  drape(walk, buffer(GROUND.median, 2.4), { cell: 4, lift: 0.15 });

  console.info(`[griffith] grounds by material: ${K.tally()}`);
  const triangles = K.emit(w);
  return { triangles, lights };
}
