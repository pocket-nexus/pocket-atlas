import type { Texture } from "three";
import { Rng } from "../../../core/random";
import type { AtlasRect } from "../../shared/atlas";
import { canvas, toTexture, type Ctx } from "../../shared/canvas";

/**
 * Leaf atlas for the observatory grounds: one 1024² canvas drawn leaf by
 * leaf, cut out by alpha test. The late-summer chaparral of the photographs
 * (p03, p06, p17, p25) and the planting by the building (p04, p05, p19):
 *
 *   cypress  Italian cypress: dense scale-leaf sprays, upright, dark green
 *   shrub    laurel sumac / toyon: clusters of 5–10 cm leaves, olive
 *   shrub2   scrub oak / chamise: small dull leaves, darker
 *   sage     coastal sage: fine grey-green leaves
 *   oak      coast live oak canopy: small cupped holly-like leaves
 *   pine     stone / Aleppo pine needle tufts
 *   yucca    chaparral yucca: one stiff blue-grey sword leaf
 *   agave    agave: a broad tapered blue-grey leaf with a dark spine
 *   grass    a tuft of dry August grass
 *   core     a shrub's shaded interior
 *   bark     oak / pine bark (opaque)
 */
const SIZE = 1024;
const px = (x: number, y: number, w: number, h: number): AtlasRect => ({ u0: x / SIZE, u1: (x + w) / SIZE, v0: 1 - (y + h) / SIZE, v1: 1 - y / SIZE });

