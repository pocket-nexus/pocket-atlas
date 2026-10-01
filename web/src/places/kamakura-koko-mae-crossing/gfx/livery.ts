import type { Texture } from "three";
import { Rng } from "../../../core/random";
import { JP_SANS, LATIN, roundRect, type Ctx } from "../../shared/canvas";
import { heightToNormal, LayerPen, paintLayer, pbrTexture, type Finish } from "../../shared/pbr-atlas";

/**
 * Enoden 500 type (second generation, 2006): body dimensions, the side and
 * cab layout, and the livery atlas every car of the train shares.
 *
 * One 2048 × 1024 atlas (the device keeps 1024 × 512) holds the side of a
 * car as a strip (both sides map to it; the far side reads mirrored, so the
 * strip carries no lettering), four cab faces (lead with headlights, two
 * coupled, tail with tail lights; each with its own car number), the
 * articulated end, the roof air-conditioner, running-gear panels, the
 * bellows, the side emblem and flat colour cells. The same drawing calls
 * paint the albedo, the ORM map (R occlusion, G roughness, B metalness), a
 * height map that becomes the normal map, and the emission map (lamps, the
 * destination display, the lit saloon ceiling).
 *
 * Local frame of a car: nose toward +x, the articulated end at −x, y above
 * the rail, z to the car's left (+z is the north side for a westbound car).
 */

/** Body dimensions (m). */
export const ENO = {
  /** Body length, nose tip to articulated end face (two bodies + 0.2 m joint = one 25.1 m unit; couplers make it 25.4 m). */
  L: 12.45,
  /** Half width at the waist (2.5 m body). */
  W: 1.25,
  /** Plan radius of the cab corners. */
  RC: 0.38,
  /** Forward bow of the cab face at the centreline. */
  BOW: 0.07,
  /** Body bottom edge and roof centre above the rail. */
  BOT: 0.8,
  TOP: 3.7,
  /** Windscreen setback at its top edge (the front leans back above the waist). */
  RAKE: 0.2,
  /** Gap between the two bodies of a unit (bellows), and between the noses of two coupled units. */
  JOINT: 0.2,
  NOSES: 0.6,
};

/** Half cross-section of the body, bottom edge to roof centre: [y, half width]. */
export const PROFILE: [number, number][] = [
  [0.8, 1.19],
  [0.92, 1.24],
  [1.05, 1.25],
  [3.05, 1.25],
  [3.22, 1.236],
  [3.36, 1.19],
  [3.47, 1.11],
  [3.56, 0.98],
  [3.63, 0.78],
  [3.675, 0.48],
  [3.7, 0],
];

/** Arc length along the profile from the bottom edge, per profile point. */
const S_PTS: number[] = (() => {
  const out = [0];
  for (let i = 1; i < PROFILE.length; i++) out.push(out[i - 1] + Math.hypot(PROFILE[i][0] - PROFILE[i - 1][0], PROFILE[i][1] - PROFILE[i - 1][1]));
  return out;
})();
export const S_MAX = S_PTS[S_PTS.length - 1];
export const PROFILE_S = S_PTS;

/** Profile arc length at height y (y is monotonic along the profile). */
export function sOfY(y: number): number {
  if (y <= PROFILE[0][0]) return 0;
  for (let i = 1; i < PROFILE.length; i++) {
    if (y <= PROFILE[i][0]) {
      const t = (y - PROFILE[i - 1][0]) / (PROFILE[i][0] - PROFILE[i - 1][0]);
      return S_PTS[i - 1] + t * (S_PTS[i] - S_PTS[i - 1]);
    }
  }
  return S_MAX;
}

/** Half width of the body at height y. */
export function halfWidth(y: number): number {
  if (y <= PROFILE[0][0]) return PROFILE[0][1];
  for (let i = 1; i < PROFILE.length; i++) {
    if (y <= PROFILE[i][0]) {
      const t = (y - PROFILE[i - 1][0]) / (PROFILE[i][0] - PROFILE[i - 1][0]);
      return PROFILE[i - 1][1] + t * (PROFILE[i][1] - PROFILE[i - 1][1]);
    }
  }
  return 0;
}

/** Livery heights (m above the rail). */
export const BANDS = { creamFrom: 1.7, creamTo: 2.98, gold: [1.615, 1.64] as const, gutter: 3.36, roofFrom: 3.5 };

/**
 * Side layout along d, metres back from where the flat side meets the cab
 * corner (d = 0 at x = L/2 − RC − BOW) to the articulated end (d = 12.0).
 */
