import type { CellContext } from "../cell";
import { BAND, CELLS, LIT_ATLAS, LIT_CELLS, LIT_STRIPS, STORE_TILE, STRIPS, WALL_TILE, cellUV, stripV, type Cell, type Strip } from "../kit/buildings-layout";
import { faceNormal, normalize, type MeshBuilder, type V3 } from "../mesh";
import { Rand, clamp, hash2 } from "../noise";
import type { Feature } from "../source";
import type { Probe, RouteWorld } from "../world";
import { Cover } from "./terrain";

/**
 * Buildings from the surveyed footprints, as winter Hokkaido builds them:
 * houses with 無落雪 flat roofs under a slab of snow or steep metal roofs
 * that have shed theirs, glazed 風除室 at the door, kerosene tanks; farms
 * with D-type arch warehouses, gambrel barns, silos and pipe greenhouses;
 * roadside shops with lit fronts, petrol canopies, schools and flats as
 * long blocks.
 *
 * Almost every footprint is a bare `building=yes`: what it is comes from
 * its size and proportions, from how many buildings stand around it (a town
 * or a farmstead) and from the shop and amenity points next to it. Every
 * choice is seeded from the footprint's centroid, so a house is the same
 * house in every cell, layer and run.
 *
 * `base` gets the building; `detail` gets what only shows from the road
 * (window frames' returns, tanks, chimneys, flues), for buildings near the
 * driven line. Both layers run the same code with the same random sequence:
 * the `Sink` drops what is not for its layer.
 *
 * Dimensions are typical values, not surveyed (OSM carries almost no heights
 * here): storeys 2.7 m, snow on roofs 0.3–0.55 m, arches as wide as tall.
 */

type RGBA = readonly [number, number, number, number];
type UV = readonly [number, number];

const M = "building";
const ML = "building-lit";
const MS = "snow";
const WHITE: RGBA = [255, 255, 255, 255];
const UP: V3 = [0, 1, 0];

const rgb = (r: number, g: number, b: number): RGBA => [r, g, b, 255];
const shade = (c: RGBA, k: number): RGBA => [Math.round(clamp(c[0] * k, 0, 255)), Math.round(clamp(c[1] * k, 0, 255)), Math.round(clamp(c[2] * k, 0, 255)), 255];

/**
 * Siding colours (sRGB) from the research report's samples (REPORT.md §3,
 * colours.tsv: cream, beige, white, pale grey, ochre, grey-green,
 * wood-brown) and its estimates (charcoal, pale blue-grey, dark brown),
 * weighted as a street has them: mostly the pale ones.
 */
const PALE: RGBA[] = [rgb(194, 187, 177), rgb(218, 196, 171), rgb(217, 219, 212), rgb(183, 195, 189), rgb(206, 204, 196)];
const TINTED: RGBA[] = [rgb(169, 180, 188), rgb(154, 145, 111), rgb(148, 156, 146), rgb(200, 180, 160)];
const DARK: RGBA[] = [rgb(110, 65, 51), rgb(74, 59, 51), rgb(58, 61, 64), rgb(92, 78, 68)];
const siding = (rnd: Rand): RGBA => {
  const k = rnd.next();
  return rnd.pick(k < 0.6 ? PALE : k < 0.82 ? TINTED : DARK);
};
/**
 * Painted roof metal, from the report: maroon, brown, dark grey, slate blue,
 * red, teal, light blue (the aerial's hazy samples taken a step darker).
 */
const ROOFS: RGBA[] = [rgb(80, 54, 55), rgb(84, 72, 68), rgb(84, 86, 88), rgb(98, 118, 134), rgb(142, 82, 76), rgb(88, 128, 130), rgb(124, 160, 168)];
const roofing = (rnd: Rand): RGBA => {
  const k = rnd.next();
  return k < 0.24 ? ROOFS[0] : k < 0.46 ? ROOFS[1] : k < 0.62 ? ROOFS[2] : k < 0.76 ? ROOFS[3] : k < 0.88 ? ROOFS[4] : k < 0.95 ? ROOFS[5] : ROOFS[6];
};
/** Farm sheet metal. */
const FARM: RGBA[] = [rgb(176, 180, 184), rgb(156, 180, 198), rgb(206, 198, 172), rgb(122, 158, 138), rgb(128, 92, 72), rgb(200, 204, 206)];
/** Barn walls: white corrugated steel first (report, photo 29), then red, grey-blue, brown boards. */
const BARN: RGBA[] = [rgb(214, 216, 214), rgb(222, 220, 212), rgb(140, 62, 52), rgb(120, 136, 150), rgb(142, 96, 70)];
/** The dark fascia band of flat roofs (#434343 in photo 16). */
const TRIM = rgb(67, 67, 67);
const CONCRETE = rgb(196, 194, 188);
/** Stripe sets of a lit fascia: band, upper stripe, lower stripe. */
const FASCIAS: [RGBA, RGBA, RGBA][] = [
  [rgb(250, 250, 246), rgb(236, 120, 40), rgb(36, 130, 76)],
  [rgb(250, 250, 246), rgb(40, 110, 190), rgb(40, 110, 190)],
  [rgb(60, 150, 96), rgb(250, 250, 246), rgb(40, 100, 180)],
  [rgb(250, 250, 246), rgb(226, 60, 50), rgb(240, 170, 40)],
];
const SIGN_BANDS: RGBA[] = [rgb(196, 52, 44), rgb(40, 90, 160), rgb(44, 120, 78), rgb(232, 140, 40), rgb(60, 62, 68)];

const STOREY = 2.7;
/** Roof segments shallower than this hold their snow (rise over run). */
const HOLDS = 0.5;

/** A local frame on the ground: `u` along an axis, `v` to its left-hand side. */
class Frame {
  readonly vx: number;
  readonly vz: number;
  constructor(
    readonly cx: number,
    readonly cz: number,
    readonly ux: number,
    readonly uz: number,
  ) {
    this.vx = -uz;
    this.vz = ux;
  }
  p(u: number, v: number, y: number): V3 {
    return [this.cx + u * this.ux + v * this.vx, y, this.cz + u * this.uz + v * this.vz];
  }
  dir(u: number, v: number): V3 {
    return [u * this.ux + v * this.vx, 0, u * this.uz + v * this.vz];
  }
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/** Where triangles go: the cell's builder, for the layer being built. */
class Sink {
  private on: boolean;
  constructor(
    private mb: MeshBuilder,
    readonly detail: boolean,
    private ox: number,
    private oz: number,
  ) {
    this.on = !detail;
  }
  /** What follows belongs to the base layer. */
  base(): void {
    this.on = !this.detail;
  }
  /** What follows belongs to the detail layer. */
  fine(): void {
    this.on = this.detail;
  }
  get active(): boolean {
    return this.on;
  }

  /** Snow UVs: 4 m per repeat over the ground, slanted so upright faces do not smear. */
  suv(p: V3): UV {
    return [(p[0] - this.ox + p[1] * 0.6) / 4, (p[2] - this.oz + p[1] * 0.6) / 4];
  }

  /** A quad a→b→c→d facing `out`, with a UV per corner. */
  quadT(mat: string, a: V3, b: V3, c: V3, d: V3, ta: UV, tb: UV, tc: UV, td: UV, col: RGBA, out: V3): void {
    if (!this.on) return;
    let n = faceNormal(a, b, c);
    const flip = dot(n, out) < 0;
    if (flip) n = [-n[0], -n[1], -n[2]];
    const mb = this.mb;
    const i = mb.vertex(mat, a, n, ta[0], ta[1], col);
    mb.vertex(mat, b, n, tb[0], tb[1], col);
    mb.vertex(mat, c, n, tc[0], tc[1], col);
    mb.vertex(mat, d, n, td[0], td[1], col);
    if (flip) {
      mb.tri(mat, i, i + 2, i + 1);
      mb.tri(mat, i, i + 3, i + 2);
    } else {
      mb.tri(mat, i, i + 1, i + 2);
      mb.tri(mat, i, i + 2, i + 3);
    }
  }

  /** A quad with a UV rectangle: a, b along the bottom (u0 → u1), c, d along the top. */
  quad(mat: string, a: V3, b: V3, c: V3, d: V3, uv: readonly [number, number, number, number], col: RGBA, out: V3): void {
    this.quadT(mat, a, b, c, d, [uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]], col, out);
  }

  tri(mat: string, a: V3, b: V3, c: V3, ta: UV, tb: UV, tc: UV, col: RGBA, out: V3): void {
    if (!this.on) return;
    let n = faceNormal(a, b, c);
    const flip = dot(n, out) < 0;
    if (flip) n = [-n[0], -n[1], -n[2]];
    const mb = this.mb;
    const i = mb.vertex(mat, a, n, ta[0], ta[1], col);
    mb.vertex(mat, b, n, tb[0], tb[1], col);
    mb.vertex(mat, c, n, tc[0], tc[1], col);
    if (flip) mb.tri(mat, i, i + 2, i + 1);
    else mb.tri(mat, i, i + 1, i + 2);
  }

  snowQuad(a: V3, b: V3, c: V3, d: V3, out: V3): void {
    this.quadT(MS, a, b, c, d, this.suv(a), this.suv(b), this.suv(c), this.suv(d), WHITE, out);
  }

  snowTri(a: V3, b: V3, c: V3, out: V3): void {
    this.tri(MS, a, b, c, this.suv(a), this.suv(b), this.suv(c), WHITE, out);
  }

  /**
   * A grid of rows with a normal and a UV per vertex (smooth surfaces:
   * snow slabs, cylinders, arches). The winding comes from the normals.
   */
  grid(mat: string, rows: V3[][], normals: V3[][], uv: (r: number, k: number) => UV, col: RGBA): void {
    if (!this.on) return;
    const mb = this.mb;
    const n = rows[0].length;
    let flip = false;
    search: for (let r = 0; r + 1 < rows.length; r++)
      for (let k = 0; k + 1 < n; k++) {
        const fn = faceNormal(rows[r][k], rows[r][k + 1], rows[r + 1][k + 1]);
        const d = dot(fn, normals[r][k]) + dot(fn, normals[r][k + 1]) + dot(fn, normals[r + 1][k + 1]);
        if (Math.abs(d) > 0.3) {
          flip = d < 0;
          break search;
        }
      }
    const first = mb.count(mat);
    for (let r = 0; r < rows.length; r++)
      for (let k = 0; k < n; k++) {
        const t = uv(r, k);
        mb.vertex(mat, rows[r][k], normals[r][k], t[0], t[1], col);
      }
    for (let r = 0; r + 1 < rows.length; r++)
      for (let k = 0; k + 1 < n; k++) {
        const a = first + r * n + k;
        const b = a + 1;
        const c = a + n + 1;
        const d = a + n;
        if (flip) {
          mb.tri(mat, a, c, b);
          mb.tri(mat, a, d, c);
        } else {
          mb.tri(mat, a, b, c);
          mb.tri(mat, a, c, d);
        }
      }
  }

  /**
   * The surface between two copies of a cross-section (`A` at one end, `B`
   * at the other), facing `hint` where it faces it most; smooth across the
   * section or one flat face per segment.
   */
  ribbon(mat: string, A: V3[], B: V3[], tA: UV[], tB: UV[], col: RGBA, hint: V3, smooth: boolean): void {
    if (!this.on) return;
    const m = A.length;
    const seg: V3[] = [];
    let best = 0;
    let sign = 1;
    for (let i = 0; i + 1 < m; i++) {
      const n = faceNormal(A[i], B[i], A[i + 1]);
      seg.push(n);
      const d = dot(n, hint);
      if (Math.abs(d) > best) {
        best = Math.abs(d);
        sign = d < 0 ? -1 : 1;
      }
    }
    if (!smooth) {
      for (let i = 0; i + 1 < m; i++) {
        const o: V3 = [seg[i][0] * sign, seg[i][1] * sign, seg[i][2] * sign];
        this.quadT(mat, A[i], B[i], B[i + 1], A[i + 1], tA[i], tB[i], tB[i + 1], tA[i + 1], col, o);
      }
      return;
    }
    const nrm: V3[] = [];
    for (let i = 0; i < m; i++) {
      const a = seg[Math.max(0, i - 1)];
      const b = seg[Math.min(m - 2, i)];
      nrm.push(normalize([(a[0] + b[0]) * sign, (a[1] + b[1]) * sign, (a[2] + b[2]) * sign]));
    }
    this.grid(mat, [A, B], [nrm, nrm], (r, k) => (r ? tB[k] : tA[k]), col);
  }
}

