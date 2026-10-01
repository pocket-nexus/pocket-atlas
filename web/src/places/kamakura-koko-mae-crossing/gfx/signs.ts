import { JP_SANS, LATIN, roundRect, type Ctx } from "../../shared/canvas";
import type { CellDef, Pen } from "./equip";

/**
 * Printed faces in the equipment atlas: crossing lamp lenses and LED
 * panels, road signs, the boards at the north-west corner (the multilingual
 * rules board, the city map boards, the vertical warning plates) and small
 * labels. Wording is the real wording of public signs or generic; no logos.
 * Sizes are 1024-atlas pixels; `p.k` scales to the atlas in use.
 */

const RED = "#d0202a";
const BLUE = "#1f55a8";
const SIGN_WHITE = "#f3f3ef";

function text(g: Ctx, s: string, x: number, y: number, font: string, color: string, maxW?: number, align: CanvasTextAlign = "center"): void {
  g.font = font;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = "middle";
  if (maxW) g.fillText(s, x, y, maxW);
  else g.fillText(s, x, y);
}

/** Retro-reflective sheet: a faint glassy speckle, smooth. */
function sheet(p: Pen, rough = 0.3): void {
  p.paint(0, 0, p.w, p.ht, undefined, rough, 0, 0.05);
  p.speckle(Math.round(p.w * p.ht * 0.01), ["rgba(255,255,255,0.06)", "rgba(0,0,0,0.05)"], [1, 1.5 * p.k]);
}

/** Weathering on a sign face: dust streaks from the top edge, a little fade. */
function weather(p: Pen, amount = 1): void {
  p.streaks(Math.round(6 * amount), "rgba(90,80,65,0.14)", [p.ht * 0.2, p.ht * 0.8], [1, 3 * p.k], () => [p.r.next() * p.w, p.ht * p.r.range(0, 0.2)]);
  p.paint(0, 0, p.w, p.ht, "rgba(255,250,240,0.04)");
}

/** Red LED lens: dark glass with Fresnel rings and a matrix of LED dots (the bright part when lit). */
function lens(p: Pen): void {
  const c = p.w / 2;
  const g = p.a.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, "#4a0b07");
  g.addColorStop(0.8, "#300604");
  g.addColorStop(1, "#160302");
  p.a.fillStyle = g;
  p.a.fillRect(0, 0, p.w, p.ht);
  p.paint(0, 0, p.w, p.ht, undefined, 0.15);
  p.a.strokeStyle = "rgba(255,120,100,0.06)";
  p.a.lineWidth = p.k;
  for (let rr = c * 0.15; rr < c; rr += c * 0.12) {
    p.a.beginPath();
    p.a.arc(c, c, rr, 0, Math.PI * 2);
    p.a.stroke();
  }
  const step = p.w / 11;
  for (let y = step / 2; y < p.ht; y += step)
    for (let x = step / 2; x < p.w; x += step) {
      if ((x - c) ** 2 + (y - c) ** 2 > (c * 0.86) ** 2) continue;
      const dg = p.a.createRadialGradient(x, y, 0, x, y, step * 0.45);
      dg.addColorStop(0, "#c8281c");
      dg.addColorStop(1, "rgba(120,20,12,0)");
      p.a.fillStyle = dg;
      p.a.fillRect(x - step / 2, y - step / 2, step, step);
    }
}

/** Amber arrow lens of the train-direction indicator (lit as a separate lamp). */
function arrowLens(p: Pen): void {
  p.base("#3a2004", 0.2);
  const step = p.w / 8;
  for (let y = step / 2; y < p.ht; y += step)
    for (let x = step / 2; x < p.w; x += step) {
      p.a.fillStyle = "#b8700e";
      p.a.beginPath();
      p.a.arc(x, y, step * 0.32, 0, Math.PI * 2);
      p.a.fill();
    }
}

