import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2, Vector3, type Material } from "three";
import type { KamakuraWorld } from "./context";
import { BUILDINGS, ROADS } from "./data";
import { BATTER, eastGround, eastGroundEdge, eastKerb, roadAt, terraceY, TRIANGLE, triangleLift, WALK, wallBase, wallTop } from "./ground";
import { COAST, GROUND_POINTS, slopeEdges, slopeY, TRACK, TRACK_SPLIT } from "./layout";

/**
 * The hillside north of the track: ground heights from the GSI survey and
 * the PLATEAU building bases (inverse-distance weighted, so each lot reads
 * as a terrace), two grids that follow the slope road's edges and the
 * track's north side exactly (the retaining walls stand on those lines),
 * and the PLATEAU hillside roads draped over it.
 */

interface Ctl {
  x: number;
  z: number;
  y: number;
  w: number;
}

const CTL: Ctl[] = [];

function addCtl(x: number, z: number, y: number, w = 1): void {
  CTL.push({ x, z, y, w });
}

function initControl(): void {
  if (CTL.length) return;
  for (const [x, z, y] of GROUND_POINTS) addCtl(x, z, y, 1.5);
  for (const [base, , , , ring] of BUILDINGS) {
    let cx = 0;
    let cz = 0;
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      cx += ring[i * 2] / n;
      cz += ring[i * 2 + 1] / n;
      addCtl(ring[i * 2], ring[i * 2 + 1], base, 0.5);
    }
    addCtl(cx, cz, base, 1.0);
  }
  // The junction east of the slope at 26–48 m north (aerial): the ground under the planted
  // triangle (its lawn stands 1.6–2.1 m above the road, ground.ts), then the side road
  // curving east to the villas' street at (42.9, 21.9 N).
  for (const [x, n, y] of [
    [7, 27, 2.9],
    [7, 31, 3.3],
    [12, 28.5, 3.2],
    [9, 36, 3.6],
    [14, 37, 3.9],
    [20, 34, 4.2],
    [25.6, 24, 4.7],
    [26, 30, 4.6],
    [34, 23, 5.6],
    [42.9, 21.9, 6.4],
    [8, 41, 4.3],
    [12, 43, 4.6],
    // The grass bank above the camera corner, 2–3 m over the road.
    [8, 50, 6.6],
    [9, 56, 7.6],
    [12, 52, 7.4],
  ]) addCtl(x, -n, y, 2.5);
  // West edge of the slope road from the park to the hospital: just above road level.
  for (let n = 10; n <= 38; n += 4) {
    const [xw] = slopeEdges(n);
    addCtl(xw - 1.8, -n, slopeY(n) + 0.6, 2.5);
  }
  // The park and the hospital's lower level, west of the slope at road level.
  for (const [x, n, y] of [
    [-6.5, 12, 1.0],
    [-12, 15, 1.3],
    [-20, 18, 1.7],
    [-28, 21, 2.2],
    [-6.8, 24, 2.4],
    [-7.2, 30, 3.1],
    [-7.5, 36, 3.8],
    [-13, 33, 3.4],
  ]) addCtl(x, -n, y, 2.5);
  // The paved north-west corner of the crossing (boards, cabinets, the curve mirror).
  for (const [x, z] of [
    [-5, -3.5],
    [-8, -3.5],
    [-11, -4],
    [-6, -7],
    [-9.5, -8],
  ]) addCtl(x, z, 0.22, 3);
  // The station side: the footway and the entrance plaza at footway level, west of the crossing.
  for (let x = -8; x > -180; x -= 8) {
    const u = COAST.project(x, 0);
    for (const s of x < -32 ? [-5, -8, -11] : [-5, -7]) {
      const p = COAST.offset(u, s, new Vector3());
      addCtl(p.x, p.z, 0.25, s === -11 ? 1.5 : 4);
    }
  }
  // The track's inland bend east of the split: a cutting at rail level.
  for (let u = TRACK_SPLIT; u < TRACK.max; u += 20) {
    const p = TRACK.point(u, new Vector3());
    addCtl(p.x, p.z, -0.4, 2);
  }
}

