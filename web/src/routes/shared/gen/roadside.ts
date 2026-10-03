import type { CellContext } from "../cell";
import { ARROW_HEAD, ARROW_SHAFT, cell as atlas, DISC_OUTLINE, SHIELD_OUTLINE, SHIELDS, SIGNAL_NAMES, SIZE, SPEEDS, STOP_OUTLINE, TOWNS, type Outline } from "../kit/roadside-layout";
import { DETAIL } from "../layers";
import type { MeshBuilder, V3 } from "../mesh";
import { clamp, hash2 } from "../noise";
import type { Probe, RouteWorld } from "../world";
import { Cover } from "./terrain";

/**
 * The equipment of a national road in a Hokkaido winter, all in the
 * `detail` layer (within 640 m; an arrow board 0.15 m wide is a tenth of a
 * pixel of the handheld's screen there, so nothing of it is worth a coarser
 * copy further out). Dimensions follow the research report
 * (`.pocket-build/research/hokkaido-r237/REPORT.md` §1.4–1.11):
 *
 *   矢羽根      固定式視線誘導柱: a galvanised post 2–3 m outside the edge
 *               line, a curved arm reaching over the shoulder at 6.5 m, and
 *               the banded arrow with its red head pointing down at the
 *               edge line; both sides, 80 m apart on straights and
 *               2.2·√(R−15) m in curves, outside the towns. They stand
 *               instead of delineators and snow poles, not with them.
 *   snow poles  at junction corners, the ends of guard cables and bridges,
 *               and every 40 m through the towns
 *   guards      cable where the ground falls away (only its top stands out
 *               of the bank), W-beam at bridges and in towns
 *   utility poles and their wires along the road and the side streets
 *   signs       route shields (on the arrow posts), speed limits, distance
 *               boards, boundary signs, warnings, 止まれ on the side roads
 *   signals, street lamps and bus stops
 *
 * What stands along the driven road is planned once for the whole route
 * (positions depend on the towns, the junctions and each other), then each
 * cell draws the things whose foot stands in it.
 */

const M = "roadside";
const LIT = "roadside-lit";

type RGBA = readonly [number, number, number, number];
type UV = readonly [number, number, number, number];

const WHITE: RGBA = [255, 255, 255, 255];
const PAINT: RGBA = [226, 226, 222, 255];
/** Galvanised steel under an overcast sky (#8C9498 once the atlas's pale metal is tinted). */
const STEEL: RGBA = [152, 161, 165, 255];
const CONCRETE: RGBA = [158, 156, 151, 255];
const DARK: RGBA = [60, 62, 66, 255];
const WIRE: RGBA = [52, 54, 58, 255];
const SIGN_BACK: RGBA = [126, 131, 136, 255];
const HOUSING: RGBA = [86, 89, 93, 255];

const U_POLE = atlas("pole").uv;
const U_WHITE = atlas("white").uv;

// Dimensions (m). Heights are above the road surface unless noted.
/** The outer edge line of a 3.25 m lane, from the centre line: what the arrows point at. */
const EDGE_LINE = 3.25;
/** 矢羽根: the post's distance outside the edge line, where its bend starts, the arm's height, the arrow's tip. */
const ARROW = { out: 2.9, bend: 5.8, arm: 6.5, tip: 5.5, every: 80, shield: 4.5 };
/** Distribution poles: 11–12 m of concrete above ground, 38 m apart, behind the arrow posts. */
const POLE = { h: 11.6, every: 38, phase: 17, rural: 3.9, town: 1.7 };
const SIDE_POLE = { h: 9.6, every: 40, behind: 1.3 };
const LAMP = { every: 45, phase: 23, h: 8.6, arm: 1.9, behind: 0.9 };
/** Guards: stations along the road, posts of a W-beam and of a cable, how far the ground must fall `out` metres away. */
const GUARD = { step: 2, beam: 4, cable: 6, behind: 0.45, drop: 2.4, out: 14, bridge: 24 };

type Kind = "arrow" | "snowpole" | "rail" | "cable" | "pole" | "shield" | "speed" | "warn" | "bound" | "board" | "signal" | "lamp" | "bus" | "stop";

export interface Item {
  kind: Kind;
  /** The foot: what decides the cell. */
  x: number;
  z: number;
  /** Arc length and signed offset on the driven road. */
  s: number;
  d: number;
  /** 1: for traffic in the direction of the drive (faces look back along it); −1: for oncoming traffic. */
  dir: number;
  /** Atlas cell of a sign's face, a limit, a town. */
  face?: string;
  /** The next post of a rail or pole of a line: the span to it belongs to this item. */
  next?: { x: number; z: number; s: number; d: number };
  /** A distance board's rows, top to bottom: town index and kilometres. */
  rows?: [number, number][];
  /** A face's outward normal in the ground plane, for things that do not follow the driven road. */
  nx?: number;
  nz?: number;
  /** A pole with a transformer. */
  extra?: boolean;
  /** A route shield carried by an arrow post, and the direction it is for. */
  shield?: string;
  shieldDir?: number;
  /** A signal's name plate: index into the atlas's junction names. */
  name?: number;
}

export interface Plan {
  cells: Map<number, Item[]>;
  /** Per 50 m of the driven road: 1 where buildings line it. */
  town: Uint8Array;
}

const key = (x: number, z: number) => (Math.floor(x / DETAIL.size) + 32768) * 65536 + (Math.floor(z / DETAIL.size) + 32768);
const newProbe = (): Probe => ({ e: 0, road: null, s: 0, d: 0, w: 0, y: 0, zone: 0, zoneRoad: null, zoneS: 0, zoneD: 0 });
const P = newProbe();
const TOWN_COVER = new Set(["residential", "commercial", "retail", "industrial"]);
const TOWN_STEP = 50;

/** The top of the snow at a point: the graded ground and the ploughed bank on it. */
function snowTop(world: RouteWorld, x: number, z: number): number {
  world.probe(x, z, P);
  const y = world.base(x, z, P);
  return P.road && P.e > 0 ? y + world.bank(P.e, P.s, P.road.cls, Math.sign(P.d)) : y;
}

/** Where buildings line the driven road, per 50 m: land use beside it, or houses close to it; short gaps closed. */
function towns(world: RouteWorld): Uint8Array {
  const line = world.main.line;
  const n = Math.ceil(line.length / TOWN_STEP) + 1;
  const raw = new Uint8Array(n);
  const half = world.main.half;
  for (let i = 0; i < n; i++) {
    const p = line.at(i * TOWN_STEP);
    const rx = -p.tz;
    const rz = p.tx;
    const cover = new Cover(world, p.x - 40, p.z - 40, p.x + 40, p.z + 40);
    let used = 0;
    for (const side of [-1, 1]) for (const out of [14, 32]) if (TOWN_COVER.has(cover.at(p.x + rx * side * (half + out), p.z + rz * side * (half + out)))) used++;
    // Houses whose centre is within 50 m of the centre line, on this 50 m.
    let houses = 0;
    for (const f of world.source.query("building", p.x - 70, p.z - 70, p.x + 70, p.z + 70)) {
      const cx = (f.box[0] + f.box[2]) / 2 - p.x;
      const cz = (f.box[1] + f.box[3]) / 2 - p.z;
      if (Math.abs(cx * rx + cz * rz) < 50 && Math.abs(cx * p.tx + cz * p.tz) < 25) houses++;
    }
    raw[i] = used >= 2 || houses >= 3 || (used >= 1 && houses >= 2) ? 1 : 0;
  }
  // A stretch is town when two of its five stations are; then runs shorter than 250 m are dropped.
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let k = -2; k <= 2; k++) c += raw[Math.max(0, Math.min(n - 1, i + k))];
    out[i] = c >= 2 ? 1 : 0;
  }
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && out[j] === out[i]) j++;
    if (out[i] === 1 && j - i < 5) out.fill(0, i, j);
    i = j;
  }
  return out;
}

