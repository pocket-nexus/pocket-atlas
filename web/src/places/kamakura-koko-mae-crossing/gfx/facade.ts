import { RepeatWrapping, ClampToEdgeWrapping, type Texture } from "three";
import { Rng } from "../../../core/random";
import { canvas, toTexture, type Ctx } from "../../shared/canvas";

/**
 * Facade atlas for the hillside villas, houses and apartments, laid out on
 * a 4096² pixel grid and painted at 4096² on high and ultra (the cooker
 * keeps 2048² from a source this size, about 95 texels a metre across and
 * 88 up) and at twice the preset's texture size below; tinted per building
 * by vertex colour.
 *
 * Seven storey rows of eight 2.6 m bays (one 20.8 m repeat across the
 * width, so a flat wall is one quad per storey with u wrapping), each row
 * one 2.9 m storey; then the bands (plain render, roof sheet, plinth,
 * soffit, window reveal, aluminium, coping) and a strip of props (balcony
 * panel, air-conditioner faces, meter box). From the photographs (p09,
 * p10, p13, p17):
 *
 *   0 villa ground   white render, sliding glass doors, picture windows, entrance door
 *   1 villa upper    tall dark-framed windows (behind balconies), picture and bathroom windows
 *   2 house ground   lap siding, aluminium sashes under rain-shutter boxes (雨戸), the door
 *   3 house upper    the same upstairs, a balcony door
 *   4 apartment      balcony side: a sliding door per bay
 *   5 apartment back corridor side: steel doors and small barred windows
 *   6 cladding       dark vertical boards with slit windows (the villa accents in p09)
 *
 * Window positions live in `LAYOUT`, which the atlas paints and the
 * building builder reads: walls near the viewpoints cut each window out,
 * line the opening with reveals and set the painted window back 0.14 m as
 * a glass pane (same texture, smooth material that reflects the sky).
 */
export const FACADE = {
  bay: 2.6,
  bays: 8,
  floor: 2.9,
  repeat: 20.8,
  rows: 7,
} as const;

export const ROWS = { villaG: 0, villaU: 1, houseG: 2, houseU: 3, apt: 4, aptBack: 5, clad: 6 } as const;

export type WinKind = "slide" | "picture" | "tall" | "sash" | "small" | "frosted" | "door" | "steel" | "slit";

/** A window in a bay: metres from the bay's left edge and the storey's floor. */
export interface Win {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: WinKind;
  /** Sill below (projecting, with run-off streaks under it). */
  sill?: boolean;
  /** Rain-shutter box (雨戸) above the opening. */
  shutter?: boolean;
  /** Canopy over a door. */
  hood?: boolean;
  /** Steel grille (面格子) over the glass. */
  grille?: boolean;
}

const slide = (o: Partial<Win> = {}): Win => ({ x: 0.2, y: 0.04, w: 2.2, h: 2.15, kind: "slide", ...o });
const picture = (o: Partial<Win> = {}): Win => ({ x: 0.7, y: 0.85, w: 1.2, h: 1.3, kind: "picture", sill: true, ...o });
const tall = (o: Partial<Win> = {}): Win => ({ x: 0.2, y: 0.04, w: 2.2, h: 2.3, kind: "tall", ...o });
const sash = (o: Partial<Win> = {}): Win => ({ x: 0.5, y: 0.85, w: 1.6, h: 1.1, kind: "sash", sill: true, shutter: true, ...o });
const small = (o: Partial<Win> = {}): Win => ({ x: 0.9, y: 1.05, w: 0.8, h: 0.9, kind: "small", sill: true, grille: true, ...o });
const frosted = (o: Partial<Win> = {}): Win => ({ x: 1.0, y: 1.4, w: 0.6, h: 0.65, kind: "frosted", sill: true, ...o });
const door = (o: Partial<Win> = {}): Win => ({ x: 0.85, y: 0.02, w: 0.92, h: 2.15, kind: "door", hood: true, ...o });
const steel = (o: Partial<Win> = {}): Win => ({ x: 0.5, y: 0.02, w: 0.85, h: 2.0, kind: "steel", hood: false, ...o });
const slit = (o: Partial<Win> = {}): Win => ({ x: 1.05, y: 0.3, w: 0.5, h: 2.2, kind: "slit", ...o });

