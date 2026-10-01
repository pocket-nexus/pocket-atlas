import { Color, CylinderGeometry, PlaneGeometry } from "three";
import { canvas, fitText, HEAVY, JP_SANS, LATIN, squeezeText } from "../../shared/canvas";
import { frameUV, Sign, signTexture } from "../../shared/signs";
import { paintAbstract, paintBanner } from "../gfx/art";
import { LEVEL } from "../gfx/materials";
import type { AkibaWorld } from "./context";
import { Facade } from "./facade";
import { CHUO, STREET } from "./layout";
import { cellPlane } from "./util";

/*
 * The street's other buildings, from OpenStreetMap footprints (x ranges in
 * the place frame) and photographs:
 *   south side, east of Radio Kaikan: alley, the narrow finance building
 *     (x 3.9…7.3), Sofmap AKIBA 駅前館 (8.0…24.0), namco on the exit corner (24.9…35.7);
 *   south side, west: alley, the pachinko hall ESPACE (−36.7…−28.7), a narrow
 *     tower with a green LED message board (−43.5…−36.9), the Chuo-dori corner (−59.8…−44.5);
 *   north side: corner block (−57…−48.8), two mid-rises, Gamers (−30.3…−20.7),
 *     the footway north, atre 1 (−16.9…38) and the station exit;
 *   across Chuo-dori (x ≈ −93.6): LAOX, Onoden with BOOK OFF, and their neighbours.
 */
export function buildNeighbours(w: AkibaWorld): void {
  finance(w);
  sofmap(w);
  namco(w);
  pachinko(w);
  ledTower(w);
  cornerSouth(w);
  northWest(w);
  gamers(w);
  atre(w);
  vista(w);
  chuoEast(w);
}

const N_LINE = STREET.northLine;

// ------------------------------------------------------------ south side

function finance(w: AkibaWorld): void {
  const lib = w.lib;
  const f = new Facade(w, 7.3, 0.5, Math.PI, 3.4, 11, "finance");
  const wall = lib.tile([0.62, 0.6, 0.58]);
  const H = 25.6;
  f.body(wall, H, 11.6, { ground: 4.2, shopDepth: 2.6 });
  f.shopfront(0.15, 3.25, 3.4, "shop", 41, { fascia: { text: "アクセスチケット", sub: "秋葉原店", bg: "#ffffff", fg: "#1f3f9a" }, fasciaH: 0.7, depth: 2.6 });
  f.windows({ x0: 0.3, x1: 3.1, y0: 4.6, floorH: 3.3, floors: 6, winH: 1.5, bays: 1, winW: 1.8, frame: lib.plain(0x3a3c3f, 0.4, 0.6) });
  // Consumer-finance signs stacked up the front, and the blade signs on the corner.
  f.panelSign(0.25, 3.15, 20.5, 24.6, { text: "アイフル", bg: "#e8202a", fg: "#ffffff", vertical: true }, { intensity: "sign" });
  f.panelSign(0.4, 3.0, 15.4, 17.0, { text: "アコム", bg: "#d8141c", fg: "#ffffff" }, { intensity: "sign" });
  f.panelSign(0.4, 3.0, 13.4, 15.1, { text: "金利0円", sub: "ご相談無料", bg: "#ffffff", fg: "#d8141c" }, { intensity: "sign" });
  f.bladeSign(3.3, 5.0, 3.6, { text: "アイフル", bg: "#ffffff", fg: "#e8202a" }, { width: 0.8 });
  f.bladeSign(3.3, 9.0, 3.4, { text: "iPhone修理", bg: "#ffe14d", fg: "#1a1a1a" }, { width: 0.7 });
  f.roof(wall, H, 11.6);
}

