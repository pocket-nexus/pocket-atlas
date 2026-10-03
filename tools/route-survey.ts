// Surveys a route for Pocket Atlas: the road itself, what stands along it and
// the ground it crosses, from OpenStreetMap and the GSI elevation tiles, into
// the compact source data a route's web reference and compiler build from.
//
//   bun tools/route-survey.ts --route hokkaido-r237 [--refresh osm|dem|all]
//
// Reads  web/src/routes/<id>/survey.json
// Caches .pocket-build/research/<id>/{osm,dem}/      (raw downloads)
// Writes web/src/routes/<id>/data/
//   route.json        frame, length, names, speed limits, stops, places
//   centerline.bin    the driven line every 5 m: x, z, y (f32) and attributes
//   features.bin      roads, rails, buildings, land cover, water, power, points (deflated JSON, decimetres)
//   dem-near.bin      elevation grids (delta + deflate, decimetres)
//   dem-mid.bin
//   dem-far.bin
//
// Sources: © OpenStreetMap contributors (ODbL); 国土地理院 標高タイル (GSI
// elevation tiles, DEM10B). Everything estimated instead of surveyed is
// produced downstream by the generators, not here.

import { deflateSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { JPRCS_XII, project, toGeo, toLocal, type Frame } from "../web/src/routes/shared/geodesy.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const ROUTE = opt("route", "hokkaido-r237");
const REFRESH = opt("refresh", "");
const SRC = resolve(ROOT, `web/src/routes/${ROUTE}`);
const CACHE = resolve(ROOT, `.pocket-build/research/${ROUTE}`);
const OUT = `${SRC}/data`;
// Overpass endpoints, tried in turn (OVERPASS=url,url overrides).
const OVERPASS = (process.env.OVERPASS ?? "https://maps.mail.ru/osm/tools/overpass/api/interpreter").split(",");

interface Survey {
  id: string;
  ref: string;
  bbox: [number, number, number, number];
  start: Stop;
  end: Stop;
  via: { lat: number; lon: number }[];
  localStreets: number;
  corridor: { roads: number; buildings: number; rail: number; land: number; power: number; points: number };
  dem: Record<"near" | "mid" | "far", { zoom: number; cell: number; reach: number }>;
}
interface Stop {
  name: string;
  native: string;
  lat: number;
  lon: number;
}
const survey: Survey = JSON.parse(readFileSync(`${SRC}/survey.json`, "utf8"));
for (const d of [`${CACHE}/osm`, `${CACHE}/dem`, OUT]) mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- overpass

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

async function overpass(name: string, query: string): Promise<OsmElement[]> {
  const path = `${CACHE}/osm/${name}.json`;
  if (existsSync(path) && REFRESH !== "osm" && REFRESH !== "all") return JSON.parse(readFileSync(path, "utf8")).elements;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length]!;
    try {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: `[out:json][timeout:90];${query}` }), signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`${r.status}`);
      const text = await r.text();
      const json = JSON.parse(text);
      if (json.remark) throw new Error(json.remark);
      writeFileSync(path, text);
      console.log(`osm ${name}: ${json.elements.length} elements (${(text.length / 1024).toFixed(0)} KiB)`);
      return json.elements;
    } catch (e) {
      console.log(`osm ${name}: ${url} failed (${(e as Error).message}); retrying`);
      await Bun.sleep(3000 * (attempt + 1));
    }
  }
  throw new Error(`overpass: ${name} failed`);
}

const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180) * 111_320, (b.lat - a.lat) * 110_540);

// ------------------------------------------------------------ the driven line

const DRIVABLE = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|service";

