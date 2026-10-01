import { BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, MeshStandardMaterial, Vector3 } from "three";
import { merge } from "../../shared/shapes";
import { crossingDeck, marking, spikeMat, tactile } from "../gfx/art";
import { Bag, type KamakuraWorld } from "./context";
import { COAST, CROSSING, SECTION, TRACK } from "./layout";
import { place, ribbon, stations, wallAlong } from "./util";

/**
 * The coastal strip along the Enoden: ballast, sleepers and rails, the
 * crossing deck and spike mats, the wood-look concrete fence, Route 134's
 * sidewalk, kerbs, lanes and markings, the sea-wall top with its steel-post
 * fence, the decorative wall face and the beach below. Everything runs along
 * the track centreline (`TRACK`) at the offsets of `SECTION`.
 */

/** Road surface height above the rail. */
export const ROAD_Y = 0.06;
const KERB = SECTION.kerb;
const WALK_Y = ROAD_Y + KERB;

/** Track arc lengths where the crossing deck starts and ends (x ≈ −6.25 … 5.85). */
const DECK_U: [number, number] = [-3.95, 5.25];
/** Sidewalk gap (the slope road joins Route 134). */
const JUNCTION_U: [number, number] = [-6.2, 7.4];

export function beachY(s: number): number {
  if (s < 38) return SECTION.sandTop - (s - 18.8) * 0.012;
  if (s < 80) return SECTION.sandTop - 0.23 - (s - 38) * 0.085;
  return SECTION.sandTop - 0.23 - 42 * 0.085 - (s - 80) * 0.03;
}