/** Windows per row and bay (null: plain wall). */
export const LAYOUT: (Win | null)[][] = [
  // 0 villa ground (bay 4: the dark-boarded wing, a slit window)
  [slide(), picture(), slide(), door(), slit({ x: 1.0, w: 0.55 }), slide({ x: 0.3, w: 2.0 }), small(), picture({ x: 0.6, w: 1.4 })],
  // 1 villa upper
  [tall(), tall(), picture({ x: 0.6, w: 1.4, h: 1.4, y: 0.8 }), frosted(), slit({ x: 1.0, w: 0.55 }), null, tall({ x: 0.3, w: 2.0 }), picture()],
  // 2 house ground
  [sash(), door({ x: 0.8, w: 0.9, h: 2.1 }), small(), slide({ x: 0.3, w: 2.0, h: 2.0, shutter: true }), sash(), frosted({ x: 1.0, y: 1.5 }), slide({ x: 0.3, w: 2.0, h: 2.0, shutter: true }), null],
  // 3 house upper
  [sash(), small({ grille: false }), slide({ x: 0.3, w: 2.0, h: 2.0, shutter: true }), null, sash(), frosted(), sash({ x: 0.9, w: 0.9 }), sash()],
  // 4 apartment, balcony side
  [slide({ x: 0.25, w: 2.1, h: 2.05 }), slide({ x: 0.25, w: 2.1, h: 2.05 }), slide({ x: 0.25, w: 2.1, h: 2.05 }), slide({ x: 0.25, w: 2.1, h: 2.05 }), slide({ x: 0.25, w: 2.1, h: 2.05 }), slide({ x: 0.25, w: 2.1, h: 2.05 }), slide({ x: 0.25, w: 2.1, h: 2.05 }), slide({ x: 0.25, w: 2.1, h: 2.05 })],
  // 5 apartment, corridor side
  [steel(), small({ x: 1.5 }), steel({ x: 0.4 }), small({ x: 1.45, grille: true }), null, steel(), small({ x: 1.5 }), frosted({ x: 1.2 })],
  // 6 cladding
  [slit(), null, slit({ x: 0.4, w: 0.6 }), slit({ x: 1.6, w: 0.6 }), null, slit({ x: 0.3, w: 2.0, y: 0.04, h: 2.3, kind: "tall" }), slit(), null],
];

const W = 4096;
const H = 4096;
const ROW = 512;
const PAD = 4;
const PX_M = W / FACADE.repeat;
const PY_M = (ROW - 2 * PAD) / FACADE.floor;

/** Canvas y (px) of height `ym` (metres above the storey floor) in row `row`. */
const rowY = (row: number, ym: number) => row * ROW + ROW - PAD - ym * PY_M;
/** Canvas x (px) of `sm` metres into bay `bay`. */
const bayX = (bay: number, sm: number) => (bay * FACADE.bay + sm) * PX_M;

/** Atlas uv of a point `s` metres along and `y` metres up a nominal 2.6 × 2.9 m bay. */
export function wallUV(row: number, bay: number, s: number, y: number): [number, number] {
  return [(bay * FACADE.bay + s) / FACADE.repeat, 1 - rowY(row, y) / H];
}

/** Bands below the rows: [top px, height px]. */
const BANDS = {
  plain: [3584, 64],
  roof: [3648, 64],
  plinth: [3712, 64],
  soffit: [3776, 32],
  reveal: [3808, 32],
  metal: [3840, 32],
  coping: [3872, 32],
} as const;
export type Band = keyof typeof BANDS;

/** Atlas uv in a band: `along` metres (wrapping), `across` 0..1 from the band's top to its bottom. */
export function bandUV(band: Band, along: number, across = 0.5): [number, number] {
  const [y, h] = BANDS[band];
  return [along / FACADE.repeat, 1 - (y + 3 + across * (h - 6)) / H];
}

