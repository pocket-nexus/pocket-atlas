import { BufferGeometry, Float32BufferAttribute } from "three";
import { Rng } from "../../../core/random";
import type { AtlasRect } from "../../shared/atlas";
import type { Ctx } from "../../shared/canvas";
import * as SURF from "../gfx/surfaces";
import type { Bag, KamakuraWorld } from "./context";
import { eastKerb, roadAt, TRIANGLE, WALK, wallBase } from "./ground";
import { CROSSING, slopeEdges } from "./layout";

/**
 * The slope road's surface from the crossing to the school: one
 * vertex-coloured mesh in the slope asphalt (wheel paths polished light,
 * oil down the lane centres, grime along both kerbs), with repair patches
 * and the long tar-sealed cracks of p01 and p03 as raised overlays in the
 * same material and draw; the concrete kerbs and the two sidewalks; the
 * steel grating along the east kerb; worn white paint (stop line, zebra,
 * the northbound lane arrow) and the manhole covers.
 */

/** Hash-based value noise in [0, 1] (vertex colours only). */
function vnoise(x: number, y: number, seed: number): number {
  const h = (i: number, j: number) => {
    const s = Math.sin(i * 127.1 + j * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}

const WEST_WALK = { to: 26, width: 1.6 };

/** West edge of the carriageway (the west sidewalk's kerb up to 26 m north). */
export function westKerb(n: number): number {
  const [w] = slopeEdges(n);
  const k = n < WEST_WALK.to ? 1 : Math.max(0, 1 - (n - WEST_WALK.to) / 2);
  return w + WEST_WALK.width * k;
}

/** Road surface height across the carriageway (a 6 cm crown at the middle). */
export function roadSurface(x: number, n: number): number {
  const xw = westKerb(n);
  const xe = eastKerb(n);
  const t = (x - xw) / Math.max(1, xe - xw);
  const crown = Math.min(0.06, (xe - xw) * 0.008);
  return roadAt(n) + crown * Math.max(0, 1 - Math.pow(2 * t - 1, 2));
}

class Soup {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  vert(x: number, y: number, z: number, c: [number, number, number]): number {
    this.pos.push(x, y, z);
    this.uv.push(x, -z);
    this.col.push(...c);
    return this.pos.length / 3 - 1;
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("uv", new Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

/** Vertex colour of the bare road at (x, n): wheel paths, lane centres, kerb grime, mottling. */
function roadTone(x: number, n: number): [number, number, number] {
  const xw = westKerb(n);
  const xe = eastKerb(n);
  const mid = (xw + xe) / 2;
  let k = 0.93 + 0.07 * vnoise(x * 0.35, n * 0.18, 1) + 0.04 * vnoise(x * 1.3, n * 0.9, 2) - 0.02;
  // Two lanes (northbound west, southbound east); wheel paths 0.85 m either side of each lane centre.
  for (const lc of [(xw + mid) / 2, (mid + xe) / 2]) {
    const d = Math.abs(x - lc);
    k += 0.07 * Math.exp(-(((d - 0.85) / 0.32) ** 2));
    k -= 0.08 * Math.exp(-((d / 0.28) ** 2)) * (0.6 + 0.4 * vnoise(x, n * 0.5, 3));
  }
  // Grime and sand along both kerbs; the east gutter by the grating darkest.
  const de = xe - x;
  const dw = x - xw;
  k -= 0.2 * Math.exp(-((de / 0.45) ** 2)) + 0.12 * Math.exp(-((dw / 0.4) ** 2));
  k = Math.min(1, Math.max(0.55, k));
  const warm = 0.02 * Math.exp(-((de / 0.6) ** 2));
  return [Math.min(1, k + warm), k, Math.max(0, k - warm * 1.5)];
}

/** A raised ribbon along a polyline (x, n points) on the road, width w, colour c. */
function ribbonOn(s: Soup, pts: [number, number][], w: number, lift: number, c: [number, number, number]): void {
  const base = s.pos.length / 3;
  pts.forEach(([x, n], i) => {
    const [xa, na] = pts[Math.max(0, i - 1)];
    const [xb, nb] = pts[Math.min(pts.length - 1, i + 1)];
    const tx = xb - xa;
    const tn = nb - na;
    const l = Math.hypot(tx, tn) || 1;
    const ox = (-tn / l) * (w / 2);
    const on = (tx / l) * (w / 2);
    for (const k of [-1, 1]) s.vert(x + ox * k, roadSurface(x + ox * k, n + on * k) + lift, -(n + on * k), c);
  });
  for (let i = 0; i < pts.length - 1; i++) {
    const a = base + i * 2;
    // The offset is left of the direction of travel, so this winding faces up either way.
    s.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

/** A raised quad patch [x0, x1] × [n0, n1] on the road, split into 1 m cells so it follows the crown. */
function patchOn(s: Soup, x0: number, x1: number, n0: number, n1: number, lift: number, c: [number, number, number]): void {
  const nx = Math.max(1, Math.ceil((x1 - x0) / 1.0));
  const nn = Math.max(1, Math.ceil((n1 - n0) / 1.5));
  const base = s.pos.length / 3;
  for (let j = 0; j <= nn; j++)
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const n = n0 + ((n1 - n0) * j) / nn;
      s.vert(x, roadSurface(x, n) + lift, -n, c);
    }
  for (let j = 0; j < nn; j++)
    for (let i = 0; i < nx; i++) {
      const a = base + j * (nx + 1) + i;
      s.idx.push(a, a + 1, a + nx + 1, a + 1, a + nx + 2, a + nx + 1);
    }
}

/** Meandering crack polyline from (x0, n0) to (x1, n1). */
function crackLine(r: Rng, x0: number, n0: number, x1: number, n1: number, wander: number, step = 0.35): [number, number][] {
  const len = Math.hypot(x1 - x0, n1 - n0);
  const k = Math.max(2, Math.ceil(len / step));
  const out: [number, number][] = [];
  let off = 0;
  const px = -(n1 - n0) / len;
  const pn = (x1 - x0) / len;
  for (let i = 0; i <= k; i++) {
    const t = i / k;
    off += r.range(-1, 1) * wander * 0.35;
    off *= 0.92;
    const e = Math.sin(Math.PI * t);
    out.push([x0 + (x1 - x0) * t + px * off * e, n0 + (n1 - n0) * t + pn * off * e]);
  }
  return out;
}

/** Worn road paint: white with tyre-worn holes and ragged edges (alpha-tested). */
function wornPaint(g: Ctx, cw: number, ch: number, seed: number, shape?: (g: Ctx, cw: number, ch: number) => void): void {
  g.clearRect(0, 0, cw, ch);
  g.fillStyle = "#e4e2da";
  if (shape) shape(g, cw, ch);
  else g.fillRect(3, 3, cw - 6, ch - 6);
  const img = g.getImageData(0, 0, cw, ch);
  const d = img.data;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      if (!d[i + 3]) continue;
      const big = vnoise(x / 22, y / 22, seed);
      const fine = vnoise(x / 4, y / 4, seed + 5);
      const wear = big * 0.7 + fine * 0.3;
      // Holes where the paint has worn through; the rest dulled by grime.
      if (wear < 0.34) d[i + 3] = 0;
      const dim = 0.86 + 0.14 * fine;
      d[i] *= dim;
      d[i + 1] *= dim;
      d[i + 2] *= dim * 0.98;
    }
  g.putImageData(img, 0, 0);
}

/** Steel bar grating over the gutter: angle frame, bearing bars across, dark channel, sand in the gaps. */
function grating(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#100e0c";
  g.fillRect(0, 0, cw, ch);
  const r = new Rng(41);
  for (let y = 2; y < ch; y += 5) {
    g.fillStyle = `rgb(${r.int(78, 96)},${r.int(70, 84)},${r.int(62, 74)})`;
    g.fillRect(4, y, cw - 8, 2);
  }
  g.fillStyle = "rgba(60,52,44,0.9)";
  for (const x of [cw * 0.33, cw * 0.66]) g.fillRect(x, 0, 2, ch);
  g.fillStyle = "#3a332d";
  g.fillRect(0, 0, 4, ch);
  g.fillRect(cw - 4, 0, 4, ch);
  // Rust and sand caught in the bars.
  for (let i = 0; i < 260; i++) {
    g.fillStyle = r.chance(0.5) ? "rgba(110,72,40,0.35)" : "rgba(150,140,118,0.4)";
    g.fillRect(r.range(4, cw - 8), r.range(0, ch), r.range(2, 8), r.range(1, 4));
  }
}

/** Manhole cover: concentric rings and a hex-grip pattern (Kamakura sewer lid). */
function manhole(g: Ctx, cw: number, ch: number): void {
  g.clearRect(0, 0, cw, ch);
  const c = cw / 2;
  g.fillStyle = "#4a4743";
  g.beginPath();
  g.arc(c, c, c - 2, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#37342f";
  g.beginPath();
  g.arc(c, c, c - 9, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#5c5852";
  for (let y = -c; y < c; y += 9)
    for (let x = -c; x < c; x += 9) {
      const xx = x + (Math.round(y / 9) % 2) * 4.5;
      if (xx * xx + y * y > (c - 14) ** 2) continue;
      g.fillRect(c + xx - 2, c + y - 2, 4, 4);
    }
  g.strokeStyle = "#625e57";
  g.lineWidth = 3;
  g.beginPath();
  g.arc(c, c, c * 0.32, 0, Math.PI * 2);
  g.stroke();
}

/** A horizontal quad following the road surface, atlas-mapped. */
function decal(x0: number, x1: number, n0: number, n1: number, lift: number, cell: AtlasRect, rotate = false, y?: (x: number, n: number) => number): BufferGeometry {
  const pts = [
    [x0, n0],
    [x1, n0],
    [x1, n1],
    [x0, n1],
  ];
  const hy = y ?? roadSurface;
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pts.flatMap(([x, n]) => [x, hy(x, n) + lift, -n]), 3));
  g.setAttribute("normal", new Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  const c = cell;
  const uv = rotate ? [c.u0, c.v0, c.u0, c.v1, c.u1, c.v1, c.u1, c.v0] : [c.u0, c.v0, c.u1, c.v0, c.u1, c.v1, c.u0, c.v1];
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export function buildRoad(w: KamakuraWorld, bag: Bag): void {
  const lib = w.lib;
  const r = new Rng(1910);
  const asphalt = lib.baked("slope-asphalt", SURF.SLOPE_ASPHALT, { size: 1024, tile: 4, bump: 2.2, normal: 0.7, vertexColors: true });
  const s = new Soup();

  // ---- carriageway: rows every metre to 70 m, then 2 m and 5 m; columns every ~0.5 m.
  const deckN = -CROSSING.deck[0];
  const ns: number[] = [];
  for (let n = deckN; n < 206; n += n < 70 ? 1 : n < 120 ? 2 : 5) ns.push(n);
  ns.push(206);
  const cols = 22;
  for (const n of ns) {
    const xw = westKerb(n);
    const xe = eastKerb(n);
    const c = n < 90 ? cols : 6;
    for (let i = 0; i <= cols; i++) {
      const x = xw + ((xe - xw) * Math.min(i, c)) / c;
      s.vert(x, roadSurface(x, n), -n, roadTone(x, n));
    }
  }
  for (let j = 0; j < ns.length - 1; j++)
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      // x increasing, north increasing (−z): (a, a+1, a+cols+1) faces up.
      s.idx.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1);
    }

  // ---- repair patches (darker, newer binder) and the deck joint band.
  const newer: [number, number, number] = [0.66, 0.66, 0.68];
  const older: [number, number, number] = [0.8, 0.79, 0.78];
  patchOn(s, westKerb(deckN) + 0.05, eastKerb(deckN) - 0.05, deckN, deckN + 1.1, 0.008, newer);
  patchOn(s, westKerb(15) + 0.05, eastKerb(15) - 0.05, 14.7, 15.9, 0.008, older);
  patchOn(s, 0.6, 2.2, 13.7, 15.3, 0.01, newer);
  patchOn(s, eastKerb(30) - 1.2, eastKerb(30) - 0.42, 26.5, 38.5, 0.008, older);
  patchOn(s, -2.8, -0.9, 41, 43.5, 0.008, older);
  patchOn(s, 1.4, 3.0, 29.4, 31.0, 0.01, newer);

  // ---- tar-sealed cracks: the lane joint, wheel-path cracks, transverse cracks with branches.
  const tar: [number, number, number] = [0.58, 0.565, 0.55];
  const seal = (pts: [number, number][]) => ribbonOn(s, pts, r.range(0.028, 0.042), 0.014, tar);
  seal(crackLine(r, 0.4, 52, -0.25, deckN + 1.2, 0.5));
  seal(crackLine(r, 2.0, 46, 2.5, 17, 0.6));
  seal(crackLine(r, -2.3, 36, -2.7, 9, 0.5));
  seal(crackLine(r, 3.1, 24, 3.7, 6, 0.4));
  for (const n of [11.2, 27.3, 44.2]) {
    const a = westKerb(n) + r.range(0.2, 1.5);
    const b = eastKerb(n) - r.range(0.3, 2.5);
    seal(crackLine(r, a, n + r.range(-0.3, 0.3), b, n + r.range(-0.4, 0.4), 0.5, 0.3));
  }
  for (let i = 0; i < 4; i++) {
    const n = r.range(9, 48);
    const x = r.range(-2.5, 3);
    seal(crackLine(r, x, n, x + r.range(-1.6, 1.6), n + r.range(-2.5, 2.5), 0.4, 0.3));
  }
  // The joint between the slope and the crossing deck.
  ribbonOn(
    s,
    Array.from({ length: 12 }, (_, i) => {
      const x = westKerb(deckN) + ((eastKerb(deckN) - westKerb(deckN)) * i) / 11;
      return [x, deckN + 0.03] as [number, number];
    }),
    0.07,
    0.016,
    [0.24, 0.23, 0.22],
  );
  const road = w.mesh(s.geometry(), asphalt, 0, 0, 0, w.root, { cast: false });
  road.name = "slope-road";

  // ---- kerbs and sidewalks.
  const concrete = lib.concrete();
  const paving = lib.paving();
  const kerbFace: number[] = [];
  const kerbTop: number[] = [];
  const walkTop: number[] = [];
  // Quad (a, b, c, d) wound to face `out`.
  const quad = (list: number[], a: number[], b: number[], c: number[], d: number[], out: [number, number, number]) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) list.push(...a, ...b, ...c, ...a, ...c, ...d);
    else list.push(...a, ...c, ...b, ...a, ...d, ...c);
  };
  const UPV: [number, number, number] = [0, 1, 0];
  // East: sidewalk to the wall foot (2.9–23.6 m), then the strip at the triangle's foot and the apron's kerb.
  for (let n = 2.4; n < 56; n += 1) {
    const n1 = Math.min(56, n + 1);
    const h0 = n < WALK.to ? WALK.height : 0.15;
    const k0 = eastKerb(n);
    const k1 = eastKerb(n1);
    const y0 = roadAt(n);
    const y1 = roadAt(n1);
    // Kerb face (faces west), kerb stone top 0.15 m.
    quad(kerbFace, [k0, y0 - 0.02, -n], [k1, y1 - 0.02, -n1], [k1, y1 + h0, -n1], [k0, y0 + h0, -n], [-1, 0, 0]);
    quad(kerbTop, [k0, y0 + h0, -n], [k1, y1 + h0, -n1], [k1 + 0.15, y1 + h0, -n1], [k0 + 0.15, y0 + h0, -n], UPV);
    const back0 = n < WALK.to ? wallBase(n) + 0.02 : n < TRIANGLE.to ? k0 + 0.34 : k0 + 0.3;
    const back1 = n1 < WALK.to ? wallBase(n1) + 0.02 : n1 < TRIANGLE.to ? k1 + 0.34 : k1 + 0.3;
    quad(walkTop, [k0 + 0.15, y0 + h0, -n], [k1 + 0.15, y1 + h0, -n1], [back1, y1 + h0, -n1], [back0, y0 + h0, -n], UPV);
  }
  // West: a 1.6 m sidewalk from the crossing corner to 26 m north, outside the park's wall.
  for (let n = -CROSSING.deck[0]; n < WEST_WALK.to; n += 1) {
    const n1 = Math.min(WEST_WALK.to, n + 1);
    const k0 = westKerb(n);
    const k1 = westKerb(n1);
    const [w0] = slopeEdges(n);
    const [w1] = slopeEdges(n1);
    const y0 = roadAt(n);
    const y1 = roadAt(n1);
    quad(kerbFace, [k1, y1 - 0.02, -n1], [k0, y0 - 0.02, -n], [k0, y0 + 0.15, -n], [k1, y1 + 0.15, -n1], [1, 0, 0]);
    quad(kerbTop, [k0 - 0.15, y0 + 0.15, -n], [k0, y0 + 0.15, -n], [k1, y1 + 0.15, -n1], [k1 - 0.15, y1 + 0.15, -n1], UPV);
    quad(walkTop, [w0, y0 + 0.15, -n], [k0 - 0.15, y0 + 0.15, -n], [k1 - 0.15, y1 + 0.15, -n1], [w1, y1 + 0.15, -n1], UPV);
  }
  const geo = (list: number[]) => {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(list, 3));
    g.computeVertexNormals();
    return g;
  };
  bag.add(concrete, geo(kerbFace));
  bag.add(concrete, geo(kerbTop), false);
  bag.add(paving, geo(walkTop), false);

  // ---- steel grating in the east gutter, from the crossing to past the camera (p01, p03, p04).
  const grate = w.draw("slope-grating", 64, 512, grating);
  for (let n = 3.4; n < 58; n += 2.9) {
    const n1 = Math.min(58, n + 2.85);
    const x = (nn: number) => eastKerb(nn) - 0.02;
    const pts = [
      [x(n) - 0.38, n],
      [x(n), n],
      [x(n1), n1],
      [x(n1) - 0.38, n1],
    ];
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pts.flatMap(([xx, nn]) => [xx, roadAt(nn) + 0.012, -nn]), 3));
    g.setAttribute("normal", new Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute("uv", new Float32BufferAttribute([grate.u0, grate.v0, grate.u1, grate.v0, grate.u1, grate.v1, grate.u0, grate.v1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    bag.add(w.printed, g, false);
  }

  // ---- worn paint: stop line (southbound lane), zebra, northbound lane arrow (p01, p02).
  const cut = w.cut;
  const lineCell = w.draw("paint-worn-line", 512, 64, (g, cw, ch) => wornPaint(g, cw, ch, 3));
  const stripeCell = w.draw("paint-worn-stripe", 64, 256, (g, cw, ch) => wornPaint(g, cw, ch, 7));
  const arrowCell = w.draw("paint-worn-arrow", 128, 512, (g, cw, ch) =>
    wornPaint(g, cw, ch, 11, (c, w2, h2) => {
      c.beginPath();
      c.moveTo(w2 * 0.5, 4);
      c.lineTo(w2 - 4, h2 * 0.3);
      c.lineTo(w2 * 0.66, h2 * 0.3);
      c.lineTo(w2 * 0.66, h2 - 4);
      c.lineTo(w2 * 0.34, h2 - 4);
      c.lineTo(w2 * 0.34, h2 * 0.3);
      c.lineTo(4, h2 * 0.3);
      c.closePath();
      c.fill();
    }),
  );
  const mid4 = (westKerb(4.3) + eastKerb(4.3)) / 2;
  bag.add(cut, decal(mid4 + 0.3, eastKerb(4.3) - 0.25, 4.05, 4.45, 0.02, lineCell), false);
  {
    const zw = westKerb(7.5) + 0.35;
    const ze = eastKerb(7.5) - 0.35;
    for (let x = zw; x < ze - 0.4; x += 0.9) bag.add(cut, decal(x, x + 0.45, 5.6, 9.2, 0.02, stripeCell), false);
  }
  // Arrow (5 m, pointing uphill) in the northbound lane: its tip at the north end.
  bag.add(cut, decal(-1.45, -0.55, 22.4, 27.4, 0.02, arrowCell, false), false);

  // ---- manhole covers (p01: at the zebra, mid-slope, in front of the camera) and a valve lid.
  const lid = w.draw("slope-manhole", 128, 128, manhole);
  for (const [x, n] of [
    [0.6, 6.6],
    [1.4, 14.5],
    [2.3, 30.2],
    [-1.6, 47.5],
  ]) bag.add(cut, decal(x - 0.32, x + 0.32, n - 0.32, n + 0.32, 0.022, lid), false);
}
