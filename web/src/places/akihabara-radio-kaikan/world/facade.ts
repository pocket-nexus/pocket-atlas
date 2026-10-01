import { CylinderGeometry, PlaneGeometry, Vector3, type Group, type Material } from "three";
import { Rng } from "../../../core/random";
import { box } from "../../shared/geo";
import { seedWindowUV } from "../../tokyo-konbini/gfx/interior";
import { paintInterior, paintLightbox, type Lightbox } from "../gfx/art";
import type { AkibaWorld } from "./context";
import { cellPlane, rect } from "./util";

/**
 * Facade toolkit for the neighbours. Every building is authored in a local
 * frame: the street facade on z = 0 facing +z, x from 0 at the left end as
 * seen from the street, the body toward −z. `frame()` places that frame:
 * south side ry = π (left = east end), north side ry = 0 (left = west end),
 * across Chuo-dori ry = π/2 (left = south end).
 */
export class Facade {
  readonly g: Group;
  readonly w: AkibaWorld;
  readonly width: number;
  readonly r: Rng;

  constructor(w: AkibaWorld, x: number, z: number, ry: number, width: number, seed: number, name: string) {
    this.w = w;
    this.g = w.group(x, 0, z, ry);
    this.g.name = name;
    this.g.updateMatrixWorld(true);
    this.width = width;
    this.r = new Rng(seed);
  }

  /** World position of a local point. */
  at(x: number, y: number, z: number): Vector3 {
    return this.g.localToWorld(new Vector3(x, y, z));
  }

  /** Box in local coordinates (centre x, y from y0 to y1, z from z0 to z1). */
  box(mat: Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    this.w.mesh(box(x1 - x0, y1 - y0, z1 - z0), mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, this.g);
  }

  /** Solid volume behind the facade. */
  mass(mat: Material, height: number, depth: number, from = 0, z0 = 0): void {
    this.box(mat, 0, this.width, from, height, -depth, z0);
  }

  /**
   * The building's volume: upper floors from `ground` to `height` with their
   * face at z = `front`, and the ground floor's back wall behind the shop
   * interiors (`shopDepth` deep), so shopfronts and windows sit in front of it.
   */
  body(mat: Material, height: number, depth: number, opts: { ground: number; shopDepth: number; front?: number }): void {
    const front = opts.front ?? 0;
    if (opts.ground < height) this.box(mat, 0, this.width, opts.ground, height, -depth, front);
    this.box(mat, 0, this.width, 0, Math.min(opts.ground, height), -depth, -opts.shopDepth - 0.06);
  }

  /** A plane facing the street. */
  plane(geo: PlaneGeometry, mat: Material, x: number, y: number, z: number): void {
    this.w.mesh(geo, mat, x, y, z, this.g);
  }

  /** Rows of interior-mapped windows (rooms with lamps) with frames and sills. */
  windows(opts: { x0: number; x1: number; y0: number; floorH: number; floors: number; winH: number; bays: number; winW?: number; sill?: Material; frame?: Material; ribbon?: boolean; intensity?: number; z?: number }): void {
    const z = opts.z ?? 0;
    const { w, r } = this;
    const mat = w.lib.interiorWindows(opts.intensity ?? 1.2);
    const span = opts.x1 - opts.x0;
    const bw = span / opts.bays;
    const ww = opts.ribbon ? bw : Math.min(bw - 0.3, opts.winW ?? bw * 0.62);
    for (let f = 0; f < opts.floors; f++) {
      const y = opts.y0 + f * opts.floorH + opts.floorH * 0.52;
      for (let b = 0; b < opts.bays; b++) {
        const x = opts.x0 + (b + 0.5) * bw;
        const pane = seedWindowUV(new PlaneGeometry(ww - 0.04, opts.winH), r.int(0, 999), r.int(0, 999));
        w.mesh(pane, mat, x, y, z + 0.015, this.g);
        if (opts.frame) {
          // Jambs only; the head and sill run as one strip per floor below.
          w.mesh(box(0.06, opts.winH, 0.08), opts.frame, x - ww / 2, y, z + 0.04, this.g);
          if (!opts.ribbon || b === opts.bays - 1) w.mesh(box(0.06, opts.winH, 0.08), opts.frame, x + ww / 2, y, z + 0.04, this.g);
        }
      }
      if (opts.sill) this.box(opts.sill, opts.x0, opts.x1, y - opts.winH / 2 - 0.12, y - opts.winH / 2, z, z + 0.16);
      if (opts.frame) {
        this.box(opts.frame, opts.x0, opts.x1, y + opts.winH / 2, y + opts.winH / 2 + 0.06, z, z + 0.08);
        this.box(opts.frame, opts.x0, opts.x1, y - opts.winH / 2 - 0.06, y - opts.winH / 2, z, z + 0.12);
      }
    }
  }

