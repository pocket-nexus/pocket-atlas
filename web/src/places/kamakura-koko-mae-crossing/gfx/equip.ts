import { CanvasTexture, ClampToEdgeWrapping, LinearMipmapLinearFilter, MeshStandardMaterial, NoColorSpace, SRGBColorSpace, Vector2, type BufferAttribute, type BufferGeometry, type Texture } from "three";
import { Rng } from "../../../core/random";
import type { AtlasRect } from "../../shared/atlas";
import { canvas, type Ctx } from "../../shared/canvas";
import type { KamakuraWorld } from "../world/context";
import { SIGN_CELLS } from "./signs";

/**
 * The equipment atlas: every painted or bare-metal surface of the crossing
 * machinery, the poles, the wires, the signs and the street furniture in one
 * texture set, so all of it draws with one material (two meshes: shadow
 * casters and the wires, which cast none).
 *
 * Each cell is painted three times on canvases of the same layout: albedo
 * (sRGB), height (grey, 128 = flat; turned into a tangent-space normal map
 * here, cell by cell) and ORM (R occlusion, G roughness, B metalness), the
 * channel layout three.js and the cooker read. The atlas is 2048² on the web
 * at high quality and 1024² otherwise; the cooker stores it at 1024².
 */

/** Painting surface for one cell: three contexts at the same origin and size. */
export class Pen {
  constructor(
    readonly a: Ctx,
    readonly h: Ctx,
    readonly o: Ctx,
    readonly w: number,
    readonly ht: number,
    readonly r: Rng,
    /** Pixels per 1024-atlas pixel. */
    readonly k: number,
    /** Cell origin on the canvas (pixel writes ignore the context transform). */
    readonly ox = 0,
    readonly oy = 0,
  ) {}

  /** Fills the cell: albedo, roughness, metalness, flat height. */
  base(color: string, rough: number, metal = 0): void {
    this.paint(0, 0, this.w, this.ht, color, rough, metal, 0);
  }

  /** A rectangle of paint; any channel left undefined is untouched. Height in −1..1 (0 flat). */
  paint(x: number, y: number, w: number, h: number, color?: string, rough?: number, metal?: number, height?: number): void {
    if (color) {
      this.a.fillStyle = color;
      this.a.fillRect(x, y, w, h);
    }
    if (rough !== undefined) {
      this.o.fillStyle = orm(1, rough, metal ?? 0);
      this.o.fillRect(x, y, w, h);
    }
    if (height !== undefined) {
      this.h.fillStyle = grey(height);
      this.h.fillRect(x, y, w, h);
    }
  }

  /** Runs a path-drawing function on the chosen layers with the given styles. */
  shape(path: (g: Ctx) => void, color?: string, rough?: number, metal = 0, height?: number): void {
    if (color) {
      this.a.fillStyle = color;
      this.a.beginPath();
      path(this.a);
      this.a.fill();
    }
    if (rough !== undefined) {
      this.o.fillStyle = orm(1, rough, metal);
      this.o.beginPath();
      path(this.o);
      this.o.fill();
    }
    if (height !== undefined) {
      this.h.fillStyle = grey(height);
      this.h.beginPath();
      path(this.h);
      this.h.fill();
    }
  }

  /** Raised round head (bolt, rivet): a radial bump in the height map and a faint highlight. */
  bolt(x: number, y: number, rad: number, color = "rgba(255,255,255,0.12)"): void {
    const g = this.h.createRadialGradient(x - rad * 0.2, y - rad * 0.2, 0, x, y, rad);
    g.addColorStop(0, grey(0.9));
    g.addColorStop(0.7, grey(0.55));
    g.addColorStop(1, grey(0));
    this.h.fillStyle = g;
    this.h.beginPath();
    this.h.arc(x, y, rad, 0, Math.PI * 2);
    this.h.fill();
    this.a.fillStyle = color;
    this.a.beginPath();
    this.a.arc(x - rad * 0.25, y - rad * 0.25, rad * 0.5, 0, Math.PI * 2);
    this.a.fill();
  }

