import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import landUrl from "world-atlas/land-50m.json?url";

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Coarse CPU grid used for lookups (town placement, road checks) and coast fields. */
export const SMALL_W = 1024;
export const SMALL_H = 512;

export interface LandData {
  /** Full-resolution antialiased land mask (white = land), north at row 0. */
  canvas: AnyCanvas;
  width: number;
  height: number;
  /** SMALL_W × SMALL_H land coverage in [0, 1]. */
  small: Float32Array;
  /**
   * SMALL_W × SMALL_H RGBA8 coast fields: land coverage blurred at σ ≈ 0.8°,
   * 3° and 9° (R, G, B) and the raw coverage (A). The bakes read them as
   * "distance to coast" proxies: shelves, continental interiors, humidity.
   */
  fields: Uint8Array;
}

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

interface Ring {
  pts: Float64Array; // lon, lat pairs, longitudes unwrapped to be continuous
  minLon: number;
  maxLon: number;
}

/**
 * world-atlas rings that cross the antimeridian jump between ±180. Unwrap them
 * into continuous longitudes; a ring whose unwrapped longitudes advance by a
 * full turn encircles a pole (Antarctica) and is closed along it.
 */
function prepareRings(coords: GeoJSON.Position[][][]): Ring[] {
  const rings: Ring[] = [];
  for (const poly of coords) {
    for (const ring of poly) {
      const n = ring.length;
      if (n < 3) continue;
      const out: number[] = [];
      let prev = ring[0][0];
      let shift = 0;
      for (let i = 0; i < n; i++) {
        let lon = ring[i][0] + shift;
        const d = lon - prev;
        if (d > 180) {
          shift -= 360;
          lon -= 360;
        } else if (d < -180) {
          shift += 360;
          lon += 360;
        }
        out.push(lon, ring[i][1]);
        prev = lon;
      }
      const turn = out[out.length - 2] - out[0];
      if (Math.abs(turn) > 300) {
        let latSum = 0;
        for (let i = 1; i < out.length; i += 2) latSum += out[i];
        const pole = latSum < 0 ? -90 : 90;
        out.push(out[out.length - 2], pole, out[0], pole);
      }
      let minLon = Infinity;
      let maxLon = -Infinity;
      for (let i = 0; i < out.length; i += 2) {
        if (out[i] < minLon) minLon = out[i];
        if (out[i] > maxLon) maxLon = out[i];
      }
      rings.push({ pts: Float64Array.from(out), minLon, maxLon });
    }
  }
  return rings;
}

function rasterize(ctx: Ctx2D, w: number, h: number, rings: Ring[]): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  const sx = w / 360;
  const sy = h / 180;
  for (const r of rings) {
    for (let k = -1; k <= 1; k++) {
      const off = k * 360;
      if (r.minLon + off >= 180 || r.maxLon + off <= -180) continue;
      const p = r.pts;
      ctx.moveTo((p[0] + off + 180) * sx, (90 - p[1]) * sy);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo((p[i] + off + 180) * sx, (90 - p[i + 1]) * sy);
      ctx.closePath();
    }
  }
  ctx.fill("evenodd");
}

/** Horizontal box blur with wrap-around and a per-row radius. */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, radius: Int32Array): void {
  for (let y = 0; y < h; y++) {
    const r = radius[y];
    const row = y * w;
    if (r <= 0) {
      dst.set(src.subarray(row, row + w), row);
      continue;
    }
    const inv = 1 / (2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + ((i % w) + w) % w];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * inv;
      const add = (x + r + 1) % w;
      const sub = ((x - r) % w + w) % w;
      sum += src[row + add] - src[row + sub];
    }
  }
}

/** Vertical box blur, edges clamped (the poles). */
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * inv;
      const add = Math.min(h - 1, y + r + 1);
      const sub = Math.max(0, y - r);
      sum += src[add * w + x] - src[sub * w + x];
    }
  }
}

/** Approximate gaussian (3 box passes) of σ in degrees, isotropic on the sphere. */
function sphereBlur(src: Float32Array, w: number, h: number, sigmaDeg: number): Float32Array {
  const pxPerDeg = w / 360;
  const sigma = sigmaDeg * pxPerDeg;
  const boxW = (s: number) => Math.max(0, Math.round((Math.sqrt((12 * s * s) / 3 + 1) - 1) / 2));
  const rv = boxW(sigma);
  const rh = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    const lat = (0.5 - (y + 0.5) / h) * Math.PI;
    const s = sigma / Math.max(0.06, Math.cos(lat));
    rh[y] = Math.min(Math.floor(w / 2) - 1, boxW(s));
  }
  const a = Float32Array.from(src);
  const b = new Float32Array(src.length);
  for (let i = 0; i < 3; i++) {
    boxH(a, b, w, h, rh);
    boxV(b, a, w, h, rv);
  }
  return a;
}

export async function loadLand(width: number, height: number): Promise<LandData> {
  const res = await fetch(landUrl);
  if (!res.ok) throw new Error(`land-50m.json: HTTP ${res.status}`);
  const topo = (await res.json()) as Topology;
  const fc = feature(topo, topo.objects.land as GeometryCollection);
  const coords: GeoJSON.Position[][][] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === "Polygon") coords.push(g.coordinates);
    else if (g.type === "MultiPolygon") coords.push(...g.coordinates);
  }
  const rings = prepareRings(coords);

  const canvas = makeCanvas(width, height);
  const big = canvas.getContext("2d") as Ctx2D | null;
  if (!big) throw new Error("2D canvas unavailable");
  rasterize(big, width, height, rings);

  const smallCanvas = makeCanvas(SMALL_W, SMALL_H);
  const sctx = smallCanvas.getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
  if (!sctx) throw new Error("2D canvas unavailable");
  rasterize(sctx, SMALL_W, SMALL_H, rings);
  const px = sctx.getImageData(0, 0, SMALL_W, SMALL_H).data;
  const small = new Float32Array(SMALL_W * SMALL_H);
  for (let i = 0; i < small.length; i++) small[i] = px[i * 4] / 255;

  const near = sphereBlur(small, SMALL_W, SMALL_H, 0.8);
  const mid = sphereBlur(small, SMALL_W, SMALL_H, 3);
  const far = sphereBlur(small, SMALL_W, SMALL_H, 9);
  const fields = new Uint8Array(SMALL_W * SMALL_H * 4);
  for (let i = 0; i < small.length; i++) {
    fields[i * 4] = Math.round(near[i] * 255);
    fields[i * 4 + 1] = Math.round(mid[i] * 255);
    fields[i * 4 + 2] = Math.round(far[i] * 255);
    fields[i * 4 + 3] = Math.round(small[i] * 255);
  }
  return { canvas, width, height, small, fields };
}

/** Bilinear land coverage lookup on the coarse grid. */
export function landAt(small: Float32Array, lat: number, lon: number): number {
  const x = ((lon + 180) / 360) * SMALL_W - 0.5;
  const y = ((90 - lat) / 180) * SMALL_H - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const X0 = ((x0 % SMALL_W) + SMALL_W) % SMALL_W;
  const X1 = (X0 + 1) % SMALL_W;
  const Y0 = Math.min(SMALL_H - 1, Math.max(0, y0));
  const Y1 = Math.min(SMALL_H - 1, Math.max(0, y0 + 1));
  const a = small[Y0 * SMALL_W + X0];
  const b = small[Y0 * SMALL_W + X1];
  const c = small[Y1 * SMALL_W + X0];
  const d = small[Y1 * SMALL_W + X1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