function sofmap(w: AkibaWorld): void {
  const lib = w.lib;
  const W = 16;
  const f = new Facade(w, 24.0, 0.3, Math.PI, W, 21, "sofmap");
  const white = lib.panel([0.98, 0.98, 0.98]);
  const H = 26.5;
  f.body(white, H, 12, { ground: 4.6, shopDepth: 3.4, front: -0.9 });
  // Ground floor: used smartphones and cameras, bright white.
  f.shopfront(0.3, W - 0.3, 3.8, "shop", 23, { fascia: { text: "1F 中古スマホ・カメラ", bg: "#ffffff", fg: "#1a1a1a" }, fasciaH: 0.6, depth: 3.4, color: 0xf4f8ff, light: 1.4 });
  // Five floors of curved glass bays over white bands that carry the floor labels.
  const labels = ["2F パソコン", "3F ゲーミングパソコン", "4F テレビ", "5F 生活家電"];
  const glass = lib.bayGlass();
  for (let k = 0; k < 5; k++) {
    const y0 = 4.6 + k * 4.2;
    // Lit sales floor behind the bay.
    const inner = w.drawArt(`sofmap-floor-${k % 2}`, 1024, 160, (g, cw, ch) => {
      const bg = g.createLinearGradient(0, 0, 0, ch);
      bg.addColorStop(0, "#ffffff");
      bg.addColorStop(1, "#c8d0dc");
      g.fillStyle = bg;
      g.fillRect(0, 0, cw, ch);
      for (let i = 0; i < 40; i++) {
        g.fillStyle = ["#2a2f38", "#5a6270", "#e8ecf2", "#1d4fd8", "#c8ccd4"][(i * 7 + k) % 5];
        g.fillRect(i * (cw / 40) + 3, ch * 0.42, cw / 40 - 6, ch * (0.25 + 0.2 * ((i * 13 + k) % 3) / 2));
      }
      for (let i = 0; i < 9; i++) {
        g.fillStyle = "rgba(255,255,255,0.95)";
        g.fillRect(i * (cw / 9) + 20, ch * 0.03, cw / 14, ch * 0.05);
      }
    });
    w.mesh(cellPlane(W - 0.8, 2.6, inner), w.interior, W / 2, y0 + 1.95, -0.8, f.g);
    // Curved glazing: a 150° sweep of a 1.25 m radius, axis along the facade.
    const bay = new CylinderGeometry(1.25, 1.25, W - 0.6, 20, 1, true, -Math.PI * 0.42, Math.PI * 0.84);
    bay.rotateZ(Math.PI / 2);
    bay.rotateX(-Math.PI / 2);
    w.mesh(bay, glass, W / 2, y0 + 1.95, -0.62, f.g);
    // Chrome mullion rings on the curve every 2 m.
    for (let x = 0.4; x < W - 0.2; x += 2.0) {
      const ring = new CylinderGeometry(1.27, 1.27, 0.05, 20, 1, true, -Math.PI * 0.42, Math.PI * 0.84);
      ring.rotateZ(Math.PI / 2);
      ring.rotateX(-Math.PI / 2);
      w.mesh(ring, lib.plain(0xc8ccd0, 0.3, 0.9), x, y0 + 1.95, -0.62, f.g);
    }
    // Band with the floor label (blue square, white numeral; black text on white).
    f.box(white, 0, W, y0 + 3.2, y0 + 4.2, -0.6, 0.65);
    if (k < 4) {
      const [num, ...rest] = labels[k].split(" ");
      const rc = w.draw(`sofmap-label-${k}`, 720, 96, (g, cw, ch) => {
        g.fillStyle = "#ffffff";
        g.fillRect(0, 0, cw, ch);
        g.fillStyle = "#1d47c8";
        g.fillRect(cw * 0.02, ch * 0.08, ch * 0.84, ch * 0.84);
        g.fillStyle = "#ffffff";
        g.textAlign = "center";
        g.textBaseline = "middle";
        fitText(g, num, cw * 0.02 + ch * 0.42, ch * 0.52, ch * 0.75, ch * 0.62, LATIN);
        g.fillStyle = "#1a1a1a";
        g.textAlign = "left";
        fitText(g, rest.join(" "), cw * 0.02 + ch, ch * 0.54, cw * 0.8, ch * 0.62);
      });
      w.mesh(cellPlane(7.0, 0.92, rc), w.dim, 4.1, y0 + 3.7, 0.66, f.g);
    }
  }
  // Brand sign: BicCamera OUTLET × Sofmap, vertical on the east end.
  f.panelSign(13.6, 15.7, 9.0, 21.5, { text: "ソフマップ", bg: "#0f3ea8", fg: "#ffffff", vertical: true }, { z: 0.95, intensity: "sign" });
  f.roof(white, H, 12);
}

function namco(w: AkibaWorld): void {
  const lib = w.lib;
  const W = 10.8;
  const f = new Facade(w, 35.7, 0.2, Math.PI, W, 31, "namco");
  const dark = lib.panel([0.22, 0.22, 0.24]);
  const H = 25.5;
  f.body(dark, H, 18, { ground: H, shopDepth: 3.5 });
  // Arcade floors behind full-height glazing: colourful, bright.
  for (let k = 0; k < 5; k++) {
    const y0 = 0.2 + k * 4.6;
    f.shopfront(0.3, W - 0.3, 4.0, "arcade", 33 + k, { light: k === 0 ? 1.6 : 0, color: 0xffd8f0, depth: 3.5, y: y0 - 0.2 });
    f.box(dark, 0, W, y0 + 4.0, y0 + 4.6, -0.4, 0.25);
  }
  // Lettering at the top and a vertical sign at the corner.
  const name = w.draw("namco-name", 1100, 260, (g, cw, ch) => {
    g.fillStyle = "#18181a";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = "#ff5a1f";
    g.textBaseline = "middle";
    squeezeText(g, "namco", cw * 0.08, ch * 0.55, cw * 0.84, ch * 0.8, LATIN, HEAVY);
  });
  w.mesh(cellPlane(8.0, 1.9, name), w.bright, W / 2, H - 1.3, 0.3, f.g);
  f.bladeSign(0.2, 6, 9, { text: "ナムコ秋葉原店", bg: "#ff5a1f", fg: "#ffffff" }, { width: 1.0, intensity: "bright" });
  f.roof(dark, H, 18);
}

