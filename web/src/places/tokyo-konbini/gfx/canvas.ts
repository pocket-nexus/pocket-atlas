import { Rng } from "../../../core/random";
import { canvas, JP_SANS, JP_SERIF, LATIN, roundRect, toTexture, verticalText, type Ctx } from "../../shared/canvas";

export { canvas, JP_SANS, JP_SERIF, LATIN, roundRect, toTexture, verticalText, type Ctx };

function fitText(g: Ctx, text: string, maxW: number, font: (px: number) => string, start: number): number {
  let px = start;
  g.font = font(px);
  while (g.measureText(text).width > maxW && px > 6) {
    px -= 2;
    g.font = font(px);
  }
  return px;
}

// ------------------------------------------------------------------ konbini

/** Internally lit fascia: brand stripes, wordmark, 24h roundel. */
export function konbiniFascia(w = 2048, h = 256): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, "#fbfdff");
  grd.addColorStop(1, "#e6eef5");
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  // Stripes along the bottom and a slanted brand block.
  const stripes = ["#0f9d74", "#2cc0d8", "#0b4ea2"];
  stripes.forEach((col, i) => {
    g.fillStyle = col;
    g.fillRect(0, h * (0.66 + i * 0.1), w, h * 0.08);
  });
  g.fillStyle = "#0b4ea2";
  g.beginPath();
  g.moveTo(w * 0.05, 0);
  g.lineTo(w * 0.24, 0);
  g.lineTo(w * 0.2, h * 0.64);
  g.lineTo(w * 0.01, h * 0.64);
  g.closePath();
  g.fill();
  g.fillStyle = "#fff";
  g.font = `italic 900 ${h * 0.34}px ${LATIN}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("POCKET", w * 0.125, h * 0.33);
  g.fillStyle = "#0b3f85";
  g.font = `900 ${h * 0.42}px ${LATIN}`;
  g.textAlign = "left";
  g.fillText("POCKET MART", w * 0.27, h * 0.34);
  g.fillStyle = "#0f9d74";
  g.font = `700 ${h * 0.2}px ${JP_SANS}`;
  g.fillText("ポケットマート", w * 0.66, h * 0.36);
  // 24h roundel
  g.fillStyle = "#e8332a";
  g.beginPath();
  g.arc(w * 0.93, h * 0.33, h * 0.25, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = `900 ${h * 0.2}px ${LATIN}`;
  g.textAlign = "center";
  g.fillText("24h", w * 0.93, h * 0.34);
  return c;
}

const POSTERS: ((g: Ctx, w: number, h: number, r: Rng) => void)[] = [
  (g, w, h) => {
    // Oden sale
    g.fillStyle = "#f7e6c4";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#b8201c";
    g.fillRect(0, 0, w, h * 0.3);
    g.fillStyle = "#fff";
    g.font = `900 ${w * 0.26}px ${JP_SERIF}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("おでん", w / 2, h * 0.15);
    g.fillStyle = "#4a2a12";
    g.font = `700 ${w * 0.1}px ${JP_SANS}`;
    g.fillText("全品", w / 2, h * 0.42);
    g.fillStyle = "#d42a1e";
    g.font = `900 ${w * 0.3}px ${LATIN}`;
    g.fillText("70円", w / 2, h * 0.58);
    g.fillStyle = "#4a2a12";
    g.font = `500 ${w * 0.07}px ${JP_SANS}`;
    g.fillText("セール開催中", w / 2, h * 0.76);
    for (let i = 0; i < 3; i++) {
      g.fillStyle = ["#e8b04a", "#f2e2b0", "#8a5a2c"][i];
      g.beginPath();
      g.arc(w * (0.28 + i * 0.22), h * 0.9, w * 0.08, 0, Math.PI * 2);
      g.fill();
    }
  },
  (g, w, h) => {
    // Fried chicken launch
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "#ffcf1f");
    grd.addColorStop(1, "#ff8a00");
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#c71b1b";
    g.beginPath();
    g.arc(w * 0.5, h * 0.52, w * 0.36, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#e79b3c";
    for (let i = 0; i < 5; i++) {
      g.beginPath();
      g.ellipse(w * (0.35 + (i % 3) * 0.15), h * (0.47 + Math.floor(i / 3) * 0.1), w * 0.09, w * 0.07, i, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "#fff";
    g.strokeStyle = "#7a0c0c";
    g.lineWidth = w * 0.02;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `900 ${w * 0.16}px ${JP_SANS}`;
    g.strokeText("新発売", w / 2, h * 0.14);
    g.fillText("新発売", w / 2, h * 0.14);
    g.font = `900 ${w * 0.13}px ${JP_SANS}`;
    g.strokeText("ジューシー", w / 2, h * 0.82);
    g.fillText("ジューシー", w / 2, h * 0.82);
    g.font = `900 ${w * 0.13}px ${JP_SANS}`;
    g.strokeText("からあげ", w / 2, h * 0.93);
    g.fillText("からあげ", w / 2, h * 0.93);
  },
  (g, w, h) => {
    // ATM / services
    g.fillStyle = "#0b4ea2";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `900 ${w * 0.3}px ${LATIN}`;
    g.fillText("ATM", w / 2, h * 0.2);
    g.font = `700 ${w * 0.08}px ${JP_SANS}`;
    g.fillText("24時間 ご利用いただけます", w / 2, h * 0.36);
    const items = ["コピー・FAX", "チケット", "宅配便", "公共料金", "Wi-Fi FREE"];
    g.font = `600 ${w * 0.075}px ${JP_SANS}`;
    items.forEach((t, i) => {
      g.fillStyle = "rgba(255,255,255,0.14)";
      g.fillRect(w * 0.12, h * (0.46 + i * 0.1), w * 0.76, h * 0.075);
      g.fillStyle = "#fff";
      g.fillText(t, w / 2, h * (0.4975 + i * 0.1));
    });
  },
  (g, w, h) => {
    // Onigiri campaign
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#1a1a1a";
    g.beginPath();
    g.moveTo(w * 0.5, h * 0.18);
    g.lineTo(w * 0.8, h * 0.58);
    g.quadraticCurveTo(w * 0.5, h * 0.66, w * 0.2, h * 0.58);
    g.closePath();
    g.fillStyle = "#f5f5f0";
    g.fill();
    g.strokeStyle = "#ddd";
    g.lineWidth = 4;
    g.stroke();
    g.fillStyle = "#15301e";
    g.fillRect(w * 0.36, h * 0.44, w * 0.28, h * 0.17);
    g.fillStyle = "#e0301e";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `900 ${w * 0.13}px ${JP_SANS}`;
    g.fillText("おにぎり", w / 2, h * 0.08);
    g.fillStyle = "#111";
    g.font = `900 ${w * 0.1}px ${JP_SANS}`;
    g.fillText("100円セール", w / 2, h * 0.75);
    g.font = `500 ${w * 0.055}px ${JP_SANS}`;
    g.fillStyle = "#555";
    g.fillText("対象商品 税込", w / 2, h * 0.86);
  },
  (g, w, h) => {
    // Hot coffee
    g.fillStyle = "#2a1a12";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#e8ddd0";
    g.fillRect(w * 0.3, h * 0.3, w * 0.4, h * 0.4);
    g.fillStyle = "#5a3a22";
    g.fillRect(w * 0.3, h * 0.3, w * 0.4, h * 0.07);
    g.strokeStyle = "rgba(255,255,255,0.5)";
    g.lineWidth = 6;
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.moveTo(w * (0.4 + i * 0.1), h * 0.26);
      g.bezierCurveTo(w * (0.36 + i * 0.1), h * 0.2, w * (0.44 + i * 0.1), h * 0.16, w * (0.4 + i * 0.1), h * 0.1);
      g.stroke();
    }
    g.fillStyle = "#f3c77a";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `800 ${w * 0.12}px ${LATIN}`;
    g.fillText("HOT COFFEE", w / 2, h * 0.8);
    g.font = `600 ${w * 0.08}px ${JP_SANS}`;
    g.fillStyle = "#fff";
    g.fillText("淹れたて 110円", w / 2, h * 0.9);
  },
  (g, w, h) => {
    // Recruitment notice (always taped to a konbini window)
    g.fillStyle = "#fffef5";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#e8332a";
    g.fillRect(0, 0, w, h * 0.18);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `900 ${w * 0.12}px ${JP_SANS}`;
    g.fillText("スタッフ募集", w / 2, h * 0.09);
    g.fillStyle = "#222";
    g.font = `700 ${w * 0.075}px ${JP_SANS}`;
    ["深夜 22:00〜翌9:00", "時給 1,400円〜", "未経験者 歓迎", "学生・主婦(夫) OK"].forEach((t, i) => g.fillText(t, w / 2, h * (0.3 + i * 0.13)));
    g.fillStyle = "#0b4ea2";
    g.font = `700 ${w * 0.06}px ${JP_SANS}`;
    g.fillText("詳しくは店長まで", w / 2, h * 0.9);
  },
];

