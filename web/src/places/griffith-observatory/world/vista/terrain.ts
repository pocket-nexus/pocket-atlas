import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from "three";
import { demSpacing, groundY } from "../dem";
import { curvatureDrop } from "../layout";
import { metresPerPixel } from "./eyes";
import { makeTolerance, type Tolerance } from "./tolerance";
import { HIDDEN } from "./viewshed";

/**
 * Terrain outside `SITE`, from the 1 m / 5 m / 50 m / 200 m DEM (`dem.ts`):
 * a quadtree of tiles, each a 33 × 33 grid simplified as a right-triangulated
 * irregular network (RTIN, as mapbox/martini) to a height error of
 * `ERR_SKY` / `ERR_GROUND` pixels from the nearest eye (`tolerance.ts`: by what the viewshed says the eyes see there), with the grid spacing
 * itself limited to `SAMPLE_PX` pixels and to the DEM's own spacing. Tiles
 * meet without cracks (each takes its neighbours' border vertices); the
 * hole at `SITE` (area A's ground) has a skirt facing into the site.
 */

/** The A/B boundary: area A owns the ground inside, B everything outside (place metres). */
export const SITE = { x0: -220, x1: 220, z0: -320, z1: 160 };

export function inSite(x: number, z: number): boolean {
  return x > SITE.x0 && x < SITE.x1 && z > SITE.z0 && z < SITE.z1;
}

/** Grid spacing limit in pixels from the nearest eye. */
const SAMPLE_PX = 3;
/** Cells per tile side (2^k). */
const N = 32;
const G = N + 1;
/** Root tile: 2^17 m, its corner placed so that every SITE edge lies on the grid of tiles with spacing ≤ 8 m. */
const ROOT = { x0: SITE.x0 - 65536, z0: SITE.z0 - 65536, size: 131072 };
/** The far DEM's extent in place metres (no data beyond). */
const DATA = { x0: -64200, x1: 69100, z0: -59200, z1: 63300 };

let tolerance: Tolerance | null = null;

/** The viewshed and mesh tolerance over the DEM (built once). */
export function vistaTolerance(): Tolerance {
  return (tolerance ??= makeTolerance(groundY));
}

// RTIN triangle table for a G × G grid (mapbox/martini): coords[i] = a, b of triangle i.
const NUM_TRI = N * N * 2 - 2;
const NUM_PARENT = NUM_TRI - N * N;
const COORDS = new Uint16Array(NUM_TRI * 4);
for (let i = 0; i < NUM_TRI; i++) {
  let id = i + 2;
  let ax = 0;
  let ay = 0;
  let bx = 0;
  let by = 0;
  let cx = 0;
  let cy = 0;
  if (id & 1) bx = by = cx = N;
  else ax = ay = cy = N;
  while ((id >>= 1) > 1) {
    const mx = (ax + bx) >> 1;
    const my = (ay + by) >> 1;
    if (id & 1) {
      bx = ax;
      by = ay;
      ax = cx;
      ay = cy;
    } else {
      ax = bx;
      ay = by;
      bx = cx;
      by = cy;
    }
    cx = mx;
    cy = my;
  }
  COORDS[i * 4] = ax;
  COORDS[i * 4 + 1] = ay;
  COORDS[i * 4 + 2] = bx;
  COORDS[i * 4 + 3] = by;
}

interface Tile {
  x0: number;
  z0: number;
  size: number;
}