/** Everything that stands along the driven road, by detail cell (exported for checks). */
export function planRoadside(world: RouteWorld): Plan {
  const main = world.main;
  const line = main.line;
  const L = line.length;
  const half = main.half;
  const town = towns(world);
  const inTown = (s: number) => town[Math.max(0, Math.min(town.length - 1, Math.round(s / TOWN_STEP)))] === 1;
  const onBridge = (s: number) => main.bridge[line.segment(s)] === 1 || main.bridge[line.segment(Math.min(L, s + 3))] === 1 || main.bridge[line.segment(Math.max(0, s - 3))] === 1;
  const cells = new Map<number, Item[]>();
  const pt = { x: 0, y: 0, z: 0, tx: 0, tz: -1, grade: 0 };
  const add = (it: Item): Item => {
    const k = key(it.x, it.z);
    const list = cells.get(k);
    if (list) list.push(it);
    else cells.set(k, [it]);
    return it;
  };
  /** A foot at offset `d` near arc length `s`, clear of every ploughed area by `clear` metres; moved along the road past a side road's mouth. */
  const stand = (s: number, d: number, clear: number, shifts: readonly number[] = SHIFTS): { x: number; z: number; s: number; d: number } | null => {
    for (const ds of shifts) {
      const s2 = s + ds;
      if (s2 < 4 || s2 > L - 4 || onBridge(s2)) continue;
      line.at(s2, pt);
      const x = pt.x - pt.tz * d;
      const z = pt.z + pt.tx * d;
      world.probe(x, z, P);
      if (P.e >= clear) return { x, z, s: s2, d };
    }
    return null;
  };

  // Bridges of the driven road, as arc-length spans.
  const bridges: [number, number][] = [];
  for (let i = 0; i < line.n; i++) {
    if (!main.bridge[i]) continue;
    let j = i;
    while (j + 1 < line.n && main.bridge[j + 1]) j++;
    bridges.push([line.s[i], line.s[Math.min(line.n - 1, j + 1)]]);
    i = j;
  }

  // Guards: where the ground 14 m out lies well below the road, in runs of at least 40 m, and at the ends of every bridge.
  // W-beam at bridges and in towns; elsewhere guard cable. A snow pole marks each end of a run.
  const ng = Math.floor(L / GUARD.step) + 1;
  const guarded = [new Uint8Array(ng), new Uint8Array(ng)];
  const atBridge = new Uint8Array(ng);
  for (const [a, b] of bridges) for (let i = Math.max(0, Math.floor((a - GUARD.bridge) / GUARD.step)); i <= Math.min(ng - 1, Math.ceil((b + GUARD.bridge) / GUARD.step)); i++) atBridge[i] = 1;
  for (let si = 0; si < 2; si++) {
    const side = si === 0 ? -1 : 1;
    const f = guarded[si];
    for (let i = 0; i < ng; i++) {
      line.at(i * GUARD.step, pt);
      const o = side * (half + GUARD.out);
      f[i] = pt.y - world.elevation(pt.x - pt.tz * o, pt.z + pt.tx * o) > GUARD.drop ? 1 : 0;
    }
    // Close gaps up to 20 m, drop runs under 40 m.
    for (let pass = 0; pass < 2; pass++) {
      const want = pass === 0 ? 0 : 1;
      const min = (pass === 0 ? 20 : 40) / GUARD.step;
      for (let i = 0; i < ng; ) {
        let j = i;
        while (j < ng && f[j] === f[i]) j++;
        if (f[i] === want && j - i < min && i > 0 && j < ng) f.fill(1 - want, i, j);
        i = j;
      }
    }
    for (let i = 0; i < ng; i++) if (atBridge[i]) f[i] = 1;
    let prev: Item | null = null;
    const endPole = (it: Item, ds: number) => {
      const p = stand(it.s + ds, side * (half + GUARD.behind + 0.1), 0.3, HERE);
      if (p) add({ kind: "snowpole", ...p, dir: 1 });
    };
    for (let i = 0; i < ng; i++) {
      const s = i * GUARD.step;
      const beam = atBridge[i] === 1 || inTown(s);
      const every = beam ? GUARD.beam : GUARD.cable;
      if (f[i] && prev && s - prev.s < every - 0.01) continue;
      const p = f[i] ? stand(s, side * (half + GUARD.behind), 0.3, HERE) : null;
      if (!p) {
        if (f[i]) f[i] = 0;
        if (prev) endPole(prev, 0.7);
        prev = null;
        continue;
      }
      const it = add({ kind: beam ? "rail" : "cable", ...p, dir: 1 });
      if (prev && s - prev.s < every + GUARD.step + 0.01) prev.next = p;
      else {
        if (prev) endPole(prev, 0.7);
        endPole(it, -0.7);
      }
      prev = it;
    }
  }
  const hasGuard = (s: number, side: number) => guarded[side < 0 ? 0 : 1][Math.max(0, Math.min(ng - 1, Math.round(s / GUARD.step)))] === 1;

  // 矢羽根 on both sides outside the towns: 80 m apart, closer in curves (S = 2.2·√(R − 15)).
  const edge = Math.min(EDGE_LINE, half - 0.3);
  const arrows: Item[] = [];
  for (let s = 40; s < L - 20; ) {
    const k = Math.abs(line.curvature(s, 60));
    const step = k > 1 / 1400 ? clamp(2.2 * Math.sqrt(Math.max(1, 1 / k - 15)), 20, ARROW.every) : ARROW.every;
    if (!inTown(s))
      for (const side of [-1, 1]) {
        const p = stand(s, side * (edge + ARROW.out), 0.7);
        if (p) arrows.push(add({ kind: "arrow", ...p, dir: 1 }));
      }
    s += Math.round(step);
  }

  // Snow poles: every 40 m through the towns, where no arrows stand.
  for (let s = 20; s < L - 10; s += 40) {
    if (!inTown(s)) continue;
    for (const side of [-1, 1]) {
      const q = hasGuard(s, side) ? null : stand(s, side * (half + 0.5), 0.3, HERE);
      if (q) add({ kind: "snowpole", ...q, dir: 1 });
    }
  }

  // Snow poles at the corners of every side road's mouth.
  const seenMouth = new Set<string>();
  for (const j of world.junctions) {
    const id = `${Math.round(j.s / 8)}|${j.side}`;
    if (seenMouth.has(id) || j.road.type === "trunk") continue;
    seenMouth.add(id);
    for (const o of [-1, 1]) {
      const p = stand(j.s + o * (j.road.half + 1.1), j.side * (half + 0.45), 0.25, HERE);
      if (p) add({ kind: "snowpole", ...p, dir: 1 });
    }
  }

  // Utility poles: one line on the right all the way, a second on the left through the towns.
  for (const side of [1, -1]) {
    let prev: Item | null = null;
    for (let k = 0; POLE.phase + k * POLE.every < L - 10; k++) {
      const s = POLE.phase + k * POLE.every;
      const urban = inTown(s);
      if (side < 0 && !urban) {
        prev = null;
        continue;
      }
      const p = stand(s, side * (half + (urban ? POLE.town : POLE.rural)), 0.8, POLE_SHIFTS);
      if (!p) continue;
      const it = add({ kind: "pole", ...p, dir: 1, extra: hash2(k, 71 + side) < (urban ? 0.3 : 0.1) });
      if (prev && p.s - prev.s < 135) prev.next = p;
      prev = it;
    }
  }

  // Signs for the driver stand on the left, 1.3 m behind the edge, apart from each other and from the 矢羽根 posts.
  const taken: [number, number][] = [];
  const sign = (s: number, dir: number, behind = 1.3): { x: number; z: number; s: number; d: number } | null => {
    // Off the 40 m module the arrows stand on.
    let s2 = Math.floor(s / 40) * 40 + 14;
    for (let tries = 0; tries < 6; tries++) {
      if (taken.some(([ts, td]) => td === dir && Math.abs(ts - s2) < 30)) {
        s2 += 40;
        continue;
      }
      const p = stand(s2, -dir * (half + behind), 0.8, SIGN_SHIFTS);
      if (p) {
        taken.push([p.s, dir]);
        return p;
      }
      s2 += 40;
    }
    return null;
  };

  // Signals first: the other signs keep clear of them.
  const signals: number[] = [];
  const signalName = new Map<number, number>();
  for (const f of world.source.features) {
    if (f.kind !== "point" || f.type !== "traffic_signals") continue;
    const p = line.project(f.pts[0], f.pts[1], 9);
    if (!p || p.s < 12 || p.s > L - 12) continue;
    const name = (SIGNAL_NAMES as readonly string[]).indexOf(f.name || String(f.tags["name:ja"] ?? ""));
    const near = signals.find((s) => Math.abs(s - p.s) < 25);
    if (near === undefined) signals.push(p.s);
    if (name >= 0) signalName.set(near ?? p.s, name);
  }
  signals.sort((a, b) => a - b);
  for (const s of signals) {
    // The head for each direction hangs beyond the junction, over its own lane.
    for (const dir of [1, -1]) {
      const p = stand(s + dir * 13, -dir * (half + 1.1), 0.5, dir > 0 ? AHEAD : BEHIND);
      if (!p) continue;
      taken.push([p.s, dir]);
      add({ kind: "signal", ...p, dir, name: signalName.get(s) });
    }
  }

  // Speed limits: where the limit changes, and again every 6 km.
  const limits = world.source.route.limits;
  limits.forEach((l, i) => {
    if (!(SPEEDS as readonly number[]).includes(l.kmh)) return;
    const end = i + 1 < limits.length ? limits[i + 1].s : L;
    for (let s = l.s + (i === 0 ? 150 : 20); s < end - 200; s += 6000) {
      const p = sign(s, 1);
      if (p) add({ kind: "speed", ...p, dir: 1, face: `speed-${l.kmh}` });
    }
  });

  // Route shields: after the start, every 2.5 km, and after the junctions with the larger roads; for oncoming traffic half as often.
  const refAt = (s: number): string | null => {
    let ref = "";
    for (const n of world.source.route.names) if (n.s <= s) ref = n.ref;
    const all = ref.split(";");
    return SHIELDS.find((r) => all.includes(r)) ?? null;
  };
  const shields: number[] = [];
  for (let s = 320; s < L - 100; s += 2500) shields.push(s);
  const LARGER = new Set(["trunk", "primary", "secondary", "tertiary"]);
  for (const j of world.junctions) if (LARGER.has(j.road.type) && j.s > 100 && !shields.some((s) => Math.abs(s - (j.s + 110)) < 1000)) shields.push(j.s + 110);
  // A shield hangs on the nearest arrow post of its side; where there are none (the towns) it has a post of its own.
  const shield = (s: number, dir: number) => {
    const ref = refAt(s);
    if (!ref) return;
    let best: Item | null = null;
    for (const a of arrows) if (Math.sign(a.d) === -dir && !a.shield && Math.abs(a.s - s) < 90 && (!best || Math.abs(a.s - s) < Math.abs(best.s - s))) best = a;
    if (best) {
      best.shield = `shield-${ref}`;
      best.shieldDir = dir;
      return;
    }
    const p = sign(s, dir);
    if (p) add({ kind: "shield", ...p, dir, face: `shield-${ref}` });
  };
  for (const s of shields) shield(s, 1);
  for (let s = 1570; s < L - 100; s += 5000) shield(s, -1);

  // The towns of the road, from the survey's place points, in the order the road reaches them.
  const places: { index: number; s: number }[] = [];
  for (const f of world.source.features) {
    if (f.kind !== "point" || !(f.type === "place-town" || f.type === "place-city" || f.type === "place-village")) continue;
    const index = TOWNS.findIndex((t) => f.name === t.key || f.name === t.key + t.suffix);
    const p = index >= 0 ? line.project(f.pts[0], f.pts[1], 4000) : null;
    if (p && !places.some((q) => q.index === index)) places.push({ index, s: p.s });
  }
  places.sort((a, b) => a.s - b.s);

  // Distance boards (方面及び距離): after the start, past each town, and 3 km before each.
  const boards: number[] = [900];
  for (const t of places) boards.push(t.s - 3200, t.s + 1800);
  boards.sort((a, b) => a - b);
  let last = -1e9;
  for (const s of boards) {
    if (s < 300 || s > L - 1500 || s - last < 1500) continue;
    const ahead = places.filter((t) => t.s > s + 700);
    if (!ahead.length) continue;
    // The next two towns and the end of the road, the furthest on top.
    const pick = ahead.length > 3 ? [ahead[0], ahead[1], ahead[ahead.length - 1]] : ahead;
    const p = sign(s, 1, 1.4);
    if (!p) continue;
    last = s;
    add({ kind: "board", ...p, dir: 1, rows: pick.map((t): [number, number] => [t.index, Math.max(1, Math.round((t.s - p.s) / 1000))]).reverse() });
  }

  // Boundary signs. The survey has no boundaries: the atlas's town list carries the kilometre where it knows one;
  // otherwise each is put halfway between two towns' centres, and a third of the way in before the first.
  const origin = TOWNS.findIndex((t) => world.source.route.start.native.includes(t.key));
  places.forEach((t, i) => {
    const known = TOWNS[t.index].boundary;
    const s = known !== undefined && known * 1000 < Math.min(t.s, L - 50) ? known * 1000 : i === 0 ? t.s - Math.min(6000, t.s / 3) : (places[i - 1].s + t.s) / 2;
    const before = i === 0 ? origin : places[i - 1].index;
    const p = sign(s, 1);
    if (p) add({ kind: "bound", ...p, dir: 1, face: `bound-${t.index}` });
    const q = before >= 0 ? sign(s + 40, -1) : null;
    if (q) add({ kind: "bound", ...q, dir: -1, face: `bound-${before}` });
  });

  // Warnings, sparingly: before the tightest bends, and before the long bridges (their decks ice first).
  let lastWarn = -1e9;
  for (let s = 400; s < L - 300; s += 20) {
    if (s - lastWarn < 1500) continue;
    const tight = Math.abs(line.curvature(s + 170, 60)) > 1 / 190;
    let bridge = false;
    if (!tight && main.bridge[line.segment(s + 140)] === 1 && main.bridge[line.segment(s + 120)] === 0) bridge = main.bridge[line.segment(s + 200)] === 1;
    if (!tight && !bridge) continue;
    const p = sign(s, 1);
    if (!p) continue;
    lastWarn = s;
    add({ kind: "warn", ...p, dir: 1, face: tight ? "curve" : "slip" });
  }

  // Street lamps through the towns, alternating sides.
  for (let k = 0; LAMP.phase + k * LAMP.every < L - 10; k++) {
    const s = LAMP.phase + k * LAMP.every;
    if (!inTown(s)) continue;
    const side = k % 2 === 0 ? -1 : 1;
    const p = stand(s, side * (half + LAMP.behind), 0.5);
    if (p) add({ kind: "lamp", ...p, dir: 1 });
  }
  // And outside them at signalled junctions, at the ends of the longer bridges and at a viewpoint's lay-by.
  const lamp = (s: number, side: number) => {
    if (s < 10 || s > L - 10 || inTown(s)) return;
    const p = stand(s, side * (half + LAMP.behind), 0.5);
    if (p) add({ kind: "lamp", ...p, dir: 1 });
  };
  for (const s of signals) {
    lamp(s - 7, -1);
    lamp(s + 7, 1);
  }
  for (const [a, b] of bridges) {
    if (b - a < 40) continue;
    lamp(a - 8, -1);
    lamp(b + 8, 1);
  }
  for (const f of world.source.features) {
    if (f.kind !== "point" || f.type !== "tourism-viewpoint") continue;
    const p = line.project(f.pts[0], f.pts[1], 60);
    if (p) for (const o of [-25, 25]) lamp(p.s + o, Math.sign(p.d) || 1);
  }

  // Bus stops: the survey's points near the road; a point on the centre line is put on the left of one direction or the other.
  const stops: { s: number; side: number }[] = [];
  for (const f of world.source.features) {
    if (f.kind !== "point" || f.type !== "bus_stop") continue;
    const p = line.project(f.pts[0], f.pts[1], 13);
    if (!p) continue;
    let side = Math.abs(p.d) > 1 ? Math.sign(p.d) : -1;
    if (stops.some((q) => Math.abs(q.s - p.s) < 250 && q.side === side)) side = -side;
    if (stops.some((q) => Math.abs(q.s - p.s) < 60 && q.side === side)) continue;
    const q = stand(p.s, side * (half + 0.8), 0.45);
    if (!q) continue;
    stops.push({ s: p.s, side });
    add({ kind: "bus", ...q, dir: -side });
  }

  // 止まれ on the side roads that meet the road without a signal: on the left of the driver waiting to join.
  const seenStop = new Set<string>();
  const STOPPED = new Set(["residential", "unclassified", "tertiary", "secondary", "living_street"]);
  for (const j of world.junctions) {
    const id = `${Math.round(j.s / 10)}|${j.side}`;
    if (seenStop.has(id) || !STOPPED.has(j.road.type) || signals.some((s) => Math.abs(s - j.s) < 35) || onBridge(j.s)) continue;
    seenStop.add(id);
    line.at(j.s, pt);
    // Away from the driven road, along the side road as it leaves.
    const far = j.road.line.project(pt.x - pt.tz * j.side * (half + 9), pt.z + pt.tx * j.side * (half + 9), 14);
    if (!far) continue;
    const a = j.road.line.at(far.s);
    const out = (a.x - pt.x) * a.tx + (a.z - pt.z) * a.tz > 0 ? 1 : -1;
    const ox = a.tx * out;
    const oz = a.tz * out;
    // The waiting driver looks along −o; their left is (−oz, ox)… of −o, which is (oz, −ox) turned about.
    const lx = -oz;
    const lz = ox;
    const x = a.x - ox * 3.2 + lx * (j.road.half + 0.8);
    const z = a.z - oz * 3.2 + lz * (j.road.half + 0.8);
    world.probe(x, z, P);
    if (P.e < 0.35) continue;
    add({ kind: "stop", x, z, s: j.s, d: 0, dir: 1, nx: ox, nz: oz });
  }

  return { cells, town };
}