export function poster(index: number, w = 384, h = 544): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  POSTERS[index % POSTERS.length](g, w, h, new Rng(index + 5));
  // Paper sheen and tape corners.
  const sheen = g.createLinearGradient(0, 0, w, h);
  sheen.addColorStop(0, "rgba(255,255,255,0.08)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0)");
  sheen.addColorStop(1, "rgba(0,0,0,0.08)");
  g.fillStyle = sheen;
  g.fillRect(0, 0, w, h);
  return c;
}

export const POSTER_COUNT = POSTERS.length;

// ---------------------------------------------------------------- products

const PRODUCT_COLORS = ["#e63b2e", "#f5b700", "#2e7bd6", "#1faa59", "#f07b1d", "#9b3fd1", "#ffffff", "#e0247a", "#20b3c7", "#6b3a1e", "#f2e3c2", "#111111"];

/**
 * Shelf facings for gondolas: rows of snack bags, cup noodles, bottles and
 * boxes with tiny labels. Each 256-px band is one shelf level.
 */
export function productAtlas(w = 2048, h = 1024, seed = 7): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  const r = new Rng(seed);
  g.fillStyle = "#1c1c1f";
  g.fillRect(0, 0, w, h);
  const band = 128;
  for (let row = 0; row < h / band; row++) {
    const y0 = row * band;
    const kind = row % 4;
    let x = 4;
    while (x < w - 10) {
      const col = r.pick(PRODUCT_COLORS);
      const col2 = r.pick(PRODUCT_COLORS);
      if (kind === 0) {
        // snack bags
        const pw = r.range(56, 84);
        const ph = r.range(88, 112);
        const y = y0 + band - ph - 6;
        g.fillStyle = col;
        roundRect(g, x, y, pw, ph, 8);
        g.fill();
        g.fillStyle = col2;
        g.fillRect(x + 6, y + ph * 0.35, pw - 12, ph * 0.3);
        g.fillStyle = "rgba(255,255,255,0.85)";
        g.font = `800 ${pw * 0.22}px ${JP_SANS}`;
        g.textAlign = "center";
        g.fillText(r.pick(["ポテト", "チップス", "スナック", "えび", "のり塩", "コーン"]), x + pw / 2, y + ph * 0.25);
        const gl = g.createLinearGradient(x, 0, x + pw, 0);
        gl.addColorStop(0, "rgba(255,255,255,0.25)");
        gl.addColorStop(0.3, "rgba(255,255,255,0)");
        gl.addColorStop(1, "rgba(0,0,0,0.25)");
        g.fillStyle = gl;
        roundRect(g, x, y, pw, ph, 8);
        g.fill();
        x += pw + r.range(2, 6);
      } else if (kind === 1) {
        // cup noodles
        const pw = r.range(58, 70);
        const ph = r.range(70, 84);
        const y = y0 + band - ph - 6;
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + pw, y);
        g.lineTo(x + pw * 0.9, y + ph);
        g.lineTo(x + pw * 0.1, y + ph);
        g.closePath();
        g.fill();
        g.fillStyle = "#f4f4f0";
        g.fillRect(x - 2, y - 6, pw + 4, 8);
        g.fillStyle = col2;
        g.fillRect(x + pw * 0.12, y + ph * 0.35, pw * 0.76, ph * 0.3);
        g.fillStyle = "#fff";
        g.font = `900 ${pw * 0.2}px ${JP_SANS}`;
        g.textAlign = "center";
        g.fillText(r.pick(["カップ", "麺", "うどん", "そば", "拉麺"]), x + pw / 2, y + ph * 0.55);
        x += pw + r.range(3, 7);
      } else if (kind === 2) {
        // PET bottles
        const pw = r.range(34, 44);
        const ph = r.range(100, 116);
        const y = y0 + band - ph - 4;
        const liquid = r.pick(["#c9e6f5", "#6b3a1e", "#f3d36b", "#9ad18b", "#e6e6e6", "#d7462f"]);
        g.fillStyle = liquid;
        roundRect(g, x, y + 22, pw, ph - 22, 8);
        g.fill();
        g.fillRect(x + pw * 0.3, y + 6, pw * 0.4, 20);
        g.fillStyle = r.pick(["#fff", "#1b7f3b", "#e8332a", "#0b4ea2"]);
        g.fillRect(x + pw * 0.3, y, pw * 0.4, 9);
        g.fillStyle = col;
        g.fillRect(x, y + ph * 0.45, pw, ph * 0.28);
        g.fillStyle = "rgba(255,255,255,0.45)";
        g.fillRect(x + 4, y + 26, 4, ph - 34);
        x += pw + r.range(3, 6);
      } else {
        // boxes (cereal / sweets / tissue)
        const pw = r.range(60, 110);
        const ph = r.range(60, 104);
        const y = y0 + band - ph - 6;
        g.fillStyle = col;
        g.fillRect(x, y, pw, ph);
        g.fillStyle = col2;
        g.beginPath();
        g.arc(x + pw * 0.5, y + ph * 0.55, Math.min(pw, ph) * 0.25, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#fff";
        g.fillRect(x + 6, y + 8, pw - 12, ph * 0.14);
        x += pw + r.range(2, 5);
      }
    }
    // shelf lip with price tags
    g.fillStyle = "#e8e8e8";
    g.fillRect(0, y0 + band - 8, w, 8);
    for (let tx = 20; tx < w; tx += r.range(70, 140)) {
      g.fillStyle = r.chance(0.2) ? "#ffe23a" : "#fff";
      g.fillRect(tx, y0 + band - 8, 34, 8);
    }
  }
  return c;
}

