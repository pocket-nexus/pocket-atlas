import type { CellContext } from "../cell";
import { BOARD, cell as atlasCell, MAIN_STATIONS, PYLON, STATIONS } from "../kit/structures-layout";
import type { LinePoint, Projection } from "../line";
import { faceNormal, type MeshBuilder, type V3 } from "../mesh";
import { clamp, fbm2, hash2, lerp, noise2, smoothstep } from "../noise";
import type { Feature } from "../source";
import type { Probe, RouteWorld } from "../world";
import { beyondOf, SKIRT, stations as roadStations } from "./strip";

/**
 * What stands in and over the ground along the route:
 *
 *   bridges   the driven road's decks (slab, girders, parapets, ploughed
 *             snow at the kerb, abutments, piers) over the space cut under
 *             them
 *   rivers    `river` waterways as channels: open dark water between ice
 *             shelves and snow banks, with the terrain sunk under them
 *   railway   the JR Furano Line: bed, rails, girder bridges, level
 *             crossings, platforms and name boards
 *   power     lattice towers and their conductors
 *
 * The 10 m elevation grid resolves neither a river's channel nor the space
 * under a bridge, so both are cut: `groundCut` is how far the terrain mesh
 * sinks at a point (`gen/terrain.ts` subtracts it), and the channel's own
 * banks and the bridges' abutments are drawn here over the sunk grid.
 *
 * Layers: structure, water, track bed and towers in `base`; rails, railing
 * posts, crossing equipment and name boards in `detail`.
 */

type RGBA = readonly [number, number, number, number];

const STRUCT = "structure";
const CUT = "structure-cut";
const SNOW = "snow";
const WATER = "water";

const rectPoint = (r: readonly [number, number, number, number]): [number, number, number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
const PLAIN = rectPoint(atlasCell("plain").uv);
const CONC = atlasCell("concrete").uv;
const PLATE = atlasCell("plate").uv;

// Colours (sRGB). Concrete and plate are tints of their atlas cells; the rest colour the plain cell.
const C_CONC: RGBA = [246, 245, 242, 255];
const C_CONC_DARK: RGBA = [176, 176, 178, 255];
const C_SOFFIT: RGBA = [150, 150, 154, 255];
const C_OPENING: RGBA = [44, 46, 50, 255];
const C_SNOW: RGBA = [255, 255, 255, 255];
const C_SHELF: RGBA = [240, 245, 252, 255];
const C_ICE: RGBA = [176, 194, 210, 255];
const C_RAIL_TOP: RGBA = [104, 106, 112, 255];
const C_RAIL_SIDE: RGBA = [62, 52, 46, 255];
const C_BED: RGBA = [204, 207, 212, 255];
const C_WIRE: RGBA = [58, 60, 64, 255];
const C_YELLOW: RGBA = [226, 184, 34, 255];
const C_BLACK: RGBA = [30, 30, 32, 255];
const C_LAMP: RGBA = [122, 24, 22, 255];
const C_GREY: RGBA = [150, 154, 158, 255];
const C_SHELTER: RGBA = [182, 176, 162, 255];
const C_DOOR: RGBA = [70, 74, 80, 255];
const C_WHITE: RGBA = [255, 255, 255, 255];

/** Paints of the steel on Hokkaido's road bridges: pale green, red-brown, grey-blue, ivory (estimated; no survey of each bridge). */
const PAINTS: RGBA[] = [
  [150, 178, 160, 255],
  [136, 92, 70, 255],
  [140, 160, 178, 255],
  [202, 196, 172, 255],
];

/** The deepest the terrain may sink: the next layer's terrain lies 5 m under this one. */
const CUT_MAX = 4.6;
/** How far a river's water may lie under the surveyed ground. */
const WATER_MAX = 3.6;
/** Width of a channel's snow bank from the foot to the crest (m). */
const BANK = 5;

const newProbe = (): Probe => ({ e: 0, road: null, s: 0, d: 0, w: 0, y: 0, zone: 0, zoneRoad: null, zoneS: 0, zoneD: 0 });

// ───────────────────────────────────────────────────────────── geometry

/** A quad a→b→c→d with its own UVs and colours, wound to face `out`. */
function quad4(mb: MeshBuilder, material: string, p: readonly [V3, V3, V3, V3], uv: readonly number[], color: RGBA | readonly [RGBA, RGBA, RGBA, RGBA], out?: V3, normal?: V3): void {
  let n = faceNormal(p[0], p[1], p[2]);
  if (n[0] === 0 && n[1] === 0 && n[2] === 0) n = faceNormal(p[0], p[2], p[3]);
  let flip = false;
  if (out && n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) {
    n = [-n[0], -n[1], -n[2]];
    flip = true;
  }
  const nn = normal ?? n;
  const col = (typeof color[0] === "number" ? [color, color, color, color] : color) as readonly [RGBA, RGBA, RGBA, RGBA];
  const i = mb.vertex(material, p[0], nn, uv[0], uv[1], col[0]);
  mb.vertex(material, p[1], nn, uv[2], uv[3], col[1]);
  mb.vertex(material, p[2], nn, uv[4], uv[5], col[2]);
  mb.vertex(material, p[3], nn, uv[6], uv[7], col[3]);
  if (flip) {
    mb.tri(material, i, i + 2, i + 1);
    mb.tri(material, i, i + 3, i + 2);
  } else {
    mb.tri(material, i, i + 1, i + 2);
    mb.tri(material, i, i + 2, i + 3);
  }
}

/** The UVs of a quad a, b, c, d over a rectangle: a and d at u0, a and b at v0. */
const uvs = (r: readonly [number, number, number, number]): number[] => [r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3]];
const UV_PLAIN = uvs(PLAIN);

/**
 * A straight member from `a` to `b`: `w` wide across, `h` deep, its top
 * face at the points. `faces` picks top, sides and bottom.
 */
function beam(mb: MeshBuilder, material: string, a: V3, b: V3, w: number, h: number, color: RGBA, side: RGBA = color, bottom = true): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const t: V3 = [dx / len, dy / len, dz / len];
  // Across: horizontal and perpendicular; for an upright member, x.
  let p: V3 = Math.abs(t[1]) > 0.95 ? [1, 0, 0] : [-t[2], 0, t[0]];
  const pl = Math.hypot(p[0], p[1], p[2]);
  p = [p[0] / pl, p[1] / pl, p[2] / pl];
  // Down: perpendicular to both.
  const q: V3 = [t[1] * p[2] - t[2] * p[1], t[2] * p[0] - t[0] * p[2], t[0] * p[1] - t[1] * p[0]];
  const s = q[1] > 0 ? -1 : 1;
  const d: V3 = [q[0] * s * h, q[1] * s * h, q[2] * s * h];
  const hw = w / 2;
  const c = (o: V3, sx: number, down: number): V3 => [o[0] + p[0] * hw * sx + d[0] * down, o[1] + p[1] * hw * sx + d[1] * down, o[2] + p[2] * hw * sx + d[2] * down];
  const up: V3 = [-d[0], -d[1], -d[2]];
  quad4(mb, material, [c(a, -1, 0), c(a, 1, 0), c(b, 1, 0), c(b, -1, 0)], UV_PLAIN, color, up);
  quad4(mb, material, [c(a, 1, 0), c(a, 1, 1), c(b, 1, 1), c(b, 1, 0)], UV_PLAIN, side, p);
  quad4(mb, material, [c(a, -1, 0), c(a, -1, 1), c(b, -1, 1), c(b, -1, 0)], UV_PLAIN, side, [-p[0], -p[1], -p[2]]);
  if (bottom) quad4(mb, material, [c(a, -1, 1), c(a, 1, 1), c(b, 1, 1), c(b, -1, 1)], UV_PLAIN, side, d);
}

/** A wire or thin rail as a ridge: two faces meeting at the top, open below. */
function ridge(mb: MeshBuilder, material: string, a: V3, b: V3, w: number, color: RGBA): void {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const l = Math.hypot(dx, dz) || 1;
  const px = (-dz / l) * w * 0.5;
  const pz = (dx / l) * w * 0.5;
  const h = w * 0.8;
  quad4(mb, material, [a, [a[0] + px, a[1] - h, a[2] + pz], [b[0] + px, b[1] - h, b[2] + pz], b], UV_PLAIN, color, [px, w * 0.3, pz]);
  quad4(mb, material, [a, [a[0] - px, a[1] - h, a[2] - pz], [b[0] - px, b[1] - h, b[2] - pz], b], UV_PLAIN, color, [-px, w * 0.3, -pz]);
}

/**
 * An upright rectangle seen from the side its normal `n` points to: centre,
 * width, height, turned by `roll` in its own plane. u runs to the viewer's
 * right. `both` adds the back with the same face.
 */
function panel(mb: MeshBuilder, material: string, c: V3, n: V3, w: number, h: number, uv: readonly [number, number, number, number], color: RGBA, roll = 0, both = false): void {
  // The viewer looks along −n; their right is (n.z, 0, −n.x).
  const ex = n[2];
  const ez = -n[0];
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const e: V3 = [ex * cr, sr, ez * cr];
  const u: V3 = [-ex * sr, cr, -ez * sr];
  const at = (a: number, b: number): V3 => [c[0] + e[0] * a * w * 0.5 + u[0] * b * h * 0.5, c[1] + e[1] * a * w * 0.5 + u[1] * b * h * 0.5, c[2] + e[2] * a * w * 0.5 + u[2] * b * h * 0.5];
  quad4(mb, material, [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)], uvs(uv), color, n);
  if (both) quad4(mb, material, [at(1, -1), at(-1, -1), at(-1, 1), at(1, 1)], uvs(uv), color, [-n[0], -n[1], -n[2]]);
}

/** An upright pole in bands of alternating colours. */
function stripedPole(mb: MeshBuilder, a: V3, b: V3, r: number, sides: number, band: number, c0: RGBA, c1: RGBA): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(1, Math.round(len / band));
  for (let i = 0; i < n; i++) {
    const p = (t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    mb.tube(STRUCT, p(i / n), p((i + 1) / n), r, r, sides, PLAIN, i & 1 ? c1 : c0);
  }
}

function inRing(pts: Float64Array, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const zi = pts[i + 1];
    const zj = pts[j + 1];
    if (zi > z !== zj > z && x < ((pts[j] - pts[i]) * (z - zi)) / (zj - zi) + pts[i]) inside = !inside;
  }
  return inside;
}

