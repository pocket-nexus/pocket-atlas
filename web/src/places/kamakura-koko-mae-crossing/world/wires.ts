import { BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, LatheGeometry, PlaneGeometry, SphereGeometry, Vector2, Vector3 } from "three";
import { cablePoint, merge, rod, tube } from "../../shared/shapes";
import type { CellKey, EquipAtlas } from "../gfx/equip";
import { Bag, type KamakuraWorld } from "./context";
import { CATENARY, COAST, PLATFORM, slopeY, TRACK, VIEW } from "./layout";
import { hillY } from "./terrain";

/**
 * Poles and overhead lines.
 *
 * The Enoden's overhead line: dark-brown steel poles on the sea side of the
 * track every ~35 m, each with a bent-pipe cantilever and a stay over the
 * track, a messenger wire 5.6 m above the rail with droppers every ~5 m to
 * the contact wire at 5.0 m (staggered ±0.2 m), and two twisted feeder
 * cables on brackets at 6.15 and 6.75 m (the two dark lines across the sea
 * in the canonical view). At the crossing the line hangs from a span wire
 * between the concrete pole at the north-east corner and a brown pole
 * south-east of the road.
 *
 * Distribution: spun-concrete poles 10.5–11 m (crossarm with three pin
 * insulators, a low-voltage arm, telecom brackets, step bolts, a tag; a
 * transformer on the north-west pole) at both corners and up both sides of
 * the slope, with high-voltage, low-voltage and telecom spans across the
 * road and up the hill; the thick black twisted cable sagging across the
 * road at the crossing from the north-east pole to the brown steel pole at
 * the north-west corner and on to the concrete pole behind it.
 *
 * Wires are tubes with a minimum radius per vertex: 0.28 of a handheld
 * pixel (272 rows) at the nearest shot camera, so they stay a steady
 * sub-pixel line at 480 × 272 instead of breaking up; real radius when the
 * camera is close. Everything merges into the equipment material; wires
 * cast no shadow (sub-pixel in the shadow map).
 */

const UP = new Vector3(0, 1, 0);

/** Shot eyes and vertical fields of view (deg), for the wires' minimum width. */
function shotEyes(): { p: Vector3; fov: number }[] {
  const side = (v: { x: number; z: number }, s: number) => COAST.offset(COAST.project(v.x, v.z), s, new Vector3()).setY(1.81);
  return [
    { p: new Vector3(VIEW.crossing.x, 6.8, VIEW.crossing.z), fov: 18 },
    { p: new Vector3(VIEW.postcard.x, 8.4, VIEW.postcard.z), fov: 17 },
    { p: new Vector3(VIEW.platform.x, PLATFORM.height + 1.6, VIEW.platform.z), fov: 22 },
    { p: side(VIEW.route134, 6.0), fov: 40 },
    { p: side(VIEW.seawall, 18.0), fov: 40 },
    { p: new Vector3(VIEW.park.x, hillY(VIEW.park.x, VIEW.park.z) + 1.6, VIEW.park.z), fov: 40 },
  ];
}

class Wires {
  private eyes = shotEyes();
  readonly geos: BufferGeometry[] = [];
  constructor(private E: EquipAtlas) {}

  /** Smallest handheld pixel (m) over the shots at p. */
  pixel(p: Vector3): number {
    let m = Infinity;
    for (const e of this.eyes) m = Math.min(m, (p.distanceTo(e.p) * ((e.fov * Math.PI) / 180)) / 272);
    return m;
  }