function pachinko(w: AkibaWorld): void {
  const lib = w.lib;
  const W = 8.0;
  const f = new Facade(w, -28.7, -0.8, Math.PI, W, 41, "pachinko");
  const white = lib.panel([0.95, 0.95, 0.95]);
  const H = 21;
  f.body(white, H, 44, { ground: 4.5, shopDepth: 4 });
  f.shopfront(0.3, W - 0.3, 3.6, "arcade", 43, { color: 0xffe0f0, light: 1.5, depth: 4 });
  // Red LED ticker over the entrance (scrolling).
  const tick = canvas(1024, 64);
  tick.g.fillStyle = "#120404";
  tick.g.fillRect(0, 0, 1024, 64);
  tick.g.fillStyle = "#ff3a1a";
  tick.g.font = `${HEAVY}44px ${JP_SANS}`;
  tick.g.textBaseline = "middle";
  tick.g.fillText("本日もご来店ありがとうございます　新台入替　PACHINKO & SLOT　", 8, 34);
  for (let x = 0; x < 1024; x += 4) {
    tick.g.fillStyle = "rgba(0,0,0,0.35)";
    tick.g.fillRect(x, 0, 1, 64);
  }
  const ticker = w.addSign(new Sign("pachinko-ticker", signTexture(tick.c, { repeat: true }), new Color(2.6, 2.2, 2.0), { scroll: [0.08, 0] }));
  w.mesh(frameUV(new PlaneGeometry(W - 0.6, 0.42), 1, 1), ticker.material, W / 2, 3.95, 0.18, f.g);
  f.box(lib.plain(0x18181a, 0.5), 0.25, W - 0.25, 3.7, 4.2, -0.1, 0.16);
  // Upper facade: a giant print (abstract) and the sign tower on top.
  const print = w.drawArt("pachinko-print", 600, 1020, (g, cw, ch) => paintAbstract(g, cw, ch, 404, ["#14121e", "#e8406a", "#ffd23f", "#3ad8ff"]));
  w.mesh(cellPlane(W - 0.6, 13.5, print), w.lib.lit(w.art.texture, LEVEL.flood, "art-flood"), W / 2, 4.6 + 13.5 / 2 + 0.3, 0.12, f.g);
  // Sign tower: white box, PACHINKO & SLOT band, the red ESPACE panel, エスパス.
  f.box(white, -0.3, W + 0.3, H, H + 11, -3.5, 0.3);
  f.panelSign(-0.2, W + 0.2, H + 9.3, H + 10.8, { text: "PACHINKO & SLOT", bg: "#141414", fg: "#ffd200", font: LATIN }, { z: 0.45, intensity: "bright" });
  f.panelSign(0.4, W - 0.4, H + 4.6, H + 8.9, { text: "ESPACE", sub: "NITTAKU", bg: "#e01d24", fg: "#ffffff", font: LATIN, border: "#ffffff" }, { z: 0.5, intensity: "bright" });
  f.panelSign(0.2, W - 0.2, H + 0.6, H + 4.2, { text: "エスパス", bg: "#ffffff", fg: "#111111" }, { z: 0.45, intensity: "sign" });
  // Its flood lamps on arms.
  const lamp = lib.glow(0xfff4e0, 5);
  for (let i = 0; i < 3; i++) {
    const x = 1.2 + i * 2.8;
    f.box(lib.plain(0x333333, 0.5), x - 0.03, x + 0.03, H + 11, H + 11.06, 0, 1.0);
    f.box(lamp, x - 0.15, x + 0.15, H + 10.9, H + 11.0, 0.9, 1.1);
  }
}

