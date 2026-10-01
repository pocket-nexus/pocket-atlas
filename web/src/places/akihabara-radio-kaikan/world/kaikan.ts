import { BoxGeometry, CircleGeometry, Color, CylinderGeometry, PlaneGeometry, SphereGeometry, type Object3D } from "three";
import { Rng } from "../../../core/random";
import { LATIN } from "../../shared/canvas";
import { box } from "../../shared/geo";
import { frameUV, Sign, signTexture } from "../../shared/signs";
import { BAND_TEXT, bandBars, fitText, HEAVY, paintAbstract, paintBillboard, paintBlueLetters, paintInterior, paintLightbox, paintPanorama, paintRadioLetters, paintTenant, screenFrames, squeezeText, type TenantPoster } from "../gfx/art";
import type { AkibaWorld } from "./context";
import { KAIKAN } from "./layout";
import { cellPlane, rect, spot, v } from "./util";

/*
 * Akihabara Radio Kaikan, the 2014 building. Authored in a local frame: the
 * north facade on z = 0 facing +z (the street), x from 0 at the NE corner to
 * 24 at the NW corner (left to right as seen from the street), body toward
 * −z. The group is turned 180° so local (x, z) is world (−x, −z).
 *
 *   y 44.2 ┌────────────────────────────┬──────┐ parapet (no rooftop sign)
 *          │ 10F … 6F  ribbon windows,   │louvre│ west quarter: horizontal
 *          │ backlit window artwork      │strip │ louvres, lit from behind
 *          │ 5F amiami │ artwork         │      │
 *     18.1 │ 4F K-BOOKS├─ billboard ─────┤      │
 *          │ 3F tenants│  (3F–4F)        │      │
 *      9.8 ├───────────┴─────────────────┤      │
 *          │ 世界の ラジオ会館 秋葉原 (LED) │screen│ 2F: yellow LED band, LED screen
 *     4.55 ├── soffit with downlights ───┴──────┤
 *          │col│ gift shop │entrance│ C-labo │B1│ ground floor, recessed 1.35 m
 *        0 └───┴───────────┴────────┴────────┴──┘
 *          x=0 (NE)                        x=24 (NW)
 */

const W = KAIKAN.x1 - KAIKAN.x0;
const D = KAIKAN.z1 - KAIKAN.z0;
const RIB = KAIKAN.ribbon.x1 - KAIKAN.ribbon.x0;
const LOUVRE_X0 = RIB;
const SOFFIT = KAIKAN.soffit;
const FRONT = -KAIKAN.shopfront;
const BAND = { x0: 0, x1: KAIKAN.band.x1 - KAIKAN.band.x0, y0: KAIKAN.band.y0, y1: KAIKAN.band.y1, d: KAIKAN.band.depth };
const SCREEN = { x0: -KAIKAN.screen.x1, x1: -KAIKAN.screen.x0, y0: KAIKAN.screen.y0, y1: KAIKAN.screen.y1 };
const BB = { x0: -KAIKAN.billboard.x1, x1: -KAIKAN.billboard.x0, y0: KAIKAN.billboard.y0, y1: KAIKAN.billboard.y1 };
const FLOORS = 8;
const SPANDREL = 0.72;
const BAYS = 15;

/** Local → world for this building (180° about y at the NE corner). */
const toWorld = (x: number, y: number, z: number) => v(-x, y, -z);

export interface Kaikan {
  root: Object3D;
}

export function buildKaikan(w: AkibaWorld): Kaikan {
  const root = w.group(0, 0, 0, Math.PI);
  root.name = "radio-kaikan";
  const lib = w.lib;
  const white = lib.panel([1.02, 1.02, 1.0]);
  const grey = lib.panel([0.82, 0.82, 0.8]);
  const alu = lib.aluminium();

  // ------------------------------------------------------------ volume
  w.mesh(box(W, KAIKAN.roof - SOFFIT, D - 0.3), white, W / 2, SOFFIT + (KAIKAN.roof - SOFFIT) / 2, -0.3 - (D - 0.3) / 2, root);
  w.mesh(box(W, SOFFIT, D - 6), white, W / 2, SOFFIT / 2, -6 - (D - 6) / 2, root);
  // Penthouse levels set back from every edge, and roof plant.
  w.mesh(box(15, KAIKAN.top - KAIKAN.roof, 22), grey, 11, KAIKAN.roof + (KAIKAN.top - KAIKAN.roof) / 2, -22, root);
  w.mesh(box(W + 0.1, 0.25, 0.4), grey, W / 2, KAIKAN.roof + 0.12, -0.2, root);
  const plant = lib.plain(0x8a8e90, 0.6);
  for (let i = 0; i < 6; i++) w.mesh(box(2.2, 1.6, 1.4), plant, 3 + i * 3.2, KAIKAN.roof + 0.8, -40, root);

  ribbonFloors(w, root);
  louvreStrip(w, root);
  band(w, root);
  screen(w, root);
  billboard(w, root);
  groundFloor(w, root, white, alu);
  return { root };
}

