import { BufferGeometry, CylinderGeometry, QuadraticBezierCurve3, TorusGeometry, TubeGeometry, Vector3, type Material } from "three";
import { box } from "../../shared/geo";
import { merge, rod, v3 } from "../../shared/shapes";
import { pipe, QuadBuilder, scaleUV } from "../gfx/geometry";
import type { SugaWorld } from "./context";
import { STAIRS } from "./layout";

const N_Y = v3(0, 1, 0);
const N_MZ = v3(0, 0, -1);
const N_X = v3(1, 0, 0);
const N_MX = v3(-1, 0, 0);
const N_CH = v3(0, 1, -1).normalize();

/**
 * A stone slab with its nosing facing −Z: top at `y`, front edge at `zf`
 * (zf < zb), a small chamfer on the front-top edge, visible ends. UVs in
 * metres, offset per slab so each shows a different part of the stone.
 */
function slab(q: QuadBuilder, x0: number, x1: number, zf: number, zb: number, y: number, t: number, c: number, uo: number, vo: number): void {
  const yb = y - t;
  q.quad([v3(x0, y, zf + c), v3(x1, y, zf + c), v3(x1, y, zb), v3(x0, y, zb)], N_Y, [
    [x0 + uo, zf + c + vo],
    [x1 + uo, zf + c + vo],
    [x1 + uo, zb + vo],
    [x0 + uo, zb + vo],
  ]);
  q.quad([v3(x0, y - c, zf), v3(x1, y - c, zf), v3(x1, y, zf + c), v3(x0, y, zf + c)], N_CH, [
    [x0 + uo, vo],
    [x1 + uo, vo],
    [x1 + uo, vo + c * 1.4],
    [x0 + uo, vo + c * 1.4],
  ]);
  q.quad([v3(x0, yb, zf), v3(x1, yb, zf), v3(x1, y - c, zf), v3(x0, y - c, zf)], N_MZ, [
    [x0 + uo, yb + vo],
    [x1 + uo, yb + vo],
    [x1 + uo, y - c + vo],
    [x0 + uo, y - c + vo],
  ]);
  for (const [x, n] of [
    [x0, N_MX],
    [x1, N_X],
  ] as const) {
    q.quad([v3(x, yb, zf), v3(x, yb, zb), v3(x, y, zb), v3(x, y, zf)], n, [
      [zf + uo, yb + vo],
      [zb + uo, yb + vo],
      [zb + uo, y + vo],
      [zf + uo, y + vo],
    ]);
  }
}

/** Splits [a, b] into 3–4 slabs of at least 0.7 m. */
function split(w: SugaWorld, a: number, b: number): number[] {
  const span = b - a;
  const n = w.rng.chance(0.55) ? 4 : 3;
  for (let tries = 0; tries < 20; tries++) {
    const cuts = Array.from({ length: n - 1 }, () => a + w.rng.range(0.1, 0.9) * span).sort((p, q) => p - q);
    const xs = [a, ...cuts, b];
    if (xs.every((x, i) => i === 0 || x - xs[i - 1] >= 0.7)) return xs;
  }
  return Array.from({ length: n + 1 }, (_, i) => a + (span * i) / n);
}

