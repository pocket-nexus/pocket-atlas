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
  [20.6, 0.5],
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
    spot(w, K3000, 325, 22, 0.42, 0.8, p, [MX, mon.base + 5.5, MZ]);
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
  railing(K, lib, [[-18.4, -118.1], [-38.6, -76.5], [-41.7, -70.2], [-46.1, -70.2], [-46.0, -63.4], [-50.7, -63.4], [-50.7, -60.6], [-49.4, -60.6]], { kerb: 0.45, drop: 4 });
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
  groundParapet(K, lib, [[23.4, 9.9], [18.5, 10.1]]);
  groundParapet(K, lib, WALLS.w377705408, 1.5);

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

  lights += yard(w, K, lib);
  roadDetail(K, lib);
  outbuildings(K, lib);
  const triangles = K.emit(w);
  return { triangles, lights };
}

/**
 * The service yard below the east deck and its viewing platform (p14, p17,
 * ortho): the yard floor at −1.6 (DEM) is the car lane along the building;
 * a raised platform (est. 1.0 m above it) fills the yard's south-east part
 * out to the retaining wall at z ≈ 10, with a solid 1.05 m parapet on its
 * outer edges, a pipe railing toward the lane, steps down at its north-west
 * corner, warm uplights at the parapet's foot pooling on the floor where
 * the visitors stand, and binocular viewers on posts. The platform's plan
 * follows the yard paving and the retaining wall's line; its height is read
 * off p14 (the visitors' feet sit about a parapet's height below the deck
 * walkway's railing in perspective) and is an estimate.
 */