export function buildCoast(w: KamakuraWorld): void {
  const lib = w.lib;
  const bag = new Bag();
  const P = w.printed;
  const ballast = lib.ballast();
  const concrete = lib.concrete();
  const asphalt = lib.asphalt();
  // Detail within NEAR of the crossing; beyond it the strip keeps four materials.
  const NEAR: [number, number] = [-220, 240];
  // The coast strip runs from past the station to 1.3 km east (beyond, the haze and the hills take over).
  const C0 = -700;
  const C1 = 1300;

  // ------------------------------------------------------------ track bed
  const bedY = (_u: number, s: number) => (Math.abs(s) < 1.45 ? -0.2 : -0.2 - (Math.abs(s) - 1.45) * 0.28);
  const bedS = [SECTION.bedNorth, -1.45, 0, 1.45, SECTION.bedSouth];
  // Track bed from past the platform to the bend where the line turns inland behind the houses.
  for (const [a, b] of [
    [-420, DECK_U[0]],
    [DECK_U[1], 600],
  ]) {
    bag.add(ballast, ribbon(TRACK, stations(a, b, 3, 10, 40), bedS, bedY));
  }

  // Sleepers: prestressed concrete, 0.6 m pitch within 90 m of the crossing.
  const sleeper = new BoxGeometry(0.2, 0.15, 2.0);
  const sl: BufferGeometry[] = [];
  const p = new Vector3();
  const t = new Vector3();
  for (let u = -90; u <= 90; u += 0.6) {
    if (u > DECK_U[0] - 0.3 && u < DECK_U[1] + 0.3) continue;
    TRACK.point(u, p);
    TRACK.tangent(u, t);
    const g = sleeper.clone();
    g.rotateY(Math.atan2(-t.z, t.x));
    g.translate(p.x, -0.2, p.z);
    sl.push(g);
  }
  bag.add(concrete, merge(sl));

  // Rails: 50 kg/m section as a 0.065 m head on a 0.14 m web, flush through the deck.
  for (const side of [-1, 1]) {
    const s = (side * (SECTION.gauge + 0.065)) / 2;
    const us = stations(NEAR[0], 420, 4, 12, 40);
    const sh = 0.0325;
    bag.add(P, w.tint(ribbon(TRACK, us, [s - sh, s + sh], () => 0), "rust"), false);
    bag.add(P, w.tint(wallAlong(TRACK, us, s + sh, () => -0.16, () => 0, 1), "rust"), false);
    bag.add(P, w.tint(wallAlong(TRACK, us, s - sh, () => -0.16, () => 0, -1), "rust"), false);
  }

  // ------------------------------------------------------------ crossing deck
  const railV = [-1, 1].map((sd) => 0.5 + (sd * (SECTION.gauge + 0.065)) / 2 / (CROSSING.deck[1] - CROSSING.deck[0]));
  const deckCell = w.draw("deck", 2048, 640, (g, cw, ch) => crossingDeck(g, cw, ch, (CROSSING.strip[1] - CROSSING.strip[0] + 0.25) / (DECK_U[1] - DECK_U[0]), railV));
  const deck = ribbon(TRACK, stations(DECK_U[0], DECK_U[1], 1, 1, 1), [CROSSING.deck[0], CROSSING.deck[1]], () => -0.005, { atlas: deckCell });
  bag.add(P, deck);

  // Spike mats between and beside the rails at both road edges (2 m long).
  const spikes = w.draw("spikes", 256, 512, spikeMat);
  for (const [a, b] of [
    [DECK_U[0] - 2.0, DECK_U[0] - 0.05],
    [DECK_U[1] + 0.05, DECK_U[1] + 2.0],
  ]) {
    bag.add(P, ribbon(TRACK, [a, (a + b) / 2, b], [-1.55, 1.55], () => -0.1, { atlas: spikes }), false);
  }

  // ------------------------------------------------------------ track fence (south)
  // Wood-look concrete fence: square posts every 2 m, two rails, 1.1 m high.
  const fenceS = SECTION.fence;
  for (const [a, b] of [
    [-170, JUNCTION_U[0] - 0.3],
    [JUNCTION_U[1] + 0.3, 200],
  ]) {
    const us = stations(a, b, 2, 4, 8);
    bag.add(P, w.tint(ribbon(TRACK, us, [fenceS - 0.06, fenceS + 0.06], () => 1.1), "brown"));
    for (const [y0, y1] of [
      [0.95, 1.1],
      [0.45, 0.6],
    ]) {
      bag.add(P, w.tint(wallAlong(TRACK, us, fenceS + 0.06, () => y0 + WALK_Y - 0.15, () => y1 + WALK_Y - 0.15, 1), "brown"));
      bag.add(P, w.tint(wallAlong(TRACK, us, fenceS - 0.06, () => y0 + WALK_Y - 0.15, () => y1 + WALK_Y - 0.15, -1), "brown"));
    }
    const post = new BoxGeometry(0.13, 1.15, 0.13);
    const posts: BufferGeometry[] = [];
    for (let u = a; u <= b; u += Math.abs(u) < 150 ? 2 : 4) {
      TRACK.offset(u, fenceS, p);
      TRACK.tangent(u, t);
      posts.push(place(post.clone(), p.setY(0.4 + WALK_Y - 0.15), Math.atan2(t.x, t.z)));
    }
    bag.add(P, w.tint(merge(posts), "brown"));
  }

  // ------------------------------------------------------------ sidewalk, road, kerbs
  const walk = [SECTION.sidewalk[0] - 0.25, SECTION.sidewalk[1]];
  for (const [a, b] of [
    [NEAR[0], JUNCTION_U[0]],
    [JUNCTION_U[1], NEAR[1]],
  ]) {
    const us = stations(a, b, 3, 10, 40);
    bag.add(asphalt, ribbon(COAST, us, walk, () => WALK_Y));
    // Kerb: a 0.2 m concrete block line with its face to the road.
    bag.add(concrete, ribbon(COAST, us, [walk[1] - 0.2, walk[1]], () => WALK_Y + 0.005));
    bag.add(concrete, wallAlong(COAST, us, walk[1], () => ROAD_Y - 0.02, () => WALK_Y + 0.005, 1));
    // Shoulder between the bed and the sidewalk, under the fence.
    bag.add(ballast, ribbon(COAST, us, [SECTION.bedSouth, walk[0]], (_u, s) => (s < 2.3 ? -0.45 : WALK_Y - 0.05)));
  }
  // Beyond NEAR: the sidewalk and the shoulder as one raised asphalt band.
  for (const [a, b] of [
    [C0, NEAR[0]],
    [NEAR[1], C1],
  ]) bag.add(asphalt, ribbon(COAST, stations(a, b, 3, 10, 40), [SECTION.bedSouth, walk[1]], () => WALK_Y));
  // Kerb returns at the junction.
  for (const u of JUNCTION_U) {
    const g = new BoxGeometry(0.2, KERB + 0.02, walk[1] - walk[0]);
    COAST.offset(u, (walk[0] + walk[1]) / 2, p);
    COAST.tangent(u, t);
    bag.add(concrete, place(g, p.setY(ROAD_Y + KERB / 2), Math.atan2(t.x, t.z) + Math.PI / 2));
  }
  // The road across the junction, from the deck to Route 134.
  bag.add(asphalt, ribbon(COAST, stations(JUNCTION_U[0], JUNCTION_U[1], 1, 1, 1), [CROSSING.deck[1], walk[1]], () => ROAD_Y));
  bag.add(ballast, ribbon(TRACK, stations(JUNCTION_U[0], DECK_U[0], 1, 1, 1), [SECTION.bedSouth, CROSSING.deck[1]], () => -0.3));
  bag.add(ballast, ribbon(TRACK, stations(DECK_U[1], JUNCTION_U[1], 1, 1, 1), [SECTION.bedSouth, CROSSING.deck[1]], () => -0.3));
  // Route 134 carriageway.
  bag.add(asphalt, ribbon(COAST, stations(C0, C1, 3, 10, 40), [SECTION.road[0], 11.1, 13.6, SECTION.road[1]], (_u, s) => ROAD_Y + 0.05 * Math.sin((Math.PI * (s - SECTION.road[0])) / (SECTION.road[1] - SECTION.road[0]))));

  // Tactile paving at the junction corners.
  const tac = w.draw("tactile", 256, 256, tactile);
  for (const [a, b] of [
    [JUNCTION_U[0] - 0.9, JUNCTION_U[0] - 0.3],
    [JUNCTION_U[1] + 0.3, JUNCTION_U[1] + 0.9],
  ]) {
    bag.add(P, ribbon(COAST, [a, b], [walk[0] + 0.3, walk[1] - 0.3], () => WALK_Y + 0.008, { atlas: tac }), false);
  }

  // ------------------------------------------------------------ markings (atlas)
  const white = w.draw("paint-white", 128, 128, marking("#e2e1da", 3));
  const orange = w.draw("paint-orange", 128, 128, marking("#e07a22", 5));
  const line = (a: number, b: number, s: number, width: number, cell: typeof white, dash = 0, gap = 0) => {
    const ys = () => ROAD_Y + 0.07;
    if (!dash) {
      bag.add(P, ribbon(COAST, stations(a, b, 6, 12, 40), [s - width / 2, s + width / 2], ys, { atlas: cell }), false);
      return;
    }
    for (let u = a; u < b; u += dash + gap) bag.add(P, ribbon(COAST, [u, Math.min(b, u + dash)], [s - width / 2, s + width / 2], ys, { atlas: cell }), false);
  };
  // Edge lines.
  line(NEAR[0], NEAR[1], SECTION.road[0] + 0.5, 0.15, white);
  line(NEAR[0], NEAR[1], SECTION.road[1] - 0.5, 0.15, white);
  // Centre: the right-turn lane east of the junction, hatching west of it, a single orange line beyond.
  line(NEAR[0], -70, SECTION.lanes.turn, 0.15, orange);
  line(70, NEAR[1], SECTION.lanes.turn, 0.15, orange);
  line(-70, 70, SECTION.centre[0], 0.15, orange);
  line(8, 70, SECTION.centre[1], 0.15, white, 3, 3);
  line(-70, -12, SECTION.centre[1], 0.15, orange);
  for (let u = -66; u < -14; u += 3.2) {
    // Zebra hatching of the median (white diagonals).
    const a = COAST.offset(u, SECTION.centre[0] + 0.1, new Vector3());
    const b = COAST.offset(u + 2.0, SECTION.centre[1] - 0.1, new Vector3());
    bag.add(P, diag(a, b, 0.3, ROAD_Y + 0.07, white), false);
  }
  // Stop lines before the pedestrian crossing.
  line(-17.6, -17.15, SECTION.lanes.east, 2.8, white);
  line(-9.85, -9.4, SECTION.lanes.west, 2.8, white);
  // Signalised pedestrian crossing just west of the junction (stripes along the road).
  for (let k = 0; k < 9; k++) {
    const s0 = SECTION.road[0] + 0.3 + k * 1.0;
    bag.add(P, ribbon(COAST, [-15.5, -11.5], [s0, s0 + 0.45], () => ROAD_Y + 0.07, { atlas: white }), false);
  }

  // ------------------------------------------------------------ sea wall
  // The cantilevered Route 134 deck on steel pipe piles, faced with decorative
  // concrete 8 m down to the sand (Kanagawa 2019). The face looks out to sea:
  // no shot or walkable place sees it, so it stays plain concrete in long panels.
  const top = [SECTION.wallTop[0], SECTION.wallTop[1]];
  const usW = stations(C0, C1, 3, 10, 40);
  bag.add(asphalt, ribbon(COAST, usW, top, () => WALK_Y));
  const usNear = stations(-300, 320, 3, 10, 40);
  bag.add(concrete, wallAlong(COAST, usNear, top[0], () => ROAD_Y - 0.02, () => WALK_Y + 0.005, -1));
  bag.add(concrete, wallAlong(COAST, stations(-300, 320, 12, 24, 40), top[1], () => SECTION.sandTop - 0.4, () => WALK_Y, 1));
  // Steps down to the beach from the junction: an opening in the fence and a
  // straight flight along the wall face, descending west.
  const STAIR: [number, number] = [-6.0, -3.6];
  const flight = beachSteps(STAIR[0], top[1]);
  bag.add(concrete, flight.steps);
  bag.add(P, w.tint(flight.rail, "galv"));
  // Wall-top fence: galvanised posts every 2.5 m with three wire ropes, within 260 m.
  // Four-sided posts and caps (12 triangles a post): from the road and the slope they read round.
  const post = new CylinderGeometry(0.05, 0.05, 1.0, 4, 1, true).rotateY(Math.PI / 4);
  const cap = new CylinderGeometry(0.0, 0.06, 0.06, 4, 1, true).rotateY(Math.PI / 4);
  const posts: BufferGeometry[] = [];
  const fenceU: number[] = [];
  for (let u = -200; u <= 220; u += 2.5) if (u < STAIR[0] - 0.3 || u > STAIR[1] + 0.3) fenceU.push(u);
  fenceU.push(STAIR[0] - 0.2, STAIR[1] + 0.2);
  for (const u of fenceU) {
    COAST.offset(u, SECTION.wallFence, p);
    posts.push(place(post.clone(), new Vector3(p.x, WALK_Y + 0.5, p.z)));
    posts.push(place(cap.clone(), new Vector3(p.x, WALK_Y + 1.025, p.z)));
  }
  bag.add(P, w.tint(merge(posts), "galv"));
  for (const h of [0.45, 0.7, 0.92]) {
    for (const [a, b] of [
      [-200, STAIR[0] - 0.2],
      [STAIR[1] + 0.2, 220],
    ]) {
      const us = stations(a, b, 5, 10, 20);
      const s = SECTION.wallFence - 0.06;
      // A thin vertical ribbon reads as a wire rope from either side.
      bag.add(P, w.tint(wallAlong(COAST, us, s, () => WALK_Y + h - 0.012, () => WALK_Y + h + 0.012, 1), "dark"), false);
      bag.add(P, w.tint(wallAlong(COAST, us, s, () => WALK_Y + h - 0.012, () => WALK_Y + h + 0.012, -1), "dark"), false);
    }
  }

  // ------------------------------------------------------------ beach
  // Shichirigahama: dark grey-beige sand, nearly flat from the wall foot
  // (2.3 m T.P.) to the berm 50 m out, then the wet beach face down through
  // the waterline (about 64 m) under the sea. Few long triangles: every 32 m
  // chunk near the crossing a triangle lands in costs a draw per material.
  const sand = lib.sand();
  // Shichirigahama's sand is dark: iron-rich volcanic grains, grey-beige even when dry.
  sand.color.setRGB(0.74, 0.71, 0.67);
  const us = [C0, 260, C1];
  const berm = SECTION.sandTop - 0.9;
  bag.add(sand, ribbon(COAST, us, [top[1], 50], (_u, s) => (s < 20 ? SECTION.sandTop : berm)));
  bag.add(wetSand(sand), ribbon(COAST, us, [50, 92], (_u, s) => (s < 51 ? berm : berm - 4.2)));

  bag.emit(w);
}

