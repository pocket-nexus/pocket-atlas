import { BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, PlaneGeometry, ShapeUtils, Vector2, Vector3 } from "three";
import { Rng } from "../../../core/random";
import { mapUV } from "../../shared/atlas";
import { merge } from "../../shared/shapes";
import { BAND, FACADE2 as FACADE, facadeAtlas, rowV } from "../gfx/facade";
import * as SURF from "../gfx/surfaces";
import { Bag, type KamakuraWorld } from "./context";
import { BUILDINGS } from "./data";
import { eastKerb, terraceY, TRIANGLE, triangleLift, WALK, wallTop } from "./ground";
import { COAST, slopeY, TRACK } from "./layout";
import { Greenery } from "./plants";
import { hillY } from "./terrain";
import { place } from "./util";

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
  const tex = facadeAtlas(w.lib);
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
  /** One wall from y0 to y1 as a quad per storey (ground row, then upper rows). */
  const wallStoreys = (ax: number, az: number, bx: number, bz: number, y0: number, y1: number, u0: number, u1: number, style: number, floorH: number) => {
    for (let f = 0, y = y0; y < y1 - 0.05; f++, y += floorH) {
      const ya = y;
      const yb = Math.min(y1, y + floorH);
      const [va, vb] = rowV(style, f > 0);
      const vt = va + (vb - va) * ((yb - ya) / floorH);
      tri([ax, ya, az], [bx, ya, bz], [bx, yb, bz], [u0, va], [u1, va], [u1, vt]);
      tri([ax, ya, az], [bx, yb, bz], [ax, yb, az], [u0, va], [u1, vt], [u0, vt]);
    }
  };
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
    // Villas with picture windows along the coast, houses, resort villas and apartments up the hill.
    let east = 0;
    for (let i = 0; i < n; i++) east += ring[i * 2] / n;
    // The villas east of the crossing are all white modern boxes (p09).
    const style = use === 1 || use === 3 ? 2 : north < 45 && east > 5 && east < 90 ? 0 : north < 45 ? r.pick([0, 0, 3, 1]) : r.pick([0, 1, 1, 3]);
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
      const vp = BAND.plinth;
      tri([ax, yb, az], [bx, yb, bz], [bx, base, bz], [u0, vp], [u1, vp], [u1, vp]);
      tri([ax, yb, az], [bx, base, bz], [ax, base, az], [u0, vp], [u1, vp], [u0, vp]);
      // Facade.
      tintNow = wallTint;
      wallStoreys(ax, az, bx, bz, base, top, u0, u1, style, floorH);
    }
    // Villas: a balcony slab along each wall facing the sea or the slope road, every floor.
    const plain = BAND.plain;
    const slab = (ax: number, az: number, bx: number, bz: number, y: number, depth: number, thick: number) => {
      const ex = bx - ax;
      const ez = bz - az;
      const len = Math.hypot(ex, ez);
      // Outward normal of a counter-clockwise (from above) ring: (−ez, ex) / len.
      const ox = (-ez / len) * depth;
      const oz = (ex / len) * depth;
      const up = new Vector3(0, 1, 0);
      const outV = new Vector3(ox, 0, oz);
      const A = [ax, y, az];
      const B = [bx, y, bz];
      const C = [bx + ox, y, bz + oz];
      const D = [ax + ox, y, az + oz];
      const lift = (p: number[]) => [p[0], p[1] + thick, p[2]];
      const uvp = [0.1, plain];
      triOut(lift(A), lift(B), lift(C), uvp, uvp, uvp, up);
      triOut(lift(A), lift(C), lift(D), uvp, uvp, uvp, up);
      triOut(D, C, lift(C), uvp, uvp, uvp, outV);
      triOut(D, lift(C), lift(D), uvp, uvp, uvp, outV);
      triOut(A, C, B, uvp, uvp, uvp, up.clone().negate());
      triOut(A, D, C, uvp, uvp, uvp, up.clone().negate());
    };
    if (style === 0 && h > 5.5 && north < 160) {
      tintNow = wallTint;
      const floors = Math.min(4, Math.floor(h / floorH));
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [ax, az, bx, bz] = [ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1]];
        const len = Math.hypot(bx - ax, bz - az);
        // Seaward (south) and west-facing walls longer than 4 m.
        const nx = -(bz - az) / len;
        const nz = (bx - ax) / len;
        if (len < 4 || (nz < 0.5 && nx > -0.7)) continue;
        for (let f = 1; f < floors; f++) slab(ax, az, bx, bz, base + f * floorH - 0.18, 1.0, 0.18);
      }
    }
    // Roof: gabled on small rectangular houses, flat with a parapet elsewhere.
    tintNow = roofTint;
    const vr = BAND.roof;
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
      const vg = BAND.plain;
      const mid = a.clone().add(c).multiplyScalar(0.5);
      triOut(q(a), q(b), q(m0), [0, vg], [0.2, vg], [0.1, vg], m0.clone().sub(mid).setY(0));
      triOut(q(c), q(d), q(m1), [0, vg], [0.2, vg], [0.1, vg], m1.clone().sub(mid).setY(0));
    } else {
      // Parapet: the wall carried 0.45 m above the roof, plain render, with a coping.
      tintNow = wallTint;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [ax, az, bx, bz] = [ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1]];
        const ex = bx - ax;
        const ez = bz - az;
        const outV = new Vector3(-ez, 0, ex);
        const uvp = [0.2, plain];
        triOut([ax, top, az], [bx, top, bz], [bx, top + 0.45, bz], uvp, uvp, uvp, outV);
        triOut([ax, top, az], [bx, top + 0.45, bz], [ax, top + 0.45, az], uvp, uvp, uvp, outV);
        triOut([ax, top + 0.45, az], [bx, top + 0.45, bz], [bx, top, bz], uvp, uvp, uvp, outV.clone().negate());
        triOut([ax, top + 0.45, az], [bx, top, bz], [ax, top, az], uvp, uvp, uvp, outV.clone().negate());
      }
      tintNow = roofTint;
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
    const style = r.pick([0, 1, 1, 3]);
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
      wallStoreys(ax, az, bx, bz, ground - 0.4, top, u0, u1, style, 2.9);
    }
    tintNow = r.pick(ROOFS);
    const P = [0, 1, 2, 3].map((i) => [ring[i * 2], top, ring[i * 2 + 1]]);
    const ru = (p: number[]) => [(p[0] + p[2]) / 4, BAND.roof];
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
  houses.userData.noBatch = true;
  houses.name = "hillside-houses";

  villas(w);
}

