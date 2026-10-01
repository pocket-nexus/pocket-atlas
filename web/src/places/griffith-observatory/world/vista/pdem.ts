import { curvatureDrop, geo, GEO } from "../layout";

/** A height grid packed by `scripts/vista-dem.ts` (see `world/dem.ts`). */
export interface Grid {
  name: string;
  width: number;
  height: number;
  south: number;
  west: number;
  north: number;
  east: number;
  /** Heights in m above sea level, row 0 = north. */
  data: Float32Array;
  /** Blend band at the edge (pixels). */
  band: number;
}

/**
 * Decodes an inflated PDEM grid: "PDEM", u32 header length, JSON header,
 * then one zigzag LEB128 residual per sample against the planar predictor
 * left + up − upleft of the quantized heights.
 */
export function decodeGrid(raw: Uint8Array, band: number): Grid {
  if (String.fromCharCode(...raw.subarray(0, 4)) !== "PDEM") throw new Error("dem: not a PDEM grid");
  const hl = new DataView(raw.buffer, raw.byteOffset).getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + hl))) as Omit<Grid, "data" | "band"> & { offset: number; scale: number };
  const W = h.width;
  const n = W * h.height;
  const q = new Int32Array(n);
  let p = 8 + hl;
  for (let i = 0; i < n; i++) {
    let z = 0;
    let m = 1;
    for (;;) {
      const b = raw[p++];
      z += (b & 0x7f) * m;
      if (b < 0x80) break;
      m *= 128;
    }
    const r = z % 2 ? -(z + 1) / 2 : z / 2;
    const x = i % W;
    const pred = i < W ? (x === 0 ? 0 : q[i - 1]) : x === 0 ? q[i - W] : q[i - 1] + q[i - W] - q[i - W - 1];
    q[i] = pred + r;
  }
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = h.offset + q[i] * h.scale;
  return { name: h.name, width: W, height: h.height, south: h.south, west: h.west, north: h.north, east: h.east, data, band };
}

const SPACING = [1, 5, 50, 200];

/**
 * Nested grids, finest first, sampled bilinearly at pixel centres; each grid
 * blends into the next over its edge band. Shared by the scene (`dem.ts`) and
 * the data scripts (which load the same files from disk).
 */
export class HeightField {
  private readonly grids: Grid[];
  private readonly tmp = { h: 0, w: 0 };

  constructor(grids: Grid[]) {
    this.grids = grids;
  }

  /** Bilinear height (m ASL) and the blend weight of grid `g` at (lat, lon); weight 0 outside. */
  private sample(g: Grid, lat: number, lon: number, out: { h: number; w: number }): void {
    const fx = ((lon - g.west) / (g.east - g.west)) * g.width - 0.5;
    const fy = ((g.north - lat) / (g.north - g.south)) * g.height - 0.5;
    const edge = Math.min(fx, fy, g.width - 1 - fx, g.height - 1 - fy);
    if (edge < 0) {
      out.w = 0;
      return;
    }
    const x0 = Math.min(Math.floor(fx), g.width - 2);
    const y0 = Math.min(Math.floor(fy), g.height - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const d = g.data;
    const i = y0 * g.width + x0;
    const a = d[i] + (d[i + 1] - d[i]) * tx;
    const b = d[i + g.width] + (d[i + g.width + 1] - d[i + g.width]) * tx;
    out.h = a + (b - a) * ty;
    const s = Math.min(1, edge / g.band);
    out.w = s * s * (3 - 2 * s);
  }

  /** Ground height above mean sea level (m). Sea and no-data read as 0. */
  heightAsl(lat: number, lon: number): number {
    let h = 0;
    let left = 1;
    for (const g of this.grids) {
      this.sample(g, lat, lon, this.tmp);
      if (this.tmp.w <= 0) continue;
      h += left * this.tmp.w * Math.max(0, this.tmp.h);
      left *= 1 - this.tmp.w;
      if (left <= 1e-6) break;
    }
    return h;
  }

  /** Ground height in place y at place (x, z), Earth curvature included. */
  groundY(x: number, z: number): number {
    const { lat, lon } = geo(x, z);
    return this.heightAsl(lat, lon) - GEO.datum - curvatureDrop(Math.hypot(x, z));
  }

  /** Spacing (m) of the finest grid that fully answers at place (x, z). */
  spacing(x: number, z: number): number {
    const { lat, lon } = geo(x, z);
    for (let k = 0; k < this.grids.length; k++) {
      this.sample(this.grids[k], lat, lon, this.tmp);
      if (this.tmp.w >= 1) return SPACING[Math.min(k, SPACING.length - 1)];
    }
    return SPACING[SPACING.length - 1];
  }
}