function inPolygon(f: Feature, x: number, z: number): boolean {
  if (x < f.box[0] || x > f.box[2] || z < f.box[1] || z > f.box[3] || !inRing(f.pts, x, z)) return false;
  for (const h of f.holes) if (inRing(h, x, z)) return false;
  return true;
}

/** Whether segments a–b and c–d cross. */
function crosses(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => Math.sign((qx - px) * (rz - pz) - (qz - pz) * (rx - px));
  return o(ax, az, bx, bz, cx, cz) !== o(ax, az, bx, bz, dx, dz) && o(cx, cz, dx, dz, ax, az) !== o(cx, cz, dx, dz, bx, bz);
}

/** Smooths a series in place, keeping both ends (so two ways that meet agree there). */
function smoothPinned(a: Float64Array, passes: number): void {
  const b = new Float64Array(a.length);
  for (let p = 0; p < passes; p++) {
    b.set(a);
    for (let i = 1; i + 1 < a.length; i++) a[i] = (b[i - 1] + 2 * b[i] + b[i + 1]) / 4;
  }
}

/** A polyline resampled at about `step` metres, with unit tangents. */
interface Path {
  n: number;
  x: Float64Array;
  z: Float64Array;
  tx: Float64Array;
  tz: Float64Array;
  /** Arc length at each point. */
  s: Float64Array;
}

function resample(pts: Float64Array, step: number, smooth: number): Path {
  const m = pts.length / 2;
  const acc = new Float64Array(m);
  for (let i = 1; i < m; i++) acc[i] = acc[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  const len = acc[m - 1];
  const n = Math.max(2, Math.round(len / step) + 1);
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = (len * i) / (n - 1);
    while (j + 2 < m && acc[j + 1] < d) j++;
    const t = clamp((d - acc[j]) / (acc[j + 1] - acc[j] || 1), 0, 1);
    x[i] = lerp(pts[j * 2], pts[j * 2 + 2], t);
    z[i] = lerp(pts[j * 2 + 1], pts[j * 2 + 3], t);
  }
  if (smooth) {
    smoothPinned(x, smooth);
    smoothPinned(z, smooth);
  }
  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const l = Math.hypot(x[b] - x[a], z[b] - z[a]) || 1;
    tx[i] = (x[b] - x[a]) / l;
    tz[i] = (z[b] - z[a]) / l;
    if (i) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  }
  return { n, x, z, tx, tz, s };
}

// ───────────────────────────────────────────────────────────── the model

/** A bridge of the driven road: from the last station with banks to the first one after. */
interface Bridge {
  index: number;
  sA: number;
  sB: number;
  /** Deck stations from sA to sB. */
  st: Float64Array;
  /** Depth of the slab and of the girders under it (0: a slab bridge). */
  slab: number;
  girder: number;
  /** Clear height cut under the road surface. */
  H: number;
  /** How far the cut reaches beyond the deck's side before it fades, and the fade's length. */
  fade: number;
  /** Arc lengths of the piers. */
  piers: number[];
  paint: RGBA;
  /** A concrete wall with a top rail instead of a post-and-rail parapet. */
  wall: boolean;
  box: [number, number, number, number];
}

/** A river (or a stream under a bridge) as a channel along a path. */
interface Reach extends Path {
  /** Half widths of the channel floor to the left and right. */
  hl: Float64Array;
  hr: Float64Array;
  /** Water level. */
  wl: Float64Array;
  /** Open water, or a snowed-over stream. */
  open: boolean;
  /** Ends that no other reach continues: 0 none, 1 a snow slope, 2 a culvert's headwall. */
  capA: number;
  capB: number;
  seed: number;
  /** Cross-sections (17 columns of x, y, z per station), built on first use. */
  sec: Float64Array | null;
}

/** A railway track along a path. */
interface Track extends Path {
  /** Top of the snow on the bed. */
  y: Float64Array;
  /** 1 where the track lies in a ploughed road (a level crossing). */
  on: Uint8Array;
  bridge: boolean;
  yard: boolean;
}

interface PowerNode {
  x: number;
  z: number;
  /** Tower height. */
  h: number;
  /** The line's direction through the tower. */
  dx: number;
  dz: number;
}

const COLS = 17;
const MID = 8;

class Model {
  readonly bridges: Bridge[] = [];
  private reaches = new Map<Feature, Reach | null>();
  private tracks = new Map<Feature, Track>();
  private cutCells = new Map<number, number[]>();
  private cutReaches: Reach[] = [];
  private cutIndex = new Map<Reach, number>();
  private nodes: Map<string, Feature[]> | null = null;
  private power: Map<string, PowerNode> | null = null;
  /** Waterways other than rivers that pass under a bridge of the driven road. */
  private under = new Set<Feature>();
  private probe = newProbe();
  private proj: Projection = { s: 0, d: 0, i: 0 };
  private pt: LinePoint = { x: 0, y: 0, z: 0, tx: 0, tz: -1, grade: 0 };

  constructor(readonly world: RouteWorld) {
    this.findBridges();
  }

  // ── bridges

  private findBridges(): void {
    const world = this.world;
    const road = world.main;
    const line = road.line;
    const st = roadStations(world, road);
    const flag = (k: number) => road.bridge[line.segment(st[k])];
    for (let k = 0; k < st.length; k++) {
      if (!flag(k)) continue;
      let j = k;
      while (j + 1 < st.length && flag(j + 1)) j++;
      const sA = st[Math.max(0, k - 1)];
      const sB = st[Math.min(st.length - 1, j + 1)];
      k = j;
      const L = sB - sA;
      const n = Math.max(1, Math.round(L / 5));
      const dst = Float64Array.from({ length: n + 1 }, (_, i) => sA + (L * i) / n);
      const index = this.bridges.length;
      const spans = L > 45 ? Math.round(L / 30) : 1;
      const span = L / spans;
      const girder = span < 16 ? 0 : clamp(span / 18, 0.9, 1.5);
      // What crosses under it.
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      const deck: number[] = [];
      for (const s of dst) {
        line.at(s, this.pt);
        deck.push(this.pt.x, this.pt.z);
        x0 = Math.min(x0, this.pt.x);
        x1 = Math.max(x1, this.pt.x);
        z0 = Math.min(z0, this.pt.z);
        z1 = Math.max(z1, this.pt.z);
      }
      const under = (f: Feature): boolean => {
        for (let i = 0; i + 2 < f.pts.length; i += 2) for (let d = 0; d + 2 < deck.length; d += 2) if (crosses(f.pts[i], f.pts[i + 1], f.pts[i + 2], f.pts[i + 3], deck[d], deck[d + 1], deck[d + 2], deck[d + 3])) return true;
        return false;
      };
      const rail = world.source.query("rail", x0, z0, x1, z1).some(under);
      for (const f of world.source.query("waterway", x0, z0, x1, z1)) if (f.type !== "river" && !f.tags.tunnel && under(f)) this.under.add(f);
      const fade = rail ? 60 : 28;
      const pad = road.half + 8 + fade + 2;
      this.bridges.push({
        index,
        sA,
        sB,
        st: dst,
        slab: girder ? 0.8 : 0.65,
        girder,
        // A railway under the road wants more than the cut can give: it gets all of it.
        H: rail ? 4.2 : L < 16 ? 1.9 : 2.6,
        fade,
        piers: Array.from({ length: spans - 1 }, (_, i) => sA + span * (i + 1)),
        paint: PAINTS[Math.floor(hash2(index, 77) * PAINTS.length) % PAINTS.length],
        wall: L < 22 || hash2(index, 31) > 0.6,
        box: [x0 - pad, z0 - pad, x1 + pad, z1 + pad],
      });
    }
  }

  /** How far the space under a bridge is cut below the graded terrain `base` at a point. */
  pit(x: number, z: number, base: number): number {
    let out = 0;
    for (const b of this.bridges) {
      if (x < b.box[0] || x > b.box[2] || z < b.box[1] || z > b.box[3]) continue;
      const main = this.world.main;
      const p = main.line.project(x, z, main.half + 8 + b.fade, this.proj);
      if (!p || p.s <= b.sA + 0.5 || p.s >= b.sB - 0.5) continue;
      const ms = smoothstep(b.sA + 0.5, b.sA + 2.5, p.s) * (1 - smoothstep(b.sB - 2.5, b.sB - 0.5, p.s));
      const md = 1 - smoothstep(main.half + 8, main.half + 8 + b.fade, Math.abs(p.d));
      const target = main.line.at(p.s, this.pt).y - b.H;
      out = Math.max(out, Math.min(CUT_MAX - 0.6, Math.max(0, base - target)) * ms * md);
    }
    return out;
  }

  /** The ground structures stand on: the graded terrain less the cut under bridges. */
  ground(x: number, z: number): number {
    const b = this.world.base(x, z, this.world.probe(x, z, this.probe));
    return b - this.pit(x, z, b);
  }

  // ── rivers

  private isReach(f: Feature): boolean {
    return f.kind === "waterway" && !f.tags.tunnel && f.pts.length >= 4 && (f.type === "river" || this.under.has(f));
  }

  private nodeKey(x: number, z: number): string {
    return `${Math.round(x * 10)},${Math.round(z * 10)}`;
  }

  /** Waterways by their end points: consecutive ways of one river share a node. */
  private ends(x: number, z: number): Feature[] {
    if (!this.nodes) {
      this.nodes = new Map();
      for (const f of this.world.source.features) {
        if (f.kind !== "waterway" || f.pts.length < 4) continue;
        for (const o of [0, f.pts.length - 2]) {
          const k = this.nodeKey(f.pts[o], f.pts[o + 1]);
          const list = this.nodes.get(k);
          if (list) list.push(f);
          else this.nodes.set(k, [f]);
        }
      }
    }
    return this.nodes.get(this.nodeKey(x, z)) ?? [];
  }