/** Walk-in cooler doors: bright shelves of bottles and cans. */
export function coolerAtlas(w = 1024, h = 1024, seed = 3): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  const r = new Rng(seed);
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, "#f7fbff");
  grd.addColorStop(1, "#d9e6f0");
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  const rows = 6;
  const rh = h / rows;
  for (let row = 0; row < rows; row++) {
    const y1 = (row + 1) * rh - 10;
    let x = 6;
    while (x < w - 30) {
      const can = r.chance(0.35);
      const pw = can ? 30 : r.range(30, 38);
      const ph = can ? 58 : r.range(96, 124);
      const liquid = r.pick(["#c9e6f5", "#6b3a1e", "#f3d36b", "#9ad18b", "#eeeeee", "#d7462f", "#2a2a2a", "#ff9d2e"]);
      const label = r.pick(PRODUCT_COLORS);
      if (can) {
        g.fillStyle = label;
        roundRect(g, x, y1 - ph, pw, ph, 4);
        g.fill();
        g.fillStyle = "#cfd3d6";
        g.fillRect(x, y1 - ph, pw, 5);
      } else {
        g.fillStyle = liquid;
        roundRect(g, x, y1 - ph + 24, pw, ph - 24, 7);
        g.fill();
        g.fillRect(x + pw * 0.3, y1 - ph + 6, pw * 0.4, 20);
        g.fillStyle = r.pick(["#fff", "#1b7f3b", "#e8332a", "#0b4ea2", "#f5b700"]);
        g.fillRect(x + pw * 0.28, y1 - ph, pw * 0.44, 9);
        g.fillStyle = label;
        g.fillRect(x, y1 - ph * 0.55, pw, ph * 0.25);
      }
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.fillRect(x + 4, y1 - ph + 26, 3, ph - 34);
      x += pw + r.range(2, 5);
    }
    g.fillStyle = "#b8c2ca";
    g.fillRect(0, y1, w, 10);
    g.fillStyle = "#fff";
    for (let tx = 10; tx < w; tx += 64) g.fillRect(tx, y1 + 1, 30, 8);
  }
  return c;
}

