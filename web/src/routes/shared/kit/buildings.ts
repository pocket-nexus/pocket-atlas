import { Color, MeshBasicMaterial } from "three";
import { extrudeEdges } from "../../../places/shared/atlas";
import { canvas, JP_SANS, toTexture, type Ctx } from "../../../places/shared/canvas";
import { ATLAS, CELLS, LIT_ATLAS, LIT_CELLS, LIT_STRIPS, PAD, ROWS, STRIPS, BAND, type Cell, type Strip } from "./buildings-layout";
import type { Kit } from "./materials";

/**
 * The kit materials of `gen/buildings.ts`:
 *
 *   building       lit atlas: siding, roof metal, concrete, windows, doors,
 *                  shutters; near white where the vertices tint it
 *   building-lit   unlit atlas: lit windows, a shop front, lit signs
 *
 * Everything is drawn here on a canvas; `buildings-layout.ts` says where.
 */
export function addBuildingMaterials(kit: Kit): void {
  const lit = toTexture(paintAtlas(), true);
  lit.name = "building";
  kit.standard("building", null, { map: lit, vertexColors: true, roughness: 0.78, metalness: 0 });
  const glow = toTexture(paintLitAtlas(), true);
  glow.name = "building-lit";
  // Above 1 the brightest panes bloom a little in the grey afternoon.
  kit.add("building-lit", new MeshBasicMaterial({ map: glow, vertexColors: true, color: new Color(1.5, 1.5, 1.5) }));
}

/** Small deterministic generator for the painter's grain and streaks. */
function rng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Per-pixel value grain over a rectangle. */
function grain(g: Ctx, x: number, y: number, w: number, h: number, amount: number, seed: number): void {
  const img = g.getImageData(x, y, w, h);
  const r = rng(seed);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = 1 + (r() - 0.5) * amount;
    d[i] = Math.min(255, d[i] * k);
    d[i + 1] = Math.min(255, d[i + 1] * k);
    d[i + 2] = Math.min(255, d[i + 2] * k);
  }
  g.putImageData(img, x, y);
}

/** Faint vertical run-off streaks; drawn wrapped so a strip still tiles in u. */
function streaks(g: Ctx, s: Strip, count: number, alpha: number, seed: number, size = ATLAS): void {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = r() * size;
    const w = 2 + r() * 14;
    const top = s.y + r() * s.h * 0.5;
    const grad = g.createLinearGradient(0, top, 0, s.y + s.h);
    const dark = r() < 0.7;
    grad.addColorStop(0, dark ? `rgba(60,58,54,0)` : `rgba(255,255,255,0)`);
    grad.addColorStop(1, dark ? `rgba(60,58,54,${alpha * (0.4 + r() * 0.6)})` : `rgba(255,255,255,${alpha})`);
    g.fillStyle = grad;
    for (const o of [-size, 0, size]) g.fillRect(x + o, top, w, s.y + s.h - top);
  }
}

function finishStrip(g: Ctx, s: Strip, size = ATLAS): void {
  extrudeEdges(g, 0, s.y, size, s.h, PAD);
}

function finishCell(g: Ctx, c: Cell): void {
  extrudeEdges(g, c.x, c.y, c.w, c.h, PAD);
}

/** Dark glass under an overcast sky: paler toward the top, a soft diagonal sheen. */
function glass(g: Ctx, x: number, y: number, w: number, h: number, seed: number, curtain = 0): void {
  const grad = g.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, "#66737d");
  grad.addColorStop(0.35, "#3c474f");
  grad.addColorStop(1, "#242a2f");
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);
  const r = rng(seed);
  if (curtain > 0) {
    // Lace curtain drawn across part of the pane.
    const cw = w * (0.45 + r() * 0.55);
    const cx = r() < 0.5 ? x : x + w - cw;
    g.fillStyle = `rgba(214,212,204,${curtain})`;
    g.fillRect(cx, y, cw, h);
    g.fillStyle = `rgba(120,120,116,${curtain * 0.5})`;
    for (let k = cx + 3; k < cx + cw; k += 5) g.fillRect(k, y, 1, h);
  }
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = "rgba(190,205,216,0.16)";
  g.beginPath();
  const sx = x + w * (0.15 + r() * 0.4);
  g.moveTo(sx, y);
  g.lineTo(sx + w * 0.22, y);
  g.lineTo(sx + w * 0.22 - h * 0.5, y + h);
  g.lineTo(sx - h * 0.5, y + h);
  g.fill();
  g.restore();
}

