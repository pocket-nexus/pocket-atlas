import { CanvasTexture, ClampToEdgeWrapping, LinearMipmapLinearFilter, MeshStandardMaterial, NoColorSpace, SRGBColorSpace, Vector2, type BufferGeometry } from "three";
import { Rng } from "../../core/random";
import { extrudeEdges, mapUV, shelfPacker, type AtlasRect } from "./atlas";
import { canvas, roundRect, type Ctx } from "./canvas";

/*
 * Painted PBR texture sets: albedo (sRGB), ORM (R occlusion, G roughness,
 * B metalness, the channel layout three.js and the cooker read), a height
 * map that becomes a tangent-space normal map, and for some sets an emission
 * map. Two ways to paint them:
 *
 *  - `PbrAtlas` + `CellPen`: cells packed into one atlas, each painted once
 *    on all three layers at the same time (equipment, street furniture);
 *  - `LayerPen` + `paintLayer`: one hand-laid layout painted once per layer
 *    from surface records (`Finish`), so every layer agrees (vehicle and
 *    train liveries).
 */

/** 0..1 → 0..255, clamped. */
export const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

/** Grey level for a height in −1..1 (128 = flat). */
export function grey(h: number): string {
  const v = Math.round(128 + Math.max(-1, Math.min(1, h)) * 120);
  return `rgb(${v},${v},${v})`;
}

/** ORM texel (occlusion, roughness, metalness in 0..1). */
export function orm(ao: number, rough: number, metal: number): string {
  return `rgb(${Math.round(ao * 255)},${Math.round(rough * 255)},${Math.round(metal * 255)})`;
}

/** A painted map as a mipmapped canvas texture (sRGB for colour, linear for data). */
export function pbrTexture(c: HTMLCanvasElement, srgb: boolean, name: string): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.anisotropy = 8;
  t.minFilter = LinearMipmapLinearFilter;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.name = name;
  return t;
}

/** A region of a height map and the gain that turns its slopes into normals. */
export interface NormalRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  strength: number;
}

/**
 * Tangent-space normal map (v up, three.js convention) from a grey height
 * canvas. Each region's neighbours are clamped to the region, so cells do
 * not tilt each other's edges; without regions the whole canvas is one.
 */
export function heightToNormal(height: HTMLCanvasElement, regions?: NormalRegion[], strength = 1): HTMLCanvasElement {
  const w = height.width;
  const h = height.height;
  const src = height.getContext("2d")!.getImageData(0, 0, w, h).data;
  const { c, g } = canvas(w, h);
  const out = g.createImageData(w, h);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 128;
    d[i + 1] = 128;
    d[i + 2] = 255;
    d[i + 3] = 255;
  }
  for (const r of regions ?? [{ x: 0, y: 0, w, h, strength }]) {
    const x0 = r.x;
    const y0 = r.y;
    const x1 = r.x + r.w;
    const y1 = r.y + r.h;
    const H = (x: number, y: number) => src[(Math.min(y1 - 1, Math.max(y0, y)) * w + Math.min(x1 - 1, Math.max(x0, x))) * 4] / 255;
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        const dx = (H(x + 1, y) - H(x - 1, y)) * r.strength;
        // Canvas rows run down; texture v runs up (flipY).
        const dv = (H(x, y - 1) - H(x, y + 1)) * r.strength;
        const l = Math.hypot(dx, dv, 1);
        const i = (y * w + x) * 4;
        d[i] = ((-dx / l) * 0.5 + 0.5) * 255;
        d[i + 1] = ((-dv / l) * 0.5 + 0.5) * 255;
        d[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      }
  }
  g.putImageData(out, 0, 0);
  return c;
}

// ---------------------------------------------------------- layer painting

export type Layer = "albedo" | "orm" | "height" | "emit";

/** A surface: albedo (sRGB), roughness, metalness, relief height (0.5 = skin), emission (sRGB). */
export interface Finish {
  c: string;
  r: number;
  m: number;
  h?: number;
  e?: string;
}

/** Paints one layer of a texture set: every call takes the record's value for that layer. */
export class LayerPen {
  constructor(
    readonly g: Ctx,
    readonly mode: Layer,
  ) {}

