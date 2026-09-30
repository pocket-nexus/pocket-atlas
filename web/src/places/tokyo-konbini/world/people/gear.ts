import { BoxGeometry, Group, Mesh, PlaneGeometry, SphereGeometry, Vector3, type BufferGeometry, type Material, type Object3D } from "three";
import { mapUV } from "../../../shared/atlas";
import { canvas, JP_SANS, LATIN, toTexture } from "../../gfx/canvas";
import { flip, merge, rod, tube, v3 } from "../props/util";
import { grid } from "./shape";

/** Carried objects: umbrellas, phone, magazine, basket, briefcase. */

function mesh(g: BufferGeometry, m: Material, parent: Object3D, cast: boolean): Mesh {
  const o = new Mesh(g, m);
  o.castShadow = cast;
  o.receiveShadow = true;
  parent.add(o);
  return o;
}

export interface UmbrellaMats {
  canopy: Material;
  frame: Material;
  handle: Material;
}

/**
 * Open umbrella. Local frame: the grip at the origin, shaft up +y. The
 * canopy is a polygon of taut panels between `ribs` ribs (chords, not a
 * cone), each panel's hem cut in a shallow arc; ribs, stretchers and runner
 * sit underneath.
 */
export function openUmbrella(m: UmbrellaMats, o: { radius: number; drop: number; ribs: number; shaft: number; cast: boolean; hook?: boolean; twoSided?: boolean }): Group {
  const g = new Group();
  const { radius: R, drop: D, ribs: n, shaft: H } = o;
  const prof = (r: number) => H - D * Math.pow(r / R, 1.6);
  const per = 6;
  const seg = n * per;
  const rows: Vector3[][] = [];
  const RINGS = 9;
  for (let i = 0; i <= RINGS; i++) {
    const rr = 0.014 + (R - 0.014) * (i / RINGS);
    const row: Vector3[] = [];
    for (let j = 0; j < seg; j++) {
      const f = (j % per) / per;
      const a = (j / seg) * Math.PI * 2;
      const th = (f - 0.5) * ((Math.PI * 2) / n);
      const chord = Math.cos(Math.PI / n) / Math.cos(th);
      const hem = i === RINGS ? Math.sin(Math.PI * f) : 0;
      const r = rr * chord - hem * 0.028;
      row.push(v3(Math.sin(a) * r, prof(rr) + hem * 0.02 + Math.sin(Math.PI * f) * 0.006 * (i / RINGS), Math.cos(a) * r));
    }
    rows.push(row);
  }
  const canopy = grid(rows, true, {}, v3(0, H - 1, 0));
  // Opaque fabric needs its underside too (the vinyl material is double-sided).
  mesh(o.twoSided ? merge([canopy, flip(canopy.clone()).translate(0, -0.002, 0)]) : canopy, m.canopy, g, o.cast);

  const frame: BufferGeometry[] = [];
  const tips: BufferGeometry[] = [];
  const runner = H - 0.3 * (H / 0.85);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const pts: Vector3[] = [];
    for (let i = 0; i <= 5; i++) {
      const rr = 0.02 + (R - 0.02) * (i / 5);
      pts.push(v3(Math.sin(a) * rr, prof(rr) - 0.007, Math.cos(a) * rr));
    }
    frame.push(tube(pts, 0.0022, 4, 10));
    const mid = 0.46 * R;
    frame.push(rod(v3(0, runner, 0), v3(Math.sin(a) * mid, prof(mid) - 0.008, Math.cos(a) * mid), 0.0018, 3));
    const tip = new SphereGeometry(0.0055, 6, 4);
    tip.translate(Math.sin(a) * R, prof(R) - 0.004, Math.cos(a) * R);
    tips.push(tip);
  }
  frame.push(rod(v3(0, 0.02, 0), v3(0, H + 0.01, 0), 0.0055, 6));
  frame.push(rod(v3(0, runner - 0.03, 0), v3(0, runner + 0.03, 0), 0.011, 8));
  frame.push(rod(v3(0, H, 0), v3(0, H + 0.055, 0), 0.008, 6, 0.003));
  mesh(merge(frame), m.frame, g, o.cast);

  // Grip and J-hook.
  const handle: BufferGeometry[] = [...tips, rod(v3(0, -0.11, 0), v3(0, 0.07, 0), 0.0125, 8, 0.011)];
  if (o.hook !== false) handle.push(tube([v3(0, -0.1, 0), v3(0, -0.15, 0.006), v3(0, -0.172, 0.04), v3(0, -0.155, 0.078), v3(0, -0.12, 0.082)], 0.0115, 7, 40));
  mesh(merge(handle), m.handle, g, o.cast);
  return g;
}

