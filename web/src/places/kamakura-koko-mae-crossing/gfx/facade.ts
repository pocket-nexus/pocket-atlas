import { RepeatWrapping, ClampToEdgeWrapping, type Texture } from "three";
import { Rng } from "../../../core/random";
import { canvas, toTexture, type Ctx } from "../../shared/canvas";

/**
 * Facade atlas for the hillside villas and houses (1024², tinted per house
 * by vertex colour): one 10.4 m repeat of four 2.6 m bays across the width,
 * and per wall style a ground-floor row and an upper-floor row, each one
 * 2.9 m storey. Walls map u = metres / 10.4 (wrapping) and v inside a row,
 * so a facade is one quad per storey. Styles, from the photographs (p09,
 * p19, p01):
 *
 *   0 villa      white render, sliding glass doors below, picture windows
 *                behind glass balustrades above, slab bands
 *   1 house      siding, aluminium sashes with shutter boxes, a door
 *   2 apartment  a balcony slab, railing panel and sliding doors per floor
 *   3 resort     cream render, tall gridded windows, dark trim
 *
 * Bands at the bottom: parapet / plain wall, roof sheet, concrete plinth,
 * slab soffit.
 */
export const FACADE2 = {
  bay: 10.4,
  floor: 2.9,
  styles: 4,
} as const;

const W = 1024;
const H = 1024;
const ROW = 112;
const PX_M = W / 10.4;
const PY_M = ROW / 2.9;

/** Atlas v range of a wall row: style s, ground (0) or upper (1) storey. */
export function rowV(style: number, upper: boolean): [number, number] {
  const k = style * 2 + (upper ? 1 : 0);
  const y0 = k * ROW;
  // 3 px inside the row so filtering never reaches the neighbour.
  return [1 - (y0 + ROW - 3) / H, 1 - (y0 + 3) / H];
}

/** Atlas v of the plain bands (centre of each 32 px band). */
export const BAND = {
  plain: 1 - (896 + 16) / H,
  roof: 1 - (928 + 16) / H,
  plinth: 1 - (960 + 16) / H,
  soffit: 1 - (992 + 16) / H,
};

function glass(g: Ctx, x: number, y: number, w: number, h: number, r: Rng): void {
  const grd = g.createLinearGradient(x, y, x + w * 0.4, y + h);
  grd.addColorStop(0, "#9db3bf");
  grd.addColorStop(0.35, "#5d7380");
  grd.addColorStop(1, "#1d262c");
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  // Interior: curtains or blinds in some panes.
  if (r.chance(0.45)) {
    g.fillStyle = r.pick(["rgba(226,220,204,0.75)", "rgba(200,196,186,0.7)", "rgba(240,236,226,0.8)"]);
    const cw = w * r.range(0.2, 0.5);
    g.fillRect(r.chance(0.5) ? x : x + w - cw, y, cw, h);
  }
  // Reflection streak.
  g.fillStyle = "rgba(255,255,255,0.12)";
  g.beginPath();
  g.moveTo(x + w * 0.15, y);
  g.lineTo(x + w * 0.35, y);
  g.lineTo(x + w * 0.1, y + h);
  g.lineTo(x, y + h);
  g.lineTo(x, y + h * 0.6);
  g.closePath();
  g.fill();
}

/** A framed window in metres (x from the bay's left, y from the storey's floor up). */
function windowM(g: Ctx, r: Rng, bx: number, by: number, xm: number, ym: number, wm: number, hm: number, o: { frame: string; mullions: number; transom?: boolean; grid?: boolean; sill?: boolean }): void {
  const x = bx + xm * PX_M;
  const w = wm * PX_M;
  const y = by + ROW - (ym + hm) * PY_M;
  const h = hm * PY_M;
  // Reveal shadow, frame, glass.
  g.fillStyle = "rgba(0,0,0,0.22)";
  g.fillRect(x - 3, y - 2, w + 6, h + 4);
  g.fillStyle = o.frame;
  g.fillRect(x - 2, y - 2, w + 4, h + 4);
  glass(g, x + 2, y + 2, w - 4, h - 4, r);
  g.fillStyle = o.frame;
  for (let m = 1; m < o.mullions; m++) g.fillRect(x + (w * m) / o.mullions - 1.5, y, 3, h);
  if (o.transom) g.fillRect(x, y + h * 0.28, w, 2);
  if (o.grid) {
    g.fillStyle = "rgba(240,240,236,0.9)";
    for (let k = 1; k < 3; k++) g.fillRect(x + (w * k) / 3 - 1, y, 2, h);
    for (let k = 1; k < 3; k++) g.fillRect(x, y + (h * k) / 3 - 1, w, 2);
  }
  if (o.sill) {
    g.fillStyle = "rgba(0,0,0,0.25)";
    g.fillRect(x - 4, y + h + 2, w + 8, 2);
    g.fillStyle = "#c9cbc8";
    g.fillRect(x - 4, y + h, w + 8, 2);
  }
}

