import type { CellContext } from "../cell";
import { BASE } from "../layers";
import type { Projection } from "../line";
import type { MeshBuilder, V3 } from "../mesh";
import { hash2, smoothstep } from "../noise";
import { CONIFER, LARCH, aspect, stand, uvOf, type CellName } from "../kit/plants-layout";
import type { Feature } from "../source";
import type { Probe, RouteWorld } from "../world";
import { inArea } from "./terrain";

/**
 * Winter vegetation: what stands on the land beside the road in January.
 *
 *   woods        the survey's wood polygons, split into stands (larch
 *                plantation, mixed broadleaf and birch, fir and spruce) by
 *                `stand()`; the terrain's tints use the same function
 *   shelterbelts the survey's tree rows, and rows along a seeded share of
 *                the long straight edges of farmland (the survey maps far
 *                fewer than there are: estimated)
 *   lone trees   one here and there on open farmland (estimated)
 *   farmsteads   a windbreak of conifers on the west and north of buildings
 *                outside the towns (estimated)
 *   towns, parks garden trees between the houses (estimated)
 *   waters       willow scrub and reeds along rivers and streams (estimated)
 *
 * Every plant is surveyed once per 256 m cell (`survey`) and drawn by the
 * layers from that one list, so they agree:
 *
 *   base    every row, lone and farmstead tree and a share of each wood's
 *           front trees as a cross of two cards; the rest of the wood as
 *           wide cards of a whole stand (`clump*`), kept back from the
 *           driven road where they would be seen for the pictures they are
 *   detail  the other front trees, trunks (a five-sided prism) for trees
 *           near the driven road, reeds and garden shrubs
 *   mid     beyond the corridor: stands and shelterbelts as sparse wide
 *           cards on the tinted ground, thinning out with distance
 *
 * One material, `plants` (alpha-tested atlas, `kit/plants.ts`).
 */

const MAT = "plants";
/** How far a card's foot goes under the ground (m). */
const SINK = 0.5;
/** Woods are drawn tree by tree within this distance of the driven road's edge (m). */
const FRONT = 62;
/** Stands as cards begin this far from it. */
const CLUMP_FROM = 44;

type Tint = [number, number, number, number];
type RGB = readonly [number, number, number];

interface Species {
  cells: CellName[];
  /** Height range (m). */
  h: [number, number];
  /** Trunk prism: bark cell, base radius and how far up the tree it runs (shares of the height), taper. */
  trunk: { bark: CellName; r: number; top: number; taper: number } | null;
  /** Boughs or stems reach the ground: the card's foot follows it. */
  low: boolean;
  tint: RGB;
}

const SPECIES = {
  larch: { cells: ["larchA", "larchB", "larchC"], h: [17, 24], trunk: { bark: "barkLarch", r: 0.0105, top: 0.8, taper: 0.25 }, low: false, tint: [255, 250, 244] },
  birch: { cells: ["birchA", "birchB"], h: [12, 18], trunk: { bark: "barkBirch", r: 0.0085, top: 0.8, taper: 0.3 }, low: false, tint: [255, 255, 255] },
  oak: { cells: ["oak"], h: [12, 17], trunk: { bark: "barkDark", r: 0.017, top: 0.36, taper: 0.72 }, low: false, tint: [255, 252, 250] },
  poplar: { cells: ["poplar"], h: [20, 27], trunk: { bark: "barkDark", r: 0.013, top: 0.7, taper: 0.3 }, low: false, tint: [255, 252, 246] },
  spruce: { cells: ["spruceA", "spruceB"], h: [9, 17], trunk: null, low: true, tint: [255, 255, 255] },
  shrub: { cells: ["shrub"], h: [2.4, 5.5], trunk: null, low: true, tint: [255, 250, 244] },
  reeds: { cells: ["reeds"], h: [1.3, 2.1], trunk: null, low: true, tint: [255, 255, 255] },
  bush: { cells: ["bush"], h: [1.2, 2.6], trunk: null, low: true, tint: [255, 255, 255] },
} as const satisfies Record<string, Species>;

type SpeciesName = keyof typeof SPECIES;

const CLUMP: readonly CellName[] = ["clumpLarch", "clumpMixed", "clumpConifer"];

interface Plant {
  x: number;
  z: number;
  sp: SpeciesName;
  h: number;
  /** An integer the plant's variations are hashed from. */
  seed: number;
  /** Drawn by the base layer (0) or the detail layer (1). */
  tier: 0 | 1;
  /** Distance beyond the driven road's ploughed edge (m); 1e9 when far. */
  em: number;
  /** A tree of a wood (trunks only near the road) or one that stands free. */
  wood: boolean;
  /** Crown width against the open-grown tree of the atlas: trees crowded in a belt are narrow. */
  slim?: number;
}

interface Clump {
  x: number;
  z: number;
  cell: CellName;
  h: number;
  seed: number;
}

interface Survey {
  plants: Plant[];
  clumps: Clump[];
}

/** A shelterbelt: one straight run of trees. */
interface Row {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  sp: SpeciesName;
  spacing: number;
  h: number;
  seed: number;
  double: boolean;
  /** Crown width of its trees (see `Plant.slim`); 1 for an avenue's open-grown trees, less for a field belt. */
  slim: number;
}

const WOOD = new Set(["wood", "forest"]);
const SCRUB = new Set(["scrub", "heath"]);
const TOWN = new Set(["residential", "commercial", "retail", "industrial"]);
const FARM = new Set(["farmland", "meadow", "grass", "grassland"]);
const PARK = new Set(["leisure-park", "religious", "cemetery"]);
/** Kept clear: car parks, pitches, rail yards. */
const BARE = new Set(["amenity-parking", "leisure-pitch", "railway", "construction", "garages", "greenhouse_horticulture"]);