  /**
   * The direction of a way at one of its ends, turned halfway toward the way
   * that continues it there (both then agree on the cross-section they
   * share), and what continues it: 0 a reach, 1 nothing, 2 a culvert.
   */
  private endTangent(f: Feature, atEnd: boolean): { tx: number; tz: number; cap: number } {
    const p = f.pts;
    const n = p.length;
    const o = atEnd ? n - 2 : 0;
    let dx = atEnd ? p[n - 2] - p[n - 4] : p[2] - p[0];
    let dz = atEnd ? p[n - 1] - p[n - 3] : p[3] - p[1];
    let l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const sgn = atEnd ? 1 : -1;
    let best = 0.3;
    let bx = 0;
    let bz = 0;
    let cap = 1;
    for (const g of this.ends(p[o], p[o + 1])) {
      if (g === f) continue;
      const q = g.pts;
      const m = q.length;
      // The other way's direction leaving the node.
      const starts = this.nodeKey(q[0], q[1]) === this.nodeKey(p[o], p[o + 1]);
      let ax = starts ? q[2] - q[0] : q[m - 4] - q[m - 2];
      let az = starts ? q[3] - q[1] : q[m - 3] - q[m - 1];
      const al = Math.hypot(ax, az) || 1;
      ax /= al;
      az /= al;
      const dot = (dx * ax + dz * az) * sgn;
      if (g.tags.tunnel && cap === 1) cap = 2;
      if (dot > best && this.isReach(g)) {
        best = dot;
        bx = ax * sgn;
        bz = az * sgn;
        cap = 0;
      }
    }
    dx += bx;
    dz += bz;
    l = Math.hypot(dx, dz) || 1;
    return { tx: dx / l, tz: dz / l, cap };
  }

  /** Half widths of a river at a point across `n` (to the right): the surveyed water area's, or the default. */
  private widths(x: number, z: number, nx: number, nz: number, dflt: number): [number, number] {
    let left = Infinity;
    let right = Infinity;
    for (const f of this.world.source.query("water", x, z, x, z)) {
      if (f.tags.water !== "river" || !inPolygon(f, x, z)) continue;
      for (const ring of [f.pts, ...f.holes]) {
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const ex = ring[i] - ring[j];
          const ez = ring[i + 1] - ring[j + 1];
          const det = ex * nz - ez * nx;
          if (Math.abs(det) < 1e-9) continue;
          const wx = ring[j] - x;
          const wz = ring[j + 1] - z;
          // x + n t = ring[j] + e u.
          const t = (ex * wz - ez * wx) / det;
          const u = (nx * wz - nz * wx) / det;
          if (u < 0 || u > 1) continue;
          if (t >= 0) right = Math.min(right, t);
          else left = Math.min(left, -t);
        }
      }
    }
    if (left === Infinity || right === Infinity) return [dflt, dflt];
    return [clamp(left, 2.5, 60), clamp(right, 2.5, 60)];
  }

  reach(f: Feature): Reach | null {
    let r = this.reaches.get(f);
    if (r !== undefined) return r;
    r = this.isReach(f) ? this.buildReach(f) : null;
    this.reaches.set(f, r);
    return r;
  }

  private buildReach(f: Feature): Reach {
    const path = resample(f.pts, 8, 2);
    const { n, x, z, tx, tz } = path;
    const a = this.endTangent(f, false);
    const b = this.endTangent(f, true);
    tx[0] = a.tx;
    tz[0] = a.tz;
    tx[n - 1] = b.tx;
    tz[n - 1] = b.tz;
    const river = f.type === "river";
    let seed = 0;
    for (let i = 0; i < f.name.length; i++) seed = (seed * 31 + f.name.charCodeAt(i)) | 0;
    // Without a surveyed water area: 10–16 m of channel for a river (estimated), a ditch's width for a stream.
    const dflt = river ? 5 + 3 * hash2(seed, 5) : 1.8;
    const hl = new Float64Array(n);
    const hr = new Float64Array(n);
    const wl = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = this.widths(x[i], z[i], -tz[i], tx[i], dflt);
      hl[i] = w[0];
      hr[i] = w[1];
      // The lowest ground about the point, less the channel's depth; never deeper than the cut allows.
      let lo = Infinity;
      let surveyed = Infinity;
      for (const [ox, oz] of STENCIL) {
        const bx = x[i] + ox;
        const bz = z[i] + oz;
        const base = this.world.base(bx, bz, this.world.probe(bx, bz, this.probe));
        surveyed = Math.min(surveyed, base);
        lo = Math.min(lo, base - this.pit(bx, bz, base));
      }
      wl[i] = Math.max(lo - (river ? 1.3 : 0.9), surveyed - WATER_MAX);
    }
    smoothPinned(hl, 3);
    smoothPinned(hr, 3);
    smoothPinned(wl, 8);
    // On the inside of a bend the channel cannot be wider than the bend's radius.
    for (let i = 1; i + 1 < n; i++) {
      const turn = tx[i - 1] * tz[i + 1] - tz[i - 1] * tx[i + 1];
      const ds = path.s[i + 1] - path.s[i - 1] || 1;
      const k = Math.asin(clamp(turn, -1, 1)) / ds;
      if (Math.abs(k) < 1e-4) continue;
      const lim = Math.max(2.5, 0.8 / Math.abs(k) - BANK);
      // Turning right (k > 0) the right side is inside.
      if (k > 0) hr[i] = Math.min(hr[i], lim);
      else hl[i] = Math.min(hl[i], lim);
    }
    return { ...path, hl, hr, wl, open: river, capA: a.cap, capB: b.cap, seed, sec: null };
  }

  /** The reach's cross-sections: 17 columns from the left skirt over the water to the right skirt. */
  section(r: Reach): Float64Array {
    if (r.sec) return r.sec;
    const sec = (r.sec = new Float64Array(r.n * COLS * 3));
    for (let k = 0; k < r.n; k++) {
      const nx = -r.tz[k];
      const nz = r.tx[k];
      const wl = r.wl[k];
      for (const side of [-1, 1]) {
        const h = side < 0 ? r.hl[k] : r.hr[k];
        const f = r.open ? 0.42 + 0.44 * noise2(r.s[k] / 37 + side * 9.1, side * 3.7, r.seed & 255) : 0;
        const aw = Math.min(h * f, h - 0.7);
        const off = [aw, aw + 0.2, h, h + 0.35 * BANK, h + 0.7 * BANK, h + BANK, h + BANK + 4, h + BANK + 8];
        for (let i = 0; i < 8; i++) {
          const px = r.x[k] + nx * side * off[i];
          const pz = r.z[k] + nz * side * off[i];
          let y: number;
          if (i === 0) y = r.open ? wl : wl + 0.34;
          else if (i === 1) y = r.open ? wl + 0.22 : wl + 0.37;
          else if (i === 2) y = wl + 0.4;
          else {
            const g = this.ground(px, pz);
            const top = Math.max(g, wl + 0.5);
            const lump = 0.18 * (noise2(px / 3.1, pz / 3.1, 7) - 0.5);
            if (i === 3) y = lerp(wl + 0.4, top, 0.55) + lump;
            else if (i === 4) y = lerp(wl + 0.4, top, 0.9) + lump;
            else if (i === 7) y = g - 0.6;
            else y = top;
          }
          const o = (k * COLS + MID + side * (i + 1)) * 3;
          sec[o] = px;
          sec[o + 1] = y;
          sec[o + 2] = pz;
        }
      }
      const o = (k * COLS + MID) * 3;
      sec[o] = r.x[k];
      sec[o + 1] = r.open ? wl : wl + 0.34;
      sec[o + 2] = r.z[k];
    }
    return sec;
  }

  /** Reach segments whose footprint touches a 64 m square, as (reach, station) pairs. */
  private cutSegments(x: number, z: number): number[] {
    const cx = Math.floor(x / 64);
    const cz = Math.floor(z / 64);
    const key = (cx + 32768) * 65536 + (cz + 32768);
    let list = this.cutCells.get(key);
    if (list) return list;
    list = [];
    const x0 = cx * 64;
    const z0 = cz * 64;
    const pad = 60 + BANK + 8;
    for (const f of this.world.source.query("waterway", x0 - pad, z0 - pad, x0 + 64 + pad, z0 + 64 + pad)) {
      const r = this.reach(f);
      if (!r) continue;
      let id = this.cutIndex.get(r);
      if (id === undefined) {
        id = this.cutReaches.length;
        this.cutReaches.push(r);
        this.cutIndex.set(r, id);
      }
      for (let k = 0; k + 1 < r.n; k++) {
        const reach = Math.max(r.hl[k], r.hr[k], r.hl[k + 1], r.hr[k + 1]) + BANK + 8;
        if (Math.max(r.x[k], r.x[k + 1]) + reach < x0 || Math.min(r.x[k], r.x[k + 1]) - reach > x0 + 64) continue;
        if (Math.max(r.z[k], r.z[k + 1]) + reach < z0 || Math.min(r.z[k], r.z[k + 1]) - reach > z0 + 64) continue;
        list.push(id, k);
      }
    }
    this.cutCells.set(key, list);
    return list;
  }

  /** Whether a bridge's cut or a channel can reach the point (a cheap test before `cut`). */
  near(x: number, z: number): boolean {
    if (this.cutSegments(x, z).length) return true;
    for (const b of this.bridges) if (x >= b.box[0] && x <= b.box[2] && z >= b.box[1] && z <= b.box[3]) return true;
    return false;
  }

  /**
   * How far the terrain sinks at a point whose graded height is `base`:
   * the space under a bridge, and under a channel enough to lie below its
   * banks and water (the channel's own mesh is what shows there).
   */
  cut(x: number, z: number, base: number): number {
    const pit = this.pit(x, z, base);
    const g = base - pit;
    const list = this.cutSegments(x, z);
    let sink = 0;
    for (let i = 0; i < list.length; i += 2) {
      const r = this.cutReaches[list[i]];
      const k = list[i + 1];
      const ax = r.x[k];
      const az = r.z[k];
      const dx = r.x[k + 1] - ax;
      const dz = r.z[k + 1] - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
      const ex = x - (ax + dx * t);
      const ez = z - (az + dz * t);
      const dist = Math.hypot(ex, ez);
      const right = -dz * ex + dx * ez > 0;
      const outer = (right ? lerp(r.hr[k], r.hr[k + 1], t) : lerp(r.hl[k], r.hl[k + 1], t)) + BANK;
      if (dist > outer + 8) continue;
      const full = Math.max(0, g - (lerp(r.wl[k], r.wl[k + 1], t) - 0.8));
      const s = Math.min(full, 0.7) * (1 - smoothstep(outer + 4.5, outer + 8, dist)) + Math.max(0, full - 0.7) * (1 - smoothstep(outer + 0.5, outer + 3.5, dist));
      if (s > sink) sink = s;
    }
    return Math.min(CUT_MAX, pit + sink);
  }

  // ── railway

  track(f: Feature): Track {
    let t = this.tracks.get(f);
    if (t) return t;
    const path = resample(f.pts, 10, 0);
    const { n, x, z } = path;
    const y = new Float64Array(n);
    const ry = new Float64Array(n);
    const rw = new Float64Array(n);
    const on = new Uint8Array(n);
    const yard = !!f.tags.service;
    const bed = yard ? 0.3 : 0.6;
    const probe = this.probe;
    for (let i = 0; i < n; i++) {
      let g = -Infinity;
      // The highest ground within a terrain quad of the point: the bed never lies under the terrain mesh.
      for (const [ox, oz] of STENCIL) g = Math.max(g, this.ground(x[i] + ox * 0.7, z[i] + oz * 0.7));
      y[i] = g + bed;
      // Where the track lies in a ploughed road it takes the road's height.
      this.world.probe(x[i], z[i], probe);
      const road = probe.road;
      if (road && probe.e < 10 && !road.bridge[road.line.segment(probe.s)]) {
        rw[i] = 1 - smoothstep(0.5, 10, probe.e);
        ry[i] = road.line.at(probe.s, this.pt).y - 0.02 * Math.min(Math.abs(probe.d), road.half);
        y[i] = lerp(y[i], ry[i], rw[i]);
        if (probe.e < 0.4) on[i] = 1;
      }
    }
    if (f.tags.bridge) {
      for (let i = 1; i + 1 < n; i++) y[i] = lerp(y[0], y[n - 1], path.s[i] / (path.s[n - 1] || 1));
    } else {
      smoothPinned(y, 6);
      for (let i = 1; i + 1 < n; i++) y[i] = lerp(y[i], ry[i], rw[i]);
    }
    t = { ...path, y, on, bridge: !!f.tags.bridge, yard };
    this.tracks.set(f, t);
    return t;
  }

  // ── power

  private static towerHeight(f: Feature): number {
    const v = Number(f.tags.voltage) || 0;
    const six = Number(f.tags.cables) >= 6;
    // Estimated from the voltage class: 187 kV lines stand about 45 m, 66 kV about 26–32 m.
    return v >= 150000 ? (six ? 48 : 42) : v >= 60000 ? (six ? 32 : 26) : 22;
  }

  /** The tower at a power line's vertex: its height (the tallest line through it) and the first line's direction. */
  powerNode(x: number, z: number): PowerNode | undefined {
    if (!this.power) {
      this.power = new Map();
      for (const f of this.world.source.features) {
        if (f.kind !== "power") continue;
        const n = f.pts.length / 2;
        for (let i = 0; i < n; i++) {
          const k = this.nodeKey(f.pts[i * 2], f.pts[i * 2 + 1]);
          const a = Math.max(0, i - 1);
          const b = Math.min(n - 1, i + 1);
          let dx = f.pts[b * 2] - f.pts[a * 2];
          let dz = f.pts[b * 2 + 1] - f.pts[a * 2 + 1];
          const l = Math.hypot(dx, dz) || 1;
          dx /= l;
          dz /= l;
          const h = Model.towerHeight(f) * (0.94 + 0.12 * hash2(Math.round(f.pts[i * 2]), Math.round(f.pts[i * 2 + 1])));
          const node = this.power.get(k);
          if (node) node.h = Math.max(node.h, h);
          else this.power.set(k, { x: f.pts[i * 2], z: f.pts[i * 2 + 1], h, dx, dz });
        }
      }
    }
    return this.power.get(this.nodeKey(x, z));
  }
}

