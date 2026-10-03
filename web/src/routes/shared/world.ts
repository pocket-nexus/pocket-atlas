import { Line, type Projection } from "./line";
import { clamp, fbm2, smoothstep } from "./noise";
import type { Feature, RouteSource } from "./source";

/**
 * The route's ground model, derived once from the survey: the driven road
 * and every ploughed road of the corridor as centre lines with a profile,
 * and the ground they are cut into.
 *
 *   elevation(x, z)   the surveyed terrain
 *   base(x, z)        the terrain graded to the roadbeds (what buildings,
 *                     trees and the terrain mesh stand on)
 *   probe(x, z)       the ploughed area around a point: the signed distance
 *                     to its edge (negative on a road), the nearest road and
 *                     how deep the point is inside a road's own strip
 *   bank(e, s)        height of the snow a plough leaves beyond the edge
 *
 * Roads are ploughed bands; banks follow the edge of their union, so a side
 * road opens the main road's bank where it joins.
 */

/** How a class of road is kept in winter. */
export interface RoadClass {
  /** Ploughed half width (m). */
  half: number;
  /** Width of the strip mesh beyond the ploughed edge (bank and verge). */
  verge: number;
  /** Reach of the cut and fill beyond the roadbed (m). */
  grade: number;
  /** Mean bank height (m). */
  bank: number;
  /** Surface material: the driven road's rutted surface or packed snow. */
  surface: "road" | "lane";
}

export const ROAD_CLASSES: Record<string, RoadClass> = {
  // National routes: two 3.25 m lanes and 1 m shoulders ploughed full width.
  trunk: { half: 4.25, verge: 9, grade: 22, bank: 1.1, surface: "road" },
  primary: { half: 4.0, verge: 6, grade: 16, bank: 1.0, surface: "road" },
  secondary: { half: 3.5, verge: 5, grade: 12, bank: 0.9, surface: "lane" },
  tertiary: { half: 3.25, verge: 5, grade: 12, bank: 0.9, surface: "lane" },
  unclassified: { half: 2.75, verge: 4, grade: 9, bank: 0.8, surface: "lane" },
  residential: { half: 2.75, verge: 4, grade: 9, bank: 0.8, surface: "lane" },
  living_street: { half: 2.5, verge: 4, grade: 8, bank: 0.7, surface: "lane" },
  service: { half: 2.0, verge: 3, grade: 6, bank: 0.55, surface: "lane" },
};
for (const k of ["trunk", "primary", "secondary", "tertiary"]) ROAD_CLASSES[`${k}_link`] = { ...ROAD_CLASSES[k], half: 3.0 };

export class Road {
  readonly line: Line;
  /** Per point of the line: 1 on a bridge. */
  readonly bridge: Uint8Array;
  constructor(
    readonly index: number,
    readonly cls: RoadClass,
    readonly type: string,
    readonly name: string,
    /** The driven road. */
    readonly main: boolean,
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    z: ArrayLike<number>,
    bridge?: Uint8Array,
  ) {
    this.line = new Line(x, y, z);
    this.bridge = bridge ?? new Uint8Array(x.length);
  }
  get half(): number {
    return this.cls.half;
  }
  /** Half width of the strip this road's mesh covers. */
  get zone(): number {
    return this.cls.half + this.cls.verge;
  }
}

/** A side road meeting the driven road. */
export interface Junction {
  /** Arc length on the driven road. */
  s: number;
  /** −1 left, 1 right. */
  side: number;
  road: Road;
}

export interface Probe {
  /** Signed distance (m) to the edge of the ploughed area: negative on a road. 1e9 when no road is near. */
  e: number;
  /** The road whose edge that is, with the point's arc length and offset on it. */
  road: Road | null;
  s: number;
  d: number;
  /** Cut-and-fill weight (0..1) and the roadbed height it pulls toward. */
  w: number;
  y: number;
  /** Depth (m) inside a road's strip zone (≤ 0 outside every zone), and that road. */
  zone: number;
  zoneRoad: Road | null;
  zoneS: number;
  zoneD: number;
}

const HASH = 64;
const REACH = 40;

export class RouteWorld {
  readonly main: Road;
  readonly roads: Road[] = [];
  readonly junctions: Junction[] = [];
  /** Segment hash: per cell, (road, segment) pairs. */
  private cells = new Map<number, number[]>();
  private tmp: Projection = { s: 0, d: 0, i: 0 };