/**
 * Areas of one kind around a cell, for many point tests: every polygon's
 * edges are sorted into rows of z, so a test crosses only the edges of its
 * row (the survey's largest woods have thousands of points).
 */
class Region {
  private polys: { box: [number, number, number, number]; rows: number[][] }[] = [];
  private nr: number;
  constructor(
    features: Feature[],
    private z0: number,
    z1: number,
    private rh = 16,
  ) {
    this.nr = Math.max(1, Math.ceil((z1 - z0) / rh));
    for (const f of features) {
      const rows: number[][] = [];
      for (let r = 0; r < this.nr; r++) rows.push([]);
      for (const ring of [f.pts, ...f.holes]) {
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const az = ring[j + 1];
          const bz = ring[i + 1];
          if (az === bz) continue;
          const r0 = Math.max(0, Math.floor((Math.min(az, bz) - z0) / rh));
          const r1 = Math.min(this.nr - 1, Math.floor((Math.max(az, bz) - z0) / rh));
          for (let r = r0; r <= r1; r++) rows[r].push(ring[j], az, ring[i], bz);
        }
      }
      this.polys.push({ box: f.box, rows });
    }
  }

  get empty(): boolean {
    return this.polys.length === 0;
  }

  has(x: number, z: number): boolean {
    const r = Math.floor((z - this.z0) / this.rh);
    if (r < 0 || r >= this.nr) return false;
    for (const p of this.polys) {
      if (x < p.box[0] || x > p.box[2] || z < p.box[1] || z > p.box[3]) continue;
      const e = p.rows[r];
      let inside = false;
      for (let k = 0; k < e.length; k += 4) {
        const az = e[k + 1];
        const bz = e[k + 3];
        if (az > z !== bz > z && x < ((e[k + 2] - e[k]) * (z - az)) / (bz - az) + e[k]) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }
}

const seedOf = (a: number, b: number): number => Math.floor(hash2(a, b) * 0x7fffffff);
/** The `k`th variation (0..1) of a seeded thing. */
const vary = (seed: number, k: number): number => hash2(seed, k * 7919 + 17);
const newProbe = (): Probe => ({ e: 0, road: null, s: 0, d: 0, w: 0, y: 0, zone: 0, zoneRoad: null, zoneS: 0, zoneD: 0 });

/** The driven line every 120 m, for distances and directions that need not be exact. */
const coarse = new WeakMap<RouteWorld, Float64Array>();
const nearOut = { d: 0, tx: 0, tz: -1 };
function nearMain(world: RouteWorld, x: number, z: number): { d: number; tx: number; tz: number } {
  let pts = coarse.get(world);
  if (!pts) {
    const l = world.main.line;
    const n = Math.ceil(l.length / 120) + 1;
    pts = new Float64Array(n * 2);
    const q = { x: 0, y: 0, z: 0, tx: 0, tz: -1, grade: 0 };
    for (let i = 0; i < n; i++) {
      l.at(i * 120, q);
      pts[i * 2] = q.x;
      pts[i * 2 + 1] = q.z;
    }
    coarse.set(world, pts);
  }
  let best = Infinity;
  let at = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const d = (pts[i] - x) * (pts[i] - x) + (pts[i + 1] - z) * (pts[i + 1] - z);
    if (d < best) {
      best = d;
      at = i;
    }
  }
  const a = Math.max(0, at - 2);
  const b = Math.min(pts.length - 2, at + 2);
  const len = Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1]) || 1;
  nearOut.d = Math.sqrt(best);
  nearOut.tx = (pts[b] - pts[a]) / len;
  nearOut.tz = (pts[b + 1] - pts[a + 1]) / len;
  return nearOut;
}

const rowProbe = newProbe();

/** A belt's planting by species: trees a few metres apart, their crowns narrowed by their neighbours (after the larch row of Mild Seven Hill, Biei). */
const BELT: Record<string, { spacing: number; slim: number }> = {
  larch: { spacing: 4.6, slim: 0.78 },
  birch: { spacing: 5.5, slim: 0.9 },
  spruce: { spacing: 4.4, slim: 0.85 },
  poplar: { spacing: 6.5, slim: 0.95 },
};

