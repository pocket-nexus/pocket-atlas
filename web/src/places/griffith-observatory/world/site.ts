import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from "three";
import { fbm } from "../../../core/random";
import type { ObsLib } from "../gfx/observatory-materials";
import type { GriffithWorld } from "./context";
import { groundY } from "./dem";
import { groundNormal, inside } from "./observatory/drape";
import type { P2 } from "./observatory/kit";
import { COVER } from "./observatory/cover";
import { Kits } from "./observatory/kit";
import { DOMES, DRUM, GROUND, deckOutline } from "./observatory/plan";
import { oak, pine, rosette, shrub, tree } from "./observatory/props";
import { Rng } from "../../../core/random";
import { TRAILS } from "./observatory/survey";
import { SITE } from "./vista/terrain";

/**
 * The ground inside `SITE` (area A): the hillside round the observatory from
 * the 1 m DEM (`dem.ts`), as one tensor-product grid — 2 m round the
 * building and the slope under the drum, 4 m in a ring, 8 m out to the
 * `SITE` edge on the same lattice as the vista terrain's border tiles — so
 * it has no T-junctions and meets B's skirt. Cells wholly under the
 * building or a paved / planted surface (grounds.ts) are left out. Vertex
 * colours carry the late-summer hillside: dry grass and decomposed granite,
 * bare fire roads and trails (OSM), darker litter where the chaparral is
 * dense.
 */

/** RTIN grid: 2 m spacing over 512 m from the SITE's south-west corner (257² points). */
const STEP = 2;
const N = 256;
const G = N + 1;
/** SITE edges in grid indices (x 220 → 220, z 160 → 240). */
const IX1 = (SITE.x1 - SITE.x0) / STEP;
const IZ1 = (SITE.z1 - SITE.z0) / STEP;

/** Where the ground is looked at closely: the building, the lawn shot, the drum lookout (m). */
const FOCI: P2[] = [
  [0, -15],
  [0, -60],
  [0, -130],
  [-150, 40],
];

/** Allowed vertical error (m) at a grid point: 4 cm near the foci, growing to 1.2 m. */
function tolerance(x: number, z: number): number {
  let d = Infinity;
  for (const [fx, fz] of FOCI) d = Math.min(d, Math.hypot(x - fx, z - fz));
  return Math.min(1.2, 0.04 + 0.006 * Math.max(0, d - 25));
}

/** Distance from (x, z) to the nearest trail centreline (m), capped. */
function trailDistance(x: number, z: number, cap = 8): number {
  let best = cap;
  for (const line of Object.values(TRAILS)) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [ax, az] = line[i];
      const [bx, bz] = line[i + 1];
      if (Math.min(ax, bx) - cap > x || Math.max(ax, bx) + cap < x || Math.min(az, bz) - cap > z || Math.max(az, bz) + cap < z) continue;
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
  }
  return best;
}

/** Polygons that cover the ground (the building and every paved or planted surface laid on it). */
export function covers(): P2[][] {
  const circle = (cx: number, cz: number, r: number): P2[] => Array.from({ length: 32 }, (_, i) => [cx + Math.cos((i / 32) * Math.PI * 2) * r, cz + Math.sin((i / 32) * Math.PI * 2) * r] as P2);
  return [
    deckOutline(),
    circle(DRUM.x, DRUM.z, DRUM.r - 0.3),
    circle(DOMES.west.x, DOMES.west.z, DOMES.drumR - 0.2),
    circle(DOMES.east.x, DOMES.east.z, DOMES.drumR - 0.2),
    GROUND.precinct,
    GROUND.drive,
    GROUND.parking,
    GROUND.eastTerrace,
  ];
}

/**
 * Right-triangulated irregular network over the 2 m grid (mapbox/martini):
 * a vertex is kept when the ground departs from the coarser triangle by more
 * than the local tolerance; the need to split propagates to the parents, so
 * the mesh has no cracks. Triangles that straddle the SITE edge split down
 * to 8 m cells, which end exactly on it.
 */
