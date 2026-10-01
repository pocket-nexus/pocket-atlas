import { BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, Vector3 } from "three";
import type { AtlasRect } from "../../shared/atlas";
import { merge } from "../../shared/shapes";
import { marking, stationBoard, tactile } from "../gfx/art";
import { Bag, type KamakuraWorld } from "./context";
import { ROAD_Y } from "./coast";
import { CROSSING, PLATFORM, slopeEdges, slopeY, TRACK } from "./layout";
import { hillY } from "./terrain";
import { place, ribbon, stations, wallAlong } from "./util";

/**
 * 日坂, the slope road from the crossing up toward Kamakura High School:
 * its 10 % carriageway, the narrow east sidewalk at the foot of the rock
 * walls, the steel drain grating along the kerb, the zebra crossing and stop
 * line above the crossing; the paved north-west corner; Koshigoe Rakko Park
 * behind its clipped hedge; the footway west along the track to the station
 * and the station's single platform.
 */

/** Grating along the east kerb: steel bars over a dark channel. */
function grating(g: CanvasRenderingContext2D, cw: number, ch: number): void {
  g.fillStyle = "#1c1b1a";
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = "#5a5650";
  for (let y = 0; y < ch; y += 6) g.fillRect(0, y, cw, 3);
  g.fillStyle = "#3e3b37";
  g.fillRect(0, 0, 3, ch);
  g.fillRect(cw - 3, 0, 3, ch);
}