/** The shelterbelts that may reach a box: the surveyed rows and the seeded farmland edges. */
function rowsNear(world: RouteWorld, x0: number, z0: number, x1: number, z1: number, town: Region): Row[] {
  const rows: Row[] = [];
  const touches = (ax: number, az: number, bx: number, bz: number) => Math.max(ax, bx) >= x0 && Math.min(ax, bx) <= x1 && Math.max(az, bz) >= z0 && Math.min(az, bz) <= z1;
  for (const f of world.source.query("treeRow", x0, z0, x1, z1)) {
    const seed = seedOf(Math.round(f.pts[0] * 10), Math.round(f.pts[1] * 10));
    // A row along a road is an avenue of birch (small in a town); a row in the fields is a shelterbelt of larch. The survey names no species: estimated.
    const street = town.has(f.pts[0], f.pts[1]);
    const avenue = street || world.probe(f.pts[0], f.pts[1], rowProbe).e < 22;
    for (let i = 0; i + 3 < f.pts.length; i += 2) {
      if (!touches(f.pts[i], f.pts[i + 1], f.pts[i + 2], f.pts[i + 3])) continue;
      rows.push({ ax: f.pts[i], az: f.pts[i + 1], bx: f.pts[i + 2], bz: f.pts[i + 3], sp: avenue ? "birch" : "larch", spacing: avenue ? 8 : 6, h: street ? 10 : avenue ? 13.5 + 2 * vary(seed, 1) : 19 + 4 * vary(seed, 1), seed: seed + i, double: false, slim: 1 });
    }
  }
  const seen = new Set<number>();
  for (const f of world.source.query("land", x0, z0, x1, z1)) {
    if (f.type !== "farmland" && f.type !== "meadow") continue;
    for (const ring of [f.pts, ...f.holes]) {
      for (let i = 0; i + 3 < ring.length; i += 2) {
        let [ax, az, bx, bz] = [ring[i], ring[i + 1], ring[i + 2], ring[i + 3]];
        let len = Math.hypot(bx - ax, bz - az);
        if (len < 70) continue;
        // Two fields share an edge: one belt, walked the same way from either.
        if (ax > bx || (ax === bx && az > bz)) [ax, az, bx, bz] = [bx, bz, ax, az];
        const seed = seedOf(Math.round((ax + bx) * 0.5), Math.round((az + bz) * 0.5));
        if (vary(seed, 0) > 0.2 || seen.has(seed)) continue;
        seen.add(seed);
        // A belt is a few hundred metres, not the whole outline of a plain.
        const want = 180 + 260 * vary(seed, 1);
        if (len > want + 40) {
          const s0 = (len - want) * vary(seed, 2);
          const [ux, uz] = [(bx - ax) / len, (bz - az) / len];
          [ax, az, bx, bz] = [ax + ux * s0, az + uz * s0, ax + ux * (s0 + want), az + uz * (s0 + want)];
          len = want;
        }
        if (!touches(ax, az, bx, bz)) continue;
        const k = vary(seed, 3);
        const sp: SpeciesName = k < 0.68 ? "larch" : k < 0.8 ? "birch" : k < 0.92 ? "spruce" : "poplar";
        const h = sp === "larch" ? 18 + 5 * vary(seed, 4) : sp === "birch" ? 13 + 4 * vary(seed, 4) : sp === "spruce" ? 11 + 4 * vary(seed, 4) : 21 + 5 * vary(seed, 4);
        rows.push({ ax, az, bx, bz, sp, ...BELT[sp], h, seed, double: sp === "larch" && vary(seed, 5) < 0.35 });
      }
    }
  }
  // Belts the survey maps as nothing at all (the Biei hills are blank on it): seeded over open land,
  // along or across the lie of the driven road, as the fields are.
  const P = 380;
  const R = 200;
  for (let gj = Math.floor((z0 - R) / P); gj <= Math.floor((z1 + R) / P); gj++)
    for (let gi = Math.floor((x0 - R) / P); gi <= Math.floor((x1 + R) / P); gi++) {
      const seed = seedOf(gi * 7 + 3, gj * 11 - 3);
      if (vary(seed, 0) > 0.45) continue;
      const cx = (gi + vary(seed, 1)) * P;
      const cz = (gj + vary(seed, 2)) * P;
      const half = 55 + 140 * vary(seed, 6);
      const near = nearMain(world, cx, cz);
      if (near.d > 2600) continue;
      const a = Math.atan2(near.tz, near.tx) + (vary(seed, 7) < 0.5 ? 0 : Math.PI / 2) + (vary(seed, 8) - 0.5) * 0.3;
      const [ux, uz] = [Math.cos(a), Math.sin(a)];
      const [ax, az, bx, bz] = [cx - ux * half, cz - uz * half, cx + ux * half, cz + uz * half];
      if (!touches(ax, az, bx, bz) || !openAt(world, cx, cz)) continue;
      const k = vary(seed, 3);
      const sp: SpeciesName = k < 0.62 ? "larch" : k < 0.8 ? "birch" : k < 0.92 ? "spruce" : "poplar";
      const h = sp === "larch" ? 18 + 5 * vary(seed, 4) : sp === "birch" ? 13 + 4 * vary(seed, 4) : sp === "spruce" ? 11 + 4 * vary(seed, 4) : 21 + 5 * vary(seed, 4);
      rows.push({ ax, az, bx, bz, sp, ...BELT[sp], h, seed, double: sp === "larch" && vary(seed, 5) < 0.3 });
    }
  return rows;
}

/** Open country at a point: farmland or nothing surveyed, not a town, a wood, a park or water. */
function openAt(world: RouteWorld, x: number, z: number): boolean {
  for (const f of world.source.query("land", x, z, x, z)) if (!FARM.has(f.type) && inArea(f, x, z)) return false;
  for (const f of world.source.query("water", x, z, x, z)) if (inArea(f, x, z)) return false;
  return true;
}

/**
 * Copses the survey does not map: a small wood in a few of a 520 m
 * lattice's squares, where the country is open (the gullies and field
 * corners of the hills). Estimated.
 */