/** Prop cells in the strip under the bands (px rects). */
const PROPS = {
  /** Apartment balcony front: two 2.6 m precast panels, 1.1 m tall. */
  panel: [0, 3906, 1024, 186],
  /** Air-conditioner outdoor unit, 0.8 × 0.6 m front. */
  ac: [1040, 3906, 160, 108],
  /** Its sides and top. */
  acSide: [1216, 3906, 96, 108],
  /** Electricity meter and gas meter box. */
  meter: [1328, 3906, 80, 120],
} as const;
export type Prop = keyof typeof PROPS;

/** Atlas uv in a prop cell, fx and fy 0..1 from its bottom-left. */
export function propUV(prop: Prop, fx: number, fy: number): [number, number] {
  const [x, y, w, h] = PROPS[prop];
  return [(x + 2 + fx * (w - 4)) / W, 1 - (y + h - 2 - fy * (h - 4)) / H];
}

// ------------------------------------------------------------------ painting

/** Fine render texture: speckle, trowel blotches and a few hairline cracks over a rect. */
function render(g: Ctx, r: Rng, x: number, y: number, w: number, h: number, color: string, k = 1): void {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
  // Soft blotches (0.5–2 m) so the wall is never one flat tone.
  for (let i = 0; i < (w * h) / 60000; i++) {
    const cx = x + r.range(0, w);
    const cy = y + r.range(0, h);
    const rad = r.range(80, 360);
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    const dark = r.chance(0.6);
    grd.addColorStop(0, dark ? `rgba(60,55,45,${0.035 * k})` : `rgba(255,255,255,${0.05 * k})`);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  }
  // Speckle.
  for (let i = 0; i < (w * h) / 90; i++) {
    g.fillStyle = r.chance(0.5) ? `rgba(0,0,0,${r.range(0.02, 0.06) * k})` : `rgba(255,255,255,${r.range(0.03, 0.08) * k})`;
    g.fillRect(x + r.range(0, w), y + r.range(0, h), r.range(1, 3), r.range(1, 3));
  }
}

/** A run-off streak from (x, y) downward, `len` px, tapering and fading. */
function streak(g: Ctx, x: number, y: number, len: number, wid: number, a: number): void {
  const grd = g.createLinearGradient(0, y, 0, y + len);
  grd.addColorStop(0, `rgba(70,64,52,${a})`);
  grd.addColorStop(0.35, `rgba(80,74,62,${a * 0.7})`);
  grd.addColorStop(1, "rgba(80,74,62,0)");
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(x - wid / 2, y);
  g.lineTo(x + wid / 2, y);
  g.lineTo(x + wid * 0.2, y + len);
  g.lineTo(x - wid * 0.2, y + len);
  g.closePath();
  g.fill();
}

