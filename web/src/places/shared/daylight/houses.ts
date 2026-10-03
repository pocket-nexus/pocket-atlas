import { BufferGeometry, Matrix4, PlaneGeometry, Vector3, type Material } from "three";
import { Rng } from "../../../core/random";
import { canvas, toTexture } from "../canvas";
import { box } from "../geo";
import { merge, rod, v3 } from "../shapes";
import type { DayWorld } from "./context";
import { QuadBuilder } from "./geometry";

type Side = "-x" | "+x" | "-z" | "+z";
export type RoofKind = "gable" | "hip" | "shed" | "flat";
type WinKind = "sash" | "door" | "small" | "tall" | "wide";

export interface HouseSpec {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Floor level (top of the foundation). */
  base: number;
  /** Lowest visible ground next to the house (foundation reaches down to it). */
  foot?: number;
  floors: number;
  floorH?: number;
  wall: Material;
  roof: { kind: RoofKind; ridge?: "x" | "z"; mat: Material; pitch?: number; low?: Side };
  /** Faces that get windows; `balcony` puts one on the named upper floor. */
  faces: Partial<Record<Side, { floors?: number[]; balcony?: number; door?: boolean; dense?: number }>>;
  detail?: "near" | "mid";
  solar?: boolean;
  seed: number;
}

/** Shared finishes for every house (one batch each). */
export interface HouseKit {
  frameBronze: Material;
  frameSilver: Material;
  glassDark: Material;
  glassCurtain: Material;
  glassFrosted: Material;
  trim: Material;
  dark: Material;
  shutter: Material;
  foundation: Material;
  slab: Material;
  door: Material;
  ac: Material;
  bars: Material;
  panel: Material;
  pv: Material;
  laundry: Material[];
}

const FACE: Record<Side, { n: Vector3; along: Vector3 }> = {
  "-x": { n: v3(-1, 0, 0), along: v3(0, 0, 1) },
  "+x": { n: v3(1, 0, 0), along: v3(0, 0, -1) },
  "-z": { n: v3(0, 0, -1), along: v3(-1, 0, 0) },
  "+z": { n: v3(0, 0, 1), along: v3(1, 0, 0) },
};

function faceOrigin(s: HouseSpec, side: Side): Vector3 {
  switch (side) {
    case "-x":
      return v3(s.x0, 0, s.z0);
    case "+x":
      return v3(s.x1, 0, s.z1);
    case "-z":
      return v3(s.x1, 0, s.z0);
    case "+z":
      return v3(s.x0, 0, s.z1);
  }
}

function faceLength(s: HouseSpec, side: Side): number {
  return side === "-x" || side === "+x" ? s.z1 - s.z0 : s.x1 - s.x0;
}

/** Matrix from face-local (x along, y up, z outward) to world. */
function faceMatrix(s: HouseSpec, side: Side): Matrix4 {
  const f = FACE[side];
  const o = faceOrigin(s, side);
  return new Matrix4().makeBasis(f.along, v3(0, 1, 0), f.n).setPosition(o);
}

/** Collects face-local pieces per material and emits them in world space. */
class Pieces {
  private map = new Map<Material, BufferGeometry[]>();
  add(m: Material, g: BufferGeometry, mtx?: Matrix4): void {
    if (mtx) g.applyMatrix4(mtx);
    let l = this.map.get(m);
    if (!l) this.map.set(m, (l = []));
    l.push(g);
  }
  emit(w: DayWorld, cast = true): void {
    for (const [m, gs] of this.map) if (gs.length) w.mesh(merge(gs), m, 0, 0, 0, w.root, { cast });
    this.map.clear();
  }
}