function slabBand(g: Ctx, y0: number, color: string): void {
  // A floor-slab band at the top of a storey with a soft shadow under it.
  g.fillStyle = color;
  g.fillRect(0, y0, W, 0.18 * PY_M);
  const grd = g.createLinearGradient(0, y0 + 0.18 * PY_M, 0, y0 + 0.6 * PY_M);
  grd.addColorStop(0, "rgba(0,0,0,0.16)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, y0 + 0.18 * PY_M, W, 0.42 * PY_M);
}

function wallBase(g: Ctx, y0: number, color: string, r: Rng, siding = false): void {
  g.fillStyle = color;
  g.fillRect(0, y0, W, ROW);
  // Faint render texture and run-off under the slab line.
  for (let i = 0; i < 220; i++) {
    g.fillStyle = `rgba(0,0,0,${r.range(0.01, 0.035)})`;
    g.fillRect(r.range(0, W), y0 + r.range(0, ROW), r.range(2, 10), r.range(2, 18));
  }
  if (siding) {
    for (let y = y0 + 4; y < y0 + ROW; y += 0.2 * PY_M) {
      g.fillStyle = "rgba(0,0,0,0.07)";
      g.fillRect(0, y, W, 1);
      g.fillStyle = "rgba(255,255,255,0.08)";
      g.fillRect(0, y + 1, W, 1);
    }
  }
}

function railing(g: Ctx, x: number, y: number, w: number, h: number, kind: "glass" | "bars"): void {
  if (kind === "glass") {
    g.fillStyle = "rgba(170,198,196,0.5)";
    g.fillRect(x, y, w, h);
    g.fillStyle = "rgba(255,255,255,0.18)";
    g.fillRect(x, y + 2, w, 2);
  } else {
    g.fillStyle = "rgba(70,74,78,0.9)";
    for (let b = x; b < x + w; b += 6) g.fillRect(b, y, 2, h);
  }
  g.fillStyle = "#8d9296";
  g.fillRect(x, y - 2, w, 3);
}

let cache: WeakMap<object, Texture> | null = null;

/** The facade atlas (drawn once per stage key). */
export function facadeAtlas(key: object): Texture {
  cache ??= new WeakMap();
  const done = cache.get(key);
  if (done) return done;
  const { c, g } = canvas(W, H);
  const r = new Rng(2905);
  const bays = [0, 1, 2, 3].map((i) => i * (W / 4));
  // ---- style 0: modern villa.
  {
    const y0 = 0;
    wallBase(g, y0, "#f1efe9", r);
    for (const bx of bays) {
      if (r.chance(0.65)) windowM(g, r, bx, y0, 0.25, 0.05, 2.1, 2.2, { frame: "#3a3d40", mullions: 2, sill: false });
      else windowM(g, r, bx, y0, 0.8, 0.9, 1.0, 1.2, { frame: "#3a3d40", mullions: 1, sill: true });
    }
    slabBand(g, y0, "#e6e4de");
    const y1 = ROW;
    wallBase(g, y1, "#f1efe9", r);
    for (const bx of bays) {
      const wide = r.chance(0.7);
      if (wide) {
        windowM(g, r, bx, y1, 0.2, 0.05, 2.2, 2.25, { frame: "#3a3d40", mullions: 3, transom: true });
        railing(g, bx + 0.12 * PX_M, y1 + ROW - 1.05 * PY_M, 2.36 * PX_M, 1.0 * PY_M, "glass");
      } else windowM(g, r, bx, y1, 0.75, 0.8, 1.1, 1.4, { frame: "#3a3d40", mullions: 2, sill: true });
    }
    slabBand(g, y1, "#e6e4de");
  }
  // ---- style 1: house with siding and sashes.
  {
    const y0 = 2 * ROW;
    wallBase(g, y0, "#ece9e2", r, true);
    bays.forEach((bx, i) => {
      if (i === 1) {
        // Entrance door under a small canopy.
        g.fillStyle = "#5b4636";
        g.fillRect(bx + 0.9 * PX_M, y0 + ROW - 2.1 * PY_M, 0.9 * PX_M, 2.1 * PY_M);
        g.fillStyle = "rgba(0,0,0,0.3)";
        g.fillRect(bx + 0.75 * PX_M, y0 + ROW - 2.35 * PY_M, 1.2 * PX_M, 0.12 * PY_M);
      } else if (r.chance(0.8)) windowM(g, r, bx, y0, 0.55, 0.9, 1.5, 1.1, { frame: "#a9adaf", mullions: 2, sill: true });
    });
    const y1 = 3 * ROW;
    wallBase(g, y1, "#ece9e2", r, true);
    for (const bx of bays) {
      if (r.chance(0.2)) continue;
      const w = r.chance(0.5) ? 1.6 : 0.9;
      const x = (2.6 - w) / 2;
      // Shutter box (雨戸) above the sash.
      g.fillStyle = "#8f9496";
      g.fillRect(bx + (x - 0.05) * PX_M, y1 + ROW - 2.25 * PY_M, (w + 0.1) * PX_M, 0.22 * PY_M);
      windowM(g, r, bx, y1, x, 0.9, w, 1.1, { frame: "#a9adaf", mullions: 2, sill: true });
      if (r.chance(0.35)) railing(g, bx + (x - 0.1) * PX_M, y1 + ROW - 1.35 * PY_M, (w + 0.2) * PX_M, 0.45 * PY_M, "bars");
    }
  }
  // ---- style 2: apartments with balconies.
  {
    const y0 = 4 * ROW;
    wallBase(g, y0, "#e2e3e2", r);
    for (const bx of bays) windowM(g, r, bx, y0, 0.3, 0.05, 2.0, 2.0, { frame: "#9ea3a5", mullions: 2 });
    const y1 = 5 * ROW;
    wallBase(g, y1, "#e2e3e2", r);
    for (const bx of bays) {
      windowM(g, r, bx, y1, 0.3, 0.05, 2.0, 2.0, { frame: "#9ea3a5", mullions: 2 });
      // Balcony: slab edge and a solid railing panel in front.
      g.fillStyle = r.chance(0.5) ? "#cfd2d2" : "#c0c5c7";
      g.fillRect(bx, y1 + ROW - 1.1 * PY_M, W / 4, 1.0 * PY_M);
      g.fillStyle = "rgba(0,0,0,0.12)";
      g.fillRect(bx, y1 + ROW - 1.12 * PY_M, W / 4, 2);
      if (r.chance(0.35)) {
        g.fillStyle = r.pick(["#e8e2d2", "#a8bccc", "#efe6d6", "#d9c3b0"]);
        g.fillRect(bx + r.range(20, 120), y1 + ROW - 1.4 * PY_M, r.range(30, 70), 0.35 * PY_M);
      }
    }
    slabBand(g, y1, "#d4d6d6");
  }
  // ---- style 3: resort villa, cream render with gridded windows and dark trim.
  {
    const y0 = 6 * ROW;
    wallBase(g, y0, "#f2e9d8", r);
    for (const bx of bays) windowM(g, r, bx, y0, 0.6, 0.6, 1.4, 1.7, { frame: "#f4f2ec", mullions: 1, grid: true, sill: true });
    g.fillStyle = "#8a5a44";
    g.fillRect(0, y0, W, 0.14 * PY_M);
    const y1 = 7 * ROW;
    wallBase(g, y1, "#f2e9d8", r);
    for (const bx of bays) {
      windowM(g, r, bx, y1, 0.6, 0.7, 1.4, 1.6, { frame: "#f4f2ec", mullions: 1, grid: true, sill: true });
      if (r.chance(0.4)) railing(g, bx + 0.4 * PX_M, y1 + ROW - 1.2 * PY_M, 1.8 * PX_M, 0.5 * PY_M, "bars");
    }
    g.fillStyle = "#8a5a44";
    g.fillRect(0, y1, W, 0.14 * PY_M);
  }
  // ---- bands: plain wall (parapets), roof sheet, plinth, soffit.
  wallBase(g, 896, "#efede7", r);
  g.fillStyle = "#c2c4c5";
  g.fillRect(0, 928, W, 32);
  g.fillStyle = "rgba(0,0,0,0.14)";
  for (let x = 0; x < W; x += 24) g.fillRect(x, 928, 2, 32);
  g.fillStyle = "#8e8c86";
  g.fillRect(0, 960, W, 32);
  g.fillStyle = "rgba(0,0,0,0.08)";
  for (let x = 0; x < W; x += 60) g.fillRect(x, 960, 2, 32);
  g.fillStyle = "#b9b8b3";
  g.fillRect(0, 992, W, 32);
  const t = toTexture(c, true);
  t.wrapS = RepeatWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.name = "kamakura-facades";
  cache.set(key, t);
  return t;
}
