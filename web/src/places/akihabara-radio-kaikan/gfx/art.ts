import { Rng } from "../../../core/random";
import { canvas, fitText, HEAVY, JP_SANS, LATIN, roundRect, squeezeText, type Ctx } from "../../shared/canvas";

/**
 * Canvas painters for the Akihabara street: lettering in the colours of the
 * real signs (no logo artwork is traced), the 2F LED band's bar patterns, the
 * LED screen's advert loop, and abstract poster art for the backlit windows
 * (shapes, type and cityscapes; no characters).
 */

const BOLD = `700 `;

// ------------------------------------------------------------ the 2F band

/** Layout of the band letters (fractions of the band's width, east → west as seen from the street). */
export const BAND_TEXT = {
  sekai: { x: 0.025, w: 0.18 },
  radio: { x: 0.215, w: 0.6 },
  akiba: { x: 0.83, w: 0.155 },
};

/**
 * ラジオ会館 as red channel letters: a slight forward slant, a white outline
 * and the grid of LED points the night photographs show. The dakuten of ジ
 * is left off (two green balls are modelled in 3D); returns their centres
 * (fractions of the cell).
 */
export function paintRadioLetters(g: Ctx, w: number, h: number): { dakuten: [number, number][] } {
  const chars = ["ラ", "シ", "オ", "会", "館"];
  const size = h * 0.86;
  g.font = `${HEAVY}${size}px ${JP_SANS}`;
  const widths = chars.map((c) => g.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0);
  const gap = (w * 0.96 - total) / (chars.length - 1);
  const shape = canvas(w, h);
  const s = shape.g;
  s.font = g.font;
  s.textBaseline = "middle";
  let x = w * 0.02;
  const dakuten: [number, number][] = [];
  chars.forEach((c, i) => {
    s.save();
    s.translate(x, h * 0.53);
    s.transform(1, 0, -0.14, 1, 0, 0);
    s.fillStyle = "#fff";
    s.fillText(c, 0, 0);
    s.restore();
    if (c === "シ") {
      dakuten.push([(x + widths[i] * 0.86) / w, 0.13], [(x + widths[i] * 1.06) / w, 0.2]);
    }
    x += widths[i] + gap;
  });
  // White outline: the glyph mask dilated, then the red face inside it.
  g.save();
  for (let a = 0; a < 16; a++) {
    const r = h * 0.035;
    g.drawImage(shape.c, Math.cos((a / 16) * Math.PI * 2) * r, Math.sin((a / 16) * Math.PI * 2) * r);
  }
  g.globalCompositeOperation = "source-in";
  g.fillStyle = "#fff4ee";
  g.fillRect(0, 0, w, h);
  g.restore();
  const face = canvas(w, h);
  face.g.drawImage(shape.c, 0, 0);
  face.g.globalCompositeOperation = "source-in";
  const grad = face.g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#ff3a2a");
  grad.addColorStop(1, "#d8120e");
  face.g.fillStyle = grad;
  face.g.fillRect(0, 0, w, h);
  // LED points on a 1/14-height grid.
  face.g.globalCompositeOperation = "source-atop";
  const step = h / 14;
  for (let yy = step * 0.5; yy < h; yy += step)
    for (let xx = step * 0.5; xx < w; xx += step) {
      face.g.fillStyle = "rgba(255,226,214,0.9)";
      face.g.beginPath();
      face.g.arc(xx, yy, step * 0.2, 0, Math.PI * 2);
      face.g.fill();
    }
  g.drawImage(face.c, 0, 0);
  return { dakuten };
}

/** 世界の / 秋葉原: blue channel letters glowing cyan-white at night. */
export function paintBlueLetters(g: Ctx, text: string, w: number, h: number): void {
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.strokeStyle = "#1d5fe8";
  g.fillStyle = "#e4f2ff";
  squeezeText(g, text, w * 0.03, h * 0.54, w * 0.94, h * 0.78, JP_SANS, HEAVY, h * 0.09);
}

/**
 * The band's LED bars: `frames` rows, each a 512-px strip of `bars` vertical
 * bars (east end at u = 0). Patterns: all on, a lit block sweeping west,
 * odd/even chase, a centre-out burst, a slow fade, sparkle.
 */
