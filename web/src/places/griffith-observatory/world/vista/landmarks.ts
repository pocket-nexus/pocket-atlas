import { BufferGeometry, Color, Float32BufferAttribute, MeshBasicMaterial, MeshStandardMaterial, ShapeUtils, Vector2, type Material } from "three";
import { canvas, toTexture } from "../../../shared/canvas";
import { LightSet } from "../../../shared/lights";
import { merge } from "../../../shared/shapes";
import TOWERS from "../../data/towers.json";
import type { GriffithWorld } from "../context";
import { groundY } from "../dem";
import { local, LOOP } from "../layout";
import { metresPerPixel } from "./eyes";

/**
 * Landmarks on the vista as they stood on 8 September 2015:
 *
 * - towers ≥ 45 m from the z14 tiles (`data/towers.json`, `scripts/vista-towers.ts`:
 *   downtown, Hollywood, Koreatown and Wilshire, Century City, Westwood),
 *   without the towers finished after September 2015 (Wilshire Grand Center,
 *   Metropolis, Circa, Oceanwide Plaza, The Beaudry, Figueroa Eight, Perla,
 *   The Grand, 10000 Santa Monica Blvd); dark glass with a lit window grid,
 *   City Hall floodlit, the U.S. Bank Tower's crown and the Gas Company
 *   Tower's blue crown lit, red aviation beacons on the tall ones;
 * - the Wilshire Grand Center under construction: its concrete core at
 *   ~206 m (est. from the ~719 ft core reported on 12 Oct 2015 and the core
 *   topping out on 29 Feb 2016), steel and decks below, two luffing cranes
 *   on the core with red lights;
 * - the Hollywood Sign: nine unlit white sheet-metal letters at their OSM
 *   positions on Mt Lee (13.7 m tall), and the Mt Lee communications tower
 *   (92 m lattice, OSM) with red beacons.
 */

interface TowerRec {
  ring: number[];
  base: number;
  h: number;
  min: number;
}

/** Window grid texture: 16 window columns × 128 floors (one repeat). */
const COLS = 16;
const FLOORS = 128;

/** A tower's façade rhythm: window bay (m), floor height (m) and where its lit-floor pattern starts. */
interface Rhythm {
  bay: number;
  floor: number;
  uOff: number;
  vOff: number;
}

/**
 * A 256 × 1024 window grid, 16 bays × 128 floors, so towers that start at
 * different floors of it show different patterns. Offices: about a third of
 * the floors lit at 19:30 as whole bands, one colour per floor (warm white or
 * neutral fluorescent under the photos' ~3800 K balance, both reading
 * warm-white to neutral as in p02 and p12), runs of lit floors together, the
 * floors between dark with a few lit windows. Residential and hotel towers:
 * a third of the rooms lit, warm.
 */
function windowTexture(style: "office" | "residential") {
  const W = 256;
  const H = 1024;
  const { c, g } = canvas(W, H);
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  let seed = style === "office" ? 7 : 19;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const cw = W / COLS;
  const ch = H / FLOORS;
  let run = 0;
  let level = 1;
  let warmFloor = false;
  for (let row = 0; row < FLOORS; row++) {
    // Lit floors come in runs (a tenant's floors), 1–6 floors long.
    if (run <= 0 && style === "office" && rnd() < 0.12) {
      run = 1 + Math.floor(rnd() * 6);
      level = 0.55 + rnd() * 0.45;
      warmFloor = rnd() < 0.5;
    }
    const floorOn = run-- > 0;
    // Some tenants leave a few bays dark at a floor's end.
    const gapFrom = rnd() < 0.3 ? Math.floor(rnd() * COLS) : COLS;
    for (let col = 0; col < COLS; col++) {
      // Texel (0, 0) stays black: roofs sample it.
      if (row === FLOORS - 1 && col === 0) continue;
      const lit = floorOn ? col < gapFrom && rnd() < 0.92 : rnd() < (style === "office" ? 0.04 : 0.32);
      if (!lit) continue;
      const warm = floorOn ? warmFloor : rnd() < 0.75;
      const v = (floorOn ? level * (0.88 + rnd() * 0.12) : 0.3 + rnd() * 0.5) * 255;
      const [r, gg, b] = warm ? [1, 0.84, 0.6] : [1, 0.95, 0.86];
      g.fillStyle = `rgb(${Math.round(v * r)},${Math.round(v * gg)},${Math.round(v * b)})`;
      g.fillRect(col * cw + 1, (FLOORS - 1 - row) * ch + 1, cw - 2, ch - 2);
    }
  }
  const t = toTexture(c, true);
  t.name = `vista-windows-${style}`;
  return t;
}

