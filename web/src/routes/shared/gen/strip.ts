import type { MeshBuilder, V3 } from "../mesh";
import { normalize, WHITE } from "../mesh";
import { fbm2 } from "../noise";
import type { Probe, Road, RouteWorld } from "../world";

/**
 * Roads as strips: at every station along a road, a cross-section from the
 * verge on one side over the bank, the ploughed surface and the other bank
 * to the other verge. The carriageway takes the road's surface material
 * with u across its width and v along it (wheel tracks run along v); what
 * lies beyond it is snow, or packed snow where another road's ploughed band
 * crosses (the mouth of a side road: the bank opens there because banks
 * follow the edge of the union of the bands).
 */

/** Bank and verge stations beyond the ploughed edge (m): cut face, shoulder, crest, back slope, verge. */
export const BEYOND = [0.2, 0.5, 0.9, 1.7, 2.6, 3.6, 6, 9];

/**
 * Tint of the bank's snow by distance beyond the ploughed edge (sRGB): in
 * January the cut face is a little greyer than the top and neutral (the
 * brown grit is March's), darkest at its foot and in lengths along the
 * road; the shoulder above it is clean.
 */
function bankTint(e: number, s: number, side: number): readonly [number, number, number, number] {
  if (e >= 0.9) return WHITE;
  const dirt = Math.exp(-Math.max(e, 0) / 0.25) * (0.4 + 0.8 * fbm2(s / 9 + side * 31.7, side * 5.3, 3, 11));
  return [Math.round(255 - 64 * dirt), Math.round(255 - 62 * dirt), Math.round(255 - 56 * dirt), 255];
}

/** How far the strip's outer edge drops under the terrain grid it meets. */
export const SKIRT = 0.6;
/** Metres of road per repeat of the surface texture along the road. */
export const SURFACE_REPEAT = 8;

/** Offsets of a road's cross-section, left to right, and which are on the carriageway. */
function offsets(road: Road): { d: number[]; first: number; last: number } {
  const beyond = BEYOND.filter((e) => e < road.cls.verge);
  beyond.push(road.cls.verge);
  const d: number[] = [];
  for (let k = beyond.length - 1; k >= 0; k--) d.push(-(road.half + beyond[k]));
  const first = d.length;
  d.push(-road.half, 0, road.half);
  const last = d.length - 1;
  for (const e of beyond) d.push(road.half + e);
  return { d, first, last };
}

/** Stations of a road: its line's points, and on the driven road extra ones at the edges of every side road's mouth. */
export function stations(world: RouteWorld, road: Road): Float64Array {
  const s: number[] = Array.from(road.line.s);
  if (road.main) {
    for (const j of world.junctions) {
      const w = j.road.half;
      for (const o of [-(w + 1.6), -(w + 0.3), 0, w + 0.3, w + 1.6]) s.push(j.s + o);
    }
  }
  s.sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (v >= 0 && v <= road.line.length && (!out.length || v - out[out.length - 1] > 0.35)) out.push(v);
  return Float64Array.from(out);
}

const stationCache = new WeakMap<Road, Float64Array>();