export function bandBars(frames = 32, bars = 56): { c: HTMLCanvasElement; rows: number } {
  const W = 512;
  const cell = 32;
  const { c, g } = canvas(W, cell * frames);
  const rng = new Rng(717);
  const level = (f: number, b: number): number => {
    const u = b / (bars - 1);
    if (f < 4) return 1;
    if (f < 12) {
      const p = (f - 4) / 7;
      return Math.max(0.12, 1 - Math.abs(u - p) * 5);
    }
    if (f < 18) return (b + f) % 2 === 0 ? 1 : 0.12;
    if (f < 24) {
      const p = (f - 18) / 5;
      return Math.abs(u - 0.5) < p * 0.55 ? 1 : 0.12;
    }
    if (f < 28) return 0.12 + 0.88 * (1 - (f - 24) / 4);
    return rng.chance(0.18) ? 1 : 0.12;
  };
  const pitch = W / bars;
  for (let f = 0; f < frames; f++) {
    const y0 = f * cell;
    // Panel between the bars: dark gold.
    g.fillStyle = "#3b3008";
    g.fillRect(0, y0, W, cell);
    for (let b = 0; b < bars; b++) {
      const v = level(f, b);
      const x = b * pitch + pitch * 0.2;
      const bw = pitch * 0.58;
      const grad = g.createLinearGradient(0, y0, 0, y0 + cell);
      const lit = (k: number) => {
        const r = Math.round(118 + (255 - 118) * v * k);
        const gg = Math.round(98 + (232 - 98) * v * k);
        const bb = Math.round(22 + (96 - 22) * v * k);
        return `rgb(${r},${gg},${bb})`;
      };
      grad.addColorStop(0, lit(0.82));
      grad.addColorStop(0.5, lit(1));
      grad.addColorStop(1, lit(0.82));
      g.fillStyle = grad;
      g.fillRect(x, y0 + 1, bw, cell - 2);
      // Highlight down the rib's crest.
      g.fillStyle = `rgba(255,250,220,${0.35 * v})`;
      g.fillRect(x + bw * 0.4, y0 + 1, bw * 0.2, cell - 2);
    }
  }
  return { c, rows: frames };
}

// ------------------------------------------------------------ LED screen

/**
 * The LED screen's loop: 16 frames in a 4 × 4 grid of 256² cells (each a
 * 256 × 162 frame squeezed into the square; the 5.2 × 3.5 m screen shows it
 * at 1.49:1). Three generic spots: a type animation, a trading-card release,
 * an event board with a clock.
 */
export function screenFrames(): HTMLCanvasElement {
  const S = 256;
  const { c, g } = canvas(S * 4, S * 4);
  for (let f = 0; f < 16; f++) {
    const x0 = (f % 4) * S;
    const y0 = Math.floor(f / 4) * S;
    g.save();
    g.translate(x0, y0);
    g.beginPath();
    g.rect(0, 0, S, S);
    g.clip();
    // Draw in a 256 × 162 frame, stretched to the cell.
    g.scale(1, S / 162);
    screenFrame(g, f, S, 162);
    g.restore();
  }
  // LED pixel rows: faint dark lines every 2 px.
  g.fillStyle = "rgba(0,0,0,0.18)";
  for (let y = 0; y < S * 4; y += 2) g.fillRect(0, y, S * 4, 0.6);
  return c;
}