  /** Glazed shopfront with a lit interior card, side returns and an optional fascia lightbox. */
  shopfront(x0: number, x1: number, h: number, kind: "gift" | "lobby" | "cards" | "shop" | "arcade" | "station", seed: number, opts: { fascia?: Lightbox; fasciaH?: number; light?: number; color?: number; depth?: number; y?: number } = {}): void {
    const { w } = this;
    const bw = x1 - x0;
    const depth = opts.depth ?? 3;
    const yb = opts.y ?? 0;
    const variant = seed % 3;
    const inner = w.draw(`int-${kind}-${variant}`, 640, 240, (g, cw, ch) => paintInterior(g, cw, ch, kind, variant + 1));
    const lit = w.lib.lit(w.atlas.texture, 1.2, "atlas-interior", { fog: false });
    w.mesh(cellPlane(bw - 0.1, h - 0.1, inner), lit, (x0 + x1) / 2, yb + h / 2, -depth, this.g);
    const glowCol = opts.color ?? 0xf0f2ff;
    for (const sx of [x0 + 0.03, x1 - 0.03]) {
      const side = new PlaneGeometry(depth, h);
      side.rotateY(sx < (x0 + x1) / 2 ? Math.PI / 2 : -Math.PI / 2);
      w.mesh(side, w.lib.glow(glowCol, 0.42, false), sx, yb + h / 2, -depth / 2, this.g);
    }
    const ceil = new PlaneGeometry(bw, depth);
    ceil.rotateX(Math.PI / 2);
    w.mesh(ceil, w.lib.glow(glowCol, 0.85, false), (x0 + x1) / 2, yb + h, -depth / 2, this.g);
    const floor = new PlaneGeometry(bw, depth);
    floor.rotateX(-Math.PI / 2);
    w.mesh(floor, w.lib.glow(0x7a7570, 0.5, false), (x0 + x1) / 2, yb + 0.005, -depth / 2, this.g);
    w.mesh(new PlaneGeometry(bw, h), w.lib.shopGlass(), (x0 + x1) / 2, yb + h / 2, -0.05, this.g);
    const frame = w.lib.plain(0x9ea3a8, 0.35, 0.8);
    const n = Math.max(1, Math.round(bw / 1.8));
    for (let i = 0; i <= n; i++) w.mesh(box(0.06, h, 0.1), frame, x0 + (bw * i) / n, yb + h / 2, -0.03, this.g);
    if (opts.fascia) {
      const fh = opts.fasciaH ?? 0.7;
      const key = `fascia-${opts.fascia.text}-${opts.fascia.bg}`;
      const rc = w.draw(key, Math.min(1024, Math.round(bw * 90)), Math.round(fh * 110), (g, cw, ch) => paintLightbox(g, cw, ch, opts.fascia!));
      this.box(w.lib.plain(0x2a2b2d, 0.6), x0, x1, yb + h, yb + h + fh + 0.1, -0.1, 0.14);
      w.mesh(cellPlane(bw - 0.1, fh, rc), w.sign, (x0 + x1) / 2, yb + h + fh / 2 + 0.05, 0.145, this.g);
    }
    if ((opts.light ?? 1) > 0) rect(w, glowCol, 0.9 * (opts.light ?? 1), bw, h * 0.8, this.at((x0 + x1) / 2, yb + h * 0.5, 0.3), this.at((x0 + x1) / 2, yb + h * 0.2 - (yb > 0 ? 2 : 0), 6));
  }