// -------------------------------------------------------------- 3F–10F

/** Window artwork per floor: [x0, x1, cell, u-range of the cell]. */
function ribbonFloors(w: AkibaWorld, root: Object3D): void {
  const lib = w.lib;
  const white = lib.panel([1.02, 1.02, 1.0]);
  const mullion = lib.plain(0xc8ccd0, 0.35, 0.8);
  const bay = RIB / BAYS;
  const winH = KAIKAN.floorH - SPANDREL - 0.05;
  const yWin = (k: number) => KAIKAN.f3 + k * KAIKAN.floorH + SPANDREL;

  // 5F–10F: one artwork behind every pane of six floors; each floor's
  // windows sample their true height in it, so it reads continuous behind
  // the spandrels.
  const artBottom = yWin(2);
  const artTop = yWin(7) + winH;
  const pano = w.drawArt("kaikan-panorama", 1600, 1720, (g, cw, ch) => paintPanorama(g, cw, ch));
  const behind = w.drawArt("kaikan-34f-west", 900, 300, (g, cw, ch) => paintAbstract(g, cw, ch, 61));

  const tenants3: TenantPoster[] = [
    { bg: "#ffffff", fg: "#e0307a", lines: ["azone", "ドール専門店", "6F"], accent: "#ffd6e8", font: LATIN },
    { bg: "#f2f2f2", fg: "#2a2a2a", lines: ["フィギュア", "中古買取・販売", "JUNGLE 2F"], accent: "#e8332a" },
    { bg: "#16328c", fg: "#ffd200", lines: ["BIGMAGIC", "カードゲーム専門店"], accent: "#ffd200", font: LATIN },
    { bg: "#ffffff", fg: "#1b1b1b", lines: ["宇宙船", "TOYS & FIGURES"], accent: "#1a4fd8" },
    { bg: "#0d2f86", fg: "#ffffff", lines: ["HOBBY STATION", "カードゲームショップ"], accent: "#e8332a", font: LATIN },
  ];
  const p3 = tenants3.map((t, i) => w.drawArt(`kaikan-3f-${i}`, 260, 520, (g, cw, ch) => paintTenant(g, cw, ch, t)));
  const kbooks = w.drawArt("kaikan-kbooks", 1040, 520, (g, cw, ch) => {
    g.fillStyle = "#0b0b0b";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    squeezeText(g, "K-BOOKS", cw * 0.08, ch * 0.3, cw * 0.84, ch * 0.3, LATIN);
    fitText(g, "秋葉原", cw / 2, ch * 0.58, cw * 0.5, ch * 0.18);
    fitText(g, "本館&MEN'S館", cw / 2, ch * 0.8, cw * 0.8, ch * 0.16);
  });
  const amiami = w.drawArt("kaikan-amiami", 780, 520, (g, cw, ch) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = "#ff7a1a";
    g.fillRect(0, 0, cw, ch * 0.22);
    g.fillStyle = "#ffffff";
    g.font = `800 ${ch * 0.12}px ${LATIN}`;
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText("FIGURES · GOODS", cw * 0.05, ch * 0.11);
    g.fillStyle = "#ff6a00";
    squeezeText(g, "amiami", cw * 0.06, ch * 0.45, cw * 0.88, ch * 0.3, LATIN);
    g.fillStyle = "#1a1a1a";
    g.textAlign = "center";
    fitText(g, "あみあみ ラジオ会館 秋葉原店", cw / 2, ch * 0.78, cw * 0.9, ch * 0.13);
  });

  for (let k = 0; k < FLOORS; k++) {
    const y0 = KAIKAN.f3 + k * KAIKAN.floorH;
    // Spandrel with its projecting sill.
    w.mesh(box(RIB, SPANDREL, 0.62), white, RIB / 2, y0 + SPANDREL / 2 - 0.02, 0.0, root);
    w.mesh(box(RIB + 0.1, 0.06, 0.75), white, RIB / 2, y0 + SPANDREL + 0.0, 0.05, root);
    const yw = yWin(k);
    const yc = yw + winH / 2;
    // Artwork panes.
    const put = (x0: number, x1: number, geo: PlaneGeometry) => w.mesh(geo, w.poster, (x0 + x1) / 2, yc, -0.06, root);
    if (k <= 1) {
      // 3F / 4F: tenant posters east of the billboard, artwork behind it.
      const east = 5 * bay;
      if (k === 0) for (let i = 0; i < 5; i++) put(i * bay, (i + 1) * bay, cellPlane(bay, winH, p3[i]));
      else put(0, east, cellPlane(east, winH, kbooks));
      put(east, RIB, cellPlane(RIB - east, winH, behind));
    } else {
      const east = k === 2 ? 4 * bay : 0;
      if (k === 2) put(0, east, cellPlane(east, winH, amiami));
      const c = (yw - artBottom) / (artTop - artBottom);
      const d = (yw + winH - artBottom) / (artTop - artBottom);
      put(east, RIB, cellPlane(RIB - east, winH, pano, east / RIB, 1, c, d));
    }
    // Mullions and the head of the frame.
    for (let i = 0; i <= BAYS; i++) w.mesh(box(0.07, winH, 0.16), mullion, Math.min(RIB - 0.04, Math.max(0.04, i * bay)), yc, 0.02, root);
    w.mesh(box(RIB, 0.08, 0.18), mullion, RIB / 2, yw + winH - 0.02, 0.02, root);
  }
  // Parapet band above 10F.
  const top = KAIKAN.f3 + FLOORS * KAIKAN.floorH;
  w.mesh(box(RIB, KAIKAN.roof - top + 0.05, 0.62), white, RIB / 2, (top + KAIKAN.roof) / 2, 0.0, root);
  // White spandrel between the band and 3F, the full ribbon width.
  w.mesh(box(RIB, KAIKAN.f3 + SPANDREL - BAND.y1, 0.4), white, RIB / 2, (BAND.y1 + KAIKAN.f3 + SPANDREL) / 2, -0.12, root);
}