// ------------------------------------------------------------------ footprint

/** A rectangle of a footprint: its own frame with `u` along its longer side, half length and half width. */
interface Part {
  fr: Frame;
  hl: number;
  hw: number;
}

interface Fit {
  /** Centroid of the ring (the anchor). */
  cx: number;
  cz: number;
  /** Polygon area (m²) and its bounding rectangle in the fitted frame: length ≥ width. */
  area: number;
  length: number;
  width: number;
  parts: Part[];
}

interface Slab {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** Cuts a polygon (local coordinates) into slabs across `u`, merging neighbours whose sides agree within `tol`. */
function slabs(lu: Float64Array, lv: Float64Array, n: number, tol: number): Slab[] {
  const cuts: number[] = [];
  for (const u of Array.from(lu.subarray(0, n)).sort((a, b) => a - b)) if (!cuts.length || u - cuts[cuts.length - 1] > tol) cuts.push(u);
  const out: Slab[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const m = (a + b) / 2;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      if ((lu[j] - m) * (lu[k] - m) >= 0) continue;
      const v = lv[j] + ((lv[k] - lv[j]) * (m - lu[j])) / (lu[k] - lu[j]);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (!(hi - lo > 1)) continue;
    const last = out[out.length - 1];
    if (last && last.u1 === a && Math.abs(last.v0 - lo) < tol && Math.abs(last.v1 - hi) < tol) {
      const wa = last.u1 - last.u0;
      const wb = b - a;
      last.v0 = (last.v0 * wa + lo * wb) / (wa + wb);
      last.v1 = (last.v1 * wa + hi * wb) / (wa + wb);
      last.u1 = b;
    } else out.push({ u0: a, u1: b, v0: lo, v1: hi });
  }
  return out;
}

/** The oriented rectangle of a footprint, or two to four of them for an L, T or U. */
function fit(f: Feature): Fit {
  const pts = f.pts;
  const n = pts.length / 2 - 1;
  let cx = 0;
  let cz = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i * 2];
    cz += pts[i * 2 + 1];
    const dx = pts[i * 2 + 2] - pts[i * 2];
    const dz = pts[i * 2 + 3] - pts[i * 2 + 1];
    const len = Math.hypot(dx, dz);
    const a = Math.atan2(dz, dx) * 4;
    // Right-angled plans: every wall votes for the same direction modulo 90°.
    sx += len * Math.cos(a);
    sy += len * Math.sin(a);
  }
  cx /= n;
  cz /= n;
  let ang = Math.atan2(sy, sx) / 4;
  const lu = new Float64Array(n);
  const lv = new Float64Array(n);
  let b = [0, 0, 0, 0];
  const project = () => {
    const ux = Math.cos(ang);
    const uz = Math.sin(ang);
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const dx = pts[i * 2] - cx;
      const dz = pts[i * 2 + 1] - cz;
      lu[i] = dx * ux + dz * uz;
      lv[i] = -dx * uz + dz * ux;
      b[0] = Math.min(b[0], lu[i]);
      b[1] = Math.min(b[1], lv[i]);
      b[2] = Math.max(b[2], lu[i]);
      b[3] = Math.max(b[3], lv[i]);
    }
  };
  project();
  if (b[3] - b[1] > b[2] - b[0]) {
    ang += Math.PI / 2;
    project();
  }
  let area = 0;
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    area += lu[i] * lv[k] - lu[k] * lv[i];
  }
  area = Math.abs(area) / 2;
  const length = b[2] - b[0];
  const width = b[3] - b[1];
  const fr = new Frame(cx, cz, Math.cos(ang), Math.sin(ang));
  const fill = area / (length * width || 1);
  let list: Slab[] = [];
  if (n > 4 && fill < 0.86) {
    const most = area > 600 ? 4 : 3;
    for (const tol of [0.9, 1.8, 3.5, 7]) {
      list = slabs(lu, lv, n, tol).filter((s) => s.u1 - s.u0 > 1.5);
      if (list.length && list.length <= most) break;
      list = [];
    }
  }
  if (!list.length) {
    // One rectangle of the polygon's area on the bounding rectangle's centre and proportions.
    const k = Math.sqrt(Math.min(1, fill / 0.96));
    const mu = (b[0] + b[2]) / 2;
    const mv = (b[1] + b[3]) / 2;
    list = [{ u0: mu - (length * k) / 2, u1: mu + (length * k) / 2, v0: mv - (width * k) / 2, v1: mv + (width * k) / 2 }];
  }
  const parts = list.map((s): Part => {
    const c = fr.p((s.u0 + s.u1) / 2, (s.v0 + s.v1) / 2, 0);
    const du = (s.u1 - s.u0) / 2;
    const dv = (s.v1 - s.v0) / 2;
    return du >= dv ? { fr: new Frame(c[0], c[2], fr.ux, fr.uz), hl: du, hw: dv } : { fr: new Frame(c[0], c[2], fr.vx, fr.vz), hl: dv, hw: du };
  });
  // The largest part first: it carries the entrance and sets the roof.
  parts.sort((p, q) => q.hl * q.hw - p.hl * p.hw);
  return { cx, cz, area, length, width, parts };
}

// ------------------------------------------------------------------ walls

/** A wall seen from outside: `t` runs left to right along it. */
interface Wall {
  mx: number;
  mz: number;
  n: V3;
  rx: number;
  rz: number;
  len: number;
  /** A gable end (across the ridge) rather than an eave side. */
  end: boolean;
  /** Which end or side of the part: +1 or −1 along `u` (ends) or `v` (sides). */
  sign: number;
  /** Hidden inside another part of the same building. */
  inner: boolean;
}

function wallOf(mid: V3, n: V3, len: number, end: boolean, sign: number): Wall {
  return { mx: mid[0], mz: mid[2], n, rx: n[2], rz: -n[0], len, end, sign, inner: false };
}

function wallsOf(p: Part): Wall[] {
  const { fr, hl, hw } = p;
  return [wallOf(fr.p(0, hw, 0), fr.dir(0, 1), 2 * hl, false, 1), wallOf(fr.p(0, -hw, 0), fr.dir(0, -1), 2 * hl, false, -1), wallOf(fr.p(hl, 0, 0), fr.dir(1, 0), 2 * hw, true, 1), wallOf(fr.p(-hl, 0, 0), fr.dir(-1, 0), 2 * hw, true, -1)];
}

/** A point of a wall: `t` along it, height `y`, `proud` metres out of its face. */
function wp(w: Wall, t: number, y: number, proud = 0): V3 {
  const k = t - w.len / 2;
  return [w.mx + w.rx * k + w.n[0] * proud, y, w.mz + w.rz * k + w.n[2] * proud];
}

function inside(p: Part, x: number, z: number, pad = 0): boolean {
  const dx = x - p.fr.cx;
  const dz = z - p.fr.cz;
  return Math.abs(dx * p.fr.ux + dz * p.fr.uz) < p.hl + pad && Math.abs(dx * p.fr.vx + dz * p.fr.vz) < p.hw + pad;
}

/** A wall face from `yb` to `yt` in bands of the strip's height; `col(i)` tints band i. */
function wallFace(s: Sink, w: Wall, yb: number, yt: number, strip: Strip, col: (band: number) => RGBA, u0: number, t0 = 0, t1 = w.len): void {
  const [vb, vt] = stripV(strip);
  const ua = u0 + t0 / WALL_TILE;
  const ub = u0 + t1 / WALL_TILE;
  const step = strip.metres || yt - yb;
  let band = 0;
  for (let y = yb; y < yt - 0.05; y += step, band++) {
    const top = Math.min(yt, y + step);
    // The last sliver joins the band under it rather than making a thin one.
    const end = yt - top < 0.5 ? yt : top;
    const v1 = strip.metres ? vb + (vt - vb) * Math.min(1, (end - y) / step) : vt;
    s.quad(M, wp(w, t0, y), wp(w, t1, y), wp(w, t1, end), wp(w, t0, end), [ua, vb, ub, v1], col(band), w.n);
    if (end === yt) break;
  }
}

/** A cell of the atlas on a wall: centre `t`, bottom `y`, as wide and tall as given, `proud` of the face. */
function panel(s: Sink, w: Wall, mat: string, uv: readonly [number, number, number, number], t: number, y: number, width: number, height: number, proud: number, col: RGBA = WHITE): void {
  s.quad(mat, wp(w, t - width / 2, y, proud), wp(w, t + width / 2, y, proud), wp(w, t + width / 2, y + height, proud), wp(w, t - width / 2, y + height, proud), uv, col, w.n);
}

const PLAIN_UV = (() => {
  const [vb, vt] = stripV(STRIPS.plain);
  return [0.01, vb + 0.004, 0.06, vt - 0.004] as const;
})();

/** The returns of a frame standing `proud` of a wall (what gives a window its depth from the road). */
function returns(s: Sink, w: Wall, t: number, y: number, width: number, height: number, proud: number, col: RGBA): void {
  const a = t - width / 2;
  const b = t + width / 2;
  const left: V3 = [-w.rx, 0, -w.rz];
  const right: V3 = [w.rx, 0, w.rz];
  s.quad(M, wp(w, a, y), wp(w, a, y, proud), wp(w, a, y + height, proud), wp(w, a, y + height), PLAIN_UV, col, left);
  s.quad(M, wp(w, b, y), wp(w, b, y, proud), wp(w, b, y + height, proud), wp(w, b, y + height), PLAIN_UV, col, right);
  s.quad(M, wp(w, a, y), wp(w, b, y), wp(w, b, y, proud), wp(w, a, y, proud), PLAIN_UV, shade(col, 0.8), [0, -1, 0]);
}

// ------------------------------------------------------------------ roofs

/** A roof's cross-section over the wall top: (s across the span, h above the wall top), from −hw to +hw. */
type Profile = [number, number][];

function profileOf(kind: "flat" | "shed" | "gable" | "gambrel" | "arch", hw: number, rise: number): Profile {
  switch (kind) {
    case "flat":
      return [
        [-hw, 0],
        [hw, 0],
      ];
    case "shed":
      return [
        [-hw, 0],
        [hw, rise],
      ];
    case "gable":
      return [
        [-hw, 0],
        [0, rise],
        [hw, 0],
      ];
    case "gambrel":
      return [
        [-hw, 0],
        [-0.58 * hw, 0.72 * rise],
        [0, rise],
        [0.58 * hw, 0.72 * rise],
        [hw, 0],
      ];
    case "arch": {
      const out: Profile = [];
      const n = 10;
      for (let k = 0; k <= n; k++) {
        const a = (Math.PI * k) / n;
        out.push([-hw * Math.cos(a), rise * Math.sin(a)]);
      }
      return out;
    }
  }
}

/** The profile carried out past the walls by the eave overhang. */
function overhung(prof: Profile, ov: number): Profile {
  if (ov <= 0) return prof;
  const out = prof.map((p) => [p[0], p[1]] as [number, number]);
  const n = out.length;
  const ext = (a: [number, number], b: [number, number]): [number, number] => {
    const k = ov / Math.abs(a[0] - b[0] || 1);
    return [a[0] + (a[0] - b[0]) * k, a[1] + (a[1] - b[1]) * k];
  };
  out[0] = ext(prof[0], prof[1]);
  out[n - 1] = ext(prof[n - 1], prof[n - 2]);
  return out;
}