const SHIFTS = [0, 6, -6, 12, -12, 18, -18];
const HERE = [0];
const POLE_SHIFTS = [0, 5, -5, 10, -10, 15];
const SIGN_SHIFTS = [0, 8, -8];
const AHEAD = [0, 4, 8, 12, 16];
const BEHIND = [0, -4, -8, -12, -16];

const plans = new WeakMap<RouteWorld, Plan>();

/** Poles, signs, arrows, delineators, guard rails, wires, signals, lamps: what this generator puts in a cell. */
export function roadside(c: CellContext): void {
  if (c.layer.name !== "detail") return;
  let p = plans.get(c.world);
  if (!p) plans.set(c.world, (p = planRoadside(c.world)));
  const d = new Draw(c.world, c.mb);
  for (const it of p.cells.get(key(c.x0 + 1, c.z0 + 1)) ?? []) d.item(it);
  sideStreets(c, d);
}

/** Utility poles and their wires along the side roads: every 40 m on one side, clear of the driven road's own. */
function sideStreets(c: CellContext, draw: Draw): void {
  const world = c.world;
  const main = world.main;
  for (const road of world.roadsIn(c.x0, c.z0, c.x1, c.z1)) {
    if (road.main || !SIDE_TYPES.has(road.type) || road.line.length < 90) continue;
    const side = hash2(road.index, 911) < 0.5 ? -1 : 1;
    const d = side * (road.half + SIDE_POLE.behind);
    const at = (k: number): { x: number; z: number; rx: number; rz: number } | null => {
      const s = 20 + k * SIDE_POLE.every;
      if (s > road.line.length - 6) return null;
      const p = road.line.at(s);
      const x = p.x - p.tz * d;
      const z = p.z + p.tx * d;
      world.probe(x, z, P);
      if (P.e < 0.6 || (P.road !== road && P.e < 1.5)) return null;
      if (main.line.project(x, z, main.half + 9)) return null;
      return { x, z, rx: -p.tz, rz: p.tx };
    };
    const n = Math.floor((road.line.length - 26) / SIDE_POLE.every) + 1;
    for (let k = 0; k < n; k++) {
      // Cheap reject before the probes: the station's own point.
      const s = 20 + k * SIDE_POLE.every;
      const q = road.line.at(s);
      if (q.x < c.x0 - 8 || q.x >= c.x1 + 8 || q.z < c.z0 - 8 || q.z >= c.z1 + 8) continue;
      const a = at(k);
      if (!a || a.x < c.x0 || a.x >= c.x1 || a.z < c.z0 || a.z >= c.z1) continue;
      draw.sidePole(a, at(k + 1), hash2(road.index * 131 + k, 5) < 0.14);
    }
  }
}