// --------------------------------------------------------- louvre strip

function louvreStrip(w: AkibaWorld, root: Object3D): void {
  const lib = w.lib;
  const x0 = LOUVRE_X0;
  const width = W - x0;
  const y0 = SOFFIT;
  const y1 = KAIKAN.roof + 0.4;
  // Light coves behind the louvres: warm white.
  w.mesh(new PlaneGeometry(width - 0.3, y1 - y0), lib.glow(0xfff0d8, 1.5), x0 + width / 2, (y0 + y1) / 2, -0.32, root);
  const blade = lib.glow(0xc9c4b8, 0.55);
  const pitch = 0.36;
  const geo = new BoxGeometry(width - 0.3, 0.025, 0.16);
  geo.rotateX(-0.25);
  for (let y = y0 + 0.2; y < y1 - 0.1; y += pitch) w.mesh(geo, blade, x0 + width / 2, y, -0.1, root);
  // Edge fins and a mid mullion every 1.5 m.
  const fin = lib.panel([0.95, 0.95, 0.93]);
  w.mesh(box(0.28, y1 - y0 + 0.3, 0.55), fin, x0 + 0.1, (y0 + y1) / 2, -0.05, root);
  w.mesh(box(0.28, y1 - y0 + 0.3, 0.55), fin, W - 0.12, (y0 + y1) / 2, -0.05, root);
  for (let x = x0 + 1.5; x < W - 0.6; x += 1.5) w.mesh(box(0.05, y1 - y0, 0.3), blade, x, (y0 + y1) / 2, -0.12, root);
}

// ------------------------------------------------------------ 2F band