/** Leaf tiles: subdivide while a tile's spacing is coarser than its pixel limit and the DEM allows. */
function leaves(): Tile[] {
  const out: Tile[] = [];
  const stack: Tile[] = [{ ...ROOT }];
  while (stack.length) {
    const t = stack.pop()!;
    const x1 = t.x0 + t.size;
    const z1 = t.z0 + t.size;
    if (x1 <= DATA.x0 || t.x0 >= DATA.x1 || z1 <= DATA.z0 || t.z0 >= DATA.z1) continue;
    if (t.x0 >= SITE.x0 && x1 <= SITE.x1 && t.z0 >= SITE.z0 && z1 <= SITE.z1) continue;
    const s = t.size / N;
    const cx = t.x0 + t.size / 2;
    const cz = t.z0 + t.size / 2;
    const touchesSite = x1 > SITE.x0 && t.x0 < SITE.x1 && z1 > SITE.z0 && t.z0 < SITE.z1;
    const want = SAMPLE_PX * metresPerPixel(cx, cz, t.size * 0.71).m;
    const floor = s <= 64 ? demSpacing(cx, cz) : 0;
    const split = (touchesSite && s > 8) || (s > want && s > floor * 1.5);
    if (!split) {
      out.push(t);
      continue;
    }
    const h = t.size / 2;
    stack.push({ x0: t.x0, z0: t.z0, size: h }, { x0: t.x0 + h, z0: t.z0, size: h }, { x0: t.x0, z0: t.z0 + h, size: h }, { x0: t.x0 + h, z0: t.z0 + h, size: h });
  }
  return out;
}

/** Vertex colour of bare ground at blue hour (linear albedo): sea, basin floor, chaparral slopes. */
function groundColor(x: number, y: number, z: number, slope: number, out: number[]): void {
  const asl = y + 346 + curvatureDrop(Math.hypot(x, z));
  if (asl < 0.5 && slope < 0.02) {
    out.push(0.01, 0.014, 0.02);
    return;
  }
  const hill = Math.min(1, Math.max(0, (slope - 0.08) / 0.25));
  out.push(0.055 + (0.04 - 0.055) * hill, 0.052 + (0.045 - 0.052) * hill, 0.048 + (0.03 - 0.048) * hill);
}

export interface TerrainStats {
  viewshedMs: number;
  /** Tiles no eye sees (dropped). */
  hidden: number;
  tiles: number;
  triangles: number;
  skirts: number;
  /** Triangles by distance from the origin: < 0.5, 1, 2, 5, 10, 20 km, beyond. */
  bands: number[];
}

interface Built {
  t: Tile;
  s: number;
  /** Heights with a one-cell border, (G + 2)². */
  H: Float32Array;
  /** Triangles in grid coordinates, counter-clockwise from above: i0, j0, i1, j1, i2, j2. */
  tris: number[];
}

/** Sorted coordinates of the tile-border vertices in use along each grid line ("x:<x>" holds z values, "z:<z>" x values). */
class BorderLines {
  private lines = new Map<string, number[]>();
  private sorted = false;
  add(key: string, v: number): void {
    let l = this.lines.get(key);
    if (!l) this.lines.set(key, (l = []));
    l.push(v);
    this.sorted = false;
  }
  /** Values strictly between a and b on a line, ordered from a to b. */
  between(key: string, a: number, b: number): number[] {
    if (!this.sorted) {
      for (const [k, l] of this.lines) this.lines.set(k, [...new Set(l)].sort((p, q) => p - q));
      this.sorted = true;
    }
    const l = this.lines.get(key);
    if (!l) return [];
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    let i = 0;
    let j = l.length;
    while (i < j) {
      const m = (i + j) >> 1;
      if (l[m] <= lo) i = m + 1;
      else j = m;
    }
    const out: number[] = [];
    for (; i < l.length && l[i] < hi; i++) out.push(l[i]);
    return a < b ? out : out.reverse();
  }
}

/**
 * Builds the terrain geometry (positions, normals, colours) outside SITE.
 * Tiles are stitched without cracks: every triangle edge on a tile border
 * takes the border vertices its neighbours use there (fanned from the
 * opposite corner, heights from the same DEM samples), so neighbouring tiles
 * share their border vertices exactly. Only the hole at SITE has a skirt.
 */
