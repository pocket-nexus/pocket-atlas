import { DoubleSide, MeshStandardMaterial } from "three";
import { extrudeEdges } from "../../../places/shared/atlas";
import { canvas, toTexture, type Ctx } from "../../../places/shared/canvas";
import type { Kit } from "./materials";
import { ATLAS, PAD, inner, type CellName } from "./plants-layout";

/**
 * The kit material of `gen/plants.ts`: one alpha-tested atlas of winter
 * trees (`plants`), painted here.
 *
 * The handheld shows a tree 100 m away through the atlas' fourth mip level,
 * where a twig a pixel wide has averaged away. So crowns are painted as
 * masses: dots and short strokes dense enough that a block of them keeps
 * more than half its coverage, thinning toward the crown's edge; at a
 * distance a tree narrows to its core instead of dissolving. The stands
 * (`clump*`) are denser still: they are only ever seen from afar.
 *
 * Colours are the trees' own under cloud (vertex colours only vary them):
 * larch twigs ochre-brown, birch crowns violet-brown on white limbs, fir
 * and spruce near-black green under snow. Estimated; no sampled values yet.
 */

type Rnd = () => number;
type RGB = readonly [number, number, number];

const lcg = (seed: number): Rnd => {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
};

/** Brightness of what is being painted: the back row of a stand is darker. */
let shade = 1;

function ink(c: RGB, k = 1): string {
  const f = k * shade;
  return `rgb(${Math.round(Math.min(255, c[0] * f))},${Math.round(Math.min(255, c[1] * f))},${Math.round(Math.min(255, c[2] * f))})`;
}

const LARCH_TWIG: RGB = [136, 111, 90];
const LARCH_INNER: RGB = [108, 92, 78];
const LARCH_BARK: RGB = [92, 74, 64];
const BIRCH_BARK: RGB = [226, 222, 212];
const BIRCH_TWIG: RGB = [122, 105, 101];
const OAK_BARK: RGB = [84, 77, 74];
const OAK_TWIG: RGB = [114, 108, 107];
const POPLAR_TWIG: RGB = [122, 108, 90];
const FIR: RGB = [42, 54, 52];
const FIR_DEEP: RGB = [27, 34, 35];
const SNOW: RGB = [238, 241, 246];
const SNOW_SHADE: RGB = [186, 198, 216];
const WILLOW: RGB = [122, 102, 90];
const WILLOW_YELLOW: RGB = [136, 124, 102];
const REED: RGB = [200, 174, 122];

function dot(g: Ctx, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

/** `n` dots scattered in an ellipse: a twig mass. */
function haze(g: Ctx, rnd: Rnd, x: number, y: number, rx: number, ry: number, n: number, c: RGB, size = 1.7): void {
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd());
    g.fillStyle = ink(c, 0.8 + 0.4 * rnd());
    dot(g, x + Math.cos(a) * rx * r, y + Math.sin(a) * ry * r, size * (0.7 + 0.7 * rnd()));
  }
}

function line(g: Ctx, x0: number, y0: number, x1: number, y1: number, w: number, style: string): void {
  g.strokeStyle = style;
  g.lineWidth = w;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}

/** A tapering trunk from the bottom centre up to `top` (px from the cell's top). */
function trunk(g: Ctx, cx: number, h: number, top: number, wb: number, wt: number, c: RGB, lean = 0): void {
  g.fillStyle = ink(c);
  g.beginPath();
  g.moveTo(cx - wb / 2, h);
  g.lineTo(cx + wb / 2, h);
  g.lineTo(cx + lean + wt / 2, top);
  g.lineTo(cx + lean - wt / 2, top);
  g.closePath();
  g.fill();
  // The side away from the brighter sky.
  g.fillStyle = ink(c, 0.78);
  g.beginPath();
  g.moveTo(cx + wb * 0.12, h);
  g.lineTo(cx + wb / 2, h);
  g.lineTo(cx + lean + wt / 2, top);
  g.lineTo(cx + lean + wt * 0.12, top);
  g.closePath();
  g.fill();
}

/**
 * A bare larch in a `w × h` box: the trunk to the tip, whorls of branches
 * that sag low on the tree and rise near the top, each carrying a band of
 * short twigs. `open` is the share of the height below the crown.
 */
function larch(g: Ctx, w: number, h: number, rnd: Rnd, o: { open: number; spread: number; fork?: boolean }): void {
  const cx = w / 2;
  const top = 5;
  const yb = h * (1 - o.open);
  const reach = (w / 2 - 4) * o.spread;
  const tw = Math.max(4, h * 0.021);
  // Dead stubs under the crown.
  for (let y = yb + 8; y < h - 60; y += 18 + rnd() * 30) {
    const s = rnd() < 0.5 ? -1 : 1;
    const l = 5 + rnd() * reach * 0.16;
    line(g, cx, y, cx + s * l, y + 1 + rnd() * 5, 1.8, ink(LARCH_BARK, 0.9));
  }
  const whorl = (y: number, t: number) => {
    const len = reach * Math.pow(1 - t, 0.72) * (0.72 + 0.4 * rnd()) + 5;
    for (const s of [-1, 1]) {
      if (rnd() < 0.07) continue;
      const l = len * (0.8 + 0.3 * rnd());
      const sag = (1 - t) * 0.42 - 0.2;
      const ex = cx + s * l;
      const ey = y + l * sag - l * 0.1;
      const mx = cx + s * l * 0.5;
      const my = y + l * sag * 0.75;
      g.strokeStyle = ink(LARCH_BARK, 0.95);
      g.lineWidth = 1.4 + 1.6 * (1 - t);
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(cx, y);
      g.quadraticCurveTo(mx, my, ex, ey);
      g.stroke();
      const n = Math.round(l * 0.95);
      for (let i = 0; i < n; i++) {
        const u = Math.pow(rnd(), 0.8);
        const px = cx + (2 * (1 - u) * u * (mx - cx) + u * u * (ex - cx));
        const py = y + (2 * (1 - u) * u * (my - y) + u * u * (ey - y));
        // Twigs hang under the branch more than they stand on it.
        const off = (rnd() - 0.3) * 8;
        const c = u < 0.3 ? LARCH_INNER : LARCH_TWIG;
        g.fillStyle = ink(c, 0.82 + 0.36 * rnd());
        dot(g, px + (rnd() - 0.5) * 5, py + off, 1.3 + 1.3 * rnd());
        if (rnd() < 0.3) line(g, px, py, px + (rnd() - 0.5) * 5, py + 3 + rnd() * 6, 1.3, ink(LARCH_TWIG, 0.8 + 0.3 * rnd()));
      }
      // A little snow lying on the branch.
      if (rnd() < 0.3 && l > 16) {
        const u = 0.25 + rnd() * 0.4;
        const px = cx + (2 * (1 - u) * u * (mx - cx) + u * u * (ex - cx));
        const py = y + (2 * (1 - u) * u * (my - y) + u * u * (ey - y));
        line(g, px - 4, py - 1.5, px + 4, py - 1.5 + s * sag * 4, 2, ink(SNOW, 0.97));
      }
    }
  };
  for (let y = yb; y > top + 4; ) {
    const t = (yb - y) / (yb - top);
    whorl(y, t);
    y -= 9 + 7 * rnd() * (1 - 0.5 * t);
  }
  trunk(g, cx, h, top, tw, 1.4, LARCH_BARK);
  if (o.fork) {
    // A leader lost and replaced by two.
    const y = top + (yb - top) * 0.22;
    line(g, cx, y, cx + 7, top + 6, 2, ink(LARCH_BARK));
    haze(g, rnd, cx + 8, top + 14, 7, 12, 40, LARCH_TWIG, 1.4);
  }
}

interface Limbs {
  rnd: Rnd;
  /** Bark of limbs wider than `pale`, and of the rest. */
  bark: RGB;
  twig: RGB;
  pale: number;
  spread: number;
  /** Pull toward upright per level. */
  rise: number;
  /** Twigs on the last limbs: how many on each, their length, how far they hang. */
  twigs: number;
  reach: number;
  droop: number;
  /** Dots of twig mass around each of the last limbs. */
  dots: number;
  /** Levels from the tips that carry twigs (default 2). */
  from?: number;
}

/**
 * A branching limb, `ang` from upright. The last three levels carry twigs:
 * strokes wide enough to hold through two mip levels, crossing into a web,
 * and a scatter of dots that keeps the crown's core once the strokes go.
 */
function limb(g: Ctx, x: number, y: number, ang: number, len: number, wd: number, depth: number, o: Limbs): void {
  const rnd = o.rnd;
  const bend = (rnd() - 0.5) * 0.3;
  const mx = x + Math.sin(ang + bend) * len * 0.5;
  const my = y - Math.cos(ang + bend) * len * 0.5;
  const x2 = x + Math.sin(ang) * len;
  const y2 = y - Math.cos(ang) * len;
  if (depth <= (o.from ?? 2)) {
    haze(g, rnd, (x + x2) / 2, (y + y2) / 2, o.reach * 1.1, o.reach * 0.9, o.dots, o.twig, 1.3);
    for (let i = 0; i < o.twigs; i++) {
      const t = 0.2 + 0.8 * rnd();
      const px = x + (x2 - x) * t;
      const py = y + (y2 - y) * t;
      const a = ang + (rnd() - 0.5) * 2.2;
      const l = o.reach * (0.5 + rnd());
      line(g, px, py, px + Math.sin(a) * l, py - Math.cos(a) * l + o.droop * rnd(), 1.5, ink(o.twig, 0.78 + 0.34 * rnd()));
    }
  }
  g.strokeStyle = wd > o.pale ? ink(o.bark, 0.92 + 0.1 * rnd()) : ink(o.twig, 0.8);
  g.lineWidth = Math.max(1.6, wd);
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(x, y);
  g.quadraticCurveTo(mx, my, x2, y2);
  g.stroke();
  if (depth === 0) return;
  const n = rnd() < 0.35 ? 3 : 2;
  for (let k = 0; k < n; k++) {
    const side = n === 2 ? (k === 0 ? -1 : 1) : k - 1;
    const a = ang * o.rise + side * o.spread * (0.55 + 0.6 * rnd()) + (rnd() - 0.5) * 0.2;
    limb(g, x2, y2, a, len * (0.62 + 0.2 * rnd()), wd * (n === 2 ? 0.7 : 0.62), depth - 1, o);
  }
}

/**
 * White birch: a slender white trunk to the top, ascending limbs from
 * `open` of the way up, every limb hung with fine dark twigs: a tall oval
 * crown, see-through at its edge.
 */
function birch(g: Ctx, w: number, h: number, rnd: Rnd, o: { open: number }): void {
  const cx = w / 2;
  const top = 18;
  const yb = h * (1 - o.open);
  const tw = Math.max(3.5, h * 0.017);
  const lim: Limbs = { rnd, bark: BIRCH_BARK, twig: BIRCH_TWIG, pale: 2.2, spread: 0.34, rise: 0.75, twigs: 7, reach: 10, droop: 9, dots: 10, from: 3 };
  // The crown first, so the white trunk lies over the twigs behind it.
  let side = rnd() < 0.5 ? -1 : 1;
  for (let y = yb; y > top + 16; y -= h * (0.035 + 0.03 * rnd())) {
    const t = (yb - y) / (yb - top);
    limb(g, cx, y, side * (0.62 - 0.3 * t + 0.2 * rnd()), h * 0.078 * (1 - 0.5 * t) * (0.8 + 0.4 * rnd()), tw * (0.62 - 0.3 * t), 3, lim);
    side = -side;
  }
  limb(g, cx, top + 20, 0, 12, 2, 2, lim);
  trunk(g, cx, h, top + 8, tw, 1.6, BIRCH_BARK);
  // Lenticel bands and the black scars under old branches.
  for (let y = top + 40; y < h; y += 5 + rnd() * 14) {
    const half = (tw * (0.2 + 0.8 * ((y - top) / (h - top)))) / 2;
    const l = half * (0.5 + rnd());
    const sd = rnd() < 0.5 ? -1 : 1;
    line(g, cx + sd * half, y, cx + sd * (half - l), y + (rnd() - 0.5), 1.4 + rnd() * 1.6, ink([52, 46, 46]));
  }
  // The foot darkens and roughens.
  g.fillStyle = ink([88, 80, 76]);
  g.fillRect(cx - tw / 2, h - h * 0.035, tw, h * 0.035);
}