const SIDE_TYPES = new Set(["primary", "secondary", "tertiary", "unclassified", "residential", "living_street"]);

/** Geometry of the kit of parts, in a cell's mesh builder. */
class Draw {
  private pt = { x: 0, y: 0, z: 0, tx: 0, tz: -1, grade: 0 };
  constructor(
    private world: RouteWorld,
    private mb: MeshBuilder,
  ) {}

  item(it: Item): void {
    const line = this.world.main.line;
    const p = line.at(it.s, this.pt);
    // Forward and right of the driven road at the item, and its surface there.
    const f: Frame = { x: it.x, z: it.z, fx: p.tx, fz: p.tz, rx: -p.tz, rz: p.tx, road: p.y - 0.02 * Math.min(Math.abs(it.d), this.world.main.half), snow: snowTop(this.world, it.x, it.z), side: Math.sign(it.d) || -1 };
    switch (it.kind) {
      case "arrow":
        return this.arrow(f, it);
      case "snowpole":
        return this.snowPole(f, it);
      case "rail":
        return this.rail(f, it);
      case "cable":
        return this.cable(f, it);
      case "pole":
        return this.pole(f, it);
      case "shield":
        return this.faceOnPost(f, it, SHIELD_OUTLINE, SIZE.shield.w, SIZE.shield.h, 2.9);
      case "speed":
        return this.faceOnPost(f, it, DISC_OUTLINE, SIZE.speed, SIZE.speed, 2.9);
      case "warn":
        return this.panel(f, it, SIZE.warn.w, SIZE.warn.h, 2.9, 1);
      case "bound":
        return this.boundary(f, it);
      case "board":
        return this.board(f, it);
      case "signal":
        return this.signal(f, it);
      case "lamp":
        return this.lamp(f);
      case "bus":
        return this.bus(f, it);
      case "stop":
        return this.stop(f, it);
    }
  }

