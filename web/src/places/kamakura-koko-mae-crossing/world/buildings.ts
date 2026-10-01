import { BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, PlaneGeometry, ShapeUtils, Vector2, Vector3 } from "three";
import { Rng } from "../../../core/random";
import { mapUV } from "../../shared/atlas";
import { merge } from "../../shared/shapes";
import { bandUV, FACADE, facadeAtlas, LAYOUT, propUV, ROWS, wallUV, type Band, type Win } from "../gfx/facade";
import * as SURF from "../gfx/surfaces";
import { Bag, type KamakuraWorld } from "./context";
import { BUILDINGS } from "./data";
import { eastKerb, terraceY, TRIANGLE, triangleLift, WALK, wallTop } from "./ground";
import { COAST, slopeY, TRACK, VIEW } from "./layout";
import { Greenery } from "./plants";
import { hillY } from "./terrain";
import { place } from "./util";

/**
 * The houses on the hillside, from PLATEAU footprints, ground levels and
 * heights, in one facade atlas (gfx/facade.ts): white villas, sided houses,
 * tiled apartment blocks and dark-boarded villa wings, a storey row each.
 *
 * Walls that face one of the viewpoints within `RELIEF_M` are built bay by
 * bay with the windows cut out: reveals, projecting sills, rain-shutter
 * boxes and door canopies around a glass pane set 0.14 m back (the painted
 * window, in a smooth material that reflects the sky). Further walls are
 * one quad per storey with the same painting. Villas get balcony slabs
 * with glass balustrades on their seaward and west walls, apartments
 * balconies with precast panels, partitions and air-conditioner units;
 * downpipes at the corners, coped parapets on flat roofs, eaves on the
 * gabled ones. The villas on the terraces just north-east of the crossing
 * add what the photographs show close up: the cream round tower with the
 * stacked-stone column, glass balustrades along the wall tops, palms and
 * cycads in the gardens.
 */

/** Wall tints (× the facade atlas): white, warm white, cream, beige, light grey, pale terracotta, blue-grey. */
const WALLS: [number, number, number][] = [
  [1, 1, 1],
  [1, 0.97, 0.92],
  [1, 0.93, 0.8],
  [0.88, 0.8, 0.68],
  [0.84, 0.85, 0.86],
  [0.95, 0.82, 0.72],
  [0.8, 0.86, 0.9],
];
/** Roof tints (× the light roof band): dark grey, brown, terracotta, blue-grey. */
const ROOFS: [number, number, number][] = [
  [0.45, 0.46, 0.48],
  [0.55, 0.4, 0.3],
  [0.75, 0.42, 0.3],
  [0.42, 0.5, 0.6],
  [0.62, 0.62, 0.6],
];

/** Walls facing a viewpoint closer than this are built with their windows in relief. */
const RELIEF_M = 64;
/** Window and door recess (m). */
const RECESS = 0.14;

type Kind = "villa" | "clad" | "house" | "apt";
type P3 = [number, number, number];
type UV = [number, number];

/** Signed area of a ring in (x, z): positive = counter-clockwise in the x–z plane (clockwise seen from above). */
function area(ring: number[]): number {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  return a / 2;
}

/** Non-indexed triangles with uv and colour; faces are turned to a wanted outward direction. */
class Faces {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  tint: P3 = [1, 1, 1];

  tri(a: P3, b: P3, c: P3, ua: UV, ub: UV, uc: UV): void {
    this.pos.push(...a, ...b, ...c);
    this.uv.push(...ua, ...ub, ...uc);
    this.col.push(...this.tint, ...this.tint, ...this.tint);
  }

  /** Triangle turned to face `out`. */
  triOut(a: P3, b: P3, c: P3, ua: UV, ub: UV, uc: UV, out: P3): void {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) this.tri(a, b, c, ua, ub, uc);
    else this.tri(a, c, b, ua, uc, ub);
  }

  /** Quad a-b-c-d (in order round its edge) turned to face `out`. */
  quad(a: P3, b: P3, c: P3, d: P3, ua: UV, ub: UV, uc: UV, ud: UV, out: P3): void {
    this.triOut(a, b, c, ua, ub, uc, out);
    this.triOut(a, c, d, ua, uc, ud, out);
  }

  get triangles(): number {
    return this.pos.length / 9;
  }

  geometry(colours = true): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("uv", new Float32BufferAttribute(this.uv, 2));
    if (colours) g.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

/** A wall's frame: origin, unit direction along it and outward normal, in x–z. */
class WallFrame {
  constructor(
    readonly ax: number,
    readonly az: number,
    readonly tx: number,
    readonly tz: number,
  ) {}
  get nx(): number {
    return -this.tz;
  }
  get nz(): number {
    return this.tx;
  }
  /** Point `s` along, at height y, `d` out of the wall plane (negative: recessed). */
  p(s: number, y: number, d = 0): P3 {
    return [this.ax + this.tx * s + this.nx * d, y, this.az + this.tz * s + this.nz * d];
  }
  get out(): P3 {
    return [this.nx, 0, this.nz];
  }
  get along(): P3 {
    return [this.tx, 0, this.tz];
  }
}

const UP: P3 = [0, 1, 0];
const DOWN: P3 = [0, -1, 0];
const neg = (v: P3): P3 => [-v[0], -v[1], -v[2]];

/**
 * A box against a wall: s0–s1 along, y0–y1 up, d0–d1 out. Front face uv
 * from `front` (corner uvs bottom-left, bottom-right, top-right, top-left),
 * the rest from a band.
 */
function wallBox(f: Faces, w: WallFrame, s0: number, s1: number, y0: number, y1: number, d0: number, d1: number, front: [UV, UV, UV, UV], band: Band, o: { top?: boolean; bottom?: boolean; ends?: boolean; bottomBand?: Band } = {}): void {
  const [fa, fb, fc, fd] = front;
  f.quad(w.p(s0, y0, d1), w.p(s1, y0, d1), w.p(s1, y1, d1), w.p(s0, y1, d1), fa, fb, fc, fd, w.out);
  const L = s1 - s0;
  const D = d1 - d0;
  if (o.top !== false) f.quad(w.p(s0, y1, d0), w.p(s1, y1, d0), w.p(s1, y1, d1), w.p(s0, y1, d1), bandUV(band, s0, 0), bandUV(band, s0 + L, 0), bandUV(band, s0 + L, 1), bandUV(band, s0, 1), UP);
  if (o.bottom !== false) {
    const bb = o.bottomBand ?? band;
    f.quad(w.p(s0, y0, d0), w.p(s1, y0, d0), w.p(s1, y0, d1), w.p(s0, y0, d1), bandUV(bb, s0, 0), bandUV(bb, s0 + L, 0), bandUV(bb, s0 + L, 1), bandUV(bb, s0, 1), DOWN);
  }
  if (o.ends !== false) {
    const H = y1 - y0;
    for (const [s, dir] of [
      [s0, neg(w.along)],
      [s1, w.along],
    ] as [number, P3][])
      f.quad(w.p(s, y0, d0), w.p(s, y0, d1), w.p(s, y1, d1), w.p(s, y1, d0), bandUV(band, 0, 0), bandUV(band, D, 0), bandUV(band, D, Math.min(1, H / 0.4)), bandUV(band, 0, Math.min(1, H / 0.4)), dir);
  }
}