/**
 * Closed umbrella, strap fastened. Local frame: the grip at the origin, the
 * shaft pointing down −y to the ferrule at −length.
 */
export function closedUmbrella(m: UmbrellaMats, length: number, cast: boolean): Group {
  const g = new Group();
  const rows: Vector3[][] = [];
  const prof: [number, number][] = [
    [-0.16, 0.012],
    [-0.2, 0.026],
    [-0.3, 0.034],
    [-0.45, 0.035],
    [-0.6, 0.028],
    [-length + 0.1, 0.014],
    [-length + 0.05, 0.006],
  ];
  for (const [y, r] of prof) {
    const row: Vector3[] = [];
    for (let j = 0; j < 24; j++) {
      const a = (j / 24) * Math.PI * 2 + y * 3;
      const rr = r * (1 + 0.22 * Math.sin(a * 8));
      row.push(v3(Math.sin(a) * rr, y, Math.cos(a) * rr));
    }
    rows.push(row);
  }
  mesh(grid(rows, true, { start: true, end: true }), m.canopy, g, cast);
  const frame = [rod(v3(0, 0, 0), v3(0, -length, 0), 0.005, 6), rod(v3(0, -0.27, 0), v3(0, -0.25, 0), 0.039, 10)];
  mesh(merge(frame), m.frame, g, cast);
  const handle = [rod(v3(0, -0.12, 0), v3(0, 0.08, 0), 0.0125, 8, 0.011), tube([v3(0, 0.07, 0), v3(0, 0.12, 0.004), v3(0, 0.142, 0.04), v3(0, 0.125, 0.078), v3(0, 0.09, 0.082)], 0.0115, 7, 40)];
  mesh(merge(handle), m.handle, g, cast);
  return g;
}

/** Phone: long axis +y, screen on the −z face. */
export function phone(body: Material, screen: Material, parent: Object3D): Group {
  const g = new Group();
  parent.add(g);
  mesh(new BoxGeometry(0.071, 0.148, 0.008), body, g, false);
  const s = new PlaneGeometry(0.064, 0.138);
  s.rotateY(Math.PI);
  s.translate(0, 0, -0.0042);
  mesh(s, screen, g, false);
  return g;
}

let magCanvas: HTMLCanvasElement | null = null;