  get albedo(): boolean {
    return this.mode === "albedo";
  }

  style(f: Finish): string {
    switch (this.mode) {
      case "albedo":
        return f.c;
      case "orm":
        return `rgb(255,${byte(f.r)},${byte(f.m)})`;
      case "height": {
        const v = byte(f.h ?? 0.5);
        return `rgb(${v},${v},${v})`;
      }
      case "emit":
        return f.e ?? "#000";
    }
  }

  /** Fills the current path. */
  fill(f: Finish): void {
    this.g.fillStyle = this.style(f);
    this.g.fill();
  }

  rect(x: number, y: number, w: number, h: number, f: Finish): void {
    this.g.fillStyle = this.style(f);
    this.g.fillRect(x, y, w, h);
  }

  /** Rectangle between two corners (any order). */
  box(x0: number, y0: number, x1: number, y1: number, f: Finish): void {
    this.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), f);
  }

  rbox(x0: number, y0: number, x1: number, y1: number, r: number, f: Finish): void {
    this.g.fillStyle = this.style(f);
    roundRect(this.g, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), r);
    this.g.fill();
  }

  disc(x: number, y: number, r: number, f: Finish): void {
    this.g.fillStyle = this.style(f);
    this.g.beginPath();
    this.g.arc(x, y, r, 0, Math.PI * 2);
    this.g.fill();
  }

  poly(pts: [number, number][], f: Finish): void {
    const g = this.g;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    this.fill(f);
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, f: Finish): void {
    this.g.strokeStyle = this.style(f);
    this.g.lineWidth = width;
    this.g.beginPath();
    this.g.moveTo(x0, y0);
    this.g.lineTo(x1, y1);
    this.g.stroke();
  }

  /** Albedo-only translucent wash (grime, shading); other layers keep their values. */
  wash(fill: string | CanvasGradient, x: number, y: number, w: number, h: number): void {
    if (!this.albedo) return;
    this.g.fillStyle = fill;
    this.g.fillRect(x, y, w, h);
  }
}

/** One layer of a w × h layout (layout pixels) on a canvas `scale` times that size. */
export function paintLayer(w: number, h: number, scale: number, mode: Layer, paint: (p: LayerPen) => void): HTMLCanvasElement {
  const { c, g } = canvas(Math.round(w * scale), Math.round(h * scale));
  g.setTransform(scale, 0, 0, scale, 0, 0);
  paint(new LayerPen(g, mode));
  return c;
}

// ------------------------------------------------------------ cell atlas

/** Painting surface for one atlas cell: albedo, height and ORM contexts at the same origin and size. */
export class CellPen {
  constructor(
    readonly a: Ctx,
    readonly h: Ctx,
    readonly o: Ctx,
    readonly w: number,
    readonly ht: number,
    readonly r: Rng,
    /** Pixels per 1024-atlas pixel. */
    readonly k: number,
    /** Cell origin on the canvas (pixel writes ignore the context transform). */
    readonly ox = 0,
    readonly oy = 0,
  ) {}

  /** Fills the cell: albedo, roughness, metalness, flat height. */
  base(color: string, rough: number, metal = 0): void {
    this.paint(0, 0, this.w, this.ht, color, rough, metal, 0);
  }

  /** A rectangle of paint; any channel left undefined is untouched. Height in −1..1 (0 flat). */
  paint(x: number, y: number, w: number, h: number, color?: string, rough?: number, metal?: number, height?: number): void {
    if (color) {
      this.a.fillStyle = color;
      this.a.fillRect(x, y, w, h);
    }
    if (rough !== undefined) {
      this.o.fillStyle = orm(1, rough, metal ?? 0);
      this.o.fillRect(x, y, w, h);
    }
    if (height !== undefined) {
      this.h.fillStyle = grey(height);
      this.h.fillRect(x, y, w, h);
    }
  }

  /** Runs a path-drawing function on the chosen layers with the given styles. */
  shape(path: (g: Ctx) => void, color?: string, rough?: number, metal = 0, height?: number): void {
    if (color) {
      this.a.fillStyle = color;
      this.a.beginPath();
      path(this.a);
      this.a.fill();
    }
    if (rough !== undefined) {
      this.o.fillStyle = orm(1, rough, metal);
      this.o.beginPath();
      path(this.o);
      this.o.fill();
    }
    if (height !== undefined) {
      this.h.fillStyle = grey(height);
      this.h.beginPath();
      path(this.h);
      this.h.fill();
    }
  }