  // ── parts ────────────────────────────────────────────────────────────

  private tube(a: V3, b: V3, ra: number, rb: number, sides: number, color: RGBA, uv: UV = U_POLE, material = M): void {
    this.mb.tube(material, a, b, ra, rb, sides, uv, color);
  }

  /**
   * A flat face: `o` its centre, (nx, nz) its outward normal in the ground
   * plane, w × h metres, cut to `outline` (the whole rectangle when absent).
   * Seen from the front, u runs to the viewer's right.
   */
  private face(material: string, o: V3, nx: number, nz: number, w: number, h: number, uv: UV, color: RGBA = WHITE, outline?: Outline, tris?: readonly number[]): void {
    const mb = this.mb;
    const ux = nz;
    const uz = -nx;
    const n: V3 = [nx, 0, nz];
    const pts = outline ?? RECT;
    const base = mb.count(material);
    for (const [px, py] of pts) mb.vertex(material, [o[0] + ux * px * w, o[1] + py * h, o[2] + uz * px * w], n, uv[0] + (px + 0.5) * (uv[2] - uv[0]), uv[1] + (py + 0.5) * (uv[3] - uv[1]), color);
    if (tris) for (let i = 0; i < tris.length; i += 3) mb.tri(material, base + tris[i], base + tris[i + 1], base + tris[i + 2]);
    else for (let i = 1; i + 1 < pts.length; i++) mb.tri(material, base, base + i, base + i + 1);
  }

  /** A sign plate: its face, and a grey back 2 cm behind. */
  private plate(o: V3, nx: number, nz: number, w: number, h: number, name: string, outline?: Outline): void {
    this.face(M, o, nx, nz, w, h, atlas(name).uv, WHITE, outline);
    this.face(M, [o[0] - nx * 0.02, o[1], o[2] - nz * 0.02], -nx, -nz, w, h, U_WHITE, SIGN_BACK, outline);
  }

  /** A rectangle in a face's own plane: x0..x1 to the viewer's right of `o`, y0..y1 above it. */
  private patch(material: string, o: V3, nx: number, nz: number, x0: number, y0: number, x1: number, y1: number, uv: UV, color: RGBA = WHITE): void {
    const ux = nz;
    const uz = -nx;
    const cx = (x0 + x1) / 2;
    this.face(material, [o[0] + ux * cx, o[1] + (y0 + y1) / 2, o[2] + uz * cx], nx, nz, x1 - x0, y1 - y0, uv, color);
  }

