import { CanvasTexture, SRGBColorSpace, type Texture } from "three";
import { Rng } from "../../../core/random";
import { canvas, JP_SANS, LATIN, roundRect, toTexture, type Ctx } from "../../shared/canvas";

/**
 * Canvas art for the place's ground and buildings: the crossing deck, spike
 * mats, tactile paving, road markings and the station name board, drawn
 * into the shared atlas by key, plus
 * three textures of their own: the Enoden livery, the hillside facades and
 * the leaf cards. The crossing equipment, signs and boards paint into the
 * equipment atlas (gfx/equip.ts, gfx/signs.ts). Lettering is generic or the
 * real wording of public signs; no logos are traced.
 */

export const ART = {
  /** Enoden green (sunlit #297a6e in the photos), the cream band and the light roof-line green. */
  green: "#1f6b5c",
  greenDark: "#16483f",
  cream: "#efe4cf",
  roofGreen: "#4fa594",
  yellow: "#f2c200",
  black: "#151515",
};

// ------------------------------------------------------------ crossing

/** Anti-slip crossing deck: ochre panels with joints, the rails' flangeways and the green pedestrian strip on the west end. */
export function crossingDeck(g: Ctx, cw: number, ch: number, stripFrac: number, rails: number[]): void {
  const r = new Rng(41);
  // Green pedestrian strip (west = left end).
  const sx = cw * stripFrac;
  g.fillStyle = "#4f8a52";
  g.fillRect(0, 0, sx, ch);
  // Ochre panels, slightly different batches.
  const panels = 9;
  for (let i = 0; i < panels; i++) {
    const x0 = sx + ((cw - sx) * i) / panels;
    const w = (cw - sx) / panels;
    const tone = r.range(-14, 14);
    g.fillStyle = `rgb(${206 + tone}, ${146 + tone * 0.7}, ${62 + tone * 0.4})`;
    g.fillRect(x0, 0, w, ch);
    // Grit speckle.
    for (let k = 0; k < 900; k++) {
      g.fillStyle = r.chance(0.5) ? "rgba(255,230,190,0.25)" : "rgba(80,50,20,0.25)";
      g.fillRect(x0 + r.next() * w, r.next() * ch, 1.5, 1.5);
    }
    // Tyre wear in the lanes.
    g.fillStyle = "rgba(60,50,40,0.14)";
    g.fillRect(x0, ch * 0.05, w, ch * 0.9);
  }
  // Panel joints along the road and the flangeway grooves along the track.
  g.fillStyle = "rgba(40,30,20,0.85)";
  for (let i = 0; i <= panels; i++) g.fillRect(sx + ((cw - sx) * i) / panels - 1.5, 0, 3, ch);
  for (const v of rails) {
    g.fillStyle = "rgba(25,20,15,0.95)";
    g.fillRect(0, v * ch - 5, cw, 10);
  }
  // Worn white edge lines at both ends of the deck.
  g.fillStyle = "rgba(230,228,220,0.85)";
  g.fillRect(sx, 0, cw - sx, ch * 0.025);
  g.fillRect(sx, ch * 0.975, cw - sx, ch * 0.025);
}

/** Yellow anti-trespass spike mat (the cones drawn lit from the south-west). */
export function spikeMat(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#c79a10";
  g.fillRect(0, 0, cw, ch);
  const n = 6;
  const m = Math.round((n * ch) / cw);
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5 + (j % 2) * 0.5) * cw) / n;
      const y = ((j + 0.5) * ch) / m;
      const rr = cw / n / 2.3;
      g.fillStyle = "rgba(60,40,0,0.45)";
      g.beginPath();
      g.ellipse(x + rr * 0.5, y + rr * 0.2, rr * 1.1, rr * 0.7, 0, 0, Math.PI * 2);
      g.fill();
      const grd = g.createRadialGradient(x - rr * 0.3, y - rr * 0.3, 1, x, y, rr);
      grd.addColorStop(0, "#fff28a");
      grd.addColorStop(0.5, "#f2c51a");
      grd.addColorStop(1, "#9a7408");
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x, y, rr, 0, Math.PI * 2);
      g.fill();
    }
}