function yard(w: GriffithWorld, K: Kits, lib: ObsLib): number {
  const deck = K.of(lib.deck());
  const wall = K.of(lib.wall());
  const steel = K.of(lib.steel());
  const lens = K.of(lib.glow(K3000, 1.6, "lens"));
  const yardY = -1.6;
  const top = yardY + 1.0;
  const P = { x0: 23.4, x1: 31.4, z0: 2.4, z1: 9.6 };
  // Platform: deck floor, its north and west faces down to the lane.
  deck.flat([[P.x0, P.z0], [P.x1, P.z0], [P.x1, P.z1], [P.x0, P.z1]], top, 1);
  wall.wall([P.x0, P.z0], [P.x1, P.z0], yardY - 0.1, top, 1, { su: 4 });
  wall.wall([P.x0, P.z0], [P.x0, P.z1], yardY - 0.1, top, -1, { su: 4 });
  // Solid parapet on the south and east edges; its outer face runs down the retaining wall.
  const par: P2[] = [[P.x0 - 0.0, P.z1], [P.x1, P.z1], [P.x1, P.z0]];
  for (let i = 0; i + 1 < par.length; i++) {
    const [a, b] = [par[i], par[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dx = (b[0] - a[0]) / len;
    const dz = (b[1] - a[1]) / len;
    const ox = dz * 0.3;
    const oz = -dx * 0.3;
    // Inner face (toward the platform), outer face (toward the slope), coping.
    wall.wall(a, b, top, top + 1.05, -1, { su: Math.ceil(len / 1.5) });
    const ao: P2 = [a[0] + ox, a[1] + oz];
    const bo: P2 = [b[0] + ox, b[1] + oz];
    wall.wall(ao, bo, Math.min(groundY(ao[0], ao[1]), groundY(bo[0], bo[1])) - 0.4, top + 1.05, 1, { su: Math.ceil(len / 1.5), sv: 3 });
    wall.face([a[0] - ox * 0.15, top + 1.05, a[1] - oz * 0.15], [b[0] - ox * 0.15, top + 1.05, b[1] - oz * 0.15], [bo[0] + ox * 0.15, top + 1.05, bo[1] + oz * 0.15], [ao[0] + ox * 0.15, top + 1.05, ao[1] + oz * 0.15], [0, 1, 0], [0, 0], [len, 0], [len, 0.35], [0, 0.35]);
  }
  // Pipe railing on the lane side and the platform's north edge.
  railing(K, lib, [[P.x0, P.z1 - 0.3], [P.x0, P.z0 + 1.6]], { base: () => top });
  railing(K, lib, [[P.x0 + 1.6, P.z0], [P.x1 - 0.3, P.z0]], { base: () => top });
  // Steps down to the lane at the north-west corner.
  for (let i = 0; i < 6; i++) {
    const y = yardY + ((top - yardY) * (i + 1)) / 6;
    deck.box(P.x0 - 1.8 + i * 0.3, P.x0, yardY - 0.1, y, P.z0, P.z0 + 1.5, "ny");
  }
  // Uplights at the parapet's foot and viewers along the south parapet.
  let n = 0;
  for (const x of [25.0, 27.8, 30.4]) {
    const z = P.z1 - 0.45;
    steel.box(x - 0.1, x + 0.1, top, top + 0.16, z - 0.1, z + 0.1, "ny");
    lens.flat([[x - 0.06, z - 0.15], [x + 0.06, z - 0.15], [x + 0.06, z - 0.1], [x - 0.06, z - 0.1]], top + 0.161, 1);
    point(w, K3000, 5, 4.5, [x, top + 0.25, z - 0.25]);
    n++;
    binoculars(K, lib, x - 1.3, top, P.z1 - 0.7, 180);
  }
  binoculars(K, lib, P.x1 - 0.7, top, 6.0, 90);
  return n;
}

/** Kerbs along the drive, the zebra crossing to the island, diagonal stall lines either side of the median (p16, p21). */
function roadDetail(K: Kits, lib: ObsLib): void {
  const walk = K.of(lib.walk());
  const paint = K.of(lib.paint());
  // Kerbs: 0.15 m high, 0.3 m wide, on the drive's west and east edges.
  const west: P2[] = [[-15.5, -121.0], [-15.5, -128.8], [-15.6, -155.0], [-16.6, -160.5], [-19.0, -167.5], [-26.6, -207.4]];
  const east: P2[] = [[15.8, -200.9], [13.5, -191.1], [11.8, -176.6], [12.1, -165.1], [14.8, -147.7], [17.5, -139.9], [17.8, -134.5], [16.8, -128.5], [15.8, -119.0]];
  for (const line of [west, east]) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(len / 4));
      const dx = (b[0] - a[0]) / len;
      const dz = (b[1] - a[1]) / len;
      for (let k = 0; k < n; k++) {
        const p0: P2 = [a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)];
        const p1: P2 = [a[0] + (b[0] - a[0]) * ((k + 1) / n), a[1] + (b[1] - a[1]) * ((k + 1) / n)];
        const g0 = groundY(p0[0], p0[1]);
        const g1 = groundY(p1[0], p1[1]);
        for (const s of [-1, 1]) {
          const ox = -dz * 0.15 * s;
          const oz = dx * 0.15 * s;
          walk.face([p0[0] + ox, g0 - 0.05, p0[1] + oz], [p1[0] + ox, g1 - 0.05, p1[1] + oz], [p1[0] + ox, g1 + 0.16, p1[1] + oz], [p0[0] + ox, g0 + 0.16, p0[1] + oz], [ox, 0, oz], [0, 0], [1, 0], [1, 0.2], [0, 0.2]);
        }
        walk.face([p0[0] + dz * 0.15, g0 + 0.16, p0[1] - dx * 0.15], [p1[0] + dz * 0.15, g1 + 0.16, p1[1] - dx * 0.15], [p1[0] - dz * 0.15, g1 + 0.16, p1[1] + dx * 0.15], [p0[0] - dz * 0.15, g0 + 0.16, p0[1] + dx * 0.15], [0, 1, 0], [p0[0], -p0[1]], [p1[0], -p1[1]], [p1[0], -p1[1]], [p0[0], -p0[1]]);
      }
    }
  }
  // Zebra crossing from the island to the west sidewalk (way 1158002855), bars along the road.
  const za: P2 = [-3.6, -138.0];
  const zb: P2 = [-15.2, -130.1];
  const cl = Math.hypot(zb[0] - za[0], zb[1] - za[1]);
  const cx = (zb[0] - za[0]) / cl;
  const cz = (zb[1] - za[1]) / cl;
  for (let d = 0.5; d < cl - 0.4; d += 1.1) {
    const x = za[0] + cx * d;
    const z = za[1] + cz * d;
    const y = groundY(x, z) + 0.065;
    // Bar 0.55 m across the crossing's direction, 3 m along the road (perpendicular to the crossing).
    const ax = -cz * 1.5;
    const az = cx * 1.5;
    const bx = cx * 0.275;
    const bz = cz * 0.275;
    paint.face([x - ax - bx, y, z - az - bz], [x + ax - bx, y, z + az - bz], [x + ax + bx, y, z + az + bz], [x - ax + bx, y, z - az + bz], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  }
  // Diagonal stalls (60°) along both sides of the median walk.
  for (let z = -146; z > -206; z -= 2.7) {
    for (const s of [-1, 1]) {
      const x0 = -0.6 + s * 1.3;
      const y = groundY(x0, z) + 0.065;
      const lx = s * Math.cos(Math.PI / 6) * 5.5;
      const lz = -Math.sin(Math.PI / 6) * 5.5;
      const w = 0.06;
      paint.face([x0, y, z - w], [x0 + lx, y, z + lz - w], [x0 + lx, y, z + lz + w], [x0, y, z + w], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }
}

/**
 * Outbuildings inside SITE: the low glass-roofed structure on the slope east
 * of the lawn (LA County 1736517 / OSM 422131197: 8.6 × 26.8 m, roof 344.7 m
 * ASL, 3.5 m) and the restroom block by the parking (OSM 422130795, 5 m).
 */
function outbuildings(K: Kits, lib: ObsLib): void {
  const wall = K.of(lib.wall());
  const steel = K.of(lib.steel());
  const glass = K.of(lib.glazing());
  // Glass-roofed structure: walls from the slope to the roof edge, a grid of glazing in steel.
  const g = { x0: 23.6, x1: 32.2, z0: -92.8, z1: -66.0, top: -1.3 };
  const ring: P2[] = [[g.x0, g.z0], [g.x1, g.z0], [g.x1, g.z1], [g.x0, g.z1]];
  const foot = Math.min(...ring.map(([x, z]) => groundY(x, z))) - 0.5;
  wall.ring(ring, foot, g.top + 0.3, true);
  glass.flat([[g.x0 + 0.3, g.z0 + 0.3], [g.x1 - 0.3, g.z0 + 0.3], [g.x1 - 0.3, g.z1 - 0.3], [g.x0 + 0.3, g.z1 - 0.3]], g.top, 1);
  wall.box(g.x0, g.x1, g.top, g.top + 0.3, g.z0, g.z0 + 0.3, "ny");
  wall.box(g.x0, g.x1, g.top, g.top + 0.3, g.z1 - 0.3, g.z1, "ny");
  wall.box(g.x0, g.x0 + 0.3, g.top, g.top + 0.3, g.z0, g.z1, "ny");
  wall.box(g.x1 - 0.3, g.x1, g.top, g.top + 0.3, g.z0, g.z1, "ny");
  for (let z = g.z0 + 2.2; z < g.z1 - 1; z += 2.2) steel.box(g.x0 + 0.3, g.x1 - 0.3, g.top, g.top + 0.08, z - 0.04, z + 0.04, "ny");
  for (const x of [g.x0 + 2.9, g.x0 + 5.7]) steel.box(x - 0.04, x + 0.04, g.top, g.top + 0.08, g.z0 + 0.3, g.z1 - 0.3, "ny");
  // Restroom block.
  const t: P2[] = [[-22.8, -239.8], [-17.1, -239.8], [-17.1, -220.4], [-22.8, -220.4]];
  const tf = Math.min(...t.map(([x, z]) => groundY(x, z))) - 0.3;
  const tt = Math.max(...t.map(([x, z]) => groundY(x, z))) + 3.2;
  wall.ring(t, tf, tt, true);
  wall.box(-23.1, -16.8, tt, tt + 0.25, -240.1, -220.1, "ny");
}