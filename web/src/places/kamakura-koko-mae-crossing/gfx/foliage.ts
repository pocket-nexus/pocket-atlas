import type { Texture } from "three";
import { Rng } from "../../../core/random";
import { canvas, toTexture, type Ctx } from "../../shared/canvas";

/**
 * Leaf atlas for the gardens, the park and the grass banks: one 1024² canvas
 * drawn leaf by leaf, cut out by alpha test (BC3 on the handheld). Cells:
 *
 *   fan      fan-palm leaf (シュロ): a pleated fan of 52 segments with split, drooping tips
 *   cycad    cycad frond (ソテツ): a rachis with stiff needle leaflets swept forward
 *   tall     tall grass (ススキ / チガヤ): long arching blades from one root
 *   shrub    broadleaf clump (トベラ): five or six rosettes of 4–6 cm glossy leaves at twig ends, gaps between
 *   shrub2   the same with pale new growth on top
 *   small    small-leaved clump (ツツジ / ツゲ): sub-clusters of 1.5–2.5 cm leaves
 *   core     a shrub's shaded interior: dense dark leaves, ragged edge
 *   hedge    clipped-hedge leaf mat (small leaves) for the hedges' ragged outline
 *   grass    short lawn-edge tuft of thin blades
 *   palmBark fibrous palm trunk (opaque)
 *   cycadBark scaled cycad trunk (opaque)
 *   box      small-leaved shrub clump, darker
 */
export interface Cell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const SIZE = 1024;
const px = (x: number, y: number, w: number, h: number): Cell => ({ u0: x / SIZE, u1: (x + w) / SIZE, v0: 1 - (y + h) / SIZE, v1: 1 - y / SIZE });

export const LEAF = {
  fan: px(0, 0, 512, 512),
  shrub: px(512, 0, 256, 256),
  shrub2: px(768, 0, 256, 256),
  small: px(512, 256, 256, 256),
  core: px(768, 256, 256, 256),
  cycad: px(0, 512, 256, 512),
  tall: px(256, 512, 256, 512),
  hedge: px(512, 512, 256, 256),
  grass: px(768, 512, 256, 256),
  palmBark: px(516, 772, 120, 248),
  cycadBark: px(644, 772, 120, 248),
  box: px(768, 768, 256, 256),
};
export type LeafCell = keyof typeof LEAF;

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a})`;

/** A tapered blade from (x0, y0) along angle `a` (radians, 0 = up), bending by `bend` toward its tip. */
function blade(g: Ctx, x0: number, y0: number, a: number, len: number, w0: number, bend: number, fill: string): void {
  const steps = 8;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  let x = x0;
  let y = y0;
  let ang = a;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const w = w0 * (1 - Math.pow(t, 1.4)) * 0.5 + 0.3;
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

/** Obovate leaf with a midrib, base at the origin pointing along −y. */
function leaf(g: Ctx, len: number, h: number, s: number, l: number, glossy: boolean): void {
  const w = len * 0.36;
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(w * 0.9, -len * 0.25, w * 1.1, -len * 0.8, 0, -len);
  g.bezierCurveTo(-w * 1.1, -len * 0.8, -w * 0.9, -len * 0.25, 0, 0);
  const grd = g.createLinearGradient(-w, 0, w, -len);
  grd.addColorStop(0, hsl(h, s, l - 6));
  grd.addColorStop(0.5, hsl(h + 3, s + 4, l + (glossy ? 8 : 3)));
  grd.addColorStop(1, hsl(h - 2, s, l - 3));
  g.fillStyle = grd;
  g.fill();
  g.strokeStyle = hsl(h + 6, s - 10, l + 16, 0.55);
  g.lineWidth = Math.max(0.8, len * 0.035);
  g.beginPath();
  g.moveTo(0, -len * 0.05);
  g.lineTo(0, -len * 0.9);
  g.stroke();
}

function fanPalm(g: Ctx, r: Rng): void {
  const cx = 256;
  const hy = 280;
  // Petiole from the cell's foot to the hastula.
  g.strokeStyle = "#4f5a2a";
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(cx, 508);
  g.lineTo(cx, hy + 6);
  g.stroke();
  const n = 48;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Fan spans 240° centred on up; outer segments droop. Each segment is a narrow pleated
    // blade split from its neighbours over the outer half, so light shows between them.
    const a = (-120 + t * 240) * (Math.PI / 180) + r.range(-0.02, 0.02);
    const edge = Math.abs(t - 0.5) * 2;
    const len = r.range(215, 250) * (1 - edge * 0.1);
    const droop = (t < 0.5 ? -1 : 1) * (0.25 + edge * 0.5) + r.range(-0.1, 0.1);
    const light = 27 + r.range(-4, 6) + (1 - edge) * 6;
    const hue = r.range(84, 96);
    // Joined base (a solid inner disc) and the free outer segment.
    blade(g, cx, hy, a, len * 0.42, 22, droop * 0.15, hsl(hue, r.range(34, 44), light - 3));
    blade(g, cx, hy, a, len * 0.8, 11, droop * 0.5, hsl(hue, r.range(34, 44), light - 1));
    // Pleat highlight down the segment's midrib.
    blade(g, cx, hy, a + 0.01, len * 0.72, 2.5, droop * 0.5, hsl(84, 30, light + 15, 0.6));
    // Split tip: two thin drooping ends past the fan's rim.
    const ex = cx + Math.sin(a) * len * 0.76;
    const ey = hy - Math.cos(a) * len * 0.76;
    for (const sp of [-0.14, 0.14]) blade(g, ex, ey, a + sp + droop * 0.4, len * 0.26, 3.5, droop * 0.9, hsl(r.range(80, 92), 36, light - 3));
  }
  // Hastula: the dark crease at the fan's centre.
  g.fillStyle = "#3a4520";
  g.beginPath();
  g.ellipse(cx, hy, 10, 6, 0, 0, Math.PI * 2);
  g.fill();
}

/**
 * A clump of rosettes: `n` twig tips packed into a rounded, lumpy patch of
 * the cell, each a whorl of leaves radiating from the tip, lit from above
 * (upper leaves lighter, a darker back layer), with small gaps between
 * rosettes so the card's outline breaks up.
 */
function clump(g: Ctx, r: Rng, ox: number, oy: number, size: number, o: { n: number; leaves: [number, number]; len: [number, number]; h: number; s: number; l: number; fresh?: number; glossy?: boolean }): void {
  const cx = ox + size / 2;
  const cy = oy + size / 2;
  g.lineCap = "round";
  // Tips: a few lobes (sub-clumps), rosettes packed round each.
  const lobes: [number, number, number][] = [];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + r.range(-0.4, 0.4);
    const d = size * r.range(0.14, 0.25);
    lobes.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.9, size * r.range(0.15, 0.21)]);
  }
  const tips: [number, number, number, number][] = [];
  for (let k = 0; k < o.n; k++) {
    const [lx, ly, lr] = lobes[k % lobes.length];
    const a = r.range(0, Math.PI * 2);
    const d = Math.sqrt(r.next()) * lr;
    tips.push([lx + Math.cos(a) * d, ly + Math.sin(a) * d, r.range(0.8, 1.15), r.range(-8, 6)]);
  }
  // Short twigs into each rosette, mostly hidden by the leaves.
  for (const [tx, ty] of tips) {
    g.strokeStyle = "#3e3226";
    g.lineWidth = 1.4 * (size / 256);
    g.beginPath();
    g.moveTo(tx + (cx - tx) * 0.35, ty + (cy + size * 0.2 - ty) * 0.35);
    g.lineTo(tx, ty);
    g.stroke();
  }
  // Back leaves first (darker, deeper), then the front ones; upper rosettes lighter.
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
        const fresh = o.fresh && pass && up > 0.5 && high > 0.45 && r.chance(o.fresh);
        // Each rosette its own light (some in a neighbour's shade), the back layer darker.
        const l = o.l + dl + (pass ? 0 : -11) + up * 6 + high * 5 + r.range(-4, 4);
        leaf(g, r.range(o.len[0], o.len[1]) * sc * (pass ? 1 : 1.1), fresh ? o.h - 14 : o.h + r.range(-6, 6), fresh ? o.s + 12 : o.s + r.range(-5, 5), fresh ? l + 12 : l, o.glossy ?? true);
        g.restore();
      }
    }
  }
}

/** A shrub's shaded interior: dense leaves filling the cell to a ragged edge, dark. */
function coreMat(g: Ctx, r: Rng, ox: number, oy: number, size: number): void {
  const cx = ox + size / 2;
  const cy = oy + size / 2;
  for (let i = 0; i < 900; i++) {
    const a = r.range(0, Math.PI * 2);
    const d = Math.pow(r.next(), 0.6) * size * 0.46;
    g.save();
    g.translate(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
    g.rotate(r.range(0, Math.PI * 2));
    leaf(g, r.range(12, 20), r.range(90, 104), r.range(38, 50), r.range(15, 22), false);
    g.restore();
  }
}

function cycadFrond(g: Ctx, r: Rng): void {
  const cx = 128;
  const y0 = 1018;
  const y1 = 524;
  g.strokeStyle = "#5a5a2c";
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(cx, y0);
  g.lineTo(cx, y1);
  g.stroke();
  const pairs = 64;
  for (let i = 0; i < pairs; i++) {
    const t = i / (pairs - 1);
    const y = y0 - 40 - t * (y0 - y1 - 50);
    // Leaflets: short at the base and tip, longest at a third; swept toward the tip.
    const len = 112 * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * t)), 0.7) * r.range(0.9, 1.05) + 6;
    const light = r.range(20, 30);
    for (const s of [-1, 1]) {
      const a = s * r.range(1.0, 1.15);
      blade(g, cx + s * 2, y, a, len, 5.5, -s * 0.12, hsl(r.range(92, 104), r.range(40, 52), light));
      blade(g, cx + s * 2, y - 1, a, len * 0.85, 1.4, -s * 0.12, hsl(90, 30, light + 16, 0.55));
    }
  }
}

function tallGrass(g: Ctx, r: Rng): void {
  for (let i = 0; i < 70; i++) {
    const x = 384 + r.range(-26, 26);
    const a = r.range(-0.4, 0.4);
    const len = r.range(220, 460);
    const bend = (a >= 0 ? 1 : -1) * r.range(0.2, 0.7);
    blade(g, x, 1020, a, len, r.range(6, 10), bend, hsl(r.range(70, 92), r.range(34, 48), r.range(30, 46)));
  }
  // Pale dry blades among the green.
  for (let i = 0; i < 12; i++) {
    const a = r.range(-0.6, 0.6);
    blade(g, 384 + r.range(-20, 20), 1020, a, r.range(180, 380), 5, (a >= 0 ? 1 : -1) * r.range(0.4, 1.2), hsl(48, 30, r.range(52, 62)));
  }
}

function hedgeMat(g: Ctx, r: Rng, ox: number, oy: number, size: number, h: number, l: number, len: [number, number], n: number, round: boolean): void {
  const cx = ox + size / 2;
  const cy = oy + size / 2;
  for (let i = 0; i < n; i++) {
    let x: number;
    let y: number;
    if (round) {
      const a = r.range(0, Math.PI * 2);
      const d = Math.sqrt(r.next()) * size * 0.43;
      x = cx + Math.cos(a) * d;
      y = cy + Math.sin(a) * d * 0.85;
    } else {
      // A clipped-hedge mat: leaves fill the cell, thinning to a ragged edge.
      x = ox + r.range(0.04, 0.96) * size;
      y = oy + r.range(0.04, 0.96) * size;
      const e = Math.min(x - ox, ox + size - x, y - oy, oy + size - y) / (size * 0.5);
      if (r.next() > 0.25 + e * 2.2) continue;
    }
    g.save();
    g.translate(x, y);
    g.rotate(r.range(0, Math.PI * 2));
    const up = 1 - (y - oy) / size;
    leaf(g, r.range(len[0], len[1]), h + r.range(-8, 8), r.range(28, 42), l + r.range(-7, 7) + up * 5, false);
    g.restore();
  }
}

function grassTuft(g: Ctx, r: Rng): void {
  for (let i = 0; i < 150; i++) {
    const x = 896 + r.range(-80, 80);
    const a = r.range(-0.45, 0.45) + (x - 896) / 320;
    blade(g, x, 764, a, r.range(50, 210), r.range(2.2, 4), a * r.range(0.5, 1.6), hsl(r.range(66, 96), r.range(34, 52), r.range(24, 46)));
  }
  for (let i = 0; i < 14; i++) {
    const a = r.range(-0.7, 0.7);
    blade(g, 896 + r.range(-60, 60), 764, a, r.range(60, 160), 2.5, a * 1.4, hsl(48, 30, r.range(50, 62)));
  }
}

function palmBark(g: Ctx, r: Rng): void {
  const [x0, y0, w, h] = [516, 772, 120, 248];
  g.fillStyle = "#4a3a2c";
  g.fillRect(x0 - 4, y0 - 4, w + 8, h + 8);
  // Fibre mat and old leaf bases in rings.
  for (let i = 0; i < 1600; i++) {
    const x = x0 + r.range(0, w);
    const y = y0 + r.range(0, h);
    g.strokeStyle = hsl(r.range(22, 34), r.range(18, 30), r.range(16, 34), 0.8);
    g.lineWidth = r.range(0.8, 1.8);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + r.range(-6, 6), y + r.range(6, 16));
    g.stroke();
  }
  for (let y = y0 + 6; y < y0 + h; y += 14) {
    g.fillStyle = "rgba(30,22,16,0.45)";
    g.fillRect(x0 - 4, y + r.range(-2, 2), w + 8, 3);
  }
}

function cycadBark(g: Ctx, r: Rng): void {
  const [x0, y0, w, h] = [644, 772, 120, 248];
  g.fillStyle = "#4a3e31";
  g.fillRect(x0 - 4, y0 - 4, w + 8, h + 8);
  // Diamond leaf-base scales.
  for (let row = 0; row < 22; row++)
    for (let col = 0; col < 9; col++) {
      const x = x0 + col * 14 + (row % 2) * 7;
      const y = y0 + row * 12;
      g.fillStyle = hsl(r.range(26, 38), r.range(16, 28), r.range(26, 40));
      g.beginPath();
      g.moveTo(x, y - 6);
      g.lineTo(x + 7, y);
      g.lineTo(x, y + 6);
      g.lineTo(x - 7, y);
      g.closePath();
      g.fill();
    }
}

/** Paints the leaf atlas (the stage's `CoastLib.foliage()` draws it once). */
export function leafAtlas(): Texture {
  const { c, g } = canvas(SIZE, SIZE);
  g.clearRect(0, 0, SIZE, SIZE);
  const r = new Rng(1883);
  // Each cell is drawn clipped to itself (2 px in), so mips and cards never pick up a neighbour.
  const clip = (c: Cell, draw: () => void) => {
    g.save();
    g.beginPath();
    g.rect(c.u0 * SIZE + 2, (1 - c.v1) * SIZE + 2, (c.u1 - c.u0) * SIZE - 4, (c.v1 - c.v0) * SIZE - 4);
    g.clip();
    draw();
    g.restore();
  };
  clip(LEAF.fan, () => fanPalm(g, r));
  clip(LEAF.shrub, () => clump(g, r, 512, 0, 256, { n: 32, leaves: [7, 10], len: [15, 22], h: 95, s: 46, l: 30 }));
  clip(LEAF.shrub2, () => clump(g, r, 768, 0, 256, { n: 30, leaves: [7, 10], len: [15, 22], h: 92, s: 48, l: 31, fresh: 0.35 }));
  clip(LEAF.small, () => clump(g, r, 512, 256, 256, { n: 60, leaves: [9, 13], len: [7, 11], h: 98, s: 42, l: 27, glossy: false }));
  clip(LEAF.core, () => coreMat(g, r, 768, 256, 256));
  clip(LEAF.cycad, () => cycadFrond(g, r));
  clip(LEAF.tall, () => tallGrass(g, r));
  clip(LEAF.hedge, () => hedgeMat(g, r, 512, 512, 256, 92, 24, [7, 12], 2600, false));
  clip(LEAF.grass, () => grassTuft(g, r));
  clip(LEAF.palmBark, () => palmBark(g, r));
  clip(LEAF.cycadBark, () => cycadBark(g, r));
  clip(LEAF.box, () => hedgeMat(g, r, 768, 768, 256, 100, 24, [8, 13], 1700, true));
  const atlas = toTexture(c);
  atlas.name = "kamakura-leaves";
  return atlas;
}