export const LEAF = {
  cypress: px(0, 0, 256, 512),
  shrub: px(256, 0, 256, 256),
  shrub2: px(512, 0, 256, 256),
  sage: px(768, 0, 256, 256),
  oak: px(256, 256, 256, 256),
  pine: px(512, 256, 256, 256),
  core: px(768, 256, 256, 256),
  yucca: px(0, 512, 128, 512),
  agave: px(128, 512, 128, 384),
  grass: px(256, 512, 256, 256),
  bark: px(516, 516, 120, 248),
};
export type LeafCell = keyof typeof LEAF;

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a})`;

/** A tapered blade from (x0, y0) along angle `a` (0 = up), bending by `bend` toward its tip. */
function blade(g: Ctx, x0: number, y0: number, a: number, len: number, w0: number, bend: number, fill: string): void {
  const steps = 10;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  let x = x0;
  let y = y0;
  let ang = a;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const w = w0 * (1 - Math.pow(t, 1.3)) * 0.5 + 0.3;
    const nx = Math.cos(ang);
    const ny = Math.sin(ang);
    left.push([x - nx * w, y - ny * w]);
    right.push([x + nx * w, y + ny * w]);
    x += Math.sin(ang) * (len / steps);
    y -= Math.cos(ang) * (len / steps);
    ang += bend / steps;
  }
  g.beginPath();
  g.moveTo(left[0][0], left[0][1]);
  for (const p of left) g.lineTo(p[0], p[1]);
  for (let i = right.length - 1; i >= 0; i--) g.lineTo(right[i][0], right[i][1]);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

/** Elliptic leaf with a midrib, base at the origin pointing along −y. */
function leaf(g: Ctx, len: number, h: number, s: number, l: number): void {
  const w = len * 0.34;
  g.fillStyle = hsl(h, s, l);
  g.beginPath();
  g.moveTo(0, 0);
  g.quadraticCurveTo(w, -len * 0.45, 0, -len);
  g.quadraticCurveTo(-w, -len * 0.45, 0, 0);
  g.fill();
  g.strokeStyle = hsl(h, s - 8, l - 7, 0.7);
  g.lineWidth = Math.max(0.6, len * 0.05);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, -len * 0.85);
  g.stroke();
}

/** A clump of leaf rosettes over the cell, back layer darker, gaps between lobes. */
function clump(g: Ctx, r: Rng, ox: number, oy: number, size: number, o: { n: number; leaves: [number, number]; len: [number, number]; h: number; s: number; l: number }): void {
  const cx = ox + size / 2;
  const cy = oy + size / 2;
  const lobes: [number, number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + r.range(-0.4, 0.4);
    const d = size * r.range(0.12, 0.25);
    lobes.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.9, size * r.range(0.14, 0.2)]);
  }
  const tips: [number, number, number, number][] = [];
  for (let k = 0; k < o.n; k++) {
    const [lx, ly, lr] = lobes[k % lobes.length];
    const a = r.range(0, Math.PI * 2);
    const d = Math.sqrt(r.next()) * lr;
    tips.push([lx + Math.cos(a) * d, ly + Math.sin(a) * d, r.range(0.8, 1.15), r.range(-7, 6)]);
  }
  g.lineCap = "round";
  for (const [tx, ty] of tips) {
    g.strokeStyle = "#3a2e22";
    g.lineWidth = 1.3 * (size / 256);
    g.beginPath();
    g.moveTo(tx + (cx - tx) * 0.35, ty + (cy + size * 0.2 - ty) * 0.35);
    g.lineTo(tx, ty);
    g.stroke();
  }
  for (const pass of [0, 1]) {
    for (const [tx, ty, sc, dl] of tips) {
      const count = r.int(o.leaves[0], o.leaves[1]);
      const high = 1 - (ty - oy) / size;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + r.range(-0.3, 0.3);
        const up = 0.5 - 0.5 * Math.sin(a);
        g.save();
        g.translate(tx + r.range(-2, 2), ty + r.range(-2, 2));
        g.rotate(a + Math.PI / 2);
        const l = o.l + dl + (pass ? 0 : -10) + up * 5 + high * 5 + r.range(-4, 4);
        leaf(g, r.range(o.len[0], o.len[1]) * sc * (pass ? 1 : 1.1), o.h + r.range(-6, 6), o.s + r.range(-5, 5), l);
        g.restore();
      }
    }
  }
}

/** Scale-leaf sprays (cypress): many short flattened fronds packed in an upright flame. */
function cypress(g: Ctx, r: Rng, ox: number, oy: number, w: number, h: number): void {
  const cx = ox + w / 2;
  for (let i = 0; i < 2600; i++) {
    const t = r.next();
    const y = oy + h * (0.02 + 0.96 * t);
    // Narrow flame: widest a third of the way up from the base, rounded tip.
    const prof = Math.sin(Math.PI * Math.min(1, (1 - t) * 1.08 + 0.02)) ** 0.7;
    const half = (w * 0.46) * prof;
    const x = cx + (r.next() * 2 - 1) * half * Math.sqrt(r.next());
    const edge = Math.abs(x - cx) / Math.max(1, half);
    const l = 17 + (1 - edge) * -5 + (1 - t) * 6 + r.range(-4, 5);
    g.save();
    g.translate(x, y);
    g.rotate(r.range(-0.5, 0.5) + (x - cx) * 0.004);
    blade(g, 0, 0, 0, r.range(7, 14), r.range(3, 5), r.range(-0.3, 0.3), hsl(r.range(95, 125), r.range(28, 40), l));
    g.restore();
  }
}

/** Needle tufts (pine): radiating needles from twig ends. */
function pine(g: Ctx, r: Rng, ox: number, oy: number, size: number): void {
  for (let k = 0; k < 26; k++) {
    const tx = ox + size * r.range(0.18, 0.82);
    const ty = oy + size * r.range(0.18, 0.82);
    const n = r.int(26, 40);
    for (let i = 0; i < n; i++) {
      const a = r.range(0, Math.PI * 2);
      blade(g, tx, ty, a, r.range(16, 30), 1.6, r.range(-0.15, 0.15), hsl(r.range(85, 105), r.range(25, 38), r.range(18, 30)));
    }
  }
}

/** Sword leaf (yucca / agave), base at the bottom of the cell. */
function sword(g: Ctx, ox: number, oy: number, w: number, h: number, width: number, h0: number, s0: number, l0: number, spine: boolean): void {
  const cx = ox + w / 2;
  const base = oy + h - 4;
  const grad = g.createLinearGradient(cx - width, 0, cx + width, 0);
  grad.addColorStop(0, hsl(h0, s0, l0 - 6));
  grad.addColorStop(0.5, hsl(h0, s0 - 4, l0 + 6));
  grad.addColorStop(1, hsl(h0, s0, l0 - 10));
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(cx - width / 2, base);
  g.quadraticCurveTo(cx - width * 0.55, oy + h * 0.45, cx, oy + 6);
  g.quadraticCurveTo(cx + width * 0.55, oy + h * 0.45, cx + width / 2, base);
  g.closePath();
  g.fill();
  if (spine) {
    g.strokeStyle = hsl(20, 30, 14);
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(cx, oy + 6);
    g.lineTo(cx, oy + 26);
    g.stroke();
    for (let y = oy + 40; y < base - 10; y += 22) {
      const t = (y - oy) / h;
      const hw = width * 0.5 * Math.min(1, t * 1.3);
      for (const s of [-1, 1]) {
        g.fillStyle = hsl(25, 25, 18);
        g.beginPath();
        g.moveTo(cx + s * hw, y);
        g.lineTo(cx + s * (hw + 4), y - 3);
        g.lineTo(cx + s * hw, y - 6);
        g.fill();
      }
    }
  }
}

/** Dry grass tuft: thin arching blades from one root. */
function grassTuft(g: Ctx, r: Rng, ox: number, oy: number, size: number): void {
  for (let i = 0; i < 140; i++) {
    const x = ox + size / 2 + r.range(-size * 0.12, size * 0.12);
    const a = r.range(-0.7, 0.7);
    blade(g, x, oy + size - 4, a, r.range(size * 0.4, size * 0.9), r.range(2, 3.4), a * r.range(0.3, 1.2), hsl(r.range(36, 50), r.range(30, 45), r.range(34, 56)));
  }
}

function coreMat(g: Ctx, r: Rng, ox: number, oy: number, size: number): void {
  const cx = ox + size / 2;
  const cy = oy + size / 2;
  for (let i = 0; i < 900; i++) {
    const a = r.range(0, Math.PI * 2);
    const d = Math.pow(r.next(), 0.6) * size * 0.46;
    g.save();
    g.translate(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
    g.rotate(r.range(0, Math.PI * 2));
    leaf(g, r.range(10, 18), r.range(80, 100), 28, r.range(9, 16));
    g.restore();
  }
}

function bark(g: Ctx, r: Rng, ox: number, oy: number, w: number, h: number): void {
  g.fillStyle = "#3b3128";
  g.fillRect(ox, oy, w, h);
  for (let i = 0; i < 260; i++) {
    const x = ox + r.next() * w;
    const y = oy + r.next() * h;
    g.fillStyle = r.chance(0.5) ? "rgba(20,15,10,0.6)" : "rgba(110,95,80,0.35)";
    g.fillRect(x, y, r.range(2, 8), r.range(8, 30));
  }
}

/** Paints the leaf atlas once per stage. */
export function leafAtlas(): Texture {
  const { c, g } = canvas(SIZE, SIZE);
  g.clearRect(0, 0, SIZE, SIZE);
  const r = new Rng(1934);
  const clip = (cell: AtlasRect, draw: (x: number, y: number, w: number, h: number) => void) => {
    const x = cell.u0 * SIZE;
    const y = (1 - cell.v1) * SIZE;
    const w = (cell.u1 - cell.u0) * SIZE;
    const h = (cell.v1 - cell.v0) * SIZE;
    g.save();
    g.beginPath();
    g.rect(x + 2, y + 2, w - 4, h - 4);
    g.clip();
    draw(x, y, w, h);
    g.restore();
  };
  clip(LEAF.cypress, (x, y, w, h) => cypress(g, r, x, y, w, h));
  clip(LEAF.shrub, (x, y, w) => clump(g, r, x, y, w, { n: 34, leaves: [6, 9], len: [16, 24], h: 78, s: 30, l: 27 }));
  clip(LEAF.shrub2, (x, y, w) => clump(g, r, x, y, w, { n: 60, leaves: [8, 12], len: [7, 11], h: 70, s: 24, l: 22 }));
  clip(LEAF.sage, (x, y, w) => clump(g, r, x, y, w, { n: 70, leaves: [8, 12], len: [6, 10], h: 85, s: 12, l: 42 }));
  clip(LEAF.oak, (x, y, w) => clump(g, r, x, y, w, { n: 70, leaves: [7, 10], len: [8, 12], h: 92, s: 32, l: 20 }));
  clip(LEAF.pine, (x, y, w) => pine(g, r, x, y, w));
  clip(LEAF.core, (x, y, w) => coreMat(g, r, x, y, w));
  clip(LEAF.yucca, (x, y, w, h) => sword(g, x, y, w, h, 34, 165, 14, 50, false));
  clip(LEAF.agave, (x, y, w, h) => sword(g, x, y, w, h, 96, 170, 16, 48, true));
  clip(LEAF.grass, (x, y, w) => grassTuft(g, r, x, y, w));
  clip(LEAF.bark, (x, y, w, h) => bark(g, r, x, y, w, h));
  const atlas = toTexture(c);
  atlas.name = "griffith-leaves";
  return atlas;
}