/** The swash zone's sand: darker and glossy with the water left by each wave. */
function wetSand(sand: MeshStandardMaterial): MeshStandardMaterial {
  const m = sand.clone();
  m.name = "sand-wet";
  m.color.setRGB(0.62, 0.6, 0.58);
  m.roughness = 0.42;
  return m;
}

/**
 * A flight of concrete steps against the sea wall's face from the wall top
 * at `u0` down to the sand, descending west (−u), 1.5 m wide, with a
 * galvanised handrail on its open side.
 */
function beachSteps(u0: number, face: number): { steps: BufferGeometry; rail: BufferGeometry } {
  const drop = WALK_Y - SECTION.sandTop;
  const n = Math.round(drop / 0.18);
  const rise = drop / n;
  const tread = 0.55;
  const width = 1.5;
  const s = face + width / 2;
  const p = new Vector3();
  const t = new Vector3();
  const steps: BufferGeometry[] = [];
  // The top landing in the fence opening, then one solid block per step down to the sand.
  COAST.offset(u0 + 1.2, s, p);
  COAST.tangent(u0 + 1.2, t);
  const landing = new BoxGeometry(width, 0.3, 2.4);
  steps.push(place(landing, p.clone().setY(WALK_Y - 0.15), Math.atan2(t.x, t.z)));
  for (let k = 0; k < n; k++) {
    const u = u0 - (k + 0.5) * tread;
    const yTop = WALK_Y - (k + 1) * rise;
    const h = yTop - (SECTION.sandTop - 0.3);
    COAST.offset(u, s, p);
    COAST.tangent(u, t);
    steps.push(place(new BoxGeometry(width, h, tread + 0.01), p.clone().setY(yTop - h / 2), Math.atan2(t.x, t.z)));
  }
  // Handrail 0.85 m above the nosings on the open side, posts every 3 m.
  const rail: BufferGeometry[] = [];
  const sr = face + width - 0.08;
  const nose = (u: number) => WALK_Y - Math.max(0, (u0 - u) / tread) * rise;
  const uEnd = u0 - n * tread;
  const a = COAST.offset(u0 + 2.4, sr, new Vector3()).setY(WALK_Y + 0.85);
  const b = COAST.offset(u0, sr, new Vector3()).setY(WALK_Y + 0.85);
  const c = COAST.offset(uEnd, sr, new Vector3()).setY(SECTION.sandTop + 0.85);
  for (const [q0, q1] of [
    [a, b],
    [b, c],
  ]) {
    const d = new Vector3().subVectors(q1, q0);
    const g = new CylinderGeometry(0.024, 0.024, d.length(), 6, 1, true);
    g.rotateX(Math.PI / 2);
    g.lookAt(d);
    g.translate((q0.x + q1.x) / 2, (q0.y + q1.y) / 2, (q0.z + q1.z) / 2);
    rail.push(g);
  }
  for (let u = u0 + 2.4; u >= uEnd; u -= 3) {
    COAST.offset(u, sr, p);
    const y = nose(Math.min(u, u0));
    rail.push(place(new CylinderGeometry(0.024, 0.024, 0.85, 6, 1, true), p.clone().setY(y + 0.425)));
  }
  return { steps: merge(steps), rail: merge(rail) };
}


/** A thin diagonal paint stripe from a to b (atlas-mapped quad), at height y. */
function diag(a: Vector3, b: Vector3, width: number, y: number, cell: { u0: number; v0: number; u1: number; v1: number }): BufferGeometry {
  const d = new Vector3().subVectors(b, a).setY(0);
  const n = new Vector3(-d.z, 0, d.x).normalize().multiplyScalar(width / 2);
  const g = new BufferGeometry();
  const pts = [a.clone().sub(n), a.clone().add(n), b.clone().add(n), b.clone().sub(n)];
  g.setAttribute("position", new Float32BufferAttribute(pts.flatMap((q) => [q.x, y, q.z]), 3));
  g.setAttribute("normal", new Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute("uv", new Float32BufferAttribute([cell.u0, cell.v0, cell.u1, cell.v0, cell.u1, cell.v1, cell.u0, cell.v1], 2));
  const up = new Vector3().subVectors(pts[1], pts[0]).cross(new Vector3().subVectors(pts[2], pts[0])).y > 0;
  g.setIndex(up ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
  return g;
}
