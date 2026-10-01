import { BufferAttribute, MeshStandardMaterial, type BufferGeometry } from "three";
import { PbrAtlas, type CellDef, type CellPen } from "../../shared/pbr-atlas";
import { SIGN_CELLS } from "./roadsigns";

/**
 * The equipment atlas: every painted or bare-metal surface of the crossing
 * machinery, the poles, the wires, the signs and the street furniture in one
 * texture set (`shared/pbr-atlas.ts`), so all of it draws with one material
 * (two meshes: shadow casters and the wires, which cast none). It is also
 * the place's one palette of plain paints: small props take a solid cell
 * (`black`, `galv`, `wood`, …) instead of a colour of their own.
 *
 * Each cell is painted on albedo (sRGB), height (grey, 128 = flat; turned
 * into a tangent-space normal map cell by cell) and ORM (R occlusion, G
 * roughness, B metalness) at once. The atlas is 2048² on the web at high
 * quality and 1024² otherwise; the cooker stores it at 1024².
 */

// ------------------------------------------------------------- paints

const YELLOW = "#f1c000";
const BLACK = "#161616";

/**
 * The place's plain paints (albedo, roughness, metalness): the base of the
 * textured cells of the same name, and flat `solid-*` cells that small props
 * (posts, rails, frames, benches) sample at their centre (`EquipAtlas.solid`).
 */
export const PAINTS = {
  black: { c: "#151617", r: 0.42, m: 0 },
  white: { c: "#ebeae4", r: 0.48, m: 0 },
  beige: { c: "#cdbf9f", r: 0.55, m: 0 },
  galv: { c: "#a2a8ab", r: 0.42, m: 0.85 },
  aluminium: { c: "#c4c7c8", r: 0.35, m: 0.8 },
  wood: { c: "#6a5038", r: 0.6, m: 0 },
  brown: { c: "#4e3e32", r: 0.6, m: 0 },
  dark: { c: "#3a3d40", r: 0.6, m: 0 },
  rust: { c: "#5e4434", r: 0.6, m: 0 },
};
export type PaintName = keyof typeof PAINTS;

const SOLID_CELLS = Object.fromEntries(
  Object.entries(PAINTS).map(([name, f]) => [`solid-${name}`, { w: 8, h: 8, bump: 0, paint: (p: CellPen) => p.base(f.c, f.r, f.m) }]),
) as Record<`solid-${PaintName}`, CellDef>;

/** Glossy-ish enamel with chips, dust and a little dirt at the bottom. */
function enamel(color: string, rough: number, chip: string, opts: { chips?: number; grime?: number; dust?: string } = {}) {
  return (p: CellPen) => {
    p.base(color, rough);
    p.speckle(Math.round(p.w * p.ht * 0.02), ["rgba(255,255,255,0.05)", "rgba(0,0,0,0.06)"], [1, 2 * p.k]);
    p.chips(opts.chips ?? 6, 2.2 * p.k, chip, 0.75, 0);
    if (opts.dust) p.streaks(8, opts.dust, [p.ht * 0.2, p.ht * 0.7], [1 * p.k, 3 * p.k]);
    if (opts.grime) p.grime(0.35, opts.grime);
  };
}

/** Hot-dip galvanised steel: mottled spangle, white-rust blooms, metallic. */
function galvanised(p: CellPen): void {
  p.base(PAINTS.galv.c, PAINTS.galv.r, PAINTS.galv.m);
  for (let i = 0; i < p.w * p.ht * 0.004; i++) {
    const s = p.r.range(3, 9) * p.k;
    const v = p.r.int(-14, 14);
    p.shape((g) => g.rect(p.r.next() * p.w, p.r.next() * p.ht, s, s * p.r.range(0.6, 1.4)), `rgba(${160 + v},${166 + v},${170 + v},0.5)`, 0.38 + p.r.range(-0.08, 0.1), 0.85);
  }
  p.chips(5, 3 * p.k, "#c9c9c2", 0.8, 0.2);
}