  /** Recessed line (panel seam, door gap). */
  seam(x0: number, y0: number, x1: number, y1: number, width: number, dark = "rgba(0,0,0,0.45)"): void {
    for (const [g, s] of [
      [this.h, grey(-0.8)],
      [this.a, dark],
    ] as const) {
      g.strokeStyle = s;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
  }

  /** Paint chips: small blobs of primer or bare metal, rougher, a little lower. */
  chips(n: number, size: number, color: string, rough: number, metal: number, where: () => [number, number] = () => [this.r.next() * this.w, this.r.next() * this.ht]): void {
    for (let i = 0; i < n; i++) {
      const [x, y] = where();
      const rx = size * this.r.range(0.3, 1);
      const ry = rx * this.r.range(0.4, 1);
      const rot = this.r.range(0, Math.PI);
      this.shape((g) => g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2), color, rough, metal, -0.35);
    }
  }

  /** Dirt rising from the bottom edge (road splash) or hanging from the top (soot); also rougher. */
  grime(fromBottom: number, alpha: number, color = "60,52,42"): void {
    const y0 = this.ht * (1 - fromBottom);
    const g = this.a.createLinearGradient(0, this.ht, 0, y0);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(1, `rgba(${color},0)`);
    this.a.fillStyle = g;
    this.a.fillRect(0, y0, this.w, this.ht - y0);
    const o = this.o.createLinearGradient(0, this.ht, 0, y0);
    o.addColorStop(0, `rgba(0,${Math.round(alpha * 90)},0,1)`);
    o.addColorStop(1, "rgba(0,0,0,1)");
    this.o.globalCompositeOperation = "lighter";
    this.o.fillStyle = o;
    this.o.fillRect(0, y0, this.w, this.ht - y0);
    this.o.globalCompositeOperation = "source-over";
  }

  /** Vertical streaks (rain runs, rust tears) of a colour. */
  streaks(n: number, color: string, len: [number, number], width: [number, number], from: () => [number, number] = () => [this.r.next() * this.w, this.r.next() * this.ht]): void {
    for (let i = 0; i < n; i++) {
      const [x, y] = from();
      const l = this.r.range(len[0], len[1]);
      const wd = this.r.range(width[0], width[1]);
      const g = this.a.createLinearGradient(0, y, 0, y + l);
      g.addColorStop(0, color);
      g.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
      this.a.fillStyle = g;
      this.a.fillRect(x - wd / 2, y, wd, l);
    }
  }

  /** Fine speckle over the albedo (paint grain, galvanising spangle). */
  speckle(n: number, colors: string[], size: [number, number]): void {
    for (let i = 0; i < n; i++) {
      this.a.fillStyle = colors[i % colors.length];
      const s = this.r.range(size[0], size[1]);
      this.a.fillRect(this.r.next() * this.w, this.r.next() * this.ht, s, s);
    }
  }

  /** Per-pixel albedo from a function of (u, v) in 0..1 (v = 0 at the top of the cell). */
  pixels(fn: (u: number, v: number, out: number[]) => void): void {
    const img = this.a.createImageData(this.w, this.ht);
    const px = [0, 0, 0];
    for (let y = 0; y < this.ht; y++)
      for (let x = 0; x < this.w; x++) {
        fn((x + 0.5) / this.w, (y + 0.5) / this.ht, px);
        const i = (y * this.w + x) * 4;
        img.data[i] = px[0];
        img.data[i + 1] = px[1];
        img.data[i + 2] = px[2];
        img.data[i + 3] = 255;
      }
    this.a.putImageData(img, this.ox, this.oy);
  }
}

/** Grey level for a height in −1..1. */
export function grey(h: number): string {
  const v = Math.round(128 + Math.max(-1, Math.min(1, h)) * 120);
  return `rgb(${v},${v},${v})`;
}

/** ORM texel (occlusion, roughness, metalness in 0..1). */
export function orm(ao: number, rough: number, metal: number): string {
  return `rgb(${Math.round(ao * 255)},${Math.round(rough * 255)},${Math.round(metal * 255)})`;
}

/** A cell: size in 1024-atlas pixels and its painter. `bump` scales the height into the normal map. */
export interface CellDef {
  w: number;
  h: number;
  bump?: number;
  paint: (p: Pen) => void;
}

// ------------------------------------------------------------- paints

const YELLOW = "#f1c000";
const BLACK = "#161616";