/** The flight: landing, 47 treads and 48 risers of granite, side curbs, three handrails, the lantern frame. */
export function buildStairs(w: SugaWorld): void {
  const { rise: R, tread: T, count: N } = STAIRS;
  const half = STAIRS.width / 2;
  const lib = w.lib;
  const gap = 0.006;
  const nose = 0.015;
  const thick = 0.07;
  const root = w.group();
  root.name = "stairs";

  // Tread stones: mostly light grey, some warmer, a few pink or dark replacements.
  const treadMats: { m: Material; p: number }[] = [
    { m: lib.granite([1, 1, 1]), p: 0.66 },
    { m: lib.granite([1.06, 1.0, 0.92]), p: 0.22 },
    { m: lib.granite([1.18, 0.95, 0.86]), p: 0.06 },
    { m: lib.granite([0.6, 0.61, 0.64], 1.05), p: 0.06 },
  ];
  const pickTread = (): Material => {
    let r = w.rng.next();
    for (const t of treadMats) if ((r -= t.p) <= 0) return t.m;
    return treadMats[0].m;
  };
  const riserMat = lib.granite([0.52, 0.52, 0.53], 1.05);
  const quads = new Map<Material, QuadBuilder>();
  const qb = (m: Material) => {
    let q = quads.get(m);
    if (!q) quads.set(m, (q = new QuadBuilder()));
    return q;
  };

  const grime = new QuadBuilder();
  const nosing = new QuadBuilder();
  // Landing at the head: two rows of 0.6 m pavers plus the nosing row.
  for (let row = 0; row < 2; row++) {
    const zf = row === 0 ? -nose : row * 0.6;
    const zb = (row + 1) * 0.6;
    const xs = split(w, -half, half);
    for (let i = 0; i < xs.length - 1; i++) slab(qb(pickTread()), xs[i] + gap / 2, xs[i + 1] - gap / 2, zf + gap / 2, zb - gap / 2, 0, thick, row === 0 ? 0.008 : 0.003, w.rng.range(0, 2), w.rng.range(0, 2));
  }

  for (let k = 1; k <= N; k++) {
    const yTop = -(k - 1) * R;
    const y = -k * R;
    const zr = -(k - 1) * T;
    const xs = split(w, -half, half);
    // Riser k: from tread k (or the lane) up to the underside of the slab above.
    for (let i = 0; i < xs.length - 1; i++) {
      const x0 = xs[i] + gap / 2;
      const x1 = xs[i + 1] - gap / 2;
      const y1 = yTop - thick;
      const uo = w.rng.range(0, 2);
      const vo = w.rng.range(0, 2);
      qb(riserMat).quad([v3(x0, y, zr), v3(x1, y, zr), v3(x1, y1, zr), v3(x0, y1, zr)], N_MZ, [
        [x0 + uo, y + vo],
        [x1 + uo, y + vo],
        [x1 + uo, y1 + vo],
        [x0 + uo, y1 + vo],
      ]);
    }
    if (k === N) break;
    // Tread k.
    const ts = split(w, -half, half);
    for (let i = 0; i < ts.length - 1; i++) {
      slab(qb(pickTread()), ts[i] + gap / 2, ts[i + 1] - gap / 2, -k * T - nose, zr + 0.03, y, thick, 0.012, w.rng.range(0, 2), w.rng.range(0, 2));
    }
    // Flamed anti-slip band behind the nosing: a darker line at every step seen from above.
    const zf = -k * T - nose + 0.012;
    nosing.quad([v3(-half + 0.01, y + 0.0012, zf), v3(half - 0.01, y + 0.0012, zf), v3(half - 0.01, y + 0.0012, zf + 0.045), v3(-half + 0.01, y + 0.0012, zf + 0.045)], N_Y, [
      [0, 0],
      [STAIRS.width, 0],
      [STAIRS.width, 0.045],
      [0, 0.045],
    ]);
    // Mortar joint and swept-in grit along the foot of the riser above.
    const gw = 0.035 + w.rng.range(0, 0.025);
    grime.quad([v3(-half, y + 0.0015, zr - gw), v3(half, y + 0.0015, zr - gw), v3(half, y + 0.0015, zr), v3(-half, y + 0.0015, zr)], N_Y, [
      [w.rng.range(0, 2), 0],
      [w.rng.range(0, 2) + STAIRS.width, 0],
      [w.rng.range(0, 2) + STAIRS.width, gw],
      [w.rng.range(0, 2), gw],
    ]);
  }
  for (const [m, q] of quads) w.mesh(q.build(), m, 0, 0, 0, root);
  w.mesh(grime.build(), lib.granite([0.2, 0.19, 0.17], 1.1), 0, 0, 0, root, { cast: false });
  w.mesh(nosing.build(), lib.granite([0.42, 0.42, 0.43], 1.15), 0, 0, 0, root, { cast: false });
  // Concrete body under the stones (seen only through the joints).
  const body: BufferGeometry[] = [];
  for (let k = 0; k < N; k++) {
    const top = -k * R - thick;
    const g = box(STAIRS.width, top + 8.2, T);
    g.translate(0, (top - 8.2) / 2, -(k + 0.5) * T);
    body.push(g);
  }
  w.mesh(merge(body), lib.concrete([0.45, 0.45, 0.44]), 0, 0, 0, root, { cast: false });

  // Side curbs: concrete copings 0.1 m above the pitch line.
  const curb = lib.concrete([0.9, 0.89, 0.86]);
  const zEnd = -7.5 / (R / T);
  for (const side of [-1, 1]) {
    const q = new QuadBuilder();
    const xi = side * half;
    const xo = side * (half + 0.17);
    const prof: [number, number][] = [
      [1.25, 0.1],
      [0, 0.1],
      [zEnd, -7.4],
      [zEnd - 0.7, -7.4],
    ];
    for (let i = 0; i < prof.length - 1; i++) {
      const [za, ya] = prof[i];
      const [zb, yb] = prof[i + 1];
      // Top (sloped), inner face down into the treads, outer face.
      const n = new Vector3(0, za - zb, ya - yb).cross(N_X).normalize();
      if (n.y < 0) n.negate();
      q.quad([v3(xi, ya, za), v3(xo, ya, za), v3(xo, yb, zb), v3(xi, yb, zb)], n, [
        [xi, za],
        [xo, za],
        [xo, zb],
        [xi, zb],
      ]);
      const ni = side > 0 ? N_MX : N_X;
      q.quad([v3(xi, ya - 0.6, za), v3(xi, ya, za), v3(xi, yb, zb), v3(xi, yb - 0.6, zb)], ni, [
        [za, ya - 0.6],
        [za, ya],
        [zb, yb],
        [zb, yb - 0.6],
      ]);
    }
    w.mesh(q.build(), curb, 0, 0, 0, root);
  }

  buildRails(w);
  buildLanternFrame(w);
}

