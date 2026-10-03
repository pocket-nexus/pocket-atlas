import { Color, MeshBasicMaterial } from "three";
import { extrudeEdges } from "../../../places/shared/atlas";
import { canvas, HEAVY, JP_SANS, LATIN, toTexture, type Ctx } from "../../../places/shared/canvas";
import type { Kit } from "./materials";
import { ARROW_BANDS, ARROW_HEAD, ATLAS_PAD, ATLAS_SIZE, CELLS, SHIELD_OUTLINE, SHIELDS, SIGNAL_NAMES, SPEEDS, STOP_OUTLINE, TOWNS, type Outline } from "./roadside-layout";

/**
 * The kit materials of `gen/roadside.ts`, both on one atlas
 * (`kit/roadside-layout.ts`):
 *
 *   roadside       lit, tinted by vertex colour: posts, poles, wires, rails,
 *                  sign faces, the 矢羽根 arrows
 *   roadside-lit   unlit: lamp heads and the lit lens of a signal, which
 *                  glow in the grey afternoon
 *
 * Sign faces are lettering only (no pictograms or emblems); their outlines
 * are cut by the generator's geometry, so each cell is painted to its edge
 * in the colour its rim has.
 */

// Sign colours as the reflective sheeting reads in overcast daylight.
// Sampled from photographs taken under overcast (research report §2).
const BLUE = "#1c609d";
const RED = "#b2201a";
const ARROW_RED = "#a81910";
const ARROW_WHITE = "#dcdad5";
const WHITE = "#e4e3de";
const YELLOW = "#f2c018";
const BLACK = "#16171a";
const SPEED_BLUE = "#17429a";

type Paint = (g: Ctx, w: number, h: number) => void;

function trace(g: Ctx, o: Outline, w: number, h: number, scale = 1): void {
  g.beginPath();
  o.forEach(([x, y], i) => {
    const px = (x * scale + 0.5) * w;
    const py = (0.5 - y * scale) * h;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  });
  g.closePath();
}

function text(g: Ctx, s: string, x: number, y: number, size: number, maxW: number, font = JP_SANS): void {
  g.font = `${HEAVY}${size}px ${font}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const m = g.measureText(s).width;
  g.save();
  g.translate(x, y);
  if (m > maxW) g.scale(maxW / m, 1);
  g.fillText(s, 0, 0);
  g.restore();
}

/** A little weathering: darker toward the bottom, faint streaks, so a face is not a flat fill. */
function weather(g: Ctx, w: number, h: number, amount = 0.1): void {
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(255,255,255,0.04)");
  grad.addColorStop(1, `rgba(40,45,50,${amount})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
}