/** Shortest path over the route's ways (and the local streets near both ends), as OSM points with their way's tags. */
async function drivenLine(): Promise<{ lat: number; lon: number; tags: Record<string, string> }[]> {
  const [s, w, n, e] = survey.bbox;
  const r = survey.localStreets;
  const ways = await overpass("line", `(way[highway][ref~"(^|;)${survey.ref}($|;)"](${s},${w},${n},${e}););out geom;`);
  // Local streets around the ends and the via points, one small query each.
  const ends = [survey.start, survey.end, ...survey.via];
  for (let i = 0; i < ends.length; i++) {
    const p = ends[i]!;
    const have = new Set(ways.map((x) => x.id));
    for (const x of await overpass(`line-end-${i}`, `(way(around:${r},${p.lat},${p.lon})[highway~"^(${DRIVABLE})$"];);out geom;`)) if (!have.has(x.id)) ways.push(x);
  }
  const key = (p: { lat: number; lon: number }) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const nodes = new Map<string, { lat: number; lon: number; out: { to: string; cost: number; tags: Record<string, string> }[] }>();
  const node = (p: { lat: number; lon: number }) => {
    const k = key(p);
    if (!nodes.has(k)) nodes.set(k, { lat: p.lat, lon: p.lon, out: [] });
    return k;
  };
  for (const way of ways) {
    const g = way.geometry ?? [];
    const tags = way.tags ?? {};
    const main = (tags.ref ?? "").split(";").includes(survey.ref);
    // The numbered road is the route: local streets only where they are all there is.
    const weight = main ? 1 : 6;
    const oneway = tags.oneway === "yes" || tags.junction === "roundabout";
    for (let i = 0; i + 1 < g.length; i++) {
      const a = node(g[i]!);
      const b = node(g[i + 1]!);
      const cost = metres(g[i]!, g[i + 1]!) * weight;
      nodes.get(a)!.out.push({ to: b, cost, tags });
      if (!oneway) nodes.get(b)!.out.push({ to: a, cost, tags });
    }
  }
  const nearest = (p: { lat: number; lon: number }) => {
    let best = "";
    let bd = Infinity;
    for (const [k, v] of nodes) {
      const d = metres(p, v);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    if (bd > 250) throw new Error(`no road within 250 m of ${p.lat},${p.lon} (nearest ${bd.toFixed(0)} m)`);
    return best;
  };
  const stops = [survey.start, ...survey.via, survey.end].map(nearest);
  const line: { lat: number; lon: number; tags: Record<string, string> }[] = [];
  for (let leg = 0; leg + 1 < stops.length; leg++) {
    const from = stops[leg]!;
    const to = stops[leg + 1]!;
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, { from: string; tags: Record<string, string> }>();
    // A binary heap of (cost, node).
    const heap: [number, string][] = [[0, from]];
    const push = (c: number, k: string) => {
      heap.push([c, k]);
      for (let i = heap.length - 1; i > 0; ) {
        const p = (i - 1) >> 1;
        if (heap[p]![0] <= heap[i]![0]) break;
        [heap[p], heap[i]] = [heap[i]!, heap[p]!];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ; ) {
          const l = i * 2 + 1;
          const rr = l + 1;
          let m = i;
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
          if (rr < heap.length && heap[rr]![0] < heap[m]![0]) m = rr;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i]!, heap[m]!];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const [c, k] = pop();
      if (k === to) break;
      if (c > (dist.get(k) ?? Infinity)) continue;
      for (const edge of nodes.get(k)!.out) {
        const nc = c + edge.cost;
        if (nc < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, nc);
          prev.set(edge.to, { from: k, tags: edge.tags });
          push(nc, edge.to);
        }
      }
    }
    if (!prev.has(to)) throw new Error(`no path for leg ${leg}`);
    const rev: { lat: number; lon: number; tags: Record<string, string> }[] = [];
    for (let k = to; k !== from; ) {
      const p = prev.get(k)!;
      const nd = nodes.get(k)!;
      rev.push({ lat: nd.lat, lon: nd.lon, tags: p.tags });
      k = p.from;
    }
    const first = nodes.get(from)!;
    if (leg === 0) line.push({ lat: first.lat, lon: first.lon, tags: rev[rev.length - 1]!.tags });
    line.push(...rev.reverse());
  }
  return line;
}

// ------------------------------------------------------------------ elevation

/** Minimal PNG reader for the GSI elevation tiles (8-bit RGB or RGBA, no interlace). */
function decodePng(bytes: Uint8Array): { width: number; height: number; channels: number; data: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 3;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  let colorType = 2;
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      colorType = body[9]!;
      if (body[8] !== 8 || body[12] !== 0) throw new Error("png: only 8-bit, non-interlaced");
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 0 ? 1 : 2;
    } else if (type === "PLTE") palette = body.slice();
    else if (type === "IDAT") idat.push(body);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[o + x - channels]! : 0;
      const b = y > 0 ? out[o - stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[o - stride + x - channels]! : 0;
      let v = row[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[o + x] = v & 255;
    }
  }
  if (colorType === 3 && palette) {
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) rgb.set(palette.subarray(out[i]! * 3, out[i]! * 3 + 3), i * 3);
    return { width, height, channels: 3, data: rgb };
  }
  return { width, height, channels, data: out };
}

const NA = -32768;

/** GSI elevation tiles of one zoom level, fetched on demand and sampled bilinearly. */
class Dem {
  private tiles = new Map<string, Float32Array | null>();
  constructor(private zoom: number) {}