/** Pipe bend from a to c through the corner b (quadratic), as a short tube. */
function bend(a: Vector3, b: Vector3, c: Vector3, r: number, radial: number): BufferGeometry {
  const curve = new QuadraticBezierCurve3(a, b, c);
  return scaleUV(new TubeGeometry(curve, 6, r, radial, false), curve.getLength(), 2 * Math.PI * r);
}

/**
 * Three painted steel handrails (left, centre, right): a Ø48.6 mm top rail
 * 0.85 m above the nosings and a lower rail, on Ø42.7 mm posts every six
 * treads. The top rail runs 0.45 m past each end and turns down into the
 * paving.
 */
function buildRails(w: SugaWorld): void {
  const { rise: R, tread: T } = STAIRS;
  const slope = R / T;
  const H = STAIRS.railHeight;
  const r = 0.0243;
  const rp = 0.0214;
  const radial = 12;
  const paint = w.lib.paint(0x6a2622, 0.55);
  const zEnd = -7.5 / slope;
  const bendR = 0.12;
  const geos: BufferGeometry[] = [];
  const flanges: BufferGeometry[] = [];
  const posts = [1, 7, 13, 19, 25, 31, 37, 43, 47];

  for (const x of STAIRS.rails) {
    const dirSlope = new Vector3(0, -slope, -1).normalize();
    // Top rail path: up out of the landing, along, down the pitch, along, down into the lane.
    const pTop0 = v3(x, 0, 0.45);
    const cTop = v3(x, H, 0.45);
    const cHead = v3(x, H, 0);
    const cFoot = v3(x, -7.5 + H, zEnd);
    const cLow = v3(x, -7.5 + H, zEnd - 0.45);
    const pEnd = v3(x, -7.5, zEnd - 0.45);
    const along = (a: Vector3, b: Vector3, d: number) => a.clone().addScaledVector(new Vector3().subVectors(b, a).normalize(), d);
    const segs: [Vector3, Vector3, Vector3][] = [
      [pTop0, cTop, cHead],
      [cTop, cHead, cFoot],
      [cHead, cFoot, cLow],
      [cFoot, cLow, pEnd],
    ];
    // Straight runs between the fillets, then each fillet as a bent tube.
    const pts: Vector3[] = [pTop0];
    for (const [a, b, c] of segs) {
      const inPt = along(b, a, bendR);
      const outPt = along(b, c, bendR);
      geos.push(pipe(pts[pts.length - 1], inPt, r, radial));
      geos.push(bend(inPt, b, outPt, r, radial));
      pts.push(outPt);
    }
    geos.push(pipe(pts[pts.length - 1], pEnd, r, radial));

    // Posts and the lower rail.
    const zs = posts.map((k) => -(k - 0.5) * T);
    for (const [i, z] of zs.entries()) {
      const k = posts[i];
      const yBase = -k * R;
      const yTop = z * slope + H;
      geos.push(pipe(v3(x, yBase, z), v3(x, yTop - r * 0.5, z), rp, 10));
      const f = new CylinderGeometry(0.055, 0.06, 0.012, 14);
      f.translate(x, yBase + 0.006, z);
      flanges.push(f);
    }
    const low0 = v3(x, zs[0] * slope + STAIRS.lowerRail, zs[0]);
    const low1 = v3(x, zs[zs.length - 1] * slope + STAIRS.lowerRail, zs[zs.length - 1]);
    geos.push(pipe(low0.clone().addScaledVector(dirSlope, -0.02), low1.clone().addScaledVector(dirSlope, 0.02), r * 0.9, radial));
    // Anchor sleeves where the returns enter the paving.
    for (const p of [pTop0, pEnd]) {
      const f = new CylinderGeometry(0.045, 0.05, 0.02, 14);
      f.translate(p.x, p.y + 0.01, p.z);
      flanges.push(f);
    }
  }
  w.mesh(merge(geos), paint, 0, 0, 0, w.root);
  w.mesh(merge(flanges), w.lib.paint(0x551c19, 0.6), 0, 0, 0, w.root);
}