/** A bare broadleaf of the mixed woods: stout dark trunk, a round crown of crooked limbs. */
function oak(g: Ctx, w: number, h: number, rnd: Rnd, o: { fork: number; reach: number }): void {
  const cx = w / 2;
  const yf = h * (1 - o.fork);
  const tw = Math.max(5, h * 0.034);
  const lim: Limbs = { rnd, bark: OAK_BARK, twig: OAK_TWIG, pale: 1.8, spread: 0.5, rise: 0.8, twigs: 6, reach: 11, droop: 1, dots: 10 };
  for (const a of [-0.95, -0.4, 0.08, 0.5, 1.0]) limb(g, cx, yf + (rnd() - 0.3) * h * 0.05, a + (rnd() - 0.5) * 0.2, h * 0.17 * o.reach * (1 - 0.4 * Math.abs(a)), tw * 0.6, 5, lim);
  trunk(g, cx, h, yf - h * 0.04, tw, tw * 0.7, OAK_BARK);
  // Snow in the fork.
  line(g, cx - tw * 0.3, yf - h * 0.035, cx + tw * 0.25, yf - h * 0.04, 2.2, ink(SNOW, 0.96));
}

/** Lombardy poplar: branches close to upright from low on the trunk. */
function poplar(g: Ctx, w: number, h: number, rnd: Rnd): void {
  const cx = w / 2;
  const top = 5;
  const y0 = h * 0.86;
  for (let y = y0; y > top + 10; y -= 5 + rnd() * 5) {
    const t = (y0 - y) / (y0 - top);
    const s = rnd() < 0.5 ? -1 : 1;
    // Widest a third of the way up, closing to a point.
    const girth = Math.sin(Math.PI * Math.min(1, 0.18 + t * 0.86)) * (w / 2 - 5);
    const len = Math.min(y - top, h * (0.1 + 0.16 * rnd()) * (1.15 - t * 0.5));
    const ex = cx + s * girth * (0.45 + 0.6 * rnd());
    const ey = y - len;
    g.strokeStyle = ink(OAK_BARK, 1.05);
    g.lineWidth = 1.2 + 1.4 * (1 - t);
    g.beginPath();
    g.moveTo(cx, y);
    g.quadraticCurveTo(cx + s * girth * 0.5, y - len * 0.25, ex, ey);
    g.stroke();
    const n = Math.round(len * 0.75);
    for (let i = 0; i < n; i++) {
      const u = 0.25 + 0.75 * rnd();
      const px = cx + (ex - cx) * (0.3 * u + 0.7 * u * u) + s * girth * 0.3 * u * (1 - u);
      const py = y - len * u;
      g.fillStyle = ink(POPLAR_TWIG, 0.8 + 0.4 * rnd());
      dot(g, px + (rnd() - 0.5) * 6, py + (rnd() - 0.5) * 5, 1.2 + 1.2 * rnd());
      if (rnd() < 0.35) line(g, px, py, px + s * rnd() * 3, py - 4 - rnd() * 6, 1.3, ink(POPLAR_TWIG, 0.85 + 0.3 * rnd()));
    }
  }
  trunk(g, cx, h, top + 4, Math.max(4, h * 0.026), 1.4, OAK_BARK);
}