const copses = new WeakMap<RouteWorld, Map<number, number>>();
function copse(world: RouteWorld, x: number, z: number): boolean {
  const P = 520;
  let m = copses.get(world);
  if (!m) copses.set(world, (m = new Map()));
  const ci = Math.floor(x / P);
  const cj = Math.floor(z / P);
  for (let gj = cj - 1; gj <= cj + 1; gj++)
    for (let gi = ci - 1; gi <= ci + 1; gi++) {
      const seed = seedOf(gi * 13 + 7, gj * 17 - 7);
      if (vary(seed, 0) > 0.38) continue;
      const cx = (gi + vary(seed, 1)) * P;
      const cz = (gj + vary(seed, 2)) * P;
      // An ellipse on a seeded axis, 40–130 m long.
      const a = vary(seed, 3) * Math.PI;
      const [dx, dz] = [x - cx, z - cz];
      const u = (dx * Math.cos(a) + dz * Math.sin(a)) / (20 + 45 * vary(seed, 4));
      const v = (-dx * Math.sin(a) + dz * Math.cos(a)) / (14 + 22 * vary(seed, 5));
      if (u * u + v * v > 1) continue;
      const key = (gi + 32768) * 65536 + (gj + 32768);
      let open = m.get(key);
      if (open === undefined) m.set(key, (open = openAt(world, cx, cz) ? 1 : 0));
      if (open) return true;
    }
  return false;
}

/** Lone trees: one in a few of a 300 m lattice's squares, where the country is open. */
function lonesIn(world: RouteWorld, x0: number, z0: number, x1: number, z1: number, each: (x: number, z: number, sp: SpeciesName, h: number, seed: number) => void): void {
  const P = 300;
  for (let gj = Math.floor(z0 / P); gj <= Math.floor(z1 / P); gj++)
    for (let gi = Math.floor(x0 / P); gi <= Math.floor(x1 / P); gi++) {
      const seed = seedOf(gi * 3 + 37, gj * 5 - 37);
      const x = (gi + vary(seed, 1)) * P;
      const z = (gj + vary(seed, 2)) * P;
      if (x < x0 || x >= x1 || z < z0 || z >= z1 || vary(seed, 3) > 0.4 || !openAt(world, x, z)) continue;
      const k = vary(seed, 4);
      const sp: SpeciesName = k < 0.4 ? "oak" : k < 0.6 ? "poplar" : k < 0.8 ? "larch" : "birch";
      each(x, z, sp, SPECIES[sp].h[0] + (SPECIES[sp].h[1] - SPECIES[sp].h[0]) * (0.6 + 0.4 * vary(seed, 9)), seed);
    }
}

/** Distance to a polyline's nearest segment. */
function lineDistance(pts: Float64Array, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const dx = pts[i + 2] - pts[i];
    const dz = pts[i + 3] - pts[i + 1];
    const t = Math.max(0, Math.min(1, ((x - pts[i]) * dx + (z - pts[i + 1]) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - pts[i] - dx * t, z - pts[i + 1] - dz * t));
  }
  return best;
}