/** Glossy-ish enamel with chips, dust and a little dirt at the bottom. */
function enamel(color: string, rough: number, chip: string, opts: { chips?: number; grime?: number; dust?: string } = {}) {
  return (p: Pen) => {
    p.base(color, rough);
    p.speckle(Math.round(p.w * p.ht * 0.02), ["rgba(255,255,255,0.05)", "rgba(0,0,0,0.06)"], [1, 2 * p.k]);
    p.chips(opts.chips ?? 6, 2.2 * p.k, chip, 0.75, 0);
    if (opts.dust) p.streaks(8, opts.dust, [p.ht * 0.2, p.ht * 0.7], [1 * p.k, 3 * p.k]);
    if (opts.grime) p.grime(0.35, opts.grime);
  };
}

/** Hot-dip galvanised steel: mottled spangle, white-rust blooms, metallic. */
function galvanised(p: Pen): void {
  p.base("#a2a8ab", 0.42, 0.85);
  for (let i = 0; i < p.w * p.ht * 0.004; i++) {
    const s = p.r.range(3, 9) * p.k;
    const v = p.r.int(-14, 14);
    p.shape((g) => g.rect(p.r.next() * p.w, p.r.next() * p.ht, s, s * p.r.range(0.6, 1.4)), `rgba(${160 + v},${166 + v},${170 + v},0.5)`, 0.38 + p.r.range(-0.08, 0.1), 0.85);
  }
  p.chips(5, 3 * p.k, "#c9c9c2", 0.8, 0.2);
}

/** Black-yellow diagonal hazard stripes (gate housings). */
function hazardBox(p: Pen): void {
  p.base(YELLOW, 0.45);
  const period = p.w / 2.5;
  for (let i = -4; i < 8; i++) {
    const x = i * period;
    p.shape((g) => {
      g.moveTo(x, p.ht);
      g.lineTo(x + period / 2, p.ht);
      g.lineTo(x + period / 2 + p.ht, 0);
      g.lineTo(x + p.ht, 0);
      g.closePath();
    }, BLACK, 0.45);
  }
  p.chips(10, 2.5 * p.k, "#8d8a80", 0.8, 0);
  p.grime(0.4, 0.35);
  // Frame edges, slightly raised.
  p.paint(0, 0, p.w, 2 * p.k, undefined, undefined, undefined, 0.4);
  p.paint(0, p.ht - 2 * p.k, p.w, 2 * p.k, undefined, undefined, undefined, 0.4);
}

/** Equipment cabinet door: seams, louvres, handle, a sticker, road dirt. */
function cabinetDoor(color: string, rough: number, label?: string) {
  return (p: Pen) => {
    p.base(color, rough);
    p.speckle(p.w * 3, ["rgba(0,0,0,0.05)", "rgba(255,255,255,0.05)"], [1, 2 * p.k]);
    const m = 6 * p.k;
    // Two doors with a centre seam, frame seam around.
    p.seam(m, m, p.w - m, m, 1.5 * p.k);
    p.seam(m, p.ht - m, p.w - m, p.ht - m, 1.5 * p.k);
    p.seam(m, m, m, p.ht - m, 1.5 * p.k);
    p.seam(p.w - m, m, p.w - m, p.ht - m, 1.5 * p.k);
    p.seam(p.w / 2, m, p.w / 2, p.ht - m, 1.5 * p.k);
    // Louvres near the top and bottom of each door.
    for (const x0 of [m * 2, p.w / 2 + m]) {
      for (const y0 of [m * 2.5, p.ht - m * 6]) {
        for (let i = 0; i < 4; i++) {
          const y = y0 + i * 3.2 * p.k;
          p.paint(x0, y, p.w / 2 - m * 3, 1.4 * p.k, "rgba(0,0,0,0.35)", undefined, undefined, -0.6);
          p.paint(x0, y + 1.4 * p.k, p.w / 2 - m * 3, 0.8 * p.k, "rgba(255,255,255,0.12)", undefined, undefined, 0.5);
        }
      }
    }
    // Handles beside the centre seam.
    for (const s of [-1, 1]) {
      const x = p.w / 2 + s * 5 * p.k;
      p.paint(x - 1.2 * p.k, p.ht * 0.45, 2.4 * p.k, 14 * p.k, "#2a2a2a", 0.4, 0.6, 0.7);
    }
    p.bolt(p.w / 2 - 12 * p.k, p.ht * 0.42, 2.2 * p.k);
    if (label) {
      p.paint(m * 2, p.ht * 0.3, p.w / 2 - m * 3, 9 * p.k, "#f2f1ea", 0.6, 0, 0.05);
      p.a.fillStyle = "#222";
      p.a.font = `700 ${6.5 * p.k}px "Hiragino Sans","Noto Sans JP",sans-serif`;
      p.a.textAlign = "center";
      p.a.textBaseline = "middle";
      p.a.fillText(label, m * 2 + (p.w / 2 - m * 3) / 2, p.ht * 0.3 + 4.6 * p.k, p.w / 2 - m * 3.5);
    }
    p.streaks(10, "rgba(70,60,45,0.18)", [p.ht * 0.1, p.ht * 0.4], [1 * p.k, 3 * p.k], () => [p.r.next() * p.w, p.ht * p.r.range(0.05, 0.3)]);
    p.grime(0.3, 0.4);
  };
}