/** Steel frame spanning the stair head for hanging festival lanterns. */
function buildLanternFrame(w: SugaWorld): void {
  const m = w.lib.paint(0x8a8e90, 0.5);
  const geos: BufferGeometry[] = [];
  const x = 2.08;
  const z = 0.35;
  const top = 3.55;
  for (const s of [-1, 1]) {
    const post = box(0.075, top, 0.075);
    post.translate(s * x, top / 2, z);
    geos.push(post);
    const foot = box(0.18, 0.02, 0.18);
    foot.translate(s * x, 0.01, z);
    geos.push(foot);
    // Knee braces.
    geos.push(rod(v3(s * x, top - 0.55, z), v3(s * (x - 0.5), top - 0.04, z), 0.018, 6));
  }
  const beam = box(2 * x + 0.1, 0.075, 0.075);
  beam.translate(0, top - 0.035, z);
  geos.push(beam);
  const lower = box(2 * x, 0.04, 0.04);
  lower.translate(0, top - 0.42, z);
  geos.push(lower);
  // Hooks for the lanterns.
  for (let i = -3; i <= 3; i++) {
    const hook = new TorusGeometry(0.025, 0.004, 5, 10);
    hook.translate(i * 0.55, top - 0.46, z);
    geos.push(hook);
  }
  w.mesh(merge(geos), m, 0, 0, 0, w.root);
}