/** Every plant whose foot is in a 256 m cell. */
function survey(world: RouteWorld, ix: number, iz: number): Survey {
  const S = BASE.size;
  const x0 = ix * S;
  const z0 = iz * S;
  const x1 = x0 + S;
  const z1 = z0 + S;
  const M = 48;
  const src = world.source;
  const land = src.query("land", x0 - M, z0 - M, x1 + M, z1 + M);
  const pick = (types: Set<string>) => new Region(land.filter((f) => types.has(f.type)), z0 - M, z1 + M);
  const woods = pick(WOOD);
  const scrub = pick(SCRUB);
  const town = pick(TOWN);
  const park = pick(PARK);
  const bare = pick(BARE);
  const water = new Region(src.query("water", x0 - M, z0 - M, x1 + M, z1 + M), z0 - M, z1 + M);
  const buildings = src.query("building", x0 - 16, z0 - 16, x1 + 16, z1 + 16);
  const rails = src.query("rail", x0 - 10, z0 - 10, x1 + 10, z1 + 10);
  const probe = newProbe();
  const proj: Projection = { s: 0, d: 0, i: 0 };
  const main = world.main;
  const inCell = (x: number, z: number) => x >= x0 && x < x1 && z >= z0 && z < z1;
  const built = (x: number, z: number, gap: number): boolean => {
    for (const b of buildings) {
      if (x < b.box[0] - gap || x > b.box[2] + gap || z < b.box[1] - gap || z > b.box[3] + gap) continue;
      if (inArea(b, x, z) || inArea(b, x + gap, z) || inArea(b, x - gap, z) || inArea(b, x, z + gap) || inArea(b, x, z - gap)) return true;
    }
    return false;
  };
  /** Whether a tree can stand here: off the ploughed roads and their banks, out of water, yards, houses and the railway. */
  const free = (x: number, z: number, edge: number, gap = 2.5): boolean => {
    if (world.probe(x, z, probe).e < edge) return false;
    if (water.has(x, z) || bare.has(x, z) || built(x, z, gap)) return false;
    for (const r of rails) if (x > r.box[0] - 8 && x < r.box[2] + 8 && z > r.box[1] - 8 && z < r.box[3] + 8 && lineDistance(r.pts, x, z) < 7) return false;
    return true;
  };
  /** Distance beyond the driven road's edge, within `reach`. */
  const fromMain = (x: number, z: number, reach: number): number => {
    const p = main.line.project(x, z, reach + main.half, proj);
    return p ? Math.abs(p.d) - main.half : 1e9;
  };
  const plants: Plant[] = [];
  const clumps: Clump[] = [];
  const put = (x: number, z: number, sp: SpeciesName, h: number, seed: number, tier: 0 | 1, em: number, wood: boolean) => plants.push({ x, z, sp, h, seed, tier, em, wood });
  const height = (sp: SpeciesName, seed: number) => SPECIES[sp].h[0] + (SPECIES[sp].h[1] - SPECIES[sp].h[0]) * vary(seed, 9);
  /** Points of a jittered lattice that fall in the cell. */
  const lattice = (pitch: number, salt: number, each: (x: number, z: number, seed: number) => void) => {
    for (let gj = Math.floor(z0 / pitch); gj <= Math.floor(z1 / pitch); gj++)
      for (let gi = Math.floor(x0 / pitch); gi <= Math.floor(x1 / pitch); gi++) {
        const seed = seedOf(gi * 3 + salt, gj * 5 - salt);
        const x = (gi + vary(seed, 1)) * pitch;
        const z = (gj + vary(seed, 2)) * pitch;
        if (inCell(x, z)) each(x, z, seed);
      }
  };

  /** In a surveyed wood or a seeded copse. */
  const wooded = (x: number, z: number) => woods.has(x, z) || (copse(world, x, z) && !town.has(x, z));
  let any = !woods.empty;
  for (let k = 0; k < 25 && !any; k++) any = copse(world, x0 + ((k % 5) * S) / 4, z0 + (Math.floor(k / 5) * S) / 4);
  if (any) {
    // The front of a wood, tree by tree: every tree in the first rows, thinning behind them.
    lattice(6.5, 11, (x, z, seed) => {
      if (!wooded(x, z)) return;
      const em = fromMain(x, z, FRONT);
      if (em > FRONT) return;
      if (vary(seed, 3) > (em < 16 ? 1 : 0.72 - 0.47 * ((em - 16) / (FRONT - 16)))) return;
      if (!free(x, z, 3.5)) return;
      const st = stand(x, z);
      const k = vary(seed, 4);
      const sp: SpeciesName = st === LARCH ? (k < 0.86 ? "larch" : "birch") : st === CONIFER ? (k < 0.84 ? "spruce" : "birch") : k < 0.3 ? "oak" : k < 0.68 ? "birch" : k < 0.88 ? "larch" : "spruce";
      put(x, z, sp, height(sp, seed), seed, vary(seed, 5) < 0.45 ? 0 : 1, em, true);
    });
    // Saplings and brush standing out of the snow under the first rows.
    lattice(9, 97, (x, z, seed) => {
      if (vary(seed, 3) > 0.3 || !wooded(x, z) || fromMain(x, z, 30) > 30 || !free(x, z, 4)) return;
      put(x, z, "shrub", 1.4 + 2.2 * vary(seed, 9), seed, 1, 30, false);
      plants[plants.length - 1].slim = 0.8;
    });
    // Behind it, stands as cards.
    lattice(18, 23, (x, z, seed) => {
      if (!wooded(x, z) || fromMain(x, z, CLUMP_FROM) < CLUMP_FROM || !free(x, z, 7, 4)) return;
      const st = stand(x, z);
      clumps.push({ x, z, cell: CLUMP[st], h: (st === CONIFER ? 15 : st === LARCH ? 20 : 17) * (0.88 + 0.26 * vary(seed, 3)), seed });
    });
  }

  // Shelterbelts.
  for (const row of rowsNear(world, x0 - 4, z0 - 4, x1 + 4, z1 + 4, town)) {
    const len = Math.hypot(row.bx - row.ax, row.bz - row.az);
    const [ux, uz] = [(row.bx - row.ax) / len, (row.bz - row.az) / len];
    for (let line = 0; line < (row.double ? 2 : 1); line++)
      for (let k = 0, s = 2 + line * row.spacing * 0.5; s < len - 1; k++, s += row.spacing) {
        const seed = seedOf(row.seed + k * 2 + line, 71);
        if (vary(seed, 1) < 0.07) continue;
        const off = line * 5 + (vary(seed, 2) - 0.5) * 1.4;
        const along = s + (vary(seed, 3) - 0.5) * 1.6;
        const x = row.ax + ux * along - uz * off;
        const z = row.az + uz * along + ux * off;
        if (!inCell(x, z) || wooded(x, z) || (row.slim < 1 && town.has(x, z)) || !free(x, z, 4.5)) continue;
        put(x, z, row.sp, row.h * (0.9 + 0.2 * vary(seed, 4)), seed, 0, fromMain(x, z, 160), false);
        plants[plants.length - 1].slim = row.slim;
      }
  }

  // Lone trees on open land, now and then with one or two beside them.
  lonesIn(world, x0, z0, x1, z1, (x, z, sp, h, seed) => {
    if (!free(x, z, 12, 6)) return;
    put(x, z, sp, h, seed, 0, fromMain(x, z, 160), false);
    const more = vary(seed, 5) < 0.25 ? 2 : vary(seed, 5) < 0.4 ? 1 : 0;
    for (let i = 0; i < more; i++) {
      const a = vary(seed, 6 + i) * Math.PI * 2;
      const [px, pz] = [x + Math.cos(a) * (7 + 6 * i), z + Math.sin(a) * (7 + 6 * i)];
      if (inCell(px, pz) && free(px, pz, 12, 6)) put(px, pz, sp, h * (0.6 + 0.3 * vary(seed, 12 + i)), seed + 1 + i, 0, fromMain(px, pz, 160), false);
    }
  });

  // Farmsteads: conifers against the north-west wind.
  for (const b of buildings) {
    const [cx, cz] = [(b.box[0] + b.box[2]) / 2, (b.box[1] + b.box[3]) / 2];
    if (!inCell(cx, cz) || (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) < 60 || town.has(cx, cz) || woods.has(cx, cz)) continue;
    const seed = seedOf(Math.round(cx * 2), Math.round(cz * 2));
    if (vary(seed, 1) > 0.42) continue;
    const h = 8 + 5 * vary(seed, 2);
    const pts: [number, number][] = [];
    const west = b.box[0] - 6.5;
    const north = b.box[1] - 6.5;
    for (let z = north, n = 0; z < b.box[3] + 3 && n < 8; z += 4.4, n++) pts.push([west, z]);
    if (vary(seed, 3) < 0.7) for (let x = west + 4.4, n = 0; x < b.box[2] + 3 && n < 8; x += 4.4, n++) pts.push([x, north]);
    pts.forEach(([px, pz], i) => {
      const s = seed + i * 13 + 1;
      const x = px + (vary(s, 1) - 0.5) * 1.2;
      const z = pz + (vary(s, 2) - 0.5) * 1.2;
      if (vary(s, 3) < 0.1 || !free(x, z, 4.5, 3)) return;
      put(x, z, "spruce", h * (0.8 + 0.3 * vary(s, 4)), s, 0, fromMain(x, z, 160), false);
    });
    if (vary(seed, 4) < 0.35) {
      const [x, z] = [b.box[2] + 5 + 4 * vary(seed, 5), b.box[3] + 4 + 4 * vary(seed, 6)];
      if (free(x, z, 5, 3)) put(x, z, vary(seed, 7) < 0.5 ? "birch" : "larch", 13 + 5 * vary(seed, 8), seed + 7, 0, fromMain(x, z, 160), false);
    }
  }

  // Gardens of the towns.
  if (!town.empty)
    lattice(24, 53, (x, z, seed) => {
      if (vary(seed, 3) > 0.3 || !town.has(x, z) || fromMain(x, z, 12) < 9 || !free(x, z, 4.5, 3.5)) return;
      const k = vary(seed, 4);
      if (k < 0.45) put(x, z, "spruce", 5 + 5 * vary(seed, 9), seed, 0, fromMain(x, z, 160), false);
      else if (k < 0.7) put(x, z, "birch", 8 + 4 * vary(seed, 9), seed, 0, fromMain(x, z, 160), false);
      else put(x, z, "bush", height("bush", seed), seed, 1, fromMain(x, z, 160), false);
    });
  if (!park.empty)
    lattice(13, 67, (x, z, seed) => {
      if (vary(seed, 3) > 0.35 || !park.has(x, z) || !free(x, z, 4.5, 3.5)) return;
      const k = vary(seed, 4);
      const sp: SpeciesName = k < 0.4 ? "spruce" : k < 0.7 ? "birch" : k < 0.85 ? "oak" : "larch";
      put(x, z, sp, height(sp, seed) * 0.85, seed, 0, fromMain(x, z, 160), false);
    });

  // Willow scrub on scrubland and along rivers and streams; reeds at the water's edge near the road.
  if (!scrub.empty)
    lattice(7, 83, (x, z, seed) => {
      if (vary(seed, 3) > 0.55 || !scrub.has(x, z) || !free(x, z, 4)) return;
      put(x, z, "shrub", height("shrub", seed), seed, vary(seed, 5) < 0.5 ? 0 : 1, fromMain(x, z, 160), false);
    });
  for (const f of src.query("waterway", x0 - 44, z0 - 44, x1 + 44, z1 + 44)) {
    const river = f.type === "river";
    if (!river && f.type !== "stream") continue;
    const fseed = seedOf(Math.round(f.pts[0] * 10), Math.round(f.pts[1] * 10));
    let run = 0;
    for (let i = 0; i + 3 < f.pts.length; i += 2) {
      const [ax, az, bx, bz] = [f.pts[i], f.pts[i + 1], f.pts[i + 2], f.pts[i + 3]];
      const len = Math.hypot(bx - ax, bz - az);
      const from = run;
      run += len;
      if (len < 0.5 || Math.max(ax, bx) < x0 - 44 || Math.min(ax, bx) > x1 + 44 || Math.max(az, bz) < z0 - 44 || Math.min(az, bz) > z1 + 44) continue;
      const [ux, uz] = [(bx - ax) / len, (bz - az) / len];
      // Steps on a lattice of the whole waterway, so a cell's trees do not depend on where its segments start.
      for (let k = Math.ceil(from / 7); k * 7 < run; k++) {
        const s = k * 7 - from;
        const seed = seedOf(fseed + k, 91);
        // Thickets and gaps, 70 m at a time.
        if (vary(fseed + Math.floor(k / 10), 1) > (river ? 0.75 : 0.5)) continue;
        for (const side of [-1, 1]) {
          const sd = seed + (side > 0 ? 3 : 0);
          const off = side * (river ? 8 + 30 * vary(sd, 2) : 2.5 + 7 * vary(sd, 2));
          const x = ax + ux * s - uz * off;
          const z = az + uz * s + ux * off;
          if (!inCell(x, z)) continue;
          if (vary(sd, 3) < 0.55 && !woods.has(x, z) && !(town.has(x, z) && vary(sd, 4) < 0.7) && free(x, z, 4)) {
            // Now and then a willow grown to a tree.
            if (vary(sd, 5) < 0.12) put(x, z, "oak", 8 + 4 * vary(sd, 6), sd, 0, fromMain(x, z, 160), false);
            else {
              const h = height("shrub", sd);
              put(x, z, "shrub", h, sd, h > 3.6 ? 0 : 1, fromMain(x, z, 160), false);
            }
          }
          if (!river && vary(sd, 7) < 0.4) {
            const o2 = side * (1.2 + 2.5 * vary(sd, 8));
            const [rx, rz] = [ax + ux * s - uz * o2, az + uz * s + ux * o2];
            const em = inCell(rx, rz) ? fromMain(rx, rz, 150) : 1e9;
            if (em < 150 && free(rx, rz, 4)) put(rx, rz, "reeds", height("reeds", sd + 1), sd + 1, 1, em, false);
          }
        }
      }
    }
  }
  return { plants, clumps };
}

