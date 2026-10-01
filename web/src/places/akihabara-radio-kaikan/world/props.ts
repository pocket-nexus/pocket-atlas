import { BoxGeometry, CylinderGeometry, TorusGeometry, Vector3 } from "three";
import { fitText, HEAVY, JP_SANS, LATIN } from "../../shared/canvas";
import { box } from "../../shared/geo";
import { merge } from "../../shared/shapes";
import { paintLightbox } from "../gfx/art";
import type { AkibaWorld } from "./context";
import { CROSSINGS, STREET, VIEW } from "./layout";
import { cellPlane, point } from "./util";

/** Lantern lamp posts along both kerbs (x), clear of crossings, the clock and doorways. */
export const LAMPS = {
  south: [-50, -30.5, -11.5, 11.5, 29],
  north: [-41, -22.5, -2.5, 3.5, 22, 31],
  /** Kerb offsets toward the sidewalk. */
  inset: 0.55,
  height: 6.2,
};

/*
 * Street furniture: dark-grey square lamp posts with lantern heads, the two-faced pole clock with its speaker, black bollards
 * with reflective bands along both kerbs, the crossing and one-way signs at
 * the NE corner, vending machines, a hedge planter, bins and A-frame boards.
 */
export function buildProps(w: AkibaWorld): void {
  lamps(w);
  clock(w);
  bollards(w);
  roadSigns(w);
  sidewalkBits(w);
}

function lamps(w: AkibaWorld): void {
  const lib = w.lib;
  const post = lib.plain(0x3a3d40, 0.5, 0.55);
  const cap = lib.plain(0x2a2c2e, 0.45, 0.6);
  const globe = lib.glow(0xffd9a0, 4.2);
  const H = LAMPS.height;
  // One lamp's parts, merged per material and reused.
  const shaft = box(0.2, H, 0.2);
  shaft.translate(0, H / 2, 0);
  const base = box(0.34, 0.5, 0.34);
  base.translate(0, 0.25, 0);
  const capG = merge([
    (() => {
      const b = box(0.62, 0.12, 0.62);
      b.translate(0, H + 1.36, 0);
      return b;
    })(),
    (() => {
      const c = new CylinderGeometry(0.06, 0.3, 0.22, 4);
      c.rotateY(Math.PI / 4);
      c.translate(0, H + 1.53, 0);
      return c;
    })(),
    (() => {
      const b = box(0.46, 0.1, 0.46);
      b.translate(0, H + 0.05, 0);
      return b;
    })(),
  ]);
  const lantern = box(0.42, 1.2, 0.42);
  lantern.translate(0, H + 0.7, 0);
  const frame = merge(
    [-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) => {
        const b = box(0.04, 1.24, 0.04);
        b.translate(sx * 0.22, H + 0.7, sz * 0.22);
        return b;
      }),
    ),
  );
  const put = (x: number, z: number) => {
    const g = w.group(x, 0, z, 0);
    w.mesh(shaft, post, 0, 0, 0, g);
    w.mesh(base, post, 0, 0, 0, g);
    w.mesh(capG, cap, 0, 0, 0, g);
    w.mesh(lantern, globe, 0, 0, 0, g);
    w.mesh(frame, cap, 0, 0, 0, g);
    point(w, 0xffd9a8, 60, 20, new Vector3(x, H + 0.7, z));
  };
  for (const x of LAMPS.south) put(x, STREET.southKerb + LAMPS.inset);
  for (const x of LAMPS.north) put(x, STREET.northKerb - LAMPS.inset);
}

