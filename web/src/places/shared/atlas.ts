import { BufferAttribute, type BufferGeometry, type CanvasTexture } from "three";
import { canvas, toTexture, type Ctx } from "./canvas";

export interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** A slot of the packed area (pixels; the cell sits `pad` inside it). */
export interface Slot {
  x: number;
  y: number;
}

/** Places w × h slots on a size × size canvas, online, in request order. */
export interface Packer {
  place(w: number, h: number): Slot | null;
}

/**
 * Shelf packing: a slot goes to the lowest shelf tall enough to hold it.
 * When a shelf is at least twice as tall as the slot, a column is split off
 * and filled with a stack of same-size slots, which later requests of that
 * size reuse. Slots on the canvas edge start `pad` outside it: the sampler
 * clamps there, so the outer border costs no space.
 */
export function shelfPacker(size: number, pad: number): Packer {
  const shelves: { y: number; h: number; x: number }[] = [];
  const spare: { x: number; y: number; w: number; h: number }[] = [];
  let top = -pad;
  const end = size + pad;
  return {
    place(w, h) {
      const si = spare.findIndex((s) => s.w === w && s.h === h);
      if (si >= 0) {
        const s = spare.splice(si, 1)[0];
        return { x: s.x, y: s.y };
      }
      let shelf: (typeof shelves)[number] | undefined;
      for (const s of shelves) if (s.h >= h && s.x + w <= end && (!shelf || s.h < shelf.h)) shelf = s;
      if (shelf && shelf.h >= h * 2) {
        const x = shelf.x;
        shelf.x += w;
        for (let y = shelf.y + h; y + h <= shelf.y + shelf.h; y += h) spare.push({ x, y, w, h });
        return { x, y: shelf.y };
      }
      if (!shelf) {
        if (top + h > end) return null;
        shelf = { y: top, h, x: -pad };
        shelves.push(shelf);
        top += h;
      }
      const x = shelf.x;
      shelf.x += w;
      return { x, y: shelf.y };
    },
  };
}

/**
 * Bottom-left skyline packing: each slot goes where its top edge ends
 * lowest along the current skyline (ties to the left). Mixed sizes pack
 * tightly online, which suits many signs of different shapes.
 */
export function skylinePacker(size: number): Packer {
  /** Top contour: segments [x, y, width] covering [0, size) in x. */
  let sky: [number, number, number][] = [[0, 0, size]];
  return {
    place(w, h) {
      let best: { x: number; y: number } | null = null;
      for (let i = 0; i < sky.length; i++) {
        const x = sky[i][0];
        if (x + w > size) break;
        let y = 0;
        let span = 0;
        for (let j = i; j < sky.length && span < w; j++) {
          y = Math.max(y, sky[j][1]);
          span += sky[j][2];
        }
        if (y + h > size) continue;
        if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y };
      }
      if (!best) return null;
      // Raise the skyline over [x, x + w) to y + h.
      const x0 = best.x;
      const x1 = best.x + w;
      const next: [number, number, number][] = [];
      for (const [sx, sy, sw] of sky) {
        const ex = sx + sw;
        if (ex <= x0 || sx >= x1) {
          next.push([sx, sy, sw]);
          continue;
        }
        if (sx < x0) next.push([sx, sy, x0 - sx]);
        if (ex > x1) next.push([x1, sy, ex - x1]);
      }
      next.push([x0, best.y + h, w]);
      next.sort((a, b) => a[0] - b[0]);
      // Merge neighbours at the same height.
      sky = next.reduce<[number, number, number][]>((acc, seg) => {
        const last = acc[acc.length - 1];
        if (last && last[1] === seg[1] && last[0] + last[2] === seg[0]) last[2] += seg[2];
        else acc.push([...seg]);
        return acc;
      }, []);
      return best;
    },
  };
}

/**
 * Repeats a cell's edge pixels over its border: rows up and down, then
 * columns (with the extended rows) left and right, which also fills the
 * corners. A sign seen from afar samples a low mip level, and a black border
 * (or the next cell) would bleed into it there; on the handheld, through
 * BC1's 4×4 blocks, as dark squares that come and go with the mip level.
 */
export function extrudeEdges(g: Ctx, x: number, y: number, w: number, h: number, pad: number): void {
  if (pad <= 0) return;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = false;
  const c = g.canvas as CanvasImageSource;
  g.drawImage(c, x, y, w, 1, x, y - pad, w, pad);
  g.drawImage(c, x, y + h - 1, w, 1, x, y + h, w, pad);
  g.drawImage(c, x, y - pad, 1, h + 2 * pad, x - pad, y - pad, pad, h + 2 * pad);
  g.drawImage(c, x + w - 1, y - pad, 1, h + 2 * pad, x + w, y - pad, pad, h + 2 * pad);
  g.restore();
}