const cache = new WeakMap<RouteWorld, Map<number, Survey>>();

/** A cell's survey; the base and the detail layer ask for the same one. */
function surveyOf(world: RouteWorld, ix: number, iz: number): Survey {
  let m = cache.get(world);
  if (!m) cache.set(world, (m = new Map()));
  const key = (ix + 32768) * 65536 + (iz + 32768);
  let s = m.get(key);
  if (!s) {
    if (m.size >= 64) m.delete(m.keys().next().value!);
    m.set(key, (s = survey(world, ix, iz)));
  }
  return s;
}

const UV = new Map<CellName, [number, number, number, number]>();
const ASPECT = new Map<CellName, number>();
function uv(name: CellName): [number, number, number, number] {
  let r = UV.get(name);
  if (!r) UV.set(name, (r = uvOf(name)));
  return r;
}
function ratio(name: CellName): number {
  let r = ASPECT.get(name);
  if (r === undefined) ASPECT.set(name, (r = aspect(name)));
  return r;
}

/** A species' tint, varied in value and a little in warmth. */
function tintOf(base: RGB, seed: number, dim = 1): Tint {
  const v = (0.82 + 0.18 * vary(seed, 21)) * dim;
  const warm = (vary(seed, 22) - 0.5) * 0.06;
  return [Math.round(Math.min(255, base[0] * v * (1 + warm))), Math.round(Math.min(255, base[1] * v)), Math.round(Math.min(255, base[2] * v * (1 - warm))), 255];
}