/**
 * Ground height of the hillside at (x, z): inverse-distance weighted and
 * softened, then the measured east side of the slope road (villa terrace,
 * planted triangle, junction apron; world/ground.ts).
 */
export function hillY(x: number, z: number): number {
  initControl();
  let sw = 0;
  let sy = 0;
  for (const c of CTL) {
    const d2 = (c.x - x) ** 2 + (c.z - z) ** 2;
    const w = c.w / Math.pow(d2 + 36, 1.6);
    sw += w;
    sy += w * c.y;
  }
  return footwayGround(x, z, eastGround(x, -z, sy / sw));
}

/** Track centreline z by x west of the crossing (the coast line's control points, piecewise linear). */
const TRACK_WEST: [number, number][] = [
  [-174.2, -11.7],
  [-125.2, -9.9],
  [-71.5, -7.2],
  [-43.6, -5.9],
  [-27.7, -4.2],
  [0, 0],
];

/**
 * The footway and station plaza west of the crossing (2.8–8 m north of the
 * track) lie flat just under their paving (0.34 m); the hillside rises
 * behind them.
 */
function footwayGround(x: number, z: number, y: number): number {
  if (x > -4 || x < -178) return y;
  let zt = TRACK_WEST[0][1];
  for (let i = 1; i < TRACK_WEST.length; i++) {
    const [xa, za] = TRACK_WEST[i - 1];
    const [xb, zb] = TRACK_WEST[i];
    if (x <= xb) {
      zt = za + ((zb - za) * (x - xa)) / (xb - xa);
      break;
    }
  }
  const s = zt - z;
  // Footway band 2.8–7.8 m north of the centreline (the station plaza to 12.6 m), blending out
  // over 3 m beyond it.
  const outer = x > -112 && x < -94 ? 12.6 : 7.8;
  if (s < 2.6 || s > outer + 3.2) return y;
  const t = s < outer ? 0 : Math.min(1, (s - outer) / 3.2);
  const flat = Math.min(y, 0.3);
  return flat + (y - flat) * (t * t * (3 - 2 * t));
}

/** Is (x, z) inside the polygon ring (x, z pairs)? */
function inside(ring: number[], x: number, z: number): boolean {
  let c = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/**
 * The junction east of the slope road (26–48 m north) from the aerial: the
 * side road leaving the slope round the planted triangle and curving east.
 * PLATEAU's own polygon there also covers the slope road, so it is replaced.
 */
/** The triangle's north edge along the side road (x, metres north). */
const TRIANGLE_NORTH: [number, number][] = [
  [6.6, 30.0],
  [12, 28.4],
  [16.7, 26.6],
  [20.5, 25.0],
  [22.5, 24.0],
];

const JUNCTION: number[] = [eastKerb(30.5) + 0.25, -30.5, eastKerb(36) + 0.25, -36, eastKerb(41) + 0.25, -41, eastKerb(48) + 0.25, -48, eastKerb(54) + 0.25, -54, 7.5, -53, 10, -47, 16, -41, 23, -36, 29, -31.5, 36, -25.5, 44, -23.2, 44, -19.6, 34, -20, 26, -21.5, 20.5, -25.0, 16.7, -26.6, 12, -28.4, 6.6, -30.0];

/** PLATEAU roads on the hillside (the slope road, the crossing and the station footway are built separately). */
export function hillRoads(): number[][] {
  return [JUNCTION, ...hillStreets()];
}

/** PLATEAU hillside streets other than the junction. */
function hillStreets(): number[][] {
  return [...ROADS.filter((ring) => {
    const n = ring.length / 2;
    let inCorridor = 0;
    let maxN = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = ring[i * 2];
      const north = -ring[i * 2 + 1];
      maxN = Math.max(maxN, north);
      const [w, e] = slopeEdges(north);
      if (north > -5 && north < 205 && x > w - 1.5 && x < e + 1.5) inCorridor++;
    }
    return inCorridor / n < 0.3 && maxN > 21;
  })];
}

