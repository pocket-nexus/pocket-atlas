import { BASE, FAR, MID, type Cells, type Layer } from "../layers";
import type { MeshBuilder, V3 } from "../mesh";
import { clamp, fbm2, smoothstep } from "../noise";
import type { Feature } from "../source";
import type { Probe, RouteWorld } from "../world";

/**
 * The ground of one cell: a regular grid of the layer's step over the
 * graded terrain. Where the next coarser layer takes over at an edge the
 * edge's vertices lie on that layer's lattice, so the two meet without a
 * crack; under the next finer layer's cells the grid sinks, so it is hidden
 * while they are loaded and stands in for them when they are not; inside a
 * road's strip it sinks under the strip.
 */

/** Snow as the land under it colours it from a distance (sRGB tint of the snow material). */
const TINT = {
  open: [255, 255, 255],
  /** Bare larch and birch over snow, seen from across a valley. */
  wood: [112, 116, 124],
  /** Conifer plantations. */
  conifer: [70, 82, 84],
  /** Under the trees the corridor draws as trees. */
  woodFloor: [214, 219, 228],
  scrub: [206, 208, 210],
  town: [226, 228, 232],
  water: [168, 186, 204],
} as const;

const WOODS = new Set(["wood", "forest", "scrub"]);

function inRing(pts: Float64Array, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const zi = pts[i + 1];
    const zj = pts[j + 1];
    if (zi > z !== zj > z && x < ((pts[j] - pts[i]) * (z - zi)) / (zj - zi) + pts[i]) inside = !inside;
  }
  return inside;
}

export function inArea(f: Feature, x: number, z: number): boolean {
  if (x < f.box[0] || x > f.box[2] || z < f.box[1] || z > f.box[3] || !inRing(f.pts, x, z)) return false;
  for (const h of f.holes) if (inRing(h, x, z)) return false;
  return true;
}

/** What covers the ground at a point: surveyed land cover in the corridor, slope and height beyond it. */
export class Cover {
  private land: Feature[];
  private water: Feature[];
  constructor(
    private world: RouteWorld,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
  ) {
    this.land = world.source.query("land", x0, z0, x1, z1);
    this.water = world.source.query("water", x0, z0, x1, z1);
  }

  /** "water", a land-use or natural type, or "" in open country. */
  at(x: number, z: number): string {
    for (const f of this.water) if (inArea(f, x, z)) return "water";
    let found = "";
    for (const f of this.land) {
      if (!inArea(f, x, z)) continue;
      if (WOODS.has(f.type)) return f.tags.leaf_type === "needleleaved" ? "conifer" : f.type;
      found = f.type;
    }
    return found;
  }

  /** Whether the point is in the corridor the survey covers in full (the fine elevation grid's reach). */
  surveyed(x: number, z: number): boolean {
    return !Number.isNaN(this.world.source.near.at(x, z));
  }
}