/**
 * One upright card: `w` wide about (x, z) along `yaw`, from `SINK` under
 * the ground to `h` above it, its top shifted by the lean. Cards face the
 * sky as much as the viewer: under cloud a tree is lit from above on both
 * its sides.
 */
function card(mb: MeshBuilder, world: RouteWorld, cell: CellName, x: number, y: number, z: number, yaw: number, w: number, h: number, lx: number, lz: number, tint: Tint, follow: boolean, flip: boolean): void {
  const dx = (Math.cos(yaw) * w) / 2;
  const dz = (Math.sin(yaw) * w) / 2;
  let ya = y;
  let yb = y;
  if (follow) {
    // On a slope a wide card's ends stand on their own ground.
    ya = world.base(x - dx, z - dz);
    yb = world.base(x + dx, z + dz);
  }
  const r = uv(cell);
  const n: V3 = [-Math.sin(yaw) * 0.5, 0.86, Math.cos(yaw) * 0.5];
  mb.quad(MAT, [x - dx, ya - SINK, z - dz], [x + dx, yb - SINK, z + dz], [x + dx + lx, yb + h, z + dz + lz], [x - dx + lx, ya + h, z - dz + lz], flip ? [r[2], r[1], r[0], r[3]] : r, tint, n);
}

/** A tree as two crossed cards. */
function cross(mb: MeshBuilder, world: RouteWorld, p: Plant, y: number): void {
  const sp: Species = SPECIES[p.sp];
  const cell = sp.cells[Math.floor(vary(p.seed, 11) * sp.cells.length) % sp.cells.length];
  const w = (p.h + SINK) * ratio(cell) * (p.slim ?? 1);
  const yaw = vary(p.seed, 12) * Math.PI;
  const [lx, lz] = lean(p);
  const tint = tintOf(sp.tint, p.seed);
  for (let k = 0; k < 2; k++) card(mb, world, cell, p.x, y, p.z, yaw + (k * Math.PI) / 2 + (vary(p.seed, 15 + k) - 0.5) * 0.3, w, p.h, lx, lz, tint, sp.low, vary(p.seed, 17 + k) < 0.5);
}

/** How far a tree's top stands off its foot. */
function lean(p: Plant): [number, number] {
  const k = SPECIES[p.sp].low ? 0 : 0.06 * p.h;
  return [(vary(p.seed, 13) - 0.5) * k, (vary(p.seed, 14) - 0.5) * k];
}

/** The trunk as a prism, where the card's painted trunk would read as paper. */
function trunk(mb: MeshBuilder, p: Plant, y: number): void {
  const sp: Species = SPECIES[p.sp];
  if (!sp.trunk) return;
  const t = sp.trunk;
  const H = p.h + SINK;
  const [lx, lz] = lean(p);
  const ra = t.r * H * 1.08;
  const tint = tintOf(sp.tint, p.seed, 0.96);
  mb.tube(MAT, [p.x, y - SINK, p.z], [p.x + lx * t.top, y - SINK + H * t.top, p.z + lz * t.top], ra, ra * t.taper, 5, uv(t.bark), tint);
}

function corridor(c: CellContext): void {
  const { world, mb } = c;
  const s = surveyOf(world, c.ix, c.iz);
  const base = c.layer.name === "base";
  for (const p of s.plants) {
    const y = world.base(p.x, p.z);
    if (p.tier === (base ? 0 : 1)) cross(mb, world, p, y);
    if (!base && p.em < (p.wood ? 34 : 150)) trunk(mb, p, y);
  }
  if (!base) return;
  for (const k of s.clumps) {
    const w = (k.h + SINK) * ratio(k.cell);
    const tint = tintOf([255, 253, 250], k.seed, 0.96);
    card(mb, world, k.cell, k.x, world.base(k.x, k.z), k.z, vary(k.seed, 4) * Math.PI, w, k.h, 0, 0, tint, true, vary(k.seed, 5) < 0.5);
  }
}