/**
 * Fir or spruce with snow on it: tiers of boughs drawn from the top down so
 * each lies over the one above, every bough a dark fan with snow on its back.
 */
function spruce(g: Ctx, w: number, h: number, rnd: Rnd, o: { girth: number; droop: number; snow: number }): void {
  const cx = w / 2;
  const top = 4;
  const base = h * 0.95;
  const half = (w / 2 - 14) * o.girth;
  trunk(g, cx, h, base - 6, Math.max(4, h * 0.035), Math.max(3, h * 0.03), [70, 58, 52]);
  // The solid body behind the boughs.
  g.fillStyle = ink(FIR_DEEP);
  g.beginPath();
  g.moveTo(cx, top + 6);
  g.lineTo(cx + half * 0.82, base - 4);
  g.lineTo(cx - half * 0.82, base - 4);
  g.closePath();
  g.fill();
  line(g, cx, top, cx, top + 16, 2.4, ink(FIR));
  dot(g, cx, top + 2, 1.6);
  let step = h * 0.03;
  for (let y = top + 12; y < base; y += step) {
    const t = (y - top) / (base - top);
    const hw = half * Math.pow(t, 0.9) + 3;
    const rx = 5 + 9 * t + rnd() * 3;
    const n = Math.max(1, Math.round((2 * hw) / (rx * 1.25)));
    for (let k = 0; k < n; k++) {
      const u = n === 1 ? 0 : (k / (n - 1)) * 2 - 1;
      const x = cx + u * (hw - rx * 0.5) + (rnd() - 0.5) * rx * 0.5;
      const drop = Math.abs(u) * rx * o.droop + rnd() * 3;
      const ry = rx * (0.62 + 0.2 * rnd());
      const yy = y + drop;
      // The bough: dark, its lower edge fringed with needles.
      g.fillStyle = ink(FIR, 0.8 + 0.5 * rnd());
      g.beginPath();
      g.ellipse(x, yy, rx, ry, u * 0.35, 0, Math.PI * 2);
      g.fill();
      for (let i = 0; i < 5; i++) {
        g.fillStyle = ink(FIR, 0.7 + 0.5 * rnd());
        dot(g, x + (rnd() - 0.5) * rx * 2, yy + ry * (0.5 + 0.6 * rnd()), 1.6 + rnd() * 1.6);
      }
      if (rnd() < o.snow) {
        // Snow on its back, in the sky's shade at its lower edge.
        const sx = rx * (0.62 + 0.3 * rnd());
        const sy = ry * (0.42 + 0.2 * rnd());
        g.fillStyle = ink(SNOW_SHADE);
        g.beginPath();
        g.ellipse(x, yy - ry * 0.3, sx, sy, u * 0.35, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = ink(SNOW, 0.96 + 0.04 * rnd());
        g.beginPath();
        g.ellipse(x - u * 1.2, yy - ry * 0.3 - sy * 0.3, sx * 0.92, sy * 0.72, u * 0.35, 0, Math.PI * 2);
        g.fill();
      }
    }
    step = h * (0.03 + 0.035 * t) * (0.85 + 0.3 * rnd());
  }
}

/** Willow scrub: stems fanning from a stool, red-brown and yellow, twig masses at their ends. */
function shrub(g: Ctx, w: number, h: number, rnd: Rnd, stools = 3): void {
  for (let s = 0; s < stools; s++) {
    const bx = w * (0.5 + ((s + 0.5) / stools - 0.5) * 0.36) + (rnd() - 0.5) * 6;
    const c = rnd() < 0.4 ? WILLOW_YELLOW : WILLOW;
    const lim: Limbs = { rnd, bark: c, twig: c, pale: 9, spread: 0.26, rise: 0.9, twigs: 5, reach: 9, droop: -3, dots: 8 };
    const n = 5 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const a = ((k + 0.5) / n - 0.5) * 1.15 + (rnd() - 0.5) * 0.2;
      limb(g, bx + (rnd() - 0.5) * 6, h, a, h * (0.2 + 0.1 * rnd()) * (1 - 0.3 * Math.abs(a)), 2.6, 3, lim);
    }
  }
}