/** A band-mapped box at any position (downpipes, rails): axis-aligned to a wall frame, centred on (s, d). */
function stick(f: Faces, w: WallFrame, s: number, d: number, y0: number, y1: number, half: number, band: Band, sides: P3[] = []): void {
  const faces: [number, number, P3][] = [
    [0, half, w.out],
    [0, -half, neg(w.out)],
    [half, 0, w.along],
    [-half, 0, neg(w.along)],
  ];
  for (const [ds, dd, dir] of faces) {
    if (sides.length && !sides.some((v) => v[0] === dir[0] && v[2] === dir[2])) continue;
    // Face centred at (s + ds, d + dd), spanning the other axis.
    const alongFace = dd !== 0;
    const a = alongFace ? w.p(s - half, y0, d + dd) : w.p(s + ds, y0, d - half);
    const b = alongFace ? w.p(s + half, y0, d + dd) : w.p(s + ds, y0, d + half);
    const c: P3 = [b[0], y1, b[2]];
    const e: P3 = [a[0], y1, a[2]];
    const H = y1 - y0;
    f.quad(a, b, c, e, bandUV(band, 0, 0.1), bandUV(band, 0, 0.9), bandUV(band, H, 0.9), bandUV(band, H, 0.1), dir);
  }
}

/**
 * One window cut into a relief bay: the wall above and below it, reveals,
 * sill, pane (glass), shutter box, canopy. Returns the opening's span along
 * the wall; the caller fills the solid strips between openings. `bay` is
 * unwrapped (u keeps increasing along the wall; the atlas repeats in u).
 */
function windowBay(walls: Faces, glass: Faces, w: WallFrame, row: number, bay: number, s0: number, y0: number, bw: number, fh: number, win: Win): [number, number] {
  const sx = bw / FACADE.bay;
  const sy = fh / FACADE.floor;
  const uv = (s: number, y: number) => wallUV(row, bay, s / sx, y / sy);
  const x0 = win.x * sx;
  const x1 = (win.x + win.w) * sx;
  const wy0 = win.y * sy;
  const wy1 = Math.min(fh - 0.02, (win.y + win.h) * sy);
  const P = (s: number, y: number, d = 0) => w.p(s0 + s, y0 + y, d);
  const out = w.out;
  const wallQ = (sa: number, sb: number, ya: number, yb: number) => {
    if (sb - sa < 0.005 || yb - ya < 0.005) return;
    walls.quad(P(sa, ya), P(sb, ya), P(sb, yb), P(sa, yb), uv(sa, ya), uv(sb, ya), uv(sb, yb), uv(sa, yb), out);
  };
  wallQ(x0, x1, 0, wy0);
  wallQ(x0, x1, wy1, fh);
  // Behind an apartment balcony the slab and panel give the depth: the pane sits flush.
  if (row === ROWS.apt) {
    glass.quad(P(x0, wy0), P(x1, wy0), P(x1, wy1), P(x0, wy1), uv(x0, wy0), uv(x1, wy0), uv(x1, wy1), uv(x0, wy1), out);
    return [s0 + x0, s0 + x1];
  }
  // Reveals (jambs and head) in the reveal band; the threshold or the sill below.
  const d = -RECESS;
  const H = wy1 - wy0;
  walls.quad(P(x0, wy0), P(x0, wy0, d), P(x0, wy1, d), P(x0, wy1), bandUV("reveal", 0, 0), bandUV("reveal", 0, 1), bandUV("reveal", H, 1), bandUV("reveal", H, 0), w.along);
  walls.quad(P(x1, wy0), P(x1, wy0, d), P(x1, wy1, d), P(x1, wy1), bandUV("reveal", 0, 0), bandUV("reveal", 0, 1), bandUV("reveal", H, 1), bandUV("reveal", H, 0), neg(w.along));
  const Wd = x1 - x0;
  walls.quad(P(x0, wy1), P(x1, wy1), P(x1, wy1, d), P(x0, wy1, d), bandUV("reveal", 0, 0), bandUV("reveal", Wd, 0), bandUV("reveal", Wd, 1), bandUV("reveal", 0, 1), DOWN);
  if (win.sill) {
    // Aluminium sill: from the pane out 5 cm past the wall, 4 cm thick at its nose.
    wallBox(walls, w, s0 + x0 - 0.04, s0 + x1 + 0.04, y0 + wy0 - 0.045, y0 + wy0, d, 0.05, [bandUV("metal", 0, 0.2), bandUV("metal", Wd, 0.2), bandUV("metal", Wd, 0.5), bandUV("metal", 0, 0.5)], "metal", { bottom: false, ends: false });
  } else walls.quad(P(x0, wy0), P(x1, wy0), P(x1, wy0, d), P(x0, wy0, d), bandUV("reveal", 0, 0), bandUV("reveal", Wd, 0), bandUV("reveal", Wd, 1), bandUV("reveal", 0, 1), UP);
  glass.quad(P(x0, wy0, d), P(x1, wy0, d), P(x1, wy1, d), P(x0, wy1, d), uv(x0, wy0), uv(x1, wy0), uv(x1, wy1), uv(x0, wy1), out);
  if (win.shutter) {
    // Rain-shutter box over the opening (painted front, metal ends and soffit).
    const a = x0 - 0.06 * sx;
    const b = x1 + 0.06 * sx;
    const ya = Math.min(fh - 0.05, wy1 + 0.04 * sy);
    const yb = Math.min(fh - 0.01, wy1 + 0.26 * sy);
    wallBox(walls, w, s0 + a, s0 + b, y0 + ya, y0 + yb, 0, 0.16, [uv(a, ya), uv(b, ya), uv(b, yb), uv(a, yb)], "metal", { top: false, ends: false });
  }
  if (win.hood) {
    // Door canopy: a thin slab 0.7 m deep.
    const a = x0 - 0.3;
    const b = x1 + 0.3;
    const ya = Math.min(fh - 0.14, wy1 + 0.16);
    const L = b - a;
    wallBox(walls, w, s0 + a, s0 + b, y0 + ya, y0 + ya + 0.12, 0, 0.72, [bandUV("plain", 0, 0.2), bandUV("plain", L, 0.2), bandUV("plain", L, 0.45), bandUV("plain", 0, 0.45)], "plain", { bottomBand: "soffit", ends: false });
  }
  return [s0 + x0, s0 + x1];
}