function ledTower(w: AkibaWorld): void {
  const lib = w.lib;
  const W = 6.6;
  const f = new Facade(w, -36.9, -1.0, Math.PI, W, 51, "led-tower");
  const wall = lib.tile([0.35, 0.34, 0.36]);
  const H = 31;
  f.body(wall, H, 16, { ground: 4.2, shopDepth: 3.2 });
  f.shopfront(0.3, W - 0.3, 3.5, "cards", 53, { fascia: { text: "トレカ・ホビー", bg: "#1a1a1a", fg: "#ffe14d" }, fasciaH: 0.6, depth: 3.2 });
  const print = w.drawArt("led-tower-print", 420, 1500, (g, cw, ch) => paintAbstract(g, cw, ch, 515, ["#1c1030", "#5b2bd8", "#ff4fb0", "#3ae0ff"]));
  w.mesh(cellPlane(W - 1.8, 22, print), w.lib.lit(w.art.texture, LEVEL.flood, "art-flood"), (W - 1.4) / 2, 5.2 + 11, 0.1, f.g);
  // Green LED message board running down the west edge (scrolls upward).
  const msg = canvas(64, 1024);
  msg.g.fillStyle = "#031006";
  msg.g.fillRect(0, 0, 64, 1024);
  msg.g.fillStyle = "#3dff6a";
  msg.g.font = `${HEAVY}50px ${JP_SANS}`;
  msg.g.textAlign = "center";
  msg.g.textBaseline = "middle";
  Array.from("いらっしゃいませ　秋葉原電気街　本日も営業中　").forEach((ch, i) => msg.g.fillText(ch, 32, 30 + i * 54));
  for (let y = 0; y < 1024; y += 4) {
    msg.g.fillStyle = "rgba(0,0,0,0.3)";
    msg.g.fillRect(0, y, 64, 1);
  }
  const board = w.addSign(new Sign("led-tower-board", signTexture(msg.c, { repeat: true }), new Color(1.6, 2.6, 1.7), { scroll: [0, 0.035] }));
  f.box(lib.plain(0x111111, 0.5), W - 1.15, W - 0.15, 5.0, 26.2, -0.1, 0.5);
  w.mesh(frameUV(new PlaneGeometry(0.85, 21), 1, 1), board.material, W - 0.65, 15.6, 0.51, f.g);
  f.roof(wall, H, 16);
}

function cornerSouth(w: AkibaWorld): void {
  const lib = w.lib;
  const W = 15.3;
  const f = new Facade(w, -44.5, -1.2, Math.PI, W, 61, "corner-south");
  const wall = lib.tile([0.78, 0.74, 0.68]);
  const H = 33;
  f.body(wall, H, 16.3, { ground: 4.4, shopDepth: 4 });
  f.shopfront(0.3, 9.5, 3.7, "arcade", 63, { fascia: { text: "GAME SPOT", sub: "アミューズメント", bg: "#1b1b5e", fg: "#ffe14d", font: LATIN }, fasciaH: 0.6, color: 0xffd0e8, depth: 4 });
  f.shopfront(9.7, W - 0.3, 3.7, "shop", 65, { fascia: { text: "ドラッグストア", bg: "#ffffff", fg: "#0a8a3a" }, fasciaH: 0.6, depth: 3 });
  f.windows({ x0: 0.4, x1: W - 0.4, y0: 4.4, floorH: 3.4, floors: 8, winH: 1.7, bays: 5, frame: lib.plain(0x4a4c4f, 0.4, 0.6) });
  // A big floodlit print over the upper floors on the street side, blade signs.
  const print = w.drawArt("corner-south-print", 1000, 700, (g, cw, ch) => {
    paintAbstract(g, cw, ch, 717, ["#0d1b3a", "#1e7bff", "#ffe14d", "#ffffff"]);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, "秋葉原", cw * 0.5, ch * 0.42, cw * 0.7, ch * 0.24);
    g.fillStyle = "#ffe14d";
    fitText(g, "GAME & HOBBY", cw * 0.5, ch * 0.66, cw * 0.7, ch * 0.12, LATIN);
  });
  w.mesh(cellPlane(9.5, 6.6, print), w.lib.lit(w.art.texture, LEVEL.flood, "art-flood"), 5.2, 18.5, 0.35, f.g);
  f.box(lib.plain(0x777b80, 0.45, 0.6), 0.4, 10.0, 15.1, 15.2, 0, 0.4);
  f.bladeSign(W - 0.3, 6, 5, { text: "カラオケ", bg: "#e8332a", fg: "#ffffff" }, { width: 0.8 });
  f.bladeSign(W - 0.3, 11.5, 5.5, { text: "メイドカフェ", bg: "#ff8ad0", fg: "#ffffff" }, { width: 0.8 });
  f.roof(wall, H, 16.3);
  // West face on Chuo-dori: windows and a vertical sign.
  const side = new Facade(w, -59.8, 0.4, -Math.PI / 2, 14.5, 67, "corner-south-west");
  side.windows({ x0: 0.5, x1: 14, y0: 4.4, floorH: 3.4, floors: 8, winH: 1.7, bays: 5, frame: lib.plain(0x4a4c4f, 0.4, 0.6) });
  side.shopfront(0.5, 14, 3.7, "shop", 69, { fascia: { text: "免税 TAX FREE", bg: "#d81e2a", fg: "#ffffff" }, fasciaH: 0.6, depth: 2.5 });
}