/** Open spread (left half) and back-cover advert (right half) of a weekly. */
export function magazineCanvas(): HTMLCanvasElement {
  if (magCanvas) return magCanvas;
  const { c, g } = canvas(1024, 512);
  g.fillStyle = "#f3f1ea";
  g.fillRect(0, 0, 512, 512);
  // Spread: a photo across the gutter, headline, text columns.
  g.fillStyle = "#6f7f8e";
  g.fillRect(24, 40, 300, 210);
  g.fillStyle = "#a4927a";
  g.fillRect(40, 150, 120, 100);
  g.fillStyle = "#c9412f";
  g.font = `900 34px ${JP_SANS}`;
  g.fillText("特集", 340, 80);
  g.fillStyle = "#222";
  g.font = `800 24px ${JP_SANS}`;
  g.fillText("雨の夜の", 340, 120);
  g.fillText("東京さんぽ", 340, 150);
  g.fillStyle = "#555";
  for (let col = 0; col < 4; col++)
    for (let r = 0; r < 18; r++) {
      const x = 24 + col * 122;
      const y = 280 + r * 12;
      g.fillRect(x, y, 104 - ((r * 37 + col * 11) % 23), 5);
    }
  g.fillStyle = "#d8d4c8";
  g.fillRect(254, 0, 4, 512);
  // Back cover: a drink advert.
  const grd = g.createLinearGradient(512, 0, 1024, 512);
  grd.addColorStop(0, "#1b6fb8");
  grd.addColorStop(1, "#0c2f5c");
  g.fillStyle = grd;
  g.fillRect(512, 0, 512, 512);
  g.fillStyle = "#f4f8ff";
  g.beginPath();
  g.ellipse(700, 300, 70, 170, 0.2, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#ffd23a";
  g.font = `900 64px ${LATIN}`;
  g.fillText("AQUA", 810, 140);
  g.fillStyle = "#fff";
  g.font = `800 30px ${JP_SANS}`;
  g.fillText("新発売", 820, 200);
  magCanvas = c;
  return c;
}

export function magazineTexture() {
  return toTexture(magazineCanvas());
}

/**
 * Open magazine. Local frame: gutter along y at x = 0, pages facing −z (the
 * reader), covers facing +z; the two halves fold 8° toward the reader. The
 * reader's left page is at +x. `leaf` turns about the gutter from the left
 * half (rotation.y = fold) to the right (π − fold), right-bound like a
 * Japanese weekly.
 */
export function magazine(mat: Material, parent: Object3D): { group: Group; leaf: Group; fold: number } {
  const W = 0.19;
  const Hh = 0.26;
  const fold = 0.14;
  const g = new Group();
  parent.add(g);
  const face = (x0: number, x1: number, toReader: boolean, u0: number, u1: number, dz = 0) => {
    const p = new PlaneGeometry(x1 - x0, Hh);
    mapUV(p, { u0, u1, v0: 0.02, v1: 0.98 });
    if (toReader) p.rotateY(Math.PI);
    p.translate((x0 + x1) / 2, 0, (toReader ? -0.0008 : 0.0008) + dz);
    return p;
  };
  const left = merge([face(0, W, true, 0, 0.25), face(0, W, false, 0.75, 0.98)]).rotateY(fold);
  const right = merge([face(-W, 0, true, 0.25, 0.5), face(-W, 0, false, 0.52, 0.75)]).rotateY(-fold);
  mesh(merge([left, right]), mat, g, false);
  const leaf = new Group();
  leaf.rotation.y = fold;
  g.add(leaf);
  mesh(merge([face(0, W - 0.003, true, 0.005, 0.245, -0.0022), face(0, W - 0.003, false, 0.255, 0.495, -0.0022)]), mat, leaf, false);
  return { group: g, leaf, fold };
}

/** Konbini shopping basket, hanging from its handles (grip at the origin). */
export function basket(body: Material, goods: Material[], parent: Object3D): Group {
  const g = new Group();
  parent.add(g);
  const W = 0.44;
  const D = 0.3;
  const Hh = 0.22;
  const y0 = -0.16 - Hh;
  const parts: BufferGeometry[] = [];
  const b = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const q = new BoxGeometry(w, h, d);
    q.translate(x, y, z);
    parts.push(q);
  };
  b(W - 0.04, 0.012, D - 0.04, 0, y0 + 0.006, 0);
  for (const sg of [-1, 1]) {
    b(W, Hh, 0.008, 0, y0 + Hh / 2, sg * (D / 2));
    b(0.008, Hh, D, sg * (W / 2), y0 + Hh / 2, 0);
    b(W + 0.02, 0.018, 0.02, 0, y0 + Hh, sg * (D / 2));
    b(0.02, 0.018, D + 0.02, sg * (W / 2), y0 + Hh, 0);
    // Handle loops from each long side, meeting at the grip.
    parts.push(tube([v3(-0.1, y0 + Hh, sg * (D / 2)), v3(-0.08, -0.06, sg * 0.07), v3(0, 0.005, sg * 0.008), v3(0.08, -0.06, sg * 0.07), v3(0.1, y0 + Hh, sg * (D / 2))], 0.007, 5, 24));
  }
  mesh(merge(parts), body, g, false);
  const items: [number, number, number, number, number, number][] = [
    [0.12, 0.2, 0.07, -0.1, y0 + 0.11, 0.02],
    [0.16, 0.06, 0.12, 0.08, y0 + 0.04, -0.04],
    [0.07, 0.14, 0.07, 0.05, y0 + 0.08, 0.07],
  ];
  items.forEach(([w, h, d, x, y, z], i) => {
    const q = new BoxGeometry(w, h, d);
    q.translate(x, y, z);
    mesh(q, goods[i % goods.length], g, false);
  });
  return g;
}

/** Briefcase hanging from its handle (grip at the origin). */
export function briefcase(body: Material, metal: Material, parent: Object3D, cast: boolean): Group {
  const g = new Group();
  parent.add(g);
  const c = new BoxGeometry(0.085, 0.29, 0.4);
  c.translate(0, -0.2, 0);
  const parts = [c, tube([v3(0, -0.055, -0.07), v3(0, -0.01, -0.05), v3(0, 0.005, 0), v3(0, -0.01, 0.05), v3(0, -0.055, 0.07)], 0.009, 5, 30)];
  mesh(merge(parts), body, g, cast);
  const clasp = merge([new BoxGeometry(0.09, 0.02, 0.03).translate(0, -0.075, -0.1), new BoxGeometry(0.09, 0.02, 0.03).translate(0, -0.075, 0.1)]);
  mesh(clasp, metal, g, false);
  return g;
}