/** Where the lowest ground about a river's point is looked for (m). */
const STENCIL: readonly (readonly [number, number])[] = [
  [0, 0],
  [12, 0],
  [-12, 0],
  [0, 12],
  [0, -12],
  [8.5, 8.5],
  [-8.5, 8.5],
  [8.5, -8.5],
  [-8.5, -8.5],
];

const models = new WeakMap<RouteWorld, Model>();

function model(world: RouteWorld): Model {
  let m = models.get(world);
  if (!m) models.set(world, (m = new Model(world)));
  return m;
}

/**
 * How far the terrain mesh sinks under the graded terrain `base` at a
 * point: the space under the driven road's bridges and the channels of the
 * rivers. Anything standing on the ground there (`world.base`) should stand
 * this much lower.
 */
export function groundCut(world: RouteWorld, x: number, z: number, base: number): number {
  const m = model(world);
  return m.near(x, z) ? m.cut(x, z, base) : 0;
}

// ───────────────────────────────────────────────────────────── rivers

const inCell = (c: CellContext, x: number, z: number) => x >= c.x0 && x < c.x1 && z >= c.z0 && z < c.z1;

function rivers(c: CellContext, m: Model): void {
  const pad = 60 + BANK + 8;
  for (const f of c.world.source.query("waterway", c.x0 - pad, c.z0 - pad, c.x1 + pad, c.z1 + pad)) {
    const r = m.reach(f);
    if (r) river(c, m, r);
  }
}

function river(c: CellContext, m: Model, r: Reach): void {
  // Stations whose cross-section can reach the cell.
  let lo = -1;
  let hi = -1;
  for (let k = 0; k < r.n; k++) {
    const reach = Math.max(r.hl[k], r.hr[k]) + BANK + 10;
    if (r.x[k] < c.x0 - reach || r.x[k] > c.x1 + reach || r.z[k] < c.z0 - reach || r.z[k] > c.z1 + reach) continue;
    if (lo < 0) lo = k;
    hi = k;
  }
  if (lo < 0) return;
  lo = Math.max(0, lo - 1);
  hi = Math.min(r.n - 1, hi + 1);
  const sec = m.section(r);
  const mb = c.mb;
  const at = (k: number, j: number): V3 => {
    const o = (clamp(k, 0, r.n - 1) * COLS + clamp(j, 0, COLS - 1)) * 3;
    return [sec[o], sec[o + 1], sec[o + 2]];
  };
  const seen = new Map<number, number>();
  // Snow tints by distance from the water: wet ice at the edge, a blue-white shelf, white banks.
  const tintOf = (j: number): RGBA => {
    const i = Math.abs(j - MID);
    return i <= 1 ? (r.open ? C_ICE : C_SHELF) : i <= 3 ? C_SHELF : C_SNOW;
  };
  const vert = (k: number, j: number): number => {
    const key = k * COLS + j;
    const hit = seen.get(key);
    if (hit !== undefined) return hit;
    const p = at(k, j);
    const a = at(k - 1, j);
    const b = at(k + 1, j);
    const l = at(k, j - 1);
    const rr = at(k, j + 1);
    const along: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const across: V3 = [rr[0] - l[0], rr[1] - l[1], rr[2] - l[2]];
    let n: V3 = [across[1] * along[2] - across[2] * along[1], across[2] * along[0] - across[0] * along[2], across[0] * along[1] - across[1] * along[0]];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / nl, Math.abs(n[1] / nl), n[2] / nl];
    const t = tintOf(j);
    const v = 0.95 + 0.05 * fbm2(p[0] / 23, p[2] / 23, 2, 3);
    const i = mb.vertex(SNOW, p, n, (p[0] - c.x0) / 4, (p[2] - c.z0) / 4, [Math.round(t[0] * v), Math.round(t[1] * v), Math.round(t[2] * v), 255]);
    seen.set(key, i);
    return i;
  };
  const up: V3 = [0, 1, 0];
  for (let k = lo; k < hi; k++) {
    for (let j = 0; j + 1 < COLS; j++) {
      const a = at(k, j);
      const b = at(k, j + 1);
      const cc = at(k + 1, j + 1);
      const d = at(k + 1, j);
      if (!inCell(c, (a[0] + b[0] + cc[0] + d[0]) / 4, (a[2] + b[2] + cc[2] + d[2]) / 4)) continue;
      if (j === MID - 1 || j === MID) {
        // The water, flat between the two ice edges.
        if (!r.open) continue;
        const uv = [a, b, cc, d].flatMap((p) => [(p[0] - c.x0) / 8, (p[2] - c.z0) / 8]);
        quad4(mb, WATER, [a, b, cc, d], uv, C_WHITE, up, up);
        continue;
      }
      const i0 = vert(k, j);
      const i1 = vert(k, j + 1);
      const i2 = vert(k + 1, j + 1);
      const i3 = vert(k + 1, j);
      mb.tri(SNOW, i0, i1, i2);
      mb.tri(SNOW, i0, i2, i3);
    }
  }
  // An end no reach continues: the channel closes against the ground, on a headwall where a culvert takes the water.
  for (const [k, cap, dir] of [
    [0, r.capA, 1],
    [r.n - 1, r.capB, -1],
  ] as const) {
    if (!cap || !inCell(c, r.x[k], r.z[k])) continue;
    const out: V3 = [r.tx[k] * dir, 0, r.tz[k] * dir];
    const first = MID - 6;
    const last = MID + 6;
    const yl = at(k, first)[1];
    const yr = at(k, last)[1];
    for (let j = first; j < last; j++) {
      const a = at(k, j);
      const b = at(k, j + 1);
      const ta = lerp(yl, yr, (j - first) / (last - first)) + 0.05;
      const tb = lerp(yl, yr, (j + 1 - first) / (last - first)) + 0.05;
      const quad: [V3, V3, V3, V3] = [a, b, [b[0], tb, b[2]], [a[0], ta, a[2]]];
      // The headwall spans the channel's floor; the banks beside it close in snow.
      if (cap === 2 && j >= MID - 3 && j < MID + 3) {
        const mouth = j === MID - 1 || j === MID;
        const u0 = lerp(CONC[0], CONC[2], (j - first) / (last - first));
        const u1 = lerp(CONC[0], CONC[2], (j + 1 - first) / (last - first));
        quad4(mb, STRUCT, quad, mouth ? UV_PLAIN : [u0, CONC[1], u1, CONC[1], u1, CONC[3], u0, CONC[3]], mouth ? C_OPENING : C_CONC, out);
      } else quad4(mb, SNOW, quad, quad.flatMap((p) => [(p[0] - c.x0) / 4, (p[1] + p[2] - c.z0) / 4]), C_SHELF, out, [out[0] * 0.5, 0.86, out[2] * 0.5]);
    }
  }
}

/**
 * Where a road's strip runs over a cut (a side road over a river: the
 * survey has no bridges for them), its edges close on concrete walls down
 * to the cut ground, so the strip reads as a low bridge or a box culvert
 * and never as a ribbon in the air.
 */