function screenFrame(g: Ctx, f: number, w: number, h: number): void {
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (f < 6) {
    const k = f / 5;
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, "#ff2d87");
    bg.addColorStop(1, "#ff9a2e");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 7; i++) {
      g.fillStyle = ["#ffe14d", "#3df0ff", "#ffffff", "#7a3cff"][i % 4];
      g.globalAlpha = 0.85;
      const r = 14 + i * 5;
      g.beginPath();
      g.arc(((i * 53 + k * 160) % (w + 60)) - 30, h * (0.2 + 0.1 * (i % 6)), r * (0.6 + 0.4 * k), 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = "#fff";
    g.strokeStyle = "#2a0a3a";
    g.lineWidth = 4;
    const word = "AKIHABARA".slice(0, Math.max(1, Math.ceil(9 * Math.min(1, k * 1.4))));
    g.font = `${HEAVY}40px ${LATIN}`;
    g.strokeText(word, w / 2, h * 0.48);
    g.fillText(word, w / 2, h * 0.48);
    g.font = `${BOLD}16px ${JP_SANS}`;
    g.fillText("電気街へようこそ", w / 2, h * 0.75);
    return;
  }
  if (f < 11) {
    const k = (f - 6) / 4;
    const bg = g.createRadialGradient(w * 0.5, h * 0.5, 4, w * 0.5, h * 0.5, w * 0.7);
    bg.addColorStop(0, "#1b3cff");
    bg.addColorStop(1, "#04051a");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // A fan of card-box shapes.
    for (let i = 0; i < 5; i++) {
      g.save();
      g.translate(w * 0.3, h * 0.92);
      g.rotate(-0.55 + i * 0.27 * (0.4 + 0.6 * k));
      g.fillStyle = ["#ffcf2e", "#ff4b4b", "#36e0a0", "#ffffff", "#c070ff"][i];
      g.fillRect(-14, -96, 28, 74);
      g.fillStyle = "rgba(0,0,0,0.35)";
      g.fillRect(-10, -88, 20, 12);
      g.restore();
    }
    g.fillStyle = "#ffe14d";
    g.font = `${HEAVY}34px ${JP_SANS}`;
    g.fillText("新弾入荷", w * 0.7, h * 0.36);
    g.fillStyle = "#fff";
    g.font = `${BOLD}15px ${JP_SANS}`;
    g.fillText("1F カードショップ", w * 0.7, h * 0.62);
    g.fillStyle = `rgba(255,255,255,${0.4 + 0.6 * k})`;
    g.fillRect(w * 0.52, h * 0.76, w * 0.36 * k, 6);
    return;
  }
  const k = (f - 11) / 4;
  g.fillStyle = "#0a1a2e";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#18e0c8";
  g.fillRect(0, 0, w, h * 0.22);
  g.fillStyle = "#06222a";
  g.font = `${HEAVY}20px ${LATIN}`;
  g.fillText("EVENT 10F", w / 2, h * 0.11);
  g.fillStyle = "#fff";
  g.font = `${HEAVY}30px ${LATIN}`;
  g.fillText(`17:3${5 + Math.round(k * 2)}`, w * 0.3, h * 0.55);
  g.font = `${BOLD}14px ${JP_SANS}`;
  g.fillText("本日 19:00 まで", w * 0.3, h * 0.78);
  for (let i = 0; i < 6; i++) {
    g.fillStyle = i <= k * 5 ? "#18e0c8" : "#28465a";
    g.beginPath();
    g.arc(w * 0.62 + (i % 3) * 30, h * 0.45 + Math.floor(i / 3) * 34, 11, 0, Math.PI * 2);
    g.fill();
  }
}

// ------------------------------------------------------------ poster art

/** Pastel gradient helper. */
function wash(g: Ctx, w: number, h: number, stops: string[], angle = 0): void {
  const gr = g.createLinearGradient(0, 0, Math.cos(angle) * w, Math.sin(angle) * h + h * (angle === 0 ? 1 : 0));
  stops.forEach((s, i) => gr.addColorStop(i / Math.max(1, stops.length - 1), s));
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
}

/**
 * The big window artwork over 5F–10F: an abstract pastel city at dusk seen
 * from above (blocks, a radio mast, rails, sparkles and colour sweeps), in the
 * violet, pink and cyan the night photographs show. No figures.
 */