/** A sliding window: outer frame, panes, meeting stiles. */
function window_(g: Ctx, c: Cell, frame: string, panes: number, seed: number, curtain: number, transom = false): void {
  g.fillStyle = frame;
  g.fillRect(c.x, c.y, c.w, c.h);
  const f = 4;
  const pw = (c.w - f * 2 - (panes - 1) * 3) / panes;
  for (let i = 0; i < panes; i++) glass(g, c.x + f + i * (pw + 3), c.y + f, pw, c.h - f * 2, seed + i * 7, curtain);
  if (transom) {
    g.fillStyle = frame;
    g.fillRect(c.x, c.y + Math.round(c.h * 0.3), c.w, 3);
  }
  // The sill's lit top edge and the head's shadow.
  g.fillStyle = "rgba(255,255,255,0.25)";
  g.fillRect(c.x, c.y + c.h - 2, c.w, 1);
  g.fillStyle = "rgba(0,0,0,0.35)";
  g.fillRect(c.x + f, c.y + f, c.w - f * 2, 2);
  finishCell(g, c);
}

function slats(g: Ctx, c: Cell, base: string, pitch: number): void {
  g.fillStyle = base;
  g.fillRect(c.x, c.y, c.w, c.h);
  for (let y = c.y + 6; y < c.y + c.h - 6; y += pitch) {
    g.fillStyle = "rgba(255,255,255,0.35)";
    g.fillRect(c.x + 5, y, c.w - 10, 1);
    g.fillStyle = "rgba(0,0,0,0.22)";
    g.fillRect(c.x + 5, y + pitch - 2, c.w - 10, 2);
  }
  // Guide rails, the box above and the bottom bar.
  g.fillStyle = "rgba(70,72,76,0.9)";
  g.fillRect(c.x, c.y, 5, c.h);
  g.fillRect(c.x + c.w - 5, c.y, 5, c.h);
  g.fillStyle = "rgba(120,122,126,1)";
  g.fillRect(c.x, c.y, c.w, 7);
  g.fillStyle = "rgba(90,92,96,1)";
  g.fillRect(c.x + 5, c.y + c.h - 6, c.w - 10, 6);
  finishCell(g, c);
}