function roadWalls(c: CellContext): void {
  const world = c.world;
  const probe = newProbe();
  const pt: LinePoint = { x: 0, y: 0, z: 0, tx: 0, tz: -1, grade: 0 };
  for (const road of world.roadsIn(c.x0, c.z0, c.x1, c.z1)) {
    const l = road.line;
    const d = road.zone - 0.06;
    let prev: { x: number; z: number; top: number; cut: number }[] | null = null;
    for (let i = 0; i < l.n; i++) {
      const near = l.x[i] > c.x0 - 24 && l.x[i] < c.x1 + 24 && l.z[i] > c.z0 - 24 && l.z[i] < c.z1 + 24;
      if (!near) {
        prev = null;
        continue;
      }
      l.at(l.s[i], pt);
      const cur = [-1, 1].map((side) => {
        const x = pt.x - pt.tz * d * side;
        const z = pt.z + pt.tx * d * side;
        const base = world.base(x, z, world.probe(x, z, probe));
        // Inside the driven road's strip a side road's edge is not an edge.
        const hidden = !road.main && probe.zoneRoad?.main;
        return { x, z, top: base - 0.6, cut: hidden || road.bridge[i] ? 0 : groundCut(world, x, z, base) };
      });
      if (prev) {
        for (let k = 0; k < 2; k++) {
          const a = prev[k];
          const b = cur[k];
          if (Math.max(a.cut, b.cut) < 0.9 || !inCell(c, (a.x + b.x) / 2, (a.z + b.z) / 2)) continue;
          const side = k ? 1 : -1;
          const ya = Math.min(a.top - 0.05, a.top + 0.45 - a.cut);
          const yb = Math.min(b.top - 0.05, b.top + 0.45 - b.cut);
          const fold = i & 1;
          const u0 = fold ? CONC[2] : CONC[0];
          const u1 = fold ? CONC[0] : CONC[2];
          quad4(
            c.mb,
            STRUCT,
            [
              [a.x, ya, a.z],
              [b.x, yb, b.z],
              [b.x, b.top, b.z],
              [a.x, a.top, a.z],
            ],
            [u0, lerp(CONC[3], CONC[1], clamp((a.top - ya) / 4, 0, 1)), u1, lerp(CONC[3], CONC[1], clamp((b.top - yb) / 4, 0, 1)), u1, CONC[3], u0, CONC[3]],
            [C_CONC_DARK, C_CONC_DARK, C_CONC, C_CONC],
            [-pt.tz * side, 0, pt.tx * side],
          );
        }
      }
      prev = cur;
    }
  }
}

/**
 * Where a stream or drain passes under the driven road in a culvert: a
 * headwall in each verge, its top out of the snow.
 */
function culverts(c: CellContext): void {
  const world = c.world;
  const main = world.main;
  const line = main.line;
  const pa: Projection = { s: 0, d: 0, i: 0 };
  const pb: Projection = { s: 0, d: 0, i: 0 };
  const probe = newProbe();
  for (const f of world.source.query("waterway", c.x0, c.z0, c.x1, c.z1)) {
    if (!f.tags.tunnel) continue;
    for (let i = 0; i + 2 < f.pts.length; i += 2) {
      const a = line.project(f.pts[i], f.pts[i + 1], 60, pa);
      const b = line.project(f.pts[i + 2], f.pts[i + 3], 60, pb);
      if (!a || !b || Math.sign(a.d) === Math.sign(b.d)) continue;
      const s = lerp(a.s, b.s, Math.abs(a.d) / (Math.abs(a.d) + Math.abs(b.d) || 1));
      const p = line.at(s);
      if (!inCell(c, p.x, p.z) || main.bridge[line.segment(s)]) continue;
      for (const side of [-1, 1]) {
        const d = (main.half + 6.2) * side;
        const x = p.x - p.tz * d;
        const z = p.z + p.tx * d;
        const y = world.base(x, z, world.probe(x, z, probe));
        const yaw = Math.atan2(-p.tz, p.tx);
        c.mb.box(STRUCT, x, y - 1.2, z, 1.5, 0.2, 1.55, yaw, [CONC[0], lerp(CONC[1], CONC[3], 0.6), lerp(CONC[0], CONC[2], 0.75), CONC[3]], C_CONC);
        c.mb.box(SNOW, x, y + 0.35, z, 1.56, 0.26, 0.14, yaw, [0, 0, 0.7, 0.1], C_SNOW);
      }
    }
  }
}

// ───────────────────────────────────────────────────────────── bridges

function bridges(c: CellContext, m: Model): void {
  for (const b of m.bridges) {
    if (c.x1 < b.box[0] || c.x0 > b.box[2] || c.z1 < b.box[1] || c.z0 > b.box[3]) continue;
    bridge(c, b);
  }
}