  /** Projecting vertical sign (袖看板): a lit box perpendicular to the facade, faces both ways. */
  bladeSign(x: number, y0: number, h: number, s: Lightbox, opts: { width?: number; out?: number; intensity?: "sign" | "bright" } = {}): void {
    const { w } = this;
    const sw = opts.width ?? 0.75;
    const out = opts.out ?? 0.15;
    const key = `blade-${s.text}-${s.bg}`;
    const rc = w.draw(key, Math.round(sw * 110), Math.min(1024, Math.round(h * 100)), (g, cw, ch) => paintLightbox(g, cw, ch, { ...s, vertical: true }));
    const mat = opts.intensity === "bright" ? w.bright : w.sign;
    const cz = out + sw / 2;
    this.box(w.lib.plain(0x222326, 0.5), x - 0.09, x + 0.09, y0, y0 + h, out, out + sw);
    for (const side of [-1, 1]) {
      const p = cellPlane(sw, h, rc);
      p.rotateY((side * Math.PI) / 2);
      w.mesh(p, mat, x + side * 0.092, y0 + h / 2, cz, this.g);
    }
    this.box(w.lib.plain(0x3a3b3e, 0.5), x - 0.03, x + 0.03, y0 + h * 0.2, y0 + h * 0.8, 0, out);
  }

  /** Flat lightbox on the facade. */
  panelSign(x0: number, x1: number, y0: number, y1: number, s: Lightbox, opts: { z?: number; intensity?: "sign" | "bright" | "dim"; depth?: number } = {}): void {
    const { w } = this;
    const bw = x1 - x0;
    const bh = y1 - y0;
    const key = `panel-${s.text}-${s.bg}-${s.vertical ? "v" : "h"}`;
    const rc = w.draw(key, Math.min(1024, Math.round(bw * 100)), Math.min(1024, Math.round(bh * 100)), (g, cw, ch) => paintLightbox(g, cw, ch, s));
    const z = opts.z ?? 0.15;
    const mat = opts.intensity === "bright" ? w.bright : opts.intensity === "dim" ? w.dim : w.sign;
    this.box(w.lib.plain(0x26272a, 0.55), x0 - 0.05, x1 + 0.05, y0 - 0.05, y1 + 0.05, z - (opts.depth ?? 0.25), z);
    w.mesh(cellPlane(bw, bh, rc), mat, (x0 + x1) / 2, (y0 + y1) / 2, z + 0.005, this.g);
  }

  /** Flat parapet top with a coping, and a few roof boxes. */
  roof(mat: Material, height: number, depth: number, plant = true): void {
    const { w, r } = this;
    this.box(mat, 0, this.width, height, height + 0.9, -0.2, 0.02);
    if (!plant) return;
    const m = w.lib.plain(0x7d8184, 0.6);
    const n = r.int(1, 3);
    for (let i = 0; i < n; i++) {
      const x = r.range(1, this.width - 1.5);
      w.mesh(box(r.range(1, 2.4), r.range(0.8, 1.8), r.range(0.8, 1.6)), m, x, height + 0.6, -r.range(2, depth - 2), this.g);
    }
    if (r.chance(0.5)) w.mesh(new CylinderGeometry(0.03, 0.03, 4, 6), m, r.range(1, this.width - 1), height + 2.5, -depth * 0.5, this.g);
  }
}