/** Open chiller: onigiri, bento, sandwiches and noodles on lit tiers. */
export function chillerAtlas(w = 1024, h = 512, seed = 5): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  const r = new Rng(seed);
  g.fillStyle = "#f2f5f7";
  g.fillRect(0, 0, w, h);
  const rows = 4;
  const rh = h / rows;
  for (let row = 0; row < rows; row++) {
    const y1 = (row + 1) * rh - 8;
    let x = 4;
    while (x < w - 40) {
      const kind = row === 0 ? 0 : row === 1 ? r.int(0, 1) : row === 2 ? 2 : r.int(1, 3);
      if (kind === 0) {
        // onigiri: white rice triangle, nori band, label
        const s = r.range(40, 48);
        g.fillStyle = "#f7f4ea";
        g.beginPath();
        g.moveTo(x + s / 2, y1 - s);
        g.lineTo(x + s, y1);
        g.lineTo(x, y1);
        g.closePath();
        g.fill();
        g.fillStyle = "#16261a";
        g.fillRect(x + s * 0.3, y1 - s * 0.45, s * 0.4, s * 0.45);
        g.fillStyle = r.pick(["#e8332a", "#1faa59", "#f5b700", "#2e7bd6"]);
        g.fillRect(x + s * 0.25, y1 - s * 0.75, s * 0.5, s * 0.14);
        x += s + 3;
      } else if (kind === 1) {
        // bento: black tray with colorful compartments
        const bw = r.range(80, 100);
        const bh = r.range(30, 40);
        g.fillStyle = "#151515";
        g.fillRect(x, y1 - bh, bw, bh);
        for (let k = 0; k < 4; k++) {
          g.fillStyle = r.pick(["#f7f4ea", "#c8702a", "#e8c33a", "#3d8a3a", "#b83a2a", "#f09a7a"]);
          g.fillRect(x + 4 + (k % 2) * (bw / 2 - 2), y1 - bh + 4 + Math.floor(k / 2) * (bh / 2 - 2), bw / 2 - 6, bh / 2 - 6);
        }
        g.fillStyle = "rgba(255,255,255,0.35)";
        g.fillRect(x, y1 - bh, bw, 4);
        x += bw + 4;
      } else if (kind === 2) {
        // sandwich wedges
        const s = r.range(44, 52);
        g.fillStyle = "#f3e2b8";
        g.beginPath();
        g.moveTo(x, y1);
        g.lineTo(x + s, y1);
        g.lineTo(x, y1 - s);
        g.closePath();
        g.fill();
        g.fillStyle = r.pick(["#f5d44a", "#e25a3a", "#6fbf4a", "#f0e0d0"]);
        g.fillRect(x + 2, y1 - s * 0.55, s * 0.4, s * 0.12);
        x += s * 0.8 + 4;
      } else {
        // noodle / pasta trays
        const bw = r.range(70, 84);
        const bh = r.range(26, 34);
        g.fillStyle = "#e9e3d4";
        g.fillRect(x, y1 - bh, bw, bh);
        g.fillStyle = r.pick(["#d8a55a", "#b8452a", "#e8d06a", "#7a5a3a"]);
        g.beginPath();
        g.ellipse(x + bw / 2, y1 - bh / 2, bw * 0.38, bh * 0.32, 0, 0, Math.PI * 2);
        g.fill();
        x += bw + 4;
      }
    }
    g.fillStyle = "#c9d2d8";
    g.fillRect(0, y1, w, 8);
    for (let tx = 8; tx < w; tx += r.range(60, 110)) {
      g.fillStyle = r.chance(0.25) ? "#ffe23a" : "#fff";
      g.fillRect(tx, y1 + 1, 30, 6);
    }
  }
  return c;
}

