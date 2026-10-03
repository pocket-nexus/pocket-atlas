import { Color, DoubleSide } from "three";
import { extrudeEdges } from "../../../places/shared/atlas";
import { canvas, HEAVY, JP_SANS, LATIN, toTexture, type Ctx } from "../../../places/shared/canvas";
import type { Kit } from "./materials";
import { ATLAS_PAD, ATLAS_SIZE, CELLS, CUT_CELLS, PYLON, STATIONS } from "./structures-layout";

/**
 * The kit materials of `gen/structures.ts` (bridges, rivers, the railway,
 * power lines):
 *
 *   structure      lit, tinted by vertex colour, on the structures atlas
 *                  (`kit/structures-layout.ts`): concrete, painted steel,
 *                  rails, crossing equipment, station name boards
 *   structure-cut  the same atlas alpha-tested and two-sided: lattice pylons
 *   water          open river water: dark, smooth, lit by the sky
 */

type Paint = (g: Ctx, w: number, h: number) => void;

/** 0..1 from an integer: the painter's marks are the same on every run. */
function hash(i: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

const plain: Paint = (g, w, h) => {
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, w, h);
};

/**
 * Board-formed concrete after some winters: pale grey, lift lines every
 * 0.9 m, tie holes, dark streaks below the lines, a damp foot. The cell is
 * 4 m and is laid mirrored, so nothing in it may read as a direction.
 */
const concrete: Paint = (g, w, h) => {
  g.fillStyle = "#b4b2ac";
  g.fillRect(0, 0, w, h);
  // Mottle.
  for (let i = 0; i < 900; i++) {
    const x = hash(i * 3) * w;
    const y = hash(i * 3 + 1) * h;
    const r = 1 + hash(i * 3 + 2) * (w / 30);
    const v = hash(i * 7 + 5);
    g.fillStyle = v > 0.5 ? `rgba(255,255,250,${0.03 + 0.04 * v})` : `rgba(60,62,66,${0.03 + 0.05 * (1 - v)})`;
    g.beginPath();
    g.ellipse(x, y, r * 2.2, r, 0, 0, Math.PI * 2);
    g.fill();
  }
  // Streaks running down from the lift lines.
  for (let i = 0; i < 46; i++) {
    const x = hash(i * 11 + 400) * w;
    const lift = Math.floor(hash(i * 11 + 401) * 4.4) * (h / 4.4);
    const len = (0.06 + 0.2 * hash(i * 11 + 402)) * h;
    const grad = g.createLinearGradient(0, lift, 0, lift + len);
    grad.addColorStop(0, "rgba(58,58,60,0.26)");
    grad.addColorStop(1, "rgba(58,58,60,0)");
    g.fillStyle = grad;
    g.fillRect(x, lift, 1 + hash(i * 11 + 403) * (w / 60), len);
  }
  // Lift lines and panel joints.
  g.fillStyle = "rgba(70,70,72,0.42)";
  for (let k = 1; k < 4.4; k++) g.fillRect(0, Math.round((k * h) / 4.4), w, Math.max(1, h / 160));
  g.fillStyle = "rgba(70,70,72,0.2)";
  g.fillRect(Math.round(w / 2), 0, Math.max(1, w / 200), h);
  // Tie holes.
  g.fillStyle = "rgba(52,52,54,0.5)";
  for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) g.fillRect(((j + 0.5) * w) / 4, ((k + 0.5) * h) / 4.4, Math.max(1, w / 110), Math.max(1, w / 110));
  // The foot is damp and dirty; the head is bleached.
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(255,255,255,0.07)");
  grad.addColorStop(0.7, "rgba(40,42,46,0.02)");
  grad.addColorStop(1, "rgba(40,42,46,0.2)");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
};

/**
 * A plate girder's web, 5 m of it: near white so the vertex colour is the
 * paint, with flanges top and bottom, vertical stiffeners every 1.25 m and
 * the rust that runs from them. Mirrors at both ends.
 */