/** A horizontal quad at height y spanning x0..x1 and north n0..n1 (atlas-mapped). */
function pad(x0: number, x1: number, n0: number, n1: number, y: (x: number, n: number) => number, cell?: AtlasRect): BufferGeometry {
  const pts = [
    [x0, n0],
    [x1, n0],
    [x1, n1],
    [x0, n1],
  ];
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pts.flatMap(([x, n]) => [x, y(x, n), -n]), 3));
  g.setAttribute("normal", new Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  const c = cell ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
  g.setAttribute("uv", new Float32BufferAttribute([c.u0, c.v0, c.u1, c.v0, c.u1, c.v1, c.u0, c.v1], 2));
  // (x0, n0) → (x1, n0) → (x1, n1): x right, n north (−z) → counter-clockwise from above.
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Road height at (x, north): the survey profile across the whole width. */
const roadY = (n: number) => slopeY(n) + ROAD_Y;

export function buildSlope(w: KamakuraWorld): void {
  const lib = w.lib;
  const bag = new Bag();
  const P = w.printed;
  const asphalt = lib.asphalt();
  const concrete = lib.concrete();
  const white = w.draw("paint-white", 128, 128, marking("#e2e1da", 3));
  const grate = w.draw("grating", 128, 512, grating);

  // ---- carriageway: rows across the road every 2 m (5 m higher up).
  const deckN = -CROSSING.deck[0];
  const ns: number[] = [];
  for (let n = deckN; n < 206; n += n < 70 ? 2 : 5) ns.push(n);
  ns.push(206);
  const walkFrom = 3.2;
  const walkTo = 22.5;
  const pos: number[] = [];
  const idx: number[] = [];
  const cols = 4;
  for (const n of ns) {
    const [xw, xe] = slopeEdges(n);
    const xs = n > walkFrom && n < walkTo ? xe - 1.05 : xe;
    const xm = (xw + xs) / 2;
    const crown = Math.min(0.06, (xs - xw) * 0.008);
    for (const [x, dy] of [
      [xw, 0],
      [xm - 1, crown],
      [xm + 1, crown],
      [xs, 0],
    ] as [number, number][])
      pos.push(x, roadY(n) + dy, -n);
  }
  for (let j = 0; j < ns.length - 1; j++)
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      // x increasing, north increasing (−z): (a, a+1, a+cols) faces up.
      idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
    }
  const road = new BufferGeometry();
  road.setAttribute("position", new Float32BufferAttribute(pos, 3));
  road.setIndex(idx);
  road.computeVertexNormals();
  bag.add(asphalt, road);

  // ---- the east sidewalk at the foot of the walls, with its kerb.
  {
    const sp: number[] = [];
    const si: number[] = [];
    const kp: number[] = [];
    const kn: number[] = [];
    let k = 0;
    for (let n = walkFrom; n <= walkTo; n += 1.5) {
      const [, xe] = slopeEdges(n);
      const y = roadY(n) + 0.13;
      sp.push(xe - 1.05, y, -n, xe, y, -n);
      kp.push(xe - 1.05, roadY(n), -n, xe - 1.05, y, -n);
      if (k > 0) {
        const a = (k - 1) * 2;
        si.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        kn.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      k++;
    }
    const walk = new BufferGeometry();
    walk.setAttribute("position", new Float32BufferAttribute(sp, 3));
    walk.setIndex(si);
    walk.computeVertexNormals();
    bag.add(asphalt, walk);
    const kerb = new BufferGeometry();
    kerb.setAttribute("position", new Float32BufferAttribute(kp, 3));
    kerb.setIndex(kn);
    kerb.computeVertexNormals();
    bag.add(concrete, kerb);
  }

  // ---- drain grating along the east kerb, from the crossing to the camera's corner.
  for (let n = 4; n < 60; n += 4) {
    const n1 = Math.min(60, n + 4);
    const [, e0] = slopeEdges(n);
    const xe = (n > walkFrom && n < walkTo ? e0 - 1.05 : e0) - 0.02;
    bag.add(P, pad(xe - 0.4, xe, n, n1, (_x, nn) => roadY(nn) + 0.012, grate), false);
  }

  // ---- markings: stop line for the southbound lane and the zebra above the crossing.
  {
    const [xw, xe] = slopeEdges(4.4);
    const mid = (xw + xe) / 2 + 0.6;
    bag.add(P, pad(mid, xe - 1.2, 4.1, 4.45, (_x, n) => roadY(n) + 0.075, white), false);
    const [zw, ze] = slopeEdges(7.5);
    for (let x = zw + 0.5; x < ze - 1.3; x += 0.9) bag.add(P, pad(x, x + 0.45, 5.7, 9.3, (_x, n) => roadY(n) + 0.075, white), false);
  }

  // ---- manhole covers and the turn arrow in the northbound lane (p01).
  const manhole = w.draw("manhole", 128, 128, (g, cw, ch) => {
    g.clearRect(0, 0, cw, ch);
    g.fillStyle = "#3a3936";
    g.beginPath();
    g.arc(cw / 2, ch / 2, cw / 2 - 1, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#57554f";
    g.lineWidth = 2;
    for (let k = 1; k < 4; k++) {
      g.beginPath();
      g.arc(cw / 2, ch / 2, (cw / 2 - 1) * (k / 4), 0, Math.PI * 2);
      g.stroke();
    }
  });
  for (const [x, n] of [
    [0.6, 6.6],
    [0.9, 15.5],
    [0.2, 33],
  ]) bag.add(w.cut, pad(x - 0.35, x + 0.35, n - 0.35, n + 0.35, (_x, nn) => roadY(nn) + 0.075, manhole), false);
  const arrow = w.draw("lane-arrow", 512, 128, (g, cw, ch) => {
    g.clearRect(0, 0, cw, ch);
    g.fillStyle = "#e2e1da";
    g.fillRect(cw * 0.18, ch * 0.38, cw * 0.78, ch * 0.24);
    g.beginPath();
    g.moveTo(0, ch / 2);
    g.lineTo(cw * 0.22, ch * 0.05);
    g.lineTo(cw * 0.22, ch * 0.95);
    g.closePath();
    g.fill();
  });
  bag.add(w.cut, pad(-2.9, 0.1, 23.6, 24.6, (_x, nn) => roadY(nn) + 0.075, arrow), false);

  // ---- the paved north-west corner and the green pedestrian strip's approach.
  bag.add(lib.paving(), pad(-12.5, CROSSING.strip[0] - 0.02, -CROSSING.deck[0], 9.5, () => 0.24));
  // Kerb along the corner's road edge.
  const kerb = new BoxGeometry(0.18, 0.2, 7.5);
  bag.add(concrete, place(kerb, new Vector3(CROSSING.strip[0] - 0.1, 0.14, -5.6)));

  // ---- Koshigoe Rakko Park: clipped hedge along the road, lawn, shrubs, benches.
  park(w, bag);

  // ---- footway west along the track to the station entrance, behind a pipe railing.
  footway(w, bag);
  station(w, bag);

  bag.emit(w);
}

/** A clipped hedge as a box lofted along a path of (x, z, ground y) points. */
function hedge(path: Vector3[], width: number, height: number): BufferGeometry {
  const pos: number[] = [];
  const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  const ring = path.map((p, i) => {
    const q = path[Math.min(path.length - 1, i + 1)];
    const o = path[Math.max(0, i - 1)];
    const t = new Vector3().subVectors(q, o).setY(0).normalize();
    const n = new Vector3(-t.z, 0, t.x).multiplyScalar(width / 2);
    // Slightly rounded top: the shoulders sit lower than the crown.
    return [p.clone().sub(n), p.clone().sub(n).setY(p.y + height * 0.9), p.clone().setY(p.y + height), p.clone().add(n).setY(p.y + height * 0.9), p.clone().add(n)];
  });
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    for (let k = 0; k < 4; k++) quad(a[k], b[k], b[k + 1], a[k + 1]);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function park(w: KamakuraWorld, bag: Bag): void {
  const lib = w.lib;
  const shrub = lib.shrub();
  // Clipped hedge along the park's road frontage (on a low kerb), and round its south side.
  const front: Vector3[] = [];
  for (let n = 9.6; n <= 24; n += 1.2) {
    const [xw] = slopeEdges(n);
    front.push(new Vector3(xw - 0.65, slopeY(n) + 0.12, -n));
  }
  bag.add(shrub, hedge(front, 1.0, 1.0));
  const south: Vector3[] = [];
  for (let x = -6.2; x >= -28; x -= 2) south.push(new Vector3(x, hillY(x, -9.8) + 0.05, -9.8 - (x + 6) * 0.06));
  bag.add(shrub, hedge(south, 0.9, 0.9));
  // Two benches facing the sea.
  for (const [x, n] of [
    [-14, 11.6],
    [-21, 12.0],
  ]) {
    const y = hillY(x, -n);
    bag.add(w.printed, w.tint(place(new BoxGeometry(1.6, 0.05, 0.42), new Vector3(x, y + 0.44, -n)), "wood"));
    bag.add(w.printed, w.tint(place(new BoxGeometry(1.6, 0.35, 0.05), new Vector3(x, y + 0.72, -n - 0.22)), "wood"));
    for (const dx of [-0.65, 0.65]) bag.add(w.printed, w.tint(place(new BoxGeometry(0.06, 0.44, 0.4), new Vector3(x + dx, y + 0.22, -n)), "black"), false);
  }
}

function footway(w: KamakuraWorld, bag: Bag): void {
  const lib = w.lib;
  const galv = lib.paint("galv");
  const us = stations(-104, -7.2, 3, 3, 3);
  bag.add(lib.paving(), ribbon(TRACK, us, [-6.9, -4.4], () => 0.34));
  // Pipe railing along the track side (0.9 m), posts every 2 m.
  const rails: BufferGeometry[] = [];
  const p = new Vector3();
  for (let i = 0; i < us.length - 1; i++) {
    const a = TRACK.offset(us[i], -3.6, new Vector3());
    const b = TRACK.offset(us[i + 1], -3.6, new Vector3());
    for (const h of [0.5, 0.95]) {
      const g = new CylinderGeometry(0.025, 0.025, a.distanceTo(b), 5, 1, true);
      g.rotateZ(Math.PI / 2);
      g.rotateY(-Math.atan2(b.z - a.z, b.x - a.x));
      g.translate((a.x + b.x) / 2, 0.3 + h, (a.z + b.z) / 2);
      rails.push(g);
    }
  }
  for (let u = -104; u < -7; u += 2) {
    TRACK.offset(u, -3.6, p);
    const g = new CylinderGeometry(0.03, 0.03, 1.0, 5, 1, true);
    g.translate(p.x, 0.3 + 0.5, p.z);
    rails.push(g);
  }
  bag.add(galv, merge(rails), false);
  // Clipped hedge on the footway's north side, against the hospital and apartment lots.
  const line: Vector3[] = [];
  for (const u of stations(-100, -14, 3, 3, 3)) {
    const q = TRACK.offset(u, -7.5, new Vector3());
    line.push(q.setY(hillY(q.x, q.z) + 0.05));
  }
  bag.add(lib.shrub(), hedge(line, 1.1, 1.2));
}

/**
 * Kamakura-Kōkōmae station (EN08): one platform on the land side, 64 m long,
 * with a timber-post shelter, benches, the teal name board at the east end
 * and the small white hut by the entrance.
 */
function station(w: KamakuraWorld, bag: Bag): void {
  const lib = w.lib;
  const concrete = lib.concrete();
  const uE = TRACK.project(PLATFORM.east, 0);
  const uW = TRACK.project(PLATFORM.west, 0);
  const us = stations(uW, uE, 4, 4, 4);
  const top = () => PLATFORM.height;
  // Deck, edge face and tactile strip.
  bag.add(lib.paving(), ribbon(TRACK, us, [PLATFORM.back, PLATFORM.edge], top, { flip: false }));
  const face: number[] = [];
  const fi: number[] = [];
  us.forEach((u, i) => {
    const p = TRACK.offset(u, PLATFORM.edge, new Vector3());
    face.push(p.x, -0.3, p.z, p.x, PLATFORM.height, p.z);
    if (i) {
      const a = (i - 1) * 2;
      fi.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  });
  const fg = new BufferGeometry();
  fg.setAttribute("position", new Float32BufferAttribute(face, 3));
  fg.setIndex(fi);
  fg.computeVertexNormals();
  bag.add(concrete, fg);
  const tac = w.draw("tactile", 256, 256, tactile);
  bag.add(w.printed, ribbon(TRACK, us, [PLATFORM.edge - 0.9, PLATFORM.edge - 0.6], () => PLATFORM.height + 0.006, { atlas: tac }), false);
  // Shelter: timber posts every 4 m on the back line, a shallow roof sloping to the track.
  const posts: BufferGeometry[] = [];
  const p = new Vector3();
  for (let u = uW + 6; u < uE - 4; u += 4) {
    TRACK.offset(u, PLATFORM.back + 0.5, p);
    posts.push(place(new BoxGeometry(0.16, 2.5, 0.16), p.clone().setY(PLATFORM.height + 1.25)));
  }
  bag.add(w.printed, w.tint(merge(posts), "wood"));
  bag.add(w.printed, w.tint(ribbon(TRACK, stations(uW + 5, uE - 3, 4, 4, 4), [PLATFORM.back - 0.2, PLATFORM.edge - 0.35], (_u, s) => PLATFORM.height + 2.55 - (s - (PLATFORM.back - 0.2)) * 0.08), "dark"));
  // Back wall of the shelter (boards) and benches.
  bag.add(w.printed, w.tint(wallAlong(TRACK, stations(uW + 5, uE - 3, 4, 4, 4), PLATFORM.back + 0.33, () => PLATFORM.height, () => PLATFORM.height + 2.4, 1), "wood"));
  // Name board at the east end, facing the track.
  const board = w.draw("station-name", 1024, 384, stationBoard);
  TRACK.offset(uE - 2.5, PLATFORM.back + 0.4, p);
  const t = TRACK.tangent(uE - 2.5, new Vector3());
  const plane = new BoxGeometry(2.0, 0.75, 0.04);
  const uv = plane.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setXY(i, board.u0 + uv.getX(i) * (board.u1 - board.u0), board.v0 + uv.getY(i) * (board.v1 - board.v0));
  bag.add(w.printed, place(plane, p.clone().setY(PLATFORM.height + 2.1), Math.atan2(t.x, t.z) + Math.PI / 2));
  // The entrance plaza east of the platform, its granite block wall, the canopy and the white hut.
  bag.add(lib.paving(), ribbon(TRACK, stations(uE - 1, uE + 9, 2, 2, 2), [-12.5, PLATFORM.back], () => 0.34));
  bag.add(lib.block(), wallAlong(TRACK, stations(uE - 6, uE + 9, 3, 3, 3), -12.5, () => 0.3, () => 3.2, 1));
  TRACK.offset(uE + 1.5, -9.8, p);
  const yaw = Math.atan2(t.x, t.z);
  bag.add(lib.stucco("white"), place(new BoxGeometry(2.4, 2.5, 2.0), p.clone().setY(0.34 + 1.25), yaw));
  bag.add(w.printed, w.tint(place(new BoxGeometry(2.8, 0.12, 2.4), p.clone().setY(0.34 + 2.56), yaw), "dark"));
  const canopy = TRACK.offset(uE - 2.5, -8, new Vector3());
  bag.add(w.printed, w.tint(place(new BoxGeometry(4.5, 0.12, 6.0), canopy.clone().setY(3.4), yaw), "dark"));
  for (const [du, ds] of [
    [-2, -2.6],
    [2, -2.6],
    [-2, 2.6],
    [2, 2.6],
  ]) {
    const q = TRACK.offset(uE - 2.5 + du, -8 + ds, new Vector3());
    bag.add(w.printed, w.tint(place(new BoxGeometry(0.14, 3.1, 0.14), q.setY(0.34 + 1.55)), "wood"));
  }
}