/** The two-faced analog clock with a speaker, on the north sidewalk (35.698243, 139.772263). */
function clock(w: AkibaWorld): void {
  const lib = w.lib;
  const c = VIEW.clock;
  const g = w.group(c.x, 0, c.z, 0);
  g.name = "pole-clock";
  const steel = lib.plain(0x2e3134, 0.45, 0.6);
  const y = 3.95;
  w.mesh(new CylinderGeometry(0.075, 0.09, y - 0.45, 12), steel, 0, (y - 0.45) / 2, 0, g);
  w.mesh(new CylinderGeometry(0.22, 0.26, 0.3, 12), steel, 0, 0.15, 0, g);
  // Ring case (faces east and west along the sidewalk).
  const ring = new TorusGeometry(0.47, 0.06, 10, 40);
  ring.rotateY(Math.PI / 2);
  w.mesh(ring, steel, 0, y, 0, g);
  w.mesh(new CylinderGeometry(0.47, 0.47, 0.16, 40, 1, true).rotateZ(Math.PI / 2), steel, 0, y, 0, g);
  const dial = w.draw("clock-dial", 400, 400, (cg, cw, ch) => {
    cg.fillStyle = "#f4f2ea";
    cg.beginPath();
    cg.arc(cw / 2, ch / 2, cw * 0.49, 0, Math.PI * 2);
    cg.fill();
    cg.fillStyle = "#1a1a1a";
    for (let i = 0; i < 12; i++) {
      cg.save();
      cg.translate(cw / 2, ch / 2);
      cg.rotate((i / 12) * Math.PI * 2);
      cg.fillRect(-cw * 0.012, -cw * 0.45, cw * 0.024, i % 3 === 0 ? cw * 0.09 : cw * 0.05);
      cg.restore();
    }
    // 17:35 — hour and minute hands.
    const hand = (ang: number, len: number, wd: number) => {
      cg.save();
      cg.translate(cw / 2, ch / 2);
      cg.rotate(ang);
      cg.fillRect(-wd / 2, -len, wd, len + cw * 0.04);
      cg.restore();
    };
    hand(((5 + 35 / 60) / 12) * Math.PI * 2, cw * 0.24, cw * 0.035);
    hand((35 / 60) * Math.PI * 2, cw * 0.38, cw * 0.022);
    cg.beginPath();
    cg.arc(cw / 2, ch / 2, cw * 0.03, 0, Math.PI * 2);
    cg.fill();
  });
  const lit = w.mid;
  for (const s of [-1, 1]) {
    const face = cellPlane(0.86, 0.86, dial);
    face.rotateY((s * Math.PI) / 2);
    w.mesh(face, lit, s * 0.081, y, 0, g);
  }
  // Speaker horn and cap on top.
  const horn = new CylinderGeometry(0.16, 0.06, 0.32, 12, 1, true);
  horn.rotateZ(Math.PI / 2);
  w.mesh(horn, steel, -0.12, y + 0.72, 0, g);
  w.mesh(box(0.1, 0.24, 0.1), steel, 0, y + 0.6, 0, g);
}

function bollards(w: AkibaWorld): void {
  const lib = w.lib;
  const black = lib.plain(0x151617, 0.45, 0.3);
  const band = lib.plain(0xf0c020, 0.35, 0.1);
  const body = new CylinderGeometry(0.06, 0.07, 0.85, 10);
  body.translate(0, 0.425, 0);
  const top = new CylinderGeometry(0.0, 0.06, 0.06, 10);
  top.translate(0, 0.88, 0);
  const ring = new CylinderGeometry(0.063, 0.063, 0.07, 10, 1, true);
  ring.translate(0, 0.72, 0);
  const crossing = (x: number) => CROSSINGS.some((c) => Math.abs(x - c.x) < c.w / 2 + 0.4) || Math.abs(x + 61.2) < 2.2;
  for (const [z, xs] of [
    [STREET.southKerb + 0.32, LAMPS.south],
    [STREET.northKerb - 0.32, LAMPS.north],
  ] as const) {
    for (let x = -57.5; x < 34; x += 2.5) {
      if (crossing(x) || xs.some((l) => Math.abs(l - x) < 0.9)) continue;
      if (z > -9 && x > -8.9 && x < -2.5) continue; // gift shop racks
      w.mesh(body, black, x, 0, z);
      w.mesh(top, black, x, 0, z);
      w.mesh(ring, band, x, 0, z);
    }
  }
}