/** Grid stations: fine near the crossing, coarse far away. */
function grid(max: number, fine: number): number[] {
  const out: number[] = [0, 1.2];
  let a = fine;
  while (a < max) {
    out.push(a);
    a += a < 120 ? fine : a < 300 ? 8 : a < 700 ? 30 : 60;
  }
  out.push(max);
  return out;
}

/**
 * Builds one side of the hillside as a Coons patch between the track's north
 * edge (b = 0, running along the coast away from the crossing) and the slope
 * road's edge (a = 0, running north). `side` −1 = west, +1 = east.
 */
function patch(side: 1 | -1, aMax: number, bMax: number): { verts: Vector3[]; rows: number; cols: number; as: number[] } {
  const edgeX = (north: number) => {
    const [w, e] = slopeEdges(north);
    const x = side > 0 ? (north < 62 ? eastGroundEdge(north) : e) : w;
    // Past the survey, the road bends north-west toward the school gate.
    return north > 190 ? x - (north - 190) * 0.35 : x;
  };
  const n0 = 2.9;
  const corner = new Vector3(edgeX(n0), 0, -n0);
  const coastU = (a: number) => side * (a + Math.abs(COAST.project(corner.x, corner.z)));
  const coast = (a: number) => COAST.offset(coastU(a), -3.0, new Vector3());
  const c0 = coast(0);
  const road = (b: number) => new Vector3(edgeX(n0 + b), 0, -(n0 + b));
  const as = grid(aMax, 3);
  let bs = grid(bMax, 3);
  if (side > 0) {
    // Rows on either side of the terrace's north wall and the triangle, so the ground steps there.
    const extra = [WALK.to - 0.2, WALK.to + 0.25, TRIANGLE.to].map((n) => n - n0);
    bs = [...new Set([...bs, ...extra])].sort((a, b) => a - b);
  }
  const verts: Vector3[] = [];
  for (const b of bs) {
    const r = road(b);
    for (const a of as) {
      const c = coast(a);
      const p = new Vector3(c.x + r.x - c0.x, 0, c.z + r.z - c0.z);
      verts.push(p);
    }
  }
  return { verts, rows: bs.length, cols: as.length, as };
}

/** Hillside ground, walls on the patch edges, and the hillside roads. */
export function buildTerrain(w: KamakuraWorld): void {
  const lib = w.lib;
  const ground = lib.ground();
  const asphalt = lib.asphalt();
  const roads = hillRoads();
  const lowered = (x: number, z: number) => roads.some((r) => inside(r, x, z));

  for (const side of [1, -1] as const) {
    const { verts, rows, cols, as } = patch(side, side > 0 ? 780 : 600, 320);
    // Heights: hillside IDW, dipped under the draped roads.
    for (const v of verts) v.y = hillY(v.x, v.z) - (lowered(v.x, v.z) ? 0.12 : 0);
    const list: number[] = [];
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        // Faces up whichever way the patch is mirrored.
        list.push(...(side > 0 ? [a, b, c, b, d, c] : [a, c, b, b, c, d]));
      }
    edgeWalls(w, side, verts, cols, rows, as);
    // One ground material out to the patch edge (the far hills are curtains in far.ts).
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(verts.flatMap((v) => [v.x, v.y, v.z]), 3));
    g.setAttribute("uv", new Float32BufferAttribute(verts.flatMap((v) => [v.x, -v.z]), 2));
    g.setIndex(list);
    g.computeVertexNormals();
    w.mesh(g, ground, 0, 0, 0, w.root, { cast: true });
  }

  // Hillside roads, triangulated and subdivided to follow the ground: the junction
  // mouth is concrete (p01, lower left), the streets asphalt.
  for (const [rings, mat] of [
    [[JUNCTION], lib.paving()],
    [roads.slice(1), asphalt],
  ] as [number[][], Material][]) {
    const pos: number[] = [];
    for (const ring of rings) {
      const pts = [];
      for (let i = 0; i < ring.length; i += 2) pts.push(new Vector2(ring[i], ring[i + 1]));
      if (ShapeUtils.isClockWise(pts)) pts.reverse();
      const tris = ShapeUtils.triangulateShape(pts, []);
      for (const t of tris) subdivide(pts[t[0]], pts[t[1]], pts[t[2]], 3.5, pos);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    w.mesh(g, mat, 0, 0, 0, w.root, { cast: false });
  }
  villaWall(w);
}