export function paintPanorama(g: Ctx, w: number, h: number, seed = 31): void {
  const r = new Rng(seed);
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#5a3fd8");
  sky.addColorStop(0.35, "#c45ae0");
  sky.addColorStop(0.62, "#ff7ab8");
  sky.addColorStop(1, "#58c8ff");
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  const ink = "#1c1450";
  const lw = Math.max(2, w / 500);
  // A city seen from above in strong perspective: blocks fanning out from a vanishing point.
  const vx = w * 0.55;
  const vy = h * 0.38;
  for (let i = 0; i < 150; i++) {
    const a = r.range(0, Math.PI * 2);
    const d = r.range(0.12, 0.85) * Math.max(w, h);
    const x = vx + Math.cos(a) * d;
    const y = vy + Math.sin(a) * d * 0.9;
    const s = r.range(0.04, 0.11) * w * (d / Math.max(w, h) + 0.3);
    g.save();
    g.translate(x, y);
    g.rotate(a + Math.PI / 2 + r.range(-0.15, 0.15));
    g.fillStyle = r.pick(["#ffffff", "#f3e6ff", "#ffd6ef", "#c8ecff", "#fff2b8", "#b9a0ff", "#ff9fd4"]);
    g.fillRect(-s / 2, -s, s, s * 1.6);
    g.lineWidth = lw;
    g.strokeStyle = ink;
    g.strokeRect(-s / 2, -s, s, s * 1.6);
    g.fillStyle = "rgba(40,20,110,0.45)";
    for (let k = 0; k < 4; k++) g.fillRect(-s * 0.38, -s * 0.85 + k * s * 0.38, s * 0.76, s * 0.12);
    g.restore();
  }
  // Elevated rails curving through, in ink with a lit centre line.
  for (let k = 0; k < 3; k++) {
    const y = h * (0.3 + k * 0.2);
    g.strokeStyle = ink;
    g.lineWidth = w * 0.012;
    g.beginPath();
    g.moveTo(-10, y);
    g.bezierCurveTo(w * 0.3, y - h * 0.14, w * 0.6, y + h * 0.12, w + 10, y - h * 0.06);
    g.stroke();
    g.strokeStyle = "#ffe14d";
    g.lineWidth = w * 0.003;
    g.stroke();
  }
  // A lattice radio mast.
  g.strokeStyle = "#ff2f6a";
  g.lineWidth = w * 0.005;
  const mx = w * 0.62;
  for (let k = 0; k < 12; k++) {
    const y0 = h * (0.02 + k * 0.04);
    const ww = w * (0.006 + k * 0.0035);
    g.strokeRect(mx - ww, y0, ww * 2, h * 0.04);
    g.beginPath();
    g.moveTo(mx - ww, y0);
    g.lineTo(mx + ww, y0 + h * 0.04);
    g.moveTo(mx + ww, y0);
    g.lineTo(mx - ww, y0 + h * 0.04);
    g.stroke();
  }
  // Sparkles and bold colour sweeps.
  for (let i = 0; i < 60; i++) {
    g.fillStyle = r.pick(["#ffffff", "#fff59a", "#ffd0ef"]);
    const x = r.range(0, w);
    const y = r.range(0, h);
    const s = r.range(3, 9) * (w / 1500);
    g.beginPath();
    for (let a = 0; a < 8; a++) {
      const rr = a % 2 ? s * 0.35 : s * 1.8;
      g.lineTo(x + Math.cos((a * Math.PI) / 4) * rr, y + Math.sin((a * Math.PI) / 4) * rr);
    }
    g.fill();
  }
  for (let i = 0; i < 5; i++) {
    g.fillStyle = r.pick(["rgba(255,60,160,0.35)", "rgba(60,220,255,0.35)", "rgba(255,230,80,0.3)", "rgba(120,80,255,0.35)"]);
    g.beginPath();
    const x = r.range(-0.2, 1) * w;
    g.moveTo(x, 0);
    g.lineTo(x + w * 0.1, 0);
    g.lineTo(x + w * 0.4, h);
    g.lineTo(x + w * 0.3, h);
    g.fill();
  }
}

/** A tenant's window poster: lettering block on a colour ground. */
export interface TenantPoster {
  bg: string;
  fg: string;
  lines: string[];
  accent?: string;
  font?: string;
}

