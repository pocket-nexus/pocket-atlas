import { BufferGeometry, CatmullRomCurve3, CircleGeometry, CylinderGeometry, LatheGeometry, PlaneGeometry, SphereGeometry, TubeGeometry, Vector2, Vector3, type Material } from "three";
import { Rng } from "../../../core/random";
import { mapUV, type AtlasRect } from "../../shared/atlas";
import { JP_SANS, JP_SERIF, LATIN, roundRect, verticalText, type Ctx } from "../../shared/canvas";
import { box, cable } from "../../shared/geo";
import { merge, rod, v3 } from "../../shared/shapes";
import type { SugaWorld } from "./context";
import { LANE, STAIRS } from "./layout";
import { pipe } from "../gfx/geometry";
import { foliage } from "./tree";

/** Collects geometry per material and emits one mesh each. */
class Bag {
  private m = new Map<Material, { geos: BufferGeometry[]; cast: boolean }>();
  add(mat: Material, g: BufferGeometry, cast = true): void {
    let e = this.m.get(mat);
    if (!e) this.m.set(mat, (e = { geos: [], cast }));
    e.geos.push(g);
  }
  emit(w: SugaWorld): void {
    for (const [mat, e] of this.m) w.mesh(merge(e.geos), mat, 0, 0, 0, w.root, { cast: e.cast });
    this.m.clear();
  }
}

/** Atlas-mapped plane of w × h metres, facing +z, centred at the origin. */
function card(w: number, h: number, r: AtlasRect): BufferGeometry {
  return mapUV(new PlaneGeometry(w, h), r);
}

/** Orients a +z-facing piece to face `yaw` (radians about y) and moves it to p. */
function place(g: BufferGeometry, p: Vector3, yaw: number): BufferGeometry {
  g.rotateY(yaw);
  g.translate(p.x, p.y, p.z);
  return g;
}

// ------------------------------------------------------------ atlas art