/** Orange LED panel reading ふみきり: dim dots when off; the lens material lights them. */
function ledFace(p: Pen): void {
  p.base("#0d0d0d", 0.25);
  p.a.save();
  text(p.a, "ふみきり", p.w / 2, p.ht * 0.54, `900 ${p.ht * 0.62}px ${JP_SANS}`, "#9a4a08", p.w * 0.9);
  // Dot matrix: black grid over the lettering.
  p.a.fillStyle = "#0d0d0d";
  const s = 3 * p.k;
  for (let x = 0; x < p.w; x += s) p.a.fillRect(x, 0, s * 0.35, p.ht);
  for (let y = 0; y < p.ht; y += s) p.a.fillRect(0, y, p.w, s * 0.35);
  p.a.restore();
  p.a.strokeStyle = "#2c2c2c";
  p.a.lineWidth = 2 * p.k;
  p.a.strokeRect(p.k, p.k, p.w - 2 * p.k, p.ht - 2 * p.k);
}

/** Train-direction indicator face: black panel, two dark arrow windows. */
function arrowFace(p: Pen): void {
  p.base("#121212", 0.45);
  for (const dir of [-1, 1]) {
    const cx = p.w / 2 + dir * p.w * 0.24;
    p.shape((g) => {
      g.moveTo(cx + dir * p.w * 0.17, p.ht / 2);
      g.lineTo(cx - dir * p.w * 0.12, p.ht * 0.16);
      g.lineTo(cx - dir * p.w * 0.12, p.ht * 0.84);
      g.closePath();
    }, "#2a1804", 0.2, 0, -0.3);
  }
  p.paint(0, 0, p.w, 2 * p.k, "#2a2a2a", undefined, undefined, 0.5);
}

/** Emergency button box (踏切支障報知装置), face. */
function emergency(p: Pen): void {
  p.base("#eceae3", 0.5);
  p.paint(p.w * 0.06, p.ht * 0.05, p.w * 0.88, p.ht * 0.2, RED, 0.45);
  text(p.a, "非常ボタン", p.w / 2, p.ht * 0.155, `900 ${p.ht * 0.12}px ${JP_SANS}`, "#fff", p.w * 0.84);
  // Button under a clear cover.
  p.shape((g) => g.arc(p.w / 2, p.ht * 0.55, p.w * 0.24, 0, Math.PI * 2), "#d0d0cc", 0.2, 0, 0.6);
  p.shape((g) => g.arc(p.w / 2, p.ht * 0.55, p.w * 0.17, 0, Math.PI * 2), "#c41712", 0.3, 0, 0.9);
  text(p.a, "踏切内で異常があった", p.w / 2, p.ht * 0.82, `700 ${p.ht * 0.065}px ${JP_SANS}`, "#222", p.w * 0.9);
  text(p.a, "ときは押してください", p.w / 2, p.ht * 0.9, `700 ${p.ht * 0.065}px ${JP_SANS}`, "#222", p.w * 0.9);
  for (const [x, y] of [
    [0.1, 0.3],
    [0.9, 0.3],
    [0.1, 0.96],
    [0.9, 0.96],
  ])
    p.bolt(p.w * x, p.ht * y, 1.6 * p.k);
  p.grime(0.25, 0.25);
}

/** Round 非常ボタン plate on the north-west post. */
function emergencySign(p: Pen): void {
  p.base("#b9bcbd", 0.4, 0.6);
  const c = p.w / 2;
  p.shape((g) => g.arc(c, c, c * 0.98, 0, Math.PI * 2), SIGN_WHITE, 0.35);
  p.shape((g) => g.arc(c, c, c * 0.86, 0, Math.PI * 2), RED, 0.35);
  text(p.a, "非常", c, c * 0.72, `900 ${c * 0.42}px ${JP_SANS}`, "#fff");
  text(p.a, "ボタン", c, c * 1.22, `900 ${c * 0.36}px ${JP_SANS}`, "#fff", c * 1.5);
  weather(p, 0.5);
}