export function paintTenant(g: Ctx, w: number, h: number, p: TenantPoster): void {
  g.fillStyle = p.bg;
  g.fillRect(0, 0, w, h);
  if (p.accent) {
    g.fillStyle = p.accent;
    g.fillRect(0, h * 0.82, w, h * 0.18);
    g.fillRect(0, 0, w, h * 0.05);
  }
  g.fillStyle = p.fg;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const n = p.lines.length;
  p.lines.forEach((line, i) => {
    const big = i === 0;
    const size = big ? h * (n > 2 ? 0.26 : 0.34) : h * 0.13;
    const y = big ? h * (n > 1 ? 0.3 : 0.45) : h * (0.55 + (i - 1) * 0.16);
    fitText(g, line, w / 2, y, w * 0.9, size, p.font ?? JP_SANS);
  });
}

/** Abstract illustration panel (shapes on a gradient) for windows without lettering. */
export function paintAbstract(g: Ctx, w: number, h: number, seed: number, palette?: string[]): void {
  const r = new Rng(seed);
  const pal = palette ?? r.pick([
    ["#2a2a6e", "#6a4cff", "#ff6ad5", "#ffe66d"],
    ["#0e3b5c", "#1fb5c9", "#e8f7ff", "#ff8a5c"],
    ["#3b0f3a", "#c23b8a", "#ffb3d9", "#fff2a8"],
    ["#10301e", "#2fbf71", "#d8ffe8", "#ffd23f"],
    ["#f4f1ff", "#b9a8ff", "#ff9ec7", "#4b3aa8"],
  ]);
  wash(g, w, h, [pal[0], pal[1]], 0.6);
  for (let i = 0; i < 14; i++) {
    g.fillStyle = r.pick(pal.slice(1));
    g.globalAlpha = r.range(0.35, 0.9);
    const x = r.range(0, w);
    const y = r.range(0, h);
    const s = r.range(0.05, 0.3) * Math.min(w, h);
    if (r.chance(0.5)) {
      g.beginPath();
      g.arc(x, y, s, 0, Math.PI * 2);
      g.fill();
    } else {
      g.save();
      g.translate(x, y);
      g.rotate(r.range(0, Math.PI));
      g.fillRect(-s, -s * 0.25, s * 2, s * 0.5);
      g.restore();
    }
  }
  g.globalAlpha = 1;
}