/** Magazine rack facings. */
export function magazineAtlas(w = 1024, h = 256, seed = 11): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  const r = new Rng(seed);
  g.fillStyle = "#1c1c1e";
  g.fillRect(0, 0, w, h);
  let x = 0;
  const titles = ["週刊", "少年", "PLAY", "旅", "MONO", "車", "料理", "美容", "競馬", "漫画", "NEWS", "GAME", "CAMP", "猫"];
  while (x < w) {
    const mw = r.range(74, 100);
    const top = r.range(4, 22);
    const cx = x + mw / 2;
    const ch = h - top;
    // Cover photo: a soft gradient "scene" with a subject silhouette.
    const hue = r.range(0, 360);
    const bg = g.createLinearGradient(0, top, 0, h);
    bg.addColorStop(0, `hsl(${hue},${r.range(30, 70)}%,${r.range(55, 80)}%)`);
    bg.addColorStop(1, `hsl(${(hue + 40) % 360},${r.range(20, 60)}%,${r.range(25, 50)}%)`);
    g.fillStyle = bg;
    g.fillRect(x + 2, top, mw - 4, ch);
    g.fillStyle = `hsla(${(hue + 180) % 360},30%,${r.range(15, 35)}%,0.85)`;
    g.beginPath();
    g.ellipse(cx + r.range(-8, 8), top + ch * 0.52, mw * 0.16, mw * 0.2, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(cx, top + ch * 0.95, mw * 0.36, ch * 0.3, 0, 0, Math.PI * 2);
    g.fill();
    // Masthead with outline.
    g.textAlign = "center";
    g.textBaseline = "top";
    g.font = `900 ${mw * 0.32}px ${JP_SANS}`;
    g.lineWidth = 3;
    g.strokeStyle = "rgba(0,0,0,0.5)";
    const title = r.pick(titles);
    g.strokeText(title, cx, top + 6);
    g.fillStyle = r.pick(["#ffffff", "#ffe23a", "#e8332a", "#111111"]);
    g.fillText(title, cx, top + 6);
    // Cover lines and a price flash.
    g.fillStyle = "rgba(255,255,255,0.9)";
    for (let i = 0; i < 4; i++) g.fillRect(x + 7 + (i % 2) * 4, top + ch * (0.42 + i * 0.09), mw * r.range(0.25, 0.45), 3);
    g.fillStyle = r.pick(["#e8332a", "#ffd21a", "#1f6fd1"]);
    g.beginPath();
    g.arc(x + mw - 16, top + ch * 0.36, 10, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#fff";
    g.fillRect(x + mw - 20, top + ch - 16, 14, 10);
    x += mw;
  }
  return c;
}

/** Back-lit cigarette wall behind the counter. */
export function tobaccoWall(w = 1024, h = 512, seed = 21): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  const r = new Rng(seed);
  g.fillStyle = "#f4f4f2";
  g.fillRect(0, 0, w, h);
  const cols = 22;
  const rows = 7;
  const cw = w / cols;
  const rh = h / rows;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = i * cw + 4;
      const y = j * rh + 8;
      g.fillStyle = r.pick(["#fff", "#e9e3d0", "#1d1d1d", "#b21e1e", "#0f3f8c", "#d9b24a", "#2f7d4f"]);
      g.fillRect(x, y, cw - 8, rh * 0.62);
      g.fillStyle = r.pick(["#c62828", "#1565c0", "#222", "#c8a23a"]);
      g.fillRect(x + 4, y + rh * 0.14, cw - 16, rh * 0.12);
      g.fillStyle = "#222";
      g.font = `600 ${rh * 0.13}px ${LATIN}`;
      g.textAlign = "center";
      g.fillText(String(r.int(1, 999)).padStart(3, "0"), x + (cw - 8) / 2, y + rh * 0.78);
    }
  return c;
}

// ---------------------------------------------------------------- vending