// ------------------------------------------------------------ north side

function northWest(w: AkibaWorld): void {
  const lib = w.lib;
  // Chuo-dori corner block.
  {
    const W = 8.2;
    const f = new Facade(w, -57, N_LINE - 0.5, 0, W, 71, "north-corner");
    const wall = lib.tile([0.7, 0.68, 0.64]);
    const H = 25;
    f.body(wall, H, 10, { ground: 4.2, shopDepth: 2.5 });
    f.shopfront(0.3, W - 0.3, 3.5, "shop", 73, { fascia: { text: "中古パソコン", bg: "#1a5ab8", fg: "#ffffff" }, fasciaH: 0.6, depth: 2.5 });
    f.windows({ x0: 0.4, x1: W - 0.4, y0: 4.3, floorH: 3.2, floors: 6, winH: 1.6, bays: 3, frame: lib.plain(0x3a3c3f, 0.4, 0.6) });
    f.bladeSign(W - 0.2, 5, 6, { text: "PCパーツ", bg: "#ffd21a", fg: "#1a1a1a" }, { width: 0.8 });
    f.roof(wall, H, 10);
  }
  // Two mid-rises (OSM 90834471, 宝田ビル).
  {
    const W = 5.3;
    const f = new Facade(w, -48.5, N_LINE - 0.4, 0, W, 75, "north-mid1");
    const wall = lib.panel([0.6, 0.64, 0.7]);
    const H = 22;
    f.body(wall, H, 10, { ground: 4.2, shopDepth: 2.5 });
    f.shopfront(0.3, W - 0.3, 3.5, "cards", 77, { fascia: { text: "カードショップ", bg: "#141414", fg: "#ffffff" }, fasciaH: 0.6, depth: 2.5 });
    f.windows({ x0: 0.3, x1: W - 0.3, y0: 4.3, floorH: 3.1, floors: 5, winH: 1.8, bays: 2, ribbon: true, frame: lib.plain(0x2a2c2f, 0.4, 0.6) });
    f.roof(wall, H, 10);
  }
  {
    const W = 11.9;
    const f = new Facade(w, -42.7, N_LINE - 0.1, 0, W, 79, "takarada");
    const wall = lib.tile([0.86, 0.84, 0.8]);
    const H = 26;
    f.body(wall, H, 14, { ground: 4.4, shopDepth: 3 });
    f.shopfront(0.3, 6.5, 3.6, "shop", 81, { fascia: { text: "電子パーツ", sub: "部品・工具", bg: "#ffffff", fg: "#d81e2a" }, fasciaH: 0.65, depth: 3 });
    f.shopfront(6.7, W - 0.3, 3.6, "gift", 83, { fascia: { text: "免税店", sub: "DUTY FREE", bg: "#7a1424", fg: "#ffffff" }, fasciaH: 0.65, depth: 3, color: 0xffe0c0 });
    f.windows({ x0: 0.4, x1: W - 0.4, y0: 4.4, floorH: 3.2, floors: 6, winH: 1.7, bays: 4, frame: lib.plain(0x3a3c3f, 0.4, 0.6) });
    f.bladeSign(0.2, 5.2, 7, { text: "パソコン", bg: "#1a5ab8", fg: "#ffffff" }, { width: 0.75 });
    f.bladeSign(W - 0.2, 5.2, 5.5, { text: "メイドカフェ", bg: "#ffe3f0", fg: "#d0307a" }, { width: 0.75 });
    f.roof(wall, H, 14);
  }
}