/** 0..1 from an integer: the painter's streaks are the same on every run. */
function hash(i: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

const shield =
  (ref: string): Paint =>
  (g, w, h) => {
    g.fillStyle = WHITE;
    g.fillRect(0, 0, w, h);
    g.fillStyle = BLUE;
    trace(g, SHIELD_OUTLINE, w, h, 0.93);
    g.fill();
    g.fillStyle = WHITE;
    text(g, "国道", w / 2, h * 0.17, h * 0.17, w * 0.4);
    text(g, ref, w / 2, h * 0.45, h * 0.37, w * 0.56, LATIN);
    text(g, "ROUTE", w / 2, h * 0.72, h * 0.105, w * 0.3, LATIN);
  };

const stop: Paint = (g, w, h) => {
  g.fillStyle = WHITE;
  g.fillRect(0, 0, w, h);
  g.fillStyle = RED;
  trace(g, STOP_OUTLINE, w, h, 0.93);
  g.fill();
  g.fillStyle = WHITE;
  text(g, "止まれ", w / 2, h * 0.3, h * 0.27, w * 0.6);
};

const speed =
  (kmh: number): Paint =>
  (g, w, h) => {
    g.fillStyle = RED;
    g.fillRect(0, 0, w, h);
    g.fillStyle = WHITE;
    g.beginPath();
    g.arc(w / 2, h / 2, w * 0.385, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = SPEED_BLUE;
    text(g, String(kmh), w / 2, h * 0.52, h * 0.5, w * 0.62, LATIN);
  };

const warning =
  (label: string): Paint =>
  (g, w, h) => {
    g.fillStyle = BLACK;
    g.fillRect(0, 0, w, h);
    g.fillStyle = YELLOW;
    const b = h * 0.06;
    g.fillRect(b, b, w - 2 * b, h - 2 * b);
    g.fillStyle = BLACK;
    text(g, label, w / 2, h * 0.52, h * 0.5, w * 0.84);
    weather(g, w, h, 0.08);
  };

/** A town's name over its romanisation, white on the guide-sign blue. */
const townName =
  (jp: string, en: string, jpSize: number): Paint =>
  (g, w, h) => {
    g.fillStyle = BLUE;
    g.fillRect(0, 0, w, h);
    g.fillStyle = WHITE;
    text(g, jp, w / 2, h * 0.38, h * jpSize, w * 0.96);
    text(g, en, w / 2, h * 0.86, h * 0.2, w * 0.9, LATIN);
  };

const digit =
  (d: string, size: number): Paint =>
  (g, w, h) => {
    g.fillStyle = BLUE;
    g.fillRect(0, 0, w, h);
    g.fillStyle = WHITE;
    text(g, d, w / 2, h * (0.92 - size / 2), h * size, w * 0.98, LATIN);
  };

/** 矢羽根: the shaft's bands, red first from the top, over the solid red of the head (the generator's outline cuts the shape). */
const arrow: Paint = (g, w, h) => {
  g.fillStyle = ARROW_RED;
  g.fillRect(0, 0, w, h);
  g.fillStyle = ARROW_WHITE;
  const band = (h * (1 - ARROW_HEAD)) / ARROW_BANDS;
  for (let k = 1; k < ARROW_BANDS; k += 2) g.fillRect(0, k * band, w, band);
  weather(g, w, h, 0.08);
};

/**
 * The picture panel of a boundary sign. The real ones carry each town's own
 * illustration; this is a generic landscape (sky, a far range, two swells
 * of field) that stands for all of them.
 */
const country: Paint = (g, w, h) => {
  g.fillStyle = "#9fc1dc";
  g.fillRect(0, 0, w, h);
  const hill = (colour: string, base: number, amp: number, phase: number, freq: number) => {
    g.fillStyle = colour;
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += 2) g.lineTo(x, h * (base - amp * Math.sin((x / w) * Math.PI * freq + phase)));
    g.lineTo(w, h);
    g.closePath();
    g.fill();
  };
  hill("#e9edf0", 0.5, 0.1, 0.4, 2.6);
  hill("#6f9a57", 0.66, 0.06, 2.0, 1.7);
  hill("#c9b45a", 0.8, 0.05, 0.2, 1.3);
  hill("#4f7f49", 0.93, 0.04, 3.4, 1.1);
  g.strokeStyle = WHITE;
  g.lineWidth = Math.max(2, w * 0.035);
  g.strokeRect(0, 0, w, h);
};

/** A junction's name beside the signal head: white on blue. */
const signalName =
  (name: string): Paint =>
  (g, w, h) => {
    g.fillStyle = BLUE;
    g.fillRect(0, 0, w, h);
    g.fillStyle = WHITE;
    text(g, name, w / 2, h * 0.52, h * 0.6, w * 0.9);
  };

/** A snow pole: red and white bands of about 30 cm. */
const stripes: Paint = (g, w, h) => {
  const n = 8;
  for (let k = 0; k < n; k++) {
    g.fillStyle = k % 2 === 0 ? ARROW_RED : ARROW_WHITE;
    g.fillRect(0, (k * h) / n, w, h / n + 1);
  }
  weather(g, w, h, 0.14);
};

/** Concrete or galvanised steel, nearly white: the vertices tint it. Streaks run down it. */
const pole: Paint = (g, w, h) => {
  g.fillStyle = "#e9e9e9";
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 60; i++) {
    const x = hash(i * 3) * w;
    const y = hash(i * 3 + 1) * h;
    const len = (0.1 + 0.5 * hash(i * 3 + 2)) * h;
    g.fillStyle = hash(i + 700) > 0.5 ? "rgba(70,70,70,0.07)" : "rgba(255,255,255,0.1)";
    g.fillRect(x, y, Math.max(1, w * 0.04), len);
  }
  // Stained toward the foot.
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.55, "rgba(60,60,60,0)");
  grad.addColorStop(1, "rgba(60,60,60,0.2)");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
};

/** The W section of a guard rail seen from the road: two ridges catching the sky, the valley and the edges in shade. */
const rail: Paint = (g, w, h) => {
  const grad = g.createLinearGradient(0, 0, 0, h);
  const stops: [number, string][] = [
    [0, "#b9bcbd"],
    [0.1, "#f1f2f2"],
    [0.28, "#e2e4e4"],
    [0.42, "#9a9d9f"],
    [0.5, "#85888b"],
    [0.6, "#eceeee"],
    [0.78, "#d8dadb"],
    [0.92, "#999c9e"],
    [1, "#808386"],
  ];
  for (const [t, c] of stops) grad.addColorStop(t, c);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
};