export const SIDE = {
  windows: [
    [1.95, 3.25],
    [3.45, 4.75],
    [4.95, 6.25],
    [6.45, 7.75],
    [9.4, 10.7],
    [10.9, 11.75],
  ] as [number, number][],
  winY: [1.8, 2.88] as const,
  doors: [
    [0.6, 1.6],
    [8.05, 9.05],
  ] as [number, number][],
  doorY: [0.97, 2.93] as const,
  /** Door window inside each door (from the door's leading edge), and its height. */
  doorWin: [0.22, 0.78] as const,
  doorWinY: [1.88, 2.86] as const,
  /** The emblem decal on the cream band behind the cab corner. */
  emblem: [0.1, 0.48] as const,
  emblemY: [2.05, 2.55] as const,
  /** Car number on the green band behind the cab corner. */
  number: [0.12, 0.48] as const,
  numberY: [1.2, 1.38] as const,
};

/** Windscreen on the cab face (half width, bottom, top, corner radius). */
export const WINDSCREEN = { z: 1.07, y0: 1.86, y1: 2.93, r: 0.12 };

// ------------------------------------------------------------------ atlas

const AW = 2048;
const AH = 1024;
/** Strip covers d from D0 to D1 (the corner continuation before d = 0, the joint after 12.0). */
const D0 = -0.7;
const D1 = 12.2;
const STRIP = { x: 0, y: 0, w: 2048, h: 480 };
/** Cab faces: z in [−1.3, 1.3] across, y in [0.78, 3.72]. */
const FACE = { w: 300, h: 448, y: 488, z: 1.3, y0: 0.78, y1: 3.72 };
export type CabKind = "lead" | "coupledA" | "coupledB" | "tail" | "end";
const FACE_X: Record<CabKind, number> = { lead: 0, coupledA: 304, coupledB: 608, tail: 912, end: 1216 };
const RECTS = {
  acTop: [1528, 488, 512, 128],
  acSide: [1528, 620, 512, 48],
  bogie: [1528, 676, 256, 64],
  under: [1528, 744, 256, 64],
  bellows: [1792, 676, 64, 260],
  emblem: [1864, 676, 128, 168],
  num502: [1864, 848, 88, 44],
  num552: [1952, 848, 88, 44],
  num501: [1864, 892, 88, 44],
  num551: [1952, 892, 88, 44],
} as const;
export type RectName = keyof typeof RECTS;

const SOLID_NAMES = ["black", "dark", "bogie", "silver", "chrome", "steel", "insulator", "copper", "roof", "rust", "green", "cream", "rubber", "acGrey", "bellows", "brown"] as const;
export type SolidName = (typeof SOLID_NAMES)[number];

const sx = (d: number) => STRIP.x + ((d - D0) / (D1 - D0)) * STRIP.w;
const sy = (y: number) => STRIP.y + STRIP.h * (1 - sOfY(y) / S_MAX);
const syS = (s: number) => STRIP.y + STRIP.h * (1 - s / S_MAX);
const fxOf = (x0: number) => (z: number) => x0 + (0.5 - z / (2 * FACE.z)) * FACE.w;
const fy = (y: number) => FACE.y + FACE.h * (1 - (y - FACE.y0) / (FACE.y1 - FACE.y0));

/** Atlas UV of side-strip point (d, profile arc length s). */
export function stripUV(d: number, s: number): [number, number] {
  return [sx(d) / AW, 1 - syS(s) / AH];
}

/** Atlas UV of a cab-face point (z across, y up). */
export function faceUV(kind: CabKind, z: number, y: number): [number, number] {
  return [fxOf(FACE_X[kind])(z) / AW, 1 - fy(y) / AH];
}

/** Atlas UV inside a named panel, fu / fv in 0..1 (v up). */
export function rectUV(name: RectName, fu: number, fv: number): [number, number] {
  const [x, y, w, h] = RECTS[name];
  return [(x + fu * w) / AW, 1 - (y + (1 - fv) * h) / AH];
}

/** Atlas UV at the centre of a flat colour cell. */
export function solidUV(name: SolidName): [number, number] {
  const i = SOLID_NAMES.indexOf(name);
  return [(i * 64 + 32) / AW, 1 - (944 + 32) / AH];
}

// ---------------------------------------------------------------- painting

type Mat = Finish & { h: number };