function gamers(w: AkibaWorld): void {
  const lib = w.lib;
  const W = 9.6;
  const f = new Facade(w, -30.3, N_LINE + 0.1, 0, W, 91, "gamers");
  const blue = lib.panel([0.25, 0.36, 0.62]);
  const white = lib.panel([0.95, 0.95, 0.95]);
  const H = 27;
  f.body(white, H, 13, { ground: 4.6, shopDepth: 3.5 });
  // Blue spandrel bands and white piers, windows full of lit posters.
  for (let k = 0; k < 6; k++) {
    const y0 = 4.5 + k * 3.6;
    f.box(blue, 0, W, y0, y0 + 1.0, -0.05, 0.25);
    for (let b = 0; b < 3; b++) {
      const rc = w.drawArt(`gamers-win-${k}-${b}`, 240, 160, (g, cw, ch) => {
        paintAbstract(g, cw, ch, 900 + k * 3 + b);
        g.fillStyle = "#ffffff";
        g.textAlign = "center";
        g.textBaseline = "middle";
        fitText(g, ["新刊", "予約受付中", "コミック", "画集", "限定版", "特典付き"][(k + b) % 6], cw / 2, ch * 0.8, cw * 0.8, ch * 0.16);
      });
      w.mesh(cellPlane(2.6, 2.3, rc), w.poster, 0.6 + b * 3.0 + 1.4, y0 + 2.25, 0.02, f.g);
    }
  }
  f.shopfront(0.3, W - 0.3, 3.8, "cards", 93, { fascia: { text: "GAMERS", sub: "ゲーマーズ本店", bg: "#173a8c", fg: "#ffffff", font: LATIN }, fasciaH: 0.75, depth: 3.5, light: 1.4 });
  f.panelSign(0.6, W - 0.6, H - 3.2, H - 0.4, { text: "GAMERS", bg: "#173a8c", fg: "#ffffff", font: LATIN }, { z: 0.35, intensity: "bright" });
  f.roof(white, H, 13);
}

function atre(w: AkibaWorld): void {
  const lib = w.lib;
  const W = 54.9;
  const f = new Facade(w, -16.9, N_LINE + 0.05, 0, W, 101, "atre1");
  const beige = lib.panel([0.84, 0.76, 0.64]);
  const H = 28.5;
  f.body(beige, H, 18, { ground: 4.9, shopDepth: 3.2, front: -0.2 });
  // Ground floor: shops and the passage, lit; a dark canopy band above.
  const shops: [number, number, "gift" | "shop" | "cards" | "lobby", string, string, string][] = [
    [0.4, 7.6, "gift", "スイーツ", "#ffffff", "#c03070"],
    [7.8, 15.0, "shop", "ドラッグ", "#ffffff", "#0a8a3a"],
    [15.2, 23.2, "lobby", "atre", "#2a2422", "#ffffff"],
    [23.4, 31.0, "shop", "ファッション", "#1a1a1a", "#ffffff"],
    [31.2, 39.0, "gift", "東京みやげ", "#ffffff", "#b3140e"],
    [39.2, 46.2, "shop", "カフェ", "#2e5a3a", "#ffffff"],
  ];
  for (const [x0, x1, kind, text, bg, fg] of shops) f.shopfront(x0, x1, 3.6, kind, Math.round(x0 * 7), { fascia: { text, bg, fg, font: text === "atre" ? `"Georgia", serif` : JP_SANS }, fasciaH: 0.6, depth: 3.2, color: kind === "gift" ? 0xffe2c0 : 0xf2f4ff });
  f.box(lib.plain(0x3a3430, 0.6), 0, W, 4.35, 4.9, -0.2, 0.9);
  // Upper facade: large beige panels, narrow dark window slots on a grid, lit signs on some.
  const slot = lib.glass("smoked");
  for (let k = 0; k < 6; k++) {
    const y = 6.6 + k * 3.6;
    for (let x = 1.2; x < W - 1; x += 3.0) {
      if (x > 26 && x < 32 && y > 7 && y < 23) continue;
      w.mesh(new PlaneGeometry(0.55, 2.0), slot, x, y, 0.005, f.g);
    }
  }
  // The magenta banner and its lettering.
  const banner = w.draw("atre-banner", 240, 800, (g, cw, ch) => paintBanner(g, cw, ch, "#c2186b", "#ffffff", "atrè 1"));
  f.box(lib.plain(0x2a2a2a, 0.5), 26.9, 31.1, 7.6, 22.6, 0, 0.18);
  w.mesh(cellPlane(4.0, 14.8, banner), w.sign, 29.0, 15.1, 0.19, f.g);
  // Shop signs on the upper floors.
  f.panelSign(20, 28, 9.5, 11.0, { text: "ユニクロ", bg: "#d81e2a", fg: "#ffffff" }, { intensity: "sign" });
  f.panelSign(30, 37, 9.5, 11.0, { text: "書店", sub: "BOOKS", bg: "#ffffff", fg: "#1a3a8a" }, { intensity: "sign" });
  f.panelSign(40, 46, 9.5, 11.0, { text: "100円ショップ", bg: "#ffe14d", fg: "#d81e2a" }, { intensity: "sign" });
  f.roof(beige, H, 18, false);
  // Electric Town South exit at the east end: a lit hall and the JR sign.
  const exit = new Facade(w, 38.0, -17.6, 0, 8, 103, "station-exit");
  exit.mass(beige, 9, 6, 4.4, -0.3);
  exit.shopfront(0.2, 7.8, 3.8, "station", 105, { depth: 6, light: 1.6 });
  exit.panelSign(0.4, 7.6, 3.85, 4.4, { text: "JR 秋葉原駅  電気街南口", bg: "#1c2a3a", fg: "#ffffff" }, { z: 0.2, intensity: "sign" });
  exit.box(lib.plain(0x2e8b57, 0.5), 0.4, 7.6, 4.4, 4.5, -0.1, 0.25);
}