/** Wall quads (outward) and a roof cap for a ring (x, z pairs; MVT exterior winding). */
function extrude(ring: Vector2[], y0: number, y1: number, ground: number, rh: Rhythm, roof = true): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  // Exterior rings have positive shoelace area in (x, z); walk them reversed so (p, q, q↑) faces out.
  const r = [...ring].reverse();
  let u = rh.uOff * rh.bay;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    const len = p.distanceTo(q);
    if (len < 1e-3) continue;
    const nx = -(q.y - p.y) / len;
    const nz = (q.x - p.x) / len;
    const u0 = u / (rh.bay * COLS);
    const u1 = (u + len) / (rh.bay * COLS);
    const v0 = ((y0 - ground) / rh.floor + rh.vOff) / FLOORS;
    const v1 = ((y1 - ground) / rh.floor + rh.vOff) / FLOORS;
    pos.push(p.x, y0, p.y, q.x, y0, q.y, q.x, y1, q.y, p.x, y0, p.y, q.x, y1, q.y, p.x, y1, p.y);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
    for (let k = 0; k < 6; k++) nor.push(nx, 0, nz);
    u += len;
  }
  if (roof) {
    const tris = ShapeUtils.triangulateShape(ring, []);
    for (const [a, b, c] of tris) {
      const A = ring[a];
      const B = ring[b];
      const C = ring[c];
      const up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y);
      for (const P of up > 0 ? [A, B, C] : [A, C, B]) {
        pos.push(P.x, y1, P.y);
        uv.push(0.5 / 256, 0.5 / 256);
        nor.push(0, 1, 0);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  return g;
}

/** Douglas–Peucker on a closed ring to `eps` metres (keeps ≥ 3 points). */
function simplifyRing(r: Vector2[], eps: number): Vector2[] {
  if (r.length <= 4 || eps <= 1.5) return r;
  let far = 1;
  for (let i = 1; i < r.length; i++) if (r[i].distanceTo(r[0]) > r[far].distanceTo(r[0])) far = i;
  const line = (s: Vector2[]): Vector2[] => {
    if (s.length <= 2) return s;
    const a = s[0];
    const b = s[s.length - 1];
    const d = b.clone().sub(a);
    const l = d.length() || 1;
    let best = 0;
    let bi = -1;
    for (let i = 1; i < s.length - 1; i++) {
      const e = Math.abs((s[i].x - a.x) * d.y - (s[i].y - a.y) * d.x) / l;
      if (e > best) (best = e), (bi = i);
    }
    if (best <= eps) return [a, b];
    return [...line(s.slice(0, bi + 1)).slice(0, -1), ...line(s.slice(bi))];
  };
  const out = [...line(r.slice(0, far + 1)).slice(0, -1), ...line([...r.slice(far), r[0]]).slice(0, -1)];
  return out.length >= 3 ? out : r;
}

function hash(x: number, z: number, s: number): number {
  let h = (Math.imul(Math.round(x) | 0, 374761393) + Math.imul(Math.round(z) | 0, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const RED: [number, number, number] = [1, 0.03, 0.02];

/** A red aviation light: flashing (L-864, ~30 per minute) or steady (L-810). */
function beacon(set: LightSet, x: number, y: number, z: number, flashing: boolean, phase: number): void {
  set.add({ x, y, z, r: RED[0], g: RED[1], b: RED[2], intensity: flashing ? 2600 : 500, radius: 0.35, phase, twinkle: 0.3, blink: flashing ? [Math.round((30 * LOOP) / 60), 0.3] : [1, 1] });
}

/** Named towers matched by position (OSM centroids) within 35 m of a ring's centroid. */
const SPECIAL = {
  cityHall: local(34.05356, -118.24291),
  usBank: local(34.05106, -118.25443),
  gasCompany: local(34.05008, -118.2531),
  twoCal: local(34.0514, -118.25163),
  wellsFargo: local(34.05302, -118.25188),
  aon: local(34.04924, -118.257),
};

/** No façade pattern (crowns, floodlit walls, construction). */
const PLAIN: Rhythm = { bay: 3, floor: 4, uOff: 0, vOff: 0 };

export function buildLandmarks(w: GriffithWorld): { beacons: LightSet; triangles: number } {
  const beacons = new LightSet("beacons");
  // Office towers (banded floors) and residential / hotel towers and mid-rises (scattered rooms, dimmer).
  const glass = new MeshStandardMaterial({ name: "vista-towers", color: new Color(0.035, 0.042, 0.06), roughness: 0.45, metalness: 0, emissive: new Color(1, 1, 1), emissiveMap: windowTexture("office"), emissiveIntensity: 1.3 });
  const homes = new MeshStandardMaterial({ name: "vista-towers-res", color: new Color(0.04, 0.042, 0.05), roughness: 0.6, metalness: 0, emissive: new Color(1, 1, 1), emissiveMap: windowTexture("residential"), emissiveIntensity: 0.9 });
  // The window grid lays 5.3 texels per metre across and 2 up: the device's
  // isotropic mips would blur the floors, so the cooker biases by the ratio.
  for (const m of [glass, homes]) m.userData.pocketAtlas = { lodBias: "auto" };
  const floodlit = new MeshStandardMaterial({ name: "vista-cityhall", color: new Color(0.3, 0.28, 0.24), roughness: 0.8, metalness: 0, emissive: new Color(1, 0.86, 0.68), emissiveIntensity: 0.55 });
  const crownWhite = new MeshBasicMaterial({ name: "vista-crown-white", color: new Color(2.4, 2.3, 2.1) });
  const crownBlue = new MeshBasicMaterial({ name: "vista-crown-blue", color: new Color(0.25, 0.6, 3.2) });
  const signRed = new MeshBasicMaterial({ name: "vista-crown-red", color: new Color(2.6, 0.25, 0.12) });
  const concrete = new MeshStandardMaterial({ name: "vista-construction", color: new Color(0.12, 0.115, 0.11), roughness: 0.9, metalness: 0 });
  // White-painted sheet steel; the faint emission stands in for the city's glow on the letters, which the
  // scene's sky light does not carry (est.; p13 and p22 show them clearly white after dark).
  const signWhite = new MeshStandardMaterial({ name: "vista-sign", color: new Color(0.8, 0.8, 0.78), roughness: 0.7, metalness: 0, emissive: new Color(1, 0.93, 0.85), emissiveIntensity: 0.05 });
  const geos = new Map<Material, BufferGeometry[]>();
  const add = (m: Material, g: BufferGeometry) => {
    let l = geos.get(m);
    if (!l) geos.set(m, (l = []));
    l.push(g);
  };

  // Tower parts by site: obstruction lights go only on the tallest part within 45 m.
  const sites = (TOWERS as TowerRec[]).map((t) => {
    let x = 0;
    let z = 0;
    for (let i = 0; i < t.ring.length; i += 2) (x += (2 * t.ring[i]) / t.ring.length), (z += (2 * t.ring[i + 1]) / t.ring.length);
    return { x, z, h: t.h };
  });
  const tallest = (cx: number, cz: number, h: number) => !sites.some((s) => s.h > h && Math.hypot(s.x - cx, s.z - cz) < 45);
  for (const t of TOWERS as TowerRec[]) {
    const ring: Vector2[] = [];
    for (let i = 0; i < t.ring.length; i += 2) ring.push(new Vector2(t.ring[i], t.ring[i + 1]));
    let cx = 0;
    let cz = 0;
    for (const p of ring) (cx += p.x / ring.length), (cz += p.y / ring.length);
    // Mid-rises far out read as lights, not as towers; the rest simplified to ~0.8 pixel at the nearest eye.
    const mpp = metresPerPixel(cx, cz);
    if (t.h < 60 && mpp.d > 5000) continue;
    const simple = simplifyRing(ring, 0.8 * mpp.m);
    const near = (p: { x: number; z: number }) => Math.hypot(cx - p.x, cz - p.z) < 35;
    const y0 = t.base + t.min;
    const y1 = t.base + t.h;
    if (near(SPECIAL.cityHall) && t.h > 60) {
      add(floodlit, extrude(simple, y0, y1, t.base, PLAIN));
    } else {
      // Each tower its own rhythm: office bays 1.5–3.2 m and floors 3.6–4.4 m, residential bays
      // 3–5 m and floors 2.9–3.3 m (est.), starting at its own floor of the 128-floor pattern.
      const office = t.h >= 100 && hash(cx, cz, 4) < 0.7;
      const rh: Rhythm = office
        ? { bay: 1.5 + 1.7 * hash(cx, cz, 5), floor: 3.6 + 0.8 * hash(cx, cz, 6), uOff: Math.floor(hash(cx, cz, 1) * COLS), vOff: Math.floor(hash(cx, cz, 2) * FLOORS) }
        : { bay: 3 + 2 * hash(cx, cz, 5), floor: 2.9 + 0.4 * hash(cx, cz, 6), uOff: Math.floor(hash(cx, cz, 1) * COLS), vOff: Math.floor(hash(cx, cz, 2) * FLOORS) };
      add(office ? glass : homes, extrude(simple, y0, y1, t.base, rh));
    }
    // Crowns lit in 2015 (est. colours): the U.S. Bank Tower's glass crown (colour-programmable,
    // white on an ordinary night), the Gas Company Tower's blue flame crown, Two California Plaza's
    // lit top; the logo bands of Wells Fargo (red) and Aon (red) on their top floors.
    if (near(SPECIAL.usBank) && t.h > 300) add(crownWhite, extrude(simple, y1 - 9, y1 + 0.3, t.base, PLAIN, false));
    if (near(SPECIAL.gasCompany) && t.h > 200) add(crownBlue, extrude(simple, y1 - 6, y1 + 0.3, t.base, PLAIN, false));
    if (near(SPECIAL.twoCal) && t.h > 200) add(crownWhite, extrude(simple, y1 - 5, y1 + 0.3, t.base, PLAIN, false));
    if ((near(SPECIAL.wellsFargo) || near(SPECIAL.aon)) && t.h > 200) add(signRed, extrude(simple, y1 - 7, y1 - 3, t.base, PLAIN, false));
    // Steady red obstruction lights (L-810) at two opposite roof corners of the tallest towers (≥ 220 m).
    if (t.h >= 220 && tallest(cx, cz, t.h)) {
      let a = 0;
      let b = 0;
      for (let i = 0; i < simple.length; i++) for (let j = i + 1; j < simple.length; j++) if (simple[i].distanceTo(simple[j]) > simple[a].distanceTo(simple[b])) (a = i), (b = j);
      for (const k of [a, b]) beacon(beacons, simple[k].x * 0.92 + cx * 0.08, y1 + 1.5, simple[k].y * 0.92 + cz * 0.08, false, 0);
    }
  }

  // The Wilshire Grand Center on 8 September 2015 (est.): podium decks, steel and decks to ~150 m
  // around the core, the concrete core at ~206 m, two luffing cranes on the core.
  {
    const c = new Vector2(3727, 7570);
    const along = new Vector2(0.79, 0.61);
    const across = new Vector2(-along.y, along.x);
    const rect = (l: number, wd: number, o = new Vector2()) =>
      [
        [-l / 2, -wd / 2],
        [-l / 2, wd / 2],
        [l / 2, wd / 2],
        [l / 2, -wd / 2],
      ].map(([a, b]) => c.clone().add(o).addScaledVector(along, a).addScaledVector(across, b));
    const base = groundY(c.x, c.y);
    add(concrete, extrude(rect(110, 70, new Vector2(-40, 0)), base, base + 30, base, PLAIN));
    add(concrete, extrude(rect(58, 26), base + 30, base + 150, base, PLAIN));
    add(concrete, extrude(rect(44, 17), base + 150, base + 206, base, PLAIN));
    // Work lights on the top decks.
    for (let k = 0; k < 6; k++) {
      const p = c.clone().addScaledVector(along, -20 + k * 8).addScaledVector(across, k % 2 ? 8 : -8);
      beacons.add({ x: p.x, y: base + 150 + (k % 3) * 4, z: p.y, r: 1, g: 0.85, b: 0.65, intensity: 1800, radius: 0.5, phase: k / 6, twinkle: 0 });
    }
    for (const s of [-1, 1]) {
      const m = c.clone().addScaledVector(along, s * 14);
      const top = base + 206 + 28;
      add(concrete, extrude(rect(2.2, 2.2, m.clone().sub(c)), base + 206, top, base, PLAIN));
      // Jib raised ~65°, 45 m, toward the outside.
      const tip = m.clone().addScaledVector(along, s * 45 * Math.cos(1.13));
      const jib = [m.clone().addScaledVector(across, -0.6), m.clone().addScaledVector(across, 0.6), tip.clone().addScaledVector(across, 0.6), tip.clone().addScaledVector(across, -0.6)];
      const g = new BufferGeometry();
      const y0 = top - 4;
      const y1 = top - 4 + 45 * Math.sin(1.13);
      g.setAttribute("position", new Float32BufferAttribute([jib[0].x, y0, jib[0].y, jib[1].x, y0, jib[1].y, jib[2].x, y1, jib[2].y, jib[0].x, y0, jib[0].y, jib[2].x, y1, jib[2].y, jib[3].x, y1, jib[3].y], 3));
      g.computeVertexNormals();
      add(concrete, g);
      beacon(beacons, m.x, top + 1, m.y, false, 0);
      beacon(beacons, tip.x, y1 + 0.5, tip.y, false, 0);
    }
  }

  // The Hollywood Sign: letter base lines from OSM (way per letter, west → east), 13.7 m tall, facing the city.
  const LETTERS: [string, number, number, number, number][] = [
    ["H", 34.1340293, -118.3222171, 34.1340297, -118.3221126],
    ["O", 34.1340025, -118.3220665, 34.1339981, -118.3219841],
    ["L", 34.1340161, -118.3219392, 34.1340267, -118.321841],
    ["L", 34.1340309, -118.3218291, 34.1340415, -118.3217497],
    ["Y", 34.1340414, -118.3217373, 34.1340542, -118.321639],
    ["W", 34.1340835, -118.3216146, 34.1340994, -118.3214969],
    ["O", 34.1341032, -118.3214707, 34.1341076, -118.3213662],
    ["O", 34.1341201, -118.3213293, 34.1341275, -118.3212336],
    ["D", 34.1340854, -118.3211679, 34.1340827, -118.3210756],
  ];
  for (const [ch, la0, lo0, la1, lo1] of LETTERS) add(signWhite, letter(ch, local(la0, lo0), local(la1, lo1)));

  // The Mt Lee communications tower (OSM: 92 m lattice) as a slim dark frustum, beacons at the top and halfway.
  {
    const p = local(34.1346331, -118.3205235);
    const base = groundY(p.x, p.z);
    const sq = (s: number) => [new Vector2(p.x - s, p.z - s), new Vector2(p.x - s, p.z + s), new Vector2(p.x + s, p.z + s), new Vector2(p.x + s, p.z - s)].reverse();
    add(concrete, taper(sq(4), sq(0.9), base, base + 92));
    beacon(beacons, p.x, base + 93, p.z, true, 0.4);
    beacon(beacons, p.x + 2.5, base + 46, p.z, false, 0);
    beacon(beacons, p.x - 1.5, base + 69, p.z, false, 0);
    // Security floodlights along the summit compound (p13: a row of white and green-white lamps).
    // Spread over the compound's ~110 m (OSM buildings 34.1345–34.1350 N, 118.3212–118.3200 W).
    for (let k = 0; k < 9; k++) {
      const q = local(34.13452 + k * 0.00005, -118.32122 + k * 0.00014);
      const gy = groundY(q.x, q.z);
      const green = k % 3 === 1;
      beacons.add({ x: q.x, y: gy + 5, z: q.z + 4, r: green ? 0.7 : 0.9, g: 1, b: green ? 0.75 : 1, intensity: 90, radius: 0.4, phase: k / 9, twinkle: 0.2 });
    }
  }

  let triangles = 0;
  for (const [m, list] of geos) {
    const g = merge(list);
    triangles += g.getAttribute("position").count / 3;
    w.mesh(g, m, 0, 0, 0, w.root, { cast: false, receive: false }).name = `vista-${m.name}`;
  }
  return { beacons, triangles };
}

/** A tapered prism from a bottom ring to a top ring (same count, exterior winding). */
function taper(bottom: Vector2[], top: Vector2[], y0: number, y1: number): BufferGeometry {
  const pos: number[] = [];
  const r0 = [...bottom].reverse();
  const r1 = [...top].reverse();
  for (let i = 0; i < r0.length; i++) {
    const j = (i + 1) % r0.length;
    pos.push(r0[i].x, y0, r0[i].y, r0[j].x, y0, r0[j].y, r1[j].x, y1, r1[j].y, r0[i].x, y0, r0[i].y, r1[j].x, y1, r1[j].y, r1[i].x, y1, r1[i].y);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * One letter of the sign as flat strokes on a vertical plane through its base
 * line (a → b, west → east), 13.7 m tall, front facing south toward the city.
 * Strokes: 2.3 m wide; O and D as 12-sided outlines.
 */
function letter(ch: string, a: { x: number; z: number }, b: { x: number; z: number }): BufferGeometry {
  const H = 13.7;
  const W = Math.hypot(b.x - a.x, b.z - a.z);
  const ux = (b.x - a.x) / W;
  const uz = (b.z - a.z) / W;
  const base = Math.min(groundY(a.x, a.z), groundY(b.x, b.z)) + 0.5;
  // Normal toward the city: perpendicular to the base line, pointing south (+z).
  let nx = -uz;
  let nz = ux;
  if (nz < 0) (nx = -nx), (nz = -nz);
  const s = 2.3;
  const quads: [number, number, number, number][] = [];
  const box = (u0: number, v0: number, u1: number, v1: number) => quads.push([u0, v0, u1, v1]);
  const pos: number[] = [];
  const P = (u: number, v: number) => [a.x + ux * u, base + v, a.z + uz * u];
  const tri = (p: number[], q: number[], r: number[]) => {
    // Order so the face points along (nx, nz).
    const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    if (cx * nx + cz * nz >= 0) pos.push(...p, ...q, ...r);
    else pos.push(...p, ...r, ...q);
  };
  const ring = (cu: number, cv: number, ru: number, rv: number, from = 0, to = 2 * Math.PI, n = 12) => {
    for (let k = 0; k < n; k++) {
      const t0 = from + ((to - from) * k) / n;
      const t1 = from + ((to - from) * (k + 1)) / n;
      const o0 = P(cu + Math.cos(t0) * ru, cv + Math.sin(t0) * rv);
      const o1 = P(cu + Math.cos(t1) * ru, cv + Math.sin(t1) * rv);
      const i0 = P(cu + Math.cos(t0) * (ru - s), cv + Math.sin(t0) * (rv - s));
      const i1 = P(cu + Math.cos(t1) * (ru - s), cv + Math.sin(t1) * (rv - s));
      tri(o0, o1, i1);
      tri(o0, i1, i0);
    }
  };
  switch (ch) {
    case "H":
      box(0, 0, s, H);
      box(W - s, 0, W, H);
      box(s, H * 0.42, W - s, H * 0.42 + s);
      break;
    case "L":
      box(0, 0, s, H);
      box(s, 0, W, s);
      break;
    case "Y":
      box(W / 2 - s / 2, 0, W / 2 + s / 2, H * 0.5);
      quads.push([NaN, 0, 0, 0]);
      break;
    case "W":
      quads.push([NaN, 1, 0, 0]);
      break;
    case "O":
      ring(W / 2, H / 2, W / 2, H / 2);
      break;
    case "D":
      box(0, 0, s, H);
      box(s, 0, W * 0.45, s);
      box(s, H - s, W * 0.45, H);
      ring(W * 0.45, H / 2, W * 0.55, H / 2, -Math.PI / 2, Math.PI / 2, 8);
      break;
  }
  const slant = (x0: number, y0: number, x1: number, y1: number) => {
    // A stroke from (x0, y0) to (x1, y1), s wide horizontally.
    tri(P(x0 - s / 2, y0), P(x0 + s / 2, y0), P(x1 + s / 2, y1));
    tri(P(x0 - s / 2, y0), P(x1 + s / 2, y1), P(x1 - s / 2, y1));
  };
  for (const [u0, v0, u1, v1] of quads) {
    if (Number.isNaN(u0)) {
      if (v0 === 0) {
        // Y arms.
        slant(W / 2, H * 0.5, s / 2, H);
        slant(W / 2, H * 0.5, W - s / 2, H);
      } else {
        // W: four strokes.
        slant(W * 0.22, 0, s / 2, H);
        slant(W * 0.22, 0, W * 0.5, H * 0.85);
        slant(W * 0.78, 0, W * 0.5, H * 0.85);
        slant(W * 0.78, 0, W - s / 2, H);
      }
      continue;
    }
    tri(P(u0, v0), P(u1, v0), P(u1, v1));
    tri(P(u0, v0), P(u1, v1), P(u0, v1));
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  const nor: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) nor.push(nx, 0, nz);
  g.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}