/** Round sign: no parking (blue disc, red ring, one red bar). */
function noParking(p: Pen): void {
  const r = p.w / 2;
  p.base("#a9aeb0", 0.45, 0.6);
  p.shape((g) => g.arc(r, r, r * 0.99, 0, Math.PI * 2), SIGN_WHITE, 0.3);
  p.shape((g) => g.arc(r, r, r * 0.93, 0, Math.PI * 2), RED, 0.3);
  p.shape((g) => g.arc(r, r, r * 0.73, 0, Math.PI * 2), BLUE, 0.3);
  p.a.save();
  p.a.translate(r, r);
  p.a.rotate(Math.PI / 4);
  p.a.fillStyle = RED;
  p.a.fillRect(-r * 0.78, -r * 0.085, r * 1.56, r * 0.17);
  p.a.restore();
  sheet(p);
  weather(p);
}

/** Speed limit 50 (Route 134). */
function speed50(p: Pen): void {
  const r = p.w / 2;
  p.base("#a9aeb0", 0.45, 0.6);
  p.shape((g) => g.arc(r, r, r * 0.99, 0, Math.PI * 2), SIGN_WHITE, 0.3);
  p.shape((g) => g.arc(r, r, r * 0.93, 0, Math.PI * 2), RED, 0.3);
  p.shape((g) => g.arc(r, r, r * 0.72, 0, Math.PI * 2), SIGN_WHITE, 0.3);
  text(p.a, "50", r, r * 1.05, `800 ${p.w * 0.5}px ${LATIN}`, BLUE);
  sheet(p);
  weather(p);
}

/** Designated direction (straight on only): blue disc, white arrow. */
function straightOnly(p: Pen): void {
  const r = p.w / 2;
  p.base("#a9aeb0", 0.45, 0.6);
  p.shape((g) => g.arc(r, r, r * 0.99, 0, Math.PI * 2), SIGN_WHITE, 0.3);
  p.shape((g) => g.arc(r, r, r * 0.92, 0, Math.PI * 2), BLUE, 0.3);
  p.shape((g) => {
    g.moveTo(r, r * 0.28);
    g.lineTo(r * 1.42, r * 0.82);
    g.lineTo(r * 1.13, r * 0.82);
    g.lineTo(r * 1.13, r * 1.72);
    g.lineTo(r * 0.87, r * 1.72);
    g.lineTo(r * 0.87, r * 0.82);
    g.lineTo(r * 0.58, r * 0.82);
    g.closePath();
  }, SIGN_WHITE, 0.3);
  sheet(p);
  weather(p);
}

/** Supplementary plate: a lorry pictogram (the sign applies to large vehicles). */
function truckPlate(p: Pen): void {
  p.base(SIGN_WHITE, 0.35);
  p.a.strokeStyle = "#222";
  p.a.lineWidth = 2 * p.k;
  p.a.strokeRect(2 * p.k, 2 * p.k, p.w - 4 * p.k, p.ht - 4 * p.k);
  const s = p.ht / 56;
  p.a.fillStyle = "#1a1a1a";
  p.a.fillRect(p.w * 0.22, p.ht * 0.2, p.w * 0.38, p.ht * 0.42);
  roundRect(p.a, p.w * 0.61, p.ht * 0.3, p.w * 0.17, p.ht * 0.32, 4 * s);
  p.a.fill();
  for (const x of [0.3, 0.42, 0.7]) {
    p.a.beginPath();
    p.a.arc(p.w * x, p.ht * 0.7, p.ht * 0.1, 0, Math.PI * 2);
    p.a.fill();
  }
  weather(p, 0.5);
}

