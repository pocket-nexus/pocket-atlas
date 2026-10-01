import { BufferAttribute, type BufferGeometry, type CanvasTexture } from "three";
import { canvas, toTexture, type Ctx } from "./canvas";

export interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

interface Shelf {
  y: number;
  h: number;
  x: number;
}

/**
 * Shelf-packed canvas atlas. Signs, posters and labels all draw into one
 * texture so the batcher can merge them into a single draw call.
 *
 * Packing: an item goes to the lowest shelf tall enough to hold it. When a
 * shelf is much taller than the item, a column is split off and filled with
 * a stack of same-size cells, which later requests of that size reuse.
 */
export class Atlas {
  readonly texture: CanvasTexture;
  private g: Ctx;
  private size: number;
  private shelves: Shelf[] = [];
  private spare: { x: number; y: number; w: number; h: number }[] = [];
  private top = 0;
  private pad = 4;
  private cells = 0;
  private keyed = new Map<string, AtlasRect>();

  constructor(size: number) {
    const { c, g } = canvas(size, size);
    this.size = size;
    this.g = g;
    g.fillStyle = "#000";
    g.fillRect(0, 0, size, size);
    this.texture = toTexture(c);
    this.texture.flipY = true;
  }

  private place(w: number, h: number): { x: number; y: number } | null {
    const si = this.spare.findIndex((s) => s.w === w && s.h === h);
    if (si >= 0) {
      const s = this.spare.splice(si, 1)[0];
      return { x: s.x, y: s.y };
    }
    let shelf: Shelf | undefined;
    for (const s of this.shelves) if (s.h >= h && s.x + w <= this.size && (!shelf || s.h < shelf.h)) shelf = s;
    if (shelf && shelf.h >= h * 2 + this.pad) {
      const x = shelf.x;
      shelf.x += w + this.pad;
      for (let y = shelf.y + h + this.pad; y + h <= shelf.y + shelf.h; y += h + this.pad) this.spare.push({ x, y, w, h });
      return { x, y: shelf.y };
    }
    if (!shelf) {
      if (this.top + h > this.size) return null;
      shelf = { y: this.top, h, x: 0 };
      this.shelves.push(shelf);
      this.top += h + this.pad;
    }
    const x = shelf.x;
    shelf.x += w + this.pad;
    return { x, y: shelf.y };
  }