function rtin(H: Float32Array): number[] {
  const numTri = N * N * 2 - 2;
  const numParent = numTri - N * N;
  const need = new Float32Array(G * G);
  for (let i = numTri - 1; i >= 0; i--) {
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
    const mx = (ax + bx) >> 1;
    const my = (ay + by) >> 1;
    const m = my * G + mx;
    const err = Math.abs((H[ay * G + ax] + H[by * G + bx]) / 2 - H[m]) - tolerance(SITE.x0 + mx * STEP, SITE.z0 + my * STEP);
    let v = err;
    const lo = Math.min(ax, bx, cx);
    const hi = Math.max(ax, bx, cx);
    const loz = Math.min(ay, by, cy);
    const hiz = Math.max(ay, by, cy);
    const straddles = (lo < IX1 && hi > IX1) || (loz < IZ1 && hiz > IZ1);
    if (straddles && Math.abs(ax - cx) + Math.abs(ay - cy) > 4) v = Math.max(v, 1);
    if (i < numParent) {
      const lc = ((ay + cy) >> 1) * G + ((ax + cx) >> 1);
      const rc = ((by + cy) >> 1) * G + ((bx + cx) >> 1);
      v = Math.max(v, need[lc], need[rc]);
    }
    need[m] = Math.max(need[m], v);
  }
  const tris: number[] = [];
  const walk = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void => {
    const mx = (ax + bx) >> 1;
    const my = (ay + by) >> 1;
    if (Math.abs(ax - cx) + Math.abs(ay - cy) > 1 && need[my * G + mx] > 0) {
      walk(cx, cy, ax, ay, mx, my);
      walk(bx, by, cx, cy, mx, my);
    } else tris.push(ay * G + ax, by * G + bx, cy * G + cx);
  };
  walk(0, 0, N, N, N, 0);
  walk(N, N, 0, 0, 0, N);
  return tris;
}

export function buildSite(w: GriffithWorld, lib: ObsLib): void {
  const H = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) H[j * G + i] = groundY(SITE.x0 + i * STEP, SITE.z0 + j * STEP);
  const all = rtin(H);
  const cov = covers();
  const covered = (x: number, z: number) => cov.some((p) => inside(p, x, z));
  const used = new Int32Array(G * G).fill(-1);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const vert = (g: number): number => {
    if (used[g] >= 0) return used[g];
    const x = SITE.x0 + (g % G) * STEP;
    const z = SITE.z0 + Math.floor(g / G) * STEP;
    used[g] = pos.length / 3;
    // Under paving and the building the ground sinks out of sight, so a draped surface's
    // straight 4 m cells never let a finer terrain triangle poke through them.
    pos.push(x, covered(x, z) ? H[g] - 0.4 : H[g], z);
    nor.push(...groundNormal(x, z, 1));
    uv.push(x, -z);
    // Hillside tint from the ortho's cover (bare decomposed granite and dry grass pale and
    // warm, dense chaparral and canopy ground darker with litter), trails bare and pale.
    // p01 reads the slope under the drum at about (14, 12, 11): warm, a little above black.
    const n = fbm(x * 0.045, z * 0.045, 4, 7);
    const t = trailDistance(x, z);
    const trail = Math.max(0, 1 - Math.max(0, t - 1.2) / 1.8);
    const cls = coverAt(x, z);
    const base = [1.85, 1.6, 1.45, 1.25, 1.1][cls] * (0.85 + 0.3 * n);
    const c = [base, base * (0.95 + 0.05 * n), base * (0.86 + 0.05 * n)];
    const pale = [2.0, 1.8, 1.5];
    col.push(...c.map((v, m) => v + (pale[m] - v) * trail));
    return used[g];
  };
  for (let k = 0; k < all.length; k += 3) {
    const g = [all[k], all[k + 1], all[k + 2]];
    const xs = g.map((v) => SITE.x0 + (v % G) * STEP);
    const zs = g.map((v) => SITE.z0 + Math.floor(v / G) * STEP);
    const mx = (xs[0] + xs[1] + xs[2]) / 3;
    const mz = (zs[0] + zs[1] + zs[2]) / 3;
    if (mx > SITE.x1 || mz > SITE.z1) continue;
    if (covered(mx, mz) && covered(xs[0], zs[0]) && covered(xs[1], zs[1]) && covered(xs[2], zs[2])) continue;
    // Counter-clockwise seen from above (normals up).
    const [a, b, c] = g.map(vert);
    const cross = (xs[1] - xs[0]) * (zs[2] - zs[0]) - (zs[1] - zs[0]) * (xs[2] - xs[0]);
    if (cross < 0) idx.push(a, b, c);
    else idx.push(a, c, b);
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  geo.setAttribute("color", new Float32BufferAttribute(col, 3));
  geo.setIndex(new Uint32BufferAttribute(new Uint32Array(idx), 1));
  geo.computeBoundingSphere();
  const m = w.mesh(geo, lib.hillside(), 0, 0, 0, w.root, { cast: false });
  m.name = "site-ground";
  console.info(`[griffith] site ground: RTIN ${idx.length / 3} triangles, ${pos.length / 3} vertices`);
}