  /** A wire from a to b hanging `sag` metres at mid-span: a three-sided prism. */
  private wire(a: V3, b: V3, sag: number, r: number, segs: number): void {
    const mb = this.mb;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    // Across the wire, in the ground plane.
    const hx = -dz / l;
    const hz = dx / l;
    const base = mb.count(M);
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const x = a[0] + dx * t;
      const y = a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t);
      const z = a[2] + dz * t;
      for (const [ch, cv] of WIRE_SECTION) mb.vertex(M, [x + hx * ch * r, y + cv * r, z + hz * ch * r], [hx * ch, cv, hz * ch], U_WHITE[0], U_WHITE[1], WIRE);
    }
    for (let k = 0; k < segs; k++)
      for (let j = 0; j < 3; j++) {
        const i0 = base + k * 3 + j;
        const i1 = base + k * 3 + ((j + 1) % 3);
        mb.tri(M, i0, i0 + 3, i1 + 3);
        mb.tri(M, i0, i1 + 3, i1);
      }
  }

  /** A box between two heights around an axis point, long along (ax, az): crossarms, lamp heads, signal heads. */
  private bar(cx: number, y0: number, cz: number, ax: number, az: number, halfLong: number, halfWide: number, h: number, color: RGBA, underside = false): void {
    this.mb.box(M, cx, y0, cz, halfLong, halfWide, h, Math.atan2(-az, ax), U_WHITE, color);
    if (underside) {
      const px = -az;
      const pz = ax;
      const c = (l: number, w: number): V3 => [cx + ax * l * halfLong + px * w * halfWide, y0, cz + az * l * halfLong + pz * w * halfWide];
      this.mb.quad(M, c(-1, -1), c(1, -1), c(1, 1), c(-1, 1), U_WHITE, color, [0, -1, 0]);
    }
  }

  // ── things ───────────────────────────────────────────────────────────

  /**
   * 矢羽根: a galvanised post behind the bank, bent over at its head into a
   * long arm, and the arrow hanging from the arm's end, point down over
   * the edge line. Some carry the route's shield lower on the post.
   */
  private arrow(f: Frame, it: Item): void {
    const y = f.road;
    const ix = -f.rx * f.side;
    const iz = -f.rz * f.side;
    const at = (inward: number, h: number): V3 => [f.x + ix * inward, y + h, f.z + iz * inward];
    this.tube([f.x, f.snow - 0.4, f.z], at(0, ARROW.bend), 0.065, 0.052, 5, STEEL);
    // The bend: a quarter circle in two pieces, then the arm.
    const r = ARROW.arm - ARROW.bend;
    const mid = at(r * (1 - Math.SQRT1_2), ARROW.bend + r * Math.SQRT1_2);
    this.tube(at(0, ARROW.bend - 0.03), mid, 0.052, 0.05, 4, STEEL);
    this.tube(mid, at(r + 0.03, ARROW.arm), 0.05, 0.048, 4, STEEL);
    const edge = Math.min(EDGE_LINE, this.world.main.half - 0.3);
    const reach = Math.abs(it.d) - edge;
    const { w, h } = SIZE.arrow;
    this.tube(at(r, ARROW.arm), at(reach - (w * ARROW_SHAFT) / 2, ARROW.arm), 0.048, 0.04, 4, STEEL);
    const o = at(reach, ARROW.tip + h / 2);
    const uv = atlas("arrow").uv;
    // Both faces carry the bands: one for each direction of travel.
    this.face(M, [o[0] - f.fx * 0.012, o[1], o[2] - f.fz * 0.012], -f.fx, -f.fz, w, h, uv, WHITE, ARROW_OUTLINE, ARROW_TRIS);
    this.face(M, [o[0] + f.fx * 0.012, o[1], o[2] + f.fz * 0.012], f.fx, f.fz, w, h, uv, WHITE, ARROW_OUTLINE, ARROW_TRIS);
    if (it.shield) {
      const nx = -f.fx * it.shieldDir!;
      const nz = -f.fz * it.shieldDir!;
      this.plate([f.x + nx * 0.09, y + ARROW.shield, f.z + nz * 0.09], nx, nz, SIZE.shield.w, SIZE.shield.h, it.shield, SHIELD_OUTLINE);
    }
  }

  /** A snow pole: red and white bands, pushed into the bank at the edge, never quite upright. */
  private snowPole(f: Frame, it: Item): void {
    const lean = 0.09;
    const lx = (hash2(Math.round(it.s), 3 + f.side) - 0.5) * 2 * lean;
    const lz = (hash2(Math.round(it.s), 9 + f.side) - 0.5) * 2 * lean;
    const top = Math.max(f.road + 2.0, f.snow + 1.3);
    this.tube([f.x, f.snow - 0.25, f.z], [f.x + lx, top, f.z + lz], 0.032, 0.032, 3, WHITE, atlas("stripes").uv);
  }

  /** A guard cable's post and the cables to the next: only the top of it stands out of the bank. */
  private cable(f: Frame, it: Item): void {
    const top = (x: number, z: number, road: number) => Math.max(road + 0.8, snowTop(this.world, x, z) + 0.3);
    const y1 = top(f.x, f.z, f.road);
    this.tube([f.x, f.snow - 0.3, f.z], [f.x, y1, f.z], 0.045, 0.045, 3, STEEL);
    const n = it.next;
    if (!n) return;
    const q = this.world.main.line.at(n.s);
    const y2 = top(n.x, n.z, q.y - 0.02 * this.world.main.half);
    const ix = -f.rx * f.side;
    const iz = -f.rz * f.side;
    // Two of the cables show: each a ribbon 3 cm deep on the road's side of the posts, seen from both sides.
    for (const down of [0.06, 0.2]) {
      const a: V3 = [f.x + ix * 0.05, y1 - down - 0.03, f.z + iz * 0.05];
      const b: V3 = [n.x + ix * 0.05, y2 - down - 0.03, n.z + iz * 0.05];
      const a1: V3 = [a[0], a[1] + 0.03, a[2]];
      const b1: V3 = [b[0], b[1] + 0.03, b[2]];
      const front: [V3, V3, V3, V3] = f.side < 0 ? [a, b, b1, a1] : [b, a, a1, b1];
      this.mb.quad(M, front[0], front[1], front[2], front[3], U_WHITE, STEEL, [ix, 0, iz]);
      this.mb.quad(M, front[1], front[0], front[3], front[2], U_WHITE, STEEL, [-ix, 0, -iz]);
    }
  }

  /** A guard rail's post and the beam to the next: the top of it stands out of the snow the plough has thrown over. */
  private rail(f: Frame, it: Item): void {
    const top = (x: number, z: number, road: number) => Math.max(road + 0.8, snowTop(this.world, x, z) + 0.24);
    const y1 = top(f.x, f.z, f.road);
    this.tube([f.x, f.snow - 0.3, f.z], [f.x, y1, f.z], 0.07, 0.07, 4, PAINT);
    const n = it.next;
    if (!n) return;
    const q = this.world.main.line.at(n.s);
    const y2 = top(n.x, n.z, q.y - 0.02 * this.world.main.half);
    // The beam sits on the road's side of the posts.
    const ix = -f.rx * f.side;
    const iz = -f.rz * f.side;
    const o = 0.09;
    const a: V3 = [f.x + ix * o, y1 - 0.37, f.z + iz * o];
    const b: V3 = [n.x + ix * o, y2 - 0.37, n.z + iz * o];
    const a1: V3 = [a[0], y1 - 0.02, a[2]];
    const b1: V3 = [b[0], y2 - 0.02, b[2]];
    const uv = atlas("rail").uv;
    // Seen from the road, left to right runs forward along the left side and back along the right.
    if (f.side < 0) {
      this.mb.quad(M, a, b, b1, a1, uv, PAINT, [ix, 0, iz]);
      this.mb.quad(M, b, a, a1, b1, uv, STEEL, [-ix, 0, -iz]);
    } else {
      this.mb.quad(M, b, a, a1, b1, uv, PAINT, [ix, 0, iz]);
      this.mb.quad(M, a, b, b1, a1, uv, STEEL, [-ix, 0, -iz]);
    }
  }

  /** A concrete distribution pole: crossarm with three conductors, a low-voltage wire and a telephone cable below, a transformer on some. */
  private pole(f: Frame, it: Item): void {
    const ground = f.snow - 0.3;
    const top = f.snow + POLE.h;
    this.tube([f.x, ground, f.z], [f.x, top, f.z], 0.17, 0.095, 6, CONCRETE);
    this.bar(f.x, top - 0.55, f.z, f.rx, f.rz, 0.95, 0.04, 0.08, DARK, true);
    this.bar(f.x, top - 3.05, f.z, f.rx, f.rz, 0.45, 0.035, 0.07, DARK, true);
    if (it.extra) {
      // A pole transformer: a grey can on a bracket, on the side away from the road.
      const ox = f.rx * f.side * 0.42;
      const oz = f.rz * f.side * 0.42;
      const y0 = top - 2.6;
      this.tube([f.x + ox, y0, f.z + oz], [f.x + ox, y0 + 0.85, f.z + oz], 0.27, 0.27, 7, STEEL);
      this.cap([f.x + ox, y0, f.z + oz], 0.27, 7, -1, STEEL);
      this.cap([f.x + ox, y0 + 0.85, f.z + oz], 0.27, 7, 1, STEEL);
    }
    const n = it.next;
    if (!n) return;
    const q = this.world.main.line.at(n.s);
    const nrx = -q.tz;
    const nrz = q.tx;
    const nTop = snowTop(this.world, n.x, n.z) + POLE.h;
    const span = Math.hypot(n.x - f.x, n.z - f.z);
    const sag = 0.75 * (span / POLE.every) ** 2;
    for (const [lat, down, r, k] of POLE_WIRES) this.wire([f.x + f.rx * lat, top - down, f.z + f.rz * lat], [n.x + nrx * lat, nTop - down, n.z + nrz * lat], sag * k, r, 4);
  }

  /** A side street's pole: shorter, a narrow crossarm, three wires to the next. */
  sidePole(a: { x: number; z: number; rx: number; rz: number }, b: { x: number; z: number; rx: number; rz: number } | null, transformer: boolean): void {
    const snow = snowTop(this.world, a.x, a.z);
    const top = snow + SIDE_POLE.h;
    this.tube([a.x, snow - 0.3, a.z], [a.x, top, a.z], 0.15, 0.09, 6, CONCRETE);
    this.bar(a.x, top - 0.45, a.z, a.rx, a.rz, 0.6, 0.035, 0.07, DARK, true);
    if (transformer) {
      const y0 = top - 2.3;
      const x = a.x + a.rx * 0.38;
      const z = a.z + a.rz * 0.38;
      this.tube([x, y0, z], [x, y0 + 0.75, z], 0.24, 0.24, 6, STEEL);
      this.cap([x, y0, z], 0.24, 6, -1, STEEL);
      this.cap([x, y0 + 0.75, z], 0.24, 6, 1, STEEL);
    }
    if (!b) return;
    const bTop = snowTop(this.world, b.x, b.z) + SIDE_POLE.h;
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const sag = 0.7 * (span / SIDE_POLE.every) ** 2;
    for (const [lat, down, r, k] of SIDE_WIRES) this.wire([a.x + a.rx * lat, top - down, a.z + a.rz * lat], [b.x + b.rx * lat, bTop - down, b.z + b.rz * lat], sag * k, r, 3);
  }

  private cap(o: V3, r: number, sides: number, up: number, color: RGBA): void {
    const mb = this.mb;
    const base = mb.count(M);
    for (let k = 0; k < sides; k++) {
      const t = (k / sides) * Math.PI * 2;
      mb.vertex(M, [o[0] + Math.cos(t) * r, o[1], o[2] + Math.sin(t) * r], [0, up, 0], U_WHITE[0], U_WHITE[1], color);
    }
    for (let k = 1; k + 1 < sides; k++) {
      if (up > 0) mb.tri(M, base, base + k + 1, base + k);
      else mb.tri(M, base, base + k, base + k + 1);
    }
  }

  private signPost(f: Frame, top: number, r = 0.038): void {
    this.tube([f.x, f.snow - 0.3, f.z], [f.x, top, f.z], r, r, 4, STEEL);
  }

  /** A sign with its own outline (shield, disc) on one post, its centre `h` above the road. */
  private faceOnPost(f: Frame, it: Item, outline: Outline, w: number, h: number, height: number): void {
    const y = f.road + height;
    this.signPost(f, y + h / 2 + 0.05);
    const nx = -f.fx * it.dir;
    const nz = -f.fz * it.dir;
    this.plate([f.x + nx * 0.05, y, f.z + nz * 0.05], nx, nz, w, h, it.face!, outline);
  }

  /** A rectangular board on one post or two. */
  private panel(f: Frame, it: Item, w: number, h: number, height: number, posts: number): void {
    const y = f.road + height;
    const nx = -f.fx * it.dir;
    const nz = -f.fz * it.dir;
    if (posts === 1) this.signPost(f, y + h / 2 + 0.05);
    else
      for (const o of [-0.32, 0.32]) {
        const x = f.x + f.rx * o * w;
        const z = f.z + f.rz * o * w;
        this.tube([x, snowTop(this.world, x, z) - 0.3, z], [x, y + h / 2 + 0.05, z], 0.038, 0.038, 4, STEEL);
      }
    this.plate([f.x + nx * 0.05, y, f.z + nz * 0.05], nx, nz, w, h, it.face!);
  }

  /** A boundary sign on two posts: a picture panel over the town's name. */
  private boundary(f: Frame, it: Item): void {
    const { w, name } = SIZE.bound;
    const y0 = f.road + 2.3;
    const nx = -f.fx * it.dir;
    const nz = -f.fz * it.dir;
    for (const o of [-0.36, 0.36]) {
      const x = f.x + f.rx * o * w;
      const z = f.z + f.rz * o * w;
      this.tube([x, snowTop(this.world, x, z) - 0.3, z], [x, y0 + name + w + 0.05, z], 0.04, 0.04, 4, STEEL);
    }
    const o: V3 = [f.x + nx * 0.055, y0, f.z + nz * 0.055];
    this.patch(M, o, nx, nz, -w / 2, 0, w / 2, name, atlas(it.face!).uv);
    this.patch(M, o, nx, nz, -w / 2, name, w / 2, name + w, atlas("country").uv);
    this.patch(M, [o[0] - nx * 0.02, o[1], o[2] - nz * 0.02], -nx, -nz, -w / 2, 0, w / 2, name + w, U_WHITE, SIGN_BACK);
  }

  /** 止まれ on a side road: (nx, nz) points along the side road away from the driven one, toward the driver it stops. */
  private stop(f: Frame, it: Item): void {
    const nx = it.nx!;
    const nz = it.nz!;
    const y = f.snow + 2.3;
    this.signPost(f, y + SIZE.stop.h / 2 + 0.05);
    this.plate([f.x + nx * 0.05, y, f.z + nz * 0.05], nx, nz, SIZE.stop.w, SIZE.stop.h, "stop", STOP_OUTLINE);
  }

  /**
   * A distance board on an F-shaped mast: the board hangs over the left
   * lane, 5 m clear of the road. It is tiled from the atlas without
   * overlaps (frame, rows of name, digits and "km"), so nothing lies
   * coplanar on anything.
   */
  private board(f: Frame, it: Item): void {
    const rows = it.rows!;
    const half = this.world.main.half;
    const B = SIZE.board;
    const R = SIZE.row;
    const H = rows.length * R.h + 2 * (B.frame + B.pad);
    const y0 = f.road + 5.0;
    const nx = -f.fx * it.dir;
    const nz = -f.fz * it.dir;
    // Inward from the mast: toward the centre line.
    const ix = -f.rx * f.side;
    const iz = -f.rz * f.side;
    const reach = Math.abs(it.d) - (half - 0.2) + B.w;
    const mastTop = y0 + H + 0.25;
    this.tube([f.x, f.snow - 0.4, f.z], [f.x, mastTop, f.z], 0.15, 0.12, 6, STEEL);
    for (const y of [y0 + 0.22, y0 + H - 0.22]) this.tube([f.x - nx * 0.1, y, f.z - nz * 0.1], [f.x + ix * reach - nx * 0.1, y, f.z + iz * reach - nz * 0.1], 0.07, 0.07, 4, STEEL);
    const centre = reach - B.w / 2;
    const o: V3 = [f.x + ix * centre, y0, f.z + iz * centre];
    const blue = atlas("blue").uv;
    const q = (x0: number, yy0: number, x1: number, yy1: number, uv: UV, color: RGBA = WHITE) => this.patch(M, o, nx, nz, x0, yy0, x1, yy1, uv, color);
    const w2 = B.w / 2;
    // Frame.
    q(-w2, 0, w2, B.frame, U_WHITE, PAINT);
    q(-w2, H - B.frame, w2, H, U_WHITE, PAINT);
    q(-w2, B.frame, -w2 + B.frame, H - B.frame, U_WHITE, PAINT);
    q(w2 - B.frame, B.frame, w2, H - B.frame, U_WHITE, PAINT);
    // Padding above and below the rows.
    const xi0 = -w2 + B.frame;
    const xi1 = w2 - B.frame;
    q(xi0, B.frame, xi1, B.frame + B.pad, blue);
    q(xi0, H - B.frame - B.pad, xi1, H - B.frame, blue);
    rows.forEach(([town, km], r) => {
      const ya = H - B.frame - B.pad - (r + 1) * R.h;
      const yb = ya + R.h;
      let x = xi0;
      const cellAt = (w: number, uv: UV) => {
        q(x, ya, x + w, yb, uv);
        x += w;
      };
      const fixed = 0.1 + R.name + 2 * R.digit + R.km + 0.08;
      cellAt(0.1, blue);
      cellAt(R.name, atlas(`name-${town}`).uv);
      cellAt(xi1 - xi0 - fixed, blue);
      const n = Math.min(99, km);
      cellAt(R.digit, n >= 10 ? atlas(`digit-${Math.floor(n / 10)}`).uv : blue);
      cellAt(R.digit, atlas(`digit-${n % 10}`).uv);
      cellAt(R.km, atlas("km").uv);
      cellAt(0.08, blue);
    });
    this.patch(M, [o[0] - nx * 0.03, o[1], o[2] - nz * 0.03], -nx, -nz, -w2, 0, w2, H, U_WHITE, SIGN_BACK);
  }

  /** A signal: a mast, an arm over the lane, a vertical head (red above amber above green, as the snow country hangs them) showing green. */
  private signal(f: Frame, it: Item): void {
    const y = f.road;
    const armY = y + 6.9;
    this.tube([f.x, f.snow - 0.4, f.z], [f.x, y + 7.3, f.z], 0.12, 0.095, 6, STEEL);
    const ix = -f.rx * f.side;
    const iz = -f.rz * f.side;
    const reach = Math.abs(it.d) - 1.7;
    const hx = f.x + ix * reach;
    const hz = f.z + iz * reach;
    this.tube([f.x, armY - 0.15, f.z], [hx + ix * 0.3, armY, hz + iz * 0.3], 0.065, 0.05, 4, STEEL);
    const nx = -f.fx * it.dir;
    const nz = -f.fz * it.dir;
    const { w, h } = SIZE.signal;
    const top = armY - 0.08;
    const depth = 0.07;
    // The body, then the face in front of it: two dark lamps (lit material) and the green one (unlit).
    this.bar(hx, top - h, hz, f.rx, f.rz, w / 2, depth, h, HOUSING, true);
    const o: V3 = [hx + nx * (depth + 0.006), top - h, hz + nz * (depth + 0.006)];
    this.patch(M, o, nx, nz, -w / 2, h / 3, w / 2, h, atlas("sigTop").uv);
    this.patch(LIT, o, nx, nz, -w / 2, 0, w / 2, h / 3, atlas("sigGo").uv);
    if (it.name !== undefined) {
      // The junction's name, hung from the arm beside the head.
      const N = SIZE.signalName;
      const c = reach - w / 2 - 0.25 - N.w / 2;
      const p: V3 = [f.x + ix * c + nx * 0.07, armY - 0.1 - N.h, f.z + iz * c + nz * 0.07];
      this.patch(M, p, nx, nz, -N.w / 2, 0, N.w / 2, N.h, atlas(`signame-${it.name}`).uv);
      this.patch(M, [p[0] - nx * 0.02, p[1], p[2] - nz * 0.02], -nx, -nz, -N.w / 2, 0, N.w / 2, N.h, U_WHITE, SIGN_BACK);
    }
  }

  /** A street lamp: a tapered steel mast, an arm toward the road, a head whose lens glows. */
  private lamp(f: Frame): void {
    const y = f.road;
    const ix = -f.rx * f.side;
    const iz = -f.rz * f.side;
    this.tube([f.x, f.snow - 0.4, f.z], [f.x, y + LAMP.h, f.z], 0.1, 0.065, 6, STEEL);
    const ex = f.x + ix * LAMP.arm;
    const ez = f.z + iz * LAMP.arm;
    const ey = y + LAMP.h + 0.45;
    this.tube([f.x, y + LAMP.h - 0.05, f.z], [ex, ey, ez], 0.05, 0.04, 4, STEEL);
    // The head lies along the arm; its lens hangs under it.
    const cx = ex + ix * 0.25;
    const cz = ez + iz * 0.25;
    this.bar(cx, ey - 0.07, cz, ix, iz, 0.36, 0.14, 0.12, HOUSING);
    const lamp = atlas("lamp").uv;
    const px = -iz;
    const pz = ix;
    const c = (l: number, w: number, yy: number): V3 => [cx + ix * l * 0.3 + px * w * 0.11, yy, cz + iz * l * 0.3 + pz * w * 0.11];
    const ya = ey - 0.07;
    const yb = ey - 0.15;
    const top = [c(-1, -1, ya), c(1, -1, ya), c(1, 1, ya), c(-1, 1, ya)];
    const low = [c(-0.8, -0.7, yb), c(0.8, -0.7, yb), c(0.8, 0.7, yb), c(-0.8, 0.7, yb)];
    this.mb.quad(LIT, low[0], low[1], low[2], low[3], lamp, WHITE, [0, -1, 0]);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      this.mb.quad(LIT, top[k], top[j], low[j], low[k], lamp);
    }
  }

  /** A bus stop: a pole with a disc and a timetable plate, read from both directions. */
  private bus(f: Frame, it: Item): void {
    const top = Math.max(f.road + 2.7, f.snow + 2.2);
    this.tube([f.x, f.snow - 0.3, f.z], [f.x, top, f.z], 0.035, 0.035, 4, PAINT);
    const d = SIZE.busDisc;
    for (const dir of [it.dir, -it.dir]) {
      const nx = -f.fx * dir;
      const nz = -f.fz * dir;
      this.face(M, [f.x + nx * 0.045, top - d / 2, f.z + nz * 0.045], nx, nz, d, d, atlas("busDisc").uv, WHITE, DISC_OUTLINE);
      this.face(M, [f.x + nx * 0.045, top - d - 0.06 - SIZE.busPlate.h / 2, f.z + nz * 0.045], nx, nz, SIZE.busPlate.w, SIZE.busPlate.h, atlas("busPlate").uv);
    }
  }
}