/** The end wall above the wall top, under the roof's profile. */
function gableEnd(s: Sink, p: Part, sign: number, yTop: number, prof: Profile, strip: Strip, col: RGBA, u0: number): void {
  const poly: Profile = [];
  if (prof[0][1] > 0.01) poly.push([prof[0][0], 0]);
  poly.push(...prof);
  if (prof[prof.length - 1][1] > 0.01) poly.push([prof[prof.length - 1][0], 0]);
  if (poly.length < 3) return;
  let rise = 0;
  for (const q of poly) rise = Math.max(rise, q[1]);
  if (rise < 0.05) return;
  const [vb, vt] = stripV(strip);
  const span = Math.max(strip.metres || rise, rise);
  const at = (q: [number, number]): V3 => p.fr.p(sign * p.hl, q[0], yTop + q[1]);
  const uv = (q: [number, number]): UV => [u0 + (q[0] + p.hw) / WALL_TILE, vb + ((vt - vb) * q[1]) / span];
  const out = p.fr.dir(sign, 0);
  for (let i = 1; i + 1 < poly.length; i++) {
    if (Math.abs(poly[i][1] - poly[i + 1][1]) < 1e-6 && poly[i][1] < 0.01 && poly[0][1] < 0.01) continue;
    s.tri(M, at(poly[0]), at(poly[i]), at(poly[i + 1]), uv(poly[0]), uv(poly[i]), uv(poly[i + 1]), col, out);
  }
}

/** The roof's metal: the top surface, the fascias at the eaves and verges, the soffits under the eaves. */
function roofSkin(s: Sink, p: Part, yTop: number, prof: Profile, ovEave: number, ovGable: number, strip: Strip, col: RGBA): Profile {
  const ext = overhung(prof, ovEave);
  const l = p.hl + ovGable;
  const [vb, vt] = stripV(strip);
  const lift = 0.02;
  const A = ext.map((q) => p.fr.p(-l, q[0], yTop + q[1] + lift));
  const B = ext.map((q) => p.fr.p(l, q[0], yTop + q[1] + lift));
  const tA: UV[] = [];
  const tB: UV[] = [];
  for (let i = 0; i < ext.length; i++) {
    const v = i & 1 ? vt - 0.003 : vb + 0.003;
    tA.push([0, v]);
    tB.push([(2 * l) / WALL_TILE, v]);
  }
  const smooth = ext.length > 5;
  s.ribbon(M, A, B, tA, tB, col, UP, smooth);
  if (smooth) return ext;
  const th = 0.16;
  const dark = shade(col, 0.82);
  const down = (q: V3): V3 => [q[0], q[1] - th, q[2]];
  // Eave fascias and soffits.
  const n = ext.length;
  for (const [i, sgn] of [
    [0, -1],
    [n - 1, 1],
  ] as const) {
    const out = p.fr.dir(0, sgn);
    s.quad(M, down(A[i]), down(B[i]), B[i], A[i], PLAIN_UV, dark, out);
    if (ovEave >= 0.2) {
      const wa = p.fr.p(-l, sgn * p.hw, A[i][1] - th);
      const wb = p.fr.p(l, sgn * p.hw, A[i][1] - th);
      s.quad(M, down(A[i]), down(B[i]), wb, wa, PLAIN_UV, shade(col, 0.6), [0, -1, 0]);
    }
  }
  // Verge fascias.
  for (const [E, sgn] of [
    [A, -1],
    [B, 1],
  ] as const) {
    const out = p.fr.dir(sgn, 0);
    for (let i = 0; i + 1 < n; i++) s.quad(M, down(E[i]), down(E[i + 1]), E[i + 1], E[i], PLAIN_UV, dark, out);
  }
  return ext;
}

/**
 * Snow lying on every run of the profile shallow enough to hold it: a slab
 * `depth` thick, lipped over the eaves, thinning to nothing where the roof
 * steepens; closed at both ends.
 */
function roofSnow(s: Sink, p: Part, yTop: number, ext: Profile, ovGable: number, depth: number, holds = HOLDS): void {
  const n = ext.length;
  const l = p.hl + ovGable + 0.06;
  let i = 0;
  while (i + 1 < n) {
    const slope = (k: number) => Math.abs((ext[k + 1][1] - ext[k][1]) / (ext[k + 1][0] - ext[k][0] || 1e-6));
    if (slope(i) >= holds) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && slope(j) < holds) j++;
    // Points i..j of the profile carry snow.
    const lower: [number, number][] = [];
    const upper: [number, number][] = [];
    for (let k = i; k <= j; k++) {
      const edge = k === i || k === j;
      const eave = (k === 0 && i === 0) || (k === n - 1 && j === n - 1);
      const d = edge && !eave ? 0 : depth;
      const out = eave ? (k === 0 ? -0.1 : 0.1) : 0;
      lower.push([ext[k][0] + out, ext[k][1] + 0.03]);
      upper.push([ext[k][0] + out * 0.3, ext[k][1] + 0.03 + d]);
    }
    const line: [number, number][] = [];
    if (i === 0) line.push(lower[0]);
    line.push(...upper);
    if (j === n - 1) line.push(lower[lower.length - 1]);
    const A = line.map((q) => p.fr.p(-l, q[0], yTop + q[1]));
    const B = line.map((q) => p.fr.p(l, q[0], yTop + q[1]));
    s.ribbon(
      MS,
      A,
      B,
      A.map((q) => s.suv(q)),
      B.map((q) => s.suv(q)),
      WHITE,
      UP,
      true,
    );
    for (const sgn of [-1, 1]) {
      const out = p.fr.dir(sgn, 0);
      const at = (q: [number, number]): V3 => p.fr.p(sgn * l, q[0], yTop + q[1]);
      for (let k = 0; k + 1 < lower.length; k++) {
        const thinA = upper[k][1] - lower[k][1] < 0.01;
        const thinB = upper[k + 1][1] - lower[k + 1][1] < 0.01;
        if (thinA && thinB) continue;
        if (thinA) s.snowTri(at(lower[k]), at(lower[k + 1]), at(upper[k + 1]), out);
        else if (thinB) s.snowTri(at(lower[k]), at(lower[k + 1]), at(upper[k]), out);
        else s.snowQuad(at(lower[k]), at(lower[k + 1]), at(upper[k + 1]), at(upper[k]), out);
      }
    }
    i = j;
  }
}

/** Snow left on a roof too steep to hold it: a few patches by the ridge and the eaves. */
function roofPatches(s: Sink, p: Part, yTop: number, ext: Profile, rnd: Rand): void {
  for (let i = 0; i + 1 < ext.length; i++) {
    const a = ext[i];
    const b = ext[i + 1];
    const run = b[0] - a[0];
    const rise = b[1] - a[1];
    const sl = Math.abs(rise / (run || 1e-6));
    if (sl < HOLDS || sl > 1.9) continue;
    const len = Math.hypot(run, rise);
    const nrm = normalize(add(p.fr.dir(0, -rise / len), UP, run / len));
    const up: V3 = nrm[1] < 0 ? [-nrm[0], -nrm[1], -nrm[2]] : nrm;
    const count = 1 + Math.floor(rnd.next() * 2);
    for (let k = 0; k < count; k++) {
      // Along the ridge line and across the slope, as fractions.
      const l0 = rnd.range(-0.95, 0.4) * p.hl;
      const l1 = Math.min(p.hl * 0.97, l0 + rnd.range(0.25, 0.9) * p.hl);
      const high = b[1] > a[1];
      const atRidge = rnd.next() < 0.6;
      const w = rnd.range(0.18, 0.4);
      // Fractions from a to b.
      let f0 = atRidge === high ? 1 - w : 0.03;
      let f1 = atRidge === high ? 0.985 : w;
      if (f0 > f1) [f0, f1] = [f1, f0];
      const at = (l: number, f: number): V3 => add(p.fr.p(l, a[0] + run * f, yTop + a[1] + rise * f + 0.02), up, 0.05);
      s.snowQuad(at(l0, f0), at(l1, f0), at(l1, f1), at(l0, f1), up);
    }
  }
}

/** A slab of snow on a level rectangle: upright sides, rounded shoulders, a flat top. */
function snowSlab(s: Sink, fr: Frame, hl: number, hw: number, y: number, depth: number, outset: number): void {
  const ring = (o: number, h: number): V3[] => {
    const a = hl + o;
    const b = hw + o;
    return [fr.p(-a, -b, y + h), fr.p(a, -b, y + h), fr.p(a, b, y + h), fr.p(-a, b, y + h), fr.p(-a, -b, y + h)];
  };
  const diag = (k: number, up: number): V3[] => {
    const d = [fr.dir(-1, -1), fr.dir(1, -1), fr.dir(1, 1), fr.dir(-1, 1), fr.dir(-1, -1)];
    return d.map((q) => normalize([q[0] * k, up, q[2] * k]));
  };
  const inset = Math.min(0.24, hw * 0.3);
  const rows = [ring(outset, 0), ring(outset + 0.05, depth * 0.6), ring(outset - inset, depth)];
  s.grid(MS, rows, [diag(1, 0.05), diag(0.7, 0.6), diag(0.2, 1)], (r, k) => s.suv(rows[r][k]), WHITE);
  const t = rows[2];
  s.snowQuad(t[0], t[1], t[2], t[3], UP);
}

// ------------------------------------------------------------------ snow on the ground

interface Site {
  world: RouteWorld;
  probe: Probe;
}

const newProbe = (): Probe => ({ e: 0, road: null, s: 0, d: 0, w: 0, y: 0, zone: 0, zoneRoad: null, zoneS: 0, zoneD: 0 });

/** Ground height, or NaN on a ploughed road. */
function ground(site: Site, x: number, z: number): number {
  site.world.probe(x, z, site.probe);
  if (site.probe.e < 0.6) return NaN;
  return site.world.base(x, z, site.probe);
}

/**
 * Snow heaped along a wall (slid off the roof, or drifted against it):
 * `h` high against the wall, a crest a third of the way out, spent `reach`
 * out; its ends run down to the ground.
 */
function mound(s: Sink, site: Site, w: Wall, t0: number, t1: number, h: number, reach: number): void {
  const mid = wp(w, (t0 + t1) / 2, 0, reach);
  if (Number.isNaN(ground(site, mid[0], mid[2]))) return;
  const g = (t: number, out: number): V3 => {
    const q = wp(w, t, 0, out);
    const y = ground(site, q[0], q[2]);
    return [q[0], (Number.isNaN(y) ? site.world.base(q[0], q[2]) : y) - 0.12, q[2]];
  };
  const len = t1 - t0;
  const e0 = g(t0, 0.3);
  const e1 = g(t1, 0.3);
  const ta = t0 + len * 0.16;
  const tb = t1 - len * 0.16;
  const fa = g(t0 + len * 0.06, reach);
  const fb = g(t1 - len * 0.06, reach);
  const yw = (fa[1] + fb[1]) / 2 + 0.12;
  const wa = wp(w, ta, yw + h * 0.8, -0.02);
  const wb = wp(w, tb, yw + h * 0.8, -0.02);
  const ca = wp(w, ta, yw + h, reach * 0.33);
  const cb = wp(w, tb, yw + h, reach * 0.33);
  const out: V3 = [w.n[0] * 0.6, 0.8, w.n[2] * 0.6];
  s.snowQuad(wa, ca, cb, wb, UP);
  s.snowQuad(ca, fa, fb, cb, out);
  const left: V3 = [-w.rx * 0.6, 0.8, -w.rz * 0.6];
  const right: V3 = [w.rx * 0.6, 0.8, w.rz * 0.6];
  s.snowTri(e0, fa, ca, left);
  s.snowTri(e0, ca, wa, left);
  s.snowTri(e1, cb, fb, right);
  s.snowTri(e1, wb, cb, right);
}

/** A shovelled heap: a low cone. */
function heap(s: Sink, site: Site, x: number, z: number, r: number, h: number, turn: number): void {
  const y = ground(site, x, z);
  if (Number.isNaN(y)) return;
  const n = 5;
  const ring: V3[] = [];
  const nrm: V3[] = [];
  const top: V3[] = [];
  const topN: V3[] = [];
  for (let k = 0; k <= n; k++) {
    const a = turn + (k / n) * Math.PI * 2;
    const c = Math.cos(a);
    const d = Math.sin(a);
    ring.push([x + c * r, y - 0.15, z + d * r]);
    nrm.push(normalize([c, 0.9, d]));
    top.push([x + c * r * 0.12, y + h, z + d * r * 0.12]);
    topN.push(normalize([c * 0.3, 1, d * 0.3]));
  }
  const rows = [ring, top];
  s.grid(MS, rows, [nrm, topN], (rr, k) => s.suv(rows[rr][k]), WHITE);
}