export interface AtlasOptions {
  /** "shelf" (default) or "skyline" (mixed sizes, many signs). */
  packer?: "shelf" | "skyline";
  /** Border around every cell (pixels), filled by edge extrusion. Default 16. */
  pad?: number;
  /** Clear to transparent instead of black (alpha-tested cut-outs). */
  transparent?: boolean;
}

/**
 * Canvas atlas. Signs, posters and labels draw into one texture so the
 * batcher can merge them into a single draw call. Cell sizes are given in
 * 4096-atlas pixels and scale with the atlas; every cell gets a border of
 * its own edge pixels (`extrudeEdges`).
 */
export class Atlas {
  readonly texture: CanvasTexture;
  readonly size: number;
  private g: Ctx;
  private packer: Packer;
  private kind: "shelf" | "skyline";
  private pad: number;
  private used = 0;
  private cells = 0;
  private keyed = new Map<string, AtlasRect>();

  constructor(size: number, opts: AtlasOptions = {}) {
    const { c, g } = canvas(size, size);
    this.size = size;
    this.g = g;
    this.kind = opts.packer ?? "shelf";
    this.pad = opts.pad ?? 16;
    this.packer = this.kind === "skyline" ? skylinePacker(size) : shelfPacker(size, this.pad);
    if (!opts.transparent) {
      g.fillStyle = "#000";
      g.fillRect(0, 0, size, size);
    }
    this.texture = toTexture(c);
    this.texture.flipY = true;
  }

  /** Share of the canvas area taken by cells and their borders. */
  get fill(): number {
    return this.used / (this.size * this.size);
  }

  /** Paints into a w×h cell (4096-atlas pixels) and returns its UV rectangle. */
  draw(w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect {
    const scale = Math.min(1, this.size / 4096);
    const cw = Math.max(8, Math.round(w * scale));
    const ch = Math.max(8, Math.round(h * scale));
    const p = this.pad;
    const slot = this.packer.place(cw + 2 * p, ch + 2 * p);
    if (!slot) {
      console.warn(`${this.kind} atlas full (${w}x${h}; ${this.cells} cells, ${Math.round(this.fill * 100)}% covered)`);
      return { u0: 0, v0: 0, u1: 0.001, v1: 0.001 };
    }
    this.used += (cw + 2 * p) * (ch + 2 * p);
    this.cells++;
    const x = slot.x + p;
    const y = slot.y + p;
    const g = this.g;
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, cw, ch);
    g.clip();
    paint(g, cw, ch);
    g.restore();
    extrudeEdges(g, x, y, cw, ch, p);
    this.texture.needsUpdate = true;
    return {
      u0: (x + 0.5) / this.size,
      u1: (x + cw - 0.5) / this.size,
      v1: 1 - (y + 0.5) / this.size,
      v0: 1 - (y + ch - 0.5) / this.size,
    };
  }

  /** Like draw(), but paints each key once and reuses its cell. */
  shared(key: string, w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect {
    let r = this.keyed.get(key);
    if (!r) {
      r = this.draw(w, h, paint);
      this.keyed.set(key, r);
    }
    return r;
  }

  /** Copies an existing canvas into the atlas. */
  put(src: HTMLCanvasElement, w = src.width, h = src.height): AtlasRect {
    return this.draw(w, h, (g, cw, ch) => g.drawImage(src, 0, 0, cw, ch));
  }
}

/**
 * Remaps a geometry's [0,1] UVs (v up) into an atlas rectangle, or into the
 * sub-rectangle `sub` = [u0, v0, u1, v1] of it (fractions of the cell).
 */
export function mapUV(geo: BufferGeometry, r: AtlasRect, sub?: [number, number, number, number]): BufferGeometry {
  const uv = geo.getAttribute("uv") as BufferAttribute;
  const [su0, sv0, su1, sv1] = sub ?? [0, 0, 1, 1];
  for (let i = 0; i < uv.count; i++) {
    const u = su0 + uv.getX(i) * (su1 - su0);
    const v = sv0 + uv.getY(i) * (sv1 - sv0);
    uv.setXY(i, r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0));
  }
  uv.needsUpdate = true;
  return geo;
}