/** The atlas cells (sizes in 1024-atlas pixels). */
export const CELLS = {
  /** Warning mast pole: spiral black-yellow bands; u around (≈0.5 m), v up 4.4 m. */
  mast: {
    w: 64,
    h: 512,
    bump: 2,
    paint: (p: Pen) => {
      p.pixels((u, v, o) => {
        const hm = (1 - v) * 4.4;
        const band = Math.floor((hm + u * 0.5 * 0.9) / 0.2);
        const c = band % 2 ? [24, 24, 24] : [240, 190, 0];
        const n = (Math.sin(u * 91 + v * 517) + Math.sin(v * 1311)) * 3;
        o[0] = c[0] + n;
        o[1] = c[1] + n;
        o[2] = c[2] + n * 0.3;
      });
      p.paint(0, 0, p.w, p.ht, undefined, 0.42);
      p.chips(30, 2 * p.k, "#8e8a7e", 0.8, 0);
      p.chips(8, 1.6 * p.k, "#6b4a33", 0.85, 0.2);
      p.grime(0.08, 0.6);
      p.streaks(6, "rgba(90,70,50,0.25)", [20 * p.k, 60 * p.k], [1, 2 * p.k], () => [p.r.next() * p.w, p.ht * p.r.range(0.1, 0.6)]);
    },
  },
  /** Gate arm (FRP tube): yellow and black bands along u, gloss film. */
  arm: {
    w: 512,
    h: 32,
    bump: 1,
    paint: (p: Pen) => {
      const bands = 13;
      for (let i = 0; i < bands; i++) p.paint((i * p.w) / bands, 0, p.w / bands + 1, p.ht, i % 2 ? BLACK : YELLOW, 0.32);
      p.speckle(p.w * 2, ["rgba(0,0,0,0.08)", "rgba(255,255,255,0.08)"], [1, 2 * p.k]);
      // A highlight line along the top of the tube and dust underneath.
      p.paint(0, p.ht * 0.1, p.w, p.ht * 0.12, "rgba(255,255,255,0.10)");
      p.paint(0, p.ht * 0.75, p.w, p.ht * 0.25, "rgba(70,60,45,0.18)", 0.5);
      p.chips(10, 1.6 * p.k, "#d8d4c6", 0.6, 0);
    },
  },
  /** Crossbuck board (one arm, 1.3 × 0.2 m): black edge, yellow and black blocks. */
  xStriped: {
    w: 256,
    h: 40,
    bump: 1.5,
    paint: (p: Pen) => {
      p.base(BLACK, 0.4);
      const b = p.ht * 0.1;
      const n = 7;
      for (let i = 0; i < n; i++) p.paint(b + ((p.w - 2 * b) * i) / n, b, (p.w - 2 * b) / n + 0.5, p.ht - 2 * b, i % 2 ? BLACK : YELLOW, 0.38, 0, 0.25);
      p.paint(0, 0, p.w, b, undefined, undefined, undefined, 0.6);
      p.paint(0, p.ht - b, p.w, b, undefined, undefined, undefined, 0.6);
      p.chips(8, 1.5 * p.k, "#9a968c", 0.75, 0);
      p.streaks(6, "rgba(80,70,55,0.2)", [p.ht * 0.3, p.ht], [1, 2 * p.k]);
    },
  },
  /** Plain yellow-orange crossbuck arm with a black edge. */
  xPlain: {
    w: 256,
    h: 40,
    bump: 1.5,
    paint: (p: Pen) => {
      p.base(BLACK, 0.4);
      const b = p.ht * 0.09;
      p.paint(b, b, p.w - 2 * b, p.ht - 2 * b, "#f4a51c", 0.36, 0, 0.25);
      p.paint(0, 0, p.w, b, undefined, undefined, undefined, 0.6);
      p.paint(0, p.ht - b, p.w, b, undefined, undefined, undefined, 0.6);
      p.speckle(p.w * 2, ["rgba(255,255,255,0.06)", "rgba(120,60,0,0.08)"], [1, 2 * p.k]);
      p.chips(6, 1.5 * p.k, "#a49c88", 0.75, 0);
      p.streaks(8, "rgba(80,60,40,0.18)", [p.ht * 0.3, p.ht], [1, 2 * p.k]);
    },
  },
  black: { w: 64, h: 64, bump: 1, paint: enamel("#151617", 0.42, "#5d5e5c", { chips: 5, dust: "rgba(140,130,115,0.12)", grime: 0.15 }) },
  blackMatte: { w: 32, h: 32, bump: 1, paint: enamel("#1b1c1d", 0.7, "#4a4b49", { chips: 2 }) },
  galv: { w: 64, h: 64, bump: 1, paint: galvanised },
  steel: {
    w: 32,
    h: 32,
    bump: 0.5,
    paint: (p: Pen) => {
      p.base("#b8bdc0", 0.28, 1);
      for (let x = 0; x < p.w; x += 1) p.paint(x, 0, 1, p.ht, `rgba(${p.r.next() < 0.5 ? "255,255,255" : "0,0,0"},0.05)`);
      p.grime(0.3, 0.3);
    },
  },
  orange: { w: 64, h: 64, bump: 1, paint: enamel("#e8661e", 0.5, "#a8a294", { chips: 4, grime: 0.2, dust: "rgba(120,100,80,0.12)" }) },
  white: { w: 64, h: 64, bump: 1, paint: enamel("#ebeae4", 0.48, "#9a9a92", { chips: 3, grime: 0.25, dust: "rgba(110,100,85,0.15)" }) },
  yellow: { w: 32, h: 32, bump: 1, paint: enamel(YELLOW, 0.45, "#8e8a7e", { chips: 3, grime: 0.2 }) },
  /** Enoden pole steel: dark-brown paint over rust; v along the pole. */
  brownSteel: {
    w: 64,
    h: 512,
    bump: 1.5,
    paint: (p: Pen) => {
      p.base("#4b3a2e", 0.62, 0.15);
      p.speckle(p.w * p.ht * 0.03, ["rgba(0,0,0,0.08)", "rgba(255,230,200,0.05)"], [1, 2 * p.k]);
      p.chips(40, 2.4 * p.k, "#6a3f22", 0.85, 0.3);
      p.streaks(18, "rgba(110,60,25,0.35)", [10 * p.k, 70 * p.k], [1, 2.5 * p.k]);
      p.grime(0.06, 0.6);
    },
  },
  /** Spun-concrete distribution pole: light grey, form seams, weathering; v along the pole (11 m). */
  concrete: {
    w: 64,
    h: 512,
    bump: 2,
    paint: (p: Pen) => {
      p.base("#b5b3ab", 0.86);
      p.speckle(p.w * p.ht * 0.08, ["rgba(0,0,0,0.07)", "rgba(255,255,255,0.08)", "rgba(90,85,75,0.08)"], [1, 2 * p.k]);
      // Two form seams along the pole.
      for (const x of [p.w * 0.25, p.w * 0.75]) p.seam(x, 0, x, p.ht, 0.8 * p.k, "rgba(0,0,0,0.12)");
      p.streaks(30, "rgba(70,68,60,0.18)", [20 * p.k, 120 * p.k], [1, 4 * p.k]);
      p.streaks(6, "rgba(120,80,40,0.2)", [10 * p.k, 50 * p.k], [1, 2 * p.k], () => [p.r.next() * p.w, p.ht * p.r.range(0.05, 0.4)]);
      // Pitting.
      for (let i = 0; i < p.w * p.ht * 0.003; i++) {
        const x = p.r.next() * p.w;
        const y = p.r.next() * p.ht;
        p.shape((g) => g.arc(x, y, p.r.range(0.4, 1.2) * p.k, 0, Math.PI * 2), "rgba(60,58,52,0.4)", 0.95, 0, -0.5);
      }
      p.grime(0.05, 0.55);
    },
  },
  cable: { w: 16, h: 16, bump: 0.5, paint: (p: Pen) => p.base("#141516", 0.62) },
  /** Twisted aerial cable: a lashing wire wound round the bundle (u along a short length, v around). */
  twisted: {
    w: 64,
    h: 32,
    bump: 3,
    paint: (p: Pen) => {
      p.base("#141414", 0.6);
      const turns = 3;
      for (let i = -2; i < turns * 2 + 2; i++) {
        const x = (i * p.w) / turns / 2;
        p.shape((g) => {
          g.moveTo(x, p.ht);
          g.lineTo(x + p.w / turns / 4, p.ht);
          g.lineTo(x + p.w / turns / 4 + p.w / turns / 2, 0);
          g.lineTo(x + p.w / turns / 2, 0);
          g.closePath();
        }, "#262626", 0.48, 0, 0.7);
      }
    },
  },
  porcelain: { w: 16, h: 16, bump: 0.3, paint: (p: Pen) => p.base("#e4e1d8", 0.18) },
  /** Pole transformer can: grey with cooling ribs. */
  transformer: {
    w: 64,
    h: 64,
    bump: 2.5,
    paint: (p: Pen) => {
      p.base("#8f9597", 0.5, 0.3);
      for (let x = 0; x < p.w; x += 4 * p.k) {
        p.paint(x, p.ht * 0.15, 1.6 * p.k, p.ht * 0.7, "rgba(0,0,0,0.18)", undefined, undefined, -0.5);
        p.paint(x + 1.6 * p.k, p.ht * 0.15, 1.2 * p.k, p.ht * 0.7, "rgba(255,255,255,0.08)", undefined, undefined, 0.6);
      }
      p.streaks(8, "rgba(100,70,40,0.25)", [10 * p.k, 40 * p.k], [1, 2 * p.k]);
      p.grime(0.2, 0.2);
    },
  },
  hazard: { w: 128, h: 128, bump: 1.2, paint: hazardBox },
  cabBeige: { w: 128, h: 192, bump: 1.5, paint: cabinetDoor("#cdbf9f", 0.55) },
  cabBrown: { w: 128, h: 192, bump: 1.5, paint: cabinetDoor("#6a5444", 0.6) },
  cabGrey: { w: 128, h: 192, bump: 1.5, paint: cabinetDoor("#c4c6c2", 0.55, "鎌高 5XK") },
  beige: { w: 32, h: 32, bump: 1, paint: enamel("#cdbf9f", 0.55, "#8d8576", { chips: 1, grime: 0.3 }) },
  brownPaint: { w: 32, h: 32, bump: 1, paint: enamel("#6a5444", 0.6, "#4a3a2e", { chips: 1, grime: 0.3 }) },
  greyPaint: { w: 32, h: 32, bump: 1, paint: enamel("#c4c6c2", 0.55, "#8d8f8a", { chips: 1, grime: 0.3 }) },
  /** Bell speaker: black with a grille of holes. */
  grille: {
    w: 32,
    h: 32,
    bump: 2,
    paint: (p: Pen) => {
      p.base("#18191a", 0.5);
      for (let y = 3 * p.k; y < p.ht; y += 4 * p.k) for (let x = 3 * p.k; x < p.w; x += 4 * p.k) p.shape((g) => g.arc(x, y, 1.1 * p.k, 0, Math.PI * 2), "#050505", 0.8, 0, -0.9);
    },
  },
  /** Concrete footing. */
  footing: {
    w: 32,
    h: 32,
    bump: 1.5,
    paint: (p: Pen) => {
      p.base("#a9a69c", 0.9);
      p.speckle(p.w * p.ht * 0.2, ["rgba(0,0,0,0.1)", "rgba(255,255,255,0.08)"], [1, 2 * p.k]);
      p.grime(0.6, 0.35);
    },
  },
  /** Delineator post: orange with two white retro-reflective bands; v up 0.8 m. */
  delineator: {
    w: 32,
    h: 128,
    bump: 1,
    paint: (p: Pen) => {
      p.base("#ec5a14", 0.45);
      for (const v of [0.12, 0.3]) p.paint(0, p.ht * v, p.w, p.ht * 0.08, "#f2f2ee", 0.3, 0, 0.2);
      p.grime(0.25, 0.45);
    },
  },
  ...SIGN_CELLS,
} satisfies Record<string, CellDef>;