  /** A cable through points: `radial` sides, per-ring radius max(real, 0.28 px), capped. */
  cable(pts: Vector3[], real: number, radial: number, cell: CellKey, zigzag = false, cap = 0.03): void {
    const n = pts.length;
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const r = this.E.rect(cell);
    const T = new Vector3();
    const N = new Vector3();
    const B = new Vector3();
    const d = new Vector3();
    for (let i = 0; i < n; i++) {
      T.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
      N.crossVectors(T, Math.abs(T.y) > 0.95 ? new Vector3(1, 0, 0) : UP).normalize();
      B.crossVectors(N, T).normalize();
      const rad = Math.max(real, Math.min(cap, 0.28 * this.pixel(pts[i])));
      const fu = zigzag ? i % 2 : i / (n - 1);
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2 + Math.PI / 2;
        d.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
        pos.push(pts[i].x + d.x * rad, pts[i].y + d.y * rad, pts[i].z + d.z * rad);
        nor.push(d.x, d.y, d.z);
        uv.push(r.u0 + fu * (r.u1 - r.u0), r.v0 + (j / radial) * (r.v1 - r.v0));
      }
    }
    const ring = radial + 1;
    for (let i = 0; i < n - 1; i++)
      for (let j = 0; j < radial; j++) {
        const a = i * ring + j;
        idx.push(a, a + ring, a + 1, a + 1, a + ring, a + ring + 1);
      }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(nor, 3));
    g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.geos.push(g);
  }

  /** A sagging span from a to b (parabola, sag at mid-span). */
  span(a: Vector3, b: Vector3, sag: number, real: number, cell: CellKey = "cable", radial = 3, step = 2.2): void {
    const len = a.distanceTo(b);
    const n = Math.max(4, Math.min(22, Math.ceil(len / step)));
    const pts: Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(cablePoint(a, b, sag, t));
    }
    this.cable(pts, real, radial, cell);
  }
}

// ------------------------------------------------------------- poles

type Put = (g: BufferGeometry, cell: CellKey, cast?: boolean) => void;

interface PoleSpec {
  x: number;
  z: number;
  /** Ground height at the foot; the shaft runs 0.8 m below it so terrain edits never float it. */
  ground: number;
  /** Height of the top above the ground. */
  h: number;
  kind: "concrete" | "steel";
  /** Crossarm direction (radians about y; 0 = along x). */
  arm?: number;
  hv?: boolean;
  lv?: boolean;
  tel?: boolean;
  /** Side the transformer hangs on (radians), if any. */
  transformer?: number;
  /** Side the tag and step bolts face (radians). */
  face?: number;
}

class Pole {
  readonly top: number;
  readonly c: Vector3;
  readonly along: Vector3;
  constructor(readonly s: PoleSpec) {
    this.top = s.ground + s.h;
    this.c = new Vector3(s.x, 0, s.z);
    const a = s.arm ?? 0;
    this.along = new Vector3(Math.cos(a), 0, -Math.sin(a));
  }
  at(y: number, along = 0, side = 0): Vector3 {
    const perp = new Vector3(-this.along.z, 0, this.along.x);
    return this.c.clone().setY(y).addScaledVector(this.along, along).addScaledVector(perp, side);
  }
  /** Wire attachment points for a line kind. */
  points(kind: "hv" | "lv" | "tel"): Vector3[] {
    if (kind === "hv") return [-0.78, 0, 0.78].map((o) => this.at(this.top - 0.35 + 0.17, o));
    if (kind === "lv") return [-0.36, 0, 0.36].map((o) => this.at(this.top - 1.95 + 0.09, o));
    return [this.at(this.top - 3.55, 0.28), this.at(this.top - 3.9, 0.28)];
  }
  radius(y: number): number {
    const f = (y - (this.s.ground - 0.8)) / (this.top - (this.s.ground - 0.8));
    const [r0, r1] = this.s.kind === "concrete" ? [0.175, 0.095] : [0.11, 0.09];
    return r0 + (r1 - r0) * f;
  }
}

/** Pin insulator (porcelain), base at the origin. */
function pinInsulator(): BufferGeometry {
  const prof = [
    [0.018, 0],
    [0.05, 0.02],
    [0.066, 0.05],
    [0.034, 0.062],
    [0.056, 0.092],
    [0.03, 0.104],
    [0.04, 0.132],
    [0.012, 0.16],
  ].map(([r, y]) => new Vector2(r, y));
  return new LatheGeometry(prof, 6);
}