/** Pedestrian crossing (407-A): blue square, white triangle, an adult leading a child. */
function pedCrossing(p: Pen): void {
  const w = p.w;
  const h = p.ht;
  p.base(SIGN_WHITE, 0.3);
  p.paint(w * 0.04, h * 0.04, w * 0.92, h * 0.92, BLUE, 0.3);
  p.shape((g) => {
    g.moveTo(w * 0.5, h * 0.1);
    g.lineTo(w * 0.9, h * 0.84);
    g.lineTo(w * 0.1, h * 0.84);
    g.closePath();
  }, SIGN_WHITE, 0.3);
  const fig = (x: number, s: number) => {
    p.a.fillStyle = "#151515";
    p.a.beginPath();
    p.a.arc(x, h * (0.84 - 0.42 * s), w * 0.04 * s, 0, Math.PI * 2);
    p.a.fill();
    p.a.fillRect(x - w * 0.035 * s, h * (0.84 - 0.36 * s), w * 0.07 * s, h * 0.18 * s);
    p.a.save();
    p.a.translate(x, h * (0.84 - 0.18 * s));
    p.a.rotate(0.35);
    p.a.fillRect(-w * 0.012 * s, 0, w * 0.03 * s, h * 0.16 * s);
    p.a.restore();
    p.a.save();
    p.a.translate(x, h * (0.84 - 0.18 * s));
    p.a.rotate(-0.35);
    p.a.fillRect(-w * 0.018 * s, 0, w * 0.03 * s, h * 0.16 * s);
    p.a.restore();
  };
  fig(w * 0.44, 1);
  fig(w * 0.6, 0.72);
  p.a.fillStyle = "#151515";
  p.a.fillRect(w * 0.47, h * 0.58, w * 0.1, h * 0.022);
  sheet(p);
  weather(p);
}

/** Point-up triangular plate at the west kerb (a pedestrian-crossing warning face). */
function triangle(p: Pen): void {
  const w = p.w;
  const h = p.ht;
  p.base("#a9aeb0", 0.45, 0.6);
  p.shape((g) => {
    g.moveTo(w * 0.5, 0);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.closePath();
  }, SIGN_WHITE, 0.3);
  p.shape((g) => {
    g.moveTo(w * 0.5, h * 0.09);
    g.lineTo(w * 0.93, h * 0.95);
    g.lineTo(w * 0.07, h * 0.95);
    g.closePath();
  }, BLUE, 0.3);
  p.a.fillStyle = SIGN_WHITE;
  p.a.beginPath();
  p.a.arc(w * 0.5, h * 0.48, w * 0.045, 0, Math.PI * 2);
  p.a.fill();
  p.a.fillRect(w * 0.46, h * 0.54, w * 0.08, h * 0.2);
  p.a.fillRect(w * 0.43, h * 0.74, w * 0.05, h * 0.14);
  p.a.fillRect(w * 0.52, h * 0.74, w * 0.05, h * 0.14);
  sheet(p);
  weather(p);
}

/** Galvanised sign back with a stiffening rib. */
function signBack(p: Pen): void {
  p.base("#a4a9ab", 0.45, 0.75);
  p.speckle(p.w * p.ht * 0.1, ["rgba(255,255,255,0.08)", "rgba(0,0,0,0.08)"], [1, 2 * p.k]);
  p.paint(0, p.ht * 0.45, p.w, p.ht * 0.1, "rgba(0,0,0,0.12)", undefined, undefined, 0.8);
}

/** Vertical white board: 車両通り抜け出来ません in red. */
function vehicles(p: Pen): void {
  p.base("#f4f3ee", 0.45);
  p.a.strokeStyle = RED;
  p.a.lineWidth = p.w * 0.06;
  p.a.strokeRect(p.w * 0.06, p.w * 0.06, p.w * 0.88, p.ht - p.w * 0.12);
  const t = "車両通り抜け出来ません";
  const size = Math.min(p.w * 0.66, (p.ht * 0.9) / t.length);
  Array.from(t).forEach((c, i) => text(p.a, c, p.w / 2, p.ht * 0.05 + size * (i + 0.5), `900 ${size}px ${JP_SANS}`, RED));
  weather(p, 0.6);
}