/** Cover class at (x, z): the ortho-derived map, open chaparral outside it. */
function coverAt(x: number, z: number): number {
  const i = Math.floor((x - COVER.x0) / COVER.step);
  const j = Math.floor((z - COVER.z0) / COVER.step);
  if (i < 0 || j < 0 || i >= COVER.nx || j >= COVER.nz) return 2;
  return COVER.rows[j].charCodeAt(i) - 48;
}

/**
 * The hillside planting inside SITE, placed from the ortho's cover classes
 * (`cover.ts`): coast live oaks and a few pines where the canopy is dark,
 * chaparral clumps (laurel sumac, toyon, scrub oak, sage) by density, dry
 * grass tufts on the open ground, yucca on the steep banks; nothing on the
 * trails, the paving or the building. Density thins with distance from the
 * building so the planting stays within its triangle budget.
 */
export function buildPlanting(w: GriffithWorld, lib: ObsLib): number {
  const K = new Kits();
  const leaf = K.of(lib.foliage());
  const r = new Rng(1935);
  const cov = covers();
  const covered = (x: number, z: number) => cov.some((p) => inside(p, x, z));
  /** Distance to the building (its deck outline, the drum and the domes, roughly). */
  const near = (x: number, z: number) => Math.min(Math.hypot(x - DRUM.x, z - DRUM.z) - DRUM.r, Math.max(Math.abs(x) - 32, Math.abs(z + 28) - 8));
  const step = COVER.step;
  let detailed = 0;
  for (let z = SITE.z0 + step / 2; z < SITE.z1; z += step)
    for (let x = SITE.x0 + step / 2; x < SITE.x1; x += step) {
      const d = Math.hypot(x, z + 30);
      const c = coverAt(x, z);
      const px = x + r.range(-step / 2, step / 2);
      const pz = z + r.range(-step / 2, step / 2);
      if (covered(px, pz) || trailDistance(px, pz, 4) < 2.2) continue;
      const y = groundY(px, pz);
      const gap = near(px, pz);
      const pick = r.next();
      // Trees where the canopy is dark (thinner far out), kept off the building's flanks (p01: shrubs up to the drum's foot).
      const treeP = c === 4 ? (d < 150 ? 0.32 : 0.18) : c === 3 ? 0.04 : 0;
      const h = r.range(6, 10) * Math.min(1, 0.5 + gap / 70);
      if (pick < treeP && gap > 14 && !blocksLookout(px, pz, y + h, h * 0.6)) {
        const isOak = r.chance(0.8);
        // Leaf-card clusters where a shot is near (the drum lookout path, the lawn, the building); card crowns beyond.
        if (nearShot(px, pz)) {
          if (isOak) oak(K, lib, px, pz, h, r);
          else pine(K, lib, px, pz, h * 1.2, r);
          detailed++;
        } else tree(K, lib, px, pz, h, isOak ? "oak" : "pine", r);
        continue;
      }
      // The slope between the Drum lookout and the building (p01): dense chaparral and scrub-oak masses.
      const lookout = px < -12 && px > -112 && pz > -5 && pz < 58;
      const shrubP = lookout ? (c <= 1 ? 0.55 : 0.95) : (c === 4 ? 0.55 : c === 3 ? 0.8 : c === 2 ? 0.6 : 0.15) * (d < 110 ? 1 : d < 180 ? 0.55 : 0.3);
      const s = r.range(1.8, 3.4) * (c === 2 ? 0.8 : 1) * (lookout ? 1.3 : 1);
      // On the lookout slope the masses may hide the drum's foot (p01) but not its lit body.
      if (lookout && blocksLookout(px, pz, y + s * 0.7, s * 0.4, SHRUB_SIGHTS, 6)) {
        // Low sage and dry grass where a full shrub would stand in the sightline.
        for (let k = 0; k < 3; k++) {
          const qx = px + r.range(-2.5, 2.5);
          const qz = pz + r.range(-2.5, 2.5);
          const qy = groundY(qx, qz);
          const q = r.range(0.7, 1.2);
          if (Math.hypot(qx - LOOKOUT[0], qz - LOOKOUT[1]) > 3 && !blocksLookout(qx, qz, qy + q * 0.55, 0.3, SHRUB_SIGHTS, 3)) shrub(leaf, r.chance(0.5) ? "sage" : "grass", qx, qy, qz, q * 1.4, q * 0.6, r, [r.range(0.8, 1.0), r.range(0.8, 0.95), r.range(0.65, 0.75)]);
        }
        continue;
      }
      if (r.chance(shrubP)) {
        shrub(leaf, r.pick(["shrub", "shrub2", "shrub2", "sage"] as const), px, y, pz, s, s * r.range(0.55, 0.8), r, [r.range(0.8, 1.0), r.range(0.82, 0.98), r.range(0.66, 0.78)]);
      } else if (c <= 1 && d < 120 && r.chance(0.4)) shrub(leaf, "grass", px, y, pz, r.range(0.9, 1.5), r.range(0.4, 0.7), r, [0.95, 0.9, 0.8]);
      else if (d < 90 && r.chance(0.04)) rosette(leaf, "yucca", px, y, pz, r.range(0.8, 1.2), r);
    }
  footPlanting(K, lib, r);
  const tris = K.emit(w);
  console.info(`[griffith] site planting: ${tris} triangles, ${detailed} near trees as leaf clusters`);
  return tris;
}