function hazard(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#f2c200";
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = "#151515";
  const period = cw / 4;
  for (let i = -8; i < 12; i++) {
    g.beginPath();
    g.moveTo(i * period, ch);
    g.lineTo(i * period + period / 2, ch);
    g.lineTo(i * period + period / 2 + ch, 0);
    g.lineTo(i * period + ch, 0);
    g.closePath();
    g.fill();
  }
  const grd = g.createLinearGradient(0, ch, 0, ch * 0.5);
  grd.addColorStop(0, "rgba(60,50,40,0.5)");
  grd.addColorStop(1, "rgba(60,50,40,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, cw, ch);
}

function noThroughSign(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#f4f4ef";
  g.fillRect(0, 0, cw, ch);
  g.strokeStyle = "#1a1a1a";
  g.lineWidth = ch * 0.03;
  g.strokeRect(ch * 0.04, ch * 0.04, cw - ch * 0.08, ch - ch * 0.08);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#111";
  g.font = `800 ${ch * 0.24}px ${JP_SANS}`;
  g.fillText("この先階段のため", cw / 2, ch * 0.3);
  g.fillStyle = "#c8161d";
  g.font = `900 ${ch * 0.22}px ${JP_SANS}`;
  g.fillText("車両通り抜けできません", cw / 2, ch * 0.66);
  g.fillStyle = "#333";
  g.font = `600 ${ch * 0.08}px ${JP_SANS}`;
  g.fillText("新宿区", cw * 0.88, ch * 0.88);
}

function evacuationPlate(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#1b5fb0";
  g.fillRect(0, 0, cw, ch);
  g.strokeStyle = "#fff";
  g.lineWidth = cw * 0.02;
  g.strokeRect(cw * 0.04, cw * 0.04, cw * 0.92, ch - cw * 0.08);
  // Pictogram: a figure running toward an open area.
  g.fillStyle = "#fff";
  const px = cw * 0.5;
  const py = ch * 0.2;
  g.fillRect(px - cw * 0.3, py - cw * 0.14, cw * 0.6, cw * 0.32);
  g.fillStyle = "#1a8a3c";
  g.fillRect(px - cw * 0.26, py - cw * 0.1, cw * 0.52, cw * 0.24);
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(px - cw * 0.08, py - cw * 0.03, cw * 0.035, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = cw * 0.035;
  g.strokeStyle = "#fff";
  g.beginPath();
  g.moveTo(px - cw * 0.1, py + cw * 0.01);
  g.lineTo(px - cw * 0.03, py + cw * 0.08);
  g.lineTo(px + cw * 0.06, py + cw * 0.1);
  g.moveTo(px - cw * 0.03, py + cw * 0.08);
  g.lineTo(px - cw * 0.12, py + cw * 0.12);
  g.stroke();
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `900 ${cw * 0.2}px ${JP_SANS}`;
  verticalText(g, "避難場所", cw / 2, ch * 0.4, cw * 0.2, 1.05);
  g.font = `600 ${cw * 0.075}px ${LATIN}`;
  g.fillText("Evacuation Area", cw / 2, ch * 0.9);
}

function addressPlate(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#e9e7df";
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = "#1f4f9e";
  g.fillRect(0, 0, cw, ch * 0.62);
  g.fillStyle = "#fff";
  g.font = `900 ${cw * 0.42}px ${JP_SANS}`;
  verticalText(g, "須賀町", cw / 2, ch * 0.04, cw * 0.42, 1.08);
  g.fillStyle = "#1f4f9e";
  g.font = `800 ${cw * 0.3}px ${JP_SANS}`;
  g.textAlign = "center";
  g.fillText("5", cw / 2, ch * 0.72);
  g.fillStyle = "#333";
  g.font = `700 ${cw * 0.14}px ${JP_SANS}`;
  g.fillText("新宿区", cw / 2, ch * 0.88);
}

function poleTag(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#f0efe9";
  g.fillRect(0, 0, cw, ch);
  g.strokeStyle = "#222";
  g.lineWidth = 2;
  g.strokeRect(2, 2, cw - 4, ch - 4);
  g.fillStyle = "#111";
  g.font = `800 ${cw * 0.42}px ${JP_SANS}`;
  verticalText(g, "四谷幹", cw / 2, ch * 0.06, cw * 0.42);
  g.font = `800 ${cw * 0.34}px ${LATIN}`;
  g.textAlign = "center";
  g.fillText("27", cw / 2, ch * 0.78);
}

function shrinePillar(g: Ctx, cw: number, ch: number): void {
  // Grey granite with the engraved name; the cut letters read darker.
  const grd = g.createLinearGradient(0, 0, cw, ch);
  grd.addColorStop(0, "#8d8b86");
  grd.addColorStop(1, "#7a7873");
  g.fillStyle = grd;
  g.fillRect(0, 0, cw, ch);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = i % 3 ? "rgba(30,30,30,0.35)" : "rgba(220,220,215,0.35)";
    g.fillRect((i * 97.31) % cw, (i * 57.17) % ch, 1.5, 1.5);
  }
  g.fillStyle = "#2c2b29";
  g.font = `700 ${cw * 0.62}px ${JP_SERIF}`;
  verticalText(g, "須賀神社", cw / 2, ch * 0.08, cw * 0.62, 1.12);
  g.fillStyle = "rgba(255,255,255,0.12)";
  g.fillRect(0, 0, cw * 0.1, ch);
}

function noticeBoard(g: Ctx, cw: number, ch: number, r: Rng): void {
  g.fillStyle = "#6b7a5e";
  g.fillRect(0, 0, cw, ch);
  const posters: [string, string, string][] = [
    ["例大祭", "#f6efe0", "#b3140e"],
    ["夏休み ラジオ体操", "#fffbe6", "#1f6fd1"],
    ["防災訓練のお知らせ", "#ffffff", "#1a7a3a"],
    ["町会だより", "#f2f2f2", "#333333"],
    ["資源回収日", "#e8f4ff", "#0b4ea2"],
  ];
  const slots = [
    [0.04, 0.06, 0.3, 0.55],
    [0.37, 0.06, 0.26, 0.4],
    [0.66, 0.06, 0.3, 0.42],
    [0.37, 0.5, 0.28, 0.44],
    [0.04, 0.64, 0.3, 0.3],
  ];
  slots.forEach(([x, y, w, h], i) => {
    const [title, bg, fg] = posters[i];
    g.fillStyle = bg;
    g.fillRect(x * cw, y * ch, w * cw, h * ch);
    g.fillStyle = fg;
    g.fillRect(x * cw, y * ch, w * cw, h * ch * 0.18);
    g.fillStyle = "#fff";
    g.font = `800 ${h * ch * 0.1}px ${JP_SANS}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(title, (x + w / 2) * cw, (y + h * 0.09) * ch, w * cw * 0.9);
    g.fillStyle = "rgba(40,40,40,0.55)";
    for (let l = 0; l < 6; l++) g.fillRect((x + 0.02) * cw, (y + h * (0.28 + l * 0.11)) * ch, (w - 0.04 - r.range(0, 0.08)) * cw, h * ch * 0.035);
  });
  g.fillStyle = "#e6e2d8";
  g.fillRect(0.68 * cw, 0.55 * ch, 0.28 * cw, 0.4 * ch);
  g.fillStyle = "#b3140e";
  g.font = `900 ${ch * 0.1}px ${JP_SERIF}`;
  g.fillText("須賀神社", 0.82 * cw, 0.68 * ch);
  g.fillStyle = "#333";
  g.font = `700 ${ch * 0.05}px ${JP_SANS}`;
  g.fillText("社務所より", 0.82 * cw, 0.82 * ch);
}

function vendingFace(g: Ctx, cw: number, ch: number, r: Rng): void {
  g.fillStyle = "#c01b1f";
  g.fillRect(0, 0, cw, ch);
  // Display window with three shelves of dummy cans and bottles.
  const x0 = cw * 0.06;
  const x1 = cw * 0.94;
  const y0 = ch * 0.05;
  const y1 = ch * 0.56;
  g.fillStyle = "#e9eef2";
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  const colors = ["#1a5fb4", "#e8e8e8", "#f5b700", "#2a9d4b", "#d9342b", "#6b3a1e", "#f07b1d", "#111", "#8fd3f0", "#e0247a"];
  for (let row = 0; row < 3; row++) {
    const ry = y0 + ((y1 - y0) * (row + 0.1)) / 3;
    const rh = ((y1 - y0) / 3) * 0.62;
    const n = 9;
    for (let i = 0; i < n; i++) {
      const bx = x0 + ((x1 - x0) * (i + 0.15)) / n;
      const bw = ((x1 - x0) / n) * 0.7;
      const bottle = r.chance(0.4);
      g.fillStyle = r.pick(colors);
      if (bottle) {
        roundRect(g, bx + bw * 0.1, ry + rh * 0.25, bw * 0.8, rh * 0.75, bw * 0.2);
        g.fill();
        g.fillRect(bx + bw * 0.35, ry, bw * 0.3, rh * 0.3);
      } else {
        roundRect(g, bx, ry + rh * 0.3, bw, rh * 0.7, bw * 0.12);
        g.fill();
      }
      g.fillStyle = "rgba(255,255,255,0.8)";
      g.fillRect(bx + bw * 0.2, ry + rh * 0.55, bw * 0.6, rh * 0.12);
      // Price strip and the button.
      g.fillStyle = "#111";
      g.fillRect(bx - bw * 0.05, ry + rh * 1.03, bw * 1.1, rh * 0.16);
      g.fillStyle = "#39e07a";
      g.font = `700 ${rh * 0.13}px ${LATIN}`;
      g.textAlign = "center";
      g.fillText(`${r.pick([110, 130, 150, 160, 180])}`, bx + bw / 2, ry + rh * 1.13);
    }
  }
  // Coin and note slots, the display, and the pickup flap.
  g.fillStyle = "#2a2a2a";
  g.fillRect(cw * 0.72, ch * 0.6, cw * 0.18, ch * 0.16);
  g.fillStyle = "#77e6ff";
  g.fillRect(cw * 0.74, ch * 0.62, cw * 0.14, ch * 0.03);
  g.fillStyle = "#1c1c1c";
  g.fillRect(cw * 0.12, ch * 0.8, cw * 0.62, ch * 0.12);
  g.fillStyle = "#fff";
  g.font = `800 ${ch * 0.035}px ${JP_SANS}`;
  g.textAlign = "left";
  g.fillText("つめたい", cw * 0.1, ch * 0.63);
  g.fillText("あったか〜い", cw * 0.1, ch * 0.68);
}

function mirrorFace(g: Ctx, cw: number, ch: number): void {
  // Orange rim ring on the chrome disc (the disc itself is a separate chrome piece).
  g.fillStyle = "#e46a1c";
  g.beginPath();
  g.arc(cw / 2, ch / 2, cw / 2, 0, Math.PI * 2);
  g.fill();
}

// ------------------------------------------------------------ builders

interface PoleSpec {
  x: number;
  z: number;
  y: number;
  h: number;
  /** Direction toward the road (the side hardware faces). */
  road: [number, number];
  transformer?: boolean;
  arm?: boolean;
  lamp?: number;
}

interface PoleOut {
  hv: Vector3[];
  lv: Vector3[];
  tel: Vector3[];
  base: Vector3;
}

/**
 * Street furniture of the flight and the lane: concrete distribution poles
 * with crossarms, transformers and dense cables on the lane's west side,
 * the stair-head street lamp, the bracket lamp and signs on the pole at the
 * foot, the red vending machine, the orange curve mirror at the junction,
 * the 須賀神社 stone pillar and the shrine's notice board.
 */
export function buildProps(w: SugaWorld): void {
  const lib = w.lib;
  const bag = new Bag();
  const concrete = lib.concrete([0.86, 0.85, 0.82], false);
  const galv = lib.paint(0x8a9094, 0.45);
  const white = lib.paint(0xe6e6e0, 0.4);
  const black = lib.plain(0x121314, 0.55);
  const porcelain = lib.plain(0x9a5a3a, 0.3);
  const grey = lib.paint(0x9ea3a6, 0.4);
  const P = w.printed;

  const A = {
    stripe: w.draw("stripe", 512, 704, hazard),
    noThrough: w.draw("nothrough", 1024, 460, noThroughSign),
    evac: w.draw("evac", 300, 900, evacuationPlate),
    address: w.draw("address", 256, 900, addressPlate),
    tag: w.draw("tag", 128, 420, poleTag),
    pillar: w.draw("pillar", 256, 1400, shrinePillar),
    board: w.draw("board", 1024, 700, (g, cw, ch) => noticeBoard(g, cw, ch, new Rng(3))),
    vending: w.draw("vending", 640, 1200, (g, cw, ch) => vendingFace(g, cw, ch, new Rng(8))),
    mirrorRim: w.draw("mirror-rim", 128, 128, mirrorFace),
  };

  // ---------------------------------------------------------- poles
  const ly = LANE.y;
  const poles: PoleSpec[] = [
    { x: 2.66, z: -16.6, y: ly, h: 9.2, road: [-1, 0], lamp: 1.2, arm: false },
    { x: -2.78, z: -24.4, y: ly, h: 11.2, road: [1, 0], transformer: true, arm: true },
    { x: -2.78, z: -40.8, y: ly, h: 11.0, road: [1, 0], arm: true },
    { x: -2.78, z: -56.9, y: ly, h: 11.2, road: [1, 0], transformer: true, arm: true, lamp: 1.3 },
    { x: -4.6, z: -71.4, y: ly, h: 11.0, road: [0.6, 0.8], arm: true },
    { x: 4.4, z: 6.0, y: 0, h: 10.4, road: [0, -1], arm: true, transformer: true },
    { x: -9.5, z: 6.0, y: 0, h: 10.4, road: [0, -1], arm: true },
    { x: 14.5, z: -71.6, y: ly, h: 10.6, road: [0, 1], arm: true },
    { x: -22, z: -71.6, y: ly, h: 10.6, road: [0, 1], arm: true },
  ];
  const out: PoleOut[] = [];
  const R0 = 0.19;
  const R1 = 0.1;
  for (const p of poles) {
    const base = v3(p.x, p.y, p.z);
    const road = v3(p.road[0], 0, p.road[1]).normalize();
    const side = v3(-road.z, 0, road.x);
    const rAt = (y: number) => R0 + (R1 - R0) * (y / p.h);
    const yaw = Math.atan2(road.x, road.z);
    const shaft = new CylinderGeometry(R1, R0, p.h, 16, 1, true);
    shaft.translate(p.x, p.y + p.h / 2, p.z);
    bag.add(concrete, shaft);
    const cap = new CylinderGeometry(0.03, R1 + 0.005, 0.07, 12);
    cap.translate(p.x, p.y + p.h + 0.035, p.z);
    bag.add(concrete, cap);
    // Tiger stripes where the lane is narrow.
    if (p.y === ly) {
      const sl = new CylinderGeometry(rAt(1.9) + 0.004, rAt(0.3) + 0.004, 1.6, 18, 1, true);
      mapUV(sl, A.stripe);
      sl.rotateY(yaw);
      sl.translate(p.x, p.y + 1.1, p.z);
      bag.add(P, sl, false);
    }
    // Step bolts up the side.
    for (let yy = 2.6; yy < p.h - 1.2; yy += 0.45) {
      const s = yy % 0.9 < 0.45 ? 1 : -1;
      const dir = side.clone().multiplyScalar(s);
      const a = base.clone().addScaledVector(dir, rAt(yy)).setY(p.y + yy);
      bag.add(galv, rod(a, a.clone().addScaledVector(dir, 0.16), 0.011, 5), false);
    }
    // Pole tag facing the road.
    bag.add(P, place(card(0.075, 0.26, A.tag), base.clone().addScaledVector(road, rAt(1.6) + 0.005).setY(p.y + 1.6 + 0.9), yaw), false);
    const o: PoleOut = { hv: [], lv: [], tel: [], base };
    const top = p.y + p.h;
    if (p.arm) {
      // Crossarm with three pin insulators, along the line direction.
      const ya = top - 0.45;
      const armC = base.clone().setY(ya);
      bag.add(galv, rod(armC.clone().addScaledVector(side, -0.95), armC.clone().addScaledVector(side, 0.95), 0.035, 4));
      for (const s of [-0.85, 0, 0.85]) {
        const pin = armC.clone().addScaledVector(side, s).addScaledVector(road, s === 0 ? 0.0 : 0);
        const ins = new LatheGeometry([new Vector2(0.02, 0), new Vector2(0.055, 0.03), new Vector2(0.03, 0.06), new Vector2(0.05, 0.1), new Vector2(0.02, 0.14)], 8);
        ins.translate(pin.x, pin.y + 0.03, pin.z);
        bag.add(porcelain, ins);
        o.hv.push(pin.clone().setY(pin.y + 0.15));
      }
      // Arm braces.
      for (const s of [-1, 1]) bag.add(galv, rod(armC.clone().addScaledVector(side, s * 0.5), base.clone().setY(ya - 0.5).addScaledVector(road, 0), 0.012, 4), false);
    }
    // Low-voltage rack and telecom messengers on the road side.
    const yLv = top - 2.1;
    for (let i = 0; i < 3; i++) {
      const pt = base.clone().addScaledVector(road, rAt(yLv) + 0.12).setY(yLv - i * 0.28);
      const spool = new CylinderGeometry(0.035, 0.035, 0.08, 8);
      spool.rotateX(Math.PI / 2);
      spool.rotateY(yaw);
      spool.translate(pt.x, pt.y, pt.z);
      bag.add(porcelain, spool);
      o.lv.push(pt);
    }
    bag.add(galv, rod(base.clone().setY(yLv + 0.1), base.clone().addScaledVector(road, rAt(yLv) + 0.14).setY(yLv + 0.1), 0.012, 4));
    bag.add(galv, rod(base.clone().setY(yLv - 0.66), base.clone().addScaledVector(road, rAt(yLv) + 0.14).setY(yLv - 0.66), 0.012, 4));
    const yTel = top - 4.4;
    for (let i = 0; i < 3; i++) {
      const pt = base.clone().addScaledVector(road, rAt(yTel) + 0.16 + i * 0.05).setY(yTel - i * 0.32);
      o.tel.push(pt);
      bag.add(galv, rod(base.clone().setY(pt.y), pt, 0.014, 4), false);
    }
    if (p.transformer) {
      const ty = top - 3.1;
      const tc = base.clone().addScaledVector(side, 0.52).setY(ty);
      const body = new CylinderGeometry(0.26, 0.26, 0.9, 16);
      body.translate(tc.x, tc.y, tc.z);
      bag.add(grey, body);
      const lid = new CylinderGeometry(0.2, 0.28, 0.12, 16);
      lid.translate(tc.x, tc.y + 0.51, tc.z);
      bag.add(grey, lid);
      for (let i = 0; i < 3; i++) {
        const bush = new CylinderGeometry(0.03, 0.04, 0.22, 6);
        bush.translate(tc.x + (i - 1) * 0.12 * side.x, tc.y + 0.66, tc.z + (i - 1) * 0.12 * side.z);
        bag.add(porcelain, bush);
      }
      bag.add(galv, rod(base.clone().setY(ty + 0.3), tc.clone().setY(ty + 0.3), 0.03, 4));
      bag.add(galv, rod(base.clone().setY(ty - 0.3), tc.clone().setY(ty - 0.3), 0.03, 4));
      // Leads up to the arm.
      if (o.hv.length) for (let i = 0; i < 3; i++) bag.add(black, cable(tc.clone().setY(ty + 0.75).addScaledVector(side, (i - 1) * 0.12), o.hv[i].clone().setY(o.hv[i].y - 0.1), 0.15, 0.007, 6), false);
    }
    if (p.lamp) {
      // LED street lamp on a short arm toward the road.
      const ly0 = p.y + 5.4;
      const a = base.clone().addScaledVector(road, rAt(5.4)).setY(ly0);
      const b = base.clone().addScaledVector(road, p.lamp).setY(ly0 + 0.35);
      bag.add(white, pipe(a, b, 0.024, 8));
      const head = box(0.5, 0.07, 0.2);
      head.rotateY(yaw + Math.PI / 2);
      head.translate(b.x, b.y - 0.02, b.z);
      bag.add(white, head);
      const lens = box(0.4, 0.01, 0.14);
      lens.rotateY(yaw + Math.PI / 2);
      lens.translate(b.x, b.y - 0.06, b.z);
      bag.add(lib.plain(0xdfe4ea, 0.2), lens, false);
    }
    out.push(o);
  }

  // ---------------------------------------------------------- wires
  // Thin cables need only three sides; the sag needs ~1 segment per 1.3 m.
  const wire = (a: Vector3, b: Vector3, sag: number, radius: number) => {
    const pts: Vector3[] = [];
    const n = Math.max(6, Math.min(16, Math.round(a.distanceTo(b) / 1.3)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(new Vector3().lerpVectors(a, b, t).setY(a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t)));
    }
    bag.add(black, new TubeGeometry(new CatmullRomCurve3(pts), n, radius, radius > 0.015 ? 4 : 3, false), false);
  };
  const span = (i: number, j: number, hv = true) => {
    const A0 = out[i];
    const B0 = out[j];
    if (hv && A0.hv.length && B0.hv.length) for (let k = 0; k < 3; k++) wire(A0.hv[k], B0.hv[k], 0.35, 0.007);
    for (let k = 0; k < 3; k++) wire(A0.lv[k], B0.lv[k], 0.45, k === 0 ? 0.012 : 0.009);
    for (let k = 0; k < 3; k++) wire(A0.tel[k], B0.tel[k], 0.55 + k * 0.1, k === 0 ? 0.03 : 0.018);
  };
  span(1, 2);
  span(2, 3);
  span(3, 4);
  span(4, 7);
  span(4, 8);
  span(5, 6);
  // Across the lane to the pole at the foot, and on from it.
  span(1, 0, false);
  // Extra fibre and coax bundled on the west side, and a lashed bundle.
  for (let k = 0; k < 3; k++) {
    const a = out[1].tel[1].clone().add(v3(0, -0.5 - k * 0.2, 0));
    const b = out[2].tel[1].clone().add(v3(0, -0.5 - k * 0.2, 0));
    wire(a, b, 0.6 + k * 0.08, 0.014);
    const c = out[3].tel[1].clone().add(v3(0, -0.5 - k * 0.2, 0));
    wire(b, c, 0.62 + k * 0.08, 0.014);
  }
  // Leaving the view: plateau street spans east and west, beyond the junction.
  const far = (o: PoleOut, dir: Vector3, len: number) => {
    for (const set of [o.hv, o.lv, o.tel]) for (const p of set) wire(p, p.clone().addScaledVector(dir, len).setY(p.y + 0.1), 0.5, set === o.tel ? 0.02 : 0.009);
  };
  far(out[5], v3(1, 0, 0), 26);
  far(out[6], v3(-1, 0, 0), 26);
  far(out[7], v3(1, 0, 0), 30);
  far(out[8], v3(-1, 0, 0), 30);
  // Service drops to the houses along the lane.
  const drops: [number, number, number, number][] = [
    [1, 3.0, 4.9, -19.5],
    [1, -2.95, 5.4, -21.0],
    [1, 3.4, 5.1, -27.5],
    [2, 3.1, 5.0, -35.0],
    [2, -3.1, 4.8, -35.4],
    [2, 3.4, 4.7, -44.0],
    [2, -3.0, 5.2, -44.2],
    [3, 3.0, 5.4, -53.0],
    [3, -3.2, 4.6, -51.8],
    [3, 3.2, 4.9, -60.2],
    [3, -3.0, 4.9, -59.5],
  ];
  for (const [pi, x, hy, z] of drops) {
    const from = out[pi].lv[2];
    const to = v3(x, ly + hy, z);
    wire(from, to, 0.25, 0.007);
    wire(out[pi].tel[2], to.clone().add(v3(0, -0.35, 0.2)), 0.3, 0.006);
  }

  // Pole at the foot: blue evacuation plate, address plate, the no-through sign facing the junction.
  {
    const p = poles[0];
    const base = out[0].base;
    const rA = (y: number) => R0 + (R1 - R0) * (y / p.h);
    // Wrap-around plates face the lane (−x) and the junction (−z).
    const plate = new CylinderGeometry(rA(2.9) + 0.008, rA(2.0) + 0.008, 0.9, 10, 1, true, -1.2, 2.4);
    mapUV(plate, A.evac);
    plate.rotateY(-Math.PI / 2 - 0.5);
    plate.translate(base.x, ly + 2.45, base.z);
    bag.add(P, plate, false);
    const addr = new CylinderGeometry(rA(4.0) + 0.008, rA(3.1) + 0.008, 0.9, 10, 1, true, -1.2, 2.4);
    mapUV(addr, A.address);
    addr.rotateY(-Math.PI / 2 - 0.5);
    addr.translate(base.x, ly + 3.55, base.z);
    bag.add(P, addr, false);
    // Sign on a bracket, facing −z.
    const sc = base.clone().add(v3(-0.52, 2.2, -0.02));
    bag.add(P, place(card(0.9, 0.4, A.noThrough), sc.clone().add(v3(0, 0, -0.012)), Math.PI));
    const back = box(0.92, 0.42, 0.015);
    back.translate(sc.x, sc.y, sc.z);
    bag.add(grey, back);
    bag.add(galv, rod(base.clone().setY(sc.y + 0.1), sc.clone().add(v3(0.3, 0.1, 0.01)), 0.015, 5));
    bag.add(galv, rod(base.clone().setY(sc.y - 0.1), sc.clone().add(v3(0.3, -0.1, 0.01)), 0.015, 5));
  }

  // The street lamp at the stair head, on the left.
  {
    const b = v3(-2.45, 0, 0.75);
    const h = 5.2;
    bag.add(white, pipe(b, b.clone().setY(h), 0.06, 12));
    const base = new CylinderGeometry(0.09, 0.1, 0.35, 12);
    base.translate(b.x, 0.175, b.z);
    bag.add(white, base);
    const arm0 = b.clone().setY(h - 0.05);
    const arm1 = b.clone().add(v3(0.62, h + 0.1, -0.12));
    bag.add(white, pipe(arm0, arm1, 0.03, 8));
    const head = box(0.26, 0.06, 0.52);
    head.translate(arm1.x + 0.1, arm1.y, arm1.z);
    bag.add(white, head);
    const lens = box(0.2, 0.01, 0.44);
    lens.translate(arm1.x + 0.1, arm1.y - 0.035, arm1.z);
    bag.add(lib.plain(0xe4e8ee, 0.2), lens, false);
  }

  // Red vending machine at the foot on the right, facing the lane.
  {
    const c = v3(2.95, ly, -19.4);
    const body = box(0.72, 1.83, 1.0);
    body.translate(c.x + 0.36, ly + 0.915 + 0.06, c.z);
    bag.add(lib.paint(0xb8141a, 0.35), body);
    const plinth = box(0.76, 0.06, 1.04);
    plinth.translate(c.x + 0.36, ly + 0.03, c.z);
    bag.add(concrete, plinth);
    const face = card(0.96, 1.78, A.vending);
    place(face, v3(c.x - 0.002, ly + 0.97, c.z), -Math.PI / 2);
    bag.add(w.lit, face);
    const hood = box(0.1, 0.06, 1.0);
    hood.translate(c.x - 0.03, ly + 1.92, c.z);
    bag.add(lib.paint(0xb8141a, 0.35), hood);
    // Recycling bin beside it.
    const bin = new CylinderGeometry(0.2, 0.18, 0.75, 14);
    bin.translate(c.x + 0.25, ly + 0.375, c.z - 0.75);
    bag.add(lib.plain(0x1f6fd1, 0.4), bin);
  }

  // Orange curve mirror at the junction corner.
  {
    const b = v3(-2.95, ly, -62.4);
    const orange = lib.paint(0xe2621b, 0.4);
    bag.add(orange, pipe(b, b.clone().setY(ly + 3.3), 0.038, 10));
    const yaw = Math.atan2(0.75, 0.66);
    const mc = b.clone().add(v3(0.15, 3.05 - ly + ly, 0.1)).setY(ly + 3.05);
    const disc = new SphereGeometry(0.42, 18, 8, 0, Math.PI * 2, 0, 0.5);
    disc.rotateX(Math.PI / 2);
    disc.rotateY(yaw);
    disc.translate(mc.x, mc.y, mc.z);
    bag.add(lib.plain(0xe8ecef, 0.03, 1.0), disc);
    const rim = mapUV(new CircleGeometry(0.46, 24), A.mirrorRim);
    rim.rotateY(yaw);
    rim.translate(mc.x - Math.sin(yaw) * 0.02, mc.y, mc.z - Math.cos(yaw) * 0.02);
    bag.add(P, rim, false);
    const back = new CylinderGeometry(0.46, 0.46, 0.06, 24);
    back.rotateX(Math.PI / 2);
    back.rotateY(yaw);
    back.translate(mc.x - Math.sin(yaw) * 0.06, mc.y, mc.z - Math.cos(yaw) * 0.06);
    bag.add(orange, back);
    bag.add(orange, rod(b.clone().setY(ly + 3.05), mc.clone().addScaledVector(v3(Math.sin(yaw), 0, Math.cos(yaw)), -0.08), 0.03, 6));
  }

  // 須賀神社 stone pillar and the notice board at the foot on the left.
  {
    const c = v3(-2.3, ly, STAIRS.bottomZ - 0.7);
    const plinth = box(0.56, 0.2, 0.56);
    plinth.translate(c.x, ly + 0.1, c.z);
    bag.add(lib.cutStone(), plinth);
    const g = box(0.3, 1.9, 0.3);
    g.translate(c.x, ly + 0.2 + 0.95, c.z);
    bag.add(lib.granite([0.85, 0.84, 0.82]), g);
    const top = new CylinderGeometry(0.0, 0.22, 0.08, 4);
    top.rotateY(Math.PI / 4);
    top.translate(c.x, ly + 2.14, c.z);
    bag.add(lib.granite([0.85, 0.84, 0.82]), top);
    for (const [yaw, off] of [
      [Math.PI, v3(0, 0, -0.152)],
      [Math.PI / 2, v3(0.152, 0, 0)],
    ] as const) {
      bag.add(P, place(card(0.24, 1.3, A.pillar), c.clone().add(off).setY(ly + 1.35), yaw), false);
    }
    // Notice board (掲示板) on two posts with a small roof, against the cut-stone wall.
    const bc = v3(-2.5, ly, -18.5);
    const wood = lib.paint(0x5a4632, 0.6);
    for (const dz of [-0.62, 0.62]) {
      const post = box(0.07, 1.9, 0.07);
      post.translate(bc.x, ly + 0.95, bc.z + dz);
      bag.add(wood, post);
    }
    const panel = box(0.04, 0.88, 1.24);
    panel.translate(bc.x - 0.01, ly + 1.35, bc.z);
    bag.add(wood, panel);
    bag.add(P, place(card(1.16, 0.8, A.board), bc.clone().add(v3(0.013, 1.35, 0)), Math.PI / 2), false);
    const roof = box(0.34, 0.03, 1.46);
    roof.rotateZ(0.25);
    roof.translate(bc.x + 0.1, ly + 1.86, bc.z);
    bag.add(lib.sheetRoof(0x4a4f52), roof);
  }

  bag.emit(w);
  buildFronts(w);
}

/**
 * The lane's edges: low block walls and gates in front of the houses,
 * potted plants, and a few bicycles' worth of clutter kept as simple shapes.
 */
function buildFronts(w: SugaWorld): void {
  const lib = w.lib;
  const r = new Rng(91);
  const bag = new Bag();
  const block = lib.block();
  const coping = lib.concrete([0.92, 0.91, 0.88], false);
  const ly = LANE.y;
  const pots = [lib.plain(0x9c5b35, 0.7), lib.plain(0x3b3f3a, 0.6), lib.plain(0xd8d4c8, 0.5), lib.plain(0x2f4a7a, 0.5)];
  const leaves = foliage(w);
  const leafCards = leaves.begin();
  for (const s of [-1, 1]) {
    for (let z = STAIRS.bottomZ - 3.2; z > -61; ) {
      const len = r.range(2.5, 6);
      const gapAfter = r.range(0.9, 1.6);
      const z1 = z;
      const z0 = Math.max(-61.5, z - len);
      z = z0 - gapAfter;
      // Leave the vending machine and the pole clear.
      if (s > 0 && z1 > -21 && z0 < -18) continue;
      if (r.chance(0.3)) continue;
      const h = r.pick([0.8, 1.0, 1.2, 1.2]);
      const x = s * 2.72;
      const wall = box(0.12, h, z1 - z0);
      wall.translate(x, ly + h / 2, (z0 + z1) / 2);
      bag.add(block, wall);
      const cap = box(0.16, 0.05, z1 - z0);
      cap.translate(x, ly + h + 0.025, (z0 + z1) / 2);
      bag.add(coping, cap);
      // Pots along the wall.
      if (r.chance(0.6)) {
        const n = r.int(2, 5);
        for (let i = 0; i < n; i++) {
          const pz = z0 + 0.3 + r.next() * (z1 - z0 - 0.6);
          const pr = r.range(0.12, 0.2);
          const ph = r.range(0.2, 0.34);
          const pot = new CylinderGeometry(pr, pr * 0.78, ph, 12);
          pot.translate(x - s * (0.22 + pr), ly + ph / 2, pz);
          bag.add(r.pick(pots), pot);
          leaves.clump(leafCards, r, v3(x - s * (0.22 + pr), ly + ph + pr * 0.9, pz), pr * 1.6, 7);
        }
      }
    }
  }
  bag.emit(w);
  leaves.end(leafCards);
}