/** Surfaces: albedo (sRGB), roughness, metalness, relief height (0.5 = skin), emission. */
const M = {
  green: { c: "#295d51", r: 0.34, m: 0, h: 0.5 },
  cream: { c: "#dcd0b4", r: 0.32, m: 0, h: 0.5 },
  gold: { c: "#b39250", r: 0.3, m: 0.6, h: 0.52 },
  roof: { c: "#4a4c4c", r: 0.72, m: 0, h: 0.5 },
  rubber: { c: "#141516", r: 0.6, m: 0, h: 0.46 },
  seam: { c: "#252a28", r: 0.55, m: 0, h: 0.3 },
  gutter: { c: "#2b3330", r: 0.5, m: 0, h: 0.62 },
  inside: { c: "#5e5d58", r: 0.88, m: 0, h: 0.4 },
  display: { c: "#0b0b0c", r: 0.3, m: 0, h: 0.42 },
  chrome: { c: "#c8cbcd", r: 0.16, m: 1, h: 0.62 },
  lens: { c: "#d6d3c8", r: 0.12, m: 0, h: 0.6 },
  tailLens: { c: "#4c0e0b", r: 0.12, m: 0, h: 0.58 },
  silver: { c: "#a8adb0", r: 0.4, m: 0.6, h: 0.5 },
  dark: { c: "#2b2d2e", r: 0.62, m: 0.15, h: 0.5 },
  bogie: { c: "#26282a", r: 0.6, m: 0.25, h: 0.5 },
  rust: { c: "#5a4232", r: 0.85, m: 0, h: 0.5 },
  steel: { c: "#8e9090", r: 0.32, m: 1, h: 0.5 },
  insulator: { c: "#d8d4c8", r: 0.28, m: 0, h: 0.5 },
  copper: { c: "#8c6b4a", r: 0.38, m: 0.8, h: 0.5 },
  acGrey: { c: "#b6babb", r: 0.5, m: 0.1, h: 0.5 },
  bellows: { c: "#1b1c1d", r: 0.82, m: 0, h: 0.5 },
  black: { c: "#121314", r: 0.55, m: 0, h: 0.5 },
  brown: { c: "#4a3a2e", r: 0.7, m: 0, h: 0.5 },
} satisfies Record<string, Mat>;

/** The colour bands of the 500 type at heights y0..y1, drawn across x0..x1 with `yOf` mapping height to canvas y. */
function bands(p: LayerPen, x0: number, x1: number, yOf: (y: number) => number, yMax: number): void {
  const w = x1 - x0;
  p.rect(x0, yOf(Math.min(BANDS.roofFrom, yMax)), w, yOf(0.78) - yOf(Math.min(BANDS.roofFrom, yMax)), M.green);
  p.rect(x0, yOf(BANDS.creamTo), w, yOf(BANDS.creamFrom) - yOf(BANDS.creamTo), M.cream);
  p.rect(x0, yOf(BANDS.gold[1]), w, Math.max(1.5, yOf(BANDS.gold[0]) - yOf(BANDS.gold[1])), M.gold);
  if (yMax > BANDS.roofFrom) p.rect(x0, yOf(yMax), w, yOf(BANDS.roofFrom) - yOf(yMax), M.roof);
}

interface Passenger {
  cx: number;
  head: number;
  top: string;
  hair: string;
  fringe: boolean;
}

/** Who stands or sits behind a window: seeded by the window's position, so every map pass agrees. */
function passengers(x0: number, y0: number, w: number, h: number, most: number): Passenger[] {
  const r = new Rng(Math.round(x0 * 31 + y0 * 17) + 7);
  const n = Math.min(most, r.chance(0.5) ? 1 : r.chance(0.3) ? 2 : 0);
  const tops = ["#b9b7b0", "#2c3442", "#66717c", "#7e4a40", "#a89c84", "#3e5a48", "#c4c2ba", "#4a4f58"];
  const hair = ["#151210", "#241a14", "#3a2a1e", "#0f0e0d", "#5a4a3c"];
  const out: Passenger[] = [];
  for (let i = 0; i < n; i++) {
    const standing = r.chance(0.45);
    out.push({
      cx: x0 + r.range(0.15, 0.85) * w,
      head: standing ? y0 + h * r.range(0.24, 0.32) : y0 + h * r.range(0.48, 0.54),
      top: tops[r.int(0, tops.length - 1)],
      hair: hair[r.int(0, hair.length - 1)],
      fringe: r.chance(0.5),
    });
  }
  return out;
}