function band(w: AkibaWorld, root: Object3D): void {
  const lib = w.lib;
  const bw = BAND.x1 - BAND.x0;
  const bh = BAND.y1 - BAND.y0;
  const zf = BAND.d;
  // Housing: yellow steel, the face covered by the LED bars.
  const housing = lib.plain(0xc9a20e, 0.5, 0.2);
  w.mesh(box(bw, bh, zf + 0.3), housing, bw / 2, BAND.y0 + bh / 2, (zf - 0.3) / 2, root);
  const bars = bandBars(32, 56);
  const tex = signTexture(bars.c);
  const sign = w.addSign(new Sign("kaikan-band", tex, new Color(1.9, 1.7, 1.25), { flipbook: { frames: 32, cols: 1, rows: 32, fps: 6 } }));
  w.mesh(frameUV(new PlaneGeometry(bw - 0.06, bh - 0.06), 1, 32), sign.material, bw / 2, BAND.y0 + bh / 2, zf + 0.005, root);
  // Channel letters standing off the face.
  let dakuten: [number, number][] = [];
  const radioH = 2.45;
  const radioW = BAND_TEXT.radio.w * bw;
  const radio = w.drawCut("kaikan-radio", 2048, Math.round((2048 * radioH) / radioW), (g, cw, ch) => {
    dakuten = paintRadioLetters(g, cw, ch).dakuten;
  });
  const sekai = w.drawCut("kaikan-sekai", 768, 300, (g, cw, ch) => paintBlueLetters(g, "世界の", cw, ch));
  const akiba = w.drawCut("kaikan-akiba", 700, 300, (g, cw, ch) => paintBlueLetters(g, "秋葉原", cw, ch));
  const yRadio = BAND.y0 + bh * 0.5;
  const zl = zf + 0.16;
  w.mesh(cellPlane(radioW, radioH, radio), w.cutoutRed, (BAND_TEXT.radio.x + BAND_TEXT.radio.w / 2) * bw, yRadio, zl, root);
  const sh = 1.05;
  w.mesh(cellPlane(BAND_TEXT.sekai.w * bw, sh, sekai), w.cutoutBright, (BAND_TEXT.sekai.x + BAND_TEXT.sekai.w / 2) * bw, yRadio + 0.15, zl, root);
  w.mesh(cellPlane(BAND_TEXT.akiba.w * bw, sh * 0.92, akiba), w.cutoutBright, (BAND_TEXT.akiba.x + BAND_TEXT.akiba.w / 2) * bw, yRadio - 0.05, zl, root);
  // Letter returns (the channel depth) as a dark strip under each word.
  const green = lib.glow(0x2ee86a, 2.6);
  const ball = new SphereGeometry(0.2, 14, 10);
  for (const [fx, fy] of dakuten) {
    const x = BAND_TEXT.radio.x * bw + fx * radioW;
    const y = yRadio + radioH / 2 - fy * radioH;
    w.mesh(ball, green, x, y, zl + 0.12, root);
  }
  // The band throws yellow light over the sidewalk and the street.
  rect(w, 0xffd76a, 2.6, bw, bh, toWorld(bw / 2, BAND.y0 + bh / 2, zf + 0.3), toWorld(bw / 2, BAND.y0 + bh / 2 - 0.6, zf + 6));
  w.update((_dt, t) => sign.update(t));
}

// ------------------------------------------------------------- screen