/** 踏切内立入禁止 with a crossed-out walker. */
function noEntry(p: Pen): void {
  p.base("#f4f3ee", 0.45);
  const cx = p.w / 2;
  const cy = p.ht * 0.3;
  const r = p.w * 0.36;
  p.a.strokeStyle = RED;
  p.a.lineWidth = p.w * 0.07;
  p.a.beginPath();
  p.a.arc(cx, cy, r, 0, Math.PI * 2);
  p.a.stroke();
  p.a.fillStyle = "#151515";
  p.a.beginPath();
  p.a.arc(cx, cy - r * 0.45, r * 0.14, 0, Math.PI * 2);
  p.a.fill();
  p.a.fillRect(cx - r * 0.12, cy - r * 0.3, r * 0.24, r * 0.55);
  p.a.fillRect(cx - r * 0.2, cy + r * 0.25, r * 0.12, r * 0.4);
  p.a.fillRect(cx + r * 0.08, cy + r * 0.25, r * 0.12, r * 0.4);
  p.a.save();
  p.a.translate(cx, cy);
  p.a.rotate(-Math.PI / 4);
  p.a.fillStyle = RED;
  p.a.fillRect(-r, -p.w * 0.035, 2 * r, p.w * 0.07);
  p.a.restore();
  ["踏切内", "立入禁止"].forEach((s, i) => text(p.a, s, cx, p.ht * (0.66 + i * 0.17), `900 ${p.w * 0.21}px ${JP_SANS}`, RED, p.w * 0.9));
  weather(p, 0.6);
}

/**
 * The multilingual rules board at the north-west corner (0.8 × 1.2 m):
 * the heading in five languages, then three panels: teal "Around the train
 * tracks", brown "On the train platform", green "Along the train route",
 * each with a prohibition pictogram and short rules.
 */
function rules(p: Pen): void {
  const w = p.w;
  const h = p.ht;
  p.base("#f6f5ef", 0.45);
  const head: [string, string, number][] = [
    ["Follow the rules for a safe and fun trip", LATIN, 0.03],
    ["遵守規則旅途愉快。", JP_SANS, 0.028],
    ["开心旅程，需要你我共同遵守规则。", JP_SANS, 0.028],
    ["규칙을 지켜 즐거운 여행을.", JP_SANS, 0.028],
    ["ルールを守って楽しい旅を。", JP_SANS, 0.033],
  ];
  head.forEach(([s, f, size], i) => text(p.a, s, w * 0.05, h * (0.035 + i * 0.04), `800 ${h * size}px ${f}`, "#1e1e1e", w * 0.9, "left"));
  p.paint(w * 0.05, h * 0.232, w * 0.9, h * 0.004, "#888");
  const panels: [string, string, string[], (x: number, y: number, s: number) => void][] = [
    [
      "#13808d",
      "Around the train tracks",
      ["線路内に立ち入らないでください", "Do not enter the tracks", "请勿进入轨道 · 선로에 들어가지 마세요"],
      (x, y, s) => walker(p.a, x, y, s),
    ],
    [
      "#8a5a2c",
      "On the train platform",
      ["ホームでは白線の内側へ", "Stay behind the line on the platform", "请站在白线内侧 · 흰 선 안쪽에 서 주세요"],
      (x, y, s) => walker(p.a, x, y, s),
    ],
    [
      "#2f7f3c",
      "Along the train route",
      ["車道で立ち止まらないでください", "Do not stop on the road to take photos", "请勿在车道停留 · 차도에 멈추지 마세요"],
      (x, y, s) => camera(p.a, x, y, s),
    ],
  ];
  panels.forEach(([col, title, lines, pict], i) => {
    const y0 = h * (0.255 + i * 0.245);
    p.paint(w * 0.04, y0, w * 0.92, h * 0.225, col, 0.4);
    text(p.a, title, w * 0.07, y0 + h * 0.022, `700 ${h * 0.027}px ${LATIN}`, "#fff", w * 0.86, "left");
    p.paint(w * 0.07, y0 + h * 0.045, w * 0.27, h * 0.165, "#fbfbf8", 0.45);
    const cx = w * 0.205;
    const cy = y0 + h * 0.128;
    pict(cx, cy, h * 0.06);
    p.a.strokeStyle = RED;
    p.a.lineWidth = h * 0.009;
    p.a.beginPath();
    p.a.arc(cx, cy, h * 0.068, 0, Math.PI * 2);
    p.a.moveTo(cx - h * 0.048, cy + h * 0.048);
    p.a.lineTo(cx + h * 0.048, cy - h * 0.048);
    p.a.stroke();
    lines.forEach((s, l) => text(p.a, s, w * 0.38, y0 + h * (0.07 + l * 0.05), `${l ? 600 : 800} ${h * (l ? 0.021 : 0.025)}px ${l === 1 ? LATIN : JP_SANS}`, "#fff", w * 0.56, "left"));
  });
  text(p.a, "江ノ島電鉄 · 鎌倉市", w * 0.5, h * 0.985, `600 ${h * 0.016}px ${JP_SANS}`, "#555");
  p.a.strokeStyle = "#9a9a94";
  p.a.lineWidth = 2 * p.k;
  p.a.strokeRect(p.k, p.k, w - 2 * p.k, h - 2 * p.k);
  weather(p, 0.8);
}