/** Reeds standing through the snow: straw stems, some broken, plumes at the tips. */
function reeds(g: Ctx, w: number, h: number, rnd: Rnd): void {
  for (let i = 0; i < 150; i++) {
    const x = 6 + rnd() * (w - 12);
    const mid = 1 - Math.abs(x / w - 0.5) * 0.9;
    const l = h * (0.35 + 0.6 * rnd()) * mid;
    const a = (rnd() - 0.5) * 0.5;
    const x2 = x + Math.sin(a) * l;
    const y2 = h - Math.cos(a) * l;
    const c = ink(REED, 0.72 + 0.4 * rnd());
    line(g, x, h, x2, y2, 1.6 + rnd(), c);
    if (rnd() < 0.5) {
      // A plume, bent over by the wind.
      g.fillStyle = ink(REED, 0.95 + 0.15 * rnd());
      g.beginPath();
      g.ellipse(x2 + 3, y2 + 1, 5 + rnd() * 3, 2.2, 0.5, 0, Math.PI * 2);
      g.fill();
    } else if (rnd() < 0.4) line(g, x2, y2, x2 + 6 + rnd() * 6, y2 + 4 + rnd() * 5, 1.5, c);
  }
  // The mass at the foot.
  haze(g, rnd, w / 2, h - 6, w * 0.42, 9, 220, REED, 2);
}