/**
 * Retaining walls where the hillside meets the slope road (a = 0) and the
 * track (b = 0): faces from the road or the track shoulder up to the ground
 * at the patch edge. East of the slope road near the crossing they are the
 * rock-faced walls under the villas; elsewhere cast-block or plain concrete.
 */
function edgeWalls(w: KamakuraWorld, side: 1 | -1, verts: Vector3[], cols: number, rows: number, as: number[]): void {
  const lib = w.lib;
  const rubble = lib.rubble();
  const block = lib.block();
  const concrete = lib.concrete();
  const buckets = new Map<Material, number[]>();
  const add = (m: Material, q: number[]) => {
    let l = buckets.get(m);
    if (!l) buckets.set(m, (l = []));
    l.push(...q);
  };
  // Quad between two columns of (bottom, top) points; `out` is the outward direction (toward the road / track).
  const face = (m: Material, p0: Vector3, p1: Vector3, y0a: number, y0b: number, out: Vector3) => {
    const q = [p0.x, y0a, p0.z, p1.x, y0b, p1.z, p1.x, p1.y, p1.z, p0.x, p0.y, p0.z];
    const e = new Vector3(p1.x - p0.x, 0, p1.z - p0.z);
    const n = new Vector3(-e.z, 0, e.x);
    const flip = n.dot(out) < 0;
    const tri = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const k of tri) add(m, [q[k * 3], q[k * 3 + 1], q[k * 3 + 2]]);
  };
  // Road edge (a = 0): column 0, rows j.
  const outRoad = new Vector3(-side, 0, 0);
  for (let j = 0; j < rows - 1; j++) {
    const p0 = verts[j * cols];
    const p1 = verts[(j + 1) * cols];
    const n0 = -p0.z;
    const n1 = -p1.z;
    const r0 = slopeY(n0) + 0.06;
    const r1 = slopeY(n1) + 0.06;
    if (n0 > 230) break;
    const tall = Math.max(p0.y - r0, p1.y - r1);
    if (tall < 0.25 && Math.min(p0.y - r0, p1.y - r1) > -0.25) continue;
    // East below 60 m: the villa wall, the triangle and the apron are built in villaWall().
    if (side > 0 && n0 < 60) continue;
    const mat = side > 0 ? (n1 < 26.5 || n0 > 44 ? rubble : n1 < 33 ? concrete : block) : n0 > 38 ? block : concrete;
    face(mat, p0, p1, Math.min(r0, p0.y), Math.min(r1, p1.y), outRoad);
  }
  // Track edge (b = 0): row 0, columns i, as far as the walls show.
  const outTrack = new Vector3(0, 0, 1);
  for (let i = 0; i < cols - 1 && as[i] < 420; i++) {
    const p0 = verts[i];
    const p1 = verts[i + 1];
    const y0 = -0.45;
    if (Math.max(p0.y, p1.y) - y0 < 0.3) continue;
    const mat = side > 0 && as[i] < 140 ? rubble : concrete;
    face(mat, p0, p1, y0, y0, outTrack);
  }
  for (const [m, list] of buckets) {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(list, 3));
    g.computeVertexNormals();
    w.mesh(g, m, 0, 0, 0, w.root, { cast: true });
  }
}