// --------------------------------------------------------- the vista

function vista(w: AkibaWorld): void {
  const lib = w.lib;
  const X = CHUO.lineWest;
  // LAOX: white tower, z 0.8 … −12.6, facing east.
  {
    const W = 13.4;
    const f = new Facade(w, X, 0.8, Math.PI / 2, W, 111, "laox");
    const white = lib.panel([0.93, 0.93, 0.92]);
    const H = 40;
    f.body(white, H, 30, { ground: 5.2, shopDepth: 3.5 });
    f.shopfront(0.4, W - 0.4, 4.2, "gift", 113, { fascia: { text: "LAOX", sub: "Home Electronics Store", bg: "#ffffff", fg: "#1d47c8", font: LATIN }, fasciaH: 0.9, depth: 3.5, light: 0, color: 0xffe8cc });
    f.windows({ x0: 0.5, x1: W - 3.4, y0: 5.4, floorH: 3.8, floors: 8, winH: 2.4, bays: 3, ribbon: true, frame: lib.plain(0xbfc3c6, 0.35, 0.8) });
    const v = w.draw("laox-vertical", 160, 1024, (g, cw, ch) => {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, cw, ch);
      g.textAlign = "center";
      g.textBaseline = "middle";
      const letters = ["L", "A", "O", "X"];
      letters.forEach((c, i) => {
        g.fillStyle = i < 2 ? "#1d47c8" : "#ff6a00";
        g.font = `${HEAVY}${ch * 0.16}px ${LATIN}`;
        g.fillText(c, cw / 2, ch * (0.13 + i * 0.17));
      });
      g.fillStyle = "#e8202a";
      for (let y = 0; y < 10; y++) for (let x = 0; x < 5; x++) g.fillRect(cw * (0.15 + x * 0.15), ch * (0.78 + y * 0.02), cw * 0.08, ch * 0.012);
    });
    f.box(lib.plain(0x2a2a2a, 0.5), W - 3.0, W - 0.4, 14, 34, 0, 0.3);
    w.mesh(cellPlane(2.5, 19.6, v), w.sign, W - 1.7, 24, 0.31, f.g);
    f.panelSign(0.6, 2.4, 12, 26, { text: "Duty Free", bg: "#7a1424", fg: "#ffffff", vertical: false, font: LATIN }, { z: 0.6, intensity: "sign" });
    f.roof(white, H, 30);
  }
  // The narrow road between LAOX and Onoden: a few lit signs deep inside.
  {
    const f = new Facade(w, X - 30, -15.7, -Math.PI / 2, 3, 115, "gap-back");
    f.mass(lib.tile([0.5, 0.5, 0.52]), 24, 2, 0, -0.1);
    f.panelSign(0.4, 2.6, 6, 7.4, { text: "居酒屋", bg: "#f7efe0", fg: "#b3140e" }, { intensity: "sign" });
  }
  // Onoden with BOOK OFF, z −15.7 … −38.
  {
    const W = 22;
    const f = new Facade(w, X - 0.6, -15.7, Math.PI / 2, W, 117, "onoden");
    const wall = lib.panel([0.85, 0.85, 0.83]);
    const H = 30;
    f.body(wall, H, 26, { ground: 5.2, shopDepth: 3 });
    f.shopfront(0.4, W - 0.4, 4.2, "shop", 119, { fascia: { text: "オノデン", sub: "家電・パソコン", bg: "#e01d24", fg: "#ffffff" }, fasciaH: 0.9, depth: 3, light: 0 });
    f.windows({ x0: 0.5, x1: W - 0.5, y0: 5.4, floorH: 3.6, floors: 6, winH: 2.0, bays: 6, frame: lib.plain(0x6a6c6f, 0.4, 0.6) });
    f.panelSign(0.6, 9.4, H - 4.6, H - 0.4, { text: "オノデン", bg: "#e01d24", fg: "#ffffff" }, { z: 0.4, intensity: "bright" });
    f.panelSign(1.0, 7.4, 13.5, 16.5, { text: "BOOK OFF", bg: "#ffd21a", fg: "#1d3a8c", font: LATIN }, { z: 0.4, intensity: "sign" });
    f.panelSign(10.5, 13.5, 8, 22, { text: "駅からすぐ", bg: "#ffffff", fg: "#e01d24", vertical: true }, { z: 0.5 });
    f.bladeSign(W - 0.3, 6, 8, { text: "家電・免税", bg: "#e01d24", fg: "#ffffff" }, { width: 1.0 });
    f.bladeSign(15.5, 6, 6, { text: "パソコン", bg: "#1d47c8", fg: "#ffffff" }, { width: 0.9 });
    f.roof(wall, H, 26);
  }
  // South of LAOX: 6 storeys with a blue sign; more frontage both ways.
  {
    const W = 26;
    const f = new Facade(w, X, 27.0, Math.PI / 2, W, 121, "vista-south");
    const wall = lib.panel([0.7, 0.72, 0.76]);
    const H = 24;
    f.body(wall, H, 12, { ground: 4.9, shopDepth: 3 });
    f.shopfront(0.4, W - 0.4, 4.0, "shop", 123, { fascia: { text: "AKIBA ZONE", bg: "#1d47c8", fg: "#ffffff", font: LATIN }, fasciaH: 0.8, depth: 3, light: 0 });
    f.windows({ x0: 0.5, x1: W - 0.5, y0: 5.0, floorH: 3.5, floors: 5, winH: 2.0, bays: 7, frame: lib.plain(0x4a4c4f, 0.4, 0.6) });
    f.panelSign(16, 25.5, H - 4, H - 0.6, { text: "パソコン館", bg: "#1d47c8", fg: "#ffffff" }, { z: 0.4, intensity: "sign" });
    f.roof(wall, H, 12);
  }
  // One fascia and blade-sign variant per building, in loop order.
  const vista = [[-38.6, 20, 34, 131], [-59, 20, 28, 133], [47, 20, 30, 135], [67, 18, 26, 137]] as const;
  for (const [i, [z0, len, H, seed]] of vista.entries()) {
    const f = new Facade(w, X, z0, Math.PI / 2, len, seed, `vista-${seed}`);
    const wall = lib.tile([0.72, 0.7, 0.68]);
    f.body(wall, H, 14, { ground: 4.9, shopDepth: 2.5 });
    f.shopfront(0.4, len - 0.4, 4.0, "shop", seed + 1, { light: 0, depth: 2.5, fascia: { text: ["免税", "ゲーム", "電気街", "カメラ"][i], bg: ["#d81e2a", "#1a1a1a", "#1d47c8", "#ffd21a"][i], fg: i === 3 ? "#1a1a1a" : "#ffffff" }, fasciaH: 0.8 });
    f.windows({ x0: 0.5, x1: len - 0.5, y0: 5.0, floorH: 3.4, floors: Math.floor((H - 6) / 3.4), winH: 1.8, bays: 5, frame: lib.plain(0x4a4c4f, 0.4, 0.6) });
    f.bladeSign(len * 0.5, 6, 9, { text: ["ゲームセンター", "中古ゲーム", "アニメグッズ", "家電量販"][i], bg: ["#ff3a8a", "#1a5ab8", "#ff9a1a", "#0a8a3a"][i], fg: "#ffffff" }, { width: 1.0 });
    f.roof(wall, H, 14);
  }
}