// ------------------------------------------------------------------ parts of buildings

interface WindowStyle {
  /** The usual window of the building. */
  main: "winSlide" | "winWhite";
  /** Share of windows lit from inside. */
  lit: number;
  /** Emit frame returns in the detail layer (on the walls that `toward` can see). */
  near: boolean;
  toward: [number, number];
  /** Share of slots left blank. */
  blank: number;
}

const LIT_OF: Record<string, Cell> = { winSlide: LIT_CELLS.winSlide, winWhite: LIT_CELLS.winSlide, winTall: LIT_CELLS.winTall, winSmall: LIT_CELLS.winSmall, winWide: LIT_CELLS.winWide };

/** One window: the pane (lit or dark) in `base`, its frame's returns in `detail`. */
function windowAt(s: Sink, w: Wall, name: "winSlide" | "winWhite" | "winTall" | "winSmall" | "winWide", t: number, y: number, lit: boolean, near: boolean): void {
  const c = CELLS[name];
  const proud = 0.06;
  if (lit) panel(s, w, ML, cellUV(LIT_OF[name], LIT_ATLAS), t, y, c.mw, c.mh, proud);
  else panel(s, w, M, cellUV(c), t, y, c.mw, c.mh, proud);
  if (near) {
    s.fine();
    returns(s, w, t, y, c.mw, c.mh, proud, name === "winWhite" ? rgb(210, 212, 212) : TRIM);
    s.base();
  }
}

/** Whether a wall's window frames get their returns: near the driven road and not turned away from it. */
const seen = (style: WindowStyle, w: Wall): boolean => style.near && w.n[0] * style.toward[0] + w.n[2] * style.toward[1] > -0.3;

/** Windows along a wall, storey by storey, clear of `blocked` spans on the ground floor. */
function windowRow(s: Sink, w: Wall, floor: number, storeys: number, rnd: Rand, style: WindowStyle, blocked: [number, number][] = []): void {
  const slots = Math.floor((w.len - 0.9) / 2.6);
  for (let st = 0; st < storeys; st++) {
    for (let i = 0; i < slots; i++) {
      const t = ((i + 0.5) * w.len) / slots + rnd.range(-0.25, 0.25);
      const pick = rnd.next();
      const lit = rnd.next() < style.lit;
      if (rnd.next() < style.blank) continue;
      let name: "winSlide" | "winWhite" | "winTall" | "winSmall" | "winWide" = style.main;
      let sill = 0.95;
      if (pick < 0.16) name = "winTall";
      else if (pick < 0.28) {
        name = "winSmall";
        sill = 1.5;
      } else if (pick < 0.42 && st === 0 && w.len / slots >= 3) {
        name = "winWide";
        sill = 0.7;
      }
      const half = CELLS[name].mw / 2 + 0.2;
      if (t - half < 0.15 || t + half > w.len - 0.15) continue;
      if (st === 0 && blocked.some(([a, b]) => t + half > a && t - half < b)) continue;
      windowAt(s, w, name, t, floor + st * STOREY + sill, lit, seen(style, w));
    }
  }
}

/** A 風除室: a glazed aluminium porch over the front door, snow on its roof. */
function porch(s: Sink, w: Wall, t: number, y: number): void {
  const wd = 1.6;
  const dp = 1.2;
  const h = 2.3;
  const uv = cellUV(CELLS.porch);
  const a = t - wd / 2;
  const b = t + wd / 2;
  // Front: two panels (the outer door is one of them).
  s.quad(M, wp(w, a, y, dp), wp(w, t, y, dp), wp(w, t, y + h, dp), wp(w, a, y + h, dp), uv, WHITE, w.n);
  s.quad(M, wp(w, t, y, dp), wp(w, b, y, dp), wp(w, b, y + h, dp), wp(w, t, y + h, dp), uv, WHITE, w.n);
  s.quad(M, wp(w, a, y), wp(w, a, y, dp), wp(w, a, y + h, dp), wp(w, a, y + h), uv, WHITE, [-w.rx, 0, -w.rz]);
  s.quad(M, wp(w, b, y, dp), wp(w, b, y), wp(w, b, y + h), wp(w, b, y + h, dp), uv, WHITE, [w.rx, 0, w.rz]);
  // Snow on its flat roof.
  const d = 0.32;
  const o = 0.06;
  const p = (tt: number, yy: number, out: number): V3 => wp(w, tt, yy, out);
  s.snowQuad(p(a - o, y + h + d, 0), p(b + o, y + h + d, 0), p(b + o, y + h + d, dp + o), p(a - o, y + h + d, dp + o), UP);
  s.snowQuad(p(a - o, y + h, dp + o), p(b + o, y + h, dp + o), p(b + o, y + h + d, dp + o), p(a - o, y + h + d, dp + o), w.n);
  s.snowQuad(p(a - o, y + h, 0), p(a - o, y + h, dp + o), p(a - o, y + h + d, dp + o), p(a - o, y + h + d, 0), [-w.rx, 0, -w.rz]);
  s.snowQuad(p(b + o, y + h, dp + o), p(b + o, y + h, 0), p(b + o, y + h + d, 0), p(b + o, y + h + d, dp + o), [w.rx, 0, w.rz]);
}

/** A box standing on a wall's face or free of it, in the `plain` or another strip. */
function boxAt(s: Sink, fr: Frame, u: number, v: number, hu: number, hv: number, y0: number, y1: number, strip: Strip, col: RGBA, top = true, mat = M): void {
  const [vb, vt] = stripV(strip);
  const uv = [0.02, vb + 0.004, 0.02 + Math.max(hu, hv) / WALL_TILE, vt - 0.004] as const;
  const c = [fr.p(u - hu, v - hv, 0), fr.p(u + hu, v - hv, 0), fr.p(u + hu, v + hv, 0), fr.p(u - hu, v + hv, 0)];
  const outs = [fr.dir(0, -1), fr.dir(1, 0), fr.dir(0, 1), fr.dir(-1, 0)];
  const at = (q: V3, y: number): V3 => [q[0], y, q[2]];
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    s.quad(mat, at(c[k], y0), at(c[j], y0), at(c[j], y1), at(c[k], y1), uv, col, outs[k]);
  }
  if (top) s.quad(mat, at(c[0], y1), at(c[1], y1), at(c[2], y1), at(c[3], y1), uv, col, UP);
}

/** A kerosene tank on legs by a wall (490 L: 1.0 × 0.6 × 1.2 m with its legs; grey or cream). */
function keroseneTank(s: Sink, w: Wall, t: number, y: number, col: RGBA): void {
  const fr = new Frame(w.mx + w.rx * (t - w.len / 2) + w.n[0] * 0.5, w.mz + w.rz * (t - w.len / 2) + w.n[2] * 0.5, w.rx, w.rz);
  boxAt(s, fr, 0, 0, 0.5, 0.3, y + 0.6, y + 1.3, STRIPS.plain, col);
  for (const k of [-0.42, 0.42]) boxAt(s, fr, k, 0, 0.035, 0.27, y - 0.2, y + 0.6, STRIPS.plain, rgb(128, 128, 126), false);
  const top = y + 1.3 + 0.16;
  s.snowQuad(fr.p(-0.5, -0.3, top), fr.p(0.5, -0.3, top), fr.p(0.5, 0.3, top), fr.p(-0.5, 0.3, top), UP);
  s.snowQuad(fr.p(-0.5, 0.3, top - 0.16), fr.p(0.5, 0.3, top - 0.16), fr.p(0.5, 0.3, top), fr.p(-0.5, 0.3, top), fr.dir(0, 1));
}

/** A vertical cylinder with a domed top (silos, tanks), snow on the dome. */
function cylinder(s: Sink, x: number, z: number, r: number, y0: number, y1: number, sides: number, strip: Strip, col: RGBA, dome: number, domeCol: RGBA | null = null): void {
  const ringAt = (rr: number, y: number): V3[] => {
    const out: V3[] = [];
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      out.push([x + Math.cos(a) * rr, y, z + Math.sin(a) * rr]);
    }
    return out;
  };
  const nrmAt = (up: number): V3[] => {
    const out: V3[] = [];
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      out.push(normalize([Math.cos(a), up, Math.sin(a)]));
    }
    return out;
  };
  const [vb, vt] = stripV(strip);
  const turns = Math.max(1, Math.round((2 * Math.PI * r) / WALL_TILE));
  const body = [ringAt(r, y0), ringAt(r, (y0 + y1) / 2), ringAt(r, y1)];
  s.grid(M, body, [nrmAt(0), nrmAt(0), nrmAt(0)], (rr, k) => [(k / sides) * turns, rr === 1 ? vt : vb], col);
  const cap = [ringAt(r * 1.02, y1), ringAt(r * 0.62, y1 + dome * 0.75), ringAt(r * 0.06, y1 + dome)];
  // A steel dome sheds its snow; a flat lid keeps it.
  if (domeCol) s.grid(M, cap, [nrmAt(0.5), nrmAt(1.2), nrmAt(6)], (rr, k) => [(k / sides) * 0.2, rr === 1 ? PLAIN_UV[3] : PLAIN_UV[1]], domeCol);
  else s.grid(MS, cap, [nrmAt(0.5), nrmAt(1.2), nrmAt(6)], (rr, k) => s.suv(cap[rr][k]), WHITE);
}

// ------------------------------------------------------------------ the building

type Kind = "house" | "temple" | "shed" | "garage" | "arch" | "barn" | "warehouse" | "greenhouse" | "konbini" | "shop" | "bigbox" | "block" | "canopy" | "tank";

interface Plot {
  f: Feature;
  fit: Fit;
  kind: Kind;
  rnd: Rand;
  site: Site;
  /** Ground under the footprint: lowest and highest corner. */
  yLow: number;
  yHigh: number;
  /** Unit direction to the nearest road from the centroid, or null. */
  road: [number, number] | null;
  /** Distance from the driven line (m). */
  dMain: number;
  /** Direction to the driven line. */
  toMain: [number, number];
  town: boolean;
  /** A restaurant or other named amenity next to it (for the sign). */
  hint: string;
}

const SHOP_TYPES = new Set(["retail", "commercial", "restaurant", "cafe", "fast_food", "pub", "pharmacy", "bank", "post_office", "karaoke_box", "supermarket", "fuel", "public_bath", "dentist", "clinic"]);
const BLOCK_TYPES = new Set(["school", "kindergarten", "hospital", "apartments", "townhall", "public", "hotel", "community_centre", "police", "fire_station", "train_station", "college", "university", "office", "civic", "dormitory"]);
const HOUSE_TYPES = new Set(["house", "detached", "residential", "bungalow", "semidetached_house", "terrace"]);

