import { BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, PlaneGeometry, ShapeUtils, Vector2, Vector3 } from "three";
import { Rng } from "../../../core/random";
import { mapUV } from "../../shared/atlas";
import { merge } from "../../shared/shapes";
import { FACADE, facadeTexture, leafTexture } from "../gfx/art";
import { Bag, type KamakuraWorld } from "./context";
import { BUILDINGS } from "./data";
import { COAST, slopeEdges, slopeY, TRACK } from "./layout";
import { hillY } from "./terrain";

/**
 * The houses on the hillside, from PLATEAU footprints, ground levels and
 * heights: walls in one facade atlas (window bays, three wall styles, the
 * roof and plinth bands), flat or gabled roofs, plinths down to the ground
 * where a lot sits on a slope. The villas on the terraces just north-east of
 * the crossing add what the photographs show close up: the cream round
 * tower with the stacked-stone column, glass balustrades along the wall
 * tops, palms and cycads in the gardens.
 */

/** Wall tints (× the facade atlas): white, warm white, cream, beige, light grey, pale terracotta, blue-grey. */
const WALLS: [number, number, number][] = [
  [1, 1, 1],
  [1, 0.97, 0.92],
  [1, 0.93, 0.8],
  [0.88, 0.8, 0.68],
  [0.84, 0.85, 0.86],
  [0.95, 0.82, 0.72],
  [0.8, 0.86, 0.9],
];
/** Roof tints (× the light roof band): dark grey, brown, terracotta, blue-grey. */
const ROOFS: [number, number, number][] = [
  [0.45, 0.46, 0.48],
  [0.55, 0.4, 0.3],
  [0.75, 0.42, 0.3],
  [0.42, 0.5, 0.6],
  [0.62, 0.62, 0.6],
];

/** Signed area of a ring in (x, z): positive = counter-clockwise in the x–z plane (clockwise seen from above). */
function area(ring: number[]): number {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  return a / 2;
}

