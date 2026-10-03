/**
 * A route's surveyed source data (`tools/route-survey.ts`): the driven line,
 * elevation grids at three reaches, and the OpenStreetMap features of the
 * corridor. Pure data: it loads in the page, in a worker and under Bun.
 */

export interface RouteJson {
  version: number;
  id: string;
  frame: { system: string; lat0: number; lon0: number; k0: number; north0: number; east0: number; origin: { lat: number; lon: number } };
  step: number;
  samples: number;
  length: number;
  elevation: { min: number; max: number; start: number; end: number };
  start: { name: string; native: string; lat: number; lon: number };
  end: { name: string; native: string; lat: number; lon: number };
  names: { s: number; name: string; ref: string }[];
  limits: { s: number; kmh: number }[];
}

/** The files of `web/src/routes/<id>/data/`. */
export interface RouteFiles {
  route: RouteJson;
  centerline: ArrayBuffer;
  features: ArrayBuffer;
  demNear: ArrayBuffer;
  demMid: ArrayBuffer;
  demFar: ArrayBuffer;
}

export async function inflate(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const stream = new Blob([src as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const NA = -32768;

/** A regular elevation grid in the route frame; empty cells read NaN. */
export class Grid {
  constructor(
    readonly cell: number,
    readonly x0: number,
    readonly z0: number,
    readonly nx: number,
    readonly nz: number,
    private h: Int16Array,
  ) {}

  static async decode(buffer: ArrayBuffer): Promise<Grid> {
    const v = new DataView(buffer);
    if (v.getUint32(0, true) !== 0x4d454452) throw new Error("not an elevation grid");
    const [cell, x0, z0, nx, nz, size] = [v.getFloat32(8, true), v.getFloat32(12, true), v.getFloat32(16, true), v.getUint32(20, true), v.getUint32(24, true), v.getUint32(28, true)];
    const raw = await inflate(new Uint8Array(buffer, 32, size));
    const h = new Int16Array(raw.buffer, raw.byteOffset, nx * nz);
    for (let iz = 0; iz < nz; iz++) {
      let prev = 0;
      for (let ix = 0; ix < nx; ix++) {
        prev = (prev + h[iz * nx + ix]) | 0;
        // Deltas wrap in 16 bits exactly as they were written.
        prev = (prev << 16) >> 16;
        h[iz * nx + ix] = prev;
      }
    }
    return new Grid(cell, x0, z0, nx, nz, h);
  }

  /** Bilinear elevation (m); NaN where fewer than half the weights have data. */
  at(x: number, z: number): number {
    const fx = (x - this.x0) / this.cell;
    const fz = (z - this.z0) / this.cell;
    if (fx < 0 || fz < 0 || fx > this.nx - 1 || fz > this.nz - 1) return NaN;
    const ix = Math.min(this.nx - 2, Math.floor(fx));
    const iz = Math.min(this.nz - 2, Math.floor(fz));
    const u = fx - ix;
    const v = fz - iz;
    const o = iz * this.nx + ix;
    const h = this.h;
    const a = h[o];
    const b = h[o + 1];
    const c = h[o + this.nx];
    const d = h[o + this.nx + 1];
    if (a !== NA && b !== NA && c !== NA && d !== NA) return ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v) * 0.1;
    let s = 0;
    let w = 0;
    const add = (val: number, k: number) => {
      if (val !== NA) {
        s += val * k;
        w += k;
      }
    };
    add(a, (1 - u) * (1 - v));
    add(b, u * (1 - v));
    add(c, (1 - u) * v);
    add(d, u * v);
    return w > 0.5 ? (s / w) * 0.1 : NaN;
  }
}

export type FeatureKind = "road" | "rail" | "building" | "land" | "water" | "waterway" | "power" | "tower" | "treeRow" | "point";

export interface Feature {
  kind: FeatureKind;
  type: string;
  name: string;
  tags: Record<string, string | number>;
  /** x, z pairs (m) in the route frame; areas close on their first point. */
  pts: Float64Array;
  holes: Float64Array[];
  /** Bounds: min x, min z, max x, max z. */
  box: [number, number, number, number];
}

function decodePts(q: number[], unit: number): Float64Array {
  const out = new Float64Array(q.length);
  let x = 0;
  let z = 0;
  for (let i = 0; i < q.length; i += 2) {
    x += q[i];
    z += q[i + 1];
    out[i] = x * unit;
    out[i + 1] = z * unit;
  }
  return out;
}

export class RouteSource {
  private hash = new Map<number, Feature[]>();
  private static readonly HASH = 256;

  private constructor(
    readonly route: RouteJson,
    /** The driven line every `route.step` metres: x, z, y. */
    readonly lineXZY: Float32Array,
    /** Per sample: lanes, speed limit (km/h), flags (1 bridge, 2 tunnel, 4 the numbered road), spare. */
    readonly lineAttr: Uint8Array,
    readonly near: Grid,
    readonly mid: Grid,
    readonly far: Grid,
    readonly features: Feature[],
  ) {
    for (const f of features) {
      const h = RouteSource.HASH;
      for (let x = Math.floor(f.box[0] / h); x <= Math.floor(f.box[2] / h); x++)
        for (let z = Math.floor(f.box[1] / h); z <= Math.floor(f.box[3] / h); z++) {
          const k = (x + 32768) * 65536 + (z + 32768);
          const list = this.hash.get(k);
          if (list) list.push(f);
          else this.hash.set(k, [f]);
        }
    }
  }

  static async decode(files: RouteFiles): Promise<RouteSource> {
    const v = new DataView(files.centerline);
    if (v.getUint32(0, true) !== 0x4e4c4352) throw new Error("not a route centre line");
    const n = v.getUint32(8, true);
    const xzy = new Float32Array(files.centerline.slice(16, 16 + n * 12));
    const attr = new Uint8Array(files.centerline.slice(16 + n * 12, 16 + n * 16));
    const [near, mid, far] = await Promise.all([Grid.decode(files.demNear), Grid.decode(files.demMid), Grid.decode(files.demFar)]);
    const json = JSON.parse(new TextDecoder().decode(await inflate(files.features))) as { unit: number; kinds: FeatureKind[]; features: [number, string, string | 0, Record<string, string | number> | 0, number[], number[][]?][] };
    const features = json.features.map((f): Feature => {
      const pts = decodePts(f[4], json.unit);
      const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pts.length; i += 2) {
        box[0] = Math.min(box[0], pts[i]);
        box[1] = Math.min(box[1], pts[i + 1]);
        box[2] = Math.max(box[2], pts[i]);
        box[3] = Math.max(box[3], pts[i + 1]);
      }
      return { kind: json.kinds[f[0]], type: f[1], name: f[2] || "", tags: f[3] || {}, pts, holes: (f[5] ?? []).map((h) => decodePts(h, json.unit)), box };
    });
    return new RouteSource(files.route, xzy, attr, near, mid, far, features);
  }

  /** Surveyed elevation: the finest grid that has the point. */
  elevation(x: number, z: number): number {
    let h = this.near.at(x, z);
    if (!Number.isNaN(h)) return h;
    h = this.mid.at(x, z);
    if (!Number.isNaN(h)) return h;
    h = this.far.at(x, z);
    return Number.isNaN(h) ? 0 : h;
  }

  /** Features of one kind whose bounds touch the box (each once). */
  query(kind: FeatureKind, x0: number, z0: number, x1: number, z1: number): Feature[] {
    const h = RouteSource.HASH;
    const out = new Set<Feature>();
    for (let x = Math.floor(x0 / h); x <= Math.floor(x1 / h); x++)
      for (let z = Math.floor(z0 / h); z <= Math.floor(z1 / h); z++) {
        const list = this.hash.get((x + 32768) * 65536 + (z + 32768));
        if (!list) continue;
        for (const f of list) if (f.kind === kind && f.box[0] <= x1 && f.box[2] >= x0 && f.box[1] <= z1 && f.box[3] >= z0) out.add(f);
      }
    return [...out];
  }
}

/** Fetches a route's data files next to a base URL (the page and the worker). */
export async function fetchRouteFiles(urls: { route: string; centerline: string; features: string; demNear: string; demMid: string; demFar: string }): Promise<RouteFiles> {
  const get = async (u: string) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${u}: ${r.status}`);
    return r.arrayBuffer();
  };
  const [route, centerline, features, demNear, demMid, demFar] = await Promise.all([fetch(urls.route).then((r) => r.json() as Promise<RouteJson>), get(urls.centerline), get(urls.features), get(urls.demNear), get(urls.demMid), get(urls.demFar)]);
  return { route, centerline, features, demNear, demMid, demFar };
}