  /** Draws into a w×h cell (pixels) and returns its UV rectangle. */
  draw(w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect {
    const scale = Math.min(1, this.size / 4096);
    w = Math.max(8, Math.round(w * scale));
    h = Math.max(8, Math.round(h * scale));
    const at = this.place(w, h);
    if (!at) {
      console.warn(`atlas full (${w}x${h}; ${this.shelves.length} shelves, ${this.cells} cells)`);
      return { u0: 0, v0: 0, u1: 0.001, v1: 0.001 };
    }
    const g = this.g;
    g.save();
    g.translate(at.x, at.y);
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    paint(g, w, h);
    g.restore();
    this.cells++;
    this.texture.needsUpdate = true;
    return {
      u0: (at.x + 0.5) / this.size,
      u1: (at.x + w - 0.5) / this.size,
      v1: 1 - (at.y + 0.5) / this.size,
      v0: 1 - (at.y + h - 0.5) / this.size,
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

/** Remaps a geometry's [0,1] UVs into an atlas rectangle. */
export function mapUV(geo: BufferGeometry, r: AtlasRect): BufferGeometry {
  const uv = geo.getAttribute("uv") as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Canvas atlas packed with a bottom-left skyline: each cell goes where its
 * top edge ends lowest along the current skyline (ties to the left). Mixed
 * sizes pack tightly online, which suits many signs of different shapes
 * (the plain `Atlas` splits tall shelves into columns of one size).
 */
export class SkylineAtlas {
  readonly texture: CanvasTexture;
  private g: Ctx;
  private size: number;
  private scale: number;
  /** Top contour: segments [x, y, width] covering [0, size) in x. */
  private sky: [number, number, number][];
  /**
   * Border around every cell, filled by extending the cell's edge pixels:
   * a sign seen from afar samples a low mip level, and a black border (or
   * the next cell) would bleed into it there — on the handheld, through
   * BC1's 4×4 blocks, as dark squares that come and go with the mip level.
   */
  private pad = 16;
  private keyed = new Map<string, AtlasRect>();
  private used = 0;

  constructor(size: number) {
    const { c, g } = canvas(size, size);
    this.size = size;
    this.scale = Math.min(1, size / 4096);
    this.g = g;
    this.sky = [[0, 0, size]];
    g.fillStyle = "#000";
    g.fillRect(0, 0, size, size);
    this.texture = toTexture(c);
    this.texture.flipY = true;
  }

  /** Share of the canvas area covered by cells. */
  get fill(): number {
    return this.used / (this.size * this.size);
  }

  private place(w: number, h: number): { x: number; y: number } | null {
    let best: { x: number; y: number; i: number } | null = null;
    for (let i = 0; i < this.sky.length; i++) {
      const x = this.sky[i][0];
      if (x + w > this.size) break;
      let y = 0;
      let span = 0;
      for (let j = i; j < this.sky.length && span < w; j++) {
        y = Math.max(y, this.sky[j][1]);
        span += this.sky[j][2];
      }
      if (y + h > this.size) continue;
      if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y, i };
    }
    if (!best) return null;
    // Raise the skyline over [x, x + w) to y + h.
    const x0 = best.x;
    const x1 = best.x + w;
    const top = best.y + h;
    const next: [number, number, number][] = [];
    for (const [sx, sy, sw] of this.sky) {
      const ex = sx + sw;
      if (ex <= x0 || sx >= x1) {
        next.push([sx, sy, sw]);
        continue;
      }
      if (sx < x0) next.push([sx, sy, x0 - sx]);
      if (ex > x1) next.push([x1, sy, ex - x1]);
    }
    next.push([x0, top, w]);
    next.sort((a, b) => a[0] - b[0]);
    // Merge neighbours at the same height.
    this.sky = next.reduce<[number, number, number][]>((acc, seg) => {
      const last = acc[acc.length - 1];
      if (last && last[1] === seg[1] && last[0] + last[2] === seg[0]) last[2] += seg[2];
      else acc.push([...seg]);
      return acc;
    }, []);
    return { x: best.x, y: best.y };
  }

  /** Paints into a w×h cell (4096-atlas pixels) and returns its UV rectangle. */
  draw(w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect {
    const cw = Math.max(8, Math.round(w * this.scale));
    const ch = Math.max(8, Math.round(h * this.scale));
    const p = this.pad;
    const slot = this.place(cw + 2 * p, ch + 2 * p);
    if (!slot) {
      console.warn(`skyline atlas full (${w}x${h}; ${Math.round(this.fill * 100)}% covered)`);
      return { u0: 0, v0: 0, u1: 0.001, v1: 0.001 };
    }
    this.used += (cw + 2 * p) * (ch + 2 * p);
    const at = { x: slot.x + p, y: slot.y + p };
    const g = this.g;
    g.save();
    g.translate(at.x, at.y);
    g.beginPath();
    g.rect(0, 0, cw, ch);
    g.clip();
    paint(g, cw, ch);
    g.restore();
    // Edge pixels stretched over the border: rows up and down, then columns
    // (with the extended rows) left and right, which also fills the corners.
    g.save();
    g.imageSmoothingEnabled = false;
    const c = g.canvas as CanvasImageSource;
    const { x, y } = at;
    g.drawImage(c, x, y, cw, 1, x, y - p, cw, p);
    g.drawImage(c, x, y + ch - 1, cw, 1, x, y + ch, cw, p);
    g.drawImage(c, x, y - p, 1, ch + 2 * p, x - p, y - p, p, ch + 2 * p);
    g.drawImage(c, x + cw - 1, y - p, 1, ch + 2 * p, x + cw, y - p, p, ch + 2 * p);
    g.restore();
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
}