function bridge(c: CellContext, b: Bridge): void {
  const world = c.world;
  const road = world.main;
  const line = road.line;
  const half = road.half;
  const detail = c.layer.name === "detail";
  const mb = c.mb;
  const n = b.st.length - 1;
  const pts = Array.from(b.st, (s) => line.at(s));
  /** A point of the deck: offset `d` to the right, `dy` above the road surface there. */
  const P = (k: number, d: number, dy: number): V3 => {
    const p = pts[k];
    return [p.x - p.tz * d, p.y - 0.02 * Math.min(Math.abs(d), half) + dy, p.z + p.tx * d];
  };
  // The kerb's outer face, and where the girders' outer faces stand.
  const E = half + 0.5;
  const gx = half - 0.7;
  const under = -(b.slab + b.girder);
  const probe = newProbe();
  /** The ground under the deck at a point, as the terrain mesh shows it. */
  const floor = (x: number, z: number): number => {
    const base = world.base(x, z, world.probe(x, z, probe));
    return base - groundCut(world, x, z, base) - 0.7;
  };

  for (let k = 0; k < n; k++) {
    const mid = line.at((b.st[k] + b.st[k + 1]) / 2);
    if (!inCell(c, mid.x, mid.z)) continue;
    const fold = k & 1;
    const fu = (r: readonly [number, number, number, number]) => (fold ? [r[2], r[0]] : [r[0], r[2]]);
    const [cu0, cu1] = fu(CONC);
    const [pu0, pu1] = fu(PLATE);
    const cv = (dy: number) => lerp(CONC[1], CONC[3], clamp((dy + 3) / 4, 0, 1));
    /** A strip of the deck's section swept over this segment. */
    const sweep = (material: string, d0: number, y0: number, d1: number, y1: number, uv: number[], color: RGBA | readonly [RGBA, RGBA, RGBA, RGBA], out: V3, normal?: V3) => quad4(mb, material, [P(k, d0, y0), P(k, d1, y1), P(k + 1, d1, y1), P(k + 1, d0, y0)], uv, color, out, normal);
    for (const side of [-1, 1]) {
      const r: V3 = [-mid.tz * side, 0, mid.tx * side];
      const q = (kk: number) => 0.75 + 0.5 * fbm2(b.st[kk] / 9 + side * 5.3, side * 2.1, 2, 9);
      // Toward the ends the plough's windrow narrows into the bank's foot.
      const taper = (kk: number) => 0.12 + 0.88 * smoothstep(0, 6, Math.min(b.st[kk] - b.sA, b.sB - b.st[kk]));
      if (detail) {
        // Posts of a post-and-rail parapet every 2 m; a wall's top rail stands on stubs every 2.5 m.
        const step = b.wall ? 2.5 : 2;
        const s0 = Math.ceil((b.st[k] - b.sA) / step - 1e-6) * step + b.sA;
        for (let s = s0; s < b.st[k + 1] - 1e-6; s += step) {
          const p = line.at(s);
          const d = (half + (b.wall ? 0.32 : 0.25)) * side;
          const x = p.x - p.tz * d;
          const z = p.z + p.tx * d;
          const y = p.y - 0.02 * half;
          if (b.wall) mb.box(STRUCT, x, y + 0.9, z, 0.035, 0.035, 0.26, Math.atan2(-p.tz, p.tx), PLAIN, C_GREY);
          else mb.box(STRUCT, x, y + 0.2, z, 0.05, 0.045, 1.06, Math.atan2(-p.tz, p.tx), PLAIN, b.paint);
        }
        continue;
      }
      // Snow the plough leaves against the kerb, lower than a roadside bank.
      const wedge: [number, number][] = b.wall
        ? [
            [half - 1.15, 0.015],
            [half - 0.55, 0.26],
            [half + 0.1, 0.5],
          ]
        : [
            [half - 1.15, 0.015],
            [half - 0.55, 0.26],
            [half - 0.02, 0.48],
            [half + 0.32, 0.42],
            [E, 0.27],
          ];
      const base = mb.count(SNOW);
      for (const kk of [k, k + 1]) {
        wedge.forEach(([d, h], i) => {
          const p = P(kk, (d < half ? half + (d - half) * taper(kk) : d) * side, i === 0 || (!b.wall && i === wedge.length - 1) ? h : h * q(kk));
          const lean = i === 0 ? 0.25 : i < 3 ? 0.55 : -0.3;
          const nl = Math.hypot(lean, 1);
          mb.vertex(SNOW, p, [(-r[0] * lean) / nl, 1 / nl, (-r[2] * lean) / nl], (p[0] - c.x0) / 4, (p[2] - c.z0) / 4, C_SNOW);
        });
      }
      const w = wedge.length;
      for (let i = 0; i + 1 < w; i++) {
        const a0 = base + i;
        const a1 = base + i + 1;
        const b0 = base + w + i;
        const b1 = base + w + i + 1;
        // Offsets run outward: on the right side that is left to right.
        if (side > 0) {
          mb.tri(SNOW, a0, a1, b1);
          mb.tri(SNOW, a0, b1, b0);
        } else {
          mb.tri(SNOW, a0, b1, a1);
          mb.tri(SNOW, a0, b0, b1);
        }
      }
      // The slab's edge, its underside out to the girder, the girder's web.
      const top = b.wall ? 0.92 : 0.27;
      sweep(STRUCT, E * side, top, E * side, -b.slab, [cu0, cv(top), cu0, cv(-b.slab), cu1, cv(-b.slab), cu1, cv(top)], C_CONC, r);
      if (b.girder) {
        sweep(STRUCT, E * side, -b.slab, gx * side, -b.slab, [cu0, CONC[1], cu0, CONC[3], cu1, CONC[3], cu1, CONC[1]], C_SOFFIT, [0, -1, 0]);
        sweep(STRUCT, gx * side, -b.slab, gx * side, under, [pu0, PLATE[3], pu0, PLATE[1], pu1, PLATE[1], pu1, PLATE[3]], b.paint, r);
      }
      if (b.wall) {
        // A concrete wall parapet: its road face, snow on its top, a steel rail above it.
        sweep(STRUCT, (half + 0.1) * side, 0.3, (half + 0.1) * side, 0.92, [cu0, cv(0.3), cu0, cv(0.92), cu1, cv(0.92), cu1, cv(0.3)], C_CONC, [-r[0], 0, -r[2]]);
        const cap = mb.count(SNOW);
        for (const kk of [k, k + 1])
          for (const [d, h, lean] of [
            [half + 0.1, 0.92, -0.6],
            [half + 0.3, 1.0 + 0.05 * q(kk), 0],
            [E, 0.92, 0.6],
          ] as const) {
            const p = P(kk, d * side, h);
            const nl = Math.hypot(lean, 1);
            mb.vertex(SNOW, p, [(r[0] * lean) / nl, 1 / nl, (r[2] * lean) / nl], (p[0] - c.x0) / 4, (p[2] - c.z0) / 4, C_SNOW);
          }
        for (let i = 0; i < 2; i++) {
          if (side > 0) {
            mb.tri(SNOW, cap + i, cap + i + 1, cap + 3 + i + 1);
            mb.tri(SNOW, cap + i, cap + 3 + i + 1, cap + 3 + i);
          } else {
            mb.tri(SNOW, cap + i, cap + 3 + i + 1, cap + i + 1);
            mb.tri(SNOW, cap + i, cap + 3 + i, cap + 3 + i + 1);
          }
        }
        beam(mb, STRUCT, P(k, (half + 0.32) * side, 1.22), P(k + 1, (half + 0.32) * side, 1.22), 0.09, 0.08, C_GREY);
      } else {
        // Post-and-rail: a top rail and two lower ones, painted with the girders.
        beam(mb, STRUCT, P(k, (half + 0.25) * side, 1.3), P(k + 1, (half + 0.25) * side, 1.3), 0.11, 0.09, b.paint);
        for (const h of [0.62, 0.95]) beam(mb, STRUCT, P(k, (half + 0.25) * side, h), P(k + 1, (half + 0.25) * side, h), 0.06, 0.06, b.paint, b.paint, false);
      }
    }
    if (detail) continue;
    // The underside: between the girders' bottom flanges, or the whole slab.
    const w = b.girder ? gx : E;
    sweep(STRUCT, -w, under, w, under, [cu0, CONC[1], cu0, CONC[3], cu1, CONC[3], cu1, CONC[1]], C_SOFFIT, [0, -1, 0]);
  }
  if (detail) return;

  // Piers: a wall under the girders down into the ground or the river.
  for (const s of b.piers) {
    const p = line.at(s);
    if (!inCell(c, p.x, p.z)) continue;
    let y0 = Infinity;
    for (const d of [-gx, 0, gx]) y0 = Math.min(y0, floor(p.x - p.tz * d, p.z + p.tx * d));
    y0 -= 1.2;
    const y1 = p.y - 0.02 * half + under;
    const yaw = Math.atan2(-p.tx, -p.tz);
    mb.box(STRUCT, p.x, y0, p.z, gx - 0.5, 0.55, y1 - 0.35 - y0, yaw, CONC, C_CONC);
    // The cap the bearings sit on.
    mb.box(STRUCT, p.x, y1 - 0.35, p.z, gx + 0.15, 0.75, 0.35, yaw, PLAIN, [200, 199, 195, 255]);
  }

  // Abutments: the end of the embankment and of its snow banks, walled across the strip's cross-section.
  const beyond = beyondOf(road);
  const offs: number[] = [];
  for (let i = beyond.length - 1; i >= 0; i--) offs.push(-(half + beyond[i]));
  offs.push(-half, 0, half);
  for (const e of beyond) offs.push(half + e);
  for (const [k, dir] of [
    [0, 1],
    [n, -1],
  ] as const) {
    const p = pts[k];
    if (!inCell(c, p.x, p.z)) continue;
    const out: V3 = [p.tx * dir, 0, p.tz * dir];
    // The strip's own section here, and the cut ground in front of it.
    const top: V3[] = offs.map((d, j) => {
      const x = p.x - p.tz * d;
      const z = p.z + p.tx * d;
      if (Math.abs(d) <= half) return [x, p.y - 0.02 * Math.abs(d) - 0.03, z];
      world.probe(x, z, probe);
      let y = world.base(x, z, probe);
      if (probe.road && probe.e > 0) y += world.bank(probe.e, probe.s, probe.road.cls, Math.sign(probe.d));
      if (j === 0 || j === offs.length - 1) y -= SKIRT;
      return [x, y - 0.02, z];
    });
    let foot = Infinity;
    for (const v of top) foot = Math.min(foot, floor(v[0] + out[0] * 3, v[2] + out[2] * 3));
    foot -= 0.8;
    const seat = p.y - 0.02 * half - 0.12;
    for (let j = 0; j + 1 < offs.length; j++) {
      const a = top[j];
      const d = top[j + 1];
      const u0 = lerp(CONC[0], CONC[2], j / (offs.length - 1));
      const u1 = lerp(CONC[0], CONC[2], (j + 1) / (offs.length - 1));
      // Concrete up to the road's level; above it the cut end of the snow bank.
      const ca = Math.min(a[1], seat);
      const cd = Math.min(d[1], seat);
      quad4(
        mb,
        STRUCT,
        [
          [a[0], foot, a[2]],
          [d[0], foot, d[2]],
          [d[0], cd, d[2]],
          [a[0], ca, a[2]],
        ],
        [u0, CONC[1], u1, CONC[1], u1, lerp(CONC[1], CONC[3], clamp((cd - foot) / 4, 0, 1)), u0, lerp(CONC[1], CONC[3], clamp((ca - foot) / 4, 0, 1))],
        [C_CONC_DARK, C_CONC_DARK, C_CONC, C_CONC],
        out,
      );
      if (a[1] > ca + 0.01 || d[1] > cd + 0.01) {
        const quad: [V3, V3, V3, V3] = [[a[0], ca, a[2]], [d[0], cd, d[2]], d, a];
        quad4(mb, SNOW, quad, quad.flatMap((v) => [(v[0] + v[2] - c.x0) / 4, v[1] / 4]), C_SHELF, out, [out[0] * 0.6, 0.8, out[2] * 0.6]);
      }
    }
    // The end posts of the parapets, capped with snow.
    for (const side of [-1, 1]) {
      const d = (half + 0.3) * side;
      const x = p.x - p.tz * d + out[0] * 0.3;
      const z = p.z + p.tx * d + out[2] * 0.3;
      const y = p.y - 0.02 * half;
      const yaw = Math.atan2(-p.tz, p.tx);
      mb.box(STRUCT, x, y - 0.1, z, 0.3, 0.27, 1.45, yaw, [CONC[0], lerp(CONC[1], CONC[3], 0.62), lerp(CONC[0], CONC[2], 0.16), CONC[3]], C_CONC);
      mb.box(SNOW, x, y + 1.35, z, 0.33, 0.3, 0.16, yaw, [0, 0, 0.2, 0.2], C_SNOW);
    }
  }
}

// ───────────────────────────────────────────────────────────── railway

const GAUGE = 1.067;

function railway(c: CellContext, m: Model): void {
  const detail = c.layer.name === "detail";
  const world = c.world;
  const mb = c.mb;
  const probe = newProbe();
  for (const f of world.source.query("rail", c.x0 - 8, c.z0 - 8, c.x1 + 8, c.z1 + 8)) {
    if (f.tags.tunnel || f.pts.length < 4) continue;
    const t = m.track(f);
    const pos = (k: number, d: number, dy: number): V3 => [t.x[k] - t.tz[k] * d, t.y[k] + dy, t.z[k] + t.tx[k] * d];
    /** The foot of the bed: on the ground as the terrain shows it, under the snow. */
    const toe = (k: number, d: number): V3 => {
      const x = t.x[k] - t.tz[k] * d;
      const z = t.z[k] + t.tx[k] * d;
      const base = world.base(x, z, world.probe(x, z, probe));
      return [x, Math.min(base - groundCut(world, x, z, base) - 0.3, t.y[k] - 0.25), z];
    };
    for (let k = 0; k + 1 < t.n; k++) {
      if (!inCell(c, (t.x[k] + t.x[k + 1]) / 2, (t.z[k] + t.z[k + 1]) / 2)) continue;
      const road = t.on[k] && t.on[k + 1];
      if (detail) {
        // The rails: dark through the snow, bright on top where the wheels run.
        const lift = road ? 0.035 : 0.05;
        for (const side of [-1, 1]) beam(mb, STRUCT, pos(k, (side * GAUGE) / 2, lift), pos(k + 1, (side * GAUGE) / 2, lift), 0.075, 0.14, C_RAIL_TOP, C_RAIL_SIDE, false);
        continue;
      }
      const up: V3 = [0, 1, 0];
      if (t.bridge) {
        // A deck plate girder: two webs under the track, the deck's snow between its edges.
        const fold = k & 1;
        const u0 = fold ? PLATE[2] : PLATE[0];
        const u1 = fold ? PLATE[0] : PLATE[2];
        const paint = PAINTS[1];
        quad4(mb, SNOW, [pos(k, -1.7, 0), pos(k, 1.7, 0), pos(k + 1, 1.7, 0), pos(k + 1, -1.7, 0)], [0, 0, 0.85, 0, 0.85, 2.5, 0, 2.5], C_BED, up);
        for (const side of [-1, 1]) {
          const r: V3 = [-t.tz[k] * side, 0, t.tx[k] * side];
          quad4(mb, STRUCT, [pos(k, 1.7 * side, 0), pos(k, 1.7 * side, -0.22), pos(k + 1, 1.7 * side, -0.22), pos(k + 1, 1.7 * side, 0)], UV_PLAIN, C_RAIL_SIDE, r);
          quad4(mb, STRUCT, [pos(k, 1.0 * side, -0.22), pos(k, 1.0 * side, -1.5), pos(k + 1, 1.0 * side, -1.5), pos(k + 1, 1.0 * side, -0.22)], [u0, PLATE[3], u0, PLATE[1], u1, PLATE[1], u1, PLATE[3]], paint, r);
          quad4(mb, STRUCT, [pos(k, 1.7 * side, -0.22), pos(k, 1.0 * side, -0.22), pos(k + 1, 1.0 * side, -0.22), pos(k + 1, 1.7 * side, -0.22)], UV_PLAIN, C_RAIL_SIDE, [0, -1, 0]);
        }
        quad4(mb, STRUCT, [pos(k, -1, -1.5), pos(k, 1, -1.5), pos(k + 1, 1, -1.5), pos(k + 1, -1, -1.5)], UV_PLAIN, C_RAIL_SIDE, [0, -1, 0]);
        continue;
      }
      if (road) continue;
      // The bed under snow: shoulders, and between them the trough the trains keep open.
      const cols: [V3, RGBA][][] = [k, k + 1].map((kk) => [
        [toe(kk, -3.1), C_SNOW],
        [pos(kk, -1.7, 0), C_SNOW],
        [pos(kk, -1.0, -0.08), C_BED],
        [pos(kk, 1.0, -0.08), C_BED],
        [pos(kk, 1.7, 0), C_SNOW],
        [toe(kk, 3.1), C_SNOW],
      ]);
      const normals: V3[] = [
        [-t.tz[k] * -0.5, 0.86, t.tx[k] * -0.5],
        [-t.tz[k] * -0.2, 0.98, t.tx[k] * -0.2],
        up,
        up,
        [-t.tz[k] * 0.2, 0.98, t.tx[k] * 0.2],
        [-t.tz[k] * 0.5, 0.86, t.tx[k] * 0.5],
      ];
      const first = mb.count(SNOW);
      for (const row of cols) row.forEach(([p, col], j) => mb.vertex(SNOW, p, normals[j], (p[0] - c.x0) / 4, (p[2] - c.z0) / 4, col));
      for (let j = 0; j < 5; j++) {
        mb.tri(SNOW, first + j, first + j + 1, first + 6 + j + 1);
        mb.tri(SNOW, first + j, first + 6 + j + 1, first + 6 + j);
      }
    }
    if (detail || !t.bridge) continue;
    // A railway bridge's abutments and, on a long one, piers every 20 m.
    const len = t.s[t.n - 1];
    const spans = Math.max(1, Math.round(len / 20));
    for (let i = 0; i <= spans; i++) {
      const s = (len * i) / spans;
      const k = Math.min(t.n - 2, Math.floor((s / len) * (t.n - 1)));
      const u = clamp((s - t.s[k]) / (t.s[k + 1] - t.s[k] || 1), 0, 1);
      const x = lerp(t.x[k], t.x[k + 1], u);
      const z = lerp(t.z[k], t.z[k + 1], u);
      if (!inCell(c, x, z)) continue;
      const y = lerp(t.y[k], t.y[k + 1], u);
      const base = world.base(x, z, world.probe(x, z, probe));
      const y0 = base - groundCut(world, x, z, base) - 2;
      const end = i === 0 || i === spans;
      mb.box(STRUCT, x, y0, z, end ? 2.2 : 1.3, end ? 0.9 : 0.5, y - (end ? 0.25 : 1.5) - y0, Math.atan2(-t.tx[k], -t.tz[k]), CONC, C_CONC);
    }
  }
}