export function roadStrip(world: RouteWorld, road: Road, x0: number, z0: number, x1: number, z1: number, mb: MeshBuilder): void {
  let st = stationCache.get(road);
  if (!st) stationCache.set(road, (st = stations(world, road)));
  const line = road.line;
  const off = offsets(road);
  const nd = off.d.length;
  // Stations whose cross-section can reach the cell.
  const pad = road.zone + 12;
  let lo = -1;
  let hi = -1;
  const pt = { x: 0, y: 0, z: 0, tx: 0, tz: -1, grade: 0 };
  const near: boolean[] = [];
  for (let k = 0; k < st.length; k++) {
    line.at(st[k], pt);
    const inside = pt.x > x0 - pad && pt.x < x1 + pad && pt.z > z0 - pad && pt.z < z1 + pad;
    near.push(inside);
    if (inside) {
      if (lo < 0) lo = k;
      hi = k;
    }
  }
  if (lo < 0) return;
  lo = Math.max(0, lo - 1);
  hi = Math.min(st.length - 1, hi + 1);
  const count = hi - lo + 1;
  const pos = new Float64Array(count * nd * 3);
  const edge = new Float64Array(count * nd);
  const bridge = new Uint8Array(count);
  const probe: Probe = { e: 0, road: null, s: 0, d: 0, w: 0, y: 0, zone: 0, zoneRoad: null, zoneS: 0, zoneD: 0 };
  for (let k = 0; k < count; k++) {
    const s = st[lo + k];
    line.at(s, pt);
    bridge[k] = road.bridge[line.segment(s)];
    const rx = -pt.tz;
    const rz = pt.tx;
    for (let j = 0; j < nd; j++) {
      const d = off.d[j];
      const x = pt.x + rx * d;
      const z = pt.z + rz * d;
      let y: number;
      let e = Math.abs(d) - road.half;
      if (j >= off.first && j <= off.last) {
        y = pt.y - 0.02 * Math.abs(d);
      } else {
        world.probe(x, z, probe);
        e = probe.e;
        y = world.base(x, z, probe);
        if (probe.road && e > 0) y += world.bank(e, probe.s, probe.road.cls, Math.sign(probe.d));
        if (j === 0 || j === nd - 1) y -= SKIRT;
      }
      const o = (k * nd + j) * 3;
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
      edge[k * nd + j] = e;
    }
  }
  // Smooth normals over the grid of stations and offsets.
  const nrm = new Float64Array(count * nd * 3);
  const at = (k: number, j: number): V3 => {
    const o = (Math.max(0, Math.min(count - 1, k)) * nd + Math.max(0, Math.min(nd - 1, j))) * 3;
    return [pos[o], pos[o + 1], pos[o + 2]];
  };
  for (let k = 0; k < count; k++)
    for (let j = 0; j < nd; j++) {
      const a = at(k - 1, j);
      const b = at(k + 1, j);
      const c = at(k, j - 1);
      const d = at(k, j + 1);
      const along: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const across: V3 = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
      // across × along points up for offsets running left to right.
      const n = normalize([across[1] * along[2] - across[2] * along[1], across[2] * along[0] - across[0] * along[2], across[0] * along[1] - across[1] * along[0]]);
      const o = (k * nd + j) * 3;
      nrm[o] = n[0];
      nrm[o + 1] = n[1] < 0 ? -n[1] : n[1];
      nrm[o + 2] = n[2];
    }
  const surface = road.cls.surface;
  const seen = new Map<string, number>();
  const vert = (material: string, k: number, j: number, planar: boolean): number => {
    const key = `${material}|${k}|${j}`;
    const hit = seen.get(key);
    if (hit !== undefined) return hit;
    const o = (k * nd + j) * 3;
    const p: V3 = [pos[o], pos[o + 1], pos[o + 2]];
    const n: V3 = [nrm[o], nrm[o + 1], nrm[o + 2]];
    const u = planar ? (p[0] - x0) / 4 : (off.d[j] + road.half) / (2 * road.half);
    const v = planar ? (p[2] - z0) / 4 : st[lo + k] / SURFACE_REPEAT;
    const i = mb.vertex(material, p, n, u, v, material === "snow" ? bankTint(edge[k * nd + j], st[lo + k], j < off.first ? -1 : 1) : WHITE);
    seen.set(key, i);
    return i;
  };
  for (let k = 0; k + 1 < count; k++) {
    if (!near[lo + k] && !near[lo + k + 1]) continue;
    for (let j = 0; j + 1 < nd; j++) {
      const a = at(k, j);
      const b = at(k, j + 1);
      const c = at(k + 1, j + 1);
      const d = at(k + 1, j);
      const cx = (a[0] + b[0] + c[0] + d[0]) / 4;
      const cz = (a[2] + b[2] + c[2] + d[2]) / 4;
      if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
      const own = j >= off.first && j < off.last;
      if (!own && (bridge[k] || bridge[k + 1])) continue;
      if (!road.main) {
        // Inside the driven road's strip that strip draws the ground.
        let covered = true;
        for (const p of [a, b, c, d]) {
          world.probe(p[0], p[2], probe);
          if (!(probe.zoneRoad && probe.zoneRoad.main)) {
            covered = false;
            break;
          }
        }
        if (covered) continue;
      }
      let material: string = surface;
      let planar = false;
      if (!own) {
        const e = (edge[k * nd + j] + edge[k * nd + j + 1] + edge[(k + 1) * nd + j] + edge[(k + 1) * nd + j + 1]) / 4;
        material = e < 0 ? "lane" : "snow";
        planar = true;
      } else if (surface === "lane") planar = true;
      const i0 = vert(material, k, j, planar);
      const i1 = vert(material, k, j + 1, planar);
      const i2 = vert(material, k + 1, j + 1, planar);
      const i3 = vert(material, k + 1, j, planar);
      // Stations run forward and offsets left to right: a, b, c, d is counter-clockwise from above.
      mb.tri(material, i0, i1, i2);
      mb.tri(material, i0, i2, i3);
    }
  }
}

/** Every road's strip in a cell. */
export function strips(world: RouteWorld, x0: number, z0: number, x1: number, z1: number, mb: MeshBuilder): void {
  for (const road of world.roadsIn(x0, z0, x1, z1)) roadStrip(world, road, x0, z0, x1, z1, mb);
}