/** Tactile paving (点字ブロック): yellow tiles with dots. */
export function tactile(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#e4b318";
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = "rgba(120,80,0,0.4)";
  for (let i = 0; i <= 4; i++) {
    g.fillRect((i * cw) / 4 - 1, 0, 2, ch);
    g.fillRect(0, (i * ch) / 4 - 1, cw, 2);
  }
  g.fillStyle = "rgba(255,240,170,0.7)";
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    g.beginPath();
    g.arc(((x + 0.5) * cw) / 20, ((y + 0.5) * ch) / 20, cw / 70, 0, Math.PI * 2);
    g.fill();
  }
}

/** Station name board (teal, white lettering). */
export function stationBoard(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#e8eef0";
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = "#1f7d8c";
  g.fillRect(cw * 0.02, ch * 0.04, cw * 0.96, ch * 0.92);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${ch * 0.16}px ${JP_SANS}`;
  g.fillText("江ノ島電鉄", cw / 2, ch * 0.18);
  g.font = `900 ${ch * 0.34}px ${JP_SANS}`;
  g.fillText("鎌倉高校前駅", cw / 2, ch * 0.5, cw * 0.92);
  g.font = `700 ${ch * 0.13}px ${LATIN}`;
  g.fillText("KAMAKURAKŌKŌMAE STATION", cw / 2, ch * 0.8, cw * 0.9);
}

/** Road marking cell: worn paint (solid with a little asphalt showing through). */
export function marking(color: string, seed: number) {
  return (g: Ctx, cw: number, ch: number) => {
    const r = new Rng(seed);
    g.fillStyle = color;
    g.fillRect(0, 0, cw, ch);
    for (let i = 0; i < (cw * ch) / 60; i++) {
      g.fillStyle = r.chance(0.6) ? "rgba(60,58,54,0.35)" : "rgba(255,255,255,0.15)";
      g.fillRect(r.next() * cw, r.next() * ch, 2, 2);
    }
  };
}

/** Sail (alpha outside): a white triangle with a faint seam. */
export function sail(g: Ctx, cw: number, ch: number): void {
  g.clearRect(0, 0, cw, ch);
  g.fillStyle = "#f6f6f2";
  g.beginPath();
  g.moveTo(cw * 0.1, 0);
  g.lineTo(cw * 0.95, ch * 0.92);
  g.lineTo(cw * 0.1, ch * 0.92);
  g.closePath();
  g.fill();
  g.fillStyle = "#30353a";
  g.fillRect(0, ch * 0.92, cw, ch * 0.08);
}

/** Japanese number plate (white private plate, green lettering). */
export function numberPlate(g: Ctx, cw: number, ch: number, seed: number): void {
  const r = new Rng(seed);
  g.fillStyle = "#f4f4ee";
  roundRect(g, 0, 0, cw, ch, ch * 0.1);
  g.fill();
  g.strokeStyle = "#1c5a34";
  g.lineWidth = ch * 0.04;
  roundRect(g, ch * 0.05, ch * 0.05, cw - ch * 0.1, ch * 0.9, ch * 0.08);
  g.stroke();
  g.fillStyle = "#1c5a34";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${ch * 0.22}px ${JP_SANS}`;
  g.fillText(`${r.pick(["湘南", "横浜", "相模", "品川"])} ${r.int(300, 599)}`, cw / 2, ch * 0.27);
  g.font = `800 ${ch * 0.48}px ${LATIN}`;
  g.fillText(`${r.int(10, 99)}-${r.int(10, 99)}`, cw * 0.56, ch * 0.66);
}

// ----------------------------------------------------- separate textures

/**
 * Enoden 500-type livery for one car side and the cab front, laid out in a
 * 1024 × 512 canvas (u along the car, v up the body):
 *   rows 0–255:   car side, 12.5 m: green skirt, cream window band, green upper band, grey roof edge
 *   rows 256–511: left: cab front (2.5 m wide); right: car end (gangway end)
 * Windows are drawn dark with interior hints, as daylight shows them.
 */