export function terrain(world: RouteWorld, cells: Cells, layer: Layer, ix: number, iz: number, mb: MeshBuilder): void {
  if (!layer.step) return;
  const S = layer.size;
  const st = layer.step;
  const n = S / st;
  const x0 = ix * S;
  const z0 = iz * S;
  const finer = layer === MID ? BASE : layer === FAR ? MID : null;
  const coarser = layer === BASE ? MID : layer === MID ? FAR : null;
  const probe: Probe = { e: 0, road: null, s: 0, d: 0, w: 0, y: 0, zone: 0, zoneRoad: null, zoneS: 0, zoneD: 0 };
  // The surface each layer follows, before any sinking.
  const ground = (x: number, z: number): number => (layer === FAR ? world.elevation(x, z) : world.base(x, z));
  const coarseGround = (x: number, z: number): number => (coarser === FAR ? world.elevation(x, z) : world.base(x, z));
  const height = (x: number, z: number): number => {
    if (layer === FAR) return world.elevation(x, z);
    world.probe(x, z, probe);
    let h = world.base(x, z, probe);
    // Under a road's strip mesh.
    if (layer === BASE && probe.zone > 0) h -= 0.7 * smoothstep(0, 2.5, probe.zone);
    return h;
  };
  const cover = new Cover(world, x0 - st, z0 - st, x0 + S + st, z0 + S + st);
  const edgeOpen = [!cells.has(layer, ix - 1, iz), !cells.has(layer, ix + 1, iz), !cells.has(layer, ix, iz - 1), !cells.has(layer, ix, iz + 1)];
  const uvScale = layer === BASE ? 4 : layer === MID ? 16 : 64;
  const material = "snow";
  const base = mb.count(material);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = x0 + i * st;
      const z = z0 + j * st;
      let y = height(x, z);
      // An edge the coarser layer continues: on its lattice.
      if (coarser) {
        const cs = coarser.step;
        const onX = (i === 0 && edgeOpen[0]) || (i === n && edgeOpen[1]);
        const onZ = (j === 0 && edgeOpen[2]) || (j === n && edgeOpen[3]);
        if (onX || onZ) {
          // Along x edges z varies; along z edges x varies. A corner is a lattice point of both.
          const along = onX ? z : x;
          const a = Math.floor(along / cs) * cs;
          const t = (along - a) / cs;
          if (onX && onZ) y = coarseGround(x, z);
          else if (onX) y = coarseGround(x, a) * (1 - t) + coarseGround(x, a + cs) * t;
          else y = coarseGround(a, z) * (1 - t) + coarseGround(a + cs, z) * t;
        }
      }
      // Under the finer layer, except on the ring that borders its coverage.
      if (finer) {
        let inside = true;
        for (let dz = -1; dz <= 1 && inside; dz++) for (let dx = -1; dx <= 1 && inside; dx++) inside = cells.covers(finer, x + dx * st - 1e-3, z + dz * st - 1e-3) && cells.covers(finer, x + dx * st + 1e-3, z + dz * st + 1e-3);
        if (inside) y -= layer.sink;
      }
      const e = st;
      const nx = ground(x - e, z) - ground(x + e, z);
      const nz = ground(x, z - e) - ground(x, z + e);
      const nl = Math.hypot(nx, 2 * e, nz);
      const normal: V3 = [nx / nl, (2 * e) / nl, nz / nl];
      mb.vertex(material, [x, y, z], normal, (i * st) / uvScale, (j * st) / uvScale, tint(world, cover, layer, x, z, y, normal[1]));
    }
  }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = base + j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      // Alternate the diagonal: no grain in the grid.
      if ((i + j) & 1) {
        mb.tri(material, a, c, b);
        mb.tri(material, b, c, d);
      } else {
        mb.tri(material, a, c, d);
        mb.tri(material, a, d, b);
      }
    }
}

function tint(world: RouteWorld, cover: Cover, layer: Layer, x: number, z: number, y: number, up: number): [number, number, number, number] {
  let c: readonly number[] = TINT.open;
  const kind = cover.at(x, z);
  if (kind || cover.surveyed(x, z)) {
    if (kind === "water") c = TINT.water;
    else if (kind === "conifer") c = layer === BASE ? TINT.woodFloor : TINT.conifer;
    else if (kind === "wood" || kind === "forest") c = layer === BASE ? TINT.woodFloor : TINT.wood;
    else if (kind === "scrub") c = TINT.scrub;
    else if (kind === "residential" || kind === "commercial" || kind === "industrial" || kind === "retail") c = TINT.town;
  } else {
    // Beyond the survey: hillsides are wooded up to the tree line (about 1100 m here), the plain is farmed.
    const slope = Math.acos(clamp(up, 0, 1));
    const wooded = smoothstep(0.1, 0.24, slope) * (1 - smoothstep(1000, 1250, y)) * smoothstep(0.25, 0.6, fbm2(x / 900, z / 900, 3, 11) + slope);
    const mix = fbm2(x / 2600, z / 2600, 2, 4);
    const w = mix > 0.5 ? TINT.wood : TINT.conifer;
    c = [TINT.open[0] + (w[0] - 255) * wooded, TINT.open[1] + (w[1] - 255) * wooded, TINT.open[2] + (w[2] - 255) * wooded];
  }
  // Wind crust and drift: a little value variation over open snow.
  const v = 0.94 + 0.06 * fbm2(x / 37, z / 37, 3, 2);
  void world;
  return [Math.round(c[0] * v), Math.round(c[1] * v), Math.round(c[2] * v), 255];
}