/** What a footprint is: from its tags when it has them, else from its size, shape and surroundings. */
function classify(f: Feature, fit: Fit, town: boolean, konbini: boolean, fuel: boolean, cover: string, dMain: number, rnd: Rand): Kind {
  const t = f.type;
  const tags = f.tags;
  const A = fit.area;
  const aspect = fit.length / (fit.width || 1);
  if (t === "roof" || t === "carport") return "canopy";
  if (t === "storage_tank" || tags.man_made === "storage_tank" || tags.man_made === "silo") return "tank";
  if (t === "greenhouse") return "greenhouse";
  if (tags.shop === "convenience" || (konbini && A > 90 && A < 420)) return "konbini";
  // A petrol station's office and bays, behind its canopy.
  if (fuel && A > 30 && A < 500) return "shop";
  if (t === "place_of_worship" || tags.amenity === "place_of_worship") return "temple";
  if (BLOCK_TYPES.has(t) || (typeof tags.amenity === "string" && BLOCK_TYPES.has(tags.amenity))) return A < 140 ? "house" : "block";
  if (SHOP_TYPES.has(t) || tags.shop || (typeof tags.amenity === "string" && SHOP_TYPES.has(tags.amenity))) return A > 800 ? "bigbox" : "shop";
  if (t === "warehouse" || t === "industrial") return A > 150 ? "warehouse" : "shed";
  if (t === "barn" || t === "cowshed" || t === "stable" || t === "farm_auxiliary") return A > 120 ? "barn" : "shed";
  if (HOUSE_TYPES.has(t)) return "house";
  if (t === "garage" || t === "garages") return "garage";
  if (t === "shed" || t === "hut") return "shed";
  const industrial = cover === "industrial" || cover === "military";
  if (town && !industrial) {
    if (A < 16) return "shed";
    if (A < 42) return fit.width > 2.9 && fit.length > 4.6 && rnd.next() < 0.6 ? "garage" : "shed";
    if (A < 270 && aspect < 2.7) return "house";
    if (A < 270) return rnd.next() < 0.5 ? "block" : "warehouse";
    const trade = cover === "retail" || cover === "commercial";
    // Unnamed larger buildings: trade where the driven road passes the door, flats and yards behind.
    if (A < 800) return trade || (dMain < 70 && rnd.next() < 0.5) ? "shop" : rnd.next() < 0.4 ? "block" : "warehouse";
    return trade || (dMain < 90 && rnd.next() < 0.4) ? "bigbox" : "warehouse";
  }
  // A farmstead or a yard.
  if (A < 45) return "shed";
  if (fit.width <= 8.5 && fit.length >= 20 && aspect >= 3) return industrial ? "warehouse" : "greenhouse";
  if (A < 210) {
    if (!industrial && A >= 62 && aspect < 1.95 && rnd.next() < 0.72) return "house";
    // Small D-type sheds are everywhere on these farms.
    return !industrial && A >= 70 && aspect >= 1.4 && fit.width >= 6 && fit.width <= 11 && rnd.next() < 0.35 ? "arch" : "shed";
  }
  if (A > 1300) return "warehouse";
  const k = rnd.next();
  if (!industrial && aspect >= 1.3 && fit.width >= 7 && fit.width <= 19 && k < 0.45) return "arch";
  if (!industrial && fit.width >= 8 && fit.width <= 16 && k < 0.75) return "barn";
  return "warehouse";
}

/** The wall that best faces a direction; `long` favours the eave sides (or, negative, the ends). */
function facing(walls: Wall[], dir: [number, number] | null, long: number, rnd: Rand): Wall {
  let best = walls[0];
  let score = -Infinity;
  const tie = rnd.next();
  walls.forEach((w, i) => {
    if (w.inner) return;
    const d = dir ? w.n[0] * dir[0] + w.n[2] * dir[1] : ((i * 0.37 + tie) % 1) - 0.5;
    const sc = d + (w.end ? -long : long);
    if (sc > score) {
      score = sc;
      best = w;
    }
  });
  return best;
}

/** Marks walls that stand inside another part of the same footprint. */
function markInner(walls: Wall[], others: Part[]): void {
  for (const w of walls) {
    const x = w.mx + w.n[0] * 0.4;
    const z = w.mz + w.n[2] * 0.4;
    w.inner = others.some((o) => inside(o, x, z));
  }
}

/** The plinth under a building on a slope, and the height its walls start from. */
function footing(s: Sink, pl: Plot, parts: Part[]): { floor: number; wallBase: number } {
  const drop = pl.yHigh - pl.yLow;
  if (drop < 0.5) return { floor: pl.yLow, wallBase: pl.yLow - 0.35 };
  const floor = pl.yLow + Math.min(drop, 1.5);
  for (const p of parts) for (const w of wallsOf(p)) wallFace(s, w, pl.yLow - 0.35, floor, STRIPS.concrete, () => CONCRETE, 0);
  return { floor, wallBase: floor };
}

/** Drifts and heaps around a building: against the windward wall and beside a door. */
function drifts(s: Sink, pl: Plot, walls: Wall[], skip: Wall | null): void {
  if (pl.dMain > 260) return;
  // The winter wind is from the north-west.
  let best: Wall | null = null;
  let score = 0.2;
  for (const w of walls) {
    if (w.inner || w === skip || w.len < 3) continue;
    const d = w.n[0] * -0.8 + w.n[2] * -0.6;
    if (d > score) {
      score = d;
      best = w;
    }
  }
  if (best) mound(s, pl.site, best, best.len * 0.04, best.len * 0.96, pl.rnd.range(0.5, 1.0), pl.rnd.range(1.8, 2.8));
}

function house(s: Sink, pl: Plot, temple: boolean): void {
  const rnd = pl.rnd;
  const parts = pl.fit.parts;
  const main = parts[0];
  const A = pl.fit.area;
  const { floor, wallBase } = footing(s, pl, parts);
  const kinds = ["musetsu", "shed", "gableSteep", "gableLow", "gambrel"] as const;
  const kr = rnd.next();
  // About half flat (無落雪), then mono-pitch and low gables, the older steep "triangle" roofs and mansards.
  let roof: (typeof kinds)[number] = kr < 0.46 ? "musetsu" : kr < 0.6 ? "shed" : kr < 0.72 ? "gableLow" : kr < 0.9 ? "gableSteep" : "gambrel";
  if (temple) roof = "gableSteep";
  const two = rnd.next() < (A < 60 ? 0.6 : A < 135 ? 0.85 : 0.5);
  let storeys = temple ? 1 : two ? 2 : 1;
  if (roof === "gambrel") storeys = 1;
  const lv = Number(pl.f.tags["building:levels"]);
  if (lv >= 1 && lv <= 4) storeys = lv;
  const mat = rnd.next();
  const strip: Strip = temple ? STRIPS.lap : mat < 0.55 ? STRIPS.lap : mat < 0.9 ? STRIPS.ceramic : STRIPS.rib;
  const wallCol = temple ? rgb(104, 86, 72) : siding(rnd);
  const twoTone = storeys === 2 && rnd.next() < 0.22;
  const lowCol = twoTone ? rnd.pick([...DARK, TINTED[0], TINTED[4]]) : wallCol;
  const roofCol = temple ? rgb(60, 62, 66) : roofing(rnd);
  const style: WindowStyle = { main: rnd.next() < 0.4 ? "winWhite" : "winSlide", lit: 0.2, near: pl.dMain < 50, toward: pl.toMain, blank: pl.dMain > 230 ? 0.5 : 0.22 };
  const u0 = rnd.next();
  const depth = rnd.range(0.4, 0.6);
  const eave = temple ? 0.9 : rnd.range(0.2, 0.45);
  const pitch = roof === "gableSteep" ? rnd.range(0.75, 1.15) : roof === "gableLow" ? rnd.range(0.25, 0.42) : roof === "shed" ? rnd.range(0.12, 0.24) : 0;
  const allWalls: Wall[] = [];

  parts.forEach((p, pi) => {
    const small = pi > 0 && p.hl * p.hw < main.hl * main.hw * 0.45;
    const st = small ? 1 : storeys;
    const walls = wallsOf(p);
    markInner(
      walls,
      parts.filter((q) => q !== p),
    );
    allWalls.push(...walls);
    let yTop = floor + st * STOREY + 0.45;
    let prof: Profile;
    if (roof === "musetsu") {
      yTop += 0.35;
      prof = profileOf("flat", p.hw, 0);
    } else if (roof === "shed") prof = profileOf("shed", p.hw, 2 * p.hw * pitch);
    else if (roof === "gambrel") prof = profileOf("gambrel", p.hw, Math.min(4.4, p.hw * 0.95));
    else prof = profileOf("gable", p.hw, Math.min(temple ? 5 : 4.6, p.hw * pitch));
    for (const w of walls) {
      const extra = w.end ? 0 : w.sign > 0 ? prof[prof.length - 1][1] : prof[0][1];
      const top = yTop + extra - (roof === "musetsu" ? 0.3 : 0);
      wallFace(s, w, wallBase, top, strip, (b) => (b === 0 ? lowCol : wallCol), u0);
      // The parapet's cap of a 無落雪 roof.
      if (roof === "musetsu") wallFace(s, w, top, yTop, STRIPS.plain, () => TRIM, 0);
    }
    if (roof === "musetsu") snowSlab(s, p.fr, p.hl, p.hw, yTop - 0.04, depth, 0.02);
    else {
      for (const sgn of [1, -1]) gableEnd(s, p, sgn, yTop, prof, strip, wallCol, u0);
      const ext = roofSkin(s, p, yTop, prof, eave, eave * 0.7, STRIPS.seam, roofCol);
      roofSnow(s, p, yTop, ext, eave * 0.7, depth);
      roofPatches(s, p, yTop, ext, rnd);
    }
    // The front: the main part's wall toward the road.
    let blocked: [number, number][] = [];
    let front: Wall | null = null;
    if (pi === 0) {
      front = facing(walls, pl.road ?? pl.toMain, roof === "gableSteep" ? -0.15 : 0.1, rnd);
      const t = clamp(front.len * rnd.range(0.25, 0.75), 1.3, front.len - 1.3);
      const yDoor = floor + 0.1;
      if (front.len > 3.4 && !temple && rnd.next() < 0.7) {
        porch(s, front, t, yDoor);
        blocked = [[t - 1.05, t + 1.05]];
      } else {
        panel(s, front, M, cellUV(CELLS.door), t, yDoor, CELLS.door.mw, CELLS.door.mh, 0.05);
        blocked = [[t - 0.8, t + 0.8]];
      }
      // Snow shovelled off the path, beside the door.
      const side = rnd.next() < 0.5 ? -1 : 1;
      const hp = wp(front, t + side * rnd.range(1.9, 2.6), 0, rnd.range(1.4, 2.2));
      if (pl.dMain < 260) heap(s, pl.site, hp[0], hp[2], rnd.range(1.0, 1.6), rnd.range(0.7, 1.3), rnd.next() * 6);
    }
    for (const w of walls) {
      if (w.inner) continue;
      windowRow(s, w, floor + 0.45, st, rnd, style, w === front ? blocked : []);
      // A window high in a steep gable.
      if (w.end && prof.length >= 3 && prof[Math.floor(prof.length / 2)][1] > 2.6) windowAt(s, w, "winTall", w.len / 2, yTop + 0.35, rnd.next() < 0.2, seen(style, w));
    }
    // Snow that has slid off a steep roof lies along the eave walls.
    if ((roof === "gableSteep" || roof === "gambrel") && pl.dMain < 260)
      for (const w of walls) {
        const h = rnd.range(0.7, 1.4);
        if (w.end || w.inner || w === front) continue;
        mound(s, pl.site, w, w.len * 0.03, w.len * 0.97, h, 2.4);
      }
    if (pi === 0 && style.near && !temple) {
      // What only shows from the road: the kerosene tank, a flue plate, a chimney.
      s.fine();
      const back = walls.filter((w) => w !== front && !w.inner && w.len > 3);
      const tw = back[Math.floor(rnd.next() * back.length)];
      const tankCol = rnd.next() < 0.5 ? rgb(176, 178, 176) : rgb(214, 208, 190);
      if (tw && rnd.next() < 0.75) keroseneTank(s, tw, tw.len * rnd.range(0.2, 0.8), floor, tankCol);
      const fw = back[Math.floor(rnd.next() * back.length)];
      if (fw) panel(s, fw, M, cellUV(CELLS.vent), fw.len * rnd.range(0.15, 0.85), floor + 1.0, 0.4, 0.4, 0.05);
      if (rnd.next() < 0.35) {
        // A block chimney through the roof (older houses with a stove).
        const cu = rnd.range(-0.5, 0.5) * p.hl;
        const cv = rnd.range(-0.4, 0.4) * p.hw;
        const top = yTop + Math.max(prof[0][1], prof[Math.floor(prof.length / 2)][1]) + 0.9;
        boxAt(s, p.fr, cu, cv, 0.26, 0.26, yTop - 0.2, top, STRIPS.concrete, CONCRETE, false);
        boxAt(s, p.fr, cu, cv, 0.29, 0.29, top, top + 0.18, STRIPS.plain, WHITE, true, MS);
      }
      s.base();
    }
  });
  drifts(s, pl, allWalls, null);
}

