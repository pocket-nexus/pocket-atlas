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