  /** Raised round head (bolt, rivet): a radial bump in the height map and a faint highlight. */
  bolt(x: number, y: number, rad: number, color = "rgba(255,255,255,0.12)"): void {
    const g = this.h.createRadialGradient(x - rad * 0.2, y - rad * 0.2, 0, x, y, rad);
    g.addColorStop(0, grey(0.9));
    g.addColorStop(0.7, grey(0.55));
    g.addColorStop(1, grey(0));
    this.h.fillStyle = g;
    this.h.beginPath();
    this.h.arc(x, y, rad, 0, Math.PI * 2);
    this.h.fill();
    this.a.fillStyle = color;
    this.a.beginPath();
    this.a.arc(x - rad * 0.25, y - rad * 0.25, rad * 0.5, 0, Math.PI * 2);
    this.a.fill();
  }

  /** Recessed line (panel seam, door gap). */
  seam(x0: number, y0: number, x1: number, y1: number, width: number, dark = "rgba(0,0,0,0.45)"): void {
    for (const [g, s] of [
      [this.h, grey(-0.8)],
      [this.a, dark],
    ] as const) {
      g.strokeStyle = s;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
  }

  /** Paint chips: small blobs of primer or bare metal, rougher, a little lower. */
  chips(n: number, size: number, color: string, rough: number, metal: number, where: () => [number, number] = () => [this.r.next() * this.w, this.r.next() * this.ht]): void {
    for (let i = 0; i < n; i++) {
      const [x, y] = where();
      const rx = size * this.r.range(0.3, 1);
      const ry = rx * this.r.range(0.4, 1);
      const rot = this.r.range(0, Math.PI);
      this.shape((g) => g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2), color, rough, metal, -0.35);
    }
  }

  /** Dirt rising from the bottom edge (road splash) or hanging from the top (soot); also rougher. */
  grime(fromBottom: number, alpha: number, color = "60,52,42"): void {
    const y0 = this.ht * (1 - fromBottom);
    const g = this.a.createLinearGradient(0, this.ht, 0, y0);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(1, `rgba(${color},0)`);
    this.a.fillStyle = g;
    this.a.fillRect(0, y0, this.w, this.ht - y0);
    const o = this.o.createLinearGradient(0, this.ht, 0, y0);
    o.addColorStop(0, `rgba(0,${Math.round(alpha * 90)},0,1)`);
    o.addColorStop(1, "rgba(0,0,0,1)");
    this.o.globalCompositeOperation = "lighter";
    this.o.fillStyle = o;
    this.o.fillRect(0, y0, this.w, this.ht - y0);
    this.o.globalCompositeOperation = "source-over";
  }

  /** Vertical streaks (rain runs, rust tears) of a colour. */
  streaks(n: number, color: string, len: [number, number], width: [number, number], from: () => [number, number] = () => [this.r.next() * this.w, this.r.next() * this.ht]): void {
    for (let i = 0; i < n; i++) {
      const [x, y] = from();
      const l = this.r.range(len[0], len[1]);
      const wd = this.r.range(width[0], width[1]);
      const g = this.a.createLinearGradient(0, y, 0, y + l);
      g.addColorStop(0, color);
      g.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
      this.a.fillStyle = g;
      this.a.fillRect(x - wd / 2, y, wd, l);
    }
  }

  /** Fine speckle over the albedo (paint grain, galvanising spangle). */
  speckle(n: number, colors: string[], size: [number, number]): void {
    for (let i = 0; i < n; i++) {
      this.a.fillStyle = colors[i % colors.length];
      const s = this.r.range(size[0], size[1]);
      this.a.fillRect(this.r.next() * this.w, this.r.next() * this.ht, s, s);
    }
  }