/**
 * The Drum lookout's view (p01): the camera on the hillside path and the
 * sightlines from it to the drum and to the west dome. A tree whose crown
 * would rise into either sightline is left out, as the lookout's clearing is.
 */
const LOOKOUT: [number, number] = [-101.5, 41];
const SIGHTS: [number, number, number][] = [
  [DRUM.x, 5.5, DRUM.z],
  [-29.2, 12, -28.9],
];
function blocksLookout(x: number, z: number, top: number, radius: number, sights = SIGHTS, near = 12): boolean {
  const [cx, cz] = LOOKOUT;
  const ey = groundY(cx, cz) + 1.6;
  if (Math.hypot(x - cx, z - cz) < near) return true;
  for (const [tx, ty, tz] of sights) {
    const dx = tx - cx;
    const dz = tz - cz;
    const l2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - cx) * dx + (z - cz) * dz) / l2));
    const lateral = Math.hypot(x - cx - dx * t, z - cz - dz * t);
    if (lateral < radius + 1.5 && t > 0 && t < 1 && top > ey + (ty - ey) * t - 1) return true;
  }
  return false;
}

/** Shrub sightlines from the lookout: the drum just above the promenade's foot, the west dome's drum. */
const SHRUB_SIGHTS: [number, number, number][] = [
  [DRUM.x, -1.5, DRUM.z],
  [-29.2, 6, -28.9],
];

/** Within reach of a close shot: the drum lookout path (Drum), the lawn (Lawn), the building and its terraces. */
function nearShot(x: number, z: number): boolean {
  return Math.hypot(x + 101, z - 41) < 80 || Math.hypot(x + 12, z + 88) < 70 || Math.hypot(x - DRUM.x, z + 10) < 70;
}

/**
 * The slope at the drum's south-west foot (p01): chaparral and a few small
 * oaks right up to the lower drum, so the crest under it is a planted
 * silhouette with the uplit pilaster feet just above it.
 */
function footPlanting(K: Kits, lib: ObsLib, r: Rng): void {
  const leaf = K.of(lib.foliage());
  const cov = covers();
  for (let i = 0; i < 70; i++) {
    const t = r.range(Math.PI * 0.3, Math.PI * 0.98);
    const d = r.range(DRUM.r + 2.5, DRUM.r + 13);
    const x = DRUM.x + Math.cos(t) * d;
    const z = DRUM.z + Math.sin(t) * d;
    if (cov.some((p) => inside(p, x, z)) || trailDistance(x, z, 4) < 1.8) continue;
    const y = groundY(x, z);
    if (i % 9 === 0 && d > DRUM.r + 7) oak(K, lib, x, z, r.range(4.5, 6.5), r);
    else {
      const s = r.range(1.8, 3.2);
      shrub(leaf, r.pick(["shrub", "shrub2", "oak", "sage"] as const), x, y, z, s, s * r.range(0.6, 0.85), r, [r.range(0.75, 0.95), r.range(0.78, 0.94), r.range(0.62, 0.74)]);
    }
  }
}