function reverse(ring: number[]): number[] {
  const out: number[] = [];
  for (let i = ring.length / 2 - 1; i >= 0; i--) out.push(ring[i * 2], ring[i * 2 + 1]);
  return out;
}

/** Garage shutter: cream steel slats with a bottom rail and a dark slot under the hood. */
function shutter(g: CanvasRenderingContext2D, cw: number, ch: number): void {
  g.fillStyle = "#d9d5c9";
  g.fillRect(0, 0, cw, ch);
  for (let y = 10; y < ch - 8; y += 7) {
    g.fillStyle = "rgba(90,86,78,0.35)";
    g.fillRect(0, y, cw, 1.5);
    g.fillStyle = "rgba(255,255,255,0.35)";
    g.fillRect(0, y + 2, cw, 1);
  }
  g.fillStyle = "#6e6a62";
  g.fillRect(0, 0, cw, 9);
  g.fillStyle = "#8c887e";
  g.fillRect(0, ch - 8, cw, 8);
  g.fillStyle = "rgba(60,50,40,0.18)";
  for (let x = 0; x < cw; x += 3) g.fillRect(x, ch * 0.7, 2, ch * 0.3 * (0.5 + 0.5 * Math.sin(x * 12.9898)));
}

/**
 * Close-up pieces of the villas east of the slope road (p01–p03, p05,
 * p09, p19): the stone-clad garage at the villa wall's north end with its
 * shutter facing the triangle, the block parapet and black steel fence on
 * the wall's coping, the round tower and ledgestone column of the corner
 * villa, glass balustrades along the terraces, and the gardens: cycads,
 * fan palms, broadleaf shrubs and silver grass, on the terrace, the garage
 * roof, the planted triangle and the bank by the junction.
 */