  /** Per-pixel albedo from a function of (u, v) in 0..1 (v = 0 at the top of the cell). */
  pixels(fn: (u: number, v: number, out: number[]) => void): void {
    const img = this.a.createImageData(this.w, this.ht);
    const px = [0, 0, 0];
    for (let y = 0; y < this.ht; y++)
      for (let x = 0; x < this.w; x++) {
        fn((x + 0.5) / this.w, (y + 0.5) / this.ht, px);
        const i = (y * this.w + x) * 4;
        img.data[i] = px[0];
        img.data[i + 1] = px[1];
        img.data[i + 2] = px[2];
        img.data[i + 3] = 255;
      }
    this.a.putImageData(img, this.ox, this.oy);
  }
}

/** A cell: size in 1024-atlas pixels and its painter. `bump` scales the height into the normal map. */
export interface CellDef {
  w: number;
  h: number;
  bump?: number;
  paint: (p: CellPen) => void;
}

/**
 * A PBR atlas of painted cells and the one material that draws them all.
 * Cells pack on shelves, tallest first, each with a border of its own edge
 * pixels on every layer (4 px in 1024-atlas pixels, as the `Atlas` keeps
 * 16 px at 4096). The height layer becomes the normal map cell by cell.
 */
export class PbrAtlas<K extends string> {
  readonly size: number;
  readonly material: MeshStandardMaterial;
  readonly albedo: CanvasTexture;
  private rects = new Map<K, AtlasRect>();

  constructor(size: number, cells: Record<K, CellDef>, opts: { name: string; seed: number }) {
    this.size = size;
    const k = size / 1024;
    const A = canvas(size, size);
    const H = canvas(size, size);
    const O = canvas(size, size);
    A.g.fillStyle = "#808080";
    A.g.fillRect(0, 0, size, size);
    H.g.fillStyle = grey(0);
    H.g.fillRect(0, 0, size, size);
    O.g.fillStyle = orm(1, 0.6, 0);
    O.g.fillRect(0, 0, size, size);
    const pad = Math.round(4 * k);
    const packer = shelfPacker(size, pad);
    const order = (Object.keys(cells) as K[]).sort((a, b) => cells[b].h - cells[a].h || cells[b].w - cells[a].w);
    const r = new Rng(opts.seed);
    const regions: NormalRegion[] = [];
    for (const key of order) {
      const def = cells[key];
      const w = Math.round(def.w * k);
      const h = Math.round(def.h * k);
      const slot = packer.place(w + 2 * pad, h + 2 * pad);
      if (!slot) throw new Error(`${opts.name} atlas full at ${key}`);
      const x = slot.x + pad;
      const y = slot.y + pad;
      for (const c of [A.g, H.g, O.g]) {
        c.save();
        c.translate(x, y);
        c.beginPath();
        c.rect(0, 0, w, h);
        c.clip();
      }
      def.paint(new CellPen(A.g, H.g, O.g, w, h, r, k, x, y));
      for (const c of [A.g, H.g, O.g]) {
        c.restore();
        extrudeEdges(c, x, y, w, h, pad);
      }
      this.rects.set(key, { u0: (x + 0.5) / size, u1: (x + w - 0.5) / size, v1: 1 - (y + 0.5) / size, v0: 1 - (y + h - 0.5) / size });
      regions.push({ x: x - pad, y: y - pad, w: w + 2 * pad, h: h + 2 * pad, strength: ((def.bump ?? 1) * 2.2) / k });
    }
    this.albedo = pbrTexture(A.c, true, opts.name);
    const ormTex = pbrTexture(O.c, false, `${opts.name}-orm`);
    this.material = new MeshStandardMaterial({
      map: this.albedo,
      normalMap: pbrTexture(heightToNormal(H.c, regions), false, `${opts.name}-normal`),
      normalScale: new Vector2(1, 1),
      roughnessMap: ormTex,
      metalnessMap: ormTex,
      aoMap: ormTex,
      aoMapIntensity: 1,
      roughness: 1,
      metalness: 1,
    });
    this.material.name = opts.name;
  }

  rect(key: K): AtlasRect {
    return this.rects.get(key)!;
  }

  /** Maps a geometry's 0..1 UVs into a cell (optionally a sub-rectangle of it, in 0..1 cell units). */
  map(g: BufferGeometry, key: K, sub?: [number, number, number, number]): BufferGeometry {
    return mapUV(g, this.rect(key), sub);
  }
}