/** Chuo-dori's east frontage north and south of the street mouth (seen up and down the avenue). */
function chuoEast(w: AkibaWorld): void {
  const lib = w.lib;
  const east = [[-44, 20, 26, 141], [-70, 14, 30, 143], [16, 22, 33, 145], [40, 16, 24, 147]] as const;
  for (const [i, [z0, len, H, seed]] of east.entries()) {
    const f = new Facade(w, CHUO.lineEast - 0.5, z0, -Math.PI / 2, len, seed, `chuo-east-${seed}`);
    const wall = lib.tile([0.66, 0.66, 0.68]);
    f.body(wall, H, 14, { ground: 4.9, shopDepth: 2.5 });
    f.shopfront(0.4, len - 0.4, 4.0, "arcade", seed + 1, { light: 0, depth: 2.5 });
    f.windows({ x0: 0.5, x1: len - 0.5, y0: 5.0, floorH: 3.4, floors: Math.floor((H - 6) / 3.4), winH: 1.8, bays: 5, frame: lib.plain(0x4a4c4f, 0.4, 0.6) });
    f.bladeSign(0.4, 6, 8, { text: ["アニメ", "フィギュア", "カード", "同人誌"][i], bg: ["#e8332a", "#1a5ab8", "#ffd21a", "#7a3cff"][i], fg: i === 2 ? "#1a1a1a" : "#ffffff" }, { width: 0.9 });
    f.roof(wall, H, 14);
  }
}