/** Billboard: a generic floodlit release advert (type, a product fan, a date band). */
export function paintBillboard(g: Ctx, w: number, h: number): void {
  wash(g, w, h, ["#11163f", "#3b2a9a", "#9b4dff", "#ff7ac8"], 0.35);
  const r = new Rng(88);
  for (let i = 0; i < 26; i++) {
    g.fillStyle = r.pick(["#ffffff", "#ffe36b", "#6bf2ff", "#ff8ad8"]);
    g.globalAlpha = r.range(0.15, 0.5);
    g.beginPath();
    g.arc(r.range(0, w), r.range(0, h), r.range(0.01, 0.08) * w, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  // Product fan (box shapes).
  for (let i = 0; i < 6; i++) {
    g.save();
    g.translate(w * 0.27, h * 0.95);
    g.rotate(-0.62 + i * 0.25);
    g.fillStyle = ["#ffd02e", "#ff4f6a", "#3ee0b0", "#ffffff", "#7a6bff", "#ff9a3c"][i];
    g.fillRect(-w * 0.045, -h * 0.82, w * 0.09, h * 0.52);
    g.fillStyle = "rgba(0,0,0,0.3)";
    g.fillRect(-w * 0.035, -h * 0.78, w * 0.07, h * 0.08);
    g.fillStyle = "rgba(255,255,255,0.75)";
    g.fillRect(-w * 0.03, -h * 0.6, w * 0.06, h * 0.012);
    g.restore();
  }
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#ffffff";
  g.strokeStyle = "#1a0c4a";
  g.lineWidth = h * 0.025;
  g.font = `${HEAVY}${h * 0.17}px ${JP_SANS}`;
  g.strokeText("新シリーズ", w * 0.68, h * 0.3);
  g.fillText("新シリーズ", w * 0.68, h * 0.3);
  g.fillStyle = "#ffe36b";
  g.font = `${HEAVY}${h * 0.12}px ${LATIN}`;
  g.fillText("NEW RELEASE", w * 0.68, h * 0.5);
  g.fillStyle = "rgba(10,8,40,0.8)";
  g.fillRect(w * 0.44, h * 0.66, w * 0.5, h * 0.16);
  g.fillStyle = "#fff";
  g.font = `${BOLD}${h * 0.075}px ${JP_SANS}`;
  g.fillText("10.24 SAT 全国発売", w * 0.69, h * 0.74);
}

// ------------------------------------------------------------ lightboxes

export interface Lightbox {
  text: string;
  bg: string;
  fg: string;
  sub?: string;
  font?: string;
  stroke?: string;
  vertical?: boolean;
  border?: string;
}

/** Backlit sign face: bold lettering on a colour ground, optional sub-line. */
export function paintLightbox(g: Ctx, w: number, h: number, s: Lightbox): void {
  g.fillStyle = s.bg;
  g.fillRect(0, 0, w, h);
  if (s.border) {
    g.strokeStyle = s.border;
    g.lineWidth = Math.min(w, h) * 0.06;
    g.strokeRect(0, 0, w, h);
  }
  g.fillStyle = s.fg;
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (s.stroke) g.strokeStyle = s.stroke;
  if (s.vertical) {
    const chars = Array.from(s.text);
    const size = Math.min(w * 0.78, (h * 0.9) / chars.length);
    g.font = `${HEAVY}${size}px ${s.font ?? JP_SANS}`;
    chars.forEach((ch, i) => {
      const y = h * 0.05 + size * (i + 0.5) + (h * 0.9 - size * chars.length) / 2;
      if (ch === "ー") {
        g.save();
        g.translate(w / 2, y);
        g.rotate(Math.PI / 2);
        g.fillText(ch, 0, 0);
        g.restore();
      } else g.fillText(ch, w / 2, y);
    });
    return;
  }
  const main = s.sub ? h * 0.36 : h * 0.62;
  if (s.stroke) {
    g.lineWidth = h * 0.06;
    g.font = `${HEAVY}${main}px ${s.font ?? JP_SANS}`;
    g.strokeText(s.text, w / 2, s.sub ? h * 0.38 : h * 0.52);
  }
  fitText(g, s.text, w / 2, s.sub ? h * 0.38 : h * 0.52, w * 0.9, main, s.font ?? JP_SANS);
  if (s.sub) fitText(g, s.sub, w / 2, h * 0.76, w * 0.86, h * 0.2, s.font ?? JP_SANS, BOLD);
}

/**
 * Lit shop interior card seen through glazing: a one-point perspective of
 * the sales floor (ceiling light panels, gondola shelving receding to the
 * back wall, a glossy floor), the arcade's glowing cabinets, or the bright
 * lobby with its escalator and floor directory.
 */
export function paintInterior(g: Ctx, w: number, h: number, kind: "gift" | "lobby" | "cards" | "shop" | "arcade" | "station", seed = 1): void {
  const r = new Rng(seed * 97 + kind.length);
  const warm = kind === "gift";
  const vx = w * r.range(0.4, 0.6);
  const vy = h * 0.42;
  const wall = kind === "arcade" ? "#2a1238" : warm ? "#fff1dc" : "#f6f8fb";
  const ceil = kind === "arcade" ? "#1a0a24" : warm ? "#f2e2c8" : "#e8ecf2";
  const floorTop = kind === "arcade" ? "#3a1a40" : warm ? "#c8a888" : "#c4ccd6";
  const floorBot = kind === "arcade" ? "#120614" : warm ? "#7a5a40" : "#6a7480";
  g.fillStyle = ceil;
  g.fillRect(0, 0, w, vy);
  const fl = g.createLinearGradient(0, vy, 0, h);
  fl.addColorStop(0, floorTop);
  fl.addColorStop(1, floorBot);
  g.fillStyle = fl;
  g.fillRect(0, vy, w, h - vy);
  // Back wall (a band around the vanishing point) with shelving.
  const bw = w * 0.42;
  const bh = h * 0.34;
  g.fillStyle = wall;
  g.fillRect(vx - bw / 2, vy - bh * 0.62, bw, bh);
  const goods = kind === "gift" ? ["#ff5a4a", "#ffd23f", "#4fa7ff", "#ff8ad8", "#ffffff", "#5ad87a", "#ff9a2e"] : kind === "cards" ? ["#ffd23f", "#1e2a8a", "#ff4b4b", "#ffffff", "#2ad0c8", "#b062ff", "#1a1a1a"] : ["#d8dde4", "#2a2f38", "#5a6270", "#1d4fd8", "#e8ecf2", "#9aa3ad", "#c83a3a"];
  for (let row = 0; row < 4; row++) {
    const y = vy - bh * 0.55 + row * bh * 0.22;
    for (let i = 0; i < 18; i++) {
      g.fillStyle = r.pick(goods);
      g.fillRect(vx - bw / 2 + (i / 18) * bw + 1, y, bw / 18 - 2, bh * 0.15);
    }
  }
  if (kind === "arcade") {
    // Rows of cabinets with glowing screens, receding.
    for (let k = 0; k < 7; k++) {
      const t = k / 7;
      for (const side of [-1, 1]) {
        const x = vx + side * (w * 0.48 * (1 - t) + bw * 0.08);
        const s = (1 - t) * h * 0.38 + h * 0.06;
        g.fillStyle = "#140a1a";
        g.fillRect(x - s * 0.3, vy - s * 0.3, s * 0.6, s * 1.1);
        g.fillStyle = r.pick(["#ff3a8a", "#3ad8ff", "#ffe14d", "#8a5cff", "#4dff9a"]);
        g.fillRect(x - s * 0.24, vy - s * 0.22, s * 0.48, s * 0.36);
      }
    }
  } else if (kind === "lobby" || kind === "station") {
    // Escalator rising to the right, the directory board on the left.
    g.strokeStyle = "#5a6470";
    g.lineWidth = w * 0.018;
    g.beginPath();
    g.moveTo(vx + bw * 0.05, h);
    g.lineTo(vx + bw * 0.45, vy - bh * 0.5);
    g.stroke();
    g.fillStyle = "#c9d2dc";
    g.beginPath();
    g.moveTo(vx + bw * 0.12, h);
    g.lineTo(vx + bw * 0.52, vy - bh * 0.5);
    g.lineTo(vx + bw * 0.7, vy - bh * 0.5);
    g.lineTo(vx + bw * 0.42, h);
    g.fill();
    g.fillStyle = "#1c2f6a";
    g.fillRect(w * 0.08, vy - bh * 0.6, w * 0.16, bh * 0.95);
    for (let i = 0; i < 10; i++) {
      g.fillStyle = i % 2 ? "#ffffff" : "#ffe24d";
      g.fillRect(w * 0.095, vy - bh * 0.55 + i * bh * 0.085, w * 0.13, bh * 0.05);
    }
    if (kind === "station") {
      g.fillStyle = "#0f2a4a";
      g.fillRect(w * 0.1, h * 0.06, w * 0.8, h * 0.1);
      g.fillStyle = "#ffffff";
      g.font = `${BOLD}${h * 0.07}px ${JP_SANS}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("JR 秋葉原駅  電気街南口", w / 2, h * 0.11);
    }
  } else {
    // Gondola shelving on both sides, receding to the back wall.
    for (const side of [-1, 1]) {
      for (let k = 0; k < 5; k++) {
        const t0 = k / 5;
        const t1 = (k + 0.8) / 5;
        const x0 = vx + side * (w * 0.55 * (1 - t0) + bw * 0.5 * t0);
        const x1 = vx + side * (w * 0.55 * (1 - t1) + bw * 0.5 * t1);
        const s0 = 1 - t0 * 0.66;
        const s1 = 1 - t1 * 0.66;
        const top0 = vy - h * 0.34 * s0;
        const top1 = vy - h * 0.34 * s1;
        const bot0 = vy + h * 0.5 * s0;
        const bot1 = vy + h * 0.5 * s1;
        g.fillStyle = kind === "cards" ? "#2a2f3a" : "#dfe3e8";
        g.beginPath();
        g.moveTo(x0, top0);
        g.lineTo(x1, top1);
        g.lineTo(x1, bot1);
        g.lineTo(x0, bot0);
        g.fill();
        for (let row = 0; row < 5; row++) {
          const f0 = 0.08 + row * 0.17;
          for (let i = 0; i < 6; i++) {
            const u0 = i / 6;
            const u1 = (i + 0.8) / 6;
            const xa = x0 + (x1 - x0) * u0;
            const xb = x0 + (x1 - x0) * u1;
            const ya = top0 + (top1 - top0) * u0 + (bot0 - top0 + (bot1 - top1 - (bot0 - top0)) * u0) * f0;
            const hh = (bot0 - top0) * (1 - u0 * (1 - s1 / s0)) * 0.11;
            g.fillStyle = r.pick(goods);
            g.fillRect(Math.min(xa, xb), ya, Math.abs(xb - xa), hh);
          }
        }
      }
    }
    // A few shoppers as soft silhouettes.
    for (let i = 0; i < 3; i++) {
      const x = vx + r.range(-0.18, 0.18) * w;
      const s = r.range(0.7, 1.0);
      g.fillStyle = "rgba(40,36,44,0.55)";
      g.beginPath();
      g.ellipse(x, vy + h * 0.1 * s, w * 0.018 * s, h * 0.2 * s, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.arc(x, vy - h * 0.12 * s, w * 0.014 * s, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Ceiling light panels in perspective.
  for (let k = 0; k < 6; k++) {
    const t = k / 6;
    for (const side of [-0.6, 0, 0.6]) {
      const x = vx + side * w * 0.5 * (1 - t * 0.7);
      const y = vy - h * 0.42 * (1 - t * 0.75);
      g.fillStyle = kind === "arcade" ? "rgba(255,120,220,0.7)" : warm ? "rgba(255,244,220,0.95)" : "rgba(244,250,255,0.98)";
      g.fillRect(x - w * 0.05 * (1 - t * 0.7), y, w * 0.1 * (1 - t * 0.7), h * 0.02 * (1 - t * 0.6));
    }
  }
  const vig = g.createRadialGradient(vx, vy, w * 0.08, vx, vy, w * 0.75);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.3)");
  g.fillStyle = vig;
  g.fillRect(0, 0, w, h);
}

/** Office floors for distant towers: a grid of lit and dark panes (tiles in both axes). */
export function paintOfficeGrid(g: Ctx, w: number, h: number, cols: number, rows: number, seed: number, litShare = 0.7): void {
  const r = new Rng(seed);
  g.fillStyle = "#151a22";
  g.fillRect(0, 0, w, h);
  const cw = w / cols;
  const ch = h / rows;
  for (let y = 0; y < rows; y++) {
    const floorLit = r.chance(litShare);
    const tone = r.pick(["#eef2ea", "#e2ecff", "#fff0d4", "#f4f6f8"]);
    // Strip window across the floor; most bays lit on a lit floor, a few blinds down.
    for (let x = 0; x < cols; x++) {
      const lit = floorLit && r.chance(0.88);
      g.fillStyle = lit ? tone : r.pick(["#26303e", "#1e2632", "#2c3542"]);
      g.fillRect(x * cw, y * ch + ch * 0.22, cw, ch * 0.58);
      if (lit && r.chance(0.2)) {
        g.fillStyle = "rgba(60,60,70,0.55)";
        g.fillRect(x * cw, y * ch + ch * 0.22, cw, ch * 0.2);
      }
      g.fillStyle = "#2a313c";
      g.fillRect(x * cw, y * ch + ch * 0.22, Math.max(1, cw * 0.06), ch * 0.58);
    }
    g.fillStyle = "#3a414c";
    g.fillRect(0, y * ch + ch * 0.8, w, ch * 0.04);
  }
}

/** Rounded vertical banner (atre-style) with lowercase lettering. */
export function paintBanner(g: Ctx, w: number, h: number, bg: string, fg: string, text: string, font = `"Georgia", "Times New Roman", serif`): void {
  g.fillStyle = bg;
  roundRect(g, 0, 0, w, h, w * 0.04);
  g.fill();
  g.save();
  g.translate(w / 2, h * 0.52);
  g.rotate(-Math.PI / 2);
  g.fillStyle = fg;
  g.textAlign = "center";
  g.textBaseline = "middle";
  fitText(g, text, 0, 0, h * 0.8, w * 0.62, font, `400 `);
  g.restore();
}