function screen(w: AkibaWorld, root: Object3D): void {
  const lib = w.lib;
  const fx0 = SCREEN.x0 - 0.22;
  const fx1 = SCREEN.x1 + 0.22;
  const fy0 = SCREEN.y0 - 0.22;
  const fy1 = SCREEN.y1 + 0.2;
  const frame = lib.panel([0.95, 0.95, 0.94]);
  w.mesh(box(fx1 - fx0, fy1 - fy0, 1.0), frame, (fx0 + fx1) / 2, (fy0 + fy1) / 2, 0.2, root);
  const tex = signTexture(screenFrames());
  const sign = w.addSign(new Sign("kaikan-screen", tex, new Color(1.7, 1.7, 1.7), { flipbook: { frames: 16, cols: 4, rows: 4, fps: 2 } }));
  const sw = SCREEN.x1 - SCREEN.x0;
  const sh = SCREEN.y1 - SCREEN.y0;
  w.mesh(frameUV(new PlaneGeometry(sw, sh), 4, 4), sign.material, (SCREEN.x0 + SCREEN.x1) / 2, (SCREEN.y0 + SCREEN.y1) / 2, 0.705, root);
  // Sponsor strip under the picture.
  const strip = w.draw("kaikan-screen-strip", 640, 40, (g, cw, ch) => {
    g.fillStyle = "#e9ecef";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = "#3a4048";
    g.font = `700 ${ch * 0.6}px ${LATIN}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("AKIHABARA RADIO KAIKAN VISION", cw / 2, ch * 0.55);
  });
  w.mesh(cellPlane(sw * 0.7, 0.12, strip), w.dim, (SCREEN.x0 + SCREEN.x1) / 2, fy0 + 0.1, 0.71, root);
  rect(w, 0xd8e0ff, 1.6, sw, sh, toWorld((SCREEN.x0 + SCREEN.x1) / 2, (SCREEN.y0 + SCREEN.y1) / 2, 0.8), toWorld((SCREEN.x0 + SCREEN.x1) / 2, (SCREEN.y0 + SCREEN.y1) / 2 - 0.6, 6));
  w.update((_dt, t) => sign.update(t));
}

// ----------------------------------------------------------- billboard

function billboard(w: AkibaWorld, root: Object3D): void {
  const lib = w.lib;
  const bw = BB.x1 - BB.x0;
  const bh = BB.y1 - BB.y0;
  const art = w.drawArt("kaikan-billboard", 1600, Math.round((1600 * bh) / bw), (g, cw, ch) => paintBillboard(g, cw, ch));
  const floodlit = lib.lit(w.art.texture, 0.95, "art-flood");
  w.mesh(cellPlane(bw, bh, art), floodlit, (BB.x0 + BB.x1) / 2, (BB.y0 + BB.y1) / 2, 0.66, root);
  // Tubular frame, stand-offs to the facade, and the flood lamps on the top rail.
  const steel = lib.plain(0x9aa0a6, 0.45, 0.7);
  const cx = (BB.x0 + BB.x1) / 2;
  const cy = (BB.y0 + BB.y1) / 2;
  w.mesh(box(bw + 0.16, 0.08, 0.1), steel, cx, BB.y1 + 0.04, 0.66, root);
  w.mesh(box(bw + 0.16, 0.08, 0.1), steel, cx, BB.y0 - 0.04, 0.66, root);
  w.mesh(box(0.08, bh + 0.16, 0.1), steel, BB.x0 - 0.04, cy, 0.66, root);
  w.mesh(box(0.08, bh + 0.16, 0.1), steel, BB.x1 + 0.04, cy, 0.66, root);
  for (let i = 0; i <= 6; i++) {
    const x = BB.x0 + (bw * i) / 6;
    w.mesh(box(0.06, 0.06, 0.7), steel, x, BB.y1 - 0.2, 0.3, root);
    w.mesh(box(0.06, 0.06, 0.7), steel, x, BB.y0 + 0.2, 0.3, root);
  }
  const lamp = lib.plain(0x2a2c2e, 0.5, 0.4);
  const lens = lib.glow(0xfff2dc, 4);
  for (let i = 0; i < 5; i++) {
    const x = BB.x0 + bw * (0.1 + 0.2 * i);
    w.mesh(box(0.05, 0.05, 1.1), steel, x, BB.y1 + 0.35, 1.0, root);
    w.mesh(box(0.34, 0.2, 0.22), lamp, x, BB.y1 + 0.32, 1.6, root);
    w.mesh(box(0.28, 0.02, 0.16), lens, x, BB.y1 + 0.21, 1.6, root);
  }
}

// --------------------------------------------------------- ground floor

function groundFloor(w: AkibaWorld, root: Object3D, white: ReturnType<AkibaWorld["lib"]["panel"]>, alu: ReturnType<AkibaWorld["lib"]["aluminium"]>): void {
  const lib = w.lib;
  const r = new Rng(1962);
  // Soffit with downlights, from the shopfront out to the band's face.
  const soffit = new PlaneGeometry(W, -FRONT + BAND.d);
  soffit.rotateX(Math.PI / 2);
  w.mesh(soffit, lib.panel([0.92, 0.92, 0.9]), W / 2, SOFFIT, (FRONT + BAND.d) / 2, root);
  const fascia = lib.plain(0xb08c0c, 0.5, 0.2);
  w.mesh(box(BAND.x1, BAND.y0 - SOFFIT, 0.12), fascia, BAND.x1 / 2, (BAND.y0 + SOFFIT) / 2, BAND.d - 0.06, root);
  w.mesh(box(W - BAND.x1, BAND.y0 - SOFFIT + 0.2, 0.12), white, (W + BAND.x1) / 2, (BAND.y0 + SOFFIT) / 2 + 0.1, 0.62, root);
  const disc = new CircleGeometry(0.11, 16);
  disc.rotateX(Math.PI / 2);
  const down = lib.glow(0xfff1dc, 6);
  for (let x = 1.4; x < W - 0.5; x += 1.8) for (const z of [-0.35, FRONT + 0.4]) w.mesh(disc, down, x, SOFFIT - 0.01, z, root);
  for (const x of [2.5, 7.5, 12.5, 17.5, 22.0]) {
    spot(w, 0xffe9cc, 45, 12, 0.85, 0.7, toWorld(x, SOFFIT - 0.05, -0.5), toWorld(x, 0, 2.2));
  }

  // Columns: the NE corner (white, with a portrait signage screen), between the entrance and C-labo, and the west pier.
  w.mesh(box(1.0, SOFFIT, -FRONT), white, 0.5, SOFFIT / 2, FRONT / 2, root);
  const sig = w.draw("kaikan-column-screen", 300, 760, (g, cw, ch) => {
    paintAbstract(g, cw, ch, 7, ["#0c1430", "#1a6cff", "#ffe24d", "#ffffff"]);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, "フロアガイド", cw / 2, ch * 0.1, cw * 0.86, ch * 0.06);
    for (let i = 0; i < 10; i++) {
      g.fillStyle = i % 2 ? "rgba(255,255,255,0.85)" : "rgba(255,226,77,0.95)";
      g.fillRect(cw * 0.1, ch * (0.18 + i * 0.075), cw * 0.8, ch * 0.05);
      g.fillStyle = "#0c1430";
      g.font = `800 ${ch * 0.035}px ${LATIN}`;
      g.fillText(`${10 - i}F`, cw * 0.2, ch * (0.205 + i * 0.075));
    }
  });
  w.mesh(cellPlane(0.62, 1.6, sig), w.sign, 0.5, 1.75, 0.012, root);
  w.mesh(box(0.6, SOFFIT, -FRONT), white, 13.9, SOFFIT / 2, FRONT / 2, root);
  w.mesh(box(W - 21.6, SOFFIT, -FRONT + 0.1), white, (21.6 + W) / 2, SOFFIT / 2, FRONT / 2 + 0.05, root);
  const adboard = w.draw("kaikan-adboard", 420, 640, (g, cw, ch) => {
    g.fillStyle = "#1f3f8a";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, "本物件の", cw / 2, ch * 0.3, cw * 0.8, ch * 0.12);
    fitText(g, "広告のお問合せ", cw / 2, ch * 0.45, cw * 0.86, ch * 0.1);
    g.fillStyle = "#ffe24d";
    fitText(g, "ラジオ会館", cw / 2, ch * 0.66, cw * 0.8, ch * 0.1);
  });
  w.mesh(cellPlane(1.05, 1.6, adboard), w.sign, 22.8, 1.6, 0.06, root);

  // Plinth strip and the shopfront sill.
  w.mesh(box(W, 0.1, 0.3), lib.granite([0.7, 0.7, 0.7]), W / 2, 0.05, FRONT + 0.15, root);

  // ------------------------------------------------ gift shop (The AKiBa)
  shopBay(w, root, 1.0, 8.6, "gift", r.int(1, 99));
  const gs = w.drawCut("akiba-gift", 1400, 300, (g, cw, ch) => {
    g.textBaseline = "middle";
    g.fillStyle = "#ffffff";
    g.font = `800 ${ch * 0.26}px ${LATIN}`;
    g.textAlign = "left";
    g.fillText("GIFT SHOP", cw * 0.02, ch * 0.16);
    g.fillStyle = "#ffb13a";
    g.strokeStyle = "#ff6a00";
    squeezeText(g, "The AKiBa", cw * 0.02, ch * 0.66, cw * 0.95, ch * 0.62, `"Arial Black", ${LATIN}`, HEAVY, ch * 0.05);
  });
  w.mesh(cellPlane(5.6, 1.2, gs), w.cutoutBright, 4.2, 3.6, FRONT + 0.06, root);
  // String lights along the top of the window.
  const bulb = lib.glow(0xffd29a, 7);
  const bg = new SphereGeometry(0.035, 6, 4);
  for (let x = 1.15; x < 8.5; x += 0.22) {
    const sag = 0.06 * Math.sin(((x - 1.15) / 1.1) * Math.PI) ** 2;
    w.mesh(bg, bulb, x, 4.25 - sag, FRONT + 0.12, root);
  }
  // Racks of goods on the sidewalk outside the shop.
  goodsRacks(w, root, r);

  // ------------------------------------------------ main entrance
  entrance(w, root, alu);

  // ------------------------------------------------ C-labo (card shop)
  shopBay(w, root, 14.2, 19.0, "cards", 7);
  const clabo = w.draw("clabo-sign", 760, 150, (g, cw, ch) => paintLightbox(g, cw, ch, { text: "C-labo", sub: "CARD GAME SHOP", bg: "#ffffff", fg: "#e0262c", font: LATIN, border: "#e0262c" }));
  w.mesh(cellPlane(2.6, 0.5, clabo), w.sign, 16.6, 3.95, FRONT + 0.1, root);
  // Card posters pasted inside the glass.
  for (let i = 0; i < 4; i++) {
    const p = w.draw(`clabo-poster-${i}`, 300, 420, (g, cw, ch) => {
      paintAbstract(g, cw, ch, 300 + i);
      g.fillStyle = "#fff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      fitText(g, ["買取強化", "新弾発売", "大会開催", "シングル"][i], cw / 2, ch * 0.85, cw * 0.85, ch * 0.13);
    });
    w.mesh(cellPlane(0.9, 1.3, p), w.poster, 14.75 + i * 1.15, 1.65, FRONT + 0.04, root);
  }

  // ------------------------------------------------ B1 beer hall entrance
  shopBay(w, root, 19.0, 21.6, "arcade", 3, true);
  const lion = w.draw("lion-sign", 520, 200, (g, cw, ch) => paintLightbox(g, cw, ch, { text: "銀座ライオン", sub: "B1F ビヤホール", bg: "#ffd21a", fg: "#1a1a1a" }));
  w.mesh(cellPlane(2.0, 0.78, lion), w.sign, 20.3, 3.55, FRONT + 0.6, root);
  w.mesh(box(2.06, 0.84, 0.18), lib.plain(0x222222, 0.5), 20.3, 3.55, FRONT + 0.5, root);

  // ------------------------------------------------ glass canopy under the screen
  const canopyY = 4.05;
  const cz0 = 0.0;
  const cz1 = 1.7;
  const steel = lib.plain(0x5a5e62, 0.45, 0.6);
  const glass = new PlaneGeometry(21.4 - 14.3, cz1 - cz0);
  glass.rotateX(-Math.PI / 2);
  w.mesh(glass, lib.shopGlass(), (14.3 + 21.4) / 2, canopyY, (cz0 + cz1) / 2, root);
  w.mesh(box(21.4 - 14.3, 0.1, 0.08), steel, (14.3 + 21.4) / 2, canopyY, cz1, root);
  for (const x of [14.4, 16.7, 19.0, 21.3]) w.mesh(box(0.06, 0.08, cz1 - cz0), steel, x, canopyY, (cz0 + cz1) / 2, root);

  // Shop light onto the sidewalk (the cooker bakes these as panel lights).
  rect(w, 0xffd7a8, 1.2, 7.4, 3.2, toWorld(4.8, 1.9, FRONT + 0.2), toWorld(4.8, 1.0, 8));
  rect(w, 0xeef4ff, 1.5, 4.4, 3.0, toWorld(11.0, 1.8, FRONT + 0.2), toWorld(11.0, 1.0, 8));
  rect(w, 0xf4f0ff, 1.1, 4.6, 3.0, toWorld(16.6, 1.8, FRONT + 0.2), toWorld(16.6, 1.0, 8));
}

/** Glazed bay with a lit interior (card, side returns, floor, ceiling). */
function shopBay(w: AkibaWorld, root: Object3D, x0: number, x1: number, kind: "gift" | "lobby" | "cards" | "arcade", seed: number, stairs = false): void {
  const lib = w.lib;
  const bw = x1 - x0;
  const depth = stairs ? 3.2 : 4.4;
  const zb = FRONT - depth;
  const h = SOFFIT - 0.15;
  const inside = w.draw(`interior-${kind}-${seed}`, Math.min(1024, Math.round(bw * 110)), 400, (g, cw, ch) => paintInterior(g, cw, ch, stairs ? "arcade" : kind, seed));
  w.mesh(cellPlane(bw, h, inside), lib.lit(w.atlas.texture, stairs ? 0.7 : 1.25, "atlas-interior", { fog: false }), (x0 + x1) / 2, h / 2, zb, root);
  const glowCol = kind === "gift" ? 0xffe2b8 : kind === "lobby" ? 0xf2f6ff : 0xf0f2ff;
  for (const sx of [x0 + 0.02, x1 - 0.02]) {
    const side = new PlaneGeometry(depth, h);
    side.rotateY(sx < (x0 + x1) / 2 ? Math.PI / 2 : -Math.PI / 2);
    w.mesh(side, lib.glow(glowCol, 0.45, false), sx, h / 2, FRONT - depth / 2, root);
  }
  const floor = new PlaneGeometry(bw, depth);
  floor.rotateX(-Math.PI / 2);
  w.mesh(floor, lib.glow(stairs ? 0x4a3020 : 0x8a8580, 0.55, false), (x0 + x1) / 2, 0.005, FRONT - depth / 2, root);
  const ceil = new PlaneGeometry(bw, depth);
  ceil.rotateX(Math.PI / 2);
  w.mesh(ceil, lib.glow(glowCol, 0.9, false), (x0 + x1) / 2, h, FRONT - depth / 2, root);
  if (!stairs) {
    const glass = new PlaneGeometry(bw - 0.1, SOFFIT - 0.2);
    w.mesh(glass, lib.shopGlass(), (x0 + x1) / 2, (SOFFIT - 0.2) / 2 + 0.05, FRONT, root);
    const frame = lib.plain(0xc8ccd0, 0.35, 0.8);
    const n = Math.max(1, Math.round(bw / 1.9));
    for (let i = 0; i <= n; i++) w.mesh(box(0.06, SOFFIT, 0.12), frame, x0 + (bw * i) / n, SOFFIT / 2, FRONT + 0.02, root);
    w.mesh(box(bw, 0.06, 0.12), frame, (x0 + x1) / 2, 0.03, FRONT + 0.02, root);
  }
}

function entrance(w: AkibaWorld, root: Object3D, alu: ReturnType<AkibaWorld["lib"]["aluminium"]>): void {
  const lib = w.lib;
  const { x0: wx0, x1: wx1 } = KAIKAN.entrance;
  const x0 = -wx1;
  const x1 = -wx0;
  const bw = x1 - x0;
  shopBay(w, root, x0, x1, "lobby", 4);
  // Two pairs of sliding doors with stainless frames, a mat in front.
  const frame = alu;
  for (let i = 0; i <= 4; i++) w.mesh(box(0.07, 3.0, 0.1), frame, x0 + (bw * i) / 4, 1.5, FRONT + 0.03, root);
  w.mesh(box(bw, 0.12, 0.12), frame, (x0 + x1) / 2, 3.0, FRONT + 0.03, root);
  const mat = new PlaneGeometry(bw - 0.6, 1.2);
  mat.rotateX(-Math.PI / 2);
  w.mesh(mat, lib.plain(0x2a2c30, 0.9), (x0 + x1) / 2, 0.006, FRONT + 0.8, root);
  // Sign panel above the doors: MIZUHO ATM and the building's name.
  w.mesh(box(bw + 0.2, 1.3, 0.2), lib.plain(0x5e6268, 0.5), (x0 + x1) / 2, 3.75, FRONT + 0.1, root);
  const name = w.draw("kaikan-name", 1100, 230, (g, cw, ch) => {
    g.fillStyle = "#5e6268";
    g.fillRect(0, 0, cw, ch);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.shadowColor = "rgba(255,120,120,0.9)";
    g.shadowBlur = ch * 0.06;
    g.fillStyle = "#fff4f2";
    fitText(g, "AKIHABARA", cw / 2, ch * 0.3, cw * 0.86, ch * 0.34, LATIN, "800 ");
    fitText(g, "RADIOKAIKAN", cw / 2, ch * 0.72, cw * 0.92, ch * 0.34, LATIN, "800 ");
  });
  w.mesh(cellPlane(3.1, 0.66, name), w.sign, x0 + 1.25 + 3.1 / 2 - 0.05, 3.72, FRONT + 0.205, root);
  const atm = w.draw("mizuho-atm", 300, 300, (g, cw, ch) => {
    g.fillStyle = "#1c2f8c";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, "MIZUHO", cw / 2, ch * 0.32, cw * 0.8, ch * 0.2, LATIN, "800 ");
    g.fillStyle = "#cfd8ff";
    fitText(g, "みずほ", cw / 2, ch * 0.58, cw * 0.6, ch * 0.13);
    fitText(g, "ATMコーナー", cw / 2, ch * 0.78, cw * 0.8, ch * 0.12);
  });
  w.mesh(cellPlane(0.95, 0.95, atm), w.sign, x0 + 0.62, 3.72, FRONT + 0.205, root);
}

/** Wheeled racks of souvenirs on the sidewalk in front of the gift shop. */
function goodsRacks(w: AkibaWorld, root: Object3D, r: Rng): void {
  const lib = w.lib;
  const metal = lib.plain(0xbfc3c6, 0.35, 0.8);
  const goods = w.draw("gift-goods", 512, 512, (g, cw, ch) => {
    g.fillStyle = "#f6efe2";
    g.fillRect(0, 0, cw, ch);
    const rr = new Rng(5);
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 8; x++) {
        g.fillStyle = rr.pick(["#ff4f4f", "#ffd23f", "#3fa7ff", "#ff8ad8", "#ffffff", "#5ad87a", "#ff9a2e", "#7a5cff"]);
        g.fillRect(x * (cw / 8) + 4, y * (ch / 6) + 6, cw / 8 - 8, ch / 6 - 14);
        g.fillStyle = "rgba(0,0,0,0.25)";
        g.fillRect(x * (cw / 8) + 4, y * (ch / 6) + ch / 6 - 12, cw / 8 - 8, 4);
      }
  });
  const goodsMat = lib.printed(w.atlas.texture, "atlas-printed");
  for (const x of [2.2, 4.1, 6.4]) {
    const g = w.group(x, 0, FRONT + 1.1 + r.range(-0.1, 0.1), r.range(-0.08, 0.08), root);
    w.mesh(box(1.2, 0.04, 0.5), metal, 0, 0.12, 0, g);
    for (const sx of [-0.58, 0.58]) w.mesh(box(0.03, 1.55, 0.03), metal, sx, 0.9, 0.22, g);
    for (const sx of [-0.58, 0.58]) w.mesh(box(0.03, 1.55, 0.03), metal, sx, 0.9, -0.22, g);
    for (let k = 0; k < 4; k++) w.mesh(box(1.18, 0.02, 0.46), metal, 0, 0.45 + k * 0.33, 0, g);
    const face = cellPlane(1.12, 1.3, goods);
    w.mesh(face, goodsMat, 0, 0.98, 0.24, g);
    const back = cellPlane(1.12, 1.3, goods, 0.5, 1);
    back.rotateY(Math.PI);
    w.mesh(back, goodsMat, 0, 0.98, -0.24, g);
    for (const sx of [-0.5, 0.5]) w.mesh(new CylinderGeometry(0.04, 0.04, 0.03, 8), lib.plain(0x111111, 0.7), sx, 0.04, 0, g);
  }
}