export function buildBuildings(w: KamakuraWorld): void {
  const tex = facadeTexture();
  const facade = w.lib.facade(tex);
  const r = new Rng(2026);
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  let tintNow: [number, number, number] = [1, 1, 1];
  const tri = (a: number[], b: number[], c: number[], ua: number[], ub: number[], uc: number[]) => {
    pos.push(...a, ...b, ...c);
    uv.push(...ua, ...ub, ...uc);
    col.push(...tintNow, ...tintNow, ...tintNow);
  };
  const vWall = (style: number, floors: number) => (1 + 5 * style + floors) / 16;
  /** A triangle turned to face `out` (a direction, or up for roofs). */
  const triOut = (a: number[], b: number[], c: number[], ua: number[], ub: number[], uc: number[], out: Vector3) => {
    const e1 = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const e2 = new Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    if (e1.cross(e2).dot(out) >= 0) tri(a, b, c, ua, ub, uc);
    else tri(a, c, b, ua, uc, ub);
  };

  for (const [base, height, storeys, use, ring0] of BUILDINGS) {
    // Walls run counter-clockwise seen from above so they face outward.
    const ring = area(ring0) > 0 ? reverse(ring0) : ring0;
    const n = ring.length / 2;
    if (n < 3) continue;
    let north = 0;
    for (let i = 0; i < n; i++) north -= ring[i * 2 + 1] / n;
    // Villas with picture windows along the coast, houses and apartments up the hill.
    const style = use === 1 || use === 3 ? 2 : north < 45 ? (r.chance(0.8) ? 0 : 1) : r.chance(0.4) ? 0 : 1;
    const wallTint = use === 3 ? WALLS[r.pick([0, 4, 6])] : r.pick(WALLS);
    const roofTint = r.pick(ROOFS);
    const shift = r.next();
    const h = Math.max(2.8, height);
    const st = storeys > 0 ? storeys : Math.max(1, Math.round(h / 3));
    const floorH = Math.max(h / 5, Math.min(3.4, Math.max(2.6, (h - 0.5) / st)));
    let ground = Infinity;
    for (let i = 0; i < n; i++) ground = Math.min(ground, hillY(ring[i * 2], ring[i * 2 + 1]));
    const yb = Math.min(base - 0.3, ground - 0.4);
    const top = base + h;
    let per = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2];
      const az = ring[i * 2 + 1];
      const bx = ring[j * 2];
      const bz = ring[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const u0 = per / FACADE.bay + shift;
      const u1 = (per + len) / FACADE.bay + shift;
      per += len;
      // Plinth.
      tintNow = [0.85, 0.85, 0.84];
      const vp = FACADE.plinth;
      tri([ax, yb, az], [bx, yb, bz], [bx, base, bz], [u0, vp], [u1, vp], [u1, vp]);
      tri([ax, yb, az], [bx, base, bz], [ax, base, az], [u0, vp], [u1, vp], [u0, vp]);
      // Facade.
      tintNow = wallTint;
      const v0 = vWall(style, 0) + 0.002;
      const v1 = vWall(style, Math.min(5, h / floorH)) - 0.002;
      tri([ax, base, az], [bx, base, bz], [bx, top, bz], [u0, v0], [u1, v0], [u1, v1]);
      tri([ax, base, az], [bx, top, bz], [ax, top, az], [u0, v0], [u1, v1], [u0, v1]);
    }
    // Roof: gabled on small rectangular houses, flat elsewhere.
    tintNow = roofTint;
    const vr = FACADE.roof;
    if (n === 4 && use === 0 && h < 10 && r.chance(0.45)) {
      const P = [0, 1, 2, 3].map((i) => new Vector3(ring[i * 2], top, ring[i * 2 + 1]));
      const l01 = P[0].distanceTo(P[1]);
      const l12 = P[1].distanceTo(P[2]);
      // Ridge across the short ends.
      const [a, b, c, d] = l01 < l12 ? [P[0], P[1], P[2], P[3]] : [P[1], P[2], P[3], P[0]];
      const m0 = a.clone().add(b).multiplyScalar(0.5).setY(top + 1.3);
      const m1 = c.clone().add(d).multiplyScalar(0.5).setY(top + 1.3);
      const q = (p: Vector3) => [p.x, p.y, p.z];
      const ru = (p: Vector3) => [(p.x + p.z) / 4, vr];
      const UP = new Vector3(0, 1, 0);
      triOut(q(b), q(c), q(m1), ru(b), ru(c), ru(m1), UP);
      triOut(q(b), q(m1), q(m0), ru(b), ru(m1), ru(m0), UP);
      triOut(q(d), q(a), q(m0), ru(d), ru(a), ru(m0), UP);
      triOut(q(d), q(m0), q(m1), ru(d), ru(m0), ru(m1), UP);
      const vg = vWall(style, Math.min(4.9, h / floorH));
      const mid = a.clone().add(c).multiplyScalar(0.5);
      triOut(q(a), q(b), q(m0), [0, vg], [0.2, vg], [0.1, vg], m0.clone().sub(mid).setY(0));
      triOut(q(c), q(d), q(m1), [0, vg], [0.2, vg], [0.1, vg], m1.clone().sub(mid).setY(0));
    } else {
      const pts: Vector2[] = [];
      for (let i = 0; i < n; i++) pts.push(new Vector2(ring[i * 2], ring[i * 2 + 1]));
      const tris = ShapeUtils.triangulateShape(pts, []);
      for (const t of tris) {
        const [a, b, c] = t.map((i) => pts[i]);
        const up = (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y) > 0;
        const order = up ? [a, b, c] : [a, c, b];
        tri(
          [order[0].x, top, order[0].y],
          [order[1].x, top, order[1].y],
          [order[2].x, top, order[2].y],
          [order[0].x / 6, vr],
          [order[1].x / 6, vr],
          [order[2].x / 6, vr],
        );
      }
    }
  }
  // Beyond PLATEAU's ±250 m: rows of two-storey houses along the coast, which also hide the
  // track where it bends inland toward Shichirigahama.
  const box = (cx: number, cz: number, wid: number, dep: number, yaw: number, h: number) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const ring: number[] = [];
    for (const [a, b] of [
      [-wid / 2, -dep / 2],
      [-wid / 2, dep / 2],
      [wid / 2, dep / 2],
      [wid / 2, -dep / 2],
    ])
      ring.push(cx + a * c + b * s, cz - a * s + b * c);
    return { ring, h };
  };
  const extra: { ring: number[]; h: number }[] = [];
  const pt = new Vector3();
  const nearTrack = (x: number, z: number) => {
    const u = TRACK.project(x, z);
    return TRACK.point(u, pt).distanceTo(new Vector3(x, pt.y, z)) < 9;
  };
  for (const [u0, u1, rows] of [
    [262, 780, [-9, -22, -36]],
    [-600, -232, [-10, -23]],
  ] as [number, number, number[]][]) {
    for (let u = u0; u < u1; u += r.range(13, 18))
      for (const s of rows) {
        const p = COAST.offset(u, s + r.range(-2, 2), new Vector3());
        if (nearTrack(p.x, p.z)) continue;
        const t = COAST.tangent(u, new Vector3());
        extra.push(box(p.x, p.z, r.range(8, 12), r.range(7, 10), Math.atan2(t.z, t.x) * -1, r.range(6, 9)));
      }
  }
  for (const e of extra) {
    let ground = Infinity;
    for (let i = 0; i < 4; i++) ground = Math.min(ground, hillY(e.ring[i * 2], e.ring[i * 2 + 1]));
    const base = ground + 0.3;
    const style = r.chance(0.7) ? 0 : 1;
    tintNow = r.pick(WALLS);
    const top = base + e.h;
    let per = r.next() * FACADE.bay;
    const ring = area(e.ring) > 0 ? reverse(e.ring) : e.ring;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const [ax, az, bx, bz] = [ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1]];
      const len = Math.hypot(bx - ax, bz - az);
      const u0 = per / FACADE.bay;
      const u1 = (per + len) / FACADE.bay;
      per += len;
      const v0 = vWall(style, 0) + 0.002;
      const v1 = vWall(style, e.h / 2.9) - 0.002;
      tri([ax, ground - 0.4, az], [bx, ground - 0.4, bz], [bx, top, bz], [u0, v0], [u1, v0], [u1, v1]);
      tri([ax, ground - 0.4, az], [bx, top, bz], [ax, top, az], [u0, v0], [u1, v1], [u0, v1]);
    }
    tintNow = r.pick(ROOFS);
    const P = [0, 1, 2, 3].map((i) => [ring[i * 2], top, ring[i * 2 + 1]]);
    const ru = (p: number[]) => [(p[0] + p[2]) / 4, FACADE.roof];
    triOut(P[0], P[1], P[2], ru(P[0]), ru(P[1]), ru(P[2]), new Vector3(0, 1, 0));
    triOut(P[0], P[2], P[3], ru(P[0]), ru(P[2]), ru(P[3]), new Vector3(0, 1, 0));
  }

  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const houses = w.mesh(g, facade, 0, 0, 0, w.root, { cast: true });
  // Kept out of batching, which drops vertex colours; nothing animates it, so it cooks as static.
  houses.userData.dynamic = true;
  houses.name = "hillside-houses";

  villas(w);
}