export function enodenLivery(): Texture {
  const { c, g } = canvas(1024, 512);
  const r = new Rng(500);
  // ---- side (0..1024 × 0..256), body height 2.7 m from 0.95 to 3.65 m above the rail.
  const H = 256;
  const yOf = (m: number) => H - ((m - 0.95) / 2.7) * H;
  g.fillStyle = ART.green;
  g.fillRect(0, 0, 1024, H);
  g.fillStyle = ART.cream;
  g.fillRect(0, yOf(3.0), 1024, yOf(1.85) - yOf(3.0));
  // Light green roof-line band.
  g.fillStyle = ART.roofGreen;
  g.fillRect(0, yOf(3.62), 1024, yOf(3.18) - yOf(3.62));
  g.fillStyle = ART.green;
  g.fillRect(0, yOf(3.18), 1024, yOf(3.0) - yOf(3.18));
  // Gold pinstripe under the windows.
  g.fillStyle = "#c9a85a";
  g.fillRect(0, yOf(1.8), 1024, 2);
  const px = (m: number) => (m / 12.5) * 1024;
  // Doors (two per side) and windows.
  const doors = [3.0, 8.6];
  for (const d of doors) {
    g.fillStyle = "#e9dec7";
    g.fillRect(px(d), yOf(3.05), px(1.1), yOf(1.0) - yOf(3.05));
    g.strokeStyle = "#7a7464";
    g.lineWidth = 2;
    g.strokeRect(px(d), yOf(3.05), px(1.1), yOf(1.0) - yOf(3.05));
    g.beginPath();
    g.moveTo(px(d + 0.55), yOf(3.05));
    g.lineTo(px(d + 0.55), yOf(1.0));
    g.stroke();
    for (const k of [0.08, 0.6]) {
      g.fillStyle = "#1a2226";
      g.fillRect(px(d + k), yOf(2.85), px(0.42), yOf(1.95) - yOf(2.85));
    }
  }
  const windows = [0.6, 1.75, 4.5, 5.65, 6.8, 10.1, 11.2];
  for (const w of windows) {
    const x = px(w);
    const ww = px(0.95);
    const grd = g.createLinearGradient(0, yOf(2.85), 0, yOf(1.95));
    grd.addColorStop(0, "#2b3a42");
    grd.addColorStop(0.5, "#1a2329");
    grd.addColorStop(1, "#11171b");
    g.fillStyle = grd;
    roundRect(g, x, yOf(2.88), ww, yOf(1.95) - yOf(2.88), 5);
    g.fill();
    // Interior hints: seat backs, standing figures, hanging straps.
    g.fillStyle = "rgba(120,110,95,0.35)";
    g.fillRect(x + 3, yOf(2.15), ww - 6, yOf(1.95) - yOf(2.15));
    if (r.chance(0.6)) {
      g.fillStyle = `rgba(${r.int(30, 90)},${r.int(30, 80)},${r.int(30, 80)},0.7)`;
      g.fillRect(x + ww * r.range(0.2, 0.6), yOf(2.6), ww * 0.18, yOf(1.95) - yOf(2.6));
    }
    g.fillStyle = "rgba(200,220,235,0.18)";
    g.fillRect(x + 2, yOf(2.86), ww - 4, 6);
  }
  g.fillStyle = "rgba(255,255,255,0.08)";
  g.fillRect(0, yOf(3.65), 1024, 3);
  // ---- cab front (0..512 × 256..512), 2.5 m wide, 0.6 .. 3.7 m high.
  const fy = (m: number) => 512 - ((m - 0.6) / 3.1) * 256;
  const fx = (m: number) => (m / 2.5) * 512;
  g.fillStyle = ART.green;
  g.fillRect(0, 256, 512, 256);
  g.fillStyle = "#c9cbcc";
  g.fillRect(0, fy(1.05), 512, fy(0.6) - fy(1.05));
  g.fillStyle = ART.cream;
  g.fillRect(0, fy(3.25), 512, fy(1.95) - fy(3.25));
  g.fillStyle = ART.roofGreen;
  g.fillRect(0, fy(3.68), 512, fy(3.32) - fy(3.68));
  // Large windscreen with the destination display.
  const grd = g.createLinearGradient(0, fy(3.15), 0, fy(2.05));
  grd.addColorStop(0, "#3a4b55");
  grd.addColorStop(1, "#141b20");
  g.fillStyle = grd;
  roundRect(g, fx(0.18), fy(3.15), fx(2.14), fy(2.08) - fy(3.15), 14);
  g.fill();
  g.fillStyle = "#101010";
  g.fillRect(fx(0.8), fy(3.12), fx(0.9), fy(2.92) - fy(3.12));
  g.fillStyle = "#ff9a3a";
  g.font = `800 ${(fy(2.92) - fy(3.12)) * 0.75}px ${JP_SANS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("鎌倉", fx(1.25), (fy(3.12) + fy(2.92)) / 2);
  // Headlights, tail lights, car number.
  for (const s of [0.45, 2.05]) {
    g.fillStyle = "#e8e4d6";
    g.beginPath();
    g.arc(fx(s), fy(1.45), fx(0.1), 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#5a1010";
    g.beginPath();
    g.arc(fx(s + (s < 1 ? -0.2 : 0.2)), fy(1.42), fx(0.05), 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#f4efe4";
  g.font = `800 ${fx(0.28)}px ${LATIN}`;
  g.fillText("502", fx(1.9), fy(1.75));
  g.fillStyle = "#c9a85a";
  g.fillRect(0, fy(1.88), 512, 2);
  // ---- car end (512..1024 × 256..512): gangway bellows and the end wall.
  g.fillStyle = ART.green;
  g.fillRect(512, 256, 512, 256);
  g.fillStyle = ART.cream;
  g.fillRect(512, fy(3.25), 512, fy(1.95) - fy(3.25));
  g.fillStyle = "#26282a";
  g.fillRect(512 + fx(0.6), fy(3.3), fx(1.3), fy(0.95) - fy(3.3));
  // Flat patches for the roof, the underframe and the pantograph (u 0.94–1, v 0.40–0.46 and 0.34–0.40).
  g.fillStyle = "#5b6064";
  g.fillRect(964, 276, 60, 30);
  g.fillStyle = "#1c1d1f";
  g.fillRect(964, 306, 60, 30);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  t.name = "enoden-livery";
  return t;
}

/**
 * Hillside facades in one 512 × 1024 texture (v up, three.js convention):
 *   v 0 – 1/32       plinth: board-marked concrete
 *   v 1/32 – 1/16    roof: dark grey sheet with seams along u
 *   v 1/16 – 1       three styles × five floors of 2.9 m (modern villa with
 *                    picture windows and glass balustrades, house with shutter
 *                    boxes, apartments with balcony slabs), four 2.6 m bays
 *                    per repeat; walls are near white and tinted per house
 * A wall maps u = metres / 10.4 and v = (1 + 5 · style + floors above its base) / 16.
 */
export const FACADE = { bay: 10.4, floor: 2.9, plinth: 1 / 64, roof: 3 / 64, styles: 3 };

export function facadeTexture(): Texture {
  const { c, g } = canvas(512, 1024);
  const r = new Rng(77);
  const FH = 64;
  const glassGrad = (y0: number, h: number) => {
    const grd = g.createLinearGradient(0, y0, 0, y0 + h);
    grd.addColorStop(0, "#5d717c");
    grd.addColorStop(0.45, "#2c3a42");
    grd.addColorStop(1, "#1b2328");
    return grd;
  };
  for (let k = 0; k < 3; k++) {
    for (let f = 0; f < 5; f++) {
      const F = k * 5 + f;
      const y1 = 960 - F * FH;
      const y0 = y1 - FH;
      // Wall colours are near white: each house tints them through its vertex colour.
      g.fillStyle = k === 2 ? "#dcdedf" : "#f2f0ea";
      g.fillRect(0, y0, 512, FH);
      if (k === 0) {
        // Modern villa: a wide picture window per bay, slim mullions, glass balustrade on upper floors.
        for (let i = 0; i < 4; i++) {
          const x0 = i * 128;
          const wide = r.chance(0.7);
          const ww = wide ? 112 : 56;
          const wx = x0 + (128 - ww) / 2;
          const wy = y0 + FH * 0.16;
          const wh = FH * 0.66;
          g.fillStyle = "#b9bdbf";
          g.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
          g.fillStyle = glassGrad(wy, wh);
          g.fillRect(wx, wy, ww, wh);
          g.fillStyle = "#c9cdcf";
          for (let m = 1; m < (wide ? 3 : 2); m++) g.fillRect(wx + (ww * m) / (wide ? 3 : 2) - 1, wy, 2, wh);
          if (f > 0) {
            g.fillStyle = "rgba(170,196,192,0.55)";
            g.fillRect(wx - 4, wy + wh * 0.5, ww + 8, wh * 0.5);
            g.fillStyle = "#d5d9da";
            g.fillRect(wx - 4, wy + wh * 0.5, ww + 8, 2);
          }
        }
        g.fillStyle = "rgba(0,0,0,0.12)";
        g.fillRect(0, y1 - 5, 512, 5);
      } else if (k === 1) {
        // House: smaller windows with shutter boxes, the odd railing.
        for (let i = 0; i < 4; i++) {
          if (r.chance(0.2)) continue;
          const x0 = i * 128;
          const ww = r.chance(0.5) ? 56 : 76;
          const wx = x0 + (128 - ww) / 2;
          const wy = y0 + FH * 0.28;
          const wh = FH * 0.44;
          g.fillStyle = "#8a8f90";
          g.fillRect(wx - 3, wy - 9, ww + 6, 8);
          g.fillStyle = "#a9adae";
          g.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
          g.fillStyle = glassGrad(wy, wh);
          g.fillRect(wx, wy, ww, wh);
          g.fillStyle = "rgba(235,233,226,0.7)";
          if (r.chance(0.5)) g.fillRect(wx + ww * 0.5, wy, ww * 0.5, wh);
          if (r.chance(0.3)) {
            g.fillStyle = "#6f7477";
            for (let b = 0; b < ww + 8; b += 6) g.fillRect(wx - 4 + b, wy + wh * 0.55, 2, wh * 0.45);
            g.fillRect(wx - 4, wy + wh * 0.55, ww + 8, 2);
          }
        }
      } else {
        // Apartments: a balcony slab per floor, railing panels, doors and windows behind.
        for (let yy = y0; yy < y1; yy += 6) {
          g.fillStyle = "rgba(0,0,0,0.04)";
          g.fillRect(0, yy, 512, 1);
        }
        for (let i = 0; i < 4; i++) {
          const x0 = i * 128;
          g.fillStyle = glassGrad(y0 + FH * 0.18, FH * 0.6);
          g.fillRect(x0 + 14, y0 + FH * 0.18, 100, FH * 0.6);
          g.fillStyle = "#9ea3a5";
          g.fillRect(x0 + 62, y0 + FH * 0.18, 3, FH * 0.6);
          if (f > 0) {
            g.fillStyle = r.chance(0.5) ? "#c8cccd" : "#b8bdbf";
            g.fillRect(x0 + 4, y0 + FH * 0.52, 120, FH * 0.42);
            if (r.chance(0.3)) {
              g.fillStyle = ["#d9d4c8", "#9fb6c9", "#e6e0d0"][i % 3];
              g.fillRect(x0 + 20 + r.range(0, 40), y0 + FH * 0.44, 30, FH * 0.2);
            }
          }
        }
        g.fillStyle = "#aeb2b3";
        g.fillRect(0, y1 - 6, 512, 6);
      }
    }
  }
  // Roof band (rows 960–991): light sheet (tinted per house) with seams along u.
  g.fillStyle = "#c4c6c8";
  g.fillRect(0, 960, 512, 32);
  g.fillStyle = "rgba(0,0,0,0.18)";
  for (let x = 0; x < 512; x += 16) g.fillRect(x, 960, 2, 32);
  // Plinth band (rows 992–1023): grey concrete with board marks.
  g.fillStyle = "#8f8d87";
  g.fillRect(0, 992, 512, 32);
  g.fillStyle = "rgba(0,0,0,0.08)";
  for (let x = 0; x < 512; x += 40) g.fillRect(x, 992, 2, 32);
  const t = toTexture(c, true);
  t.name = "facades";
  return t;
}

/** Leaf atlas for cut-out foliage: 2 × 2 cells (broadleaf shrub, palm frond, cycad frond, grass tuft). */
export function leafTexture(): Texture {
  const { c, g } = canvas(512, 512);
  const r = new Rng(9);
  g.clearRect(0, 0, 512, 512);
  // Cell 0 (top-left): broadleaf shrub, a dome of small leaves, darker inside.
  for (let i = 0; i < 900; i++) {
    const a = r.range(0, Math.PI * 2);
    const d = Math.sqrt(r.next()) * 112;
    const x = 128 + Math.cos(a) * d;
    const y = 140 + Math.sin(a) * d * 0.85;
    if (y < 18) continue;
    const s = r.range(3.5, 7.5);
    const lit = 0.55 + 0.45 * (1 - d / 112) * 0.3 + (y < 140 ? 0.25 : 0) + r.range(-0.15, 0.15);
    g.fillStyle = `rgb(${Math.round(r.int(26, 44) * lit)}, ${Math.round(r.int(62, 92) * lit)}, ${Math.round(r.int(18, 34) * lit)})`;
    g.beginPath();
    g.ellipse(x, y, s, s * 0.55, r.range(0, Math.PI), 0, Math.PI * 2);
    g.fill();
  }
  // Cell 1 (top-right): palm frond (fan) and cell 2 (bottom-left): cycad frond.
  const frond = (ox: number, oy: number, fan: boolean) => {
    g.save();
    g.translate(ox, oy);
    g.strokeStyle = "#5a6a2a";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(128, 250);
    g.lineTo(128, fan ? 120 : 10);
    g.stroke();
    const n = fan ? 26 : 38;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      if (fan) {
        const a = -Math.PI * 0.9 + t * Math.PI * 0.8;
        g.strokeStyle = `rgb(${r.int(40, 70)}, ${r.int(90, 120)}, ${r.int(30, 50)})`;
        g.lineWidth = 6;
        g.beginPath();
        g.moveTo(128, 120);
        g.lineTo(128 + Math.cos(a) * 118, 120 + Math.sin(a) * 110 + 60);
        g.stroke();
      } else {
        const y = 20 + t * 220;
        const len = 100 * Math.sin(Math.PI * (0.15 + 0.85 * t));
        g.strokeStyle = `rgb(${r.int(20, 45)}, ${r.int(60, 90)}, ${r.int(20, 40)})`;
        g.lineWidth = 4;
        for (const s of [-1, 1]) {
          g.beginPath();
          g.moveTo(128, y);
          g.lineTo(128 + s * len, y - 18);
          g.stroke();
        }
      }
    }
    g.restore();
  };
  frond(256, 0, true);
  frond(0, 256, false);
  // Cell 3 (bottom-right): grass tufts.
  for (let i = 0; i < 160; i++) {
    const x = 256 + r.range(10, 246);
    const h = r.range(40, 200);
    g.strokeStyle = `rgb(${r.int(60, 110)}, ${r.int(90, 130)}, ${r.int(30, 60)})`;
    g.lineWidth = r.range(2, 4);
    g.beginPath();
    g.moveTo(x, 510);
    g.quadraticCurveTo(x + r.range(-20, 20), 510 - h * 0.6, x + r.range(-40, 40), 510 - h);
    g.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  t.name = "leaves";
  return t;
}