/** An air-conditioner outdoor unit standing on (s, y) in front of a wall. */
function acUnit(f: Faces, w: WallFrame, s: number, y: number, d0 = 0.06): void {
  wallBox(f, w, s - 0.4, s + 0.4, y, y + 0.6, d0, d0 + 0.3, [propUV("ac", 0, 0), propUV("ac", 1, 0), propUV("ac", 1, 1), propUV("ac", 0, 1)], "metal", { bottom: false });
}

export function buildBuildings(w: KamakuraWorld): void {
  const tex = facadeAtlas(w.lib);
  const facade = w.lib.facade(tex);
  // The same atlas on the glass panes, smooth: they reflect the sky probe over the painted rooms.
  const paneMat = w.lib.printed("facade-glass", tex, 0.06);
  paneMat.envMapIntensity = 1.35;
  const r = new Rng(2026);
  const walls = new Faces();
  const glass = new Faces();
  glass.tint = [1, 1, 1];
  const railPanes: BufferGeometry[] = [];
  const views = Object.values(VIEW).map((v) => [v.x, v.z] as [number, number]);
  /** Viewpoints in front of a wall (by more than 1 m) and within `RELIEF_M`. */
  const seen = (fr: WallFrame, len: number) =>
    views.some(([vx, vz]) => {
      const mx = fr.ax + fr.tx * len * 0.5;
      const mz = fr.az + fr.tz * len * 0.5;
      const dx = vx - mx;
      const dz = vz - mz;
      return dx * fr.nx + dz * fr.nz > 1 && Math.hypot(dx, dz) < RELIEF_M;
    });
  let reliefBays = 0;

  /** A wall from y0 up to y1, storeys `fh` tall; `rowOf(f)` picks the atlas row per storey. */
  const wallStoreys = (fr: WallFrame, len: number, y0: number, y1: number, rowOf: (f: number) => number, fh: number, off: number, relief: boolean) => {
    const nb = Math.max(1, Math.round(len / FACADE.bay));
    const bw = len / nb;
    for (let f = 0, y = y0; y < y1 - 0.05; f++, y += fh) {
      const ya = y;
      const yb = Math.min(y1, y + fh);
      const row = rowOf(f);
      const full = yb - ya > fh * 0.92;
      if (!relief || !full) {
        const vb = wallUV(row, 0, 0, 0)[1];
        const vt = wallUV(row, 0, 0, ((yb - ya) / fh) * FACADE.floor)[1];
        const u0 = off / FACADE.bays;
        const u1 = (off + nb) / FACADE.bays;
        walls.quad(fr.p(0, ya), fr.p(len, ya), fr.p(len, yb), fr.p(0, yb), [u0, vb], [u1, vb], [u1, vt], [u0, vt], fr.out);
        continue;
      }
      // Full-height solid strips between the openings span bays (u runs on along the wall).
      const U = (s: number, yy: number): UV => wallUV(row, off, (s / bw) * FACADE.bay, (yy / fh) * FACADE.floor);
      const strip = (sa: number, sb: number) => {
        if (sb - sa > 0.005) walls.quad(fr.p(sa, ya), fr.p(sb, ya), fr.p(sb, yb), fr.p(sa, yb), U(sa, 0), U(sb, 0), U(sb, fh), U(sa, fh), fr.out);
      };
      let run = 0;
      for (let k = 0; k < nb; k++) {
        const win = LAYOUT[row][(off + k) % FACADE.bays];
        if (!win) continue;
        const [a, b] = windowBay(walls, glass, fr, row, off + k, k * bw, ya, bw, fh, win);
        strip(run, a);
        run = b;
        reliefBays++;
      }
      strip(run, len);
    }
  };

  for (const [base, height, storeys, use, ring0] of BUILDINGS) {
    // Walls run counter-clockwise seen from above so they face outward.
    const ring = area(ring0) > 0 ? reverse(ring0) : ring0;
    const n = ring.length / 2;
    if (n < 3) continue;
    let north = 0;
    let east = 0;
    for (let i = 0; i < n; i++) {
      north -= ring[i * 2 + 1] / n;
      east += ring[i * 2] / n;
    }
    const foot = Math.abs(area(ring));
    // Apartments and the welfare block are tiled blocks; the villas east of the crossing are
    // white modern boxes (p09), some with a dark-boarded wing; houses with siding up the hill.
    const kind: Kind =
      use === 1 || use === 3 || foot > 380 ? "apt" : north < 45 && east > 5 && east < 90 ? r.pick(["villa", "villa", "clad"] as const) : north < 45 ? r.pick(["villa", "villa", "house", "clad"] as const) : r.pick(["villa", "house", "house", "apt"] as const);
    const wallTint: P3 = kind === "apt" ? WALLS[r.pick([1, 2, 3, 4])] : kind === "house" ? r.pick(WALLS) : WALLS[r.pick([0, 0, 1, 4])];
    const roofTint = r.pick(ROOFS);
    const off = r.int(0, FACADE.bays - 1);
    const h = Math.max(2.8, height);
    const st = storeys > 0 ? storeys : Math.max(1, Math.round(h / 3));
    const floorH = Math.max(h / 5, Math.min(3.4, Math.max(2.6, (h - 0.5) / st)));
    let ground = Infinity;
    for (let i = 0; i < n; i++) ground = Math.min(ground, hillY(ring[i * 2], ring[i * 2 + 1]));
    const yb = Math.min(base - 0.3, ground - 0.4);
    const top = base + h;
    const frames: { fr: WallFrame; len: number; relief: boolean }[] = [];
    let per = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2];
      const az = ring[i * 2 + 1];
      const len = Math.hypot(ring[j * 2] - ax, ring[j * 2 + 1] - az);
      if (len < 0.05) continue;
      const fr = new WallFrame(ax, az, (ring[j * 2] - ax) / len, (ring[j * 2 + 1] - az) / len);
      const relief = seen(fr, len);
      frames.push({ fr, len, relief });
      // Plinth.
      walls.tint = [0.85, 0.85, 0.84];
      walls.quad(fr.p(0, yb), fr.p(len, yb), fr.p(len, base), fr.p(0, base), bandUV("plinth", per, 1), bandUV("plinth", per + len, 1), bandUV("plinth", per + len, 0), bandUV("plinth", per, 0), fr.out);
      // Facade rows: a dark-boarded wing on the villas' short walls, the apartments' balcony side seaward.
      walls.tint = wallTint;
      let rowOf: (f: number) => number;
      if (kind === "clad" && len < 8) {
        walls.tint = [1, 1, 1];
        rowOf = () => ROWS.clad;
      } else if (kind === "villa" || kind === "clad") rowOf = (f) => (f === 0 ? ROWS.villaG : ROWS.villaU);
      else if (kind === "house") rowOf = (f) => (f === 0 ? ROWS.houseG : ROWS.houseU);
      else rowOf = fr.nz > 0.3 && len > 6 ? (f) => (f === 0 ? ROWS.aptBack : ROWS.apt) : () => ROWS.aptBack;
      wallStoreys(fr, len, base, top, rowOf, floorH, (off + Math.round(per / FACADE.bay)) % FACADE.bays, relief);
      per += len;
    }
    const anyRelief = frames.some((e) => e.relief);
    const floors = Math.max(1, Math.min(st, Math.floor(h / floorH + 0.1)));

    // ---- villas: a balcony slab with a glass balustrade on each seaward or west wall, every upper floor.
    if ((kind === "villa" || kind === "clad") && h > 5.5 && north < 160) {
      for (const { fr, len, relief } of frames) {
        if (len < 4 || (fr.nz < 0.5 && fr.nx > -0.7) || (kind === "clad" && len < 8)) continue;
        for (let f = 1; f < floors; f++) {
          const y = base + f * floorH - 0.18;
          walls.tint = wallTint;
          wallBox(walls, fr, 0, len, y, y + 0.18, 0, 1.05, [bandUV("plain", 0, 0.15), bandUV("plain", len, 0.15), bandUV("plain", len, 0.5), bandUV("plain", 0, 0.5)], "soffit", { top: true });
          if (!relief) continue;
          // Glass balustrade on the slab edge, aluminium top rail and posts.
          for (let s = 0; s < len - 0.1; s += 1.6) {
            const s1 = Math.min(len, s + 1.6);
            const a = fr.p(s + 0.04, y + 0.2, 1.0);
            const b = fr.p(s1 - 0.04, y + 0.2, 1.0);
            const g = new PlaneGeometry(Math.hypot(b[0] - a[0], b[2] - a[2]), 0.95);
            g.rotateY(-Math.atan2(b[2] - a[2], b[0] - a[0]));
            g.translate((a[0] + b[0]) / 2, y + 0.18 + 0.5, (a[2] + b[2]) / 2);
            railPanes.push(g);
          }
          walls.tint = [0.9, 0.9, 0.9];
          wallBox(walls, fr, 0, len, y + 1.16, y + 1.21, 0.97, 1.05, [bandUV("metal", 0, 0.3), bandUV("metal", len, 0.3), bandUV("metal", len, 0.6), bandUV("metal", 0, 0.6)], "metal", { ends: false });
          for (let s = 0.03; s < len; s += 1.6) stick(walls, fr, Math.min(s, len - 0.03), 1.01, y + 0.18, y + 1.17, 0.025, "metal", [fr.out, fr.along, neg(fr.along)]);
        }
      }
    }

    // ---- apartments: balconies with precast panels, partitions and outdoor units on the seaward side.
    if (kind === "apt" && floors > 1) {
      for (const { fr, len, relief } of frames) {
        if (len <= 6 || fr.nz <= 0.3) continue;
        const nb = Math.max(1, Math.round(len / FACADE.bay));
        const bw = len / nb;
        for (let f = 1; f < floors; f++) {
          const y = base + f * floorH - 0.16;
          walls.tint = wallTint;
          wallBox(walls, fr, 0, len, y, y + 0.16, 0, 1.2, [bandUV("plain", 0, 0.2), bandUV("plain", len, 0.2), bandUV("plain", len, 0.45), bandUV("plain", 0, 0.45)], "soffit");
          // Front panels, 1.1 m, one 2.6 m panel a bay; a coping on top.
          for (let k = 0; k < nb; k++) {
            const s0 = k * bw;
            const fx = (k % 2) * 0.5;
            wallBox(walls, fr, s0, s0 + bw, y + 0.16, y + 1.22, 1.08, 1.2, [propUV("panel", fx, 0), propUV("panel", fx + 0.5, 0), propUV("panel", fx + 0.5, 1), propUV("panel", fx, 1)], "coping", { bottom: false, ends: k === 0 || k === nb - 1 });
            if (!relief) continue;
            // Partition between units every two bays, and the unit's air conditioner.
            if (k % 2 === 0 && k > 0) {
              const ps = s0;
              walls.quad(fr.p(ps, y + 0.16, 0), fr.p(ps, y + 0.16, 1.08), fr.p(ps, y + floorH - 0.2, 1.08), fr.p(ps, y + floorH - 0.2, 0), bandUV("soffit", 0, 0), bandUV("soffit", 1.08, 0), bandUV("soffit", 1.08, 1), bandUV("soffit", 0, 1), fr.along);
              walls.quad(fr.p(ps, y + 0.16, 0), fr.p(ps, y + 0.16, 1.08), fr.p(ps, y + floorH - 0.2, 1.08), fr.p(ps, y + floorH - 0.2, 0), bandUV("soffit", 0, 0), bandUV("soffit", 1.08, 0), bandUV("soffit", 1.08, 1), bandUV("soffit", 0, 1), neg(fr.along));
            }
            if (k % 2 === 0) {
              walls.tint = [1, 1, 1];
              acUnit(walls, fr, s0 + 0.55, y + 0.16, 0.25);
              walls.tint = wallTint;
            }
          }
        }
      }
    }

    // ---- houses near the viewpoints: an outdoor unit and the meter box against the ground storey.
    if (kind !== "apt" && anyRelief) {
      const e = frames.find((x) => x.relief && x.len > 4);
      if (e) {
        walls.tint = [1, 1, 1];
        const nb = Math.max(1, Math.round(e.len / FACADE.bay));
        const k = r.int(0, nb - 1);
        const win = LAYOUT[kind === "house" ? ROWS.houseG : ROWS.villaG][(off + k) % FACADE.bays];
        if (!win || win.kind !== "slide") {
          const s = ((k + 0.5) * e.len) / nb;
          acUnit(walls, e.fr, s, Math.min(base + 1, hillY(...xz(e.fr.p(s, 0, 0.3)))) + 0.05, 0.08);
        }
        const ms = e.len - 0.6;
        wallBox(walls, e.fr, ms - 0.2, ms + 0.2, base + 1.2, base + 1.8, 0, 0.12, [propUV("meter", 0, 0), propUV("meter", 1, 0), propUV("meter", 1, 1), propUV("meter", 0, 1)], "metal");
      }
    }

    // ---- downpipes at two corners seen from the viewpoints.
    if (anyRelief) {
      walls.tint = kind === "clad" ? [0.35, 0.33, 0.32] : [0.86, 0.86, 0.85];
      let pipes = 0;
      for (const { fr, len, relief } of frames) {
        if (!relief || pipes >= 2 || len < 3) continue;
        stick(walls, fr, len - 0.12, 0.07, yb + 0.3, top + 0.3, 0.04, "metal", [fr.out, fr.along, neg(fr.along)]);
        pipes++;
      }
    }

    // ---- roof: gabled on small rectangular houses, flat with a coped parapet elsewhere.
    walls.tint = roofTint;
    if (n === 4 && use === 0 && kind === "house" && h < 10 && r.chance(0.6)) {
      const P = [0, 1, 2, 3].map((i) => new Vector3(ring[i * 2], top, ring[i * 2 + 1]));
      const l01 = P[0].distanceTo(P[1]);
      const l12 = P[1].distanceTo(P[2]);
      // Ridge across the short ends; eaves 0.45 m out on every side.
      const [a, b, c, d] = l01 < l12 ? [P[0], P[1], P[2], P[3]] : [P[1], P[2], P[3], P[0]];
      const ex = b.clone().sub(a).normalize().multiplyScalar(0.45);
      const ez = d.clone().sub(a).normalize().multiplyScalar(0.45);
      const A = a.clone().sub(ex).sub(ez).setY(top - 0.12);
      const B = b.clone().add(ex).sub(ez).setY(top - 0.12);
      const C = c.clone().add(ex).add(ez).setY(top - 0.12);
      const D = d.clone().sub(ex).add(ez).setY(top - 0.12);
      const rise = Math.min(1.6, a.distanceTo(b) * 0.28);
      const m0 = a.clone().add(b).multiplyScalar(0.5).sub(ez).setY(top + rise);
      const m1 = c.clone().add(d).multiplyScalar(0.5).add(ez).setY(top + rise);
      const q = (p: Vector3): P3 => [p.x, p.y, p.z];
      const dir = ez.clone().normalize();
      const ru = (p: Vector3): UV => bandUV("roof", p.x * dir.x + p.z * dir.z, 0.5);
      // The two slopes (each seen from above and, under the eaves, from below).
      for (const [p, q2, m, mm] of [
        [B, C, m1, m0],
        [D, A, m0, m1],
      ] as Vector3[][]) {
        walls.quad(q(p), q(q2), q(m), q(mm), ru(p), ru(q2), ru(m), ru(mm), UP);
        walls.tint = [0.8, 0.8, 0.78];
        walls.quad(q(p), q(q2), q(m), q(mm), bandUV("soffit", 0, 0), bandUV("soffit", 1, 0), bandUV("soffit", 1, 1), bandUV("soffit", 0, 1), DOWN);
        walls.tint = roofTint;
      }
      // Gable ends in the wall's render.
      walls.tint = wallTint;
      const mid = a.clone().add(c).multiplyScalar(0.5);
      const ga = m0.clone().add(ez).setY(top + rise - 0.1);
      const gb = m1.clone().sub(ez).setY(top + rise - 0.1);
      walls.triOut(q(a), q(b), q(ga), bandUV("plain", 0, 1), bandUV("plain", 1, 1), bandUV("plain", 0.5, 0), ga.clone().sub(mid).setY(0).toArray() as P3);
      walls.triOut(q(c), q(d), q(gb), bandUV("plain", 0, 1), bandUV("plain", 1, 1), bandUV("plain", 0.5, 0), gb.clone().sub(mid).setY(0).toArray() as P3);
      // Fascia along the eaves.
      walls.tint = [0.85, 0.85, 0.83];
      for (const [p, q2] of [
        [B, C],
        [D, A],
      ] as Vector3[][]) {
        const o = q2.clone().sub(p).cross(new Vector3(0, 1, 0)).normalize();
        if (o.dot(p.clone().sub(mid)) < 0) o.negate();
        const L = p.distanceTo(q2);
        walls.quad(q(p), q(q2), q(q2.clone().setY(q2.y - 0.14)), q(p.clone().setY(p.y - 0.14)), bandUV("metal", 0, 0), bandUV("metal", L, 0), bandUV("metal", L, 1), bandUV("metal", 0, 1), o.toArray() as P3);
      }
    } else {
      // Parapet: the wall carried 0.5 m above the roof, plain render, with an aluminium coping.
      walls.tint = wallTint;
      const villa = kind === "villa" || kind === "clad";
      frames.forEach(({ fr, len, relief }, i) => {
        if (!villa || !relief) return;
        // A thin roof slab projecting 0.4 m along the villas' near walls: the shadow line under the roof edge.
        const e = 0.002 * (i % 3);
        walls.tint = wallTint;
        wallBox(walls, fr, -0.4, len + 0.4, top - 0.24 + e, top + e, 0, 0.4, [bandUV("plain", 0, 0.25), bandUV("plain", len, 0.25), bandUV("plain", len, 0.6), bandUV("plain", 0, 0.6)], "coping", { bottomBand: "soffit", ends: false });
      });
      for (const { fr, len, relief } of frames) {
        const outV = fr.out;
        walls.quad(fr.p(0, top), fr.p(len, top), fr.p(len, top + 0.5), fr.p(0, top + 0.5), bandUV("plain", 0, 1), bandUV("plain", len, 1), bandUV("plain", len, 0), bandUV("plain", 0, 0), outV);
        // Near walls: the coping, its nose and the parapet's inner face (seen across the roof from above).
        if (relief) {
          walls.tint = [0.95, 0.95, 0.95];
          walls.quad(fr.p(-0.02, top + 0.5, -0.17), fr.p(len + 0.02, top + 0.5, -0.17), fr.p(len + 0.02, top + 0.53, 0.03), fr.p(-0.02, top + 0.53, 0.03), bandUV("coping", 0, 0), bandUV("coping", len, 0), bandUV("coping", len, 1), bandUV("coping", 0, 1), UP);
          walls.quad(fr.p(-0.02, top + 0.45, 0.03), fr.p(len + 0.02, top + 0.45, 0.03), fr.p(len + 0.02, top + 0.53, 0.03), fr.p(-0.02, top + 0.53, 0.03), bandUV("coping", 0, 0.2), bandUV("coping", len, 0.2), bandUV("coping", len, 0.8), bandUV("coping", 0, 0.8), outV);
          walls.tint = wallTint;
          walls.quad(fr.p(0, top, -0.15), fr.p(len, top, -0.15), fr.p(len, top + 0.5, -0.15), fr.p(0, top + 0.5, -0.15), bandUV("plain", 0, 1), bandUV("plain", len, 1), bandUV("plain", len, 0), bandUV("plain", 0, 0), neg(outV));
        }
        walls.tint = wallTint;
      }
      walls.tint = roofTint;
      const pts: Vector2[] = [];
      for (let i = 0; i < n; i++) pts.push(new Vector2(ring[i * 2], ring[i * 2 + 1]));
      const tris = ShapeUtils.triangulateShape(pts, []);
      for (const t of tris) {
        const [a, b, c] = t.map((i) => pts[i]);
        walls.triOut([a.x, top, a.y], [b.x, top, b.y], [c.x, top, c.y], bandUV("roof", a.x), bandUV("roof", b.x), bandUV("roof", c.x), UP);
      }
    }
  }
  // Beyond PLATEAU's ±250 m: rows of two-storey houses along the coast, which also hide the
  // track where it bends inland toward Shichirigahama.
  const box = (cx: number, cz: number, wid: number, dep: number, yaw: number, h: number) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const ring: number[] = [];
    for (const [a, b] of [
      [-wid / 2, -dep / 2],
      [-wid / 2, dep / 2],
      [wid / 2, dep / 2],
      [wid / 2, -dep / 2],
    ])
      ring.push(cx + a * c + b * s, cz - a * s + b * c);
    return { ring, h };
  };
  const extra: { ring: number[]; h: number }[] = [];
  const pt = new Vector3();
  const nearTrack = (x: number, z: number) => {
    const u = TRACK.project(x, z);
    return TRACK.point(u, pt).distanceTo(new Vector3(x, pt.y, z)) < 9;
  };
  for (const [u0, u1, rows] of [
    [262, 780, [-9, -22, -36]],
    [-600, -232, [-10, -23]],
  ] as [number, number, number[]][]) {
    for (let u = u0; u < u1; u += r.range(13, 18))
      for (const s of rows) {
        const p = COAST.offset(u, s + r.range(-2, 2), new Vector3());
        if (nearTrack(p.x, p.z)) continue;
        const t = COAST.tangent(u, new Vector3());
        extra.push(box(p.x, p.z, r.range(8, 12), r.range(7, 10), Math.atan2(t.z, t.x) * -1, r.range(6, 9)));
      }
  }
  for (const e of extra) {
    let ground = Infinity;
    for (let i = 0; i < 4; i++) ground = Math.min(ground, hillY(e.ring[i * 2], e.ring[i * 2 + 1]));
    const base = ground + 0.3;
    const house = r.chance(0.55);
    walls.tint = r.pick(WALLS);
    const top = base + e.h;
    const off = r.int(0, FACADE.bays - 1);
    const ring = area(e.ring) > 0 ? reverse(e.ring) : e.ring;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const [ax, az, bx, bz] = [ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1]];
      const len = Math.hypot(bx - ax, bz - az);
      const fr = new WallFrame(ax, az, (bx - ax) / len, (bz - az) / len);
      wallStoreys(fr, len, ground - 0.4, top, (f) => (f === 0 ? (house ? ROWS.houseG : ROWS.villaG) : house ? ROWS.houseU : ROWS.villaU), 2.9, (off + i * 3) % FACADE.bays, false);
    }
    walls.tint = r.pick(ROOFS);
    const P = [0, 1, 2, 3].map((i) => [ring[i * 2], top, ring[i * 2 + 1]] as P3);
    const ru = (p: P3) => bandUV("roof", p[0] + p[2]);
    walls.triOut(P[0], P[1], P[2], ru(P[0]), ru(P[1]), ru(P[2]), UP);
    walls.triOut(P[0], P[2], P[3], ru(P[0]), ru(P[2]), ru(P[3]), UP);
  }

  const houses = w.mesh(walls.geometry(), facade, 0, 0, 0, w.root, { cast: true });
  // Kept out of batching, which drops vertex colours; nothing animates it, so it cooks as static.
  houses.userData.noBatch = true;
  houses.name = "hillside-houses";
  const panes = w.mesh(glass.geometry(false), paneMat, 0, 0, 0, w.root, { cast: false });
  panes.name = "hillside-windows";
  if (railPanes.length) w.mesh(merge(railPanes), w.lib.glassRail(), 0, 0, 0, w.root, { cast: false }).name = "villa-balustrades";
  console.info(`[kamakura:buildings] ${walls.triangles} wall triangles, ${glass.triangles} pane triangles, ${reliefBays} window bays in relief`);

  villas(w);
}