function paintAtlas(): HTMLCanvasElement {
  const { c, g } = canvas(ATLAS, ATLAS);
  g.fillStyle = "#d8d8d4";
  g.fillRect(0, 0, ATLAS, ATLAS);

  // Lap siding: sixteen boards, each catching light on its upper face and shading the lap below.
  {
    const s = STRIPS.lap;
    const r = rng(11);
    const n = 16;
    const p = s.h / n;
    for (let i = 0; i < n; i++) {
      const y = s.y + i * p;
      const v = 228 + Math.round((r() - 0.5) * 8);
      const grad = g.createLinearGradient(0, y, 0, y + p);
      grad.addColorStop(0, `rgb(${v + 10},${v + 10},${v + 8})`);
      grad.addColorStop(0.7, `rgb(${v},${v},${v - 2})`);
      grad.addColorStop(0.86, `rgb(${v - 30},${v - 30},${v - 30})`);
      grad.addColorStop(1, `rgb(${v - 95},${v - 95},${v - 92})`);
      g.fillStyle = grad;
      g.fillRect(0, y, ATLAS, p + 0.5);
    }
    // Board ends: a joint every 3.6 m or so, staggered.
    g.fillStyle = "rgba(60,60,60,0.35)";
    for (let i = 0; i < n; i++) g.fillRect(Math.floor(r() * ATLAS), s.y + i * p, 1, p - 2);
    streaks(g, s, 26, 0.1, 5);
    grain(g, 0, s.y, ATLAS, s.h, 0.05, 21);
    finishStrip(g, s);
  }

  // Ceramic siding: 45 × 15 cm blocks in stretcher bond, a groove between them.
  {
    const s = STRIPS.ceramic;
    const r = rng(31);
    const rows = 20;
    const bh = s.h / rows;
    const bw = ATLAS / 16;
    g.fillStyle = "#cdcbc4";
    g.fillRect(0, s.y, ATLAS, s.h);
    for (let j = 0; j < rows; j++)
      for (let i = -1; i < 17; i++) {
        const v = 226 + Math.round((r() - 0.5) * 10);
        const x = i * bw + (j & 1 ? bw / 2 : 0);
        g.fillStyle = `rgb(${v},${v - 1},${v - 4})`;
        g.fillRect(x + 1, s.y + j * bh + 1, bw - 1.5, bh - 1.5);
        g.fillStyle = "rgba(255,255,255,0.2)";
        g.fillRect(x + 1, s.y + j * bh + 1, bw - 1.5, 1);
      }
    streaks(g, s, 14, 0.07, 9);
    grain(g, 0, s.y, ATLAS, s.h, 0.07, 41);
    finishStrip(g, s);
  }

  // A storey of a block: painted panels, a joint at each floor, three windows per repeat.
  {
    const s = STRIPS.band;
    const px = ATLAS / 8;
    const py = s.h / s.metres;
    g.fillStyle = "#e3e1db";
    g.fillRect(0, s.y, ATLAS, s.h);
    g.fillStyle = "rgba(90,88,84,0.45)";
    g.fillRect(0, s.y, ATLAS, 2);
    g.fillStyle = "rgba(120,118,112,0.25)";
    for (let k = 0; k < 6; k++) g.fillRect(Math.round((k * ATLAS) / 6), s.y, 1, s.h);
    streaks(g, s, 20, 0.09, 13);
    for (let k = 0; k < 3; k++) {
      const x = Math.round((k * BAND.period + BAND.x) * px);
      const w = Math.round(BAND.w * px);
      const h = Math.round(BAND.h * py);
      const y = Math.round(s.y + s.h - (BAND.sill + BAND.h) * py);
      g.fillStyle = "#8f9498";
      g.fillRect(x, y, w, h);
      const pw = (w - 8 - 3) / 2;
      glass(g, x + 4, y + 4, pw, h - 8, 50 + k, k === 1 ? 0.5 : 0);
      glass(g, x + 7 + pw, y + 4, pw, h - 8, 60 + k, 0);
      g.fillStyle = "#8f9498";
      g.fillRect(x, y + Math.round(h * 0.28), w, 3);
      // Sill and its drip shadow.
      g.fillStyle = "#c9c9c6";
      g.fillRect(x - 3, y + h, w + 6, 3);
      g.fillStyle = "rgba(60,58,54,0.25)";
      g.fillRect(x - 2, y + h + 3, w + 4, 5);
    }
    grain(g, 0, s.y, ATLAS, s.h, 0.04, 43);
    finishStrip(g, s);
  }

  // Ribbed metal: 64 trapezoid ribs.
  {
    const s = STRIPS.rib;
    const p = ATLAS / 64;
    for (let i = 0; i < 64; i++) {
      const x = i * p;
      const grad = g.createLinearGradient(x, 0, x + p, 0);
      grad.addColorStop(0, "#f0f0ee");
      grad.addColorStop(0.42, "#e6e6e4");
      grad.addColorStop(0.5, "#fafaf8");
      grad.addColorStop(0.62, "#b4b4b2");
      grad.addColorStop(0.9, "#cfcfcd");
      grad.addColorStop(1, "#f0f0ee");
      g.fillStyle = grad;
      g.fillRect(x, s.y, p, s.h);
    }
    grain(g, 0, s.y, ATLAS, s.h, 0.05, 47);
    finishStrip(g, s);
  }

  // Standing seams every 50 cm.
  {
    const s = STRIPS.seam;
    g.fillStyle = "#e4e4e2";
    g.fillRect(0, s.y, ATLAS, s.h);
    const r = rng(53);
    for (let i = 0; i < 16; i++) {
      const x = i * 64;
      g.fillStyle = `rgba(0,0,0,${0.02 + r() * 0.05})`;
      g.fillRect(x, s.y, 64, s.h);
      g.fillStyle = "#f0f0ee";
      g.fillRect(x + 30, s.y, 2, s.h);
      g.fillStyle = "#b2b2b0";
      g.fillRect(x + 32, s.y, 3, s.h);
      g.fillStyle = "#d0d0ce";
      g.fillRect(x + 35, s.y, 2, s.h);
    }
    grain(g, 0, s.y, ATLAS, s.h, 0.03, 59);
    finishStrip(g, s);
  }

  // Concrete: pour grain, a lift line, tie holes.
  {
    const s = STRIPS.concrete;
    g.fillStyle = "#c6c5c0";
    g.fillRect(0, s.y, ATLAS, s.h);
    const r = rng(61);
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? "70,70,68" : "235,235,230"},${0.05 + r() * 0.08})`;
      g.fillRect(r() * ATLAS, s.y + r() * s.h, 6 + r() * 40, 1 + r() * 3);
    }
    g.fillStyle = "rgba(60,60,58,0.5)";
    for (let i = 0; i < 16; i++) g.fillRect(i * 64 + 30, s.y + 14, 3, 3);
    grain(g, 0, s.y, ATLAS, s.h, 0.12, 67);
    finishStrip(g, s);
  }

  // Smooth painted metal.
  {
    const s = STRIPS.plain;
    g.fillStyle = "#eeeeec";
    g.fillRect(0, s.y, ATLAS, s.h);
    grain(g, 0, s.y, ATLAS, s.h, 0.03, 71);
    finishStrip(g, s);
  }

  // Storeys of a house for the distance tiers: a flat wall, a hint of board lines, windows painted in.
  for (const name of ["rowA", "rowB"] as const) {
    const s = STRIPS[name];
    const px = ATLAS / 8;
    const py = s.h / s.metres;
    g.fillStyle = "#e6e6e3";
    g.fillRect(0, s.y, ATLAS, s.h);
    g.fillStyle = "rgba(120,120,116,0.10)";
    for (let y = s.y + 3; y < s.y + s.h; y += 4) g.fillRect(0, y, ATLAS, 1);
    for (const [x, w, sill, h, lit] of ROWS[name]) {
      const X = Math.round(x * px);
      const W = Math.round(w * px);
      const H = Math.round(h * py);
      const Y = Math.round(s.y + s.h - (sill + h) * py);
      g.fillStyle = "#4a4642";
      g.fillRect(X, Y, W, H);
      if (lit) {
        const grad = g.createLinearGradient(0, Y, 0, Y + H);
        grad.addColorStop(0, "#ffe6b4");
        grad.addColorStop(1, "#e9b877");
        g.fillStyle = grad;
        g.fillRect(X + 6, Y + 2, W - 12, H - 4);
      } else glass(g, X + 6, Y + 2, W - 12, H - 4, 300 + x * 10, w > 1 ? 0.45 : 0);
      if (w > 1) {
        g.fillStyle = "#4a4642";
        g.fillRect(X + W / 2 - 2, Y, 4, H);
      }
    }
    grain(g, 0, s.y, ATLAS, s.h, 0.03, 91);
    finishStrip(g, s);
  }

  window_(g, CELLS.winSlide, "#3d3833", 2, 101, 0.55);
  window_(g, CELLS.winTall, "#3d3833", 1, 103, 0, true);
  window_(g, CELLS.winSmall, "#b8bcbf", 1, 105, 0.7);
  window_(g, CELLS.winWide, "#3d3833", 3, 107, 0.4);
  window_(g, CELLS.winWhite, "#dcdedf", 2, 109, 0.6);

  // Front door: a dark slab with a glazed slit and a pull handle.
  {
    const d = CELLS.door;
    g.fillStyle = "#4a4039";
    g.fillRect(d.x, d.y, d.w, d.h);
    g.fillStyle = "#5d5046";
    g.fillRect(d.x + 4, d.y + 4, d.w - 8, d.h - 6);
    glass(g, d.x + 14, d.y + 16, 9, 84, 113);
    g.fillStyle = "#c8c8c4";
    g.fillRect(d.x + d.w - 16, d.y + 50, 3, 30);
    for (let y = d.y + 24; y < d.y + d.h - 8; y += 12) {
      g.fillStyle = "rgba(0,0,0,0.12)";
      g.fillRect(d.x + 28, y, d.w - 48, 1);
    }
    finishCell(g, d);
  }

  // A panel of a 風除室: aluminium frame, glass, a rail at waist height, a kick panel.
  {
    const p = CELLS.porch;
    g.fillStyle = "#b4b8bb";
    g.fillRect(p.x, p.y, p.w, p.h);
    glass(g, p.x + 4, p.y + 4, p.w - 8, 66, 127);
    glass(g, p.x + 4, p.y + 73, p.w - 8, 32, 131);
    g.fillStyle = "#9da1a4";
    g.fillRect(p.x + 4, p.y + 108, p.w - 8, p.h - 112);
    g.fillStyle = "rgba(255,255,255,0.35)";
    g.fillRect(p.x, p.y, 1, p.h);
    finishCell(g, p);
  }

  slats(g, CELLS.shutter, "#c4c6c6", 6);
  slats(g, CELLS.bigShutter, "#aeb6bc", 7);

  // Shop glazing: three bays, mullions, a kick panel; dark behind the glass.
  {
    const s = CELLS.shopGlass;
    g.fillStyle = "#54585b";
    g.fillRect(s.x, s.y, s.w, s.h);
    const bw = (s.w - 4) / 3;
    for (let i = 0; i < 3; i++) glass(g, s.x + 4 + i * bw, s.y + 4, bw - 4, s.h - 26, 137 + i, i === 2 ? 0.25 : 0);
    g.fillStyle = "#8a8e90";
    g.fillRect(s.x, s.y + s.h - 20, s.w, 20);
    g.fillStyle = "rgba(0,0,0,0.3)";
    g.fillRect(s.x, s.y + s.h - 20, s.w, 2);
    finishCell(g, s);
  }

  // Barn door: vertical boards, a frame and two braces in a paler paint.
  {
    const b = CELLS.barnDoor;
    g.fillStyle = "#d9d6cf";
    g.fillRect(b.x, b.y, b.w, b.h);
    const r = rng(149);
    for (let x = b.x; x < b.x + b.w; x += 8) {
      const v = 200 + Math.round(r() * 24);
      g.fillStyle = `rgb(${v},${v - 3},${v - 9})`;
      g.fillRect(x, b.y, 7, b.h);
    }
    g.strokeStyle = "#f4f2ec";
    g.lineWidth = 7;
    g.strokeRect(b.x + 4, b.y + 4, b.w - 8, b.h - 8);
    g.beginPath();
    g.moveTo(b.x + b.w / 2, b.y + 4);
    g.lineTo(b.x + b.w / 2, b.y + b.h - 4);
    g.moveTo(b.x + 6, b.y + 6);
    g.lineTo(b.x + b.w / 2, b.y + b.h - 6);
    g.lineTo(b.x + b.w - 6, b.y + 6);
    g.stroke();
    finishCell(g, b);
  }

  // Louvred vent.
  {
    const v = CELLS.vent;
    g.fillStyle = "#b9bbbd";
    g.fillRect(v.x, v.y, v.w, v.h);
    g.fillStyle = "#4c4e50";
    for (let y = v.y + 5; y < v.y + v.h - 4; y += 5) g.fillRect(v.x + 4, y, v.w - 8, 2);
    finishCell(g, v);
  }

  // A painted board over a shopfront.
  {
    const b = CELLS.board;
    g.fillStyle = "#ecebe4";
    g.fillRect(b.x, b.y, b.w, b.h);
    g.fillStyle = "#27496d";
    g.fillRect(b.x, b.y + b.h - 8, b.w, 8);
    g.fillStyle = "#2a2c30";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `900 34px ${JP_SANS}`;
    g.fillText("酒・たばこ・食料品", b.x + b.w / 2, b.y + b.h / 2 - 3, b.w - 16);
    finishCell(g, b);
  }
  return c;
}

/** A window lit from inside: a warm room behind a curtain, the frame in silhouette. */
function litWindow(g: Ctx, c: Cell, panes: number, seed: number, warm: boolean): void {
  g.fillStyle = "#1f1b18";
  g.fillRect(c.x, c.y, c.w, c.h);
  const r = rng(seed);
  const f = 4;
  const pw = (c.w - f * 2 - (panes - 1) * 3) / panes;
  for (let i = 0; i < panes; i++) {
    const x = c.x + f + i * (pw + 3);
    const grad = g.createLinearGradient(0, c.y + f, 0, c.y + c.h - f);
    if (warm) {
      grad.addColorStop(0, "#ffe2b0");
      grad.addColorStop(0.6, "#f6c583");
      grad.addColorStop(1, "#c98f55");
    } else {
      grad.addColorStop(0, "#f2f5f0");
      grad.addColorStop(1, "#c3ccc6");
    }
    g.fillStyle = grad;
    g.fillRect(x, c.y + f, pw, c.h - f * 2);
    // Curtain folds.
    for (let k = x; k < x + pw; k += 3 + r() * 5) {
      g.fillStyle = `rgba(${r() < 0.5 ? "120,80,40" : "255,240,210"},${0.08 + r() * 0.14})`;
      g.fillRect(k, c.y + f, 1 + r() * 2, c.h - f * 2);
    }
  }
  // Something dark in the room on one side: furniture, a person's back.
  g.fillStyle = "rgba(60,40,24,0.35)";
  g.fillRect(c.x + f + r() * (c.w * 0.5), c.y + c.h * 0.55, c.w * 0.25, c.h * 0.45 - f);
  extrudeEdges(g, c.x, c.y, c.w, c.h, PAD);
}

function litSign(g: Ctx, c: Cell, bg: string, fg: string, text: string): void {
  g.fillStyle = bg;
  g.fillRect(c.x, c.y, c.w, c.h);
  g.fillStyle = fg;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `900 40px ${JP_SANS}`;
  g.fillText(text, c.x + c.w / 2, c.y + c.h / 2 + 2, c.w - 14);
  extrudeEdges(g, c.x, c.y, c.w, c.h, PAD);
}

function paintLitAtlas(): HTMLCanvasElement {
  const S = LIT_ATLAS;
  const { c, g } = canvas(S, S);
  g.fillStyle = "#3a3632";
  g.fillRect(0, 0, S, S);
  litWindow(g, LIT_CELLS.winSlide, 2, 201, true);
  litWindow(g, LIT_CELLS.winTall, 1, 203, true);
  litWindow(g, LIT_CELLS.winSmall, 1, 205, false);
  litWindow(g, LIT_CELLS.winWide, 3, 207, true);
  litWindow(g, LIT_CELLS.winBand, 2, 209, false);

  // A shop through its glass: ceiling lights, shelves of goods, a magazine rack at the window, mullions.
  {
    const s = LIT_STRIPS.store;
    const r = rng(211);
    const grad = g.createLinearGradient(0, s.y, 0, s.y + s.h);
    grad.addColorStop(0, "#f4f6f2");
    grad.addColorStop(0.55, "#e2e3da");
    grad.addColorStop(1, "#b9b6aa");
    g.fillStyle = grad;
    g.fillRect(0, s.y, S, s.h);
    // Ceiling tubes.
    g.fillStyle = "#ffffff";
    for (let x = 10; x < S; x += 64) g.fillRect(x, s.y + 12, 44, 4);
    // Back shelves: rows of packaging.
    const hues = ["#c9403a", "#e6b23c", "#3f7fb8", "#5aa35c", "#e8e4d8", "#d9772f", "#7c4f9a", "#f0d9c2"];
    for (let row = 0; row < 4; row++) {
      const y = s.y + 36 + row * 17;
      g.fillStyle = "#8d8a80";
      g.fillRect(0, y + 14, S, 3);
      for (let x = 0; x < S; ) {
        const w = 4 + Math.floor(r() * 9);
        g.fillStyle = hues[Math.floor(r() * hues.length)];
        g.fillRect(x, y + 2 + Math.floor(r() * 3), w - 1, 12);
        x += w;
      }
    }
    // The rack along the window and the counter's shadow.
    g.fillStyle = "#6d695f";
    g.fillRect(0, s.y + 106, S, 34);
    for (let x = 2; x < S; x += 13) {
      g.fillStyle = hues[Math.floor(r() * hues.length)];
      g.fillRect(x, s.y + 108, 11, 15);
      g.fillStyle = "rgba(255,255,255,0.6)";
      g.fillRect(x + 2, s.y + 110, 7, 3);
    }
    // The glass between: the room is paler and flatter from outside.
    g.fillStyle = "rgba(226,230,228,0.42)";
    g.fillRect(0, s.y, S, s.h - 20);
    // Kick panel and mullions (every 1.5 m).
    g.fillStyle = "#4c4e50";
    g.fillRect(0, s.y + s.h - 20, S, 20);
    g.fillStyle = "#2c2e30";
    for (let x = 0; x < S; x += S / 4) g.fillRect(x - 2 + (x === 0 ? 2 : 0), s.y, 4, s.h);
    g.fillRect(0, s.y, S, 3);
    extrudeEdges(g, 0, s.y, S, s.h, PAD);
  }

  // Lit fascia: white acrylic, a joint every 1.5 m.
  {
    const s = LIT_STRIPS.fascia;
    g.fillStyle = "#f6f6f4";
    g.fillRect(0, s.y, S, s.h);
    g.fillStyle = "rgba(120,120,120,0.35)";
    for (let x = 0; x < S; x += S / 4) g.fillRect(x, s.y, 1, s.h);
    extrudeEdges(g, 0, s.y, S, s.h, PAD);
  }

  litSign(g, LIT_CELLS.sign0, "#f4f2ea", "#c2302a", "営業中");
  litSign(g, LIT_CELLS.sign1, "#e9c33a", "#b3261e", "ラーメン");
  litSign(g, LIT_CELLS.sign2, "#2f6a46", "#f4f2ea", "農産物直売");

  {
    const l = LIT_CELLS.lamp;
    const grad = g.createRadialGradient(l.x + l.w / 2, l.y + l.h / 2, 2, l.x + l.w / 2, l.y + l.h / 2, l.w / 2);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.7, "#f1f3f4");
    grad.addColorStop(1, "#c9cdd0");
    g.fillStyle = grad;
    g.fillRect(l.x, l.y, l.w, l.h);
    extrudeEdges(g, l.x, l.y, l.w, l.h, PAD);
  }
  {
    const p = LIT_CELLS.panel;
    g.fillStyle = "#2a2c30";
    g.fillRect(p.x, p.y, p.w, p.h);
    g.fillStyle = "#eef2f4";
    g.fillRect(p.x + 5, p.y + 6, p.w - 10, 34);
    const r = rng(223);
    const hues = ["#c9403a", "#e6b23c", "#3f7fb8", "#5aa35c", "#e8e4d8"];
    for (let row = 0; row < 3; row++)
      for (let k = 0; k < 6; k++) {
        g.fillStyle = hues[Math.floor(r() * hues.length)];
        g.fillRect(p.x + 6 + k * 9, p.y + 46 + row * 15, 7, 12);
      }
    extrudeEdges(g, p.x, p.y, p.w, p.h, PAD);
  }
  return c;
}