/** Splits a 2D triangle (x, z) until its edges are under `max` and drapes it on the hillside. */
function subdivide(a: Vector2, b: Vector2, c: Vector2, max: number, out: number[]): void {
  const ab = a.distanceTo(b);
  const bc = b.distanceTo(c);
  const ca = c.distanceTo(a);
  const m = Math.max(ab, bc, ca);
  if (m <= max) {
    // Emit facing up (+y): (b − a) × (c − a) has y = (c − a).x (b − a).z − (b − a).x (c − a).z.
    const up = (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y) > 0;
    for (const p of up ? [a, b, c] : [a, c, b]) out.push(p.x, hillY(p.x, p.y) + 0.05, p.y);
    return;
  }
  if (m === ab) {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    subdivide(a, mid, c, max, out);
    subdivide(mid, b, c, max, out);
  } else if (m === bc) {
    const mid = b.clone().add(c).multiplyScalar(0.5);
    subdivide(a, b, mid, max, out);
    subdivide(a, mid, c, max, out);
  } else {
    const mid = c.clone().add(a).multiplyScalar(0.5);
    subdivide(a, b, mid, max, out);
    subdivide(mid, b, c, max, out);
  }
}

/** Pushes a quad (a, b, c, d counter-clockwise seen from `out`) into a position list. */
function quadOut(list: number[], a: Vector3, b: Vector3, c: Vector3, d: Vector3, out: Vector3): void {
  const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
  const tris = n.dot(out) >= 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
  for (const p of tris) list.push(p.x, p.y, p.z);
}

/**
 * The villa wall east of the slope road (p01–p03, p05): a battered rubble
 * wall from the sidewalk to the terrace 4.1–4.5 m up, its concrete coping,
 * the terrace's north wall toward the junction, and the planted triangle
 * north of the garage: a lawn `triangleLift` (1.6–2.1 m) above the road
 * behind a low rubble wall.
 */