const xz = (p: P3): [number, number] => [p[0], p[2]];

function reverse(ring: number[]): number[] {
  const out: number[] = [];
  for (let i = ring.length / 2 - 1; i >= 0; i--) out.push(ring[i * 2], ring[i * 2 + 1]);
  return out;
}

/** Garage shutter: cream steel slats with a bottom rail and a dark slot under the hood. */
function shutter(g: CanvasRenderingContext2D, cw: number, ch: number): void {
  g.fillStyle = "#d9d5c9";
  g.fillRect(0, 0, cw, ch);
  for (let y = 10; y < ch - 8; y += 7) {
    g.fillStyle = "rgba(90,86,78,0.35)";
    g.fillRect(0, y, cw, 1.5);
    g.fillStyle = "rgba(255,255,255,0.35)";
    g.fillRect(0, y + 2, cw, 1);
  }
  g.fillStyle = "#6e6a62";
  g.fillRect(0, 0, cw, 9);
  g.fillStyle = "#8c887e";
  g.fillRect(0, ch - 8, cw, 8);
  g.fillStyle = "rgba(60,50,40,0.18)";
  for (let x = 0; x < cw; x += 3) g.fillRect(x, ch * 0.7, 2, ch * 0.3 * (0.5 + 0.5 * Math.sin(x * 12.9898)));
}