/** Where an item stands and how the driven road runs past it. */
interface Frame {
  x: number;
  z: number;
  /** Forward and right of the driven road. */
  fx: number;
  fz: number;
  rx: number;
  rz: number;
  /** Height of the road surface beside it, and of the snow at its foot. */
  road: number;
  snow: number;
  /** −1 left of the road, 1 right. */
  side: number;
}

const RECT: Outline = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

/** The arrow: the shaft's top left, down its left side, the head's left corner, the point, and back up the right. */
const ARROW_OUTLINE: Outline = [
  [-ARROW_SHAFT / 2, 0.5],
  [-ARROW_SHAFT / 2, -0.5 + ARROW_HEAD],
  [-0.5, -0.5 + ARROW_HEAD],
  [0, -0.5],
  [0.5, -0.5 + ARROW_HEAD],
  [ARROW_SHAFT / 2, -0.5 + ARROW_HEAD],
  [ARROW_SHAFT / 2, 0.5],
];
const ARROW_TRIS = [0, 1, 5, 0, 5, 6, 2, 3, 4];

/** A wire's section: three corners around its axis (across, up). */
const WIRE_SECTION: readonly [number, number][] = [
  [0, 1],
  [-0.87, -0.5],
  [0.87, -0.5],
];

/**
 * The driven road's wires: offset along the crossarm, drop below the pole's
 * top, radius, share of the sag. About 3 cm across: thinner than that they
 * break up within sight, thicker they read as pipes near the camera.
 */
const POLE_WIRES: readonly [number, number, number, number][] = [
  [-0.82, 0.42, 0.0175, 1],
  [0.3, 0.42, 0.0175, 1],
  [0.82, 0.42, 0.0175, 1],
  [-0.38, 2.95, 0.0175, 1.15],
  // The telephone cable: thicker, lower, slacker.
  [0.12, 5.2, 0.026, 1.4],
];
const SIDE_WIRES: readonly [number, number, number, number][] = [
  [-0.5, 0.34, 0.0175, 1],
  [0.5, 0.34, 0.0175, 1],
  [0.1, 3.6, 0.024, 1.35],
];