/** Box in face-local coordinates: x ∈ [x0, x1], y ∈ [y0, y1], z ∈ [z0, z1]. */
function lbox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): BufferGeometry {
  const g = box(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** Plane facing +z (face-local) with UVs in metres. */
function lplane(x0: number, x1: number, y0: number, y1: number, z: number, swapUV = false): BufferGeometry {
  const g = new PlaneGeometry(x1 - x0, y1 - y0);
  const uv = g.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) {
    const u = x0 + uv.getX(i) * (x1 - x0);
    const vv = y0 + uv.getY(i) * (y1 - y0);
    if (swapUV) uv.setXY(i, vv, u);
    else uv.setXY(i, u, vv);
  }
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
  return g;
}

const WIN: Record<WinKind, { w: number; h: number; sill: number }> = {
  sash: { w: 1.65, h: 1.1, sill: 0.9 },
  wide: { w: 2.55, h: 1.1, sill: 0.9 },
  door: { w: 1.65, h: 1.95, sill: 0.02 },
  small: { w: 0.6, h: 0.9, sill: 1.25 },
  tall: { w: 0.75, h: 1.55, sill: 0.55 },
};

/** A window with its aluminium frame, glass, and optional shutter box or bars. */
function windowAt(p: Pieces, k: HouseKit, r: Rng, m: Matrix4, cx: number, y0: number, kind: WinKind, near: boolean): void {
  const { w, h } = WIN[kind];
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y1 = y0 + h;
  const glass = kind === "small" ? k.glassFrosted : r.chance(0.45) ? k.glassCurtain : k.glassDark;
  if (!near) {
    p.add(glass, lplane(x0, x1, y0, y1, 0.02), m);
    return;
  }
  const frame = r.chance(0.6) ? k.frameBronze : k.frameSilver;
  const t = 0.045;
  const closed = (kind === "sash" || kind === "door") && r.chance(0.14);
  p.add(closed ? k.shutter : glass, lplane(x0 + t, x1 - t, y0 + t, y1 - t, 0.012, closed), m);
  p.add(frame, lbox(x0, x1, y0, y0 + t, 0, 0.06), m);
  p.add(frame, lbox(x0, x1, y1 - t, y1, 0, 0.06), m);
  p.add(frame, lbox(x0, x0 + t, y0, y1, 0, 0.06), m);
  p.add(frame, lbox(x1 - t, x1, y0, y1, 0, 0.06), m);
  if (kind !== "small" && kind !== "tall") {
    // Two sliding sashes: the meeting stiles overlap at the centre.
    p.add(frame, lbox(cx - 0.035, cx + 0.005, y0 + t, y1 - t, 0.018, 0.05), m);
    p.add(frame, lbox(cx - 0.005, cx + 0.035, y0 + t, y1 - t, 0.03, 0.062), m);
  }
  // Sill flashing.
  p.add(k.trim, lbox(x0 - 0.03, x1 + 0.03, y0 - 0.03, y0, 0, 0.09), m);
  if ((kind === "sash" || kind === "door" || kind === "wide") && r.chance(0.6)) {
    // Shutter box (雨戸) above the opening, shutters parked in a side pocket.
    p.add(k.shutter, lbox(x0 - 0.05, x1 + 0.05, y1, y1 + 0.24, 0, 0.16), m);
  }
  if (kind === "small") {
    for (let i = 1; i <= 4; i++) p.add(frame, lbox(x0 + (w * i) / 5 - 0.008, x0 + (w * i) / 5 + 0.008, y0, y1, 0.07, 0.085), m);
    p.add(frame, lbox(x0 - 0.02, x1 + 0.02, y1 - 0.02, y1 + 0.01, 0.06, 0.1), m);
    p.add(frame, lbox(x0 - 0.02, x1 + 0.02, y0 - 0.01, y0 + 0.02, 0.06, 0.1), m);
  }
}

/** Air-conditioner outdoor unit, face-local, standing at (cx, y0) in front of the wall. */
function acUnit(p: Pieces, k: HouseKit, m: Matrix4, cx: number, y0: number, z0 = 0.05): void {
  p.add(k.ac, lbox(cx - 0.39, cx + 0.39, y0, y0 + 0.55, z0, z0 + 0.28), m);
  p.add(k.dark, lplane(cx - 0.3, cx + 0.08, y0 + 0.07, y0 + 0.47, z0 + 0.283), m);
  p.add(k.dark, lbox(cx + 0.2, cx + 0.23, y0 + 0.2, y0 + 1.4, 0.02, 0.05), m);
}

/**
 * One house: foundation, walls, floor bands, windows, a balcony, the door and
 * its canopy, gutters and downpipes, and the roof (gable, hip, shed or flat
 * with parapet). `mid` detail keeps the massing, roof and window glass only.
 */
export function house(w: DayWorld, k: HouseKit, s: HouseSpec): void {
  const r = new Rng(s.seed);
  const near = (s.detail ?? "near") === "near";
  const fh = s.floorH ?? 2.8;
  const fnd = near ? 0.45 : 0.3;
  const wallY0 = s.base + fnd;
  const top = wallY0 + s.floors * fh;
  const p = new Pieces();
  const W = s.x1 - s.x0;
  const D = s.z1 - s.z0;
  const cx = (s.x0 + s.x1) / 2;
  const cz = (s.z0 + s.z1) / 2;

  // Foundation (down to the lowest ground beside it) and walls.
  const foot = s.foot ?? s.base - 0.4;
  if (near) {
    const f = box(W + 0.04, wallY0 - foot, D + 0.04);
    f.translate(cx, (foot + wallY0) / 2, cz);
    p.add(k.foundation, f);
  }
  const bodyY0 = near ? wallY0 : foot;
  const body = box(W, top - bodyY0, D);
  body.translate(cx, (bodyY0 + top) / 2, cz);
  p.add(s.wall, body);
  if (near) {
    // Floor bands (水切り) between storeys.
    for (let i = 1; i < s.floors; i++) {
      const b = box(W + 0.05, 0.05, D + 0.05);
      b.translate(cx, wallY0 + i * fh, cz);
      p.add(k.trim, b);
    }
    const b0 = box(W + 0.05, 0.04, D + 0.05);
    b0.translate(cx, wallY0 + 0.02, cz);
    p.add(k.dark, b0);
  }

  // Openings.
  for (const [side, spec] of Object.entries(s.faces) as [Side, NonNullable<HouseSpec["faces"][Side]>][]) {
    const m = faceMatrix(s, side);
    const len = faceLength(s, side);
    const floors = spec.floors ?? Array.from({ length: s.floors }, (_, i) => i);
    for (const fl of floors) {
      const y0 = wallY0 - s.base + fl * fh;
      const balcony = spec.balcony === fl && near;
      if (balcony) {
        buildBalcony(p, k, r, m, 0.4, len - 0.4, s.base + y0, near);
        continue;
      }
      if (spec.balcony === fl && !near) {
        // Far balcony: slab and a solid parapet in the wall finish.
        const mb = m.clone().setPosition(new Vector3().setFromMatrixPosition(m).setY(s.base + y0));
        p.add(k.slab, lbox(0.3, len - 0.3, -0.12, 0, 0, 0.9), mb);
        p.add(r.chance(0.5) ? s.wall : k.panel, lbox(0.3, len - 0.3, 0, 1.0, 0.82, 0.9), mb);
      }
      // Pick a run of windows that fits the face, then spread them evenly.
      const kinds: WinKind[] = [];
      let used = 0;
      const dense = spec.dense ?? 1;
      for (;;) {
        const kind: WinKind = fl === 0 && spec.door && kinds.length === 0 ? "door" : r.pick(len > 6 ? ["sash", "sash", "wide", "small", "tall"] : ["sash", "small", "tall", "sash"]);
        const need = WIN[kind].w + r.range(0.9, 2.0) / dense;
        if (used + need > len - 0.5) break;
        kinds.push(kind);
        used += need;
      }
      if (!kinds.length) continue;
      const widths = kinds.reduce((a, q) => a + WIN[q].w, 0);
      const gap = (len - widths) / (kinds.length + 1);
      const mb = m.clone().setPosition(new Vector3().setFromMatrixPosition(m).setY(s.base));
      let x = gap;
      for (const kind of kinds) {
        const c = x + WIN[kind].w / 2;
        if (kind === "door" && fl === 0) doorAt(p, k, m, c, s.base + y0, near);
        else windowAt(p, k, r, mb, c, y0 + WIN[kind].sill, kind, near);
        x += WIN[kind].w + gap;
      }
      if (near && fl === 0 && gap > 1.1 && r.chance(0.55)) acUnit(p, k, mb, gap / 2, 0.05);
    }
  }

  if (near) {
    // Downpipes at two corners.
    for (const [x, z] of [
      [s.x0 - 0.06, s.z0 - 0.06],
      [s.x1 + 0.06, s.z1 + 0.06],
    ]) p.add(k.trim, rod(v3(x, s.base, z), v3(x, top, z), 0.032, 6));
  }

  buildRoof(p, k, s, top, near);
  // Rooftop clutter: stair penthouse and water tank on flat roofs, a TV aerial on some pitched ones.
  if (s.roof.kind === "flat" && W > 5 && D > 5 && r.chance(near ? 0.4 : 0.7)) {
    const pw = Math.min(3, W * 0.35);
    const pd = Math.min(3, D * 0.35);
    const px = s.x0 + 0.4 + r.next() * (W - pw - 0.8);
    const pz = s.z0 + 0.4 + r.next() * (D - pd - 0.8);
    const ph = r.chance(0.5) ? 2.4 : 1.2;
    const g = box(pw, ph, pd);
    g.translate(px + pw / 2, top + ph / 2, pz + pd / 2);
    p.add(ph > 2 ? s.wall : k.ac, g);
  } else if (s.roof.kind !== "flat" && Math.hypot(cx, cz) < 110 && r.chance(0.3)) {
    const ax = cx + r.range(-W / 4, W / 4);
    const az = cz + r.range(-D / 4, D / 4);
    const y0 = top + 1.0;
    p.add(k.frameSilver, rod(v3(ax, top, az), v3(ax, y0 + 1.8, az), 0.02, 4));
    const yaw = r.range(0, Math.PI);
    for (let i = 0; i < 5; i++) {
      const h = y0 + 1.5 - i * 0.02;
      const along = v3(Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(-0.5 + i * 0.25);
      const perp = v3(-Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(0.28 - i * 0.03);
      const c = v3(ax, h, az).add(along);
      p.add(k.frameSilver, rod(c.clone().sub(perp), c.clone().add(perp), 0.006, 3));
    }
    p.add(k.frameSilver, rod(v3(ax, y0 + 1.5, az).addScaledVector(v3(Math.cos(yaw), 0, Math.sin(yaw)), -0.6), v3(ax, y0 + 1.5, az).addScaledVector(v3(Math.cos(yaw), 0, Math.sin(yaw)), 0.6), 0.01, 3));
  }
  if (s.solar) buildSolar(p, k, s, top);
  p.emit(w);
}

function doorAt(p: Pieces, k: HouseKit, m: Matrix4, c: number, yBase: number, near: boolean): void {
  const mm = m.clone().setPosition(new Vector3().setFromMatrixPosition(m).setY(yBase));
  p.add(k.door, lbox(c - 0.45, c + 0.45, 0, 2.05, 0, 0.04), mm);
  if (!near) return;
  p.add(k.frameBronze, lbox(c - 0.5, c + 0.5, 2.05, 2.1, 0, 0.07), mm);
  p.add(k.glassFrosted, lplane(c - 0.12, c + 0.12, 0.9, 1.9, 0.045), mm);
  // Canopy (庇) and the step.
  p.add(k.trim, lbox(c - 0.8, c + 0.8, 2.35, 2.42, 0, 0.75), mm);
  p.add(k.foundation, lbox(c - 0.7, c + 0.7, -0.45, -0.25, 0, 0.6), mm);
}

/** Balcony on a floor: slab, aluminium rail with bar infill, a sliding door, often laundry. */
function buildBalcony(p: Pieces, k: HouseKit, r: Rng, m: Matrix4, a: number, b: number, yFloor: number, near: boolean): void {
  const mm = m.clone().setPosition(new Vector3().setFromMatrixPosition(m).setY(yFloor));
  const depth = 0.95;
  p.add(k.slab, lbox(a, b, -0.14, 0, 0, depth), mm);
  // Door(s) behind.
  const n = Math.max(1, Math.floor((b - a) / 2.6));
  for (let i = 0; i < n; i++) {
    const c = a + ((i + 0.5) * (b - a)) / n;
    windowAt(p, k, r, mm, c, 0.02, "door", near);
  }
  const H = 1.1;
  const barsLike = r.chance(0.6);
  const infill = barsLike ? k.bars : k.panel;
  const frame = r.chance(0.5) ? k.frameBronze : k.frameSilver;
  // Front and the two ends.
  p.add(infill, lplane(a, b, 0.05, H - 0.05, depth - 0.02), mm);
  for (const x of [a, b]) {
    const g = lplane(0.02, depth - 0.02, 0.05, H - 0.05, 0);
    g.rotateY(-Math.PI / 2);
    g.translate(x, 0, 0);
    p.add(infill, g, mm);
  }
  p.add(frame, lbox(a - 0.02, b + 0.02, H - 0.05, H, depth - 0.05, depth + 0.01), mm);
  for (const x of [a, b]) p.add(frame, lbox(x - 0.025, x + 0.025, H - 0.05, H, 0, depth), mm);
  for (let x = a; x <= b + 0.01; x += (b - a) / Math.max(1, Math.round((b - a) / 1.8))) p.add(frame, lbox(x - 0.02, x + 0.02, 0, H, depth - 0.04, depth), mm);
  if (near && r.chance(0.5)) acUnit(p, k, mm, b - 0.55, 0.0, 0.1);
  if (near && r.chance(0.55)) {
    // Laundry pole (物干し竿) with towels and shirts.
    const y = 1.75;
    p.add(k.frameSilver, rod(v3(a + 0.2, y, depth * 0.6), v3(b - 0.2, y, depth * 0.6), 0.016, 6), mm);
    const count = r.int(2, 5);
    for (let i = 0; i < count; i++) {
      const c = a + 0.5 + r.next() * (b - a - 1.0);
      const ww = r.range(0.35, 0.7);
      const hh = r.range(0.45, 0.8);
      p.add(r.pick(k.laundry), lplane(c - ww / 2, c + ww / 2, y - hh, y, depth * 0.6), mm);
    }
  }
}

/** Roof: gable, hip, shed or flat with a parapet; gutters and fascia on near houses. */
function buildRoof(p: Pieces, k: HouseKit, s: HouseSpec, top: number, near: boolean): void {
  const kind = s.roof.kind;
  const mat = s.roof.mat;
  if (kind === "flat") {
    const t = 0.16;
    const h = 0.5;
    const q = [
      [s.x0, s.x1, s.z0, s.z0 + t],
      [s.x0, s.x1, s.z1 - t, s.z1],
      [s.x0, s.x0 + t, s.z0, s.z1],
      [s.x1 - t, s.x1, s.z0, s.z1],
    ];
    for (const [x0, x1, z0, z1] of q) {
      const g = box(x1 - x0, h, z1 - z0);
      g.translate((x0 + x1) / 2, top + h / 2, (z0 + z1) / 2);
      p.add(s.wall, g);
      const c = box(x1 - x0 + 0.04, 0.04, z1 - z0 + 0.04);
      c.translate((x0 + x1) / 2, top + h + 0.02, (z0 + z1) / 2);
      p.add(k.frameSilver, c);
    }
    const roof = box(s.x1 - s.x0 - 2 * t, 0.05, s.z1 - s.z0 - 2 * t);
    roof.translate((s.x0 + s.x1) / 2, top + 0.025, (s.z0 + s.z1) / 2);
    p.add(mat, roof);
    return;
  }
  const pitch = s.roof.pitch ?? 0.4;
  const eave = near ? 0.5 : 0.4;
  const ridgeX = (s.roof.ridge ?? (s.x1 - s.x0 >= s.z1 - s.z0 ? "x" : "z")) === "x";
  // Work in a frame where the ridge runs along a, the span along b.
  const a0 = (ridgeX ? s.x0 : s.z0) - eave * 0.7;
  const a1 = (ridgeX ? s.x1 : s.z1) + eave * 0.7;
  const b0 = ridgeX ? s.z0 : s.x0;
  const b1 = ridgeX ? s.z1 : s.x1;
  const half = (b1 - b0) / 2;
  const bc = (b0 + b1) / 2;
  const P = (a: number, b: number, y: number) => (ridgeX ? v3(a, y, b) : v3(b, y, a));
  const q = new QuadBuilder();
  const gable = new QuadBuilder();
  const yEave = top - eave * pitch;
  const addPlane = (pts: Vector3[], uvs: [number, number][]) => {
    const n = new Vector3().subVectors(pts[1], pts[0]).cross(new Vector3().subVectors(pts[2], pts[0])).normalize();
    if (n.y < 0) n.negate();
    if (pts.length === 4) q.quad(pts, n, uvs);
    else q.tri(pts, n, uvs);
  };
  if (kind === "shed") {
    const lowAtB0 = s.roof.low ? s.roof.low === (ridgeX ? "-z" : "-x") : true;
    const span = b1 - b0 + 2 * eave;
    const yHi = top + (b1 - b0 + eave) * pitch;
    const bl = lowAtB0 ? b0 - eave : b1 + eave;
    const bh = lowAtB0 ? b1 + eave : b0 - eave;
    addPlane([P(a0, bl, yEave), P(a1, bl, yEave), P(a1, bh, yHi + eave * pitch * 0), P(a0, bh, yHi)], [
      [a0, span],
      [a1, span],
      [a1, 0],
      [a0, 0],
    ]);
    // Side walls up to the slope.
    for (const a of [ridgeX ? s.x0 : s.z0, ridgeX ? s.x1 : s.z1]) {
      const wl = lowAtB0 ? b0 : b1;
      const wh = lowAtB0 ? b1 : b0;
      const n = ridgeX ? v3(a === s.x0 ? -1 : 1, 0, 0) : v3(0, 0, a === s.z0 ? -1 : 1);
      gable.tri([P(a, wl, top), P(a, wh, top), P(a, wh, top + (b1 - b0) * pitch)], n, [
        [wl, top],
        [wh, top],
        [wh, top + (b1 - b0) * pitch],
      ]);
    }
  } else {
    const yRidge = top + half * pitch;
    const inset = kind === "hip" ? half + eave : 0;
    const ra0 = a0 + inset;
    const ra1 = a1 - inset;
    for (const side of [-1, 1]) {
      const be = bc + side * (half + eave);
      const slopeLen = Math.hypot(half + eave, (half + eave) * pitch);
      if (kind === "hip" && ra1 <= ra0) {
        addPlane([P(a0, be, yEave), P(a1, be, yEave), P((a0 + a1) / 2, bc, yRidge)], [
          [a0, slopeLen],
          [a1, slopeLen],
          [(a0 + a1) / 2, 0],
        ]);
      } else {
        addPlane([P(a0, be, yEave), P(a1, be, yEave), P(ra1, bc, yRidge), P(ra0, bc, yRidge)], [
          [a0, slopeLen],
          [a1, slopeLen],
          [ra1, 0],
          [ra0, 0],
        ]);
      }
    }
    if (kind === "hip") {
      for (const [ae, ar] of [
        [a0, ra0],
        [a1, ra1],
      ]) {
        const len = Math.hypot(half + eave, (half + eave) * pitch);
        addPlane([P(ae, bc - half - eave, yEave), P(ae, bc + half + eave, yEave), P(Math.min(Math.max(ar, a0), a1), bc, yRidge)], [
          [bc - half - eave, len],
          [bc + half + eave, len],
          [bc, 0],
        ]);
      }
    } else {
      // Gable-end walls.
      for (const a of [ridgeX ? s.x0 : s.z0, ridgeX ? s.x1 : s.z1]) {
        const n = ridgeX ? v3(a === s.x0 ? -1 : 1, 0, 0) : v3(0, 0, a === s.z0 ? -1 : 1);
        gable.tri([P(a, b0, top), P(a, b1, top), P(a, bc, yRidge)], n, [
          [b0, top],
          [b1, top],
          [bc, yRidge],
        ]);
      }
      if (near) {
        // Verge boards along the gable edges.
        for (const a of [a0, a1]) {
          for (const side of [-1, 1]) {
            const p0 = P(a, bc + side * (half + eave), yEave);
            const p1 = P(a, bc, yRidge);
            p.add(k.trim, rod(p0, p1, 0.05, 4));
          }
        }
      }
    }
    if (near) {
      // Gutters along both eaves, and the ridge cap.
      for (const side of [-1, 1]) {
        const be = bc + side * (half + eave + 0.05);
        p.add(k.trim, rod(P(a0, be, yEave - 0.05), P(a1, be, yEave - 0.05), 0.055, 6));
      }
      if (kind !== "hip" || ra1 > ra0) p.add(mat, rod(P(Math.max(ra0, a0), bc, yRidge + 0.03), P(Math.min(ra1, a1), bc, yRidge + 0.03), 0.09, 6));
    }
  }
  const g = q.build();
  p.add(mat, g);
  // Roof thickness seen from below: a soffit plane under the eaves.
  if (near) {
    const sof = box((ridgeX ? a1 - a0 : b1 - b0 + 2 * eave) - 0.02, 0.03, (ridgeX ? b1 - b0 + 2 * eave : a1 - a0) - 0.02);
    sof.translate((s.x0 + s.x1) / 2, yEave - 0.04, (s.z0 + s.z1) / 2);
    p.add(k.trim, sof);
  }
  if (!gable.empty) p.add(s.wall, gable.build());
}

/** Tilted photovoltaic modules on a flat roof, facing south (world +x+z). */
function buildSolar(p: Pieces, k: HouseKit, s: HouseSpec, top: number): void {
  const tilt = 0.35;
  const south = new Vector3(0.545, 0, 0.839);
  const yaw = Math.atan2(south.x, south.z);
  const cols = Math.floor((s.x1 - s.x0 - 1.0) / 1.05);
  const rows = Math.floor((s.z1 - s.z0 - 1.0) / 1.9);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = s.x0 + 0.7 + i * 1.05;
      const z = s.z0 + 1.0 + j * 1.9;
      const panel = box(1.0, 0.04, 1.65);
      panel.rotateX(tilt);
      panel.rotateY(yaw * 0.15);
      panel.translate(x, top + 0.55, z);
      p.add(k.frameSilver, panel);
      const face = new PlaneGeometry(0.96, 1.6);
      face.rotateX(-Math.PI / 2 + tilt);
      face.rotateY(yaw * 0.15);
      face.translate(x, top + 0.575, z);
      p.add(k.pv, face);
      const leg = box(0.04, 0.5, 0.04);
      leg.translate(x, top + 0.3, z - 0.6);
      p.add(k.frameSilver, leg);
    }
  }
}

// ------------------------------------------------------------ textures

/** Vertical balcony bars (alpha), one tile = 1 m. */
function barsTexture() {
  const { c, g } = canvas(256, 256);
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = "#fff";
  for (let i = 0; i < 9; i++) g.fillRect(i * (256 / 9) + 6, 0, 9, 256);
  return toTexture(c, true);
}

/** Monocrystalline PV module: dark cells, silver busbars, white grid. */
function pvTexture() {
  const { c, g } = canvas(256, 512);
  g.fillStyle = "#e8eaec";
  g.fillRect(0, 0, 256, 512);
  const cw = 256 / 6;
  const ch = 512 / 10;
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 10; j++) {
      const gr = g.createLinearGradient(0, j * ch, 0, (j + 1) * ch);
      gr.addColorStop(0, "#1c2a44");
      gr.addColorStop(1, "#0f1830");
      g.fillStyle = gr;
      g.fillRect(i * cw + 2, j * ch + 2, cw - 4, ch - 4);
      g.fillStyle = "rgba(170,180,195,0.5)";
      g.fillRect(i * cw + cw * 0.33, j * ch + 2, 1.5, ch - 4);
      g.fillRect(i * cw + cw * 0.66, j * ch + 2, 1.5, ch - 4);
    }
  return toTexture(c);
}