export type CellKey = keyof typeof CELLS;

// ------------------------------------------------------------- atlas

interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
  rect: AtlasRect;
}

/** The painted atlas, its material and UV helpers. */
export class EquipAtlas {
  readonly size: number;
  readonly material: MeshStandardMaterial;
  readonly albedo: Texture;
  private cells = new Map<CellKey, Placed>();
  private lensMats = new Map<string, MeshStandardMaterial>();

  constructor(size: number) {
    this.size = size;
    const k = size / 1024;
    const A = canvas(size, size);
    const H = canvas(size, size);
    const O = canvas(size, size);
    A.g.fillStyle = "#808080";
    A.g.fillRect(0, 0, size, size);
    H.g.fillStyle = grey(0);
    H.g.fillRect(0, 0, size, size);
    O.g.fillStyle = orm(1, 0.6, 0);
    O.g.fillRect(0, 0, size, size);
    // Shelf packing, tallest first; 4 px (1024 space) of padding, filled by edge extrusion.
    const pad = Math.round(4 * k);
    const order = (Object.keys(CELLS) as CellKey[]).sort((a, b) => CELLS[b].h - CELLS[a].h || CELLS[b].w - CELLS[a].w);
    let x = pad;
    let y = pad;
    let shelf = 0;
    const r = new Rng(4242);
    const normals: { p: Placed; bump: number }[] = [];
    for (const key of order) {
      const def: CellDef = CELLS[key];
      const w = Math.round(def.w * k);
      const h = Math.round(def.h * k);
      if (x + w + pad > size) {
        x = pad;
        y += shelf + pad * 2;
        shelf = 0;
      }
      if (y + h + pad > size) throw new Error(`equipment atlas full at ${key}`);
      for (const c of [A.g, H.g, O.g]) {
        c.save();
        c.translate(x, y);
        c.beginPath();
        c.rect(0, 0, w, h);
        c.clip();
      }
      def.paint(new Pen(A.g, H.g, O.g, w, h, r, k, x, y));
      for (const c of [A.g, H.g, O.g]) c.restore();
      const placed: Placed = {
        x,
        y,
        w,
        h,
        rect: { u0: (x + 0.5) / size, u1: (x + w - 0.5) / size, v1: 1 - (y + 0.5) / size, v0: 1 - (y + h - 0.5) / size },
      };
      this.cells.set(key, placed);
      normals.push({ p: placed, bump: def.bump ?? 1 });
      for (const c of [A.c, H.c, O.c]) extrude(c, x, y, w, h, pad);
      x += w + pad * 2;
      shelf = Math.max(shelf, h);
    }
    const N = normalMap(H.c, normals, k, pad);
    const tex = (c: HTMLCanvasElement, srgb: boolean, name: string) => {
      const t = new CanvasTexture(c);
      t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
      t.anisotropy = 8;
      t.minFilter = LinearMipmapLinearFilter;
      t.wrapS = t.wrapT = ClampToEdgeWrapping;
      t.name = name;
      return t;
    };
    this.albedo = tex(A.c, true, "equipment");
    const ormTex = tex(O.c, false, "equipment-orm");
    this.material = new MeshStandardMaterial({
      map: this.albedo,
      normalMap: tex(N, false, "equipment-normal"),
      normalScale: new Vector2(1, 1),
      roughnessMap: ormTex,
      metalnessMap: ormTex,
      aoMap: ormTex,
      aoMapIntensity: 1,
      roughness: 1,
      metalness: 1,
    });
    this.material.name = "equipment";
  }