/** Front of a drink vending machine: sample display, prices, buttons, slot. */
export function vendingFront(brand: string, accent: string, seed: number, w = 512, h = 1024): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  const r = new Rng(seed);
  g.fillStyle = accent;
  g.fillRect(0, 0, w, h);
  // brand header
  g.fillStyle = "rgba(255,255,255,0.95)";
  g.font = `900 ${w * 0.12}px ${LATIN}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(brand, w / 2, h * 0.045);
  // display window
  const dx = w * 0.06;
  const dy = h * 0.09;
  const dw = w * 0.88;
  const dh = h * 0.52;
  const bg = g.createLinearGradient(0, dy, 0, dy + dh);
  bg.addColorStop(0, "#ffffff");
  bg.addColorStop(1, "#e4ecf2");
  g.fillStyle = bg;
  g.fillRect(dx, dy, dw, dh);
  const rows = 3;
  const per = 8;
  for (let row = 0; row < rows; row++) {
    const ry = dy + (dh / rows) * row;
    const rh = dh / rows;
    for (let i = 0; i < per; i++) {
      const cx = dx + (dw / per) * (i + 0.5);
      const bw = (dw / per) * 0.62;
      const bh = rh * 0.62;
      const top = ry + rh * 0.08;
      const col = r.pick(PRODUCT_COLORS);
      if (r.chance(0.5)) {
        // can
        g.fillStyle = col;
        roundRect(g, cx - bw / 2, top + bh * 0.28, bw, bh * 0.72, 4);
        g.fill();
        g.fillStyle = "#d0d4d8";
        g.fillRect(cx - bw / 2, top + bh * 0.28, bw, 4);
      } else {
        g.fillStyle = r.pick(["#c9e6f5", "#6b3a1e", "#f3d36b", "#9ad18b", "#eeeeee", "#ff9d2e"]);
        roundRect(g, cx - bw / 2, top + bh * 0.2, bw, bh * 0.8, 6);
        g.fill();
        g.fillRect(cx - bw * 0.2, top + bh * 0.04, bw * 0.4, bh * 0.18);
        g.fillStyle = col;
        g.fillRect(cx - bw / 2, top + bh * 0.5, bw, bh * 0.25);
      }
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.fillRect(cx - bw / 2 + 3, top + bh * 0.3, 2, bh * 0.6);
      // price + button
      g.fillStyle = "#111";
      g.fillRect(cx - bw * 0.62, ry + rh * 0.74, bw * 1.24, rh * 0.1);
      g.fillStyle = "#ffdf3a";
      g.font = `700 ${rh * 0.075}px ${LATIN}`;
      g.fillText(`${r.pick([110, 130, 140, 150, 160, 180])}`, cx, ry + rh * 0.79);
      g.fillStyle = r.chance(0.12) ? "#e8332a" : "#39d353";
      roundRect(g, cx - bw * 0.35, ry + rh * 0.87, bw * 0.7, rh * 0.07, 3);
      g.fill();
    }
    if (row === 1) {
      g.fillStyle = "#d8201a";
      g.fillRect(dx, ry + rh * 0.02, dw * 0.38, rh * 0.06);
      g.fillStyle = "#fff";
      g.font = `800 ${rh * 0.045}px ${JP_SANS}`;
      g.fillText("あったか〜い", dx + dw * 0.19, ry + rh * 0.05);
      g.fillStyle = "#1f6fd1";
      g.fillRect(dx + dw * 0.4, ry + rh * 0.02, dw * 0.6, rh * 0.06);
      g.fillStyle = "#fff";
      g.fillText("つめた〜い", dx + dw * 0.7, ry + rh * 0.05);
    }
  }
  // lower panel: bill/coin, IC reader, dispenser flap
  g.fillStyle = "rgba(0,0,0,0.18)";
  g.fillRect(0, h * 0.64, w, h * 0.36);
  g.fillStyle = "#222";
  roundRect(g, w * 0.66, h * 0.66, w * 0.26, h * 0.14, 10);
  g.fill();
  g.fillStyle = "#39d353";
  g.fillRect(w * 0.7, h * 0.68, w * 0.18, h * 0.03);
  g.fillStyle = "#0a0a0a";
  g.fillRect(w * 0.7, h * 0.73, w * 0.18, h * 0.012);
  g.fillStyle = "#1e88e5";
  roundRect(g, w * 0.08, h * 0.67, w * 0.22, h * 0.09, 8);
  g.fill();
  g.fillStyle = "#fff";
  g.font = `700 ${w * 0.035}px ${LATIN}`;
  g.fillText("IC CARD", w * 0.19, h * 0.715);
  g.fillStyle = "#151515";
  roundRect(g, w * 0.1, h * 0.84, w * 0.8, h * 0.11, 10);
  g.fill();
  g.fillStyle = "#2a2a2a";
  g.fillRect(w * 0.14, h * 0.86, w * 0.72, h * 0.03);
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.font = `700 ${w * 0.04}px ${JP_SANS}`;
  g.fillText("とりだしぐち", w / 2, h * 0.925);
  return c;
}

// -------------------------------------------------------------------- signs

export interface SignStyle {
  text: string;
  sub?: string;
  bg: string;
  fg: string;
  border?: string;
  vertical?: boolean;
  serif?: boolean;
}

/** Internally lit box sign (the stacked vertical signs on every mixed-use building). */
export function lightboxSign(s: SignStyle, w: number, h: number): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  g.fillStyle = s.bg;
  g.fillRect(0, 0, w, h);
  if (s.border) {
    g.strokeStyle = s.border;
    g.lineWidth = Math.min(w, h) * 0.05;
    g.strokeRect(g.lineWidth, g.lineWidth, w - g.lineWidth * 2, h - g.lineWidth * 2);
  }
  g.fillStyle = s.fg;
  const family = s.serif ? JP_SERIF : JP_SANS;
  if (s.vertical) {
    const chars = Array.from(s.text).length;
    const size = Math.min(w * 0.72, (h * (s.sub ? 0.8 : 0.9)) / (chars * 1.08));
    g.font = `900 ${size}px ${family}`;
    const total = size * 1.08 * chars;
    verticalText(g, s.text, w / 2, (h * (s.sub ? 0.86 : 1) - total) / 2, size);
    if (s.sub) {
      g.font = `700 ${w * 0.22}px ${LATIN}`;
      g.textAlign = "center";
      g.fillText(s.sub, w / 2, h * 0.93);
    }
  } else {
    const px = fitText(g, s.text, w * 0.9, (p) => `900 ${p}px ${family}`, h * (s.sub ? 0.56 : 0.72));
    g.font = `900 ${px}px ${family}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(s.text, w / 2, h * (s.sub ? 0.42 : 0.52));
    if (s.sub) {
      g.font = `700 ${h * 0.2}px ${LATIN}`;
      g.fillText(s.sub, w / 2, h * 0.82);
    }
  }
  return c;
}