function walker(g: Ctx, x: number, y: number, s: number): void {
  g.fillStyle = "#1a1a1a";
  g.beginPath();
  g.arc(x, y - s * 0.62, s * 0.16, 0, Math.PI * 2);
  g.fill();
  g.fillRect(x - s * 0.12, y - s * 0.45, s * 0.24, s * 0.55);
  g.fillRect(x - s * 0.24, y + s * 0.1, s * 0.13, s * 0.5);
  g.fillRect(x + s * 0.1, y + s * 0.1, s * 0.13, s * 0.5);
  g.fillStyle = "#555";
  g.fillRect(x - s * 0.9, y + s * 0.62, s * 1.8, s * 0.08);
}

function camera(g: Ctx, x: number, y: number, s: number): void {
  g.fillStyle = "#1a1a1a";
  roundRect(g, x - s * 0.6, y - s * 0.3, s * 1.2, s * 0.75, s * 0.1);
  g.fill();
  g.fillRect(x - s * 0.25, y - s * 0.45, s * 0.4, s * 0.18);
  g.fillStyle = "#fbfbf8";
  g.beginPath();
  g.arc(x, y + s * 0.07, s * 0.24, 0, Math.PI * 2);
  g.fill();
}

/** City map board: Koshigoe and Shichirigahama, pale map, coast, the Enoden, a you-are-here dot. */
function mapBoard(seed: number) {
  return (p: Pen) => {
    const w = p.w;
    const h = p.ht;
    p.base("#2a4a3c", 0.45);
    p.paint(w * 0.05, h * 0.13, w * 0.9, h * 0.8, "#eef0e2", 0.4);
    text(p.a, seed === 1 ? "周辺案内図  Area Map" : "七里ヶ浜・腰越 散策マップ", w / 2, h * 0.065, `800 ${h * 0.05}px ${JP_SANS}`, "#fff", w * 0.9);
    const L = (fx: number) => w * (0.05 + 0.9 * fx);
    const T = (fy: number) => h * (0.13 + 0.8 * fy);
    // Sea, beach, Route 134, the Enoden, the slope road, blocks.
    p.a.fillStyle = "#a8d0e4";
    p.a.beginPath();
    p.a.moveTo(L(0), T(0.74));
    for (let i = 0; i <= 10; i++) p.a.lineTo(L(i / 10), T(0.74 + 0.04 * Math.sin(i * 0.8 + seed)));
    p.a.lineTo(L(1), T(1));
    p.a.lineTo(L(0), T(1));
    p.a.closePath();
    p.a.fill();
    p.a.strokeStyle = "#e6d39a";
    p.a.lineWidth = h * 0.03;
    p.a.beginPath();
    p.a.moveTo(L(0), T(0.7));
    p.a.lineTo(L(1), T(0.72));
    p.a.stroke();
    p.a.strokeStyle = "#f0b04a";
    p.a.lineWidth = h * 0.022;
    p.a.beginPath();
    p.a.moveTo(L(0), T(0.63));
    p.a.lineTo(L(1), T(0.65));
    p.a.stroke();
    p.a.strokeStyle = "#2f7f5a";
    p.a.lineWidth = h * 0.01;
    p.a.setLineDash([h * 0.02, h * 0.012]);
    p.a.beginPath();
    p.a.moveTo(L(0), T(0.58));
    p.a.lineTo(L(1), T(0.6));
    p.a.stroke();
    p.a.setLineDash([]);
    p.a.strokeStyle = "#fff";
    p.a.lineWidth = h * 0.016;
    p.a.beginPath();
    p.a.moveTo(L(0.52), T(0.6));
    p.a.lineTo(L(0.5), T(0.3));
    p.a.lineTo(L(0.45), T(0.02));
    p.a.stroke();
    for (let i = 0; i < 9; i++) {
      p.a.fillStyle = i % 3 ? "#d9dccb" : "#cfe2b6";
      p.a.fillRect(L(p.r.range(0.04, 0.85)), T(p.r.range(0.05, 0.45)), w * p.r.range(0.06, 0.15), h * p.r.range(0.04, 0.1));
    }
    p.a.fillStyle = RED;
    p.a.beginPath();
    p.a.arc(L(0.52), T(0.6), h * 0.018, 0, Math.PI * 2);
    p.a.fill();
    text(p.a, "現在地", L(0.52) + h * 0.06, T(0.55), `800 ${h * 0.03}px ${JP_SANS}`, RED);
    for (let l = 0; l < 3; l++) p.paint(L(0.05), T(0.08 + l * 0.04), w * 0.3, h * 0.008, "rgba(60,60,60,0.5)");
    weather(p, 0.8);
  };
}