/** A storage shed, a garage or a small farm shed: a metal box under snow. */
function shed(s: Sink, pl: Plot, garage: boolean): void {
  const rnd = pl.rnd;
  const p = pl.fit.parts[0];
  const A = pl.fit.area;
  const { floor, wallBase } = footing(s, pl, [p]);
  const h = A < 14 ? rnd.range(1.9, 2.3) : A < 45 ? rnd.range(2.4, 2.9) : rnd.range(3.0, 4.2);
  const strip: Strip = rnd.next() < 0.6 ? STRIPS.rib : STRIPS.lap;
  const col = rnd.next() < 0.5 ? rnd.pick(FARM) : siding(rnd);
  const u0 = rnd.next();
  const walls = wallsOf(p);
  const yTop = floor + h;
  const sloped = A >= 45 && rnd.next() < 0.6;
  const prof = sloped ? profileOf("gable", p.hw, p.hw * rnd.range(0.28, 0.45)) : profileOf("shed", p.hw, 2 * p.hw * rnd.range(0.04, 0.12));
  for (const w of walls) wallFace(s, w, wallBase, yTop + (w.end ? 0 : w.sign > 0 ? prof[prof.length - 1][1] : prof[0][1]), strip, () => col, u0);
  for (const sgn of [1, -1]) gableEnd(s, p, sgn, yTop, prof, strip, col, u0);
  const roofCol = roofing(rnd);
  const ext = sloped ? roofSkin(s, p, yTop, prof, 0.3, 0.2, STRIPS.seam, roofCol) : overhung(prof, 0.1);
  if (!sloped) {
    // A plain sheet roof: only its edge shows under the snow.
    const A0 = ext.map((q) => p.fr.p(-p.hl - 0.1, q[0], yTop + q[1] + 0.02));
    const B0 = ext.map((q) => p.fr.p(p.hl + 0.1, q[0], yTop + q[1] + 0.02));
    s.quad(M, A0[0], B0[0], B0[1], A0[1], PLAIN_UV, shade(roofCol, 0.9), UP);
  }
  roofSnow(s, p, yTop, ext, sloped ? 0.2 : 0.1, rnd.range(0.3, 0.5));
  const front = facing(walls, pl.road ?? pl.toMain, garage ? -0.3 : 0, rnd);
  if (garage || (A >= 20 && rnd.next() < 0.5)) {
    const c = CELLS.shutter;
    const wd = Math.min(c.mw, front.len - 0.5);
    const ht = Math.min(c.mh, h - 0.25);
    if (wd > 1.6) panel(s, front, M, cellUV(c), front.len / 2, floor + 0.05, wd, ht, 0.04);
  } else if (A >= 8) panel(s, front, M, cellUV(CELLS.door), clamp(front.len * 0.3, 0.7, front.len - 0.7), floor + 0.05, 0.9, Math.min(1.9, h - 0.2), 0.04, rgb(200, 200, 196));
  if (A >= 45) drifts(s, pl, walls, front);
}

/** Tall doors on a wall: roller shutters or hanging barn doors, as many as fit. */
function bigDoors(s: Sink, w: Wall, floor: number, cell: Cell, most: number, maxH: number, rnd: Rand): void {
  const ht = Math.min(cell.mh, maxH);
  const wd = Math.min(cell.mw, w.len * 0.6);
  if (wd < 1.8) return;
  const count = Math.max(1, Math.min(most, Math.floor((w.len - 1) / (wd + 1.5))));
  for (let i = 0; i < count; i++) {
    const t = ((i + 0.5) * w.len) / count + (count === 1 ? rnd.range(-0.15, 0.15) * (w.len - wd - 1) : 0);
    panel(s, w, M, cellUV(cell), t, floor + 0.05, wd, ht, 0.05);
  }
}

/** A D-type warehouse (かまぼこ型): a corrugated arch from the ground, snow on its crown, slid snow along both sides. */
function arch(s: Sink, pl: Plot): void {
  const rnd = pl.rnd;
  const p = pl.fit.parts[0];
  const y = pl.yLow - 0.3;
  const rise = Math.min(p.hw * rnd.range(0.85, 1.0), 8) + 0.3;
  const col = rnd.pick(FARM);
  const prof = profileOf("arch", p.hw, rise);
  const ext = roofSkin(s, p, y, prof, 0, 0, STRIPS.rib, col);
  // End walls: the shell's colour, another sheet colour, or the dark teal of photo 29.
  const ek = rnd.next();
  const endCol = ek < 0.4 ? col : ek < 0.7 ? rnd.pick(FARM) : rgb(44, 70, 80);
  for (const sgn of [1, -1]) gableEnd(s, p, sgn, y, prof, STRIPS.rib, endCol, 0);
  // Corrugations hold snow well down the arch's shoulders.
  roofSnow(s, p, y, ext, 0, rnd.range(0.35, 0.55), rnd.next() < 0.6 ? 1.2 : HOLDS);
  const walls = wallsOf(p);
  const front = facing(walls, pl.road ?? pl.toMain, -1, rnd);
  bigDoors(s, front, pl.yLow, CELLS.bigShutter, 1, rise * 0.72, rnd);
  for (const w of walls) {
    const h = rnd.range(0.9, 1.7);
    if (!w.end && pl.dMain < 300) mound(s, pl.site, w, w.len * 0.02, w.len * 0.98, h, 2.8);
  }
}

/** A gambrel barn, a silo or two at its end. */
function barn(s: Sink, pl: Plot): void {
  const rnd = pl.rnd;
  const p = pl.fit.parts[0];
  const { floor, wallBase } = footing(s, pl, [p]);
  const h = rnd.range(2.8, 3.6);
  const yTop = floor + h;
  const col = rnd.pick(BARN);
  const strip: Strip = rnd.next() < 0.35 ? STRIPS.lap : STRIPS.rib;
  const roofCol = rnd.pick([rgb(146, 62, 54), rgb(146, 62, 54), ROOFS[3], rgb(70, 96, 136), ROOFS[0], ROOFS[5]]);
  const u0 = rnd.next();
  const prof = profileOf("gambrel", p.hw, Math.min(6.5, p.hw * 0.92));
  const walls = wallsOf(p);
  for (const w of walls) wallFace(s, w, wallBase, yTop, strip, () => col, u0);
  for (const sgn of [1, -1]) gableEnd(s, p, sgn, yTop, prof, strip, col, u0);
  const ext = roofSkin(s, p, yTop, prof, 0.35, 0.3, STRIPS.seam, roofCol);
  roofSnow(s, p, yTop, ext, 0.3, rnd.range(0.3, 0.5));
  roofPatches(s, p, yTop, ext, rnd);
  const front = facing(walls, pl.road ?? pl.toMain, -1, rnd);
  bigDoors(s, front, floor, CELLS.barnDoor, 1, h - 0.1, rnd);
  // The loft door over it.
  panel(s, front, M, cellUV(CELLS.barnDoor), front.len / 2, yTop + 0.5, 1.5, 1.5, 0.05);
  const style: WindowStyle = { main: "winWhite", lit: 0, near: false, toward: pl.toMain, blank: 0.3 };
  for (const w of walls) {
    if (w.end) continue;
    const n = Math.floor(w.len / 4);
    for (let i = 0; i < n; i++) if (rnd.next() > style.blank) windowAt(s, w, "winSmall", ((i + 0.5) * w.len) / n, floor + 1.5, false, false);
    const mh = rnd.range(0.8, 1.5);
    if (pl.dMain < 300) mound(s, pl.site, w, w.len * 0.03, w.len * 0.97, mh, 2.6);
  }
  // Silos stand at the end away from the door.
  const silos = pl.fit.area > 230 ? (rnd.next() < 0.55 ? 1 + Math.floor(rnd.next() * 1.4) : 0) : 0;
  const back = walls.find((w) => w.end && w !== front)!;
  for (let k = 0; k < silos; k++) {
    const r = rnd.range(2.1, 3.0);
    const sh = rnd.range(10, 15);
    const q = wp(back, back.len * (0.3 + 0.45 * k) + rnd.range(-0.5, 0.5), 0, r + 0.6);
    const gy = ground(pl.site, q[0], q[2]);
    // Dark steel staves under a bright dome (photo 29), blue steel, or old concrete.
    const tint = rnd.pick([rgb(74, 82, 86), rgb(74, 82, 86), rgb(84, 108, 138), rgb(196, 196, 190), rgb(150, 132, 118)]);
    const domeCol = rnd.next() < 0.75 ? rgb(190, 196, 200) : rgb(86, 124, 104);
    if (!Number.isNaN(gy)) cylinder(s, q[0], q[2], r, gy - 0.3, gy + sh, 9, STRIPS.concrete, tint, r * 0.6, domeCol);
  }
}

/** A sheet-metal warehouse or workshop: ribbed walls, a low roof under snow, roller shutters. */
function warehouse(s: Sink, pl: Plot): void {
  const rnd = pl.rnd;
  const col = rnd.pick(FARM);
  const roofCol = roofing(rnd);
  const u0 = rnd.next();
  const parts = pl.fit.parts;
  const { floor, wallBase } = footing(s, pl, parts);
  const all: Wall[] = [];
  let front: Wall | null = null;
  parts.forEach((p, pi) => {
    const h = clamp(3.0 + p.hw * 0.36, 3.4, 8.5) * (pi ? 0.85 : 1);
    const yTop = floor + h;
    const prof = profileOf("gable", p.hw, p.hw * 0.2);
    const walls = wallsOf(p);
    markInner(
      walls,
      parts.filter((q) => q !== p),
    );
    all.push(...walls);
    for (const w of walls) wallFace(s, w, wallBase, yTop, STRIPS.rib, () => col, u0);
    for (const sgn of [1, -1]) gableEnd(s, p, sgn, yTop, prof, STRIPS.rib, col, u0);
    const ext = roofSkin(s, p, yTop, prof, 0.25, 0.2, STRIPS.seam, roofCol);
    roofSnow(s, p, yTop, ext, 0.2, rnd.range(0.35, 0.5));
    if (pi === 0) {
      front = facing(walls, pl.road ?? pl.toMain, 0, rnd);
      bigDoors(s, front, floor, CELLS.bigShutter, 3, h - 0.4, rnd);
      const side = walls.find((w) => w !== front && !w.inner && w.end !== front!.end);
      if (side && side.len > 8) {
        const n = Math.floor(side.len / 5);
        for (let i = 0; i < n; i++) if (rnd.next() < 0.6) windowAt(s, side, "winSlide", ((i + 0.5) * side.len) / n, floor + Math.min(2.2, h - 1.6), rnd.next() < 0.12, false);
      }
    }
  });
  drifts(s, pl, all, front);
}

/** A pipe greenhouse in winter: bare hoops with the film taken off, or a tunnel left covered, snow on its crown. */
function greenhouse(s: Sink, pl: Plot): void {
  const rnd = pl.rnd;
  const p = pl.fit.parts[0];
  const y = pl.yLow - 0.25;
  const rise = Math.min(p.hw * 0.75, 3.4) + 0.4;
  const covered = rnd.next() < 0.4;
  if (covered) {
    const prof: Profile = [];
    for (let k = 0; k <= 6; k++) prof.push([-p.hw * Math.cos((Math.PI * k) / 6), rise * Math.sin((Math.PI * k) / 6)]);
    const ext = roofSkin(s, p, y, prof, 0, 0, STRIPS.plain, rgb(206, 212, 214));
    for (const sgn of [1, -1]) gableEnd(s, p, sgn, y, prof, STRIPS.plain, rgb(196, 202, 206), 0);
    roofSnow(s, p, y, ext, 0, 0.3);
    return;
  }
  // Hoops as flat ribbons, both faces; the real pitch is 50 cm, a hoop every few metres reads the same from the road.
  const hoops = clamp(Math.round((2 * p.hl) / 3.2), 3, 13);
  const col = rgb(150, 154, 156);
  const segs = 5;
  const wide = 0.09;
  const at = (l: number, k: number): V3 => p.fr.p(l, -p.hw * Math.cos((Math.PI * k) / segs), y + rise * Math.sin((Math.PI * k) / segs));
  for (let h = 0; h <= hoops; h++) {
    const l = -p.hl + (2 * p.hl * h) / hoops;
    for (let k = 0; k < segs; k++) {
      const a = at(l - wide / 2, k);
      const b = at(l + wide / 2, k);
      const c = at(l + wide / 2, k + 1);
      const d = at(l - wide / 2, k + 1);
      const mid = (k + 0.5) / segs;
      const out = normalize(add(p.fr.dir(0, -Math.cos(Math.PI * mid)), UP, Math.sin(Math.PI * mid)));
      s.quad(M, a, b, c, d, PLAIN_UV, col, out);
      s.quad(M, a, b, c, d, PLAIN_UV, shade(col, 0.8), [-out[0], -out[1], -out[2]]);
    }
  }
  // Purlins: the ridge and one each side.
  for (const k of [1, 2.5, 4]) {
    const a = at(-p.hl, k);
    const b = at(p.hl, k);
    const mid = k / segs;
    const out = normalize(add(p.fr.dir(0, -Math.cos(Math.PI * mid)), UP, Math.sin(Math.PI * mid)));
    const side = p.fr.dir(0, 0.05);
    const dn: V3 = [0, -0.07, 0];
    const w: V3 = Math.abs(out[1]) > 0.8 ? side : dn;
    s.quad(M, a, b, add(b, w), add(a, w), PLAIN_UV, col, out);
    s.quad(M, a, b, add(b, w), add(a, w), PLAIN_UV, shade(col, 0.8), [-out[0], -out[1], -out[2]]);
  }
}