/**
 * Close-up pieces of the villas east of the slope road (p01–p03, p05,
 * p09, p19): the stone-clad garage at the villa wall's north end with its
 * shutter facing the triangle, the block parapet and black steel fence on
 * the wall's coping, the round tower and ledgestone column of the corner
 * villa, glass balustrades along the terraces, and the gardens: cycads,
 * fan palms, broadleaf shrubs and silver grass, on the terrace, the garage
 * roof, the planted triangle and the bank by the junction.
 */
function villas(w: KamakuraWorld): void {
  const lib = w.lib;
  const bag = new Bag();
  const green = new Greenery(5150);
  const r = green.r;
  const clad = lib.stoneClad();
  const ledge = lib.baked("ledgestone", SURF.LEDGE, { size: 512, tile: 1.2, bump: 3, normal: 1.4, ao: 1 });

  // ---- the garage block: west face on the wall top, shutter on its north face (p01, p02).
  const gx0 = wallTop(WALK.to) + 0.55;
  const gx1 = gx0 + 2.6;
  const gn0 = WALK.to - 3.2;
  const gn1 = TRIANGLE.from + 0.4;
  const gy0 = 3.0;
  const gy1 = terraceY(WALK.to) + 0.85;
  bag.add(clad, place(new BoxGeometry(gx1 - gx0, gy1 - gy0, gn1 - gn0), new Vector3((gx0 + gx1) / 2, (gy0 + gy1) / 2, -(gn0 + gn1) / 2)));
  bag.add(lib.concrete(), place(new BoxGeometry(gx1 - gx0 + 0.16, 0.14, gn1 - gn0 + 0.16), new Vector3((gx0 + gx1) / 2, gy1 + 0.07, -(gn0 + gn1) / 2)));
  {
    const cell = w.draw("garage-shutter", 256, 224, shutter);
    const sh = mapUV(new PlaneGeometry(2.4, 2.1), cell);
    sh.rotateY(Math.PI);
    sh.translate(gx0 + 1.55, 3.45 + 1.05, -gn1 - 0.025);
    bag.add(w.printed, sh, false);
    // Hood over the shutter.
    bag.add(w.printed, w.tint(place(new BoxGeometry(2.6, 0.22, 0.2), new Vector3(gx0 + 1.55, 3.45 + 2.2, -gn1 - 0.1)), "beige"));
  }

  // ---- parapet and fence on the villa wall's coping (p19: split-face block, black steel fence).
  const posts: BufferGeometry[] = [];
  for (let n = WALK.from + 0.2; n < gn0; n += 1) {
    const n1 = Math.min(gn0, n + 1);
    const block = n > 15;
    const a = new Vector3(wallTop(n) + 0.12, terraceY(n) + 0.14, -n);
    const b = new Vector3(wallTop(n1) + 0.12, terraceY(n1) + 0.14, -n1);
    const len = a.distanceTo(b);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    // A split-face block parapet next to the garage (p01), the bare coping further south.
    const ph = block ? 0.55 : 0;
    if (block) bag.add(clad, place(new BoxGeometry(0.16, ph, len + 0.01), mid.clone().setY(mid.y + ph / 2), yaw));
    posts.push(place(new BoxGeometry(0.04, 0.85, 0.04), a.clone().setY(a.y + ph + 0.42)));
    posts.push(place(new BoxGeometry(0.03, 0.03, len), mid.clone().setY(mid.y + ph + 0.82), yaw));
    posts.push(place(new BoxGeometry(0.02, 0.02, len), mid.clone().setY(mid.y + ph + 0.12), yaw));
    for (let k = 0.12; k < len; k += 0.12) posts.push(place(new BoxGeometry(0.012, 0.7, 0.012), a.clone().lerp(b, k / len).setY(mid.y + ph + 0.47)));
  }
  bag.add(w.printed, w.tint(merge(posts), "black"), false);

  // ---- round-tower villa NE of the crossing (PLATEAU 19.6, 8.3 N; ground 14.2 m T.P.; p09).
  const base = 4.0;
  const tower = new CylinderGeometry(2.3, 2.3, 9.4, 24, 1, true);
  tower.translate(21.8, base + 4.7, -6.1);
  bag.add(lib.stucco("cream"), tower);
  const cap = new CylinderGeometry(2.45, 2.45, 0.28, 24);
  cap.translate(21.8, base + 9.5, -6.1);
  bag.add(lib.stucco("white"), cap);
  // Tower windows in pale frames, two storeys round the seaward half (p09).
  const panes: BufferGeometry[] = [];
  const frames: BufferGeometry[] = [];
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI * 0.2 + k * 0.38;
    for (const y of [base + 2.1, base + 5.5]) {
      const p = new PlaneGeometry(0.85, 1.5);
      p.translate(0, 0, 2.32);
      p.rotateY(a);
      p.translate(21.8, y, -6.1);
      panes.push(p);
      const f = new BoxGeometry(1.0, 1.66, 0.06);
      f.translate(0, 0, 2.3);
      f.rotateY(a);
      f.translate(21.8, y, -6.1);
      frames.push(f);
    }
  }
  bag.add(lib.paint("aluminium"), merge(frames), false);
  bag.add(lib.glass(), merge(panes), false);
  // Ledgestone columns either side of the tower (p09).
  for (const [x, z] of [
    [18.9, -5.2],
    [24.6, -7.3],
  ])
    bag.add(ledge, place(new BoxGeometry(1.3, 9.9, 1.1), new Vector3(x, base + 4.95, z)));

  // ---- glass balustrades: on the garage roof and along the track-side terrace (p09).
  const glass = lib.glassRail();
  const rails: BufferGeometry[] = [];
  const steel: BufferGeometry[] = [];
  const pane = (a: Vector3, b: Vector3, h = 1.05) => {
    const len = a.distanceTo(b);
    const g = new PlaneGeometry(len, h);
    g.rotateY(-Math.atan2(b.z - a.z, b.x - a.x));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2 + h / 2 + 0.05, (a.z + b.z) / 2);
    rails.push(g);
    steel.push(place(new BoxGeometry(0.05, h + 0.1, 0.05), a.clone().setY(a.y + (h + 0.1) / 2)));
    const top = new BoxGeometry(len, 0.04, 0.06);
    top.rotateY(-Math.atan2(b.z - a.z, b.x - a.x));
    top.translate((a.x + b.x) / 2, (a.y + b.y) / 2 + h + 0.08, (a.z + b.z) / 2);
    steel.push(top);
  };
  pane(new Vector3(gx0 + 0.1, gy1 + 0.14, -gn1 + 0.1), new Vector3(gx1 - 0.1, gy1 + 0.14, -gn1 + 0.1));
  pane(new Vector3(gx0 + 0.1, gy1 + 0.14, -gn0), new Vector3(gx0 + 0.1, gy1 + 0.14, -gn1 + 0.1));
  for (let u = 9; u < 62; u += 3) {
    const a = COAST.offset(u, -3.6, new Vector3());
    const b = COAST.offset(u + 3, -3.6, new Vector3());
    a.y = hillY(a.x, a.z);
    b.y = hillY(b.x, b.z);
    pane(a, b, 1.6);
  }
  bag.add(glass, merge(rails), false);
  bag.add(lib.paint("aluminium"), merge(steel), false);

  // ---- gardens.
  const at = (x: number, n: number) => new Vector3(x, hillY(x, -n), -n);
  // Terrace behind the parapet: shrubs spilling over, cycads and a fan palm (p01, p02, p19).
  for (let n = WALK.from + 1.0; n < gn0; n += r.range(1.4, 2.2)) {
    const x = wallTop(n) + r.range(1.3, 2.2);
    green.shrub(at(x, n), r.range(0.7, 1.0), r.range(1.3, 2.0), r.chance(0.6) ? "shrub" : "box");
    if (r.chance(0.45)) green.cycad(at(x + r.range(1.0, 2.2), n + r.range(-0.5, 0.5)), r.range(0.9, 1.25));
  }
  // The lush mass behind the garage and along the wall's north half (p01 upper left): big
  // broadleaf shrubs, cycads and a palm, darker in the shade of each other.
  for (let n = 12; n < gn0 + 1.5; n += r.range(1.6, 2.4)) {
    const x = wallTop(n) + r.range(1.8, 4.5);
    green.shrub(at(x, n), r.range(1.1, 1.5), r.range(2.2, 3.2), "shrub", 1.1);
    if (r.chance(0.6)) green.cycad(at(x + r.range(-1.2, 1.2), n + r.range(-0.8, 0.8)), r.range(1.2, 1.5));
  }
  green.fanPalm(at(wallTop(9) + 2.4, 9), 5.5, new Vector3(-0.05, 0, 0.02));
  green.fanPalm(at(wallTop(16) + 2.8, 16.5), 6.8, new Vector3(-0.06, 0, -0.03));
  // On the garage roof: two cycads, a shrub and a palm behind (p01 upper left).
  green.cycad(new Vector3(gx0 + 0.9, gy1 + 0.14, -(gn0 + 1.2)), 1.2);
  green.cycad(new Vector3(gx0 + 2.1, gy1 + 0.14, -(gn1 - 0.9)), 1.05);
  green.shrub(new Vector3(gx1 - 0.6, gy1 + 0.14, -(gn0 + 0.8)), 0.9, 1.5, "shrub");
  green.fanPalm(at(gx1 + 1.6, gn0 + 0.6), 6.2, new Vector3(-0.08, 0, 0));
  for (let x = gx1 + 0.6; x < 18; x += r.range(1.6, 2.6)) green.shrub(at(x, gn0 + r.range(-1.5, 1)), r.range(0.9, 1.3), r.range(1.4, 2.4));
  // The planted triangle: silver grass on the low wall's edge, lawn tufts, shrubs and cycads (p01 left).
  const triTop = (x: number, n: number) => new Vector3(x, slopeY(n) + triangleLift(n) + 0.03 * (x - eastKerb(n)), -n);
  // Short grass along the low wall's edge (the villa wall behind stays in view), silver grass further back.
  for (let n = TRIANGLE.from + 0.9; n < TRIANGLE.to - 0.4; n += r.range(0.35, 0.6)) {
    green.grass(triTop(eastKerb(n) + r.range(0.55, 0.9), n), r.range(0.3, 0.55), "grass");
    green.grass(triTop(eastKerb(n) + r.range(2.2, 3.4), n), r.range(0.8, 1.3), "tall");
  }
  for (let i = 0; i < 60; i++) {
    const n = r.range(TRIANGLE.from + 0.8, TRIANGLE.to - 0.6);
    const xMax = 7 + (TRIANGLE.to - n) * 1.2;
    const x = r.range(eastKerb(n) + 0.7, Math.min(xMax, 16));
    green.grass(triTop(x, n), r.range(0.25, 0.55), x > eastKerb(n) + 2 && r.chance(0.3) ? "tall" : "grass");
  }
  for (const [x, n, k] of [
    [7.2, 25.4, "cycad"],
    [9.6, 26.8, "shrub"],
    [6.8, 28.6, "shrub"],
    [11.8, 25.2, "cycad"],
    [14.2, 26.4, "shrub"],
  ] as [number, number, string][]) {
    if (k === "cycad") green.cycad(triTop(x, n), 1.1);
    else green.shrub(triTop(x, n), r.range(0.8, 1.1), r.range(1.0, 1.5), "box");
  }
  // The bank east of the junction above the camera corner (p01 far left): grass and shrubs.
  for (let i = 0; i < 26; i++) {
    const n = r.range(34, 58);
    const x = eastKerb(n) + r.range(4.5, 12);
    green.grass(at(x, n), r.range(0.5, 1.1), "tall");
  }
  for (const [x, n] of [
    [11, 44],
    [13.5, 50],
    [10.5, 55],
  ])
    green.shrub(at(x, n), 1.2, 1.8, "shrub");
  // Track-side gardens of the villas east of the crossing (p09): palms and shrubs above the glass screen.
  for (const [x, n, k] of [
    [14, 3.6, "palm"],
    [27, 3.9, "palm"],
    [33, 4.2, "shrub"],
    [44, 3.0, "palm"],
    [52, 2.0, "shrub"],
    [38, 3.6, "cycad"],
    [58, 1.6, "shrub"],
  ] as [number, number, string][]) {
    if (k === "palm") green.fanPalm(at(x, n), r.range(5.5, 7.5), new Vector3(r.range(-0.06, 0.06), 0, 0.04));
    else if (k === "cycad") green.cycad(at(x, n), 1.1);
    else green.shrub(at(x, n), 1.1, 1.8);
  }
  green.emit(w, "villa-gardens");
  bag.emit(w);
}