/** White plate with black lettering (gate machine numbers, pole tags). */
function label(s: string, vertical = false) {
  return (p: Pen) => {
    p.base("#efeee8", 0.5);
    p.a.strokeStyle = "#333";
    p.a.lineWidth = 1.2 * p.k;
    p.a.strokeRect(p.k, p.k, p.w - 2 * p.k, p.ht - 2 * p.k);
    if (vertical) {
      const chars = Array.from(s);
      const size = Math.min(p.w * 0.7, (p.ht * 0.9) / chars.length);
      chars.forEach((c, i) => text(p.a, c, p.w / 2, p.ht * 0.05 + size * (i + 0.5), `800 ${size}px ${JP_SANS}`, "#111"));
    } else text(p.a, s, p.w / 2, p.ht * 0.54, `800 ${p.ht * 0.7}px ${LATIN}`, "#111", p.w * 0.86);
    weather(p, 0.4);
  };
}

export const SIGN_CELLS = {
  lens: { w: 64, h: 64, bump: 0.2, paint: lens },
  arrowLens: { w: 32, h: 32, bump: 0.2, paint: arrowLens },
  ledFace: { w: 128, h: 40, bump: 0.3, paint: ledFace },
  arrowFace: { w: 96, h: 48, bump: 1, paint: arrowFace },
  emergency: { w: 64, h: 96, bump: 1.5, paint: emergency },
  emergencySign: { w: 64, h: 64, bump: 0.6, paint: emergencySign },
  noParking: { w: 128, h: 128, bump: 0.4, paint: noParking },
  speed50: { w: 128, h: 128, bump: 0.4, paint: speed50 },
  straightOnly: { w: 128, h: 128, bump: 0.4, paint: straightOnly },
  truckPlate: { w: 128, h: 56, bump: 0.4, paint: truckPlate },
  pedCrossing: { w: 128, h: 128, bump: 0.4, paint: pedCrossing },
  triangle: { w: 128, h: 112, bump: 0.4, paint: triangle },
  signBack: { w: 32, h: 32, bump: 1.5, paint: signBack },
  vehicles: { w: 40, h: 240, bump: 0.4, paint: vehicles },
  noEntry: { w: 80, h: 140, bump: 0.4, paint: noEntry },
  rules: { w: 224, h: 336, bump: 0.3, paint: rules },
  map1: { w: 160, h: 200, bump: 0.3, paint: mapBoard(1) },
  map2: { w: 160, h: 200, bump: 0.3, paint: mapBoard(2) },
  plate2: { w: 32, h: 40, bump: 0.3, paint: label("2") },
  poleTag: { w: 24, h: 72, bump: 0.3, paint: label("七里中12", true) },
} satisfies Record<string, CellDef>;