/** The nearest point of the railway to a point: its track, station and distance. */
function nearestTrack(c: CellContext, m: Model, x: number, z: number, reach: number, skip?: Track): { t: Track; k: number; u: number; d: number } | null {
  let best: { t: Track; k: number; u: number; d: number } | null = null;
  for (const f of c.world.source.query("rail", x - reach, z - reach, x + reach, z + reach)) {
    if (f.tags.tunnel || f.pts.length < 4) continue;
    const t = m.track(f);
    if (t === skip) continue;
    for (let k = 0; k + 1 < t.n; k++) {
      const dx = t.x[k + 1] - t.x[k];
      const dz = t.z[k + 1] - t.z[k];
      const u = clamp(((x - t.x[k]) * dx + (z - t.z[k]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
      const d = Math.hypot(x - (t.x[k] + dx * u), z - (t.z[k] + dz * u));
      // A running line before a siding at the same distance.
      const rank = d + (t.yard ? 3 : 0);
      if (rank < reach && (!best || rank < best.d)) best = { t, k, u, d: rank };
    }
  }
  return best;
}

/**
 * A level crossing's equipment where a ploughed road crosses the track: on
 * each approach, to the left of the road, a striped post with the crossing
 * sign (踏切警標), the pair of warning lamps and the barrier with its boom
 * raised. Dimensions follow the usual first-class crossing (estimated).
 */
function crossings(c: CellContext, m: Model): void {
  const world = c.world;
  const mb = c.mb;
  const probe = newProbe();
  for (const f of world.source.query("point", c.x0, c.z0, c.x1, c.z1)) {
    if (f.type !== "rail-level_crossing") continue;
    const x = f.pts[0];
    const z = f.pts[1];
    if (!inCell(c, x, z)) continue;
    world.probe(x, z, probe);
    const road = probe.road;
    if (!road || probe.e > 0.5 || road.main) continue;
    const hit = nearestTrack(c, m, x, z, 12);
    if (!hit) continue;
    const t = hit.t;
    // How far along the road the track's edge lies from its centre: the track may cross at an angle.
    const rp = road.line.at(probe.s);
    const sin = Math.abs(rp.tx * -t.tz[hit.k] + rp.tz * t.tx[hit.k]);
    const back = Math.min(9, 3.2 / Math.max(0.35, sin));
    for (const dir of [1, -1]) {
      // Approaching in direction `dir` along the road: before the track, on the left.
      const p = road.line.at(probe.s - dir * back);
      const d = -(road.half + 0.9) * dir;
      const bx = p.x - p.tz * d;
      const bz = p.z + p.tx * d;
      const by = p.y - 0.1;
      // The equipment faces the approaching driver.
      const n: V3 = [-p.tx * dir, 0, -p.tz * dir];
      const e: V3 = [n[2], 0, -n[0]];
      stripedPole(mb, [bx, by, bz], [bx, by + 3.5, bz], 0.057, 6, 0.44, C_YELLOW, C_BLACK);
      // The crossed boards.
      const cy = by + 3.15;
      for (const roll of [Math.PI / 4, -Math.PI / 4]) {
        for (let i = 0; i < 5; i++) {
          const a = (i - 2) * 0.24;
          const cx: V3 = [bx + e[0] * a * Math.cos(roll) + n[0] * 0.07, cy + a * Math.sin(roll), bz + e[2] * a * Math.cos(roll) + n[2] * 0.07];
          panel(mb, STRUCT, cx, n, 0.24, 0.15, PLAIN, i & 1 ? C_BLACK : C_YELLOW, roll, true);
        }
      }
      // The lamps: a black board with two red lenses, dark until a train comes.
      const ly = by + 2.35;
      panel(mb, STRUCT, [bx + n[0] * 0.08, ly, bz + n[2] * 0.08], n, 0.92, 0.36, PLAIN, C_BLACK, 0, true);
      for (const o of [-0.26, 0.26]) {
        const lc: V3 = [bx + e[0] * o + n[0] * 0.1, ly, bz + e[2] * o + n[2] * 0.1];
        const first = mb.count(STRUCT);
        mb.vertex(STRUCT, lc, n, PLAIN[0], PLAIN[1], C_LAMP);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          mb.vertex(STRUCT, [lc[0] + e[0] * 0.13 * Math.cos(a), lc[1] + 0.13 * Math.sin(a), lc[2] + e[2] * 0.13 * Math.cos(a)], n, PLAIN[0], PLAIN[1], C_LAMP);
        }
        for (let i = 0; i < 8; i++) mb.tri(STRUCT, first, first + 1 + i, first + 1 + ((i + 1) % 8));
      }
      // The barrier: its machine, and the boom standing raised over the verge.
      const yaw = Math.atan2(-e[2], e[0]);
      const mx = bx - n[0] * 0.75;
      const mz = bz - n[2] * 0.75;
      mb.box(STRUCT, mx, by, mz, 0.2, 0.22, 1.15, yaw, PLAIN, C_GREY);
      mb.box(SNOW, mx, by + 1.15, mz, 0.22, 0.24, 0.1, yaw, [0, 0, 0.1, 0.1], C_SNOW);
      const toRoad = dir;
      const tip: V3 = [mx + e[0] * 0.8 * toRoad, by + 0.95 + 4.6, mz + e[2] * 0.8 * toRoad];
      stripedPole(mb, [mx + e[0] * 0.26 * toRoad, by + 0.95, mz + e[2] * 0.26 * toRoad], tip, 0.035, 4, 0.5, C_YELLOW, C_BLACK);
    }
  }
}

/**
 * A station: a low platform under snow beside the track, on a halt a small
 * waiting shelter, and (in `detail`) two name boards. Station buildings
 * come from the building footprints.
 */
function stations(c: CellContext, m: Model): void {
  const world = c.world;
  const mb = c.mb;
  const detail = c.layer.name === "detail";
  const probe = newProbe();
  for (const f of world.source.query("point", c.x0, c.z0, c.x1, c.z1)) {
    if (f.type !== "rail-station" && f.type !== "rail-halt") continue;
    const x = f.pts[0];
    const z = f.pts[1];
    if (!inCell(c, x, z)) continue;
    const hit = nearestTrack(c, m, x, z, 60);
    if (!hit) continue;
    const t = hit.t;
    const main = MAIN_STATIONS.includes(f.name);
    const length = main ? 90 : 45;
    // The platform's middle: at the survey's point, moved along where the way ends short of half a platform.
    const total = t.s[t.n - 1];
    const sc = clamp(lerp(t.s[hit.k], t.s[hit.k + 1], hit.u), Math.min(length, total) / 2, Math.max(total - length / 2, Math.min(length, total) / 2));
    const at = (s: number) => {
      const cs = clamp(s, 0, t.s[t.n - 1]);
      let k = Math.min(t.n - 2, Math.floor((cs / (t.s[t.n - 1] || 1)) * (t.n - 1)));
      while (k > 0 && t.s[k] > cs) k--;
      while (k < t.n - 2 && t.s[k + 1] < cs) k++;
      const u = clamp((cs - t.s[k]) / (t.s[k + 1] - t.s[k] || 1), 0, 1);
      return { x: lerp(t.x[k], t.x[k + 1], u), y: lerp(t.y[k], t.y[k + 1], u), z: lerp(t.z[k], t.z[k + 1], u), tx: t.tx[k], tz: t.tz[k] };
    };
    const p0 = at(sc);
    // The side the survey's point lies on, unless another track runs there.
    let side = Math.sign((x - p0.x) * -p0.tz + (z - p0.z) * p0.tx) || 1;
    const blocked = (sd: number) => !!nearestTrack(c, m, p0.x - p0.tz * 3.2 * sd, p0.z + p0.tx * 3.2 * sd, 2.6, t);
    if (blocked(side) && !blocked(-side)) side = -side;
    const d0 = 1.45 * side;
    const d1 = (1.45 + 2.6) * side;
    const s0 = Math.max(0, sc - length / 2);
    const s1 = Math.min(total, sc + length / 2);
    const steps = Math.max(2, Math.ceil((s1 - s0) / 7.5));
    // Platform height above the rail: 0.92 m, with 0.2 m of snow on it.
    const H = 0.92;
    const row = (s: number) => {
      const p = at(s);
      const o = (d: number, y: number): V3 => [p.x - p.tz * d, y, p.z + p.tx * d];
      const gx = p.x - p.tz * (d1 + 1.8 * side);
      const gz = p.z + p.tx * (d1 + 1.8 * side);
      const g = world.base(gx, gz, world.probe(gx, gz, probe));
      return { p, pts: [o(d0, p.y - 0.4), o(d0, p.y + H), o(d0 + 0.3 * side, p.y + H + 0.2), o(d1 - 0.3 * side, p.y + H + 0.22), o(d1, p.y + H + 0.08), [gx, Math.min(g - 0.2, p.y + H - 0.2), gz] as V3] };
    };
    if (!detail) {
      let prev = row(s0);
      for (let i = 1; i <= steps; i++) {
        const cur = row(s0 + ((s1 - s0) * i) / steps);
        const r: V3 = [-cur.p.tz * side, 0, cur.p.tx * side];
        const fold = i & 1;
        const u0 = fold ? CONC[2] : CONC[0];
        const u1 = fold ? CONC[0] : CONC[2];
        const vTop = lerp(CONC[1], CONC[3], 0.33);
        // The face toward the track, the snow on top, the snow slope behind.
        quad4(mb, STRUCT, [prev.pts[0], cur.pts[0], cur.pts[1], prev.pts[1]], [u0, CONC[1], u1, CONC[1], u1, vTop, u0, vTop], C_CONC, [-r[0], 0, -r[2]]);
        for (let j = 1; j < 5; j++) {
          const quad: [V3, V3, V3, V3] = [prev.pts[j], cur.pts[j], cur.pts[j + 1], prev.pts[j + 1]];
          const lean = j === 1 ? -0.5 : j === 2 ? 0 : j === 3 ? 0.4 : 0.8;
          quad4(mb, SNOW, quad, quad.flatMap((v) => [(v[0] - c.x0) / 4, (v[2] - c.z0) / 4]), C_SNOW, [0, 1, 0], [r[0] * lean * 0.6, 1 - Math.abs(lean) * 0.25, r[2] * lean * 0.6]);
        }
        prev = cur;
      }
      // The ends.
      for (const [s, dir] of [
        [s0, -1],
        [s1, 1],
      ] as const) {
        const e = row(s);
        const out: V3 = [e.p.tx * dir, 0, e.p.tz * dir];
        const b0 = e.pts[0];
        const b1: V3 = [e.pts[4][0], b0[1], e.pts[4][2]];
        quad4(mb, STRUCT, [b0, b1, e.pts[4], e.pts[1]], [CONC[0], CONC[1], CONC[2], CONC[1], CONC[2], lerp(CONC[1], CONC[3], 0.33), CONC[0], lerp(CONC[1], CONC[3], 0.33)], C_CONC, out);
      }
      if (!main) {
        // A halt's waiting shelter: a hut at the back of the platform, a door toward the track, snow on its roof.
        const dc = (1.45 + 1.65) * side;
        const cx = p0.x - p0.tz * dc;
        const cz = p0.z + p0.tx * dc;
        const y = p0.y + H + 0.1;
        const yaw = Math.atan2(-p0.tz, p0.tx);
        mb.box(STRUCT, cx, y, cz, 1.9, 0.9, 2.35, yaw, PLAIN, C_SHELTER);
        mb.box(SNOW, cx, y + 2.35, cz, 2.1, 1.1, 0.3, yaw, [0, 0, 1, 0.1], C_SNOW);
        const n: V3 = [p0.tz * side, 0, -p0.tx * side];
        panel(mb, STRUCT, [cx + n[0] * 0.92 + p0.tx * 0.9, y + 1.0, cz + n[2] * 0.92 + p0.tz * 0.9], n, 0.9, 1.9, PLAIN, C_DOOR);
        panel(mb, STRUCT, [cx + n[0] * 0.92 - p0.tx * 0.7, y + 1.45, cz + n[2] * 0.92 - p0.tz * 0.7], n, 1.2, 0.7, PLAIN, C_DOOR);
      }
      continue;
    }
    // Name boards toward both ends, at the back of the platform, read from the track and from behind.
    const index = STATIONS.findIndex((s) => s.key === f.name);
    if (index < 0) continue;
    const uv = atlasCell(`board-${index}`).uv;
    for (const frac of [-0.3, 0.3]) {
      const p = at(sc + frac * (s1 - s0));
      const d = (1.45 + 2.25) * side;
      const bx = p.x - p.tz * d;
      const bz = p.z + p.tx * d;
      const y = p.y + H + 0.15;
      const n: V3 = [p.tz * side, 0, -p.tx * side];
      for (const o of [-0.62, 0.62]) {
        const px = bx + p.tx * o;
        const pz = bz + p.tz * o;
        mb.tube(STRUCT, [px, y - 0.3, pz], [px, y + 2.1, pz], 0.035, 0.035, 5, PLAIN, C_GREY);
      }
      panel(mb, STRUCT, [bx + n[0] * 0.04, y + 1.62, bz + n[2] * 0.04], n, BOARD.w, BOARD.h, uv, C_WHITE);
      panel(mb, STRUCT, [bx - n[0] * 0.04, y + 1.62, bz - n[2] * 0.04], [-n[0], 0, -n[2]], BOARD.w, BOARD.h, uv, C_WHITE);
      // Snow on the board's top edge.
      beam(mb, SNOW, [bx - p.tx * 0.78, y + 2.12, bz - p.tz * 0.78], [bx + p.tx * 0.78, y + 2.12, bz + p.tz * 0.78], 0.14, 0.08, C_SNOW, C_SNOW, false);
    }
  }
}

// ───────────────────────────────────────────────────────────── power

function power(c: CellContext, m: Model): void {
  const world = c.world;
  const mb = c.mb;
  const probe = newProbe();
  const ground = (x: number, z: number) => world.base(x, z, world.probe(x, z, probe));
  // Towers: two crossed cut-out cards, the one across the line carrying the arms.
  for (const f of world.source.query("tower", c.x0, c.z0, c.x1, c.z1)) {
    const x = f.pts[0];
    const z = f.pts[1];
    if (!inCell(c, x, z)) continue;
    const node = m.powerNode(x, z);
    if (!node && f.type !== "tower" && f.type !== "power-tower") continue;
    const a = hash2(Math.round(x), Math.round(z)) * Math.PI;
    const dx = node ? node.dx : Math.cos(a);
    const dz = node ? node.dz : Math.sin(a);
    const h = node ? node.h : 24 + 8 * hash2(Math.round(z), Math.round(x));
    const y = ground(x, z) - 0.3;
    const front = node ? atlasCell("pylon").uv : atlasCell("pylonSide").uv;
    const fw = (node ? PYLON.width : PYLON.sideWidth) * h;
    panel(mb, CUT, [x, y + h / 2, z], [dx, 0, dz], fw, h, front, C_WHITE);
    panel(mb, CUT, [x, y + h / 2, z], [-dz, 0, dx], PYLON.sideWidth * h, h, atlasCell("pylonSide").uv, C_WHITE);
  }
  // Conductors: from each arm to the next tower's, sagging, and the earth wire over the peaks.
  for (const f of world.source.query("power", c.x0, c.z0, c.x1, c.z1)) {
    const n = f.pts.length / 2;
    const six = Number(f.tags.cables) >= 6;
    for (let i = 0; i + 1 < n; i++) {
      const ax = f.pts[i * 2];
      const az = f.pts[i * 2 + 1];
      const bx = f.pts[i * 2 + 2];
      const bz = f.pts[i * 2 + 3];
      if (!inCell(c, (ax + bx) / 2, (az + bz) / 2)) continue;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 20 || len > 700) continue;
      const na = m.powerNode(ax, az);
      const nb = m.powerNode(bx, bz);
      if (!na || !nb) continue;
      const tx = (bx - ax) / len;
      const tz = (bz - az) / len;
      /** A point where a wire hangs on a tower: arm `j` (3: the peak), side −1 or 1 across this span. */
      const hang = (node: PowerNode, j: number, side: number): V3 => {
        const y = ground(node.x, node.z) - 0.3;
        if (j === 3) return [node.x, y + node.h, node.z];
        // The tower's own across direction, on this span's side.
        let px = -node.dz;
        let pz = node.dx;
        if (px * -tz + pz * tx < 0) {
          px = -px;
          pz = -pz;
        }
        const arm = PYLON.arms[j];
        return [node.x + px * side * arm.half * node.h, y + (arm.y - 0.022) * node.h, node.z + pz * side * arm.half * node.h];
      };
      const wires: [number, number][] = six
        ? [
            [0, -1],
            [0, 1],
            [1, -1],
            [1, 1],
            [2, -1],
            [2, 1],
          ]
        : [
            [0, -1],
            [1, 1],
            [2, -1],
          ];
      wires.push([3, 0]);
      const SEG = 6;
      for (const [j, side] of wires) {
        const a = hang(na, j, side);
        const b = hang(nb, j, side);
        const sag = len * (j === 3 ? 0.018 : 0.028);
        let prev = a;
        for (let k = 1; k <= SEG; k++) {
          const u = k / SEG;
          const p: V3 = [lerp(a[0], b[0], u), lerp(a[1], b[1], u) - sag * 4 * u * (1 - u), lerp(a[2], b[2], u)];
          ridge(mb, STRUCT, prev, p, j === 3 ? 0.07 : 0.1, C_WIRE);
          prev = p;
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────── the generator

/** Bridges, rivers, the railway and power lines: what this generator puts in a cell. */
export function structures(c: CellContext): void {
  const name = c.layer.name;
  if (name !== "base" && name !== "detail") return;
  const m = model(c.world);
  bridges(c, m);
  railway(c, m);
  stations(c, m);
  if (name === "detail") {
    crossings(c, m);
    return;
  }
  rivers(c, m);
  roadWalls(c);
  culverts(c);
  power(c, m);
}