export function buildTerrainGeometry(): { geometry: BufferGeometry; stats: TerrainStats } {
  const t0 = performance.now();
  const { shed, at: terrainTolerance } = vistaTolerance();
  const stats: TerrainStats = { viewshedMs: Math.round(performance.now() - t0), hidden: 0, tiles: 0, triangles: 0, skirts: 0, bands: [0, 0, 0, 0, 0, 0, 0] };
  const err = new Float32Array(G * G);
  const tol = new Float32Array(G * G);
  const built: Built[] = [];
  const lines = new BorderLines();

  // Pass 1: heights, tolerances and the RTIN of every tile.
  for (const t of leaves()) {
    stats.tiles++;
    const s = t.size / N;
    const H = new Float32Array((G + 2) * (G + 2));
    for (let j = -1; j <= G; j++) for (let i = -1; i <= G; i++) H[(j + 1) * (G + 2) + i + 1] = groundY(t.x0 + i * s, t.z0 + j * s);
    const h = (i: number, j: number) => H[(j + 1) * (G + 2) + i + 1];
    let seen = 0;
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const x = t.x0 + i * s;
        const z = t.z0 + j * s;
        tol[j * G + i] = terrainTolerance(x, h(i, j), z);
        if (shed.sight(x, h(i, j) + 2, z, 0.002) !== HIDDEN) seen++;
        // Vertices on SITE's edges stay, so no triangle crosses into the site.
        const onX = (x === SITE.x0 || x === SITE.x1) && z >= SITE.z0 && z <= SITE.z1;
        const onZ = (z === SITE.z0 || z === SITE.z1) && x >= SITE.x0 && x <= SITE.x1;
        err[j * G + i] = onX || onZ ? 1e9 : 0;
      }
    if (!seen) {
      stats.hidden++;
      continue;
    }
    // RTIN errors, normalised by the tolerance at each midpoint, propagated to the parents.
    for (let i = NUM_TRI - 1; i >= 0; i--) {
      const k = i * 4;
      const ax = COORDS[k];
      const ay = COORDS[k + 1];
      const bx = COORDS[k + 2];
      const by = COORDS[k + 3];
      const mx = (ax + bx) >> 1;
      const my = (ay + by) >> 1;
      const cx = mx + my - ay;
      const cy = my + ax - mx;
      const mid = my * G + mx;
      const e = Math.abs((h(ax, ay) + h(bx, by)) / 2 - h(mx, my)) / tol[mid];
      err[mid] = Math.max(err[mid], e);
      if (i < NUM_PARENT) {
        const l = ((ay + cy) >> 1) * G + ((ax + cx) >> 1);
        const r = ((by + cy) >> 1) * G + ((bx + cx) >> 1);
        err[mid] = Math.max(err[mid], err[l], err[r]);
      }
    }
    const tris: number[] = [];
    const emit = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
      if (inSite(t.x0 + ((ax + bx + cx) / 3) * s, t.z0 + ((ay + by + cy) / 3) * s)) return;
      // Counter-clockwise seen from above (screen x = x, screen up = −z): negative cross product in (i, j).
      if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) tris.push(ax, ay, bx, by, cx, cy);
      else tris.push(ax, ay, cx, cy, bx, by);
      for (const [i, j] of [
        [ax, ay],
        [bx, by],
        [cx, cy],
      ]) {
        if (i === 0 || i === N) lines.add(`x:${t.x0 + i * s}`, t.z0 + j * s);
        if (j === 0 || j === N) lines.add(`z:${t.z0 + j * s}`, t.x0 + i * s);
      }
    };
    const recurse = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void => {
      const mx = (ax + bx) >> 1;
      const my = (ay + by) >> 1;
      if (Math.abs(ax - cx) + Math.abs(ay - cy) > 1 && err[my * G + mx] > 1) {
        recurse(cx, cy, ax, ay, mx, my);
        recurse(bx, by, cx, cy, mx, my);
      } else emit(ax, ay, bx, by, cx, cy);
    };
    recurse(0, 0, N, N, N, 0);
    recurse(N, N, 0, 0, 0, N);
    built.push({ t, s, H, tris });
  }

  // Pass 2: vertices, stitched triangles and the SITE skirt.
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c3: number[] = [];
  for (const { t, s, H, tris } of built) {
    const ids = new Map<string, number>();
    const h = (i: number, j: number) => H[(j + 1) * (G + 2) + i + 1];
    const vertex = (x: number, z: number): number => {
      const key = `${x},${z}`;
      const known = ids.get(key);
      if (known !== undefined) return known;
      const i = (x - t.x0) / s;
      const j = (z - t.z0) / s;
      const onGrid = Number.isInteger(i) && Number.isInteger(j);
      let y: number;
      let nx: number;
      let nz: number;
      if (onGrid) {
        y = h(i, j);
        nx = h(i - 1, j) - h(i + 1, j);
        nz = h(i, j - 1) - h(i, j + 1);
      } else {
        y = groundY(x, z);
        nx = groundY(x - s, z) - groundY(x + s, z);
        nz = groundY(x, z - s) - groundY(x, z + s);
      }
      const ny = 2 * s;
      const l = Math.hypot(nx, ny, nz);
      const v = pos.length / 3;
      pos.push(x, y, z);
      nor.push(nx / l, ny / l, nz / l);
      c3.length = 0;
      groundColor(x, y, z, Math.hypot(nx, nz) / (2 * s), c3);
      col.push(c3[0], c3[1], c3[2]);
      ids.set(key, v);
      return v;
    };
    const xMin = t.x0;
    const xMax = t.x0 + t.size;
    const zMin = t.z0;
    const zMax = t.z0 + t.size;
    // Emits (a, b, c) counter-clockwise, fanning any neighbour's border vertices on its edges.
    const tri = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, depth = 0): void => {
      const P = [ax, az, bx, bz, cx, cz];
      for (let e = 0; e < 3 && depth < 64; e++) {
        const px = P[e * 2];
        const pz = P[e * 2 + 1];
        const qx = P[((e + 1) % 3) * 2];
        const qz = P[((e + 1) % 3) * 2 + 1];
        const rx = P[((e + 2) % 3) * 2];
        const rz = P[((e + 2) % 3) * 2 + 1];
        let mid: number[] = [];
        if (px === qx && (px === xMin || px === xMax)) mid = lines.between(`x:${px}`, pz, qz).map((z) => [px, z]).flat();
        else if (pz === qz && (pz === zMin || pz === zMax)) mid = lines.between(`z:${pz}`, px, qx).map((x) => [x, pz]).flat();
        if (mid.length) {
          tri(px, pz, mid[0], mid[1], rx, rz, depth + 1);
          tri(mid[0], mid[1], qx, qz, rx, rz, depth + 1);
          return;
        }
      }
      idx.push(vertex(ax, az), vertex(bx, bz), vertex(cx, cz));
      stats.triangles++;
      const dk = Math.hypot((ax + bx + cx) / 3, (az + bz + cz) / 3) / 1000;
      stats.bands[dk < 0.5 ? 0 : dk < 1 ? 1 : dk < 2 ? 2 : dk < 5 ? 3 : dk < 10 ? 4 : dk < 20 ? 5 : 6]++;
      // Edges on SITE's border: a skirt hanging into the site (p → q runs with the winding: the outside is to its right).
      for (let e = 0; e < 3; e++) {
        const px = P[e * 2];
        const pz = P[e * 2 + 1];
        const qx = P[((e + 1) % 3) * 2];
        const qz = P[((e + 1) % 3) * 2 + 1];
        const site = (px === qx && (px === SITE.x0 || px === SITE.x1) && inSite(px + (px === SITE.x0 ? 0.5 : -0.5), (pz + qz) / 2)) || (pz === qz && (pz === SITE.z0 || pz === SITE.z1) && inSite((px + qx) / 2, pz + (pz === SITE.z0 ? 0.5 : -0.5)));
        if (!site) continue;
        const a = vertex(px, pz);
        const b = vertex(qx, qz);
        const a2 = pos.length / 3;
        for (const v of [a, b]) {
          pos.push(pos[v * 3], pos[v * 3 + 1] - 6, pos[v * 3 + 2]);
          nor.push(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]);
          col.push(col[v * 3], col[v * 3 + 1], col[v * 3 + 2]);
        }
        idx.push(a, a2, b, b, a2, a2 + 1);
        stats.skirts += 2;
      }
    };
    for (let k = 0; k < tris.length; k += 6) tri(t.x0 + tris[k] * s, t.z0 + tris[k + 1] * s, t.x0 + tris[k + 2] * s, t.z0 + tris[k + 3] * s, t.x0 + tris[k + 4] * s, t.z0 + tris[k + 5] * s);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(col, 3));
  geometry.setIndex(new Uint32BufferAttribute(idx, 1));
  geometry.computeBoundingSphere();
  return { geometry, stats };
}