function laundryTexture(hex: string, stripe?: string) {
  const { c, g } = canvas(64, 64);
  g.fillStyle = hex;
  g.fillRect(0, 0, 64, 64);
  if (stripe) {
    g.fillStyle = stripe;
    for (let y = 6; y < 64; y += 14) g.fillRect(0, y, 64, 5);
  }
  return toTexture(c);
}

export function houseKit(w: DayWorld): HouseKit {
  const lib = w.lib;
  const bronze = lib.plain(0x3b352d, 0.4, 0.55);
  bronze.name = "alu-bronze";
  return {
    frameBronze: bronze,
    frameSilver: lib.plain(0xb9bdbf, 0.32, 0.7),
    glassDark: lib.glass("dark"),
    glassCurtain: lib.glass("curtain"),
    glassFrosted: lib.glass("frosted"),
    trim: lib.paint(0xe9e8e2, 0.5),
    dark: lib.plain(0x26282a, 0.6),
    shutter: lib.sheetRoof(0xb4ada0),
    foundation: lib.concrete([0.82, 0.81, 0.78], false),
    slab: lib.concrete([0.9, 0.89, 0.86], false),
    door: lib.paint(0x4a3a2c, 0.55),
    ac: lib.plain(0xe0e0da, 0.5),
    bars: lib.cutout("balcony-bars", barsTexture(), { color: 0x6d6a64, rough: 0.35, metal: 0.5 }),
    panel: lib.glass("frosted"),
    pv: lib.printed("pv", pvTexture(), 0.18),
    laundry: [
      lib.printed("laundry-white", laundryTexture("#f2f2ee"), 0.9),
      lib.printed("laundry-blue", laundryTexture("#5f86b8", "#e8eef4"), 0.9),
      lib.printed("laundry-pink", laundryTexture("#e6a3ad"), 0.9),
      lib.printed("laundry-towel", laundryTexture("#f1e7c8", "#c9803c"), 0.9),
    ],
  };
}