/** A flat-roofed box with a parapet and snow: the body of shops and blocks. Returns its walls. */
function flatBox(s: Sink, p: Part, wallBase: number, yTop: number, strip: Strip, col: (band: number) => RGBA, u0: number, depth: number, others: Part[]): Wall[] {
  const walls = wallsOf(p);
  markInner(walls, others);
  for (const w of walls) wallFace(s, w, wallBase, yTop, strip, col, u0);
  snowSlab(s, p.fr, p.hl, p.hw, yTop - 0.04, depth, 0.02);
  return walls;
}

/** Where a shop looks: at the driven road when it stands by it, else at its own street. */
const shopSide = (pl: Plot): [number, number] => (pl.dMain < 110 ? pl.toMain : (pl.road ?? pl.toMain));

/** A lit fascia along the top of a wall: the band and two stripes. */
function fascia(s: Sink, w: Wall, y0: number, y1: number, scheme: [RGBA, RGBA, RGBA], t0 = 0, t1 = w.len): void {
  const [vb, vt] = stripV(LIT_STRIPS.fascia, LIT_ATLAS);
  const q = (a: number, b: number, proud: number, col: RGBA) => s.quad(ML, wp(w, t0, a, proud), wp(w, t1, a, proud), wp(w, t1, b, proud), wp(w, t0, b, proud), [t0 / STORE_TILE, vb + 0.01, t1 / STORE_TILE, vt - 0.01], col, w.n);
  const h = y1 - y0;
  q(y0, y1, 0.08, scheme[0]);
  q(y0 + h * 0.62, y0 + h * 0.8, 0.1, scheme[1]);
  q(y0 + h * 0.2, y0 + h * 0.38, 0.1, scheme[2]);
}

/** A shop front seen through its glass, lit. */
function storeFront(s: Sink, w: Wall, y: number, t0: number, t1: number, height: number): void {
  const [vb, vt] = stripV(LIT_STRIPS.store, LIT_ATLAS);
  const n = Math.max(1, Math.round((t1 - t0) / 1.5));
  // Through the glass a lit shop is not bright at four in the afternoon (#4A4840 in photo 34): its lamps are.
  s.quad(ML, wp(w, t0, y, 0.05), wp(w, t1, y, 0.05), wp(w, t1, y + height, 0.05), wp(w, t0, y + height, 0.05), [0, vb, (n * 1.5) / STORE_TILE, vt], rgb(176, 172, 162), w.n);
}

function konbini(s: Sink, pl: Plot): void {
  const rnd = pl.rnd;
  const p = pl.fit.parts[0];
  const { floor, wallBase } = footing(s, pl, [p]);
  const h = 3.7;
  const col = rgb(232, 230, 224);
  const walls = flatBox(s, p, wallBase, floor + h, STRIPS.ceramic, () => col, rnd.next(), rnd.range(0.35, 0.5), []);
  const front = facing(walls, shopSide(pl), 0.25, rnd);
  const glassW = Math.min(front.len - 1, 15);
  storeFront(s, front, floor + 0.15, (front.len - glassW) / 2, (front.len + glassW) / 2, 2.5);
  const scheme = rnd.pick(FASCIAS);
  for (const w of walls) {
    const d = w.n[0] * front.n[0] + w.n[2] * front.n[2];
    if (d < -0.5) continue;
    fascia(s, w, floor + 2.85, floor + h - 0.05, scheme, 0, w === front ? w.len : Math.min(w.len, 4));
  }
  drifts(s, pl, walls, front);
}

function shop(s: Sink, pl: Plot, big: boolean): void {
  const rnd = pl.rnd;
  const parts = pl.fit.parts;
  const { floor, wallBase } = footing(s, pl, parts);
  const lv = Number(pl.f.tags["building:levels"]);
  const storeys = big ? 1 : lv >= 1 && lv <= 4 ? lv : rnd.next() < 0.35 ? 2 : 1;
  const h = big ? rnd.range(6, 8.5) : storeys * 3.0 + rnd.range(0.6, 1.4);
  const strip: Strip = big ? (rnd.next() < 0.6 ? STRIPS.rib : STRIPS.ceramic) : rnd.next() < 0.5 ? STRIPS.ceramic : STRIPS.lap;
  const col = rnd.pick([...PALE, rgb(236, 234, 228)]);
  const band = rnd.pick(SIGN_BANDS);
  const u0 = rnd.next();
  const depth = rnd.range(0.35, 0.5);
  const open = rnd.next() < (big ? 0.9 : 0.55);
  const all: Wall[] = [];
  let front: Wall | null = null;
  parts.forEach((p, pi) => {
    const walls = flatBox(
      s,
      p,
      wallBase,
      floor + h * (pi ? 0.8 : 1),
      strip,
      () => col,
      u0,
      depth,
      parts.filter((q) => q !== p),
    );
    all.push(...walls);
    if (pi) return;
    const f = (front = facing(walls, shopSide(pl), 0.2, rnd));
    const [vb, vt] = stripV(STRIPS.plain);
    // The sign band over the front.
    const bh = big ? 1.4 : 0.8;
    const by = floor + h - bh - 0.15;
    s.quad(M, wp(f, 0, by, 0.06), wp(f, f.len, by, 0.06), wp(f, f.len, by + bh, 0.06), wp(f, 0, by + bh, 0.06), [0, vb + 0.004, f.len / WALL_TILE, vt - 0.004], band, f.n);
    if (big) {
      // An entrance bay in the middle, lit; the name panel over it.
      const wd = clamp(f.len * 0.3, 6, 15);
      storeFront(s, f, floor + 0.15, f.len / 2 - wd / 2, f.len / 2 + wd / 2, 2.6);
      const sign = rnd.pick([LIT_CELLS.sign0, LIT_CELLS.sign2]);
      panel(s, f, ML, cellUV(sign, LIT_ATLAS), f.len / 2, by - 0.1, 5, 1.6, 0.1);
    } else {
      const c = CELLS.shopGlass;
      // The glazed part of the front: a few bays about the door, not the whole of a long wall.
      const span = Math.min(f.len - 1.2, 10.5);
      const g0 = clamp(f.len * rnd.range(0.3, 0.7) - span / 2, 0.6, f.len - 0.6 - span);
      if (open) storeFront(s, f, floor + 0.15, g0, g0 + span, Math.min(2.4, by - floor - 0.3));
      else {
        const n = Math.max(1, Math.floor(span / c.mw));
        for (let i = 0; i < n; i++) panel(s, f, M, cellUV(c), g0 + ((i + 0.5) * span) / n, floor + 0.15, span / n - 0.1, c.mh, 0.05);
      }
      const eats = pl.hint === "restaurant" || pl.f.type === "restaurant" || pl.f.type === "fast_food" || pl.f.type === "cafe";
      if (open) panel(s, f, ML, cellUV(eats ? LIT_CELLS.sign1 : rnd.pick([LIT_CELLS.sign0, LIT_CELLS.sign2]), LIT_ATLAS), clamp(f.len * 0.5, 1.4, f.len - 1.4), by + bh * 0.5 - 0.5, 2.5, 1.0, 0.09);
      else if (f.len > 4.6) panel(s, f, M, cellUV(CELLS.board), f.len / 2, by + bh * 0.5 - 0.5, 4, 1, 0.09);
      if (storeys > 1) {
        const n = Math.floor(f.len / 2.8);
        for (let i = 0; i < n; i++) windowAt(s, f, "winSlide", ((i + 0.5) * f.len) / n, floor + 3.0 + 0.9, rnd.next() < 0.25, pl.dMain < 75);
      }
    }
  });
  drifts(s, pl, all, front);
}

/** A school, flats, a hospital, an office: storeys of window bands under a flat roof. */
function block(s: Sink, pl: Plot): void {
  const rnd = pl.rnd;
  const parts = pl.fit.parts;
  const A = pl.fit.area;
  const t = pl.f.type;
  const { floor, wallBase } = footing(s, pl, parts);
  const lv = Number(pl.f.tags["building:levels"]);
  let storeys = t === "school" || t === "hospital" ? (A > 1400 ? 3 : 2) : A > 900 ? 3 : 2;
  if (t === "kindergarten" || t === "community_centre" || t === "train_station") storeys = 1;
  if (lv >= 1 && lv <= 8) storeys = lv;
  const sh = STRIPS.band.metres;
  const col = rnd.pick([rgb(232, 228, 216), rgb(218, 214, 204), rgb(226, 214, 196), rgb(206, 210, 212), rgb(214, 196, 178)]);
  const depth = rnd.range(0.35, 0.5);
  const all: Wall[] = [];
  parts.forEach((p, pi) => {
    const st = pi && p.hl * p.hw < parts[0].hl * parts[0].hw * 0.3 ? Math.max(1, storeys - 1) : storeys;
    const yTop = floor + 0.3 + st * sh;
    const walls = wallsOf(p);
    const others = parts.filter((q) => q !== p);
    markInner(walls, others);
    all.push(...walls);
    for (const w of walls) {
      // A base course, then whole repeats of the band so no window is cut at a corner.
      wallFace(s, w, wallBase, floor + 0.3, STRIPS.concrete, () => CONCRETE, 0);
      const n = Math.floor(w.len / BAND.period);
      const m = (w.len - n * BAND.period) / 2;
      const [vb, vt] = stripV(STRIPS.plain);
      const plain = (t0: number, t1: number) => s.quad(M, wp(w, t0, floor + 0.3), wp(w, t1, floor + 0.3), wp(w, t1, yTop), wp(w, t0, yTop), [0, vb + 0.004, 0.1, vt - 0.004], shade(col, 0.96), w.n);
      if (w.inner || n < 1) {
        plain(0, w.len);
        continue;
      }
      if (m > 0.02) {
        plain(0, m);
        plain(w.len - m, w.len);
      }
      wallFace(s, w, floor + 0.3, yTop, STRIPS.band, () => col, 0, m, w.len - m);
      // Rooms with the lights on.
      const c = LIT_CELLS.winBand;
      for (let k = 0; k < st; k++)
        for (let i = 0; i < n; i++) {
          if (rnd.next() >= 0.14) continue;
          panel(s, w, ML, cellUV(c, LIT_ATLAS), m + i * BAND.period + BAND.x + BAND.w / 2, floor + 0.3 + k * sh + BAND.sill, BAND.w, BAND.h, 0.04);
        }
    }
    snowSlab(s, p.fr, p.hl, p.hw, yTop - 0.04, depth, 0.03);
  });
  drifts(s, pl, all, null);
}