function villas(w: KamakuraWorld): void {
  const lib = w.lib;
  const bag = new Bag();
  const green = new Greenery(5150);
  const r = green.r;
  const clad = lib.stoneClad();
  const ledge = lib.baked("ledgestone", SURF.LEDGE, { size: 512, tile: 1.2, bump: 3, normal: 1.4, ao: 1 });

  // ---- the garage block: west face on the wall top, shutter on its north face (p01, p02).
  const gx0 = wallTop(WALK.to) + 0.55;
  const gx1 = gx0 + 2.6;
  const gn0 = WALK.to - 3.2;
  const gn1 = TRIANGLE.from + 0.4;
  const gy0 = 3.0;
  const gy1 = terraceY(WALK.to) + 0.85;
  bag.add(clad, place(new BoxGeometry(gx1 - gx0, gy1 - gy0, gn1 - gn0), new Vector3((gx0 + gx1) / 2, (gy0 + gy1) / 2, -(gn0 + gn1) / 2)));
  bag.add(lib.concrete(), place(new BoxGeometry(gx1 - gx0 + 0.16, 0.14, gn1 - gn0 + 0.16), new Vector3((gx0 + gx1) / 2, gy1 + 0.07, -(gn0 + gn1) / 2)));
  {
    const cell = w.draw("garage-shutter", 256, 224, shutter);
    const sh = mapUV(new PlaneGeometry(2.4, 2.1), cell);
    sh.rotateY(Math.PI);
    sh.translate(gx0 + 1.55, 3.45 + 1.05, -gn1 - 0.025);
    bag.add(w.printed, sh, false);
    // Hood over the shutter.
    bag.add(w.printed, w.tint(place(new BoxGeometry(2.6, 0.22, 0.2), new Vector3(gx0 + 1.55, 3.45 + 2.2, -gn1 - 0.1)), "beige"));
  }

  // ---- parapet and fence on the villa wall's coping (p19: split-face block, black steel fence).
  const posts: BufferGeometry[] = [];
  for (let n = WALK.from + 0.2; n < gn0; n += 1) {
    const n1 = Math.min(gn0, n + 1);
    const block = n > 15;
    const a = new Vector3(wallTop(n) + 0.12, terraceY(n) + 0.14, -n);
    const b = new Vector3(wallTop(n1) + 0.12, terraceY(n1) + 0.14, -n1);
    const len = a.distanceTo(b);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    // A split-face block parapet next to the garage (p01), the bare coping further south.
    const ph = block ? 0.55 : 0;
    if (block) bag.add(clad, place(new BoxGeometry(0.16, ph, len + 0.01), mid.clone().setY(mid.y + ph / 2), yaw));
    posts.push(place(new BoxGeometry(0.04, 0.85, 0.04), a.clone().setY(a.y + ph + 0.42)));
    posts.push(place(new BoxGeometry(0.03, 0.03, len), mid.clone().setY(mid.y + ph + 0.82), yaw));
    posts.push(place(new BoxGeometry(0.02, 0.02, len), mid.clone().setY(mid.y + ph + 0.12), yaw));
    for (let k = 0.12; k < len; k += 0.12) posts.push(place(new BoxGeometry(0.012, 0.7, 0.012), a.clone().lerp(b, k / len).setY(mid.y + ph + 0.47)));
  }
  bag.add(w.printed, w.tint(merge(posts), "black"), false);

  // ---- round-tower villa NE of the crossing (PLATEAU 19.6, 8.3 N; ground 14.2 m T.P.; p09).
  const base = 4.0;
  const tower = new CylinderGeometry(2.3, 2.3, 9.4, 24, 1, true);
  tower.translate(21.8, base + 4.7, -6.1);
  bag.add(lib.stucco("cream"), tower);
  const cap = new CylinderGeometry(2.45, 2.45, 0.28, 24);
  cap.translate(21.8, base + 9.5, -6.1);
  bag.add(lib.stucco("white"), cap);
  // Tower windows in pale frames, two storeys round the seaward half (p09).
  const panes: BufferGeometry[] = [];
  const frames: BufferGeometry[] = [];
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI * 0.2 + k * 0.38;
    for (const y of [base + 2.1, base + 5.5]) {
      const p = new PlaneGeometry(0.85, 1.5);
      p.translate(0, 0, 2.32);
      p.rotateY(a);
      p.translate(21.8, y, -6.1);
      panes.push(p);
      const f = new BoxGeometry(1.0, 1.66, 0.06);
      f.translate(0, 0, 2.3);
      f.rotateY(a);
      f.translate(21.8, y, -6.1);
      frames.push(f);
    }
  }
  bag.add(lib.paint("aluminium"), merge(frames), false);
  bag.add(lib.glass(), merge(panes), false);
  // Ledgestone columns either side of the tower (p09).
  for (const [x, z] of [
    [18.9, -5.2],
    [24.6, -7.3],
  ])
    bag.add(ledge, place(new BoxGeometry(1.3, 9.9, 1.1), new Vector3(x, base + 4.95, z)));

  // ---- glass balustrades: on the garage roof and along the track-side terrace (p09).
  const glass = lib.glassRail();
  const rails: BufferGeometry[] = [];
  const steel: BufferGeometry[] = [];
  const pane = (a: Vector3, b: Vector3, h = 1.05) => {
    const len = a.distanceTo(b);
    const g = new PlaneGeometry(len, h);
    g.rotateY(-Math.atan2(b.z - a.z, b.x - a.x));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2 + h / 2 + 0.05, (a.z + b.z) / 2);
    rails.push(g);
    steel.push(place(new BoxGeometry(0.05, h + 0.1, 0.05), a.clone().setY(a.y + (h + 0.1) / 2)));
    const top = new BoxGeometry(len, 0.04, 0.06);
    top.rotateY(-Math.atan2(b.z - a.z, b.x - a.x));
    top.translate((a.x + b.x) / 2, (a.y + b.y) / 2 + h + 0.08, (a.z + b.z) / 2);
    steel.push(top);
  };
  pane(new Vector3(gx0 + 0.1, gy1 + 0.14, -gn1 + 0.1), new Vector3(gx1 - 0.1, gy1 + 0.14, -gn1 + 0.1));
  pane(new Vector3(gx0 + 0.1, gy1 + 0.14, -gn0), new Vector3(gx0 + 0.1, gy1 + 0.14, -gn1 + 0.1));
  for (let u = 9; u < 62; u += 3) {
    const a = COAST.offset(u, -3.6, new Vector3());
    const b = COAST.offset(u + 3, -3.6, new Vector3());
    a.y = hillY(a.x, a.z);
    b.y = hillY(b.x, b.z);
    pane(a, b, 1.6);
  }
  bag.add(glass, merge(rails), false);
  bag.add(lib.paint("aluminium"), merge(steel), false);

  // ---- gardens.
  const at = (x: number, n: number) => new Vector3(x, hillY(x, -n), -n);
  // Terrace behind the parapet: shrubs spilling over, cycads and a fan palm (p01, p02, p19).
  for (let n = WALK.from + 1.0; n < gn0; n += r.range(1.4, 2.2)) {
    const x = wallTop(n) + r.range(1.3, 2.2);
    green.shrub(at(x, n), r.range(0.7, 1.0), r.range(1.3, 2.0), r.chance(0.6) ? "shrub" : "box");
    if (r.chance(0.45)) green.cycad(at(x + r.range(1.0, 2.2), n + r.range(-0.5, 0.5)), r.range(0.9, 1.25));
  }
  // The lush mass behind the garage and along the wall's north half (p01 upper left): big
  // broadleaf shrubs, cycads and a palm, darker in the shade of each other.
  for (let n = 12; n < gn0 + 1.5; n += r.range(1.6, 2.4)) {
    const x = wallTop(n) + r.range(1.8, 4.5);
    green.shrub(at(x, n), r.range(1.1, 1.5), r.range(2.2, 3.2), "shrub", 1.1);
    if (r.chance(0.6)) green.cycad(at(x + r.range(-1.2, 1.2), n + r.range(-0.8, 0.8)), r.range(1.2, 1.5));
  }
  green.fanPalm(at(wallTop(9) + 2.4, 9), 5.5, new Vector3(-0.05, 0, 0.02));
  green.fanPalm(at(wallTop(16) + 2.8, 16.5), 6.8, new Vector3(-0.06, 0, -0.03));
  // On the garage roof: two cycads, a shrub and a palm behind (p01 upper left).
  green.cycad(new Vector3(gx0 + 0.9, gy1 + 0.14, -(gn0 + 1.2)), 1.2);
  green.cycad(new Vector3(gx0 + 2.1, gy1 + 0.14, -(gn1 - 0.9)), 1.05);
  green.shrub(new Vector3(gx1 - 0.6, gy1 + 0.14, -(gn0 + 0.8)), 0.9, 1.5, "shrub");
  green.fanPalm(at(gx1 + 1.6, gn0 + 0.6), 6.2, new Vector3(-0.08, 0, 0));
  for (let x = gx1 + 0.6; x < 18; x += r.range(1.6, 2.6)) green.shrub(at(x, gn0 + r.range(-1.5, 1)), r.range(0.9, 1.3), r.range(1.4, 2.4));
  // The planted triangle: silver grass on the low wall's edge, lawn tufts, shrubs and cycads (p01 left).
  const triTop = (x: number, n: number) => new Vector3(x, slopeY(n) + triangleLift(n) + 0.03 * (x - eastKerb(n)), -n);
  // Short grass along the low wall's edge (the villa wall behind stays in view), silver grass further back.
  for (let n = TRIANGLE.from + 0.9; n < TRIANGLE.to - 0.4; n += r.range(0.35, 0.6)) {
    green.grass(triTop(eastKerb(n) + r.range(0.55, 0.9), n), r.range(0.3, 0.55), "grass");
    green.grass(triTop(eastKerb(n) + r.range(2.2, 3.4), n), r.range(0.8, 1.3), "tall");
  }
  for (let i = 0; i < 60; i++) {
    const n = r.range(TRIANGLE.from + 0.8, TRIANGLE.to - 0.6);
    const xMax = 7 + (TRIANGLE.to - n) * 1.2;
    const x = r.range(eastKerb(n) + 0.7, Math.min(xMax, 16));
    green.grass(triTop(x, n), r.range(0.25, 0.55), x > eastKerb(n) + 2 && r.chance(0.3) ? "tall" : "grass");
  }
  for (const [x, n, k] of [
    [7.2, 25.4, "cycad"],
    [9.6, 26.8, "shrub"],
    [6.8, 28.6, "shrub"],
    [11.8, 25.2, "cycad"],
    [14.2, 26.4, "shrub"],
  ] as [number, number, string][]) {
    if (k === "cycad") green.cycad(triTop(x, n), 1.1);
    else green.shrub(triTop(x, n), r.range(0.8, 1.1), r.range(1.0, 1.5), "box");
  }
  // The bank east of the junction above the camera corner (p01 far left): grass and shrubs.
  for (let i = 0; i < 26; i++) {
    const n = r.range(34, 58);
    const x = eastKerb(n) + r.range(4.5, 12);
    green.grass(at(x, n), r.range(0.5, 1.1), "tall");
  }
  for (const [x, n] of [
    [11, 44],
    [13.5, 50],
    [10.5, 55],
  ])
    green.shrub(at(x, n), 1.2, 1.8, "shrub");
  // Track-side gardens of the villas east of the crossing (p09): palms and shrubs above the glass screen.
  for (const [x, n, k] of [
    [14, 3.6, "palm"],
    [27, 3.9, "palm"],
    [33, 4.2, "shrub"],
    [44, 3.0, "palm"],
    [52, 2.0, "shrub"],
    [38, 3.6, "cycad"],
    [58, 1.6, "shrub"],
  ] as [number, number, string][]) {
    if (k === "palm") green.fanPalm(at(x, n), r.range(5.5, 7.5), new Vector3(r.range(-0.06, 0.06), 0, 0.04));
    else if (k === "cycad") green.cycad(at(x, n), 1.1);
    else green.shrub(at(x, n), 1.1, 1.8);
  }
  green.emit(w, "villa-gardens");
  bag.emit(w);
}