function villaWall(w: KamakuraWorld): void {
  const lib = w.lib;
  const rub: number[] = [];
  const cope: number[] = [];
  const lawn: number[] = [];
  const west = new Vector3(-1, 0.3, 0).normalize();
  const ns: number[] = [];
  for (let n = WALK.from; n < WALK.to; n += 1.0) ns.push(n);
  ns.push(WALK.to);
  const foot = (n: number) => new Vector3(wallBase(n), roadAt(n) + WALK.height - 0.02, -n);
  const head = (n: number) => new Vector3(wallTop(n), terraceY(n), -n);
  for (let i = 0; i < ns.length - 1; i++) {
    const [n0, n1] = [ns[i], ns[i + 1]];
    quadOut(rub, foot(n0), foot(n1), head(n1), head(n0), west);
    // Coping: a 0.3 m concrete cap on the wall head.
    const c0 = head(n0);
    const c1 = head(n1);
    const lift = (p: Vector3, dx: number, dy: number) => p.clone().add(new Vector3(dx, dy, 0));
    quadOut(cope, lift(c0, -0.04, 0), lift(c1, -0.04, 0), lift(c1, -0.04, 0.14), lift(c0, -0.04, 0.14), new Vector3(-1, 0, 0));
    quadOut(cope, lift(c0, -0.04, 0.14), lift(c1, -0.04, 0.14), lift(c1, 0.3, 0.14), lift(c0, 0.3, 0.14), new Vector3(0, 1, 0));
  }
  // South end, where the wall meets the track-side wall at the crossing.
  {
    const n = WALK.from;
    const f = foot(n);
    const h = head(n);
    const south = new Vector3(0, 0, 1);
    const g = h.clone().setY(f.y - 0.6);
    quadOut(rub, f.clone().setY(f.y - 0.6), g, h, f, south);
  }
  // The terrace's north wall toward the junction, from the garage east (rubble, falling as the side road climbs).
  const nN = WALK.to;
  for (let x = wallTop(nN); x < 24; x += 1.5) {
    const x1 = Math.min(24, x + 1.5);
    const y0 = hillY(x, -(nN + 0.4)) - 0.15;
    const y1 = hillY(x1, -(nN + 0.4)) - 0.15;
    const t0 = Math.max(y0 + 0.2, terraceY(nN) - Math.max(0, x - 14) * 0.05);
    const t1 = Math.max(y1 + 0.2, terraceY(nN) - Math.max(0, x1 - 14) * 0.05);
    quadOut(rub, new Vector3(x, y0, -nN), new Vector3(x1, y1, -nN), new Vector3(x1, t1, -nN), new Vector3(x, t0, -nN), new Vector3(0, 0, -1));
  }
  // The planted triangle: a prism on the junction surface, its top `triangleLift` (1.6–2.1 m) over the slope road.
  {
    const ring: [number, number][] = [];
    for (let n = TRIANGLE.from + 0.4; n <= TRIANGLE.to; n += 1.5) ring.push([eastKerb(n) + 0.3, n]);
    ring.push([eastKerb(TRIANGLE.to) + 0.3, TRIANGLE.to]);
    for (const p of TRIANGLE_NORTH) 
      ring.push(p);
    const top = (x: number, n: number) => roadAt(n) + triangleLift(n) + 0.03 * (x - eastKerb(n));
    // Walls round the outside (skip the south side, against the terrace wall).
    for (let i = 0; i < ring.length - 1; i++) {
      const [xa, na] = ring[i];
      const [xb, nb] = ring[i + 1];
      // The ring runs north along the kerb, then east and south: the inside is on the right, so
      // outward is the left of the direction of travel.
      const out = new Vector3(na - nb, 0, xa - xb).normalize();
      // From the kerb strip along the road, from the junction surface elsewhere.
      const ya = xa < eastKerb(na) + 0.5 ? roadAt(na) + 0.1 : hillY(xa, -na) - 0.2;
      const yb = xb < eastKerb(nb) + 0.5 ? roadAt(nb) + 0.1 : hillY(xb, -nb) - 0.2;
      const ta = top(xa, na);
      const tb = top(xb, nb);
      if (Math.max(ta - ya, tb - yb) < 0.15) continue;
      const lean = (p: Vector3, k: number) => p.clone().addScaledVector(out, -k * BATTER * 0.6);
      quadOut(rub, new Vector3(xa, ya, -na), new Vector3(xb, yb, -nb), lean(new Vector3(xb, tb, -nb), tb - yb), lean(new Vector3(xa, ta, -na), ta - ya), out.clone().setY(0.2));
    }
    // Lawn top, fanned from the ring's centre and pulled in by the batter.
    const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const cn = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    const close = [...ring, [wallTop(TRIANGLE.from + 0.4), TRIANGLE.from + 0.4] as [number, number]];
    for (let i = 0; i < close.length; i++) {
      const [xa, na] = close[i];
      const [xb, nb] = close[(i + 1) % close.length];
      const pull = (x: number, n: number) => {
        const d = Math.hypot(x - cx, n - cn) || 1;
        const k = Math.min(0.45, 0.3 * TRIANGLE.lift) / d;
        return [x + (cx - x) * k, n + (cn - n) * k];
      };
      const [pa, qa] = pull(xa, na);
      const [pb, qb] = pull(xb, nb);
      quadOut(lawn, new Vector3(cx, top(cx, cn), -cn), new Vector3(pa, top(pa, qa), -qa), new Vector3(pb, top(pb, qb), -qb), new Vector3(cx, top(cx, cn), -cn), new Vector3(0, 1, 0));
    }
  }
  for (const [list, mat] of [
    [rub, lib.rubble()],
    [cope, lib.concrete()],
    [lawn, lib.ground()],
  ] as [number[], Material][]) {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(list, 3));
    g.computeVertexNormals();
    w.mesh(g, mat, 0, 0, 0, w.root, { cast: true });
  }
}