function lens(g: Ctx, x: number, y: number, r: number, rim: string, core: string): void {
  const grad = g.createRadialGradient(x, y, r * 0.1, x, y, r);
  grad.addColorStop(0, core);
  grad.addColorStop(0.75, core);
  grad.addColorStop(1, rim);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

/** The upper two lamps of a vertical signal head, unlit (red above amber). */
const signalTop: Paint = (g, w, h) => {
  g.fillStyle = "#2a2c2f";
  g.fillRect(0, 0, w, h);
  lens(g, w / 2, h * 0.25, w * 0.38, "#1a1012", "#4d1a18");
  lens(g, w / 2, h * 0.75, w * 0.38, "#18150e", "#4b3a14");
};

/** A lit lamp of the head, on the unlit material: the housing around it is painted as dark as daylight leaves it. */
const signalLit =
  (rim: string, core: string): Paint =>
  (g, w, h) => {
    g.fillStyle = "#17181a";
    g.fillRect(0, 0, w, h);
    lens(g, w / 2, h / 2, w * 0.38, rim, core);
  };

const busDisc: Paint = (g, w, h) => {
  g.fillStyle = "#e0701c";
  g.fillRect(0, 0, w, h);
  g.fillStyle = WHITE;
  g.beginPath();
  g.arc(w / 2, h / 2, w * 0.4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#1d3f86";
  text(g, "バス", w / 2, h * 0.4, h * 0.26, w * 0.6);
  text(g, "のりば", w / 2, h * 0.66, h * 0.17, w * 0.6);
};

/** The timetable plate under a bus stop's disc: a heading and ruled lines of times. */
const busPlate: Paint = (g, w, h) => {
  g.fillStyle = WHITE;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#1d3f86";
  g.fillRect(0, 0, w, h * 0.2);
  g.fillStyle = WHITE;
  text(g, "時刻表", w / 2, h * 0.105, h * 0.12, w * 0.8);
  g.fillStyle = "#5c6066";
  for (let r = 0; r < 9; r++) {
    const y = h * (0.27 + r * 0.075);
    g.fillRect(w * 0.1, y, w * 0.14, h * 0.03);
    for (let k = 0; k < 4; k++) if (hash(r * 7 + k) > 0.3) g.fillRect(w * (0.34 + k * 0.15), y, w * 0.09, h * 0.03);
  }
  weather(g, w, h, 0.1);
};

const flat =
  (colour: string): Paint =>
  (g, w, h) => {
    g.fillStyle = colour;
    g.fillRect(0, 0, w, h);
  };

function painters(): Record<string, Paint> {
  const p: Record<string, Paint> = {
    arrow,
    stripes,
    pole,
    busPlate,
    stop,
    busDisc,
    sigTop: signalTop,
    sigGo: signalLit("#0c6a52", "#35f0b4"),
    sigStop: signalLit("#7a1410", "#ff4a3a"),
    slip: warning("スリップ注意"),
    curve: warning("急カーブ注意"),
    km: digit("km", 0.5),
    rail,
    country,
    blue: flat(BLUE),
    white: flat("#ffffff"),
    lamp: flat("#fff3d6"),
  };
  for (const r of SHIELDS) p[`shield-${r}`] = shield(r);
  for (const v of SPEEDS) p[`speed-${v}`] = speed(v);
  SIGNAL_NAMES.forEach((n, i) => (p[`signame-${i}`] = signalName(n)));
  TOWNS.forEach((t, i) => {
    p[`name-${i}`] = townName(t.key, t.en, 0.68);
    p[`bound-${i}`] = townName(t.key + t.suffix, `${t.en} ${t.kind}`, 0.62);
  });
  for (let d = 0; d < 10; d++) p[`digit-${d}`] = digit(String(d), 0.78);
  return p;
}

export function addRoadsideMaterials(kit: Kit): void {
  const size = Math.min(ATLAS_SIZE, kit.textureSize);
  const k = size / ATLAS_SIZE;
  const { c, g } = canvas(size, size);
  g.fillStyle = "#808080";
  g.fillRect(0, 0, size, size);
  const paint = painters();
  for (const [name, cell] of Object.entries(CELLS)) {
    const fn = paint[name];
    if (!fn) {
      console.warn(`[route] roadside atlas cell "${name}" has no painter`);
      continue;
    }
    const x = Math.round(cell.x * k);
    const y = Math.round(cell.y * k);
    const w = Math.round(cell.w * k);
    const h = Math.round(cell.h * k);
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    fn(g, w, h);
    g.restore();
    extrudeEdges(g, x, y, w, h, Math.max(1, Math.floor(ATLAS_PAD * k)));
  }
  const map = toTexture(c);
  map.name = "roadside";
  kit.standard("roadside", null, { map, vertexColors: true, roughness: 0.62, metalness: 0 });
  // Lamps and lit lenses: brighter than white paper under this sky, so they bloom a little.
  kit.add("roadside-lit", new MeshBasicMaterial({ map, color: new Color(1.9, 1.9, 1.9) }));
}