/** Beyond the corridor: stands and shelterbelts as sparse wide cards, out to where they stop showing. */
function beyond(c: CellContext): void {
  const { world, mb, cells, x0, z0, x1, z1 } = c;
  const land = world.source.query("land", x0, z0, x1, z1);
  const woods = new Region(
    land.filter((f) => WOOD.has(f.type)),
    z0,
    z1,
    64,
  );
  const town = new Region(
    land.filter((f) => TOWN.has(f.type)),
    z0,
    z1,
    64,
  );
  const inCell = (x: number, z: number) => x >= x0 && x < x1 && z >= z0 && z < z1;
  /** Cards thin out between 1.3 and 2.3 km from the driven road. */
  const shown = (x: number, z: number, seed: number) => !cells.covers(BASE, x, z) && vary(seed, 8) < 1 - smoothstep(1300, 2300, nearMain(world, x, z).d);
  {
    const P = 48;
    for (let gj = Math.floor(z0 / P); gj <= Math.floor(z1 / P); gj++)
      for (let gi = Math.floor(x0 / P); gi <= Math.floor(x1 / P); gi++) {
        const seed = seedOf(gi * 3 + 5, gj * 5 - 5);
        const x = (gi + 0.15 + 0.7 * vary(seed, 1)) * P;
        const z = (gj + 0.15 + 0.7 * vary(seed, 2)) * P;
        if (!inCell(x, z) || !(woods.has(x, z) || (copse(world, x, z) && !town.has(x, z))) || !shown(x, z, seed)) continue;
        const st = stand(x, z);
        const cell = CLUMP[st];
        const h = (st === CONIFER ? 19 : 24) * (0.9 + 0.25 * vary(seed, 3));
        card(mb, world, cell, x, world.base(x, z), z, vary(seed, 4) * Math.PI, h * ratio(cell) * 1.3, h, 0, 0, tintOf([250, 248, 246], seed, 0.94), true, vary(seed, 5) < 0.5);
      }
  }
  for (const row of rowsNear(world, x0, z0, x1, z1, town)) {
    const len = Math.hypot(row.bx - row.ax, row.bz - row.az);
    const [ux, uz] = [(row.bx - row.ax) / len, (row.bz - row.az) / len];
    const cell: CellName = row.sp === "larch" ? "clumpLarch" : row.sp === "spruce" ? "clumpConifer" : row.sp === "poplar" ? "poplar" : "clumpMixed";
    const w = row.sp === "poplar" ? row.h * ratio(cell) : (row.h * ratio(cell)) / 1.1;
    const step = row.sp === "poplar" ? row.spacing : w * 0.9;
    const along = Math.atan2(uz, ux);
    for (let k = 0, s = step / 2; s < len; k++, s += step) {
      const x = row.ax + ux * s;
      const z = row.az + uz * s;
      const seed = seedOf(row.seed + k, 73);
      if (!inCell(x, z) || woods.has(x, z) || !shown(x, z, seed)) continue;
      // Turned a little off the row, alternately: a belt seen end-on keeps some width.
      card(mb, world, cell, x, world.base(x, z), z, along + (k & 1 ? 0.4 : -0.4), w, row.h * 1.05, 0, 0, tintOf([255, 252, 248], seed, 0.96), true, vary(seed, 5) < 0.5);
    }
  }
  lonesIn(world, x0, z0, x1, z1, (x, z, sp, h, seed) => {
    if (shown(x, z, seed)) cross(mb, world, { x, z, sp, h, seed, tier: 0, em: 1e9, wood: false }, world.base(x, z));
  });
  // Willow thickets along the rivers.
  const water = new Region(world.source.query("water", x0, z0, x1, z1), z0, z1, 64);
  for (const f of world.source.query("waterway", x0, z0, x1, z1)) {
    if (f.type !== "river") continue;
    const fseed = seedOf(Math.round(f.pts[0] * 10), Math.round(f.pts[1] * 10));
    let run = 0;
    for (let i = 0; i + 3 < f.pts.length; i += 2) {
      const [ax, az, bx, bz] = [f.pts[i], f.pts[i + 1], f.pts[i + 2], f.pts[i + 3]];
      const len = Math.hypot(bx - ax, bz - az);
      const from = run;
      run += len;
      if (len < 0.5) continue;
      for (let k = Math.ceil(from / 30); k * 30 < run; k++) {
        const s = k * 30 - from;
        if (vary(fseed + Math.floor(k / 4), 1) > 0.7) continue;
        for (const side of [-1, 1]) {
          const seed = seedOf(fseed + k, side > 0 ? 97 : 93);
          const off = side * (14 + 34 * vary(seed, 2));
          const x = ax + ((bx - ax) / len) * s - ((bz - az) / len) * off;
          const z = az + ((bz - az) / len) * s + ((bx - ax) / len) * off;
          if (!inCell(x, z) || vary(seed, 3) > 0.6 || water.has(x, z) || woods.has(x, z) || town.has(x, z) || !shown(x, z, seed)) continue;
          const h = 7 + 5 * vary(seed, 4);
          card(mb, world, "clumpMixed", x, world.base(x, z), z, vary(seed, 5) * Math.PI, h * ratio("clumpMixed"), h, 0, 0, tintOf([255, 236, 220], seed, 0.96), true, vary(seed, 6) < 0.5);
        }
      }
    }
  }
}

/** Trees, shrubs, woods, shelter belts: what this generator puts in a cell. */
export function plants(c: CellContext): void {
  if (c.layer.name === "mid") beyond(c);
  else if (c.layer.name === "base" || c.layer.name === "detail") corridor(c);
}
