import { CanvasTexture, LinearMipmapLinearFilter, NoColorSpace, SRGBColorSpace } from "three";
import { Rng } from "../../../core/random";
import type { AtlasRect } from "../../shared/atlas";
import { heightToNormal, paintLayer, type Finish, type Layer, type LayerPen, type NormalRegion } from "../../shared/pbr-atlas";

/**
 * The observatory's trim atlas: every painted detail of the building in one
 * texture set (albedo, ORM, height → normal, emission), so the windows, the
 * entrance, the lettering, the Greek-key bands, the pilaster flutes, the
 * drum's panels and the Zeiss dome's lit interior draw as one material.
 * Cells sit on a 1024-pixel layout; wall-coloured cell grounds match the
 * coated concrete (`COATED`) so trim and wall meet without a seam.
 *
 * Photographs: bronze-grille tall windows lit amber at blue hour (p02, p04,
 * p05: 3 lights × 6 panes, warm glow brightest high up), the bronze-and-glass
 * entrance under its transom (p05), "GRIFFITH OBSERVATORY" in bronze capitals
 * on the entrance frieze (p04, p05), the Greek key (p09, p14, p23), the
 * drum's fluted bay panels under a row of small arches (p09), the Zeiss
 * dome's ribbed interior through the open shutter (p20).
 */

const L = 1024;

/** Cell rectangles in layout pixels: x, y (top), w, h. */
const CELLS = {
  letters: [0, 0, 1024, 72],
  window: [0, 72, 128, 256],
  window2: [128, 72, 128, 256],
  door: [256, 72, 192, 288],
  panel: [448, 72, 256, 256],
  key: [704, 72, 256, 64],
  flutes: [960, 72, 64, 256],
  vent: [704, 136, 96, 128],
  drumWin: [800, 136, 64, 96],
  drumDark: [864, 136, 64, 96],
  slit: [0, 360, 128, 384],
  astro: [128, 360, 96, 256],
  astro2: [224, 360, 96, 256],
  plaque: [320, 360, 128, 64],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export type ArtCell = keyof typeof CELLS;

/** Atlas rectangle of a cell (UV, v up), half a texel inside its edge. */
export function artRect(k: ArtCell): AtlasRect {
  const [x, y, w, h] = CELLS[k];
  return { u0: (x + 0.5) / L, u1: (x + w - 0.5) / L, v1: 1 - (y + 0.5) / L, v0: 1 - (y + h - 0.5) / L };
}

/** Physical size the cells are drawn for (m, width × height). */
export const ART_SIZE = {
  window: [1.6, 3.2],
  door: [3.6, 5.4],
  panel: [3.4, 3.4],
  key: [1.44, 0.36],
  slit: [2.4, 7.2],
} as const;

// ------------------------------------------------------------------ finishes

const WALL: Finish = { c: "#dbd5c9", r: 0.76, m: 0, h: 0.5 };
const WALL_SHADE: Finish = { c: "#c9c2b5", r: 0.8, m: 0, h: 0.42 };
const GROOVE: Finish = { c: "#9d968a", r: 0.85, m: 0, h: 0.22 };
const BRONZE: Finish = { c: "#4a3826", r: 0.42, m: 0.85, h: 0.66 };
const BRONZE_DK: Finish = { c: "#2a1f15", r: 0.5, m: 0.8, h: 0.6 };
const GLASS_DARK: Finish = { c: "#0b0d11", r: 0.08, m: 0, h: 0.46, e: "#000" };

const glass = (e: string): Finish => ({ c: "#1d1810", r: 0.1, m: 0, h: 0.46, e });

/** sRGB hex for an emission level (0–1) of the amber interior light. */
function amber(k: number, hue = 0): string {
  // sRGB (255, 198, 88): through the AgX grade the panes land near p04's (209, 174, 97).
  const r = Math.min(255, Math.round(255 * k));
  const g = Math.min(255, Math.round((198 + hue * 20) * k));
  const b = Math.min(255, Math.round((88 + hue * 30) * k));
  return `rgb(${r},${g},${b})`;
}

// ------------------------------------------------------------------ painters

/**
 * A tall bronze window (1.6 × 3.2 m): a deep bronze frame, two mullions and
 * five transoms (3 × 6 lights), a decorative bronze spandrel across the
 * fifth row, the glass amber with a lit ceiling near the top and exhibit
 * silhouettes low down.
 */
function windowCell(p: LayerPen, x: number, y: number, w: number, h: number, r: Rng, level: number): void {
  p.rect(x, y, w, h, BRONZE_DK);
  const fx = w * 0.07;
  const fy = h * 0.035;
  const gx0 = x + fx;
  const gx1 = x + w - fx;
  const gy0 = y + fy;
  const gy1 = y + h - fy;
  const rows = 6;
  const cols = 3;
  const cw = (gx1 - gx0) / cols;
  const rh = (gy1 - gy0) / rows;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const px0 = gx0 + i * cw + 2.5;
      const py0 = gy0 + j * rh + 2.5;
      const pw = cw - 5;
      const ph = rh - 5;
      // Ceiling light: brightest up high, falling off toward the sill.
      const k = level * (0.95 - 0.35 * (j / rows) + r.range(-0.05, 0.05)) * (i === 1 ? 1.04 : 0.96);
      p.rect(px0, py0, pw, ph, glass(amber(k)));
      if (p.mode === "emit" || p.albedo) {
        // A softer centre in each pane (the interior's depth), and dark exhibit shapes low down.
        const f = glass(amber(k * 1.12));
        p.rect(px0 + pw * 0.2, py0 + ph * 0.15, pw * 0.6, ph * 0.7, f);
        if (j >= 4 && r.chance(0.6)) p.rect(px0 + pw * r.range(0, 0.5), py0 + ph * r.range(0.2, 0.6), pw * r.range(0.25, 0.5), ph, glass(amber(k * 0.35)));
      }
    }
  // Spandrel: a bronze band with chevrons across row 5, at the floor line.
  const sy = gy0 + rh * 4.62;
  p.rect(gx0, sy, gx1 - gx0, rh * 0.32, BRONZE);
  for (let i = 0; i < 9; i++) {
    const cx = gx0 + ((i + 0.5) / 9) * (gx1 - gx0);
    p.poly(
      [
        [cx - 4, sy + rh * 0.04],
        [cx, sy + rh * 0.28],
        [cx + 4, sy + rh * 0.04],
      ],
      BRONZE_DK,
    );
  }
  // Mullions and transoms over the glass.
  for (let i = 1; i < cols; i++) p.rect(gx0 + i * cw - 2.5, gy0, 5, gy1 - gy0, BRONZE);
  for (let j = 1; j < rows; j++) p.rect(gx0, gy0 + j * rh - 2.5, gx1 - gx0, 5, BRONZE);
  // Frame lip.
  p.rect(x, y, w, 3, BRONZE);
  p.rect(x, y + h - 4, w, 4, BRONZE);
}