  rect(key: CellKey): AtlasRect {
    return this.cells.get(key)!.rect;
  }

  /** Maps a geometry's 0..1 UVs into a cell (optionally a sub-rectangle of it, in 0..1 cell units). */
  map(g: BufferGeometry, key: CellKey, sub?: [number, number, number, number]): BufferGeometry {
    const r = this.rect(key);
    const [su0, sv0, su1, sv1] = sub ?? [0, 0, 1, 1];
    const uv = g.getAttribute("uv") as BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const u = su0 + uv.getX(i) * (su1 - su0);
      const v = sv0 + uv.getY(i) * (sv1 - sv0);
      uv.setXY(i, r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0));
    }
    uv.needsUpdate = true;
    return g;
  }

  /**
   * A crossing lamp lens (or LED face): the atlas albedo also drives the
   * emission, so the lens shows its LED dots when lit and dark red glass
   * when off. `peak` is the lit emissive intensity (exported as the
   * material's emission; the crossing timeline scales it as a track).
   */
  lens(name: string, peak: number, tint = 0xffffff): MeshStandardMaterial {
    let m = this.lensMats.get(name);
    if (!m) {
      m = new MeshStandardMaterial({ map: this.albedo, emissiveMap: this.albedo, emissive: tint, emissiveIntensity: peak, roughness: 0.18, metalness: 0 });
      m.name = name;
      m.userData.peak = peak;
      this.lensMats.set(name, m);
    }
    return m;
  }
}