/** A roof on posts: carports, shelters. */
function canopy(s: Sink, pl: Plot): void {
  const p = pl.fit.parts[0];
  const rnd = pl.rnd;
  const h = pl.fit.area > 80 ? 4.6 : 2.6;
  const y = pl.yLow;
  boxAt(s, p.fr, 0, 0, p.hl, p.hw, y + h, y + h + 0.3, STRIPS.plain, rgb(226, 226, 222), false);
  s.quad(M, p.fr.p(-p.hl, -p.hw, y + h), p.fr.p(p.hl, -p.hw, y + h), p.fr.p(p.hl, p.hw, y + h), p.fr.p(-p.hl, p.hw, y + h), PLAIN_UV, rgb(200, 200, 196), [0, -1, 0]);
  for (const [a, b] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ])
    boxAt(s, p.fr, a * (p.hl - 0.3), b * (p.hw - 0.3), 0.08, 0.08, y - 0.3, y + h, STRIPS.plain, rgb(150, 152, 154), false);
  snowSlab(s, p.fr, p.hl, p.hw, y + h + 0.28, rnd.range(0.3, 0.45), 0.03);
}

function tank(s: Sink, pl: Plot): void {
  const r = Math.max(1.2, Math.sqrt(pl.fit.area / Math.PI));
  cylinder(s, pl.fit.cx, pl.fit.cz, r, pl.yLow - 0.3, pl.yLow + clamp(r * 1.6, 3, 10), 10, STRIPS.concrete, rgb(214, 214, 208), r * 0.25);
}

/**
 * A petrol station's canopy at an `amenity=fuel` point: a deep white fascia
 * with a colour stripe on columns, lamps in its ceiling, snow on top, two
 * pump islands under it. It stands along the nearest road.
 */
function fuelCanopy(s: Sink, site: Site, x: number, z: number, rnd: Rand, taken: (x: number, z: number) => boolean): void {
  const world = site.world;
  const [px, pz] = [x, z];
  let ux = 1;
  let uz = 0;
  // The road it serves: the driven road when it stands by it, else the nearest.
  const pm = world.main.line.project(x, z, 70);
  world.probe(x, z, site.probe);
  const road = pm ? world.main : site.probe.road;
  if (road) {
    const arc = pm ? pm.s : site.probe.s;
    const d = pm ? pm.d : site.probe.d;
    const a = road.line.at(arc);
    ux = a.tx;
    uz = a.tz;
    const sx = Math.sign(d) || 1;
    const ox = -a.tz * sx;
    const oz = a.tx * sx;
    // The surveyed point is often the office: the canopy stands on the forecourt, between it and the road.
    let e = Math.abs(d) - road.half;
    for (let k = 0; k < 14 && e > 10 && taken(x, z); k++, e -= 2) {
      x -= ox * 2;
      z -= oz * 2;
    }
    // Off the road, by a lane's width.
    const want = 8;
    if (e < want) {
      x += ox * (want - e);
      z += oz * (want - e);
    }
  }
  const hl = rnd.range(6.5, 9);
  const hw = rnd.range(3.6, 4.6);
  const clear = (f: Frame) =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [0, 0],
    ].every(([a, b]) => {
      const q = f.p(a * hl, b * hw, 0);
      return world.probe(q[0], q[2], site.probe).e >= 1.5;
    });
  let fr = new Frame(x, z, ux, uz);
  if (!clear(fr)) {
    // A lane crosses the forecourt there: stay at the surveyed point.
    fr = new Frame(px, pz, ux, uz);
    if (!clear(fr)) return;
    [x, z] = [px, pz];
  }
  const y = world.base(x, z);
  const h = 4.9;
  const stripe = rnd.pick(SIGN_BANDS);
  boxAt(s, fr, 0, 0, hl, hw, y + h, y + h + 0.75, STRIPS.plain, rgb(238, 238, 234), false);
  boxAt(s, fr, 0, 0, hl + 0.03, hw + 0.03, y + h + 0.22, y + h + 0.5, STRIPS.plain, stripe, false);
  s.quad(M, fr.p(-hl, -hw, y + h), fr.p(hl, -hw, y + h), fr.p(hl, hw, y + h), fr.p(-hl, hw, y + h), PLAIN_UV, rgb(214, 214, 210), [0, -1, 0]);
  snowSlab(s, fr, hl, hw, y + h + 0.73, rnd.range(0.3, 0.45), 0.03);
  const lamp = cellUV(LIT_CELLS.lamp, LIT_ATLAS);
  const panelUV = cellUV(LIT_CELLS.panel, LIT_ATLAS);
  for (const a of [-0.5, 0.5]) {
    boxAt(s, fr, a * hl, 0, 0.22, 0.22, y - 0.3, y + h, STRIPS.plain, rgb(232, 232, 228), false);
    // The island: a kerb and a pump with its lit face toward both lanes.
    boxAt(s, fr, a * hl, 0, 1.5, 0.5, y - 0.2, y + 0.18, STRIPS.concrete, CONCRETE);
    boxAt(s, fr, a * hl + 0.9, 0, 0.3, 0.42, y + 0.18, y + 1.75, STRIPS.plain, rgb(226, 226, 222));
    for (const sd of [-1, 1]) {
      const c = fr.p(a * hl + 0.9, sd * 0.44, 0);
      const r = fr.dir(0.28, 0);
      s.quad(ML, [c[0] - r[0], y + 0.45, c[2] - r[2]], [c[0] + r[0], y + 0.45, c[2] + r[2]], [c[0] + r[0], y + 1.65, c[2] + r[2]], [c[0] - r[0], y + 1.65, c[2] - r[2]], panelUV, WHITE, fr.dir(0, sd));
    }
    for (const b of [-0.5, 0.5]) {
      const q = (du: number, dv: number): V3 => fr.p(a * hl + du, b * hw + dv, y + h - 0.03);
      s.quad(ML, q(-0.6, -0.6), q(0.6, -0.6), q(0.6, 0.6), q(-0.6, 0.6), lamp, WHITE, [0, -1, 0]);
    }
  }
}

// ------------------------------------------------------------------ the cell

/** Centroid of a ring (the mean of its corners): the building's anchor. */
function centroid(f: Feature): [number, number] {
  const n = f.pts.length / 2 - 1;
  let x = 0;
  let z = 0;
  for (let i = 0; i < n; i++) {
    x += f.pts[i * 2];
    z += f.pts[i * 2 + 1];
  }
  return [x / n, z / n];
}

/** Moves a footprint's parts off the ploughed roads; false when it cannot stand clear. */
function clearOfRoads(site: Site, parts: Part[]): boolean {
  const CLEAR = 1.5;
  for (let pass = 0; pass < 4; pass++) {
    let worst = CLEAR;
    let mx = 0;
    let mz = 0;
    for (const p of parts)
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
        [0, 0],
      ]) {
        const q = p.fr.p(a * p.hl, b * p.hw, 0);
        const pr = site.world.probe(q[0], q[2], site.probe);
        if (pr.e >= worst || !pr.road) continue;
        worst = pr.e;
        // Away from the road's centre line at the nearest point.
        const at = pr.road.line.at(pr.s);
        const sd = Math.sign(pr.d) || 1;
        mx = -at.tz * sd;
        mz = at.tx * sd;
      }
    if (worst >= CLEAR) return true;
    const k = CLEAR - worst + 0.15;
    if (pass === 3 || k > 7) return false;
    for (const p of parts) {
      const fr = p.fr;
      p.fr = new Frame(fr.cx + mx * k, fr.cz + mz * k, fr.ux, fr.uz);
    }
  }
  return false;
}

export function buildings(c: CellContext): void {
  const layer = c.layer.name;
  if (layer !== "base" && layer !== "detail") return;
  const { world, x0, z0, x1, z1 } = c;
  const PAD = 70;
  const around = world.source.query("building", x0 - PAD, z0 - PAD, x1 + PAD, z1 + PAD);
  if (!around.length && !world.source.query("point", x0, z0, x1, z1).length) return;
  const cents = around.map(centroid);
  const points = world.source.query("point", x0 - 40, z0 - 40, x1 + 40, z1 + 40);
  const shops = points.filter((p) => p.type === "shop-convenience");
  const fuels = points.filter((p) => p.type === "amenity-fuel");
  const eats = points.filter((p) => p.type === "amenity-restaurant" || p.type === "amenity-fast_food" || p.type === "amenity-cafe");
  const cover = new Cover(world, x0, z0, x1, z1);
  const site: Site = { world, probe: newProbe() };
  const s = new Sink(c.mb, layer === "detail", x0, z0);
  const proj = { s: 0, d: 0, i: 0 };

  around.forEach((f, i) => {
    const [cx, cz] = cents[i];
    if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) return;
    if (f.pts.length < 8) return;
    const ft = fit(f);
    if (ft.area < 3 || ft.width < 1.2) return;
    const rnd = new Rand(Math.floor(hash2(Math.round(cx * 10), Math.round(cz * 10)) * 0x7fffffff) + 1);
    // A town: other buildings close by on several sides.
    let near = 0;
    for (const q of cents) if (Math.abs(q[0] - cx) < 55 && Math.abs(q[1] - cz) < 55) near++;
    const land = cover.at(cx, cz);
    const town = near >= 8 || land === "residential" || land === "retail" || land === "commercial";
    const byShop = shops.some((p) => Math.hypot(p.pts[0] - cx, p.pts[1] - cz) < Math.max(14, ft.length * 0.6));
    
    if (!clearOfRoads(site, ft.parts)) return;
    let yLow = Infinity;
    let yHigh = -Infinity;
    for (const p of ft.parts)
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const q = p.fr.p(a * p.hl, b * p.hw, 0);
        const y = world.base(q[0], q[2]);
        yLow = Math.min(yLow, y);
        yHigh = Math.max(yHigh, y);
      }
    const m = ft.parts[0].fr;
    const pr = world.probe(m.cx, m.cz, site.probe);
    let road: [number, number] | null = null;
    if (pr.road && pr.e < 38) {
      const at = pr.road.line.at(pr.s);
      const d = Math.hypot(at.x - m.cx, at.z - m.cz) || 1;
      road = [(at.x - m.cx) / d, (at.z - m.cz) / d];
    }
    const pm = world.main.line.project(m.cx, m.cz, 700, proj);
    let dMain = 999;
    let toMain: [number, number] = [1, 0];
    if (pm) {
      const at = world.main.line.at(pm.s);
      dMain = Math.hypot(at.x - m.cx, at.z - m.cz);
      toMain = [(at.x - m.cx) / (dMain || 1), (at.z - m.cz) / (dMain || 1)];
    }
    const byFuel = fuels.some((p) => Math.hypot(p.pts[0] - cx, p.pts[1] - cz) < Math.max(14, ft.length * 0.7));
    const kind = classify(f, ft, town, byShop, byFuel, land, dMain, rnd);
    const hint = eats.some((p) => Math.hypot(p.pts[0] - cx, p.pts[1] - cz) < Math.max(12, ft.length * 0.6)) ? "restaurant" : "";
    const pl: Plot = { f, fit: ft, kind, rnd, site, yLow, yHigh, road, dMain, toMain, town, hint };
    s.base();
    switch (kind) {
      case "house":
        return house(s, pl, false);
      case "temple":
        return house(s, pl, true);
      case "shed":
        return shed(s, pl, false);
      case "garage":
        return shed(s, pl, true);
      case "arch":
        return arch(s, pl);
      case "barn":
        return barn(s, pl);
      case "warehouse":
        return warehouse(s, pl);
      case "greenhouse":
        return greenhouse(s, pl);
      case "konbini":
        return konbini(s, pl);
      case "shop":
        return shop(s, pl, false);
      case "bigbox":
        return shop(s, pl, true);
      case "block":
        return block(s, pl);
      case "canopy":
        return canopy(s, pl);
      case "tank":
        return tank(s, pl);
    }
  });

  // Petrol stations' canopies, at their surveyed points.
  for (const p of points) {
    if (p.type !== "amenity-fuel") continue;
    const [x, z] = [p.pts[0], p.pts[1]];
    if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
    s.base();
    const taken = (qx: number, qz: number) => around.some((f) => qx > f.box[0] - 5.5 && qx < f.box[2] + 5.5 && qz > f.box[1] - 5.5 && qz < f.box[3] + 5.5);
    fuelCanopy(s, site, x, z, new Rand(Math.floor(hash2(Math.round(x * 10), Math.round(z * 10)) * 0x7fffffff) + 1), taken);
  }
}