/**
 * Neon tube lettering on a dark backplate. Returns the emissive canvas; the
 * glow itself comes from bloom, so tubes are drawn crisp with a hot core.
 */
export function neonSign(text: string, color: string, w: number, h: number, vertical = false, font = JP_SANS): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  g.fillStyle = "#050507";
  g.fillRect(0, 0, w, h);
  g.lineJoin = "round";
  g.lineCap = "round";
  const draw = (stroke: string, width: number, blur: number) => {
    g.strokeStyle = stroke;
    g.lineWidth = width;
    g.shadowColor = color;
    g.shadowBlur = blur;
    if (vertical) {
      const chars = Array.from(text);
      const size = Math.min(w * 0.78, (h * 0.9) / (chars.length * 1.05));
      g.font = `700 ${size}px ${font}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      const total = size * 1.05 * chars.length;
      chars.forEach((ch, i) => g.strokeText(ch, w / 2, (h - total) / 2 + size * 1.05 * (i + 0.5)));
    } else {
      const px = fitText(g, text, w * 0.86, (p) => `700 ${p}px ${font}`, h * 0.7);
      g.font = `700 ${px}px ${font}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.strokeText(text, w / 2, h / 2);
    }
  };
  const base = Math.min(w, h) * (vertical ? 0.05 : 0.045);
  draw(color, base * 1.6, base * 3);
  draw(color, base, base);
  draw("#ffffff", base * 0.35, 0);
  g.shadowBlur = 0;
  return c;
}

/** Red paper lantern wrap (chōchin): text runs vertically on the front. */
export function lanternWrap(text: string, w = 512, h = 512): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, "#5a0a06");
  grd.addColorStop(0.12, "#d8261a");
  grd.addColorStop(0.5, "#ff4a2a");
  grd.addColorStop(0.88, "#d8261a");
  grd.addColorStop(1, "#5a0a06");
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  // rib lines
  g.strokeStyle = "rgba(60,0,0,0.35)";
  g.lineWidth = 2;
  for (let y = 0; y < h; y += h / 22) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  g.fillStyle = "#111";
  const chars = Array.from(text);
  const size = Math.min(w * 0.2, (h * 0.8) / chars.length);
  g.font = `900 ${size}px ${JP_SERIF}`;
  verticalText(g, text, w * 0.25, (h - size * 1.08 * chars.length) / 2, size);
  verticalText(g, text, w * 0.75, (h - size * 1.08 * chars.length) / 2, size);
  return c;
}