/**
 * The entrance (3.6 × 5.4 m): three pairs of bronze-framed glass doors under
 * a tall grilled transom, a stepped bronze surround; the lobby lit warm.
 */
function doorCell(p: LayerPen, x: number, y: number, w: number, h: number, r: Rng): void {
  p.rect(x, y, w, h, BRONZE_DK);
  const m = w * 0.05;
  p.rect(x + m * 0.5, y + m * 0.5, w - m, h - m * 0.5, BRONZE);
  const ix0 = x + m;
  const ix1 = x + w - m;
  const iy0 = y + m;
  const iy1 = y + h;
  const transom = iy0 + (iy1 - iy0) * 0.38;
  // Transom: a grille of narrow lights over a lit lobby ceiling.
  p.rect(ix0, iy0, ix1 - ix0, transom - iy0, glass(amber(1.05)));
  for (let i = 0; i <= 12; i++) p.rect(ix0 + ((ix1 - ix0) * i) / 12 - 1.5, iy0, 3, transom - iy0, BRONZE);
  for (let j = 1; j < 4; j++) p.rect(ix0, iy0 + ((transom - iy0) * j) / 4 - 1.5, ix1 - ix0, 3, BRONZE);
  p.rect(ix0, transom - 5, ix1 - ix0, 10, BRONZE);
  // Six leaves.
  const n = 6;
  const lw = (ix1 - ix0) / n;
  for (let i = 0; i < n; i++) {
    const lx = ix0 + i * lw;
    p.rect(lx + 3, transom + 5, lw - 6, iy1 - transom - 5, glass(amber(r.range(0.85, 1.1))));
    p.rect(lx + 3, transom + 5, 4, iy1 - transom - 5, BRONZE);
    p.rect(lx + lw - 7, transom + 5, 4, iy1 - transom - 5, BRONZE);
    p.rect(lx + 3, iy1 - 22, lw - 6, 22, BRONZE);
    p.rect(lx + 3, transom + 5, lw - 6, 6, BRONZE);
    // Push bar.
    p.rect(lx + 6, transom + (iy1 - transom) * 0.5, lw - 12, 3, BRONZE_DK);
  }
}