/** Slab edge at the top of a storey: a 0.2 m concrete band with a drip shadow and streaks under it. */
function slab(g: Ctx, r: Rng, row: number, color: string, streaks = true): void {
  const y0 = row * ROW;
  const hh = PAD + 0.2 * PY_M;
  g.fillStyle = color;
  g.fillRect(0, y0, W, hh);
  g.fillStyle = "rgba(0,0,0,0.12)";
  g.fillRect(0, y0 + hh - 3, W, 3);
  const grd = g.createLinearGradient(0, y0 + hh, 0, y0 + hh + 0.35 * PY_M);
  grd.addColorStop(0, "rgba(0,0,0,0.13)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, y0 + hh, W, 0.35 * PY_M);
  if (streaks) for (let i = 0; i < 26; i++) streak(g, r.range(0, W), y0 + hh, r.range(0.3, 1.4) * PY_M, r.range(4, 14), r.range(0.04, 0.1));
}

/** Splash zone at the foot of a ground storey. */
function splash(g: Ctx, row: number): void {
  const y1 = row * ROW + ROW;
  const grd = g.createLinearGradient(0, y1 - 0.45 * PY_M, 0, y1);
  grd.addColorStop(0, "rgba(70,60,45,0)");
  grd.addColorStop(1, "rgba(70,60,45,0.22)");
  g.fillStyle = grd;
  g.fillRect(0, y1 - 0.45 * PY_M, W, 0.45 * PY_M);
}

/** Interior seen through glass in daylight: dark room, the sky's reflection high in the pane, curtains or blinds. */
function glass(g: Ctx, r: Rng, x: number, y: number, w: number, h: number, o: { curtains?: boolean; frosted?: boolean } = {}): void {
  if (o.frosted) {
    const grd = g.createLinearGradient(x, y, x, y + h);
    grd.addColorStop(0, "#c6ced1");
    grd.addColorStop(1, "#a3adb2");
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
    return;
  }
  const grd = g.createLinearGradient(x, y, x + w * 0.25, y + h);
  // Sky and the hill opposite reflected high in the pane, the room darker below.
  grd.addColorStop(0, "#9fb5c2");
  grd.addColorStop(0.28, "#6e8594");
  grd.addColorStop(0.62, "#3b4851");
  grd.addColorStop(1, "#262d32");
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  // Room: a ceiling light, a wall, furniture tops.
  if (r.chance(0.5)) {
    g.fillStyle = "rgba(160,150,130,0.18)";
    g.fillRect(x + w * r.range(0.1, 0.5), y + h * 0.18, w * r.range(0.2, 0.4), h * 0.5);
  }
  if (r.chance(0.5)) {
    const fy = y + h * r.range(0.62, 0.75);
    g.fillStyle = "rgba(10,10,10,0.35)";
    g.fillRect(x + w * r.range(0, 0.5), fy, w * r.range(0.2, 0.5), y + h - fy);
  }
  if (o.curtains !== false) {
    const kind = r.next();
    if (kind < 0.4) {
      // Curtains drawn to one or both sides.
      const col = r.pick(["#e9e2d0", "#d8cbb4", "#cfd6d8", "#b8a58c", "#efe9df"]);
      for (const side of r.chance(0.5) ? [0, 1] : [r.chance(0.5) ? 0 : 1]) {
        const cw = w * r.range(0.14, 0.32);
        const cx = side ? x + w - cw : x;
        g.fillStyle = col;
        g.globalAlpha = 0.85;
        g.fillRect(cx, y, cw, h);
        for (let f = cx; f < cx + cw; f += 7) {
          g.fillStyle = "rgba(0,0,0,0.12)";
          g.fillRect(f, y, 2, h);
        }
        g.globalAlpha = 1;
      }
    } else if (kind < 0.6) {
      // Lace across the whole pane.
      g.fillStyle = "rgba(235,235,228,0.42)";
      g.fillRect(x, y, w, h);
    } else if (kind < 0.75) {
      // Blind, part drawn.
      const bh = h * r.range(0.2, 0.7);
      g.fillStyle = "#d9d6cc";
      g.fillRect(x, y, w, bh);
      for (let b = y; b < y + bh; b += 5) {
        g.fillStyle = "rgba(0,0,0,0.1)";
        g.fillRect(x, b, w, 1);
      }
    }
  }
  // Reflection: a soft diagonal sheen.
  g.fillStyle = "rgba(255,255,255,0.08)";
  g.beginPath();
  g.moveTo(x + w * 0.2, y);
  g.lineTo(x + w * 0.45, y);
  g.lineTo(x + w * 0.15, y + h);
  g.lineTo(x, y + h);
  g.lineTo(x, y + h * 0.7);
  g.closePath();
  g.fill();
}

const FRAME = { dark: "#34373a", alu: "#b4b8b9", bronze: "#5a4e43", white: "#e9e8e3" } as const;

/** One window, painted into its rect (px): frame, sashes, glass; sill, shutter box, streaks outside it. */
function paintWindow(g: Ctx, r: Rng, row: number, bay: number, win: Win, frame: string): void {
  const x = bayX(bay, win.x);
  const w = win.w * PX_M;
  const y = rowY(row, win.y + win.h);
  const h = win.h * PY_M;
  const f = 0.045 * PX_M;
  // Opening shadow just outside the frame (the reveal, as seen on flat far walls).
  g.fillStyle = "rgba(0,0,0,0.22)";
  g.fillRect(x - 4, y - 5, w + 8, h + 7);
  if (win.kind === "door") {
    g.fillStyle = r.pick(["#4f3b2c", "#5d4636", "#3d3a37"]);
    g.fillRect(x, y, w, h);
    for (let k = 0; k < 7; k++) {
      g.fillStyle = "rgba(0,0,0,0.08)";
      g.fillRect(x + (w * (k + 0.5)) / 7, y, 2, h);
    }
    glass(g, r, x + w * 0.12, y + h * 0.1, w * 0.14, h * 0.8, { curtains: false });
    g.fillStyle = "#c9c4b8";
    g.fillRect(x + w * 0.8, y + h * 0.45, 5, h * 0.12);
    g.strokeStyle = frame;
    g.lineWidth = f;
    g.strokeRect(x + f / 2, y + f / 2, w - f, h - f);
    return;
  }
  if (win.kind === "steel") {
    g.fillStyle = r.pick(["#7d8a92", "#8f8a7e", "#6f7b7f"]);
    g.fillRect(x, y, w, h);
    g.fillStyle = "rgba(255,255,255,0.08)";
    g.fillRect(x + 10, y + 10, w - 20, h - 20);
    g.fillStyle = "#2a2c2e";
    g.fillRect(x + w * 0.78, y + h * 0.45, 8, 26);
    g.fillRect(x + w * 0.35, y + h * 0.6, w * 0.3, 8);
    g.fillStyle = "#c8c8c0";
    g.fillRect(x + w * 0.4, y + h * 0.12, w * 0.2, 14);
    return;
  }
  // Frame, then the glazing inside it.
  g.fillStyle = frame;
  g.fillRect(x, y, w, h);
  const gx = x + f;
  const gy = y + f;
  const gw = w - 2 * f;
  const gh = h - 2 * f;
  const frosted = win.kind === "frosted";
  if (win.kind === "slide" || win.kind === "sash") {
    // Two sliding panels (引き違い), each framed, overlapping at the meeting stiles.
    const pw = gw / 2;
    for (const k of [0, 1]) {
      const px = gx + k * pw;
      glass(g, r, px + f * 0.6, gy + f * 0.6, pw - f * 1.2, gh - f * 1.2, { frosted: frosted || (win.kind === "sash" && r.chance(0.25)) });
      g.strokeStyle = frame;
      g.lineWidth = f * 0.9;
      g.strokeRect(px + f * 0.3, gy + f * 0.3, pw - f * 0.6, gh - f * 0.6);
    }
    g.fillStyle = "rgba(0,0,0,0.3)";
    g.fillRect(gx + pw - 2, gy, 4, gh);
  } else if (win.kind === "tall") {
    // Three lights under a transom.
    const th = gh * 0.22;
    glass(g, r, gx, gy, gw, th, { curtains: false });
    for (let k = 0; k < 3; k++) glass(g, r, gx + (gw * k) / 3, gy + th + f * 0.6, gw / 3, gh - th - f * 0.6);
    g.fillStyle = frame;
    g.fillRect(gx, gy + th, gw, f * 0.6);
    for (let k = 1; k < 3; k++) g.fillRect(gx + (gw * k) / 3 - f * 0.35, gy, f * 0.7, gh);
  } else if (win.kind === "picture") {
    // A fixed light and a narrow casement.
    const cw = gw * 0.34;
    glass(g, r, gx, gy, gw - cw, gh);
    glass(g, r, gx + gw - cw + f * 0.6, gy, cw - f * 0.6, gh, { curtains: false });
    g.fillStyle = frame;
    g.fillRect(gx + gw - cw, gy, f * 0.6, gh);
  } else if (win.kind === "slit") {
    glass(g, r, gx, gy, gw, gh, { curtains: false });
    g.fillStyle = frame;
    g.fillRect(gx, gy + gh * 0.5, gw, f * 0.5);
  } else {
    glass(g, r, gx, gy, gw, gh, { frosted, curtains: !frosted && r.chance(0.5) });
    if (!frosted) {
      g.fillStyle = frame;
      g.fillRect(gx + gw / 2 - f * 0.3, gy, f * 0.6, gh);
    }
  }
  if (win.grille) {
    // Steel grille: vertical bars and two rails, standing proud of the glass.
    g.fillStyle = "#a9adae";
    for (let bx = x + 6; bx < x + w - 4; bx += 0.1 * PX_M) g.fillRect(bx, y, 5, h);
    g.fillRect(x, y + h * 0.08, w, 6);
    g.fillRect(x, y + h * 0.9, w, 6);
  }
  if (win.sill) {
    // Aluminium sill with its drip shadow, and run-off streaks from both ends.
    g.fillStyle = "#c3c6c6";
    g.fillRect(x - 10, y + h, w + 20, 0.05 * PY_M);
    g.fillStyle = "rgba(0,0,0,0.25)";
    g.fillRect(x - 10, y + h + 0.05 * PY_M, w + 20, 4);
    for (const sx of [x - 6, x + w + 6, x + w * r.range(0.3, 0.7)]) streak(g, sx, y + h + 0.06 * PY_M, r.range(0.35, 1.0) * PY_M, r.range(8, 22), r.range(0.07, 0.15));
  }
  if (win.shutter) {
    // Rain-shutter box: ribbed steel, 0.22 m tall, its shadow on the wall below.
    const by = y - 0.26 * PY_M;
    g.fillStyle = "rgba(0,0,0,0.2)";
    g.fillRect(x - 0.06 * PX_M, by + 0.22 * PY_M, w + 0.12 * PX_M, 6);
    g.fillStyle = "#a6aaac";
    g.fillRect(x - 0.06 * PX_M, by, w + 0.12 * PX_M, 0.22 * PY_M);
    for (let ry = by + 6; ry < by + 0.22 * PY_M; ry += 9) {
      g.fillStyle = "rgba(0,0,0,0.12)";
      g.fillRect(x - 0.06 * PX_M, ry, w + 0.12 * PX_M, 2);
    }
    // Guide rails down both sides.
    g.fillStyle = "#9a9ea0";
    g.fillRect(x - 0.05 * PX_M, y, 0.04 * PX_M, h);
    g.fillRect(x + w + 0.01 * PX_M, y, 0.04 * PX_M, h);
  }
  if (win.hood) {
    const hy = y - 0.3 * PY_M;
    g.fillStyle = "rgba(0,0,0,0.25)";
    g.fillRect(x - 0.3 * PX_M, hy + 0.12 * PY_M, w + 0.6 * PX_M, 0.3 * PY_M);
  }
}

/** Lap siding: 0.19 m boards with shadow lines, caulked panel joints. */
function siding(g: Ctx, row: number): void {
  const y0 = row * ROW;
  for (let y = y0 + ROW - PAD; y > y0; y -= 0.19 * PY_M) {
    g.fillStyle = "rgba(0,0,0,0.1)";
    g.fillRect(0, y - 3, W, 3);
    g.fillStyle = "rgba(255,255,255,0.12)";
    g.fillRect(0, y, W, 2);
  }
  for (let b = 0; b < FACADE.bays; b += 3) {
    g.fillStyle = "rgba(0,0,0,0.1)";
    g.fillRect(bayX(b, 0), y0, 3, ROW);
  }
}

/** Mosaic tile (二丁掛): faint 0.06 × 0.23 m courses. */
function tile(g: Ctx, row: number): void {
  const y0 = row * ROW;
  let k = 0;
  for (let y = y0 + ROW - PAD; y > y0; y -= 0.06 * PY_M, k++) {
    g.fillStyle = "rgba(0,0,0,0.05)";
    g.fillRect(0, y - 1, W, 2);
    for (let x = (k % 2) * 0.115 * PX_M; x < W; x += 0.23 * PX_M) {
      g.fillStyle = "rgba(0,0,0,0.035)";
      g.fillRect(x, y - 0.06 * PY_M, 2, 0.06 * PY_M);
    }
  }
}

/** Dark vertical boards (焼杉 / painted cedar) with grooves, over a rect. */
function boards(g: Ctx, r: Rng, x0: number, y0: number, w: number, h: number): void {
  for (let x = x0; x < x0 + w - 1; x += 0.14 * PX_M) {
    const bw = Math.min(0.14 * PX_M, x0 + w - x);
    g.fillStyle = `hsl(${r.range(20, 30)}, ${r.range(8, 16)}%, ${r.range(16, 24)}%)`;
    g.fillRect(x, y0, bw, h);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(0,0,0,${r.range(0.03, 0.1)})`;
      g.fillRect(x + r.range(0, bw), y0 + r.range(0, h), 1.5, r.range(20, 120));
    }
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.fillRect(x, y0, 4, h);
  }
}

/** Paints the facade atlas on a size × size canvas (the layout stays in 4096² pixels). */
export function facadeAtlas(size: number): Texture {
  const { c, g } = canvas(size, size);
  g.scale(size / W, size / H);
  const r = new Rng(2905);
  // Opaque everywhere (the cooker keeps BC1 for a texture without alpha).
  g.fillStyle = "#e6e4de";
  g.fillRect(0, 0, W, H);
  const rowRect = (row: number) => [0, row * ROW, W, ROW] as const;
  // ---- walls.
  render(g, r, ...rowRect(ROWS.villaG), "#ebeae5");
  render(g, r, ...rowRect(ROWS.villaU), "#ebeae5");
  render(g, r, ...rowRect(ROWS.houseG), "#e6e4de", 0.7);
  render(g, r, ...rowRect(ROWS.houseU), "#e6e4de", 0.7);
  siding(g, ROWS.houseG);
  siding(g, ROWS.houseU);
  render(g, r, ...rowRect(ROWS.apt), "#e9e5dc", 0.8);
  render(g, r, ...rowRect(ROWS.aptBack), "#e9e5dc", 0.8);
  tile(g, ROWS.apt);
  tile(g, ROWS.aptBack);
  boards(g, r, 0, ROWS.clad * ROW, W, ROW);
  // The villas' dark-boarded wing: bay 4 of both villa rows, so it runs up the whole wall.
  for (const row of [ROWS.villaG, ROWS.villaU]) boards(g, r, bayX(4, 0), row * ROW, FACADE.bay * PX_M, ROW);
  slab(g, r, ROWS.villaG, "#e7e6e1");
  slab(g, r, ROWS.villaU, "#e7e6e1");
  slab(g, r, ROWS.apt, "#dcd8cf");
  slab(g, r, ROWS.aptBack, "#dcd8cf");
  for (const row of [ROWS.villaG, ROWS.houseG, ROWS.aptBack]) splash(g, row);
  // House eaves line: a soffit shadow at the top of each storey.
  for (const row of [ROWS.houseG, ROWS.houseU]) {
    const grd = g.createLinearGradient(0, row * ROW, 0, row * ROW + 0.4 * PY_M);
    grd.addColorStop(0, "rgba(0,0,0,0.16)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, row * ROW, W, 0.4 * PY_M);
  }
  // Windows, with their sills, shutter boxes and streaks.
  for (let row = 0; row < FACADE.rows; row++) {
    const frame = row <= ROWS.villaU || row === ROWS.clad ? FRAME.dark : row <= ROWS.houseU ? (row === ROWS.houseG ? FRAME.alu : FRAME.bronze) : FRAME.alu;
    LAYOUT[row].forEach((win, bay) => {
      if (win) paintWindow(g, r, row, bay, win, win.kind === "door" ? FRAME.dark : frame);
    });
  }
  // ---- bands.
  const band = (b: Band) => BANDS[b];
  {
    const [y, h] = band("plain");
    render(g, r, 0, y, W, h, "#f0efea");
    for (let i = 0; i < 90; i++) streak(g, r.range(0, W), y, r.range(0.3, 1) * h, r.range(4, 12), r.range(0.05, 0.12));
  }
  {
    const [y, h] = band("roof");
    render(g, r, 0, y, W, h, "#c4c6c6", 0.8);
    for (let x = 0; x < W; x += 0.45 * PX_M) {
      g.fillStyle = "rgba(0,0,0,0.2)";
      g.fillRect(x, y, 4, h);
      g.fillStyle = "rgba(255,255,255,0.25)";
      g.fillRect(x + 4, y, 3, h);
    }
  }
  {
    const [y, h] = band("plinth");
    render(g, r, 0, y, W, h, "#8f8d87", 1.4);
    for (let x = 30; x < W; x += 0.6 * PX_M) {
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.beginPath();
      g.arc(x, y + h / 2, 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  {
    const [y, h] = band("soffit");
    render(g, r, 0, y, W, h, "#cfcfca", 0.6);
  }
  {
    const [y, h] = band("reveal");
    const grd = g.createLinearGradient(0, y, 0, y + h);
    grd.addColorStop(0, "#e9e8e3");
    grd.addColorStop(1, "#c9c8c2");
    g.fillStyle = grd;
    g.fillRect(0, y, W, h);
  }
  {
    const [y, h] = band("metal");
    const grd = g.createLinearGradient(0, y, 0, y + h);
    grd.addColorStop(0, "#d4d7d8");
    grd.addColorStop(0.5, "#b2b6b8");
    grd.addColorStop(1, "#8e9294");
    g.fillStyle = grd;
    g.fillRect(0, y, W, h);
  }
  {
    const [y, h] = band("coping");
    g.fillStyle = "#b5b8b8";
    g.fillRect(0, y, W, h);
    for (let x = 0; x < W; x += 1.8 * PX_M) {
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.fillRect(x, y, 3, h);
    }
  }
  // ---- props.
  {
    // Balcony panels: precast concrete, a drip groove under the rail, streaks from the top.
    const [x, y, w, h] = PROPS.panel;
    render(g, r, x, y, w, h, "#e6e3db");
    for (let k = 1; k < 2; k++) {
      g.fillStyle = "rgba(0,0,0,0.2)";
      g.fillRect(x + (w * k) / 2 - 2, y, 4, h);
    }
    g.fillStyle = "rgba(0,0,0,0.12)";
    g.fillRect(x, y + 14, w, 3);
    for (let i = 0; i < 14; i++) streak(g, x + r.range(10, w - 10), y + 18, r.range(0.3, 0.8) * h, r.range(6, 14), r.range(0.06, 0.14));
  }
  {
    // Outdoor unit: off-white case, round fan grille, side louvres.
    const [x, y, w, h] = PROPS.ac;
    g.fillStyle = "#e4e3dc";
    g.fillRect(x, y, w, h);
    const cx = x + w * 0.38;
    const cy = y + h * 0.5;
    const rad = h * 0.4;
    g.fillStyle = "#3b3e40";
    g.beginPath();
    g.arc(cx, cy, rad, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "rgba(200,200,195,0.6)";
    g.lineWidth = 1.5;
    for (let k = 1; k < 6; k++) {
      g.beginPath();
      g.arc(cx, cy, (rad * k) / 6, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = "rgba(0,0,0,0.25)";
    for (let ly = y + 12; ly < y + h - 10; ly += 7) g.fillRect(x + w * 0.74, ly, w * 0.2, 2);
    g.fillStyle = "rgba(0,0,0,0.3)";
    g.fillRect(x, y + h - 4, w, 4);
  }
  {
    const [x, y, w, h] = PROPS.acSide;
    g.fillStyle = "#d9d8d1";
    g.fillRect(x, y, w, h);
    g.fillStyle = "rgba(0,0,0,0.12)";
    for (let ly = y + 8; ly < y + h - 8; ly += 6) g.fillRect(x + 8, ly, w - 16, 2);
  }
  {
    const [x, y, w, h] = PROPS.meter;
    g.fillStyle = "#cfd0cb";
    g.fillRect(x, y, w, h);
    g.fillStyle = "#2b2e30";
    g.fillRect(x + 14, y + 16, w - 28, 26);
    g.fillStyle = "#9da3a6";
    g.fillRect(x + 10, y + 60, w - 20, 50);
  }
  const t = toTexture(c, true);
  t.wrapS = RepeatWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.name = "kamakura-facades";
  return t;
}