/** A garden evergreen under a cap of snow. */
function bush(g: Ctx, w: number, h: number, rnd: Rnd): void {
  const cx = w / 2;
  const rx = w * 0.4;
  const ry = h * 0.78;
  g.fillStyle = ink(FIR_DEEP, 1.2);
  g.beginPath();
  g.ellipse(cx, h, rx, ry, 0, Math.PI, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 260; i++) {
    const a = Math.PI + rnd() * Math.PI;
    const r = Math.sqrt(rnd());
    g.fillStyle = ink(FIR, 0.8 + 0.6 * rnd());
    dot(g, cx + Math.cos(a) * rx * r, h + Math.sin(a) * ry * r, 2 + rnd() * 2.5);
  }
  // The cap: thick on top, broken down the sides.
  g.fillStyle = ink(SNOW_SHADE);
  g.beginPath();
  g.ellipse(cx, h - ry * 0.56, rx * 0.86, ry * 0.42, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = ink(SNOW);
  g.beginPath();
  g.ellipse(cx, h - ry * 0.62, rx * 0.82, ry * 0.37, 0, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 26; i++) {
    const a = Math.PI + rnd() * Math.PI;
    g.fillStyle = ink(SNOW, 0.95 + 0.05 * rnd());
    g.beginPath();
    g.ellipse(cx + Math.cos(a) * rx * 0.8, h + Math.sin(a) * ry * (0.3 + 0.5 * rnd()), 5 + rnd() * 8, 3 + rnd() * 3, 0, 0, Math.PI * 2);
    g.fill();
  }
}

type Tree = (g: Ctx, w: number, h: number, rnd: Rnd) => void;

const LARCHES: Tree[] = [(g, w, h, r) => larch(g, w, h, r, { open: 0.3, spread: 1 }), (g, w, h, r) => larch(g, w, h, r, { open: 0.42, spread: 0.9, fork: true }), (g, w, h, r) => larch(g, w, h, r, { open: 0.22, spread: 0.95 })];
const BIRCHES: Tree[] = [(g, w, h, r) => birch(g, w, h, r, { open: 0.36 }), (g, w, h, r) => birch(g, w, h, r, { open: 0.46 })];
const SPRUCES: Tree[] = [(g, w, h, r) => spruce(g, w, h, r, { girth: 0.86, droop: 0.35, snow: 0.8 }), (g, w, h, r) => spruce(g, w, h, r, { girth: 1, droop: 0.75, snow: 0.72 })];
/** In a stand seen from afar the dark of the boughs carries, not the snow on them. */
const FAR_SPRUCES: Tree[] = [(g, w, h, r) => spruce(g, w, h, r, { girth: 0.86, droop: 0.35, snow: 0.5 }), (g, w, h, r) => spruce(g, w, h, r, { girth: 1, droop: 0.75, snow: 0.45 })];
const OAKS: Tree[] = [(g, w, h, r) => oak(g, w, h, r, { fork: 0.38, reach: 1 })];

/**
 * A stand as one card: a far mass of twigs and trunks, a back row in shade
 * and a front row, thick enough to hold together where single trees have
 * thinned away.
 */
function clump(g: Ctx, w: number, h: number, rnd: Rnd, o: { trees: Tree[]; ratio: number; mass: RGB; trunkBark: RGB; solid: boolean; rows: number[] }): void {
  // The rows behind: a ragged band of twig mass over a fence of trunks.
  for (let x = 4; x < w - 4; x += 5) {
    const u = x / w;
    const crest = (o.solid ? h * 0.42 : 0) + h * (0.14 + 0.1 * Math.sin(u * 9 + 1) * Math.sin(u * 23) + 0.06 * rnd()) + h * 0.5 * Math.pow(Math.abs(u - 0.5) * 2, 4);
    const foot = o.solid ? h : h * 0.62;
    for (let y = crest; y < foot; y += 4) {
      if (rnd() < 0.42) continue;
      g.fillStyle = ink(o.mass, 0.62 + 0.3 * rnd());
      dot(g, x + (rnd() - 0.5) * 5, y + (rnd() - 0.5) * 4, 2 + rnd() * 1.6);
    }
    if (!o.solid && rnd() < 0.8 && Math.abs(u - 0.5) < 0.46) line(g, x, h * 0.55, x + (rnd() - 0.5) * 4, h, 1.6 + rnd() * 1.6, ink(o.trunkBark, 0.7 + 0.25 * rnd()));
  }
  o.rows.forEach((n, row) => {
    shade = row === o.rows.length - 1 ? 1 : 0.8;
    for (let k = 0; k < n; k++) {
      const th = h * (row === o.rows.length - 1 ? 0.84 + 0.16 * rnd() : 0.72 + 0.2 * rnd());
      const tw = th * o.ratio;
      const x = tw / 2 + ((k + 0.5 + (rnd() - 0.5) * 0.5) / n) * (w - tw);
      g.save();
      g.translate(x - tw / 2, h - th);
      o.trees[Math.floor(rnd() * o.trees.length)](g, tw, th, rnd);
      g.restore();
    }
  });
  shade = 1;
  if (!o.solid) {
    // Undergrowth and saplings close the foot.
    for (let x = 8; x < w - 8; x += 3) if (rnd() < 0.75) line(g, x, h, x + (rnd() - 0.5) * 6, h - 6 - rnd() * h * 0.16, 1.6, ink(o.mass, 0.6 + 0.3 * rnd()));
  }
}

/** A strip of bark: furrows running up it. */
function bark(g: Ctx, w: number, h: number, rnd: Rnd, c: RGB, kind: "furrow" | "birch"): void {
  g.fillStyle = ink(c);
  g.fillRect(0, 0, w, h);
  if (kind === "furrow") {
    for (let i = 0; i < 46; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      line(g, x, y, x + (rnd() - 0.5) * 3, y + 10 + rnd() * 30, 1.5 + rnd() * 1.5, ink(c, rnd() < 0.6 ? 0.66 : 1.22));
    }
    // Snow driven into the furrows on one side.
    for (let i = 0; i < 12; i++) dot(g, w * 0.1 + rnd() * w * 0.12, rnd() * h, 1.2 + rnd() * 1.4);
  } else {
    for (let y = 2; y < h; y += 3 + rnd() * 9) {
      const x = rnd() * w;
      line(g, x, y, x + 5 + rnd() * 16, y + (rnd() - 0.5), 1.3 + rnd() * 1.8, ink([56, 50, 50]));
    }
    for (let i = 0; i < 5; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      g.fillStyle = ink([46, 42, 42]);
      g.beginPath();
      g.moveTo(x - 6, y);
      g.lineTo(x + 6, y);
      g.lineTo(x, y + 8);
      g.closePath();
      g.fill();
    }
    // Rough and dark at the foot.
    const grd = g.createLinearGradient(0, h * 0.82, 0, h);
    grd.addColorStop(0, "rgba(70,64,62,0)");
    grd.addColorStop(1, "rgba(70,64,62,0.9)");
    g.fillStyle = grd;
    g.fillRect(0, h * 0.82, w, h * 0.18);
  }
}

function paintAtlas(): HTMLCanvasElement {
  const { c, g } = canvas(ATLAS, ATLAS);
  g.clearRect(0, 0, ATLAS, ATLAS);
  const cell = (name: CellName, seed: number, paint: (g: Ctx, w: number, h: number, rnd: Rnd) => void) => {
    const r = inner(name);
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.translate(r.x, r.y);
    paint(g, r.w, r.h, lcg(seed));
    g.restore();
    extrudeEdges(g, r.x, r.y, r.w, r.h, PAD);
  };
  cell("larchA", 11, LARCHES[0]);
  cell("larchB", 23, LARCHES[1]);
  cell("larchC", 37, LARCHES[2]);
  cell("birchA", 41, BIRCHES[0]);
  cell("birchB", 53, BIRCHES[1]);
  cell("poplar", 61, poplar);
  cell("spruceA", 71, SPRUCES[0]);
  cell("spruceB", 83, SPRUCES[1]);
  cell("oak", 97, OAKS[0]);
  cell("clumpLarch", 101, (g, w, h, r) => clump(g, w, h, r, { trees: [LARCHES[0], LARCHES[2], LARCHES[0], BIRCHES[0]], ratio: 0.36, mass: [128, 100, 76], trunkBark: LARCH_BARK, solid: false, rows: [5, 4] }));
  cell("clumpMixed", 113, (g, w, h, r) => clump(g, w, h, r, { trees: [OAKS[0], BIRCHES[0], OAKS[0], LARCHES[2]], ratio: 0.6, mass: [104, 92, 90], trunkBark: OAK_BARK, solid: false, rows: [4, 3] }));
  cell("clumpConifer", 127, (g, w, h, r) => clump(g, w, h, r, { trees: FAR_SPRUCES, ratio: 0.46, mass: [34, 46, 44], trunkBark: [60, 52, 48], solid: true, rows: [5, 4] }));
  cell("shrub", 131, (g, w, h, r) => shrub(g, w, h, r));
  cell("reeds", 139, reeds);
  cell("bush", 149, bush);
  cell("barkLarch", 151, (g, w, h, r) => bark(g, w, h, r, LARCH_BARK, "furrow"));
  cell("barkBirch", 157, (g, w, h, r) => bark(g, w, h, r, BIRCH_BARK, "birch"));
  cell("barkDark", 163, (g, w, h, r) => bark(g, w, h, r, OAK_BARK, "furrow"));
  return c;
}

/** The kit materials of `gen/plants.ts` (trees, shrubs, woods, shelter belts). */
export function addPlantMaterials(kit: Kit): void {
  let c = paintAtlas();
  if (kit.textureSize < ATLAS) {
    const small = canvas(kit.textureSize, kit.textureSize);
    small.g.drawImage(c, 0, 0, kit.textureSize, kit.textureSize);
    c = small.c;
  }
  const map = toTexture(c, false, 4);
  map.name = "plants";
  kit.add("plants", new MeshStandardMaterial({ map, alphaTest: 0.5, side: DoubleSide, vertexColors: true, roughness: 1, metalness: 0 }));
}