/** "GRIFFITH OBSERVATORY": bronze capitals on the coated frieze, slightly raised. */
function lettersCell(p: LayerPen, x: number, y: number, w: number, h: number): void {
  p.rect(x, y, w, h, WALL);
  const g = p.g;
  g.save();
  g.font = `600 ${Math.round(h * 0.62)}px "Futura", "Avenir Next", "Century Gothic", "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const text = "GRIFFITH  OBSERVATORY";
  // Wide tracking, drawn glyph by glyph.
  const chars = Array.from(text);
  const track = h * 0.18;
  const widths = chars.map((c) => g.measureText(c).width + track);
  const total = widths.reduce((a, b) => a + b, 0) - track;
  const scale = Math.min(1, (w * 0.94) / total);
  let cx = x + w / 2 - (total * scale) / 2;
  g.fillStyle = p.style(BRONZE);
  for (let i = 0; i < chars.length; i++) {
    const cw = widths[i] * scale;
    g.save();
    g.translate(cx + (cw - track * scale) / 2, y + h * 0.54);
    g.scale(scale, 1);
    g.fillText(chars[i], 0, 0);
    g.restore();
    cx += cw;
  }
  g.restore();
}

/**
 * Greek key (meander) band, two units of 0.72 m: the key incised 25 mm into
 * the coating between two fillets, tiling at the cell's left and right edges.
 */
function keyCell(p: LayerPen, x: number, y: number, w: number, h: number): void {
  p.rect(x, y, w, h, WALL);
  p.rect(x, y, w, h * 0.09, GROOVE);
  p.rect(x, y + h * 0.91, w, h * 0.09, GROOVE);
  const u = w / 2;
  const s = h * 0.16;
  // One unit of the running key as a polyline in unit coordinates (0..4 wide, 0..4 tall), line width 1.
  const path: [number, number][] = [
    [0, 3.5],
    [3.5, 3.5],
    [3.5, 0.5],
    [1.0, 0.5],
    [1.0, 2.5],
    [2.5, 2.5],
    [2.5, 1.5],
  ];
  for (let k = -1; k <= 2; k++) {
    const ox = x + k * u;
    const sx = u / 4;
    const sy = (h * 0.72) / 4;
    const oy = y + h * 0.14;
    const g = p.g;
    g.save();
    g.strokeStyle = p.style(GROOVE);
    g.lineWidth = s;
    g.lineJoin = "miter";
    g.lineCap = "square";
    g.beginPath();
    path.forEach(([a, b], i) => (i ? g.lineTo(ox + a * sx, oy + b * sy) : g.moveTo(ox + a * sx, oy + b * sy)));
    g.lineTo(ox + 4 * sx, oy + 3.5 * sy);
    g.stroke();
    g.restore();
  }
}

/** Three concave flutes down a pilaster face (64 × 256, uniform along its length). */
function flutesCell(p: LayerPen, x: number, y: number, w: number, h: number): void {
  p.rect(x, y, w, h, WALL);
  if (p.mode === "height" || p.albedo) {
    const g = p.g;
    for (let i = 0; i < 3; i++) {
      const cx = x + w * (0.22 + i * 0.28);
      const fw = w * 0.2;
      const grad = g.createLinearGradient(cx - fw / 2, 0, cx + fw / 2, 0);
      if (p.albedo) {
        grad.addColorStop(0, "rgba(120,112,100,0.0)");
        grad.addColorStop(0.35, "rgba(120,112,100,0.35)");
        grad.addColorStop(1, "rgba(255,250,240,0.12)");
      } else {
        grad.addColorStop(0, "rgb(128,128,128)");
        grad.addColorStop(0.5, "rgb(70,70,70)");
        grad.addColorStop(1, "rgb(128,128,128)");
      }
      g.fillStyle = grad;
      g.fillRect(cx - fw / 2, y, fw, h);
    }
  }
}

/**
 * An upper-drum bay (p09): a recessed field of vertical flutes under a row of
 * five small round arches and a narrow fillet; the arches cast a dark line.
 */
function panelCell(p: LayerPen, x: number, y: number, w: number, h: number): void {
  p.rect(x, y, w, h, WALL);
  const m = w * 0.06;
  p.rect(x + m, y + h * 0.1, w - 2 * m, h * 0.86, WALL_SHADE);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const fx = x + m + ((i + 0.5) / n) * (w - 2 * m);
    p.rect(fx - 3, y + h * 0.3, 6, h * 0.62, GROOVE);
  }
  // Row of small arches across the top of the field.
  const a = 5;
  const aw = (w - 2 * m) / a;
  for (let i = 0; i < a; i++) {
    const ax = x + m + i * aw;
    const g = p.g;
    g.beginPath();
    g.moveTo(ax + 3, y + h * 0.27);
    g.lineTo(ax + 3, y + h * 0.17);
    g.arc(ax + aw / 2, y + h * 0.17, aw / 2 - 3, Math.PI, 0);
    g.lineTo(ax + aw - 3, y + h * 0.27);
    g.closePath();
    p.fill(GROOVE);
    g.beginPath();
    g.moveTo(ax + 7, y + h * 0.27);
    g.lineTo(ax + 7, y + h * 0.18);
    g.arc(ax + aw / 2, y + h * 0.18, aw / 2 - 7, Math.PI, 0);
    g.lineTo(ax + aw - 7, y + h * 0.27);
    g.closePath();
    p.fill(WALL_SHADE);
  }
  p.rect(x + m, y + h * 0.27, w - 2 * m, 4, GROOVE);
}

/** A small square drum window with a bronze grille; `lit` glows amber. */
function smallWindow(p: LayerPen, x: number, y: number, w: number, h: number, lit: number): void {
  p.rect(x, y, w, h, BRONZE_DK);
  p.rect(x + 4, y + 4, w - 8, h - 8, lit > 0 ? glass(amber(lit)) : GLASS_DARK);
  for (let i = 1; i < 3; i++) p.rect(x + 4 + ((w - 8) * i) / 3 - 1.5, y + 4, 3, h - 8, BRONZE);
  for (let j = 1; j < 4; j++) p.rect(x + 4, y + 4 + ((h - 8) * j) / 4 - 1.5, w - 8, 3, BRONZE);
}

/**
 * The Zeiss dome's interior seen through the open shutter (p20): curved
 * steel ribs and purlins lit warm from below, brighter toward the base.
 */
function slitCell(p: LayerPen, x: number, y: number, w: number, h: number): void {
  for (let j = 0; j < 32; j++) {
    const k = 0.55 + 0.5 * (j / 31);
    p.rect(x, y + (h * j) / 32, w, h / 32 + 1, { c: "#2a2015", r: 0.6, m: 0.3, h: 0.4, e: amber(k * 0.9, -0.3) });
  }
  // Purlins (horizontal) and two ribs (vertical), dark against the lit skin.
  for (let j = 0; j < 14; j++) p.rect(x, y + (h * (j + 0.5)) / 14 - 2, w, 4, { c: "#1a130c", r: 0.6, m: 0.6, h: 0.6, e: amber(0.25) });
  p.rect(x + w * 0.22, y, 6, h, { c: "#1a130c", r: 0.6, m: 0.6, h: 0.6, e: amber(0.18) });
  p.rect(x + w * 0.78 - 6, y, 6, h, { c: "#1a130c", r: 0.6, m: 0.6, h: 0.6, e: amber(0.18) });
}

/**
 * One astronomer in relief on the monument's shaft (Hipparchus, Copernicus,
 * Galileo, Kepler, Newton, Herschel — six figures, painted as two robed
 * silhouettes and mirrored): raised figure, folded drapery in the height.
 */
function astronomerCell(p: LayerPen, x: number, y: number, w: number, h: number, r: Rng, variant: number): void {
  p.rect(x, y, w, h, WALL);
  const g = p.g;
  const cx = x + w / 2;
  const rise: Finish = { c: "#e3ddd2", r: 0.7, m: 0, h: 0.85 };
  const fold: Finish = { c: "#cfc8bb", r: 0.75, m: 0, h: 0.7 };
  // Robe: a long tapered body.
  g.beginPath();
  g.moveTo(cx - w * 0.16, y + h * 0.22);
  g.quadraticCurveTo(cx - w * (0.3 + 0.05 * variant), y + h * 0.6, cx - w * 0.34, y + h * 0.97);
  g.lineTo(cx + w * 0.34, y + h * 0.97);
  g.quadraticCurveTo(cx + w * 0.28, y + h * 0.6, cx + w * 0.16, y + h * 0.22);
  g.closePath();
  p.fill(rise);
  // Head.
  p.disc(cx + (variant ? 2 : -2), y + h * 0.14, w * 0.12, rise);
  // Drapery folds.
  for (let i = 0; i < 6; i++) {
    const fx = cx + (i - 2.5) * w * 0.1 + r.range(-2, 2);
    p.line(fx, y + h * 0.35, fx + r.range(-6, 6), y + h * 0.96, 2.5, fold);
  }
  // An instrument held across the chest (a globe or a book).
  if (variant) p.disc(cx + w * 0.12, y + h * 0.36, w * 0.1, rise);
  else p.rect(cx - w * 0.2, y + h * 0.33, w * 0.28, h * 0.07, rise);
}

/** A bronze plaque (the monument's dedication). */
function plaqueCell(p: LayerPen, x: number, y: number, w: number, h: number): void {
  p.rect(x, y, w, h, BRONZE);
  p.rect(x + 4, y + 4, w - 8, h - 8, BRONZE_DK);
  for (let j = 0; j < 5; j++) p.rect(x + 12, y + 12 + j * 9, w - 24 - (j % 2) * 14, 3, BRONZE);
}

/** Paints one layer of the whole atlas. */
function paintArt(p: LayerPen): void {
  const r = new Rng(1935);
  const at = (k: ArtCell) => CELLS[k];
  // Unused ground: wall.
  p.rect(0, 0, L, L, WALL);
  let [x, y, w, h] = at("letters");
  lettersCell(p, x, y, w, h);
  [x, y, w, h] = at("window");
  windowCell(p, x, y, w, h, r, 1);
  [x, y, w, h] = at("window2");
  windowCell(p, x, y, w, h, r, 0.78);
  [x, y, w, h] = at("door");
  doorCell(p, x, y, w, h, r);
  [x, y, w, h] = at("panel");
  panelCell(p, x, y, w, h);
  [x, y, w, h] = at("key");
  keyCell(p, x, y, w, h);
  [x, y, w, h] = at("flutes");
  flutesCell(p, x, y, w, h);
  [x, y, w, h] = at("vent");
  smallWindow(p, x, y, w, h, 0);
  [x, y, w, h] = at("drumWin");
  smallWindow(p, x, y, w, h, 0.8);
  [x, y, w, h] = at("drumDark");
  smallWindow(p, x, y, w, h, 0);
  [x, y, w, h] = at("slit");
  slitCell(p, x, y, w, h);
  [x, y, w, h] = at("astro");
  astronomerCell(p, x, y, w, h, r, 0);
  [x, y, w, h] = at("astro2");
  astronomerCell(p, x, y, w, h, r, 1);
  [x, y, w, h] = at("plaque");
  plaqueCell(p, x, y, w, h);
}

function tex(c: HTMLCanvasElement, srgb: boolean, name: string): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.anisotropy = 8;
  t.minFilter = LinearMipmapLinearFilter;
  t.name = name;
  return t;
}

export interface ArtMaps {
  map: CanvasTexture;
  ormMap: CanvasTexture;
  normalMap: CanvasTexture;
  emissiveMap: CanvasTexture;
}

/** Paints the atlas at `size` pixels (1024 or 2048). */
export function paintArtAtlas(size: number): ArtMaps {
  const scale = size / L;
  const layer = (mode: Layer) => paintLayer(L, L, scale, mode, paintArt);
  const height = layer("height");
  const regions: NormalRegion[] = Object.values(CELLS).map(([x, y, w, h]) => ({ x: x * scale, y: y * scale, w: w * scale, h: h * scale, strength: 2.2 / scale }));
  return {
    map: tex(layer("albedo"), true, "griffith-art"),
    ormMap: tex(layer("orm"), false, "griffith-art-orm"),
    normalMap: tex(heightToNormal(height, regions), false, "griffith-art-normal"),
    emissiveMap: tex(layer("emit"), true, "griffith-art-emit"),
  };
}