  async tile(x: number, y: number): Promise<Float32Array | null> {
    const k = `${x}/${y}`;
    if (this.tiles.has(k)) return this.tiles.get(k)!;
    const dir = `${CACHE}/dem/${this.zoom}/${x}`;
    const path = `${dir}/${y}.png`;
    const missing = `${dir}/${y}.none`;
    let bytes: Uint8Array | null = null;
    const refresh = REFRESH === "dem" || REFRESH === "all";
    if (existsSync(path) && !refresh) bytes = new Uint8Array(readFileSync(path));
    else if (!existsSync(missing) || refresh) {
      mkdirSync(dir, { recursive: true });
      for (let attempt = 0; attempt < 5 && !bytes; attempt++) {
        try {
          const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/${this.zoom}/${x}/${y}.png`, { signal: AbortSignal.timeout(30_000) });
          if (r.status === 404) {
            writeFileSync(missing, "");
            break;
          }
          if (!r.ok) throw new Error(`${r.status}`);
          bytes = new Uint8Array(await r.arrayBuffer());
          writeFileSync(path, bytes);
        } catch {
          await Bun.sleep(1000 * (attempt + 1));
        }
      }
    }
    let h: Float32Array | null = null;
    if (bytes) {
      const png = decodePng(bytes);
      h = new Float32Array(256 * 256);
      for (let i = 0; i < 256 * 256; i++) {
        const o = i * png.channels;
        const v = png.data[o]! * 65536 + png.data[o + 1]! * 256 + png.data[o + 2]!;
        h[i] = v === 8388608 ? NaN : v < 8388608 ? v * 0.01 : (v - 16777216) * 0.01;
      }
    }
    this.tiles.set(k, h);
    return h;
  }

  /** Elevation at a geographic point (NaN over the sea or outside the tiles). */
  async at(lat: number, lon: number): Promise<number> {
    const n = 2 ** this.zoom;
    const fx = ((lon + 180) / 360) * n * 256 - 0.5;
    const s = Math.sin((lat * Math.PI) / 180);
    const fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * 256 - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const px = async (x: number, y: number) => {
      const t = await this.tile(x >> 8, y >> 8);
      return t ? t[(y & 255) * 256 + (x & 255)]! : NaN;
    };
    const [a, b, c, d] = [await px(x0, y0), await px(x0 + 1, y0), await px(x0, y0 + 1), await px(x0 + 1, y0 + 1)];
    const u = fx - x0;
    const v = fy - y0;
    const vals = [a, b, c, d];
    const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
    let sum = 0;
    let ws = 0;
    for (let i = 0; i < 4; i++) {
      if (!Number.isNaN(vals[i]!)) {
        sum += vals[i]! * w[i]!;
        ws += w[i]!;
      }
    }
    return ws > 0.2 ? sum / ws : NaN;
  }
}

/** A regular elevation grid in the route frame; cells further than `reach` from the line stay empty. */
interface Grid {
  cell: number;
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  h: Int16Array;
}

/** Distance from points to the driven line, through a coarse hash of its segments. */
class LineIndex {
  private cells = new Map<number, number[]>();
  private size = 512;
  constructor(readonly pts: Float64Array) {
    for (let i = 0; i + 1 < pts.length / 2; i++) {
      const x0 = Math.floor(Math.min(pts[i * 2]!, pts[i * 2 + 2]!) / this.size);
      const x1 = Math.floor(Math.max(pts[i * 2]!, pts[i * 2 + 2]!) / this.size);
      const z0 = Math.floor(Math.min(pts[i * 2 + 1]!, pts[i * 2 + 3]!) / this.size);
      const z1 = Math.floor(Math.max(pts[i * 2 + 1]!, pts[i * 2 + 3]!) / this.size);
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) {
          const k = (x + 32768) * 65536 + (z + 32768);
          const a = this.cells.get(k);
          if (a) a.push(i);
          else this.cells.set(k, [i]);
        }
    }
  }
  /** Distance to the line, or `limit` when further. */
  distance(x: number, z: number, limit: number): number {
    const r = Math.ceil(limit / this.size);
    const cx = Math.floor(x / this.size);
    const cz = Math.floor(z / this.size);
    let best = limit * limit;
    for (let ix = cx - r; ix <= cx + r; ix++)
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const list = this.cells.get((ix + 32768) * 65536 + (iz + 32768));
        if (!list) continue;
        for (const i of list) {
          const ax = this.pts[i * 2]!;
          const az = this.pts[i * 2 + 1]!;
          const bx = this.pts[i * 2 + 2]!;
          const bz = this.pts[i * 2 + 3]!;
          const dx = bx - ax;
          const dz = bz - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
          const ex = ax + dx * t - x;
          const ez = az + dz * t - z;
          best = Math.min(best, ex * ex + ez * ez);
        }
      }
    return Math.sqrt(best);
  }
}

async function grid(frame: Frame, index: LineIndex, bounds: [number, number, number, number], spec: { zoom: number; cell: number; reach: number }): Promise<Grid> {
  const dem = new Dem(spec.zoom);
  const c = spec.cell;
  const x0 = Math.floor((bounds[0] - spec.reach) / c) * c;
  const z0 = Math.floor((bounds[1] - spec.reach) / c) * c;
  const nx = Math.ceil((bounds[2] + spec.reach - x0) / c) + 1;
  const nz = Math.ceil((bounds[3] + spec.reach - z0) / c) + 1;
  const h = new Int16Array(nx * nz).fill(NA);
  let filled = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ix * c;
      const z = z0 + iz * c;
      if (index.distance(x, z, spec.reach + c) > spec.reach) continue;
      const [lat, lon] = toGeo(frame, x, z);
      const v = await dem.at(lat, lon);
      if (Number.isNaN(v)) continue;
      h[iz * nx + ix] = Math.max(-32767, Math.min(32767, Math.round(v * 10)));
      filled++;
    }
    if (iz % 200 === 0) console.log(`dem z${spec.zoom}: row ${iz}/${nz}`);
  }
  console.log(`dem z${spec.zoom}: ${nx}×${nz} cells of ${c} m, ${filled} filled`);
  return { cell: c, x0, z0, nx, nz, h };
}

/** Header (magic, cell, origin, size) then the rows' horizontal deltas, deflated. */
function writeGrid(path: string, g: Grid): void {
  const delta = new Int16Array(g.h.length);
  for (let iz = 0; iz < g.nz; iz++) {
    let prev = 0;
    for (let ix = 0; ix < g.nx; ix++) {
      const v = g.h[iz * g.nx + ix]!;
      delta[iz * g.nx + ix] = (v - prev) | 0;
      prev = v;
    }
  }
  const body = deflateSync(Buffer.from(delta.buffer), { level: 9 });
  const head = new DataView(new ArrayBuffer(32));
  head.setUint32(0, 0x4d454452, true); // "RDEM"
  head.setUint32(4, 1, true);
  head.setFloat32(8, g.cell, true);
  head.setFloat32(12, g.x0, true);
  head.setFloat32(16, g.z0, true);
  head.setUint32(20, g.nx, true);
  head.setUint32(24, g.nz, true);
  head.setUint32(28, body.length, true);
  writeFileSync(path, Buffer.concat([Buffer.from(head.buffer), body]));
  console.log(`${path}: ${((32 + body.length) / 1024).toFixed(0)} KiB`);
}

function sampleGrid(g: Grid, x: number, z: number): number {
  const fx = (x - g.x0) / g.cell;
  const fz = (z - g.z0) / g.cell;
  const ix = Math.max(0, Math.min(g.nx - 2, Math.floor(fx)));
  const iz = Math.max(0, Math.min(g.nz - 2, Math.floor(fz)));
  const u = Math.max(0, Math.min(1, fx - ix));
  const v = Math.max(0, Math.min(1, fz - iz));
  const at = (i: number, j: number) => g.h[j * g.nx + i]!;
  const vals = [at(ix, iz), at(ix + 1, iz), at(ix, iz + 1), at(ix + 1, iz + 1)];
  const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
  let s = 0;
  let ws = 0;
  for (let i = 0; i < 4; i++)
    if (vals[i] !== NA) {
      s += vals[i]! * w[i]!;
      ws += w[i]!;
    }
  return ws > 0 ? s / ws / 10 : NaN;
}

// ------------------------------------------------------------------- features

const FEATURE_KINDS = ["road", "rail", "building", "land", "water", "waterway", "power", "tower", "treeRow", "point"] as const;
type FeatureKind = (typeof FEATURE_KINDS)[number];

interface Feature {
  kind: FeatureKind;
  /** Subclass: the highway class, the land use, the shop kind … */
  type: string;
  name?: string;
  /** Tags the generators read (levels, lanes, bridge, layer, brand …). */
  tags?: Record<string, string | number>;
  /** Decimetres in the route frame: x0, z0, then deltas. A closed ring repeats its first point. */
  pts: number[];
  /** Further rings of an area: holes. */
  holes?: number[][];
}

function encode(frame: Frame, g: { lat: number; lon: number }[]): number[] {
  const out: number[] = [];
  let px = 0;
  let pz = 0;
  for (const p of g) {
    const [x, z] = toLocal(frame, p.lat, p.lon);
    const qx = Math.round(x * 10);
    const qz = Math.round(z * 10);
    out.push(qx - px, qz - pz);
    px = qx;
    pz = qz;
  }
  return out;
}

const keep = (tags: Record<string, string>, keys: string[]): Record<string, string | number> | undefined => {
  const out: Record<string, string | number> = {};
  for (const k of keys) {
    const v = tags[k];
    if (v === undefined) continue;
    const n = Number(v);
    out[k] = v !== "" && Number.isFinite(n) ? n : v;
  }
  return Object.keys(out).length ? out : undefined;
};

async function features(frame: Frame, line: { lat: number; lon: number }[]): Promise<Feature[]> {
  // The line thinned to ~300 m, in pieces short enough for one query each.
  const thin = [line[0]!];
  for (const p of line) if (metres(thin[thin.length - 1]!, p) > 300) thin.push(p);
  thin.push(line[line.length - 1]!);
  const pieces: string[] = [];
  for (let i = 0; i < thin.length; i += 39) pieces.push(thin.slice(i, i + 40).map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(","));
  const c = survey.corridor;
  const out: Feature[] = [];
  const seen = new Set<string>();
  const once = (e: OsmElement) => {
    const k = `${e.type}${e.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const rings = (e: OsmElement): { outer: { lat: number; lon: number }[][]; inner: { lat: number; lon: number }[][] } => {
    if (e.type === "way") return { outer: e.geometry ? [e.geometry] : [], inner: [] };
    // Multipolygon members are pieces of rings: join them end to end.
    const join = (role: string) => {
      const parts = (e.members ?? []).filter((m) => m.type === "way" && m.role === role && m.geometry?.length).map((m) => m.geometry!.slice());
      const done: { lat: number; lon: number }[][] = [];
      const same = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => a.lat === b.lat && a.lon === b.lon;
      while (parts.length) {
        let ring = parts.pop()!;
        for (let grew = true; grew && !same(ring[0]!, ring[ring.length - 1]!); ) {
          grew = false;
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i]!;
            if (same(ring[ring.length - 1]!, p[0]!)) ring = ring.concat(p.slice(1));
            else if (same(ring[ring.length - 1]!, p[p.length - 1]!)) ring = ring.concat(p.reverse().slice(1));
            else continue;
            parts.splice(i, 1);
            grew = true;
            break;
          }
        }
        if (ring.length >= 4 && same(ring[0]!, ring[ring.length - 1]!)) done.push(ring);
      }
      return done;
    };
    return { outer: join("outer"), inner: join("inner") };
  };
  for (let i = 0; i < pieces.length; i++) {
    const P = pieces[i]!;
    const roads = await overpass(`roads-${i}`, `(way(around:${c.roads},${P})[highway~"^(${DRIVABLE}|track)$"];);out geom;`);
    for (const e of roads) {
      if (!once(e) || !e.geometry) continue;
      const t = e.tags ?? {};
      out.push({ kind: "road", type: t.highway!, name: t.name, tags: keep(t, ["ref", "lanes", "oneway", "bridge", "tunnel", "layer", "maxspeed", "surface", "width", "service"]), pts: encode(frame, e.geometry) });
    }
    const rail = await overpass(`rail-${i}`, `(way(around:${c.rail},${P})[railway~"^(rail|light_rail)$"];node(around:${c.rail},${P})[railway~"^(station|halt|level_crossing)$"];);out geom;`);
    for (const e of rail) {
      if (!once(e)) continue;
      const t = e.tags ?? {};
      if (e.type === "way" && e.geometry) out.push({ kind: "rail", type: t.railway!, name: t.name, tags: keep(t, ["bridge", "tunnel", "electrified", "service", "layer"]), pts: encode(frame, e.geometry) });
      else if (e.type === "node") out.push({ kind: "point", type: `rail-${t.railway}`, name: t.name, pts: encode(frame, [{ lat: e.lat!, lon: e.lon! }]) });
    }
    const buildings = await overpass(`buildings-${i}`, `(way(around:${c.buildings},${P})[building];relation(around:${c.buildings},${P})[building];);out geom;`);
    for (const e of buildings) {
      if (!once(e)) continue;
      const t = e.tags ?? {};
      const r = rings(e);
      for (const outer of r.outer) {
        out.push({ kind: "building", type: t.building === "yes" ? (t.shop ? "retail" : t.amenity ?? "yes") : t.building!, name: t.name, tags: keep(t, ["building:levels", "height", "roof:shape", "shop", "amenity", "brand", "man_made"]), pts: encode(frame, outer), holes: r.inner.length ? r.inner.map((h) => encode(frame, h)) : undefined });
      }
    }
    const land = await overpass(
      `land-${i}`,
      `(way(around:${c.land},${P})[landuse];relation(around:${c.land},${P})[landuse];way(around:${c.land},${P})[natural~"^(wood|scrub|water|wetland|grassland|heath)$"];relation(around:${c.land},${P})[natural~"^(wood|scrub|water|wetland|grassland|heath)$"];way(around:${c.land},${P})[waterway~"^(river|stream|canal|drain|ditch)$"];way(around:${c.roads},${P})[natural=tree_row];way(around:${c.roads},${P})[leisure~"^(park|pitch|golf_course)$"];way(around:${c.roads},${P})[amenity=parking];);out geom;`,
    );
    for (const e of land) {
      if (!once(e)) continue;
      const t = e.tags ?? {};
      if (t.waterway && e.geometry) {
        out.push({ kind: "waterway", type: t.waterway, name: t.name, tags: keep(t, ["width", "tunnel", "layer"]), pts: encode(frame, e.geometry) });
        continue;
      }
      if (t.natural === "tree_row" && e.geometry) {
        out.push({ kind: "treeRow", type: t.leaf_type ?? "row", tags: keep(t, ["species", "genus", "leaf_cycle"]), pts: encode(frame, e.geometry) });
        continue;
      }
      const type = t.natural ?? t.landuse ?? (t.leisure ? `leisure-${t.leisure}` : t.amenity ? `amenity-${t.amenity}` : "");
      if (!type) continue;
      const r = rings(e);
      for (const outer of r.outer) {
        if (outer.length < 4) continue;
        out.push({ kind: type === "water" || type === "wetland" || type === "reservoir" || type === "basin" ? "water" : "land", type, name: t.name, tags: keep(t, ["leaf_type", "leaf_cycle", "crop", "water", "residential"]), pts: encode(frame, outer), holes: r.inner.length ? r.inner.map((h) => encode(frame, h)) : undefined });
      }
    }
    const power = await overpass(`power-${i}`, `(way(around:${c.power},${P})[power~"^(line|minor_line)$"];node(around:${c.power},${P})[power~"^(tower|pole)$"];node(around:${c.power},${P})[man_made~"^(tower|mast|silo|chimney|communications_tower)$"];);out geom;`);
    for (const e of power) {
      if (!once(e)) continue;
      const t = e.tags ?? {};
      if (e.type === "way" && e.geometry) out.push({ kind: "power", type: t.power!, tags: keep(t, ["voltage", "cables"]), pts: encode(frame, e.geometry) });
      else if (e.type === "node") out.push({ kind: "tower", type: t.power ? `power-${t.power}` : t.man_made!, tags: keep(t, ["height"]), pts: encode(frame, [{ lat: e.lat!, lon: e.lon! }]) });
    }
    const points = await overpass(
      `points-${i}`,
      `(nwr(around:${c.points},${P})[shop];nwr(around:${c.points},${P})[amenity~"^(fuel|restaurant|cafe|fast_food|police|post_office|townhall|school|fire_station|hospital|bank|place_of_worship|community_centre)$"];nwr(around:${c.points},${P})[tourism];node(around:${c.points},${P})[highway~"^(traffic_signals|crossing|bus_stop|street_lamp|stop)$"];node(around:${c.land},${P})[place~"^(city|town|village|hamlet|suburb|neighbourhood|locality)$"];node(around:${c.land},${P})[natural=peak];);out center tags;`,
    );
    for (const e of points) {
      if (!once(e)) continue;
      const t = e.tags ?? {};
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      if (lat === undefined || lon === undefined) continue;
      const type = t.highway ?? (t.place ? `place-${t.place}` : t.natural === "peak" ? "peak" : t.shop ? `shop-${t.shop}` : t.amenity ? `amenity-${t.amenity}` : t.tourism ? `tourism-${t.tourism}` : "");
      if (!type) continue;
      out.push({ kind: "point", type, name: t.name, tags: keep(t, ["brand", "name:en", "name:ja", "ele", "population", "crossing", "traffic_signals:direction", "direction"]), pts: encode(frame, [{ lat, lon }]) });
    }
  }
  return out;
}

// --------------------------------------------------------------- centre line

/** Centripetal Catmull–Rom through the points, sampled every `step` metres of arc. */
function smoothLine(pts: [number, number][], step: number): [number, number][] {
  const dense: [number, number][] = [];
  const n = pts.length;
  const at = (i: number) => pts[Math.max(0, Math.min(n - 1, i))]!;
  for (let i = 0; i + 1 < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const d = (a: [number, number], b: [number, number]) => Math.max(1e-3, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5);
    const t0 = 0;
    const t1 = t0 + d(p0, p1);
    const t2 = t1 + d(p1, p2);
    const t3 = t2 + d(p2, p3);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(1, Math.ceil(len / 1));
    for (let j = 0; j < k; j++) {
      const t = t1 + ((t2 - t1) * j) / k;
      const mix = (a: [number, number], b: [number, number], ta: number, tb: number): [number, number] => {
        const w = (t - ta) / (tb - ta || 1);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      };
      const a1 = mix(p0, p1, t0, t1);
      const a2 = mix(p1, p2, t1, t2);
      const a3 = mix(p2, p3, t2, t3);
      const b1 = mix(a1, a2, t0, t2);
      const b2 = mix(a2, a3, t1, t3);
      dense.push(mix(b1, b2, t1, t2));
    }
  }
  dense.push(pts[n - 1]!);
  // Resample by arc length.
  const out: [number, number][] = [dense[0]!];
  let carry = 0;
  for (let i = 0; i + 1 < dense.length; i++) {
    const a = dense[i]!;
    const b = dense[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= len) {
      out.push([a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len]);
      t += step;
    }
    carry = len - (t - step);
  }
  return out;
}

/** Gaussian smoothing of a sampled series (σ in samples), the ends held. */
function gauss(v: Float64Array, sigma: number): Float64Array {
  const r = Math.ceil(sigma * 3);
  const w = Array.from({ length: r * 2 + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let s = 0;
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = Math.max(0, Math.min(v.length - 1, i + k));
      s += v[j]! * w[k + r]!;
      ws += w[k + r]!;
    }
    out[i] = s / ws;
  }
  return out;
}

// ----------------------------------------------------------------------- main

const STEP = 5;
const line = await drivenLine();
let lineKm = 0;
for (let i = 0; i + 1 < line.length; i++) lineKm += metres(line[i]!, line[i + 1]!) / 1000;
console.log(`driven line: ${line.length} OSM points, ${lineKm.toFixed(2)} km`);

// Frame: the plane's origin moved to the middle of the line's bounds, on a whole kilometre.
const plane = line.map((p) => project(JPRCS_XII, p.lat, p.lon));
const mid = (sel: (p: { north: number; east: number }) => number) => Math.round((Math.min(...plane.map(sel)) + Math.max(...plane.map(sel))) / 2000) * 1000;
const frame: Frame = { zone: JPRCS_XII, north0: mid((p) => p.north), east0: mid((p) => p.east) };
const [originLat, originLon] = toGeo(frame, 0, 0);

const raw: [number, number][] = line.map((p) => toLocal(frame, p.lat, p.lon));
const smooth = smoothLine(raw, STEP);
const n = smooth.length;
// Corners of the OSM polyline rounded over ~15 m; the line moves by centimetres on straights.
const sx = gauss(Float64Array.from(smooth, (p) => p[0]), 3);
const sz = gauss(Float64Array.from(smooth, (p) => p[1]), 3);
const flat = new Float64Array(n * 2);
for (let i = 0; i < n; i++) {
  flat[i * 2] = sx[i]!;
  flat[i * 2 + 1] = sz[i]!;
}
const index = new LineIndex(flat);
const bounds: [number, number, number, number] = [Math.min(...sx), Math.min(...sz), Math.max(...sx), Math.max(...sz)];
console.log(`frame origin ${originLat.toFixed(6)}, ${originLon.toFixed(6)} (XII north ${frame.north0}, east ${frame.east0}); bounds x ${bounds[0].toFixed(0)}..${bounds[2].toFixed(0)}, z ${bounds[1].toFixed(0)}..${bounds[3].toFixed(0)}; ${n} samples`);

// Attributes per sample: the nearest OSM point's way tags.
const rawS = new Float64Array(raw.length);
for (let i = 1; i < raw.length; i++) rawS[i] = rawS[i - 1]! + Math.hypot(raw[i]![0] - raw[i - 1]![0], raw[i]![1] - raw[i - 1]![1]);
const scale = rawS[raw.length - 1]! / ((n - 1) * STEP);
const tagsAt = (i: number): Record<string, string> => {
  const s = i * STEP * scale;
  let lo = 0;
  let hi = raw.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (rawS[m]! < s) lo = m + 1;
    else hi = m;
  }
  return line[Math.min(raw.length - 1, lo)]!.tags;
};

const near = await grid(frame, index, bounds, survey.dem.near);
const midGrid = await grid(frame, index, bounds, survey.dem.mid);
const far = await grid(frame, index, bounds, survey.dem.far);
writeGrid(`${OUT}/dem-near.bin`, near);
writeGrid(`${OUT}/dem-mid.bin`, midGrid);
writeGrid(`${OUT}/dem-far.bin`, far);

// The road's own profile: the ground under the line, bridges strung between
// their abutments, then smoothed over ~60 m (the 10 m grid's steps are not
// the road's) with grades held under 7 %.
const ground = new Float64Array(n);
const bridge = new Uint8Array(n);
for (let i = 0; i < n; i++) {
  ground[i] = sampleGrid(near, sx[i]!, sz[i]!);
  bridge[i] = tagsAt(i).bridge && tagsAt(i).bridge !== "no" ? 1 : 0;
}
for (let i = 0; i < n; i++) if (Number.isNaN(ground[i]!)) ground[i] = i > 0 ? ground[i - 1]! : 0;
const profile = Float64Array.from(ground);
for (let i = 0; i < n; ) {
  if (!bridge[i]) {
    i++;
    continue;
  }
  let j = i;
  while (j < n && bridge[j]) j++;
  // Abutments three samples back from each end, on firm ground.
  const a = Math.max(0, i - 3);
  const b = Math.min(n - 1, j + 2);
  for (let k = a; k <= b; k++) profile[k] = ground[a]! + ((ground[b]! - ground[a]!) * (k - a)) / Math.max(1, b - a);
  i = j;
}
let y = gauss(profile, 12);
for (let pass = 0; pass < 4; pass++) {
  for (let i = 1; i < n; i++) y[i] = Math.max(y[i - 1]! - 0.07 * STEP, Math.min(y[i - 1]! + 0.07 * STEP, y[i]!));
  for (let i = n - 2; i >= 0; i--) y[i] = Math.max(y[i + 1]! - 0.07 * STEP, Math.min(y[i + 1]! + 0.07 * STEP, y[i]!));
  y = gauss(y, 4);
}

// centerline.bin: "RCLN", version, count, step; then x, z, y (f32 each), then per sample
// lanes (u8), speed limit km/h (u8), flags (u8: 1 bridge, 2 tunnel, 4 the numbered road), spare.
const head = new DataView(new ArrayBuffer(16));
head.setUint32(0, 0x4e4c4352, true);
head.setUint32(4, 1, true);
head.setUint32(8, n, true);
head.setFloat32(12, STEP, true);
const xyz = new Float32Array(n * 3);
const attr = new Uint8Array(n * 4);
const names: { s: number; name: string; ref: string }[] = [];
const limits: { s: number; kmh: number }[] = [];
for (let i = 0; i < n; i++) {
  xyz[i * 3] = sx[i]!;
  xyz[i * 3 + 1] = sz[i]!;
  xyz[i * 3 + 2] = y[i]!;
  const t = tagsAt(i);
  const kmh = Number(t.maxspeed) || 0;
  attr[i * 4] = Number(t.lanes) || 2;
  attr[i * 4 + 1] = kmh;
  attr[i * 4 + 2] = (bridge[i]! ? 1 : 0) | (t.tunnel && t.tunnel !== "no" ? 2 : 0) | ((t.ref ?? "").split(";").includes(survey.ref) ? 4 : 0);
  const name = t.name ?? "";
  if (!names.length || names[names.length - 1]!.name !== name) names.push({ s: i * STEP, name, ref: t.ref ?? "" });
  if (kmh && (!limits.length || limits[limits.length - 1]!.kmh !== kmh)) limits.push({ s: i * STEP, kmh });
}
writeFileSync(`${OUT}/centerline.bin`, Buffer.concat([Buffer.from(head.buffer), Buffer.from(xyz.buffer), Buffer.from(attr.buffer)]));

const feats = await features(frame, line);
const counts: Record<string, number> = {};
for (const f of feats) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
const packed = deflateSync(Buffer.from(JSON.stringify({ version: 1, unit: 0.1, kinds: FEATURE_KINDS, features: feats.map((f) => [FEATURE_KINDS.indexOf(f.kind), f.type, f.name ?? 0, f.tags ?? 0, f.pts, ...(f.holes ? [f.holes] : [])]) })), { level: 9 });
writeFileSync(`${OUT}/features.bin`, packed);
console.log(`features: ${JSON.stringify(counts)} → ${(packed.length / 1024).toFixed(0)} KiB`);

const length = (n - 1) * STEP;
const minY = Math.min(...y);
const maxY = Math.max(...y);
writeFileSync(
  `${OUT}/route.json`,
  JSON.stringify(
    {
      version: 1,
      id: survey.id,
      surveyed: new Date().toISOString().slice(0, 10),
      sources: ["© OpenStreetMap contributors (ODbL)", "国土地理院 標高タイル DEM10B"],
      frame: { system: "JGD2011 / Japan Plane Rectangular CS XII", lat0: JPRCS_XII.lat0, lon0: JPRCS_XII.lon0, k0: JPRCS_XII.k0, north0: frame.north0, east0: frame.east0, origin: { lat: originLat, lon: originLon } },
      axes: "+X east, −Z north, y metres above sea level",
      step: STEP,
      samples: n,
      length,
      elevation: { min: Number(minY.toFixed(1)), max: Number(maxY.toFixed(1)), start: Number(y[0]!.toFixed(1)), end: Number(y[n - 1]!.toFixed(1)) },
      start: survey.start,
      end: survey.end,
      names,
      limits,
      features: counts,
    },
    null,
    1,
  ) + "\n",
);
console.log(`route ${survey.id}: ${(length / 1000).toFixed(2)} km, elevation ${minY.toFixed(0)}–${maxY.toFixed(0)} m, ${names.length} name changes, ${limits.length} limit changes`);