/** Split shop curtain (noren) with a single word across the panels. */
export function norenCloth(text: string, color: string, w = 1024, h = 512): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  const cloth = g.createLinearGradient(0, 0, 0, h);
  cloth.addColorStop(0, "rgba(0,0,0,0.2)");
  cloth.addColorStop(0.2, "rgba(0,0,0,0)");
  cloth.addColorStop(1, "rgba(0,0,0,0.3)");
  g.fillStyle = cloth;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#f4efe6";
  const chars = Array.from(text);
  const size = h * 0.42;
  g.font = `900 ${size}px ${JP_SERIF}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  chars.forEach((ch, i) => g.fillText(ch, (w / chars.length) * (i + 0.5), h * 0.52));
  return c;
}

/** Road stencil text (white paint, alpha only). Written to be read from the approaching driver. */
export function roadText(text: string, w = 1024, h = 512): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#fff";
  const px = fitText(g, text, w * 0.94, (p) => `900 ${p}px ${JP_SANS}`, h * 0.9);
  g.font = `900 ${px}px ${JP_SANS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.save();
  g.translate(w / 2, h / 2);
  g.scale(1, 1.9);
  g.fillText(text, 0, 0);
  g.restore();
  // paint wear
  const r = new Rng(9);
  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(0,0,0,${r.range(0.2, 0.9)})`;
    g.beginPath();
    g.arc(r.range(0, w), r.range(0, h), r.range(0.5, 4), 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = "source-over";
  return c;
}

/** Blue municipal address plate on utility poles. */
export function addressPlate(ward: string, town: string, block: string, w = 256, h = 512): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  g.fillStyle = "#1f4fa3";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#fff";
  g.lineWidth = 8;
  g.strokeRect(10, 10, w - 20, h - 20);
  g.fillStyle = "#fff";
  g.font = `700 ${w * 0.2}px ${JP_SANS}`;
  verticalText(g, ward, w * 0.5, h * 0.06, w * 0.2);
  g.font = `900 ${w * 0.3}px ${JP_SANS}`;
  verticalText(g, town, w * 0.5, h * 0.34, w * 0.3);
  g.font = `700 ${w * 0.2}px ${JP_SANS}`;
  verticalText(g, block, w * 0.5, h * 0.72, w * 0.2);
  return c;
}

/** Inverted-triangle Japanese stop sign. */
export function stopSign(w = 512, h = 512): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#fff";
  g.beginPath();
  g.moveTo(w * 0.02, h * 0.08);
  g.lineTo(w * 0.98, h * 0.08);
  g.lineTo(w * 0.5, h * 0.92);
  g.closePath();
  g.fill();
  g.fillStyle = "#d8201a";
  g.beginPath();
  g.moveTo(w * 0.08, h * 0.115);
  g.lineTo(w * 0.92, h * 0.115);
  g.lineTo(w * 0.5, h * 0.855);
  g.closePath();
  g.fill();
  g.fillStyle = "#fff";
  g.font = `900 ${w * 0.17}px ${JP_SANS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("止まれ", w / 2, h * 0.3);
  g.font = `800 ${w * 0.09}px ${LATIN}`;
  g.fillText("STOP", w / 2, h * 0.46);
  return c;
}

/** Coin-parking sign: big P and the rate table. */
export function parkingSign(w = 512, h = 768): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  g.fillStyle = "#f5c400";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#1a1a1a";
  roundRect(g, w * 0.08, h * 0.05, w * 0.84, w * 0.84, w * 0.12);
  g.fill();
  g.fillStyle = "#f5c400";
  g.font = `900 ${w * 0.72}px ${LATIN}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("P", w / 2, h * 0.34);
  g.fillStyle = "#1a1a1a";
  g.font = `900 ${w * 0.12}px ${JP_SANS}`;
  g.fillText("20分 200円", w / 2, h * 0.73);
  g.font = `700 ${w * 0.08}px ${JP_SANS}`;
  g.fillText("夜間最大 1,000円", w / 2, h * 0.84);
  g.fillStyle = "#d8201a";
  g.font = `900 ${w * 0.11}px ${JP_SANS}`;
  g.fillText("空", w / 2, h * 0.94);
  return c;
}

/** Apartment window interiors: curtains, blinds, lamps; 4×4 atlas. */
export function windowAtlas(w = 1024, h = 1024, seed = 17): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  const r = new Rng(seed);
  const n = 4;
  const cw = w / n;
  const ch = h / n;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = i * cw;
      const y = j * ch;
      const lit = (i + j * n) % 5 !== 0;
      const warm = r.chance(0.7);
      const base = lit ? (warm ? `hsl(${r.range(28, 42)},${r.range(50, 80)}%,${r.range(45, 70)}%)` : `hsl(${r.range(190, 215)},${r.range(10, 40)}%,${r.range(55, 80)}%)`) : "#07080a";
      const grd = g.createRadialGradient(x + cw * r.range(0.3, 0.7), y + ch * 0.3, 4, x + cw / 2, y + ch / 2, cw * 0.8);
      grd.addColorStop(0, base);
      grd.addColorStop(1, lit ? "#1a1410" : "#030304");
      g.fillStyle = grd;
      g.fillRect(x, y, cw, ch);
      const style = r.int(0, 3);
      if (style === 0) {
        // blinds
        g.fillStyle = lit ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.03)";
        for (let s = 0; s < ch; s += 10) g.fillRect(x, y + s, cw, 4);
      } else if (style === 1) {
        // curtains half-drawn
        g.fillStyle = lit ? `hsla(${r.range(0, 360)},35%,40%,0.85)` : "rgba(20,20,24,0.9)";
        g.fillRect(x, y, cw * r.range(0.25, 0.45), ch);
        g.fillRect(x + cw * r.range(0.6, 0.8), y, cw, ch);
        for (let s = 0; s < cw; s += 14) {
          g.fillStyle = "rgba(0,0,0,0.12)";
          g.fillRect(x + s, y, 5, ch);
        }
      } else if (style === 2) {
        // lace curtain
        g.fillStyle = lit ? "rgba(255,245,230,0.35)" : "rgba(255,255,255,0.02)";
        g.fillRect(x, y, cw, ch);
      } else {
        // silhouette of a shelf/plant
        g.fillStyle = "rgba(0,0,0,0.55)";
        g.fillRect(x + cw * 0.1, y + ch * 0.55, cw * 0.3, ch * 0.45);
        g.beginPath();
        g.arc(x + cw * 0.75, y + ch * 0.6, cw * 0.12, 0, Math.PI * 2);
        g.fill();
        g.fillRect(x + cw * 0.73, y + ch * 0.6, cw * 0.04, ch * 0.4);
      }
      // mullion
      g.fillStyle = "#15171a";
      g.fillRect(x + cw / 2 - 3, y, 6, ch);
      g.fillRect(x, y, cw, 6);
      g.fillRect(x, y + ch - 6, cw, 6);
      g.fillRect(x, y, 6, ch);
      g.fillRect(x + cw - 6, y, 6, ch);
    }
  return c;
}
