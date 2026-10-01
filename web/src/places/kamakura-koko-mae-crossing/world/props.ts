import { BoxGeometry, BufferGeometry, CircleGeometry, CylinderGeometry, LatheGeometry, PlaneGeometry, SphereGeometry, Vector2, Vector3, type Material } from "three";
import { mapUV, type AtlasRect } from "../../shared/atlas";
import { cable } from "../../shared/geo";
import { rod } from "../../shared/shapes";
import { crossingSign, mapBoard, noParking, solid, speed50 } from "../gfx/art";
import { Bag, type KamakuraWorld, type SOLIDS } from "./context";
import { COAST, SECTION, slopeEdges, slopeY, TRACK } from "./layout";
import { hillY } from "./terrain";

/**
 * Street furniture and overhead lines: the Enoden's catenary (dark-brown
 * steel poles with bent-pipe arms, messenger and contact wire with
 * droppers, feeders above), the concrete distribution poles on both sides
 * of the slope with their wires, the thick black twisted cable that sags
 * across the road at the crossing, the curve mirror on its orange pole, the
 * road signs and city map boards, Route 134's street lamps and the
 * signalised pedestrian crossing west of the junction.
 */

function place(g: BufferGeometry, p: Vector3, yaw = 0): BufferGeometry {
  if (yaw) g.rotateY(yaw);
  g.translate(p.x, p.y, p.z);
  return g;
}

function card(w: number, h: number, cell: AtlasRect): BufferGeometry {
  return mapUV(new PlaneGeometry(w, h), cell);
}

/** Concrete distribution pole with a crossarm; returns attachment points (top wires, lower wires). */
type Add = (m: Material | keyof typeof SOLIDS, g: BufferGeometry, cast?: boolean) => void;

function utilityPole(add: Add, concrete: Material, base: Vector3, h: number, armYaw: number, transformer = false): { top: Vector3[]; low: Vector3[] } {
  const shaft = new CylinderGeometry(0.1, 0.19, h, 12, 1, true);
  shaft.translate(base.x, base.y + h / 2, base.z);
  add(concrete, shaft);
  const along = new Vector3(Math.cos(armYaw), 0, -Math.sin(armYaw));
  const ya = base.y + h - 0.4;
  const c = base.clone().setY(ya);
  add("galv", rod(c.clone().addScaledVector(along, -1.0), c.clone().addScaledVector(along, 1.0), 0.04, 4));
  const top: Vector3[] = [];
  for (const s of [-0.9, 0, 0.9]) {
    const p = c.clone().addScaledVector(along, s);
    const ins = new LatheGeometry([new Vector2(0.02, 0), new Vector2(0.05, 0.03), new Vector2(0.03, 0.06), new Vector2(0.045, 0.1), new Vector2(0.015, 0.14)], 6);
    ins.translate(p.x, p.y + 0.03, p.z);
    add("white", ins, false);
    top.push(p.clone().setY(p.y + 0.15));
  }
  // Low-voltage and telecom lines on the pole body.
  const low: Vector3[] = [];
  for (let i = 0; i < 4; i++) low.push(base.clone().setY(base.y + h - 2.2 - i * 0.55).addScaledVector(along, (i % 2 ? -0.18 : 0.18)));
  if (transformer) {
    const side = new Vector3(-along.z, 0, along.x);
    const tc = base.clone().setY(base.y + h - 3.2).addScaledVector(side, 0.5);
    const body = new CylinderGeometry(0.25, 0.25, 0.85, 12);
    body.translate(tc.x, tc.y, tc.z);
    add("grey", body);
    add("galv", rod(base.clone().setY(tc.y + 0.3), tc.clone().setY(tc.y + 0.3), 0.03, 4), false);
  }
  return { top, low };
}