/** Generic summer passengers; in the emission pass, black cut-outs over the far windows' daylight. */
function drawPassengers(g: Ctx, crowd: Passenger[], h: number, y1: number, dark: boolean): void {
  for (const q of crowd) {
    const hr = h * 0.075;
    const body = g.createLinearGradient(0, q.head + hr, 0, y1);
    body.addColorStop(0, dark ? "#000" : q.top);
    body.addColorStop(0.5, dark ? "#000" : q.top);
    body.addColorStop(1, dark ? "#000" : "#1a1d1f");
    g.fillStyle = body;
    roundRect(g, q.cx - hr * 1.9, q.head + hr * 1.2, hr * 3.8, y1 - q.head, hr * 1.3);
    g.fill();
    g.fillStyle = dark ? "#000" : "#b8927a";
    g.fillRect(q.cx - hr * 0.35, q.head + hr * 0.7, hr * 0.7, hr * 0.7);
    g.fillStyle = dark ? "#000" : "#c49c82";
    g.beginPath();
    g.ellipse(q.cx, q.head, hr * 0.85, hr, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = dark ? "#000" : q.hair;
    g.beginPath();
    g.ellipse(q.cx, q.head - hr * 0.25, hr * 0.92, hr * 0.85, 0, Math.PI, Math.PI * 2);
    g.fill();
    if (q.fringe) g.fillRect(q.cx - hr * 0.92, q.head - hr * 0.3, hr * 1.84, hr * 0.5);
  }
}

/**
 * What a window shows from outside: the lit ceiling, hand straps, the far
 * side's windows bright with the day outside, seat backs and, now and then,
 * a passenger. Other maps: matte, recessed, the ceiling faintly lit.
 */
function saloon(p: LayerPen, x0: number, y0: number, x1: number, y1: number, r: Rng, people: number): void {
  const g = p.g;
  const w = x1 - x0;
  const h = y1 - y0;
  // Far windows: positions from the window itself, so every map pass agrees.
  const pitch = w / 1.1;
  const off = (((x0 * 0.618) % 1) - 0.5) * 0.6 * pitch;
  const fy0 = y0 + h * 0.17;
  const fy1 = y0 + h * 0.6;
  const farWindows = () => {
    for (let k = -1; k < 3; k++) {
      const a = x0 + off + k * pitch + pitch * 0.06;
      const b = a + pitch * 0.82;
      const lo = Math.max(x0, a);
      const hi = Math.min(x1, b);
      if (hi > lo) g.fillRect(lo, fy0, hi - lo, fy1 - fy0);
    }
  };
  const crowd = passengers(x0, y0, w, h, people);
  if (p.mode === "emit") {
    // The lit ceiling, and daylight through the far side (independent of the near side's shade).
    const grd = g.createLinearGradient(0, y0, 0, y0 + h * 0.3);
    grd.addColorStop(0, "#4a4a44");
    grd.addColorStop(1, "#000");
    g.fillStyle = grd;
    g.fillRect(x0, y0, w, h * 0.3);
    g.fillStyle = "#3e5462";
    farWindows();
    drawPassengers(g, crowd, h, y1, true);
    return;
  }
  if (!p.albedo) {
    p.rect(x0, y0, w, h, M.inside);
    return;
  }
  // Back wall and ceiling.
  let grd = g.createLinearGradient(0, y0, 0, y1);
  grd.addColorStop(0, "#a9a79e");
  grd.addColorStop(0.13, "#8c8a81");
  grd.addColorStop(0.2, "#6c6a62");
  grd.addColorStop(0.62, "#5c5a53");
  grd.addColorStop(0.7, "#2f4f58");
  grd.addColorStop(1, "#1b2a30");
  g.fillStyle = grd;
  g.fillRect(x0, y0, w, h);
  // Ceiling light strip.
  g.fillStyle = "#e2e0d6";
  g.fillRect(x0, y0 + h * 0.03, w, h * 0.025);
  // Far windows: the day outside through the other side of the car.
  grd = g.createLinearGradient(0, fy0, 0, fy1);
  grd.addColorStop(0, "#c9dbe6");
  grd.addColorStop(0.55, "#a4c0d2");
  grd.addColorStop(1, "#8fb0c4");
  g.fillStyle = grd;
  farWindows();
  // Seat backs (blue-green moquette) and the grab rail on top.
  g.fillStyle = "#28505a";
  g.fillRect(x0, y0 + h * 0.66, w, h * 0.22);
  g.fillStyle = "#1a3238";
  for (let x = x0 + r.range(0, 30); x < x1; x += 34) g.fillRect(x, y0 + h * 0.66, 2, h * 0.22);
  g.fillStyle = "#b8bcbd";
  g.fillRect(x0, y0 + h * 0.64, w, 2);
  // Hand straps along the ceiling rail.
  g.fillStyle = "#8a8c8c";
  g.fillRect(x0, y0 + h * 0.14, w, 2);
  for (let x = x0 + 10 + r.range(0, 14); x < x1 - 4; x += 30) {
    g.fillStyle = "#6f706c";
    g.fillRect(x, y0 + h * 0.14, 1.5, h * 0.09);
    g.strokeStyle = "#ecebe4";
    g.lineWidth = 2.2;
    g.beginPath();
    g.ellipse(x + 0.75, y0 + h * 0.255, 3.6, 4.4, 0, 0, Math.PI * 2);
    g.stroke();
  }
  drawPassengers(g, crowd, h, y1, false);
  // Glass shade toward the bottom (the car body shadows the lower saloon).
  grd = g.createLinearGradient(0, y0, 0, y1);
  grd.addColorStop(0, "rgba(0,0,0,0)");
  grd.addColorStop(0.7, "rgba(10,16,20,0.18)");
  grd.addColorStop(1, "rgba(10,16,20,0.45)");
  g.fillStyle = grd;
  g.fillRect(x0, y0, w, h);
}

/** A window in its black rubber frame. */
function windowAt(p: LayerPen, x0: number, y0: number, x1: number, y1: number, r: Rng, people: number): void {
  p.rbox(x0 - 4, y0 - 4, x1 + 4, y1 + 4, 9, M.rubber);
  p.g.save();
  roundRect(p.g, x0, y0, x1 - x0, y1 - y0, 7);
  p.g.clip();
  saloon(p, x0, y0, x1, y1, r, people);
  p.g.restore();
}

function paintStrip(p: LayerPen, r: Rng): void {
  const x0 = sx(D0);
  const x1 = sx(D1);
  bands(p, x0, x1, sy, 3.7);
  // Rain gutter along the roof edge, and the roof walkway mats.
  p.rect(x0, sy(BANDS.gutter) - 2, x1 - x0, 4, M.gutter);
  p.rect(x0, sy(BANDS.roofFrom) - 1, x1 - x0, 2, M.seam);
  if (p.albedo) {
    for (let k = 0; k < 40; k++) {
      const x = r.range(x0, x1);
      p.wash(`rgba(${r.int(40, 70)},${r.int(38, 55)},${r.int(30, 45)},0.12)`, x, syS(S_MAX), r.range(30, 160), sy(BANDS.roofFrom) - syS(S_MAX));
    }
    p.wash("rgba(255,255,255,0.05)", x0, syS(S_MAX), x1 - x0, 8);
  }
  // Doors: body colours, seams, a tall window.
  for (const [a, b] of SIDE.doors) {
    const [dy0, dy1] = SIDE.doorY;
    p.box(sx(a), sy(dy1), sx(b), sy(dy0), M.seam);
    p.box(sx(a) + 2, sy(dy1) + 2, sx(b) - 2, sy(BANDS.creamFrom), M.cream);
    p.box(sx(a) + 2, sy(BANDS.creamFrom), sx(b) - 2, sy(dy0) - 2, M.green);
    p.box(sx(a) + 2, sy(BANDS.gold[1]), sx(b) - 2, sy(BANDS.gold[0]), M.gold);
    windowAt(p, sx(a + SIDE.doorWin[0]), sy(SIDE.doorWinY[1]), sx(a + SIDE.doorWin[1]), sy(SIDE.doorWinY[0]), r, 1);
    // Door stickers: a white notice with a blue band and a red hand pictogram, at eye height.
    {
      const cx = sx(a + (SIDE.doorWin[0] + SIDE.doorWin[1]) / 2);
      const y0 = sy(2.32);
      const y1 = sy(2.14);
      const hw = (sx(0.09) - sx(0)) / 1;
      p.box(cx - hw, y0, cx + hw, y1, M.cream);
      if (p.albedo) {
        p.g.fillStyle = "#2a5fae";
        p.g.fillRect(cx - hw, y0, hw * 2, (y1 - y0) * 0.3);
        p.g.fillStyle = "#c8302a";
        p.g.beginPath();
        p.g.arc(cx, y0 + (y1 - y0) * 0.66, (y1 - y0) * 0.22, 0, Math.PI * 2);
        p.g.fill();
      }
    }
    // Door rail and the step light below.
    p.box(sx(a) - 6, sy(dy0) - 1, sx(b) + 6, sy(dy0) + 5, M.silver);
  }
  for (const [a, b] of SIDE.windows) {
    windowAt(p, sx(a), sy(SIDE.winY[1]), sx(b), sy(SIDE.winY[0]), r, 2);
    // Upper sash split of the opening section.
    p.box(sx(a), sy(SIDE.winY[1] - 0.3) - 1.5, sx(b), sy(SIDE.winY[1] - 0.3) + 1.5, M.rubber);
  }
  // Panel seams at the body ends and the articulation.
  for (const d of [0, 11.98]) p.box(sx(d) - 1, sy(3.3), sx(d) + 1, sy(0.82), M.seam);
  // Road and brake dust low on the body, streaks under the windows.
  if (p.albedo) {
    const g = p.g;
    const grd = g.createLinearGradient(0, sy(1.35), 0, sy(0.8));
    grd.addColorStop(0, "rgba(70,60,45,0)");
    grd.addColorStop(1, "rgba(70,60,45,0.32)");
    g.fillStyle = grd;
    g.fillRect(x0, sy(1.35), x1 - x0, sy(0.8) - sy(1.35));
    for (const [a, b] of SIDE.windows)
      for (let k = 0; k < 3; k++) {
        const x = sx(r.range(a, b));
        const sg = g.createLinearGradient(0, sy(SIDE.winY[0]), 0, sy(SIDE.winY[0] - 0.5));
        sg.addColorStop(0, "rgba(60,58,50,0.1)");
        sg.addColorStop(1, "rgba(60,58,50,0)");
        g.fillStyle = sg;
        g.fillRect(x, sy(SIDE.winY[0]), r.range(4, 12), sy(SIDE.winY[0] - 0.5) - sy(SIDE.winY[0]));
      }
  }
}

/** Cab face: windscreen with the cab and saloon behind it, display, lamps, number. */
function paintFace(p: LayerPen, kind: CabKind, num: string, r: Rng): void {
  const X0 = FACE_X[kind];
  const fx = fxOf(X0);
  const g = p.g;
  bands(p, X0, X0 + FACE.w, fy, FACE.y1);
  if (kind === "end") {
    // Articulated end: the gangway opening behind the bellows.
    p.box(fx(0.62), fy(2.95), fx(-0.62), fy(0.95), M.bellows);
    return;
  }
  const ws = WINDSCREEN;
  p.rbox(fx(ws.z) - 4, fy(ws.y1) - 4, fx(-ws.z) + 4, fy(ws.y0) + 4, 20, M.rubber);
  g.save();
  roundRect(g, fx(ws.z), fy(ws.y1), fx(-ws.z) - fx(ws.z), fy(ws.y0) - fy(ws.y1), 17);
  g.clip();
  const lead = kind === "lead";
  if (p.albedo) {
    // Through the cab: the saloon ceiling and the far cab window, then the desk.
    let grd = g.createLinearGradient(0, fy(ws.y1), 0, fy(ws.y0));
    grd.addColorStop(0, "#77766f");
    grd.addColorStop(0.18, "#5a5954");
    grd.addColorStop(0.45, "#3c3d3b");
    grd.addColorStop(0.62, "#1d1f20");
    grd.addColorStop(1, "#0f1112");
    g.fillStyle = grd;
    g.fillRect(fx(ws.z), fy(ws.y1), fx(-ws.z) - fx(ws.z), fy(ws.y0) - fy(ws.y1));
    grd = g.createLinearGradient(0, fy(2.6), 0, fy(2.25));
    grd.addColorStop(0, "#6f8492");
    grd.addColorStop(1, "#526a7a");
    g.fillStyle = grd;
    g.fillRect(fx(0.42), fy(2.6), fx(-0.42) - fx(0.42), fy(2.25) - fy(2.6));
    // Cab back wall with its door, the saloon's straps beyond.
    g.fillStyle = "#33342f";
    g.fillRect(fx(1.07), fy(2.62), fx(0.42) - fx(1.07), fy(2.15) - fy(2.62));
    g.fillRect(fx(-0.42), fy(2.62), fx(-1.07) - fx(-0.42), fy(2.15) - fy(2.62));
    // Desk and controls.
    g.fillStyle = "#1c1e1f";
    g.fillRect(fx(1.07), fy(2.12), fx(-1.07) - fx(1.07), fy(ws.y0) - fy(2.12));
    g.fillStyle = "#3a3d3f";
    g.fillRect(fx(0.9), fy(2.12), fx(0.1) - fx(0.9), 5);
    g.fillStyle = "#6c7c84";
    g.fillRect(fx(0.7), fy(2.08), 18, 8);
    if (lead) {
      // The driver, cap and pale blue shirt, at the desk on the left of the cab.
      const cx = fx(0.18);
      g.fillStyle = "#4c5966";
      roundRect(g, cx - 13, fy(2.28), 26, fy(2.05) - fy(2.28), 8);
      g.fill();
      g.fillStyle = "#a08070";
      g.beginPath();
      g.ellipse(cx, fy(2.39), 7, 9, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#1d2230";
      g.fillRect(cx - 8, fy(2.46), 16, 6);
      g.fillRect(cx - 10, fy(2.44), 20, 2);
    }
  } else if (p.mode === "emit") {
    const grd = g.createLinearGradient(0, fy(ws.y1), 0, fy(2.4));
    grd.addColorStop(0, "#2c2c28");
    grd.addColorStop(1, "#000");
    g.fillStyle = grd;
    g.fillRect(fx(ws.z), fy(ws.y1), fx(-ws.z) - fx(ws.z), fy(2.4) - fy(ws.y1));
  } else p.box(fx(ws.z), fy(ws.y1), fx(-ws.z), fy(ws.y0), M.inside);
  // Destination display behind the glass: 藤沢 / FUJISAWA (lit on the lead and the tail).
  const dz = 0.42;
  p.box(fx(dz), fy(2.89), fx(-dz), fy(2.66), M.display);
  if (kind === "lead" || kind === "tail") {
    if (p.albedo || p.mode === "emit") {
      g.fillStyle = p.albedo ? "#ff9a3c" : "#ff8a2a";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `800 ${(fy(2.66) - fy(2.89)) * 0.62}px ${JP_SANS}`;
      g.fillText("藤 沢", (fx(dz) + fx(-dz)) / 2, fy(2.8));
      g.fillStyle = p.albedo ? "#f2efe6" : "#9a988f";
      g.font = `700 ${(fy(2.66) - fy(2.89)) * 0.2}px ${LATIN}`;
      g.fillText("FUJISAWA", (fx(dz) + fx(-dz)) / 2, fy(2.69));
    }
  }
  // Pillar of the two-pane windscreen and the wiper at rest.
  p.box(fx(-0.42) - 2, fy(ws.y1), fx(-0.42) + 2, fy(ws.y0), M.rubber);
  p.line(fx(0.32), fy(1.9), fx(-0.48), fy(2.06), 3, M.black);
  g.restore();
  // Headlights in chrome bezels, tail lights outboard.
  for (const s of [1, -1]) {
    const hx = fx(s * 0.63);
    const hy = fy(1.22);
    const rr = (fx(0) - fx(0.11)) * 1;
    p.disc(hx, hy, rr * 1.18, M.chrome);
    p.disc(hx, hy, rr, M.lens);
    if (p.albedo) {
      const grd = g.createRadialGradient(hx - rr * 0.3, hy - rr * 0.3, rr * 0.1, hx, hy, rr);
      grd.addColorStop(0, lead ? "#fffdf6" : "#f2f0ea");
      grd.addColorStop(0.6, lead ? "#f4ecd8" : "#c9c6bc");
      grd.addColorStop(1, "#8c8a84");
      g.fillStyle = grd;
      g.beginPath();
      g.arc(hx, hy, rr, 0, Math.PI * 2);
      g.fill();
    }
    if (p.mode === "emit" && lead) {
      const grd = g.createRadialGradient(hx, hy, 0, hx, hy, rr);
      grd.addColorStop(0, "#fff6e6");
      grd.addColorStop(0.75, "#e8d8b8");
      grd.addColorStop(1, "#000");
      g.fillStyle = grd;
      g.beginPath();
      g.arc(hx, hy, rr, 0, Math.PI * 2);
      g.fill();
    }
    const tx = fx(s * 0.95);
    const ty = fy(1.18);
    const tr = fx(0) - fx(0.05);
    p.disc(tx, ty, tr * 1.25, M.chrome);
    p.disc(tx, ty, tr, kind === "tail" ? { ...M.tailLens, c: "#a3221a", e: "#ff2a14" } : M.tailLens);
  }
  // Car number in white, right of centre.
  if (p.albedo || p.mode === "height") {
    g.fillStyle = p.albedo ? "#f3f0e8" : "rgb(135,135,135)";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `800 ${fy(1.3) - fy(1.48)}px ${LATIN}`;
    g.fillText(num, fx(-0.55), fy(1.47));
  }
  if (p.mode === "orm") {
    // Lettering is paint: same finish as the green.
  }
  // Grime low on the face and around the coupler.
  if (p.albedo) {
    const grd = g.createLinearGradient(0, fy(1.1), 0, fy(0.78));
    grd.addColorStop(0, "rgba(60,52,40,0)");
    grd.addColorStop(1, "rgba(60,52,40,0.35)");
    g.fillStyle = grd;
    g.fillRect(X0, fy(1.1), FACE.w, fy(0.78) - fy(1.1));
  }
  void r;
}

function paintPanels(p: LayerPen, r: Rng): void {
  const g = p.g;
  // Air-conditioner top: louvres either side of two fan grilles.
  {
    const [x, y, w, h] = RECTS.acTop;
    p.rect(x, y, w, h, M.acGrey);
    for (let k = 0; k < 2; k++) {
      const cx = x + w * (0.3 + 0.4 * k);
      p.disc(cx, y + h / 2, h * 0.32, M.dark);
      for (let q = 0; q < 6; q++) p.line(cx - h * 0.3, y + h / 2 - h * 0.25 + q * h * 0.1, cx + h * 0.3, y + h / 2 - h * 0.25 + q * h * 0.1, 2, M.acGrey);
    }
    for (let q = 0; q < 26; q++) {
      const lx = x + 12 + q * ((w - 24) / 26);
      if (Math.abs(lx - (x + w * 0.3)) < h * 0.4 || Math.abs(lx - (x + w * 0.7)) < h * 0.4) continue;
      p.box(lx, y + h * 0.18, lx + 4, y + h * 0.82, M.seam);
    }
    p.wash("rgba(90,80,60,0.12)", x, y, w, h);
  }
  {
    const [x, y, w, h] = RECTS.acSide;
    p.rect(x, y, w, h, M.acGrey);
    for (let q = 0; q < 40; q++) p.box(x + 8 + q * 12.4, y + h * 0.25, x + 12 + q * 12.4, y + h * 0.8, M.seam);
  }
  {
    const [x, y, w, h] = RECTS.bogie;
    p.rect(x, y, w, h, M.bogie);
    p.box(x, y + h * 0.4, x + w, y + h * 0.45, M.seam);
    if (p.albedo) for (let k = 0; k < 30; k++) p.wash(`rgba(${r.int(80, 110)},${r.int(60, 75)},${r.int(40, 50)},0.18)`, r.range(x, x + w), r.range(y, y + h), r.range(6, 30), r.range(3, 12));
  }
  {
    const [x, y, w, h] = RECTS.under;
    p.rect(x, y, w, h, M.dark);
    for (let q = 1; q < 6; q++) p.box(x + (q * w) / 6 - 1, y, x + (q * w) / 6 + 1, y + h, M.seam);
    p.box(x + 20, y + 10, x + 44, y + 24, M.cream);
    if (p.albedo) p.wash("rgba(80,62,44,0.25)", x, y + h * 0.6, w, h * 0.4);
  }
  {
    const [x, y, w, h] = RECTS.bellows;
    p.rect(x, y, w, h, M.bellows);
    for (let q = 0; q < h; q += 8) p.box(x, y + q, x + w, y + q + 3, M.seam);
  }
  {
    // Side emblem: a green roundel with a gold ring above the company name.
    const [x, y, w, h] = RECTS.emblem;
    p.rect(x, y, w, h, M.cream);
    const cx = x + w / 2;
    const cy = y + w * 0.5;
    p.disc(cx, cy, w * 0.42, M.gold);
    p.disc(cx, cy, w * 0.38, M.green);
    if (p.albedo) {
      g.strokeStyle = "#e6dcc2";
      g.lineWidth = 4;
      for (const dy of [-10, 0, 10]) {
        g.beginPath();
        g.moveTo(cx - 26, cy + dy);
        g.bezierCurveTo(cx - 12, cy + dy - 9, cx + 12, cy + dy + 9, cx + 26, cy + dy);
        g.stroke();
      }
      g.fillStyle = "#2a5a4e";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `600 22px ${LATIN}`;
      g.fillText("ENODEN", cx, y + h - 22);
    }
  }
  // Car numbers for the sides, white on the green.
  for (const n of ["502", "552", "501", "551"] as const) {
    const [x, y, w, h] = RECTS[`num${n}`];
    p.rect(x, y, w, h, M.green);
    if (p.albedo || p.mode === "height") {
      g.fillStyle = p.albedo ? "#f3f0e8" : "rgb(135,135,135)";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `800 ${h * 0.8}px ${LATIN}`;
      g.fillText(n, x + w / 2, y + h * 0.54);
    }
  }
  // Flat colour cells.
  SOLID_NAMES.forEach((n, i) => {
    const m: Mat = (M as Record<string, Mat>)[n] ?? M.dark;
    p.rect(i * 64, 944, 64, 64, m);
  });
}

function paintAll(p: LayerPen): void {
  const r = new Rng(502);
  p.rect(0, 0, AW, AH, M.dark);
  paintStrip(p, r);
  paintFace(p, "lead", "502", new Rng(1));
  paintFace(p, "coupledA", "552", new Rng(2));
  paintFace(p, "coupledB", "501", new Rng(3));
  paintFace(p, "tail", "551", new Rng(4));
  paintFace(p, "end", "", new Rng(5));
  paintPanels(p, new Rng(6));
}

export interface LiveryMaps {
  map: Texture;
  orm: Texture;
  normal: Texture;
  emissive: Texture;
}

/** The 500 type's maps (painted once per build; the stage disposes them with the place). */
export function enoden500Maps(): LiveryMaps {
  return {
    map: pbrTexture(paintLayer(AW, AH, 1, "albedo", paintAll), true, "enoden500-albedo"),
    orm: pbrTexture(paintLayer(AW, AH, 0.5, "orm", paintAll), false, "enoden500-orm"),
    normal: pbrTexture(heightToNormal(paintLayer(AW, AH, 0.5, "height", paintAll), undefined, 3.0), false, "enoden500-normal"),
    emissive: pbrTexture(paintLayer(AW, AH, 0.25, "emit", paintAll), true, "enoden500-emission"),
  };
}