/** Black-yellow diagonal hazard stripes (gate housings). */
function hazardBox(p: CellPen): void {
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
  return (p: CellPen) => {
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
    paint: (p: CellPen) => {
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
    paint: (p: CellPen) => {
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
    paint: (p: CellPen) => {
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
    paint: (p: CellPen) => {
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
  black: { w: 64, h: 64, bump: 1, paint: enamel(PAINTS.black.c, PAINTS.black.r, "#5d5e5c", { chips: 5, dust: "rgba(140,130,115,0.12)", grime: 0.15 }) },
  blackMatte: { w: 32, h: 32, bump: 1, paint: enamel("#1b1c1d", 0.7, "#4a4b49", { chips: 2 }) },
  galv: { w: 64, h: 64, bump: 1, paint: galvanised },
  steel: {
    w: 32,
    h: 32,
    bump: 0.5,
    paint: (p: CellPen) => {
      p.base("#b8bdc0", 0.28, 1);
      for (let x = 0; x < p.w; x += 1) p.paint(x, 0, 1, p.ht, `rgba(${p.r.next() < 0.5 ? "255,255,255" : "0,0,0"},0.05)`);
      p.grime(0.3, 0.3);
    },
  },
  orange: { w: 64, h: 64, bump: 1, paint: enamel("#e8661e", 0.5, "#a8a294", { chips: 4, grime: 0.2, dust: "rgba(120,100,80,0.12)" }) },
  white: { w: 64, h: 64, bump: 1, paint: enamel(PAINTS.white.c, PAINTS.white.r, "#9a9a92", { chips: 3, grime: 0.25, dust: "rgba(110,100,85,0.15)" }) },
  yellow: { w: 32, h: 32, bump: 1, paint: enamel(YELLOW, 0.45, "#8e8a7e", { chips: 3, grime: 0.2 }) },
  /** Enoden pole steel: dark-brown paint over rust; v along the pole. */
  brownSteel: {
    w: 64,
    h: 512,
    bump: 1.5,
    paint: (p: CellPen) => {
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
    paint: (p: CellPen) => {
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
  cable: { w: 16, h: 16, bump: 0.5, paint: (p: CellPen) => p.base("#141516", 0.62) },
  /** Twisted aerial cable: a lashing wire wound round the bundle (u along a short length, v around). */
  twisted: {
    w: 64,
    h: 32,
    bump: 3,
    paint: (p: CellPen) => {
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
  porcelain: { w: 16, h: 16, bump: 0.3, paint: (p: CellPen) => p.base("#e4e1d8", 0.18) },
  /** Pole transformer can: grey with cooling ribs. */
  transformer: {
    w: 64,
    h: 64,
    bump: 2.5,
    paint: (p: CellPen) => {
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
  beige: { w: 32, h: 32, bump: 1, paint: enamel(PAINTS.beige.c, PAINTS.beige.r, "#8d8576", { chips: 1, grime: 0.3 }) },
  brownPaint: { w: 32, h: 32, bump: 1, paint: enamel("#6a5444", 0.6, "#4a3a2e", { chips: 1, grime: 0.3 }) },
  greyPaint: { w: 32, h: 32, bump: 1, paint: enamel("#c4c6c2", 0.55, "#8d8f8a", { chips: 1, grime: 0.3 }) },
  /** Bell speaker: black with a grille of holes. */
  grille: {
    w: 32,
    h: 32,
    bump: 2,
    paint: (p: CellPen) => {
      p.base("#18191a", 0.5);
      for (let y = 3 * p.k; y < p.ht; y += 4 * p.k) for (let x = 3 * p.k; x < p.w; x += 4 * p.k) p.shape((g) => g.arc(x, y, 1.1 * p.k, 0, Math.PI * 2), "#050505", 0.8, 0, -0.9);
    },
  },
  /** Concrete footing. */
  footing: {
    w: 32,
    h: 32,
    bump: 1.5,
    paint: (p: CellPen) => {
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
    paint: (p: CellPen) => {
      p.base("#ec5a14", 0.45);
      for (const v of [0.12, 0.3]) p.paint(0, p.ht * v, p.w, p.ht * 0.08, "#f2f2ee", 0.3, 0, 0.2);
      p.grime(0.25, 0.45);
    },
  },
  ...SIGN_CELLS,
  ...SOLID_CELLS,
} satisfies Record<string, CellDef>;

export type CellKey = keyof typeof CELLS;

// ------------------------------------------------------------- atlas

/** The painted atlas, its material, UV helpers and the crossing's lamp lenses. */
export class EquipAtlas extends PbrAtlas<CellKey> {
  private lensMats = new Map<string, MeshStandardMaterial>();

  constructor(size: number) {
    super(size, CELLS, { name: "equipment", seed: 4242 });
  }

  /** Paints a geometry one plain colour: every UV goes to the centre of the paint's flat cell. */
  solid(g: BufferGeometry, paint: PaintName): BufferGeometry {
    const r = this.rect(`solid-${paint}`);
    const u = (r.u0 + r.u1) / 2;
    const v = (r.v0 + r.v1) / 2;
    const n = g.getAttribute("position").count;
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      uv[i * 2] = u;
      uv[i * 2 + 1] = v;
    }
    g.setAttribute("uv", new BufferAttribute(uv, 2));
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
      this.lensMats.set(name, m);
    }
    return m;
  }
}