export function buildProps(w: KamakuraWorld): void {
  const lib = w.lib;
  const bag = new Bag();
  const P = w.printed;
  const concrete = lib.concrete();
  const galv = "galv" as const;
  const black = "black" as const;
  const brown = "brown" as const;
  // Small props paint from the printed atlas (one draw per chunk with the signs).
  const add: Add = (m, g, cast = true) => (typeof m === "string" ? bag.add(P, w.tint(g, m), cast) : bag.add(m, g, cast));

  // ------------------------------------------------------------ catenary
  // Poles on the track's south side every ~35 m: dark-brown steel, bent-pipe arm over the track.
  const wireMess: Vector3[] = [];
  const wireCont: Vector3[] = [];
  const catU: number[] = [];
  for (let u = -210; u <= 290; u += 35) if (Math.abs(u - 0) > 4) catU.push(u);
  catU.push(9.5);
  catU.sort((a, b) => a - b);
  for (const u of catU) {
    const base = TRACK.offset(u, 2.3, new Vector3()).setY(-0.3);
    const t = TRACK.tangent(u, new Vector3());
    const n = new Vector3(-t.z, 0, t.x);
    const top = base.clone().setY(7.6);
    add(brown, rod(base, top, 0.11, 8));
    // Bent-pipe arm reaching over the track and its stay.
    const armStart = base.clone().setY(6.15);
    const armEnd = armStart.clone().addScaledVector(n, -2.6);
    add(brown, rod(armStart, armEnd, 0.035, 5), false);
    add(brown, rod(base.clone().setY(6.9), armEnd.clone().setY(6.1), 0.025, 5), false);
    // Feeder brackets near the top.
    add(brown, rod(top.clone().setY(7.3).addScaledVector(n, 0.6), top.clone().setY(7.3).addScaledVector(n, -0.6), 0.03, 4), false);
    wireMess.push(TRACK.point(u, new Vector3()).setY(5.95));
    wireCont.push(TRACK.point(u, new Vector3()).setY(5.05));
  }
  // Messenger and contact wire sag a little between poles; droppers every ~5 m.
  for (let i = 0; i < catU.length - 1; i++) {
    const a = wireMess[i];
    const b = wireMess[i + 1];
    add(black, cable(a, b, 0.25, 0.008, 10), false);
    add(black, cable(wireCont[i], wireCont[i + 1], 0.02, 0.007, 6), false);
    const span = catU[i + 1] - catU[i];
    for (let k = 1; k < Math.round(span / 5); k++) {
      const f = k / Math.round(span / 5);
      const top = new Vector3().lerpVectors(a, b, f);
      top.y -= 0.25 * 4 * f * (1 - f);
      const bot = new Vector3().lerpVectors(wireCont[i], wireCont[i + 1], f);
      add(black, rod(top, bot, 0.006, 3), false);
    }
  }
  // Two feeders along the track at 7.3 m (the two horizontal cables above the sea in the canonical view).
  for (const off of [0.45, -0.45]) {
    for (let i = 0; i < catU.length - 1; i++) {
      const a = TRACK.offset(catU[i], 2.3 + off, new Vector3()).setY(7.3);
      const b = TRACK.offset(catU[i + 1], 2.3 + off, new Vector3()).setY(7.3);
      add(black, cable(a, b, 0.35, 0.016, 10), false);
    }
  }

  // ------------------------------------------------------------ distribution poles
  // North-west corner pole (transformer), the pole on the east bank above the slope, one further up each side.
  const nw = utilityPole(add, concrete, new Vector3(-11.6, 0.24, -4.8), 12.5, 0.15, true);
  const eBank = new Vector3(8.6, hillY(8.6, -40), -40);
  const ne = utilityPole(add, concrete, eBank, 12.0, 0.1);
  const nUp = new Vector3(-7.2, slopeY(72), -72);
  const nw2 = utilityPole(add, concrete, nUp, 12.5, 0.05, true);
  const eUp = new Vector3(5.2, hillY(5.2, -98), -98);
  const ne2 = utilityPole(add, concrete, eUp, 12.0, 0.05);
  // Thin wires cast no sun shadow (sub-pixel on the handheld's shadow map); the twisted cable does.
  const span = (a: Vector3[], b: Vector3[], sag: number, r: number) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) add(black, cable(a[i], b[i], sag, r, 14), false);
  };
  // Wires across the slope road and up it (the lines across the sky in the canonical view).
  span(nw.top, ne.top, 0.9, 0.009);
  span(nw.low, ne.low, 1.1, 0.012);
  span(ne.top, ne2.top, 0.8, 0.009);
  span(nw.top, nw2.top, 1.0, 0.009);
  span(nw.low, nw2.low, 1.2, 0.012);
  span(ne2.low, nw2.low, 1.0, 0.012);
  // Wires from the corner pole west along the footway and east along the track.
  const westEnd = TRACK.offset(-60, -7.5, new Vector3()).setY(9.5);
  for (const p of nw.low.slice(0, 2)) add(black, cable(p, westEnd.clone().setY(p.y - 1), 1.2, 0.012, 12), false);
  // The thick black twisted cable sagging across the road at the crossing, about 6.5 m up at its lowest.
  const cabA = TRACK.offset(9.5, 2.3, new Vector3()).setY(7.8);
  const cabB = nw.low[1].clone().setY(8.1);
  add(black, cable(cabA, cabB, 1.6, 0.05, 24), true);

  // ------------------------------------------------------------ curve mirror
  {
    const base = new Vector3(-4.75, 0.24, -12.6);
    const orange = w.draw("orange", 64, 64, solid("#e0601a"));
    const pole = new CylinderGeometry(0.038, 0.038, 2.75, 8, 1, true);
    mapUV(pole, orange);
    add(P, place(pole, base.clone().setY(base.y + 1.37)));
    // Mirror: convex disc facing up the slope (north-east), orange rim behind.
    const yaw = Math.PI - 0.3;
    const dir = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const c = base.clone().setY(base.y + 2.75).addScaledVector(dir, 0.08);
    const face = new SphereGeometry(0.45, 16, 6, 0, Math.PI * 2, 0, 0.42);
    face.rotateX(Math.PI / 2);
    face.translate(0, 0, -0.38);
    add(lib.mirror(), place(face, c, yaw));
    const rim = new CylinderGeometry(0.43, 0.43, 0.06, 18, 1, true);
    rim.rotateX(Math.PI / 2);
    mapUV(rim, orange);
    add(P, place(rim, c, yaw));
    const back = new CircleGeometry(0.43, 18);
    back.rotateY(Math.PI);
    mapUV(back, orange);
    add(P, place(back, c.clone().addScaledVector(dir, -0.03), yaw), false);
  }

  // ------------------------------------------------------------ signs on the slope road
  const A = {
    noParking: w.draw("no-parking", 256, 256, noParking),
    ped: w.draw("ped-crossing", 256, 256, (g, cw, ch) => crossingSign(g, cw, ch, false)),
    school: w.draw("school-crossing", 256, 256, (g, cw, ch) => crossingSign(g, cw, ch, true)),
    map1: w.draw("map-1", 512, 640, (g, cw, ch) => mapBoard(g, cw, ch, 1)),
    map2: w.draw("map-2", 512, 640, (g, cw, ch) => mapBoard(g, cw, ch, 2)),
    speed: w.draw("speed-50", 256, 256, speed50),
    grey: w.draw("grey", 64, 64, solid("#8d9194")),
  };
  const signPost = (x: number, n: number, y0: number, cells: [AtlasRect, number, number][], yaw: number) => {
    const base = new Vector3(x, y0, -n);
    const top = 2.2 + cells.length * 0.65;
    add(galv, rod(base, base.clone().setY(y0 + top), 0.03, 6), false);
    cells.forEach(([cell, wdt, hgt], i) => {
      const p = base.clone().setY(y0 + top - 0.35 - i * 0.7);
      const d = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const cut = cell === A.noParking || cell === A.speed;
      add(cut ? w.cut : P, place(card(wdt, hgt, cell), p.clone().addScaledVector(d, 0.035), yaw), false);
      const back = card(wdt * 0.98, hgt * 0.98, A.grey);
      back.rotateY(Math.PI);
      add(P, place(back, p.clone().addScaledVector(d, 0.03), yaw), false);
    });
  };
  // East sidewalk: the pedestrian-crossing sign above the zebra and the no-parking sign further up, facing down the slope… and up it.
  {
    const [, e9] = slopeEdges(9.5);
    signPost(e9 - 0.45, 9.5, slopeY(9.5) + 0.19, [[A.school, 0.6, 0.6]], Math.PI);
    const [, e24] = slopeEdges(26);
    signPost(e24 - 0.4, 26, slopeY(26) + 0.19, [[A.noParking, 0.6, 0.6]], Math.PI);
    const [w8] = slopeEdges(8.5);
    signPost(w8 - 0.3, 8.5, hillY(w8 - 0.3, -8.5), [[A.ped, 0.6, 0.6]], Math.PI);
  }
  // City map boards by the park corner, facing the road.
  for (const [cell, n] of [
    [A.map1, 14.2],
    [A.map2, 15.9],
  ] as [AtlasRect, number][]) {
    const [xw] = slopeEdges(n);
    const x = xw - 2.0;
    const y = hillY(x, -n);
    const yaw = 2.45;
    const p = new Vector3(x, y + 1.25, -n);
    add(P, place(card(0.9, 1.15, cell), p, yaw), false);
    const back = card(0.94, 1.19, A.grey);
    back.rotateY(Math.PI);
    add(P, place(back, p.clone().add(new Vector3(-Math.sin(yaw) * 0.02, 0, -Math.cos(yaw) * 0.02)), yaw), false);
    for (const s of [-0.48, 0.48]) {
      const lp = p.clone().add(new Vector3(Math.cos(yaw) * s, 0, -Math.sin(yaw) * s));
      add(black, rod(lp.clone().setY(y), lp.clone().setY(y + 1.9), 0.035, 6), false);
    }
  }

  // ------------------------------------------------------------ Route 134: street lamps, signals, speed sign
  for (let u = -156; u <= 264; u += 42) {
    const base = COAST.offset(u, 17.6, new Vector3()).setY(0.21);
    const t = COAST.tangent(u, new Vector3());
    const n = new Vector3(-t.z, 0, t.x);
    add(galv, rod(base, base.clone().setY(8.6), 0.08, 8));
    const tip = base.clone().setY(8.75).addScaledVector(n, -1.6);
    add(galv, rod(base.clone().setY(8.5), tip, 0.04, 5), false);
    add(galv, place(new BoxGeometry(0.6, 0.12, 0.28), tip.clone().setY(tip.y - 0.05), Math.atan2(t.x, t.z)));
  }
  const green = lib.glow(0x2bff9a, 3);
  const red = lib.glow(0xff2a1a, 3);
  for (const [s, armTo] of [[17.55, SECTION.lanes.west - 0.5]] as [number, number][]) {
    const u = -13.6;
    const base = COAST.offset(u, s, new Vector3()).setY(0.21);
    add(galv, rod(base, base.clone().setY(5.6), 0.09, 8));
    const arm = COAST.offset(u, armTo, new Vector3()).setY(5.4);
    add(galv, rod(base.clone().setY(5.4), arm, 0.05, 6), false);
    // Horizontal three-light vehicle signal, green lit, facing approaching traffic.
    const t = COAST.tangent(u, new Vector3());
    const facing = s > 10 ? 1 : -1;
    const yaw = Math.atan2(t.x * facing, t.z * facing);
    const head = new BoxGeometry(1.25, 0.42, 0.25);
    add(black, place(head, arm.clone().setY(5.65), yaw + Math.PI / 2));
    const lens = new CircleGeometry(0.13, 10);
    lens.rotateY(Math.atan2(t.x * facing, t.z * facing));
    const lp = arm.clone().setY(5.65).addScaledVector(t, 0.13 * facing).addScaledVector(new Vector3(-t.z, 0, t.x), 0.4);
    add(green, lens.translate(lp.x, lp.y, lp.z), false);
    // Pedestrian signal at the kerb, red.
    const ped = new BoxGeometry(0.3, 0.6, 0.22);
    const pp = base.clone().setY(2.8);
    add(black, place(ped, pp));
    const pl = new PlaneGeometry(0.24, 0.24);
    pl.rotateY(s > 10 ? Math.PI : 0);
    add(red, pl.translate(pp.x, pp.y + 0.13, pp.z + (s > 10 ? -0.115 : 0.115)), false);
  }
  {
    const base = COAST.offset(36, 17.7, new Vector3()).setY(0.21);
    add(galv, rod(base, base.clone().setY(2.6), 0.03, 6), false);
    const t = COAST.tangent(36, new Vector3());
    add(w.cut, place(card(0.6, 0.6, A.speed), base.clone().setY(2.3), Math.atan2(-t.x, -t.z)), false);
  }

  bag.emit(w);
}