function buildPole(put: Put, p: Pole): void {
  const s = p.s;
  const y0 = s.ground - 0.8;
  const H = p.top - y0;
  const shaft = new CylinderGeometry(p.radius(p.top), p.radius(y0), H, s.kind === "concrete" ? 12 : 10, 1, true);
  shaft.translate(s.x, y0 + H / 2, s.z);
  put(shaft, s.kind === "concrete" ? "concrete" : "brownSteel");
  const cap = new SphereGeometry(p.radius(p.top) * 1.05, 10, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  put(cap.translate(s.x, p.top, s.z), s.kind === "concrete" ? "concrete" : "brownSteel", false);
  const box = (l: number, t: number, at: Vector3, cell: CellKey, cast = true) => {
    const g = new BoxGeometry(l, t, t);
    g.rotateY(Math.atan2(-p.along.z, p.along.x));
    put(g.translate(at.x, at.y, at.z), cell, cast);
  };
  if (s.hv) {
    const y = p.top - 0.35;
    box(1.9, 0.065, p.at(y, 0, 0.12), "galv");
    for (const o of [-0.6, 0.6]) put(rod(p.at(y - 0.02, o, 0.12), p.at(y - 0.5, 0, 0.1), 0.014, 4), "galv", false);
    for (const q of p.points("hv")) {
      const ins = pinInsulator();
      put(ins.translate(q.x, q.y - 0.17, q.z + 0), "porcelain", false);
    }
  }
  if (s.lv) {
    const y = p.top - 1.95;
    box(0.95, 0.05, p.at(y, 0, 0.1), "galv");
    for (const q of p.points("lv")) put(new CylinderGeometry(0.03, 0.035, 0.09, 6).translate(q.x, q.y - 0.045, q.z), "porcelain", false);
  }
  if (s.tel) {
    for (const q of p.points("tel")) {
      put(rod(p.c.clone().setY(q.y), q, 0.016, 4), "galv", false);
      put(new BoxGeometry(0.07, 0.09, 0.07).translate(q.x, q.y, q.z), "black", false);
    }
  }
  if (s.transformer !== undefined) {
    const dir = new Vector3(Math.cos(s.transformer), 0, -Math.sin(s.transformer));
    const tc = p.c.clone().setY(p.top - 3.0).addScaledVector(dir, 0.5);
    put(new CylinderGeometry(0.25, 0.25, 0.85, 14).translate(tc.x, tc.y, tc.z), "transformer");
    put(new CylinderGeometry(0.26, 0.26, 0.05, 14).translate(tc.x, tc.y + 0.45, tc.z), "transformer");
    for (const dy of [0.25, -0.25]) put(rod(p.c.clone().setY(tc.y + dy), tc.clone().setY(tc.y + dy).addScaledVector(dir, -0.22), 0.022, 4), "galv", false);
    for (const o of [-0.12, 0.12]) {
      const b = tc.clone().setY(tc.y + 0.47).add(new Vector3(-dir.z * o, 0, dir.x * o));
      put(new CylinderGeometry(0.02, 0.035, 0.14, 6).translate(b.x, b.y + 0.07, b.z), "porcelain", false);
    }
    // Cut-out switches under the crossarm.
    for (const o of [-0.3, 0.3]) put(new BoxGeometry(0.08, 0.22, 0.08).translate(...p.at(p.top - 1.15, o, 0.22).toArray()), "porcelain", false);
  }
  // Step bolts on two sides from 2.4 m up (concrete poles), a tag at 1.8 m.
  const face = s.face ?? 0;
  for (let y = s.ground + 2.4, i = 0; s.kind === "concrete" && y < p.top - 0.9; y += 0.45, i++) {
    const a = face + (i % 2 ? Math.PI / 2 : -Math.PI / 2);
    const d = new Vector3(Math.cos(a), 0, -Math.sin(a));
    const r = p.radius(y);
    put(rod(p.c.clone().setY(y).addScaledVector(d, r * 0.8), p.c.clone().setY(y + 0.02).addScaledVector(d, r + 0.17), 0.011, 4), "galv", false);
  }
  if (s.kind === "concrete") {
    const d = new Vector3(Math.cos(face), 0, -Math.sin(face));
    const tag = new PlaneGeometry(0.1, 0.3);
    tag.rotateY(Math.atan2(d.x, d.z));
    const tp = p.c.clone().setY(s.ground + 1.85).addScaledVector(d, p.radius(s.ground + 1.85) + 0.006);
    put(tag.translate(tp.x, tp.y, tp.z), "poleTag", false);
  }
}

// ------------------------------------------------------------- build

export function buildWires(w: KamakuraWorld): void {
  const E = w.equip;
  const bag = new Bag();
  const put: Put = (g, cell, cast = true) => bag.add(E.material, E.map(g, cell), cast);
  const W = new Wires(E);

  // ------------------------------------------------------------ distribution poles
  const hill = (x: number, z: number) => Math.max(0.05, hillY(x, z));
  const slopeSide = (x: number, n: number) => Math.max(slopeY(n) + 0.15, hillY(x, -n));
  const P = {
    // North-east corner at the foot of the rock wall: angle pole, also holds the overhead line's span wire.
    e1: new Pole({ x: 7.8, z: -3.65, ground: 0.25, h: 10.6, kind: "concrete", arm: -1.23, hv: true, lv: true, tel: true, face: Math.PI }),
    // North-west: behind the equipment fence, transformer facing the road.
    w1: new Pole({ x: -6.5, z: -8.9, ground: 0.3, h: 10.9, kind: "concrete", arm: 0.02, hv: true, lv: true, tel: true, transformer: 0, face: 0 }),
    // North-west corner: brown steel pole carrying the twisted cable and telecom west.
    w2: new Pole({ x: -5.45, z: -4.9, ground: 0.06, h: 7.2, kind: "steel", arm: 0.1, tel: true }),
    e2: new Pole({ x: 7.0, z: -23.5, ground: hill(7.0, -23.5), h: 10.8, kind: "concrete", arm: 0.05, hv: true, lv: true, tel: true, face: Math.PI / 2 + 0.6 }),
    w3: new Pole({ x: -7.9, z: -38, ground: slopeSide(-7.9, 38), h: 10.8, kind: "concrete", arm: 0.03, hv: true, lv: true, tel: true, transformer: Math.PI, face: 0 }),
    w4: new Pole({ x: -8.9, z: -72, ground: slopeSide(-8.9, 72), h: 10.8, kind: "concrete", arm: 0.06, hv: true, lv: true, tel: true, face: 0 }),
    e3: new Pole({ x: 4.9, z: -98, ground: hill(4.9, -98), h: 10.5, kind: "concrete", arm: 0.06, hv: true, lv: true, tel: true, face: Math.PI }),
    w5: new Pole({ x: -40, z: -9.8, ground: hill(-40, -9.8), h: 10.5, kind: "concrete", arm: 1.45, hv: true, lv: true, tel: true, face: -Math.PI / 2 }),
  };
  for (const p of Object.values(P)) buildPole(put, p);

  /** Joins matching attachment points of two poles without crossing the wires. */
  const line = (a: Pole, b: Pole, kind: "hv" | "lv" | "tel", sag: number, real: number) => {
    const pa = a.points(kind);
    const pb = b.points(kind);
    const d = new Vector3().subVectors(b.c, a.c);
    const perp = new Vector3(-d.z, 0, d.x).normalize();
    const key = (q: Vector3) => q.dot(perp) + q.y * 0.01;
    pa.sort((x, y) => key(x) - key(y));
    pb.sort((x, y) => key(x) - key(y));
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) W.span(pa[i], pb[i], sag * (1 + i * 0.04), real);
  };
  const spans: [Pole, Pole, number][] = [
    [P.e1, P.w1, 0.55],
    [P.e1, P.e2, 0.75],
    [P.w1, P.w3, 0.85],
    [P.w3, P.w4, 1.0],
    [P.e2, P.e3, 1.3],
    [P.w1, P.w5, 1.0],
  ];
  for (const [a, b, sag] of spans) {
    line(a, b, "hv", sag, 0.009);
    line(a, b, "lv", sag * 1.25, 0.008);
    line(a, b, "tel", sag * 1.4, 0.012);
  }
  // Telecom from the brown pole west along the footway, and a drop to the north-west pole.
  line(P.w2, P.w5, "tel", 1.1, 0.012);
  line(P.w2, P.w1, "tel", 0.25, 0.011);
  // Service drops from the north-east pole to the villa above the crossing.
  for (const [dy, o] of [
    [0, 0],
    [-0.3, 0.25],
  ])
    W.span(P.e1.at(P.e1.top - 4.4 + dy, 0.3), new Vector3(16.5, 9.2 + dy, -7.8 + o), 0.5, 0.008);

  // The thick black twisted cable: north-east pole → brown pole (lowest ~4.6 m over the road) → north-west pole, then down it.
  {
    const a = P.e1.at(5.15, 0, 0).add(new Vector3(-0.2, 0, 0));
    const b = P.w2.at(5.05).add(new Vector3(0.13, 0, 0));
    const c = P.w1.at(4.35).add(new Vector3(0.2, 0, 0.05));
    const run = (p: Vector3, q: Vector3, sag: number, segLen: number) => {
      const n = Math.max(6, Math.round(p.distanceTo(q) / segLen));
      const pts: Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push(cablePoint(p, q, sag, t));
      }
      return pts;
    };
    W.cable(run(a, b, 0.5, 0.3), 0.04, 6, "twisted", true, 0.07);
    W.cable(run(b, c, 0.25, 0.3), 0.038, 6, "twisted", true, 0.07);
    // A loop where it turns at the brown pole, the riser down the north-west pole into a conduit.
    W.cable([b.clone(), b.clone().add(new Vector3(0.1, -0.35, 0.05)), b.clone().add(new Vector3(-0.05, -0.55, 0.12)), b.clone().add(new Vector3(-0.2, -0.3, 0.1)), b.clone().add(new Vector3(-0.15, 0, 0.04))], 0.03, 6, "cable", false, 0.05);
    const riser = P.w1.c.clone().add(new Vector3(0.21, 0, 0.05));
    W.cable([c, riser.clone().setY(3.9), riser.clone().setY(0.3)], 0.028, 6, "cable", false, 0.04);
    put(rod(riser.clone().setY(0.25), riser.clone().setY(2.6), 0.045, 8), "greyPaint");
    for (const y of [0.8, 1.6, 2.4]) put(new BoxGeometry(0.06, 0.04, 0.06).translate(riser.x, y, riser.z), "galv", false);
  }

  // ------------------------------------------------------------ Enoden overhead line
  const south = (u: number, s = 2.35) => TRACK.offset(u, s, new Vector3());
  const normalAt = (u: number) => {
    const t = TRACK.tangent(u, new Vector3());
    return new Vector3(-t.z, 0, t.x);
  };
  const MESS = CATENARY.messenger;
  const CONT = CATENARY.contact;
  const SOUTH_POLES = [-219, -184, -149, -114, -79, -44, -9, 5.5, 42, 77, 112, 147, 182, 217, 252, 287];
  const supports: { u: number; mess: Vector3; cont: Vector3 }[] = [];
  const feeders: Vector3[][] = [[], []];
  let stagger = 1;
  for (const u of SOUTH_POLES) {
    const n = normalAt(u);
    const base = south(u, u === 5.5 ? 2.6 : 2.35);
    const top = 7.15;
    const pole = new Pole({ x: base.x, z: base.z, ground: 0.0, h: top, kind: "steel" });
    buildPole(put, pole);
    // Feeder brackets toward the track at 6.75 and 6.15 m with an insulator at each end.
    [6.75, 6.15].forEach((y, k) => {
      const end = base.clone().setY(y).addScaledVector(n, -0.42);
      put(rod(base.clone().setY(y), end, 0.022, 5), "brownSteel", false);
      put(new CylinderGeometry(0.035, 0.05, 0.16, 6).translate(end.x, end.y - 0.08, end.z), "porcelain", false);
      feeders[k].push(end.clone().setY(y - 0.17));
    });
    const centre = TRACK.point(u, new Vector3());
    if (u === 5.5) {
      // South-east pole: a short diagonal arm toward the crossing holding the span wire.
      const tip = base.clone().setY(6.45).addScaledVector(n, -1.1).add(new Vector3(0.5, 0, 0));
      put(tube([base.clone().setY(6.6), base.clone().setY(6.5).addScaledVector(n, -0.3), tip], 0.03, 6, 10), "brownSteel");
      put(rod(base.clone().setY(7.0), tip.clone().addScaledVector(n, 0.35).setY(6.48), 0.016, 4), "brownSteel", false);
      continue;
    }
    // Bent-pipe cantilever with a stay; hanger to the messenger, steady arm to the contact wire.
    const reach = base.distanceTo(centre.clone().setY(0)) + 0.3;
    const p0 = base.clone().setY(5.98);
    const p1 = base.clone().setY(5.86).addScaledVector(n, -0.35);
    const p2 = base.clone().setY(5.78).addScaledVector(n, -reach);
    put(tube([p0, p1, p2], 0.03, 6, 6), "brownSteel");
    put(rod(base.clone().setY(6.95), base.clone().setY(5.82).addScaledVector(n, -reach * 0.62), 0.016, 4), "brownSteel", false);
    put(pinInsulator().rotateZ(Math.PI / 2).translate(...p1.toArray()), "porcelain", false);
    const off = 0.2 * stagger;
    stagger = -stagger;
    const mess = centre.clone().setY(MESS);
    const cont = centre.clone().addScaledVector(n, off).setY(CONT);
    put(rod(mess.clone().setY(5.78), mess, 0.012, 4), "galv", false);
    put(rod(mess.clone().setY(5.55).addScaledVector(n, 0.1), cont, 0.012, 4), "galv", false);
    supports.push({ u, mess, cont });
  }
  // The span support over the crossing: span wire from the north-east pole to the south-east arm.
  {
    const a = P.e1.at(6.45).addScaledVector(normalAt(7), 0.18);
    const se = south(5.5, 2.6);
    const b = se.clone().setY(6.45).addScaledVector(normalAt(5.5), -1.1).add(new Vector3(0.5, 0, 0));
    put(new BoxGeometry(0.4, 0.06, 0.06).translate(a.x, a.y, a.z - 0.1), "galv");
    W.span(a, b, 0.12, 0.007, "cable", 3, 1.5);
    // Where the span crosses the track centreline.
    const uc = TRACK.project((a.x + b.x) / 2, (a.z + b.z) / 2);
    const c = TRACK.point(uc, new Vector3());
    const t = (c.x - a.x) / (b.x - a.x || 1);
    const ys = a.y + (b.y - a.y) * t - 0.12 * 4 * t * (1 - t);
    const mess = c.clone().setY(MESS);
    const cont = c.clone().addScaledVector(normalAt(uc), 0.2 * stagger).setY(CONT);
    put(rod(c.clone().setY(ys), mess, 0.012, 4), "galv", false);
    put(rod(mess.clone().setY(5.55), cont, 0.012, 4), "galv", false);
    supports.push({ u: uc, mess, cont });
    supports.sort((p, q) => p.u - q.u);
  }
  for (let i = 0; i < supports.length - 1; i++) {
    const A = supports[i];
    const B = supports[i + 1];
    const len = A.mess.distanceTo(B.mess);
    const sag = 0.06 + len * 0.004;
    W.span(A.mess, B.mess, sag, 0.006, "cable", 3, 3.5);
    W.span(A.cont, B.cont, 0.01, 0.0065, "cable", 3, 4);
    const k = Math.max(1, Math.round(len / 5));
    for (let j = 1; j < k; j++) {
      const f = j / k;
      const top = cablePoint(A.mess, B.mess, sag, f);
      const bot = new Vector3().lerpVectors(A.cont, B.cont, f);
      W.cable([top, bot], 0.003, 3, "galv", false, 0.012);
    }
  }
  for (const f of feeders) for (let i = 0; i < f.length - 1; i++) W.span(f[i], f[i + 1], 0.32 + f[i].distanceTo(f[i + 1]) * 0.006, 0.018, "twisted", 4, 3.5);

  bag.emit(w);
  const mesh = w.mesh(merge(W.geos, { index: true }), E.material, 0, 0, 0, w.root, { cast: false, receive: false });
  mesh.name = "overhead-wires";
}