  constructor(readonly source: RouteSource) {
    const n = source.lineXZY.length / 3;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const z = new Float64Array(n);
    const bridge = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = source.lineXZY[i * 3];
      z[i] = source.lineXZY[i * 3 + 1];
      y[i] = source.lineXZY[i * 3 + 2];
      bridge[i] = source.lineAttr[i * 4 + 2] & 1;
    }
    this.main = new Road(0, ROAD_CLASSES.trunk, "trunk", source.route.names[0]?.name ?? "", true, x, y, z, bridge);
    this.roads.push(this.main);
    for (const f of source.features) if (f.kind === "road") this.addSideRoads(f);
    for (const r of this.roads) this.hashRoad(r);
    this.findJunctions();
  }

  /** The parts of a surveyed road that are not the driven road, resampled every 5 m with a profile. */
  private addSideRoads(f: Feature): void {
    const cls = ROAD_CLASSES[f.type];
    if (!cls || f.tags.tunnel) return;
    if (f.type === "service" && (f.tags.service === "driveway" || f.tags.service === "parking_aisle")) return;
    // Resample at 5 m, keeping the surveyed corners.
    const px: number[] = [];
    const pz: number[] = [];
    for (let i = 0; i + 2 < f.pts.length; i += 2) {
      const [ax, az, bx, bz] = [f.pts[i], f.pts[i + 1], f.pts[i + 2], f.pts[i + 3]];
      const len = Math.hypot(bx - ax, bz - az);
      const k = Math.max(1, Math.round(len / 5));
      for (let j = 0; j < k; j++) {
        px.push(ax + ((bx - ax) * j) / k);
        pz.push(az + ((bz - az) * j) / k);
      }
    }
    px.push(f.pts[f.pts.length - 2]);
    pz.push(f.pts[f.pts.length - 1]);
    if (px.length < 2) return;
    // Points on the driven road itself (the same way, or the rest of the numbered road).
    const main = this.main;
    const on = px.map((_, i) => {
      const p = main.line.project(px[i], pz[i], 6, this.tmp);
      if (!p || Math.abs(p.d) > 3) return false;
      const j = Math.min(px.length - 2, i);
      const tx = px[j + 1] - px[j];
      const tz = pz[j + 1] - pz[j];
      const m = main.line.at(p.s);
      return Math.abs(tx * m.tx + tz * m.tz) / (Math.hypot(tx, tz) || 1) > 0.9;
    });
    for (let i = 0; i < px.length; ) {
      if (on[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < px.length && !on[j]) j++;
      const a = Math.max(0, i - 1);
      const b = Math.min(px.length, j + 1);
      if (b - a >= 2) this.addRoad(cls, f, px.slice(a, b), pz.slice(a, b));
      i = j;
    }
  }

  private addRoad(cls: RoadClass, f: Feature, px: number[], pz: number[]): void {
    const n = px.length;
    const main = this.main;
    let y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = this.source.elevation(px[i], pz[i]);
    // The 10 m grid's steps are not the road's: smooth over ~30 m.
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      let w = 0;
      for (let k = -6; k <= 6; k++) {
        const j = clamp(i + k, 0, n - 1);
        const g = Math.exp(-(k * k) / 18);
        s += y[j] * g;
        w += g;
      }
      sm[i] = s / w;
    }
    y = sm;
    // Where it meets the driven road it takes that road's height.
    for (let i = 0; i < n; i++) {
      const p = main.line.project(px[i], pz[i], REACH, this.tmp);
      if (!p) continue;
      const w = 1 - smoothstep(main.half + 1, main.half + 26, Math.abs(p.d));
      if (w > 0) y[i] += (main.line.at(p.s).y - y[i]) * w;
    }
    this.roads.push(new Road(this.roads.length, cls, f.type, f.name, false, px, y, pz));
  }

  private hashRoad(r: Road): void {
    const l = r.line;
    for (let i = 0; i + 1 < l.n; i++) {
      const pad = r.half + REACH;
      const x0 = Math.floor((Math.min(l.x[i], l.x[i + 1]) - pad) / HASH);
      const x1 = Math.floor((Math.max(l.x[i], l.x[i + 1]) + pad) / HASH);
      const z0 = Math.floor((Math.min(l.z[i], l.z[i + 1]) - pad) / HASH);
      const z1 = Math.floor((Math.max(l.z[i], l.z[i + 1]) + pad) / HASH);
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const k = (cx + 32768) * 65536 + (cz + 32768);
          const list = this.cells.get(k);
          if (list) list.push(r.index, i);
          else this.cells.set(k, [r.index, i]);
        }
    }
  }

  private findJunctions(): void {
    const main = this.main;
    for (const r of this.roads) {
      if (r.main) continue;
      const l = r.line;
      let prev: number | null = null;
      for (let i = 0; i < l.n; i++) {
        const p = main.line.project(l.x[i], l.z[i], main.half + 12, this.tmp);
        const d = p ? p.d : null;
        const end = i === 0 || i === l.n - 1;
        // An end on the driven road, or a crossing of its centre line.
        if (p && d !== null && ((end && Math.abs(d) < main.half + 1.5) || (prev !== null && Math.sign(prev) !== Math.sign(d)))) {
          // Which side the road leaves on: its points a little further along.
          for (const dir of end ? [i === 0 ? 1 : -1] : [-1, 1]) {
            const j = clamp(i + dir * 4, 0, l.n - 1);
            const q = main.line.project(l.x[j], l.z[j], 60);
            if (q && Math.abs(q.d) > main.half) this.junctions.push({ s: p.s, side: Math.sign(q.d), road: r });
          }
        }
        prev = d;
      }
    }
    this.junctions.sort((a, b) => a.s - b.s);
  }

  /** Roads with a segment near the box (within the reach of their cut and fill). */
  roadsIn(x0: number, z0: number, x1: number, z1: number): Road[] {
    const seen = new Set<number>();
    for (let cx = Math.floor(x0 / HASH); cx <= Math.floor(x1 / HASH); cx++)
      for (let cz = Math.floor(z0 / HASH); cz <= Math.floor(z1 / HASH); cz++) {
        const list = this.cells.get((cx + 32768) * 65536 + (cz + 32768));
        if (list) for (let k = 0; k < list.length; k += 2) seen.add(list[k]);
      }
    return [...seen].sort((a, b) => a - b).map((i) => this.roads[i]);
  }

  /** Surveyed terrain. */
  elevation(x: number, z: number): number {
    return this.source.elevation(x, z);
  }

  /** The ploughed area, the cut and fill and the strip zones around a point. */
  probe(x: number, z: number, out: Probe): Probe {
    out.e = 1e9;
    out.road = null;
    out.w = 0;
    out.y = 0;
    out.zone = -1e9;
    out.zoneRoad = null;
    const list = this.cells.get((Math.floor(x / HASH) + 32768) * 65536 + (Math.floor(z / HASH) + 32768));
    if (!list) return out;
    let wsum = 0;
    let ysum = 0;
    // Segments arrive grouped by road in runs; a road's nearest segment decides its terms.
    let cur = -1;
    let bestD2 = Infinity;
    let bs = 0;
    let bd = 0;
    let bi = 0;
    const flush = () => {
      if (cur < 0 || bestD2 === Infinity) return;
      const r = this.roads[cur];
      const ad = Math.abs(bd);
      const e = ad - r.half;
      if (e < out.e) {
        out.e = e;
        out.road = r;
        out.s = bs;
        out.d = bd;
      }
      const zone = r.zone - ad;
      // The driven road's strip wins where zones overlap.
      if (zone > 0 && (out.zoneRoad === null || (r.main && !out.zoneRoad.main) || (r.main === out.zoneRoad.main && zone > out.zone))) {
        out.zone = zone;
        out.zoneRoad = r;
        out.zoneS = bs;
        out.zoneD = bd;
      }
      if (r.bridge[bi] === 0) {
        const w = 1 - smoothstep(r.half + 1.5, r.half + 1.5 + r.cls.grade, ad);
        if (w > 0) {
          const l = r.line;
          const len = l.s[bi + 1] - l.s[bi] || 1;
          const t = (bs - l.s[bi]) / len;
          const ry = l.y[bi] + (l.y[bi + 1] - l.y[bi]) * t - 0.02 * Math.min(ad, r.half);
          // The driven road sets the grade where roads meet.
          const k = r.main ? w * 4 : w;
          wsum += k;
          ysum += ry * k;
          out.w = Math.max(out.w, w);
        }
      }
    };
    for (let k = 0; k < list.length; k += 2) {
      const ri = list[k];
      if (ri !== cur) {
        flush();
        cur = ri;
        bestD2 = Infinity;
      }
      const l = this.roads[ri].line;
      const i = list[k + 1];
      const ax = l.x[i];
      const az = l.z[i];
      const dx = l.x[i + 1] - ax;
      const dz = l.z[i + 1] - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
      const ex = x - (ax + dx * t);
      const ez = z - (az + dz * t);
      const d2 = ex * ex + ez * ez;
      if (d2 < bestD2) {
        bestD2 = d2;
        bs = l.s[i] + Math.sqrt(l2) * t;
        bd = Math.sign(-dz * ex + dx * ez || 1) * Math.sqrt(d2);
        bi = i;
      }
    }
    flush();
    if (wsum > 0) out.y = ysum / wsum;
    return out;
  }

  private scratch: Probe = { e: 0, road: null, s: 0, d: 0, w: 0, y: 0, zone: 0, zoneRoad: null, zoneS: 0, zoneD: 0 };

  /** The terrain graded to the roadbeds. */
  base(x: number, z: number, probe?: Probe): number {
    const p = probe ?? this.probe(x, z, this.scratch);
    const h = this.elevation(x, z);
    return p.w > 0 ? h + (p.y - h) * p.w : h;
  }

  /**
   * Height of the ploughed bank `e` metres beyond the edge, at arc length
   * `s`: a cut face, a crest 0.9 m back, a slope spent 3.6 m back. Its
   * height swells and sags along the road.
   */
  bank(e: number, s: number, cls: RoadClass, side: number): number {
    if (e <= 0 || e >= 3.6) return 0;
    const h = cls.bank * (0.62 + 0.76 * fbm2(s / 55 + side * 17.3, side * 3.1, 3, 5));
    const rise = e < 0.15 ? (e / 0.15) * 0.62 : e < 0.9 ? 0.62 + 0.38 * smoothstep(0.15, 0.9, e) : 1 - smoothstep(0.9, 3.6, e);
    return h * rise;
  }
}