const plate: Paint = (g, w, h) => {
  g.fillStyle = "#e9e9e6";
  g.fillRect(0, 0, w, h);
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(20,20,24,0.3)");
  grad.addColorStop(0.16, "rgba(20,20,24,0.08)");
  grad.addColorStop(1, "rgba(20,20,24,0.16)");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // Flanges: a lit edge above, a shaded one below.
  g.fillStyle = "rgba(255,255,255,0.5)";
  g.fillRect(0, 0, w, h * 0.06);
  g.fillStyle = "rgba(30,30,34,0.45)";
  g.fillRect(0, h * 0.06, w, h * 0.035);
  g.fillStyle = "rgba(30,30,34,0.5)";
  g.fillRect(0, h * 0.9, w, h * 0.1);
  g.fillStyle = "rgba(255,255,255,0.35)";
  g.fillRect(0, h * 0.875, w, h * 0.03);
  // Stiffeners (the cell's ends are stiffeners too, so mirrored copies join on one).
  for (let k = 0; k <= 4; k++) {
    const x = Math.min(w - 2, Math.max(0, (k * w) / 4 - 1));
    g.fillStyle = "rgba(255,255,255,0.4)";
    g.fillRect(x, h * 0.09, 1.2, h * 0.79);
    g.fillStyle = "rgba(24,24,28,0.5)";
    g.fillRect(x + 1.2, h * 0.09, 1.6, h * 0.79);
    const rust = g.createLinearGradient(0, h * 0.5, 0, h * 0.9);
    rust.addColorStop(0, "rgba(120,62,30,0)");
    rust.addColorStop(1, "rgba(120,62,30,0.3)");
    g.fillStyle = rust;
    g.fillRect(x - 2, h * 0.5, 7, h * 0.4);
  }
};

/** Draws a lattice body between two heights: legs and X bracing per panel. */
function lattice(g: Ctx, cx: number, y0: number, y1: number, half0: number, half1: number, panels: number, leg: number, brace: number): void {
  const ys: number[] = [];
  // Panels shorten toward the top with the taper.
  const sizes = Array.from({ length: panels }, (_, i) => 1 - (0.55 * i) / panels);
  const sum = sizes.reduce((a, b) => a + b, 0);
  let acc = 0;
  ys.push(y0);
  for (const s of sizes) {
    acc += s;
    ys.push(y0 + ((y1 - y0) * acc) / sum);
  }
  const half = (y: number) => half0 + ((half1 - half0) * (y - y0)) / (y1 - y0);
  g.lineCap = "square";
  g.lineWidth = leg;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + side * half0, y0);
    g.lineTo(cx + side * half1, y1);
    g.stroke();
  }
  g.lineWidth = brace;
  for (let i = 0; i < panels; i++) {
    const a = ys[i];
    const b = ys[i + 1];
    g.beginPath();
    g.moveTo(cx - half(a), a);
    g.lineTo(cx + half(b), b);
    g.moveTo(cx + half(a), a);
    g.lineTo(cx - half(b), b);
    g.moveTo(cx - half(b), b);
    g.lineTo(cx + half(b), b);
    g.stroke();
  }
}

/** Galvanised steel under an overcast sky: mid grey, a little lighter than it reads against snow. */
const STEEL = "#6f767c";

/**
 * A transmission tower across the line (`arms`) or along it: the cell's
 * height is the tower's, y 0 at its foot. Members are drawn heavier than
 * true so the cut-out survives its mips.
 */