function reverse(ring: number[]): number[] {
  const out: number[] = [];
  for (let i = ring.length / 2 - 1; i >= 0; i--) out.push(ring[i * 2], ring[i * 2 + 1]);
  return out;
}

/**
 * Close-up details of the villas above the crossing: the round tower and
 * stacked-stone column of the villa at the corner, glass balustrades on the
 * wall tops along the slope road and the track, palms and cycads.
 */
function villas(w: KamakuraWorld): void {
  const lib = w.lib;
  const bag = new Bag();
  // Round tower villa (PLATEAU 19.6, 8.3 N; ground 14.2 m T.P.).
  const base = 4.0;
  const tower = new CylinderGeometry(2.3, 2.3, 9.4, 20, 1, true);
  tower.translate(21.8, base + 4.7, -6.1);
  bag.add(lib.stucco("cream"), tower);
  const cap = new CylinderGeometry(2.45, 2.45, 0.25, 20);
  cap.translate(21.8, base + 9.5, -6.1);
  bag.add(lib.stucco("white"), cap);
  // Tower windows: tall dark panes around the seaward half.
  const panes: BufferGeometry[] = [];
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI * 0.15 + k * 0.42;
    for (const y of [base + 2.0, base + 5.2]) {
      const p = new PlaneGeometry(0.9, 1.6);
      p.translate(0, 0, 2.31);
      p.rotateY(a);
      p.translate(21.8, y, -6.1);
      panes.push(p);
    }
  }
  bag.add(lib.glass(), merge(panes), false);
  // Stacked-stone column beside it.
  const col = new BoxGeometry(1.3, 9.8, 1.1);
  col.translate(18.9, base + 4.9, -5.2);
  bag.add(lib.stoneClad(), col);

  // Glass balustrades: along the east wall top of the slope road (3–22 m north) and the track wall (8–62 m east).
  const glass = lib.glassRail();
  const rails: BufferGeometry[] = [];
  const pane = (a: Vector3, b: Vector3) => {
    const len = a.distanceTo(b);
    const g = new PlaneGeometry(len, 1.05);
    g.rotateY(-Math.atan2(b.z - a.z, b.x - a.x));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.55, (a.z + b.z) / 2);
    rails.push(g);
  };
  for (let n = 3.5; n < 21; n += 2.5) {
    const [, e0] = slopeEdges(n);
    const [, e1] = slopeEdges(n + 2.5);
    const a = new Vector3(e0 + 0.6, 0, -n);
    const b = new Vector3(e1 + 0.6, 0, -(n + 2.5));
    a.y = Math.max(hillY(a.x, a.z), slopeY(n) + 2);
    b.y = Math.max(hillY(b.x, b.z), slopeY(n + 2.5) + 2);
    pane(a, b);
  }
  for (let u = 9; u < 62; u += 3) {
    const a = COAST.offset(u, -3.6, new Vector3());
    const b = COAST.offset(u + 3, -3.6, new Vector3());
    a.y = hillY(a.x, a.z);
    b.y = hillY(b.x, b.z);
    pane(a, b);
  }
  bag.add(glass, merge(rails), false);

  // Palms and cycads in the gardens above the walls (leaf cards from one atlas).
  const leaves = lib.cutout("leaves", leafTexture(), { rough: 0.7 });
  const r = new Rng(5);
  const fronds: BufferGeometry[] = [];
  const trunks: BufferGeometry[] = [];
  const cell = (i: number) => ({ u0: (i % 2) * 0.5, u1: (i % 2) * 0.5 + 0.5, v0: i < 2 ? 0.5 : 0, v1: i < 2 ? 1 : 0.5 });
  const plant = (x: number, z: number, kind: "palm" | "cycad" | "bush") => {
    const y = hillY(x, z);
    if (kind === "palm") {
      const h = r.range(5, 8);
      trunks.push(new CylinderGeometry(0.14, 0.2, h, 6, 1, true).translate(x, y + h / 2, z));
      for (let k = 0; k < 7; k++) {
        const g = mapUV(new PlaneGeometry(2.2, 2.2), cell(1));
        g.rotateX(-0.6);
        g.translate(0, 0.2, 1.0);
        g.rotateY((k / 7) * Math.PI * 2 + r.next());
        g.translate(x, y + h, z);
        fronds.push(g);
      }
    } else if (kind === "cycad") {
      for (let k = 0; k < 6; k++) {
        const g = mapUV(new PlaneGeometry(1.4, 1.6), cell(2));
        g.rotateX(-0.9);
        g.translate(0, 0.6, 0.6);
        g.rotateY((k / 6) * Math.PI * 2 + r.next());
        g.translate(x, y, z);
        fronds.push(g);
      }
    } else {
      for (let k = 0; k < 3; k++) {
        const s = r.range(1.4, 2.2);
        const g = mapUV(new PlaneGeometry(s, s), cell(0));
        g.translate(0, s / 2, 0);
        g.rotateY((k / 3) * Math.PI + r.next() * 0.3);
        g.translate(x, y, z);
        fronds.push(g);
      }
    }
  };
  for (const [x, n, k] of [
    [8.5, 5, "cycad"],
    [8.8, 9, "bush"],
    [9.2, 13, "cycad"],
    [8.6, 17, "bush"],
    [9.6, 20.5, "palm"],
    [14, 3.5, "palm"],
    [27, 3.8, "palm"],
    [33, 4.2, "bush"],
    [44, 3.0, "palm"],
    [52, 2.0, "bush"],
    [8.0, 34, "bush"],
    [9.0, 38, "cycad"],
    [10, 44, "bush"],
    [-14, 22, "palm"],
    [-25, 21, "palm"],
    [-9, 14, "bush"],
  ] as [number, number, "palm" | "cycad" | "bush"][])
    plant(x, -n, k);
  // Grass and shrub tufts along the east wall tops (the bank in the canonical view).
  for (let n = 30; n < 62; n += 2.2) {
    const [, e] = slopeEdges(n);
    plant(e + 1.0 + r.range(0, 1.5), -n, "bush");
  }
  bag.add(leaves, merge(fronds), false);
  bag.add(w.printed, w.tint(merge(trunks), "wood"));
  bag.emit(w);
}