function roadSigns(w: AkibaWorld): void {
  const lib = w.lib;
  const pole = lib.plain(0x9a9fa4, 0.4, 0.7);
  const back = lib.plain(0x6a6e72, 0.5, 0.6);
  const crossingSign = w.draw("sign-crossing", 256, 256, (g, cw, ch) => {
    g.fillStyle = "#1f5fbf";
    g.fillRect(0, 0, cw, ch);
    g.strokeStyle = "#ffffff";
    g.lineWidth = cw * 0.04;
    g.strokeRect(cw * 0.04, ch * 0.04, cw * 0.92, ch * 0.92);
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.moveTo(cw * 0.5, ch * 0.14);
    g.lineTo(cw * 0.88, ch * 0.84);
    g.lineTo(cw * 0.12, ch * 0.84);
    g.closePath();
    g.fill();
    // Pedestrian pictogram (standard road-sign figure) and the zebra bars.
    g.fillStyle = "#1a1a1a";
    g.beginPath();
    g.arc(cw * 0.52, ch * 0.38, cw * 0.045, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = cw * 0.045;
    g.strokeStyle = "#1a1a1a";
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(cw * 0.51, ch * 0.45);
    g.lineTo(cw * 0.48, ch * 0.6);
    g.lineTo(cw * 0.42, ch * 0.72);
    g.moveTo(cw * 0.48, ch * 0.6);
    g.lineTo(cw * 0.56, ch * 0.72);
    g.moveTo(cw * 0.5, ch * 0.5);
    g.lineTo(cw * 0.6, ch * 0.56);
    g.stroke();
    for (let i = 0; i < 4; i++) g.fillRect(cw * (0.26 + i * 0.13), ch * 0.76, cw * 0.07, ch * 0.05);
  });
  const oneWay = w.draw("sign-oneway", 320, 128, (g, cw, ch) => {
    g.fillStyle = "#1f5fbf";
    g.fillRect(0, 0, cw, ch);
    g.strokeStyle = "#ffffff";
    g.lineWidth = ch * 0.06;
    g.strokeRect(ch * 0.06, ch * 0.06, cw - ch * 0.12, ch - ch * 0.12);
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.moveTo(cw * 0.1, ch * 0.5);
    g.lineTo(cw * 0.32, ch * 0.18);
    g.lineTo(cw * 0.32, ch * 0.38);
    g.lineTo(cw * 0.88, ch * 0.38);
    g.lineTo(cw * 0.88, ch * 0.62);
    g.lineTo(cw * 0.32, ch * 0.62);
    g.lineTo(cw * 0.32, ch * 0.82);
    g.closePath();
    g.fill();
  });
  const face = lib.printed(w.atlas.texture, "atlas-printed");
  // NE corner of Radio Kaikan and the crossing's north end; faces toward oncoming traffic (east).
  for (const [x, z] of [
    [0.7, STREET.southKerb + 0.45],
    [9.9, STREET.northKerb - 0.45],
  ]) {
    const g = w.group(x, 0, z, Math.PI / 2);
    w.mesh(new CylinderGeometry(0.035, 0.035, 3.3, 8), pole, 0, 1.65, 0, g);
    w.mesh(cellPlane(0.6, 0.6, crossingSign), face, 0, 2.45, 0.04, g);
    w.mesh(box(0.6, 0.6, 0.02), back, 0, 2.45, 0.02, g);
    w.mesh(cellPlane(0.8, 0.32, oneWay), face, 0, 3.0, 0.04, g);
    w.mesh(box(0.8, 0.32, 0.02), back, 0, 3.0, 0.02, g);
  }
}

function sidewalkBits(w: AkibaWorld): void {
  const lib = w.lib;
  // Vending machines in a row against Sofmap's alley wall and by the pachinko hall.
  const front = (brand: string, accent: string, seed: number) =>
    w.draw(`vend-${brand}`, 300, 560, (g, cw, ch) => {
      g.fillStyle = accent;
      g.fillRect(0, 0, cw, ch);
      g.fillStyle = "#f4f6f8";
      g.fillRect(cw * 0.06, ch * 0.06, cw * 0.88, ch * 0.5);
      for (let r = 0; r < 4; r++)
        for (let i = 0; i < 6; i++) {
          g.fillStyle = ["#e8332a", "#1f6fd1", "#f2c200", "#2a9a4a", "#ffffff", "#7a4a2a"][(i + r + seed) % 6];
          g.fillRect(cw * (0.1 + i * 0.135), ch * (0.09 + r * 0.115), cw * 0.1, ch * 0.08);
        }
      g.fillStyle = "#ffffff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      fitText(g, brand, cw / 2, ch * 0.64, cw * 0.8, ch * 0.06, LATIN, HEAVY);
      g.fillStyle = "#1a1a1a";
      g.fillRect(cw * 0.3, ch * 0.82, cw * 0.4, ch * 0.08);
    });
  const vendFront = w.mid;
  const vend = (x: number, z: number, ry: number, brand: string, accent: string, seed: number) => {
    const g = w.group(x, 0, z, ry);
    const body = lib.plain(Number.parseInt(accent.slice(1), 16), 0.4, 0.2);
    w.mesh(box(1.0, 1.83, 0.72), body, 0, 0.915, -0.36, g);
    w.mesh(cellPlane(0.92, 1.72, front(brand, accent, seed)), vendFront, 0, 0.94, 0.003, g);
  };
  vend(-25.2, 1.4, Math.PI, "COLD DRINKS", "#c8141e", 1);
  vend(-26.25, 1.4, Math.PI, "TEA & COFFEE", "#1f4fa8", 2);
  vend(3.15, 1.6, -Math.PI / 2, "ICE COFFEE", "#e8e8e4", 3);

  // Hedge planter at the west end of Radio Kaikan, a bin pair by the exit, A-frame boards.
  const planter = lib.plain(0x6a6e70, 0.6, 0.2);
  const hedge = lib.plain(0x1e3a1a, 0.9);
  w.mesh(box(2.6, 0.45, 0.8), planter, -20.4, 0.225, -0.2);
  const leaves = merge(
    Array.from({ length: 14 }, (_, i) => {
      const s = new BoxGeometry(0.36, 0.36, 0.36);
      s.translate(-21.5 + i * 0.17, 0.62 + (i % 3) * 0.03, -0.2 + ((i * 7) % 3) * 0.12 - 0.12);
      return s;
    }),
  );
  w.mesh(leaves, hedge, 0, 0, 0);
  const bin = lib.plain(0x2a4a7a, 0.5, 0.3);
  for (const [x, z] of [[36.6, -12.4], [37.3, -12.4]]) w.mesh(new CylinderGeometry(0.28, 0.25, 0.95, 14), bin, x, 0.475, z);
  const aframe = (x: number, z: number, ry: number, s: Parameters<typeof paintLightbox>[3]) => {
    const g = w.group(x, 0, z, ry);
    const rc = w.draw(`aframe-${s.text}`, 220, 320, (cg, cw, ch) => paintLightbox(cg, cw, ch, s));
    for (const side of [-1, 1]) {
      const p = cellPlane(0.5, 0.75, rc);
      p.rotateX(side * 0.16);
      p.rotateY(side > 0 ? 0 : Math.PI);
      w.mesh(p, lib.printed(w.atlas.texture, "atlas-printed"), 0, 0.5, side * 0.07, g);
    }
  };
  aframe(-15.4, -1.6, 0.1, { text: "カード買取", sub: "1F C-labo", bg: "#ffffff", fg: "#e0262c" });
  aframe(-8.0, -0.7, -0.15, { text: "東京みやげ", sub: "GIFT SHOP", bg: "#ff9a2e", fg: "#ffffff" });
  aframe(-21.0, -1.7, 0.2, { text: "生ビール", sub: "B1F", bg: "#ffd21a", fg: "#1a1a1a" });
  aframe(-33.5, -1.9, -0.1, { text: "新台入替", bg: "#e01d24", fg: "#ffffff" });

  // Guide map board by the exit (lit).
  const map = w.draw("guide-map", 420, 300, (g, cw, ch) => {
    g.fillStyle = "#123a6a";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = "#e8eef4";
    g.fillRect(cw * 0.05, ch * 0.18, cw * 0.9, ch * 0.76);
    g.strokeStyle = "#9aa8b8";
    g.lineWidth = 6;
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.moveTo(cw * 0.05, ch * (0.25 + i * 0.12));
      g.lineTo(cw * 0.95, ch * (0.3 + i * 0.1));
      g.stroke();
    }
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, "秋葉原電気街 案内図", cw / 2, ch * 0.09, cw * 0.8, ch * 0.1, JP_SANS);
  });
  const mg = w.group(34.6, 0, -17.4, 0);
  w.mesh(box(1.5, 1.1, 0.12), lib.plain(0x2a2c2e, 0.5, 0.4), 0, 1.45, 0, mg);
  w.mesh(cellPlane(1.4, 1.0, map), w.mid, 0, 1.45, 0.065, mg);
  for (const s of [-0.65, 0.65]) w.mesh(box(0.06, 0.95, 0.06), lib.plain(0x2a2c2e, 0.5, 0.4), s, 0.47, 0, mg);
}