const pylon =
  (arms: boolean): Paint =>
  (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = STEEL;
    g.fillStyle = STEEL;
    const leg = Math.max(2.2, h / 190);
    const brace = Math.max(1.4, h / 330);
    const cx = w / 2;
    const Y = (f: number) => h * (1 - f);
    const X = (f: number) => f * h;
    const k = arms ? 1 : 0.8;
    lattice(g, cx, Y(0), Y(PYLON.waistAt), X(PYLON.foot) * k, X(PYLON.waist) * k, 6, leg, brace);
    lattice(g, cx, Y(PYLON.waistAt), Y(0.97), X(PYLON.waist) * k, X(PYLON.waist) * 0.55 * k, 6, leg, brace);
    // The peak that carries the earth wire.
    g.lineWidth = leg;
    g.beginPath();
    g.moveTo(cx - X(PYLON.waist) * 0.55 * k, Y(0.97));
    g.lineTo(cx, Y(1) + leg);
    g.lineTo(cx + X(PYLON.waist) * 0.55 * k, Y(0.97));
    g.stroke();
    for (const a of PYLON.arms) {
      if (arms) {
        // A cross-arm: a tapered truss to each side.
        const y = Y(a.y);
        const d = h * 0.03;
        g.lineWidth = brace * 1.2;
        for (const side of [-1, 1]) {
          const tip = cx + side * X(a.half);
          const root = cx + side * X(PYLON.waist) * 0.8;
          g.beginPath();
          g.moveTo(root, y - d);
          g.lineTo(tip, y);
          g.lineTo(root, y + d * 0.5);
          g.moveTo(cx + side * X(a.half) * 0.55, y - d * 0.45);
          g.lineTo(cx + side * X(a.half) * 0.55, y + d * 0.22);
          g.stroke();
          // The insulator string.
          g.fillRect(tip - brace * 0.9, y, brace * 1.8, h * 0.022);
        }
      } else {
        // Seen along the line the arms are their ends: a thickening of the body.
        g.fillRect(cx - X(PYLON.waist) * 1.25, Y(a.y) - h * 0.012, X(PYLON.waist) * 2.5, h * 0.02);
      }
    }
  };

/**
 * A JR Hokkaido station name board: the reading large, the name under it,
 * a spring-green band, the romanised name. Lettering only.
 */
const board =
  (s: (typeof STATIONS)[number]): Paint =>
  (g, w, h) => {
    g.fillStyle = "#f1f1ee";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#3d4347";
    g.lineWidth = Math.max(2, h * 0.035);
    g.strokeRect(0, 0, w, h);
    const text = (t: string, y: number, size: number, font: string, weight = HEAVY) => {
      g.font = `${weight}${size}px ${font}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      const m = g.measureText(t).width;
      g.save();
      g.translate(w / 2, y);
      if (m > w * 0.86) g.scale((w * 0.86) / m, 1);
      g.fillText(t, 0, 0);
      g.restore();
    };
    g.fillStyle = "#15171a";
    text(s.kana, h * 0.25, h * 0.3, JP_SANS);
    text(s.key, h * 0.53, h * 0.17, JP_SANS, "600 ");
    g.fillStyle = "#7cbb3c";
    g.fillRect(w * 0.05, h * 0.67, w * 0.9, h * 0.075);
    g.fillStyle = "#15171a";
    text(s.en, h * 0.86, h * 0.125, LATIN, "600 ");
    // Snow dust and weather on the face.
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(255,255,255,0.1)");
    grad.addColorStop(1, "rgba(70,76,84,0.12)");
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  };

export function addStructureMaterials(kit: Kit): void {
  const size = Math.min(ATLAS_SIZE, kit.textureSize);
  const k = size / ATLAS_SIZE;
  const { c, g } = canvas(size, size);
  // Opaque where nothing is painted: only the pylon cells are cut out.
  g.fillStyle = "#b4b2ac";
  g.fillRect(0, 0, size, size);
  const paints: Record<string, Paint> = { plain, concrete, plate, pylon: pylon(true), pylonSide: pylon(false) };
  STATIONS.forEach((s, i) => (paints[`board-${i}`] = board(s)));
  for (const [name, cell] of Object.entries(CELLS)) {
    const paint = paints[name];
    if (!paint) continue;
    const x = Math.round(cell.x * k);
    const y = Math.round(cell.y * k);
    const w = Math.round(cell.w * k);
    const h = Math.round(cell.h * k);
    const cut = CUT_CELLS.includes(name);
    const pad = Math.round(ATLAS_PAD * k);
    g.save();
    if (cut) g.clearRect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    paint(g, w, h);
    g.restore();
    if (!cut) extrudeEdges(g, x, y, w, h, pad);
  }
  const map = toTexture(c);
  map.name = "structures";
  kit.standard("structure", null, { map, vertexColors: true, roughness: 0.78, metalness: 0 });
  kit.standard("structure-cut", null, { map, vertexColors: true, roughness: 0.7, metalness: 0, alphaTest: 0.42, side: DoubleSide });
  // A river in January: near black with a little blue, smooth enough to carry the sky.
  kit.standard("water", null, { color: new Color(0.035, 0.05, 0.062), roughness: 0.2, metalness: 0 });
}