/** Repeats a cell's border pixels into its padding (keeps mip levels from bleeding neighbours in). */
function extrude(c: HTMLCanvasElement, x: number, y: number, w: number, h: number, pad: number): void {
  const g = c.getContext("2d")!;
  g.drawImage(c, x, y, w, 1, x, y - pad, w, pad);
  g.drawImage(c, x, y + h - 1, w, 1, x, y + h, w, pad);
  g.drawImage(c, x, y - pad, 1, h + pad * 2, x - pad, y - pad, pad, h + pad * 2);
  g.drawImage(c, x + w - 1, y - pad, 1, h + pad * 2, x + w, y - pad, pad, h + pad * 2);
}

/** Tangent-space normal map from the height canvas, cell by cell (neighbours clamped to the cell). */
function normalMap(H: HTMLCanvasElement, cells: { p: Placed; bump: number }[], k: number, pad: number): HTMLCanvasElement {
  const size = H.width;
  const src = H.getContext("2d")!.getImageData(0, 0, size, size).data;
  const out = canvas(size, size);
  const img = out.g.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 128;
    d[i + 1] = 128;
    d[i + 2] = 255;
    d[i + 3] = 255;
  }
  for (const { p, bump } of cells) {
    const s = (bump * 2.2) / k;
    const x0 = p.x - pad;
    const y0 = p.y - pad;
    const x1 = p.x + p.w + pad;
    const y1 = p.y + p.h + pad;
    const at = (x: number, y: number) => src[(Math.min(y1 - 1, Math.max(y0, y)) * size + Math.min(x1 - 1, Math.max(x0, x))) * 4] / 255;
    for (let y = Math.max(0, y0); y < Math.min(size, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * s;
        // Canvas rows run down; texture v runs up (flipY).
        const dy = (at(x, y - 1) - at(x, y + 1)) * s;
        const l = Math.hypot(dx, dy, 1);
        const i = (y * size + x) * 4;
        d[i] = Math.round((-dx / l) * 127 + 128);
        d[i + 1] = Math.round((-dy / l) * 127 + 128);
        d[i + 2] = Math.round((1 / l) * 127 + 128);
      }
  }
  out.g.putImageData(img, 0, 0);
  return out.c;
}

const atlases = new WeakMap<KamakuraWorld, EquipAtlas>();

/** The world's equipment atlas (built on first use). */
export function equipment(w: KamakuraWorld): EquipAtlas {
  let a = atlases.get(w);
  if (!a) {
    a = new EquipAtlas(w.quality.textureSize >= 2048 ? 2048 : 1024);
    atlases.set(w, a);
  }
  return a;
}

