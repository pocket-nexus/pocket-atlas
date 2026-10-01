import { BufferGeometry, CanvasTexture, CylinderGeometry, Float32BufferAttribute, LinearMipmapLinearFilter, MeshStandardMaterial, NoColorSpace, SphereGeometry, SRGBColorSpace, TorusGeometry, Vector3, type Texture } from "three";
import { canvas, JP_SANS, LATIN, type Ctx } from "../../shared/canvas";
import { merge, rod } from "../../shared/shapes";

/*
 * Route 134 vehicles: a white kei tall-wagon, a silver minivan, a black SUV,
 * a white delivery van, a pearl sedan, a motorcycle with its rider and a
 * road cyclist. Each car is a loft of cross-sections along its length (sill,
 * widest point, beltline, tumblehome glass, roof) with wheels set flush in
 * painted arches and mirrors on the doors. One 1024 × 1024 atlas holds every
 * vehicle's side, front, rear and top views; each triangle takes the view
 * its normal faces (box projection), so the painted windows, lamps, grilles
 * and plates land on the right surfaces. A vehicle is one mesh and one
 * material (one draw on the handheld); the ORM map makes the glass glossy,
 * the paint semi-gloss and the tyres matte.
 *
 * Local frame: nose toward +x, ground at y = 0, centred on x and z.
 */

export type CarKind = "kei" | "minivan" | "suv" | "van" | "sedan";

/** Station along the car (x from the rear): sill, beltline and roof heights, half widths at the waist and the roof. */
type Station = [x: number, y0: number, y1: number, y2: number, w1: number, w2: number];

interface CarSpec {
  len: number;
  stations: Station[];
  /** Wheel radius and the axles' distances from the front and the rear. */
  wheel: number;
  axles: [front: number, rear: number];
  paint: { hex: string; rough: number; metal: number };
  /** Black plastic cladding on the sills and arches. */
  cladding?: boolean;
  /** Kei cars carry yellow plates. */
  kei?: boolean;
  /** Pillars behind the front door (from the windscreen base, m). */
  pillars: number[];
  /** Commercial van: no rear side glass. */
  panelVan?: boolean;
  /** Headlamp and tail lamp style. */
  lamps: "slim" | "tall" | "round";
}

export const CARS: Record<CarKind, CarSpec> = {
  kei: {
    len: 3.395,
    wheel: 0.28,
    axles: [0.66, 0.62],
    paint: { hex: "#eceeec", rough: 0.3, metal: 0 },
    kei: true,
    pillars: [1.0, 2.25],
    lamps: "tall",
    stations: [
      [0.0, 0.32, 0.92, 1.6, 0.66, 0.58],
      [0.07, 0.2, 0.98, 1.75, 0.72, 0.65],
      [0.45, 0.16, 1.0, 1.79, 0.737, 0.67],
      [2.5, 0.16, 1.0, 1.79, 0.737, 0.67],
      [2.75, 0.17, 0.99, 1.75, 0.737, 0.66],
      [3.08, 0.18, 0.95, 0.97, 0.735, 0.64],
      [3.32, 0.22, 0.86, 0.87, 0.71, 0.62],
      [3.395, 0.32, 0.72, 0.73, 0.64, 0.56],
    ],
  },
  minivan: {
    len: 4.7,
    wheel: 0.32,
    axles: [0.92, 0.93],
    paint: { hex: "#b9bdc0", rough: 0.34, metal: 0.55 },
    pillars: [1.05, 2.75],
    lamps: "tall",
    stations: [
      [0.0, 0.38, 1.0, 1.7, 0.8, 0.7],
      [0.08, 0.24, 1.04, 1.83, 0.85, 0.76],
      [0.6, 0.2, 1.05, 1.85, 0.865, 0.78],
      [3.25, 0.2, 1.05, 1.85, 0.865, 0.78],
      [3.6, 0.21, 1.03, 1.72, 0.865, 0.76],
      [4.02, 0.22, 0.98, 1.0, 0.86, 0.72],
      [4.55, 0.27, 0.9, 0.91, 0.83, 0.7],
      [4.7, 0.4, 0.78, 0.79, 0.74, 0.62],
    ],
  },
  suv: {
    len: 4.6,
    wheel: 0.37,
    axles: [0.92, 1.0],
    paint: { hex: "#16181b", rough: 0.22, metal: 0.2 },
    cladding: true,
    pillars: [1.1],
    lamps: "slim",
    stations: [
      [0.0, 0.5, 1.0, 1.24, 0.86, 0.7],
      [0.1, 0.37, 1.07, 1.54, 0.91, 0.72],
      [0.5, 0.33, 1.1, 1.67, 0.93, 0.75],
      [0.95, 0.33, 1.1, 1.71, 0.93, 0.76],
      [2.95, 0.33, 1.09, 1.71, 0.93, 0.76],
      [3.38, 0.34, 1.07, 1.5, 0.93, 0.73],
      [3.66, 0.35, 1.04, 1.06, 0.92, 0.71],
      [4.42, 0.39, 0.97, 0.98, 0.89, 0.7],
      [4.6, 0.5, 0.8, 0.81, 0.8, 0.62],
    ],
  },
  van: {
    len: 4.695,
    wheel: 0.31,
    axles: [1.0, 1.06],
    paint: { hex: "#f0f1ee", rough: 0.36, metal: 0 },
    pillars: [0.95, 2.0, 3.15],
    lamps: "tall",
    stations: [
      [0.0, 0.32, 1.04, 1.9, 0.83, 0.78],
      [0.05, 0.24, 1.08, 1.96, 0.845, 0.8],
      [4.3, 0.24, 1.08, 1.98, 0.845, 0.8],
      [4.52, 0.26, 1.06, 1.84, 0.84, 0.78],
      [4.64, 0.3, 0.98, 1.06, 0.83, 0.76],
      [4.695, 0.38, 0.8, 0.81, 0.79, 0.7],
    ],
  },
  sedan: {
    len: 4.6,
    wheel: 0.31,
    axles: [0.95, 0.95],
    paint: { hex: "#e4e3dd", rough: 0.24, metal: 0.25 },
    pillars: [1.12],
    lamps: "slim",
    stations: [
      [0.0, 0.42, 0.86, 0.88, 0.8, 0.7],
      [0.12, 0.3, 0.97, 0.99, 0.86, 0.72],
      [0.5, 0.28, 0.99, 1.06, 0.88, 0.72],
      [1.4, 0.26, 0.98, 1.44, 0.88, 0.7],
      [2.55, 0.26, 0.96, 1.47, 0.88, 0.7],
      [3.3, 0.27, 0.92, 0.94, 0.88, 0.7],
      [4.4, 0.3, 0.78, 0.79, 0.85, 0.66],
      [4.6, 0.42, 0.62, 0.63, 0.76, 0.58],
    ],
  },
};

const SLOTS: CarKind[] = ["kei", "minivan", "suv", "van", "sedan"];

// ------------------------------------------------------------------ atlas

const A = 1024;
/** View cells of a slot: side (x along, y up), front / rear (z across, y up), top (x along, z across). */
function cells(kind: CarKind) {
  const i = SLOTS.indexOf(kind);
  const bx = (i % 2) * 512;
  const by = Math.floor(i / 2) * 240;
  return {
    side: [bx, by, 512, 136],
    front: [bx, by + 136, 150, 104],
    rear: [bx + 154, by + 136, 150, 104],
    top: [bx + 308, by + 136, 204, 104],
  } as const;
}
type View = "side" | "front" | "rear" | "top";

const SHARED = ["tyre", "rim", "black", "chrome", "glass", "red", "amber", "lens", "helmet", "jacket", "jeans", "skin", "jersey", "white", "frame", "silver"] as const;
type Shared = (typeof SHARED)[number];
const sharedXY = (n: Shared): [number, number] => [SHARED.indexOf(n) * 64, 960];

function extents(spec: CarSpec) {
  const hw = Math.max(...spec.stations.map((s) => s[4])) + 0.06;
  const h = Math.max(...spec.stations.map((s) => s[3])) + 0.08;
  return { hw, h, hl: spec.len / 2 + 0.06 };
}

/** Canvas position of a point in a view (x, z centred; y up). */
function canvasXY(kind: CarKind, view: View, x: number, y: number, z: number): [number, number] {
  const spec = CARS[kind];
  const { hw, h, hl } = extents(spec);
  const [cx, cy, cw, ch] = cells(kind)[view];
  switch (view) {
    case "side":
      return [cx + ((x + hl) / (2 * hl)) * cw, cy + (1 - y / h) * ch];
    case "front":
      return [cx + (0.5 - z / (2 * hw)) * cw, cy + (1 - y / h) * ch];
    case "rear":
      return [cx + (0.5 + z / (2 * hw)) * cw, cy + (1 - y / h) * ch];
    case "top":
      return [cx + ((x + hl) / (2 * hl)) * cw, cy + (0.5 + z / (2 * hw)) * ch];
  }
}

function uvOf(kind: CarKind, view: View, x: number, y: number, z: number): [number, number] {
  const [px, py] = canvasXY(kind, view, x, y, z);
  return [px / A, 1 - py / A];
}

function sharedUV(n: Shared, fu = 0.5, fv = 0.5): [number, number] {
  const [x, y] = sharedXY(n);
  return [(x + 2 + fu * 60) / A, 1 - (y + 2 + (1 - fv) * 60) / A];
}

// --------------------------------------------------------------- painting

type Mode = "albedo" | "orm";
interface Finish {
  c: string;
  r: number;
  m: number;
}
const F = {
  glass: { c: "#0d1215", r: 0.05, m: 0 },
  black: { c: "#141516", r: 0.6, m: 0 },
  trim: { c: "#0f1011", r: 0.35, m: 0 },
  chrome: { c: "#c6c9cb", r: 0.15, m: 1 },
  lens: { c: "#d7dadc", r: 0.08, m: 0.2 },
  red: { c: "#8e1512", r: 0.15, m: 0 },
  amber: { c: "#d0861c", r: 0.15, m: 0 },
  plate: { c: "#f2f1ea", r: 0.4, m: 0 },
  keiPlate: { c: "#f0cf2a", r: 0.4, m: 0 },
  tyre: { c: "#1a1a1b", r: 0.88, m: 0 },
  rim: { c: "#9fa3a6", r: 0.3, m: 0.9 },
  helmet: { c: "#e8e8e4", r: 0.25, m: 0 },
  jacket: { c: "#24272c", r: 0.7, m: 0 },
  jeans: { c: "#33415a", r: 0.8, m: 0 },
  skin: { c: "#c49c82", r: 0.55, m: 0 },
  jersey: { c: "#c8382e", r: 0.5, m: 0 },
  white: { c: "#ecebe6", r: 0.5, m: 0 },
  frame: { c: "#1b2a44", r: 0.3, m: 0.4 },
  silver: { c: "#b5b9bb", r: 0.3, m: 0.8 },
} satisfies Record<string, Finish>;

class Pen {
  constructor(
    readonly g: Ctx,
    readonly mode: Mode,
  ) {}
  get albedo(): boolean {
    return this.mode === "albedo";
  }
  style(f: Finish): string {
    return this.mode === "albedo" ? f.c : `rgb(255,${Math.round(f.r * 255)},${Math.round(f.m * 255)})`;
  }
  fill(f: Finish): void {
    this.g.fillStyle = this.style(f);
    this.g.fill();
  }
  rect(x: number, y: number, w: number, h: number, f: Finish): void {
    this.g.fillStyle = this.style(f);
    this.g.fillRect(x, y, w, h);
  }
  poly(pts: [number, number][], f: Finish): void {
    const g = this.g;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    this.fill(f);
  }
  wash(fill: string | CanvasGradient, x: number, y: number, w: number, h: number): void {
    if (!this.albedo) return;
    this.g.fillStyle = fill;
    this.g.fillRect(x, y, w, h);
  }
}

/** Linear interpolation of a station column at x (from the rear). */
function at(spec: CarSpec, x: number, k: 1 | 2 | 3 | 4 | 5): number {
  const st = spec.stations;
  if (x <= st[0][0]) return st[0][k];
  for (let i = 1; i < st.length; i++)
    if (x <= st[i][0]) {
      const t = (x - st[i - 1][0]) / (st[i][0] - st[i - 1][0]);
      return st[i - 1][k] + t * (st[i][k] - st[i - 1][k]);
    }
  return st[st.length - 1][k];
}

/** Key x positions (from the rear): windscreen base, roof front and rear, rear-window base. */
function keys(spec: CarSpec) {
  const st = spec.stations;
  const top = Math.max(...st.map((s) => s[3]));
  const roof = st.filter((s) => s[3] >= top - 0.03);
  const rf = roof[roof.length - 1][0];
  const rr = roof[0][0];
  const a = st.find((s) => s[0] > rf && s[3] - s[2] < 0.06)?.[0] ?? spec.len;
  const rb = [...st].reverse().find((s) => s[0] < rr && s[3] - s[2] < 0.06)?.[0] ?? 0;
  return { a, rf, rr, rb, top };
}

function plateText(p: Pen, x: number, y: number, w: number, h: number, kei: boolean, van: boolean): void {
  const g = p.g;
  p.rect(x, y, w, h, kei ? F.keiPlate : F.plate);
  if (!p.albedo) return;
  g.strokeStyle = kei ? "#1a1a1a" : "#1d5a34";
  g.lineWidth = Math.max(0.6, w * 0.03);
  g.strokeRect(x + w * 0.05, y + h * 0.08, w * 0.9, h * 0.84);
  g.fillStyle = kei ? "#1a1a1a" : "#1d5a34";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${h * 0.3}px ${JP_SANS}`;
  g.fillText(`湘南 ${van ? "400" : kei ? "580" : "300"}`, x + w / 2, y + h * 0.3);
  g.font = `700 ${h * 0.5}px ${LATIN}`;
  g.fillText(kei ? "12-07" : van ? "46-31" : "3-58", x + w * 0.56, y + h * 0.68);
}

function paintCar(p: Pen, kind: CarKind): void {
  const spec = CARS[kind];
  const g = p.g;
  const paint: Finish = { c: spec.paint.hex, r: spec.paint.rough, m: spec.paint.metal };
  const C = cells(kind);
  const half = spec.len / 2;
  const K = keys(spec);
  const xc = (x: number) => x - half;
  const S = (x: number, y: number) => canvasXY(kind, "side", xc(x), y, 0);
  // ---------------------------------------------------------------- side
  {
    const [cx, cy, cw, ch] = C.side;
    p.rect(cx, cy, cw, ch, paint);
    // Body shading: darker toward the sill, a light character line under the belt.
    if (p.albedo) {
      const top = S(0, at(spec, K.rf, 2))[1];
      const grd = g.createLinearGradient(0, top, 0, cy + ch);
      grd.addColorStop(0, "rgba(255,255,255,0.04)");
      grd.addColorStop(0.75, "rgba(0,0,0,0.04)");
      grd.addColorStop(1, "rgba(0,0,0,0.22)");
      g.fillStyle = grd;
      g.fillRect(cx, cy, cw, ch);
    }
    // Side glass: the greenhouse between the windscreen and the rear pillar, inset at the frame.
    const xs: number[] = [];
    for (let x = Math.max(K.rb, 0.05); x <= Math.min(K.a, spec.len - 0.05); x += 0.05) xs.push(x);
    const xEnd = Math.min(K.a, spec.len);
    const xBeg = spec.panelVan ? K.a - spec.pillars[0] : K.rb + (K.rb > 0 ? 0.05 : 0.12);
    const topPts: [number, number][] = [];
    const botPts: [number, number][] = [];
    for (const x of xs) {
      if (x < xBeg || x > xEnd) continue;
      const y1 = at(spec, x, 2);
      const y2 = at(spec, x, 3);
      if (y2 - y1 < 0.12) continue;
      topPts.push(S(x, y2 - 0.06));
      botPts.push(S(x, y1 + 0.03));
    }
    if (topPts.length > 1) {
      // Pull the front and rear ends of the glass in along the slopes.
      p.poly([...topPts, ...botPts.reverse()], F.trim);
      const inner = [...topPts.map(([x, y]) => [x, y + 1.2] as [number, number]), ...botPts.map(([x, y]) => [x, y - 1.2] as [number, number])];
      p.poly(inner, F.glass);
      if (p.albedo) {
        // Sky in the upper glass, the cabin dark below; a driver behind the front side window.
        const yTop = Math.min(...topPts.map((q) => q[1]));
        const yBot = Math.max(...botPts.map((q) => q[1]));
        g.save();
        g.beginPath();
        inner.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.clip();
        const grd = g.createLinearGradient(0, yTop, 0, yBot);
        grd.addColorStop(0, "rgba(120,150,170,0.25)");
        grd.addColorStop(0.5, "rgba(40,50,58,0.1)");
        grd.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = grd;
        g.fillRect(cx, yTop, cw, yBot - yTop);
        const dx = S(K.a - 0.75, 0)[0];
        const hy = S(0, at(spec, K.a - 0.75, 2) + 0.32)[1];
        g.fillStyle = "#1e2124";
        g.beginPath();
        g.ellipse(dx, hy, 4.5, 5.5, 0, 0, Math.PI * 2);
        g.fill();
        g.fillRect(dx - 7, hy + 5, 14, 12);
        g.restore();
      }
      // Blacked-out pillars.
      for (const d of spec.pillars) {
        if (spec.panelVan && d !== spec.pillars[0]) continue;
        const x = K.a - d;
        const [px] = S(x, 0);
        const w = (0.09 / spec.len) * cw * 1.0;
        p.rect(px - w / 2, cy, w, ch, F.trim);
        // Restore body paint above the roof line and below the belt where the strip overran.
        const yRoof = S(x, at(spec, x, 3) - 0.035)[1];
        const yBelt = S(x, at(spec, x, 2))[1];
        p.rect(px - w / 2 - 1, cy, w + 2, yRoof - cy, paint);
        p.rect(px - w / 2 - 1, yBelt, w + 2, cy + ch - yBelt, paint);
      }
    }
    // Door cuts and handles.
    const cuts = spec.panelVan ? [K.a - 0.05, K.a - spec.pillars[0] - 0.02, K.a - spec.pillars[0] - 0.95] : [K.a - 0.05, ...spec.pillars.map((d) => K.a - d), K.rr + (K.rb > 0 ? 0.45 : 0.3)];
    for (const x of cuts) {
      const [px] = S(x, 0);
      const y0 = S(x, at(spec, x, 1) + 0.06)[1];
      const y1 = S(x, at(spec, x, 2) - 0.01)[1];
      p.rect(px - 0.6, y1, 1.2, y0 - y1, F.trim);
    }
    for (let i = 0; i < cuts.length - 1; i++) {
      const x = cuts[i + 1] + 0.12;
      const [hx, hy] = S(x, at(spec, x, 2) - 0.1);
      p.rect(hx, hy - 1.5, 7, 3, kind === "suv" ? F.chrome : F.black);
    }
    // Sills and cladding.
    {
      const pts: [number, number][] = [];
      for (let x = 0; x <= spec.len + 0.001; x += 0.1) pts.push(S(x, at(spec, x, 1) + (spec.cladding ? 0.17 : 0.07)));
      for (let x = spec.len; x >= -0.001; x -= 0.1) pts.push(S(x, at(spec, x, 1) - 0.05));
      p.poly(pts, spec.cladding ? F.black : { c: "#2a2b2c", r: 0.6, m: 0 });
    }
    // Wheel arches.
    for (const [ax, sgn] of [
      [spec.len - spec.axles[0], 1],
      [spec.axles[1], -1],
    ] as [number, number][]) {
      const [px, py] = S(ax, spec.wheel);
      const r = ((spec.wheel + 0.07) / (2 * extents(spec).hl)) * cw;
      if (spec.cladding) {
        g.beginPath();
        g.arc(px, py, r * 1.22, Math.PI, 0);
        g.closePath();
        p.fill(F.black);
      }
      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      p.fill({ c: "#0b0b0c", r: 0.9, m: 0 });
      void sgn;
    }
    // Lamps wrapping onto the sides.
    const yb = at(spec, 0.05, 2);
    if (spec.lamps === "tall") p.poly([S(0, yb + 0.12), S(0.12, yb + 0.1), S(0.12, yb - 0.32), S(0, yb - 0.34)], F.red);
    else p.poly([S(0, yb - 0.02), S(0.22, yb - 0.04), S(0.18, yb - 0.16), S(0, yb - 0.16)], F.red);
    const yh = at(spec, spec.len - 0.05, 2);
    p.poly([S(spec.len, yh - 0.04), S(spec.len - 0.32, yh - 0.02), S(spec.len - 0.28, yh - 0.12), S(spec.len, yh - 0.15)], F.lens);
    p.rect(...S(spec.len - 0.5, yh - 0.2), 4, 2, F.amber);
  }
  const { hw, h } = extents(spec);
  // --------------------------------------------------------------- front
  {
    const [cx, cy, cw, ch] = C.front;
    p.rect(cx, cy, cw, ch, paint);
    const Fp = (z: number, y: number) => canvasXY(kind, "front", 0, y, z);
    const yA = at(spec, K.a, 2);
    const w1 = at(spec, spec.len - 0.1, 4);
    const w2 = at(spec, K.rf, 5);
    // Windscreen (the steep fronts of the van and the kei use this view).
    p.poly([Fp(w2 - 0.05, K.top - 0.05), Fp(-(w2 - 0.05), K.top - 0.05), Fp(-(w1 - 0.07), yA + 0.03), Fp(w1 - 0.07, yA + 0.03)], F.glass);
    const yHood = at(spec, spec.len - 0.02, 2);
    const y0 = at(spec, spec.len - 0.02, 1);
    // Bumper intake, grille, lamps, plate.
    p.poly([Fp(w1 - 0.12, y0 + 0.2), Fp(-(w1 - 0.12), y0 + 0.2), Fp(-(w1 - 0.2), y0 + 0.02), Fp(w1 - 0.2, y0 + 0.02)], F.black);
    const gw = kind === "van" ? 0.55 : 0.45;
    p.poly([Fp(gw, yHood - 0.06), Fp(-gw, yHood - 0.06), Fp(-gw * 0.85, yHood - 0.24), Fp(gw * 0.85, yHood - 0.24)], kind === "suv" ? F.trim : F.black);
    if (p.albedo) {
      g.strokeStyle = "rgba(160,165,170,0.5)";
      g.lineWidth = 1;
      for (let k = 1; k < 4; k++) {
        const [ax, ay] = Fp(gw * 0.95, yHood - 0.06 - k * 0.045);
        const [bx] = Fp(-gw * 0.95, 0);
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, ay);
        g.stroke();
      }
    }
    for (const s of [1, -1]) {
      const zi = s * (gw + 0.04);
      const zo = s * (w1 - 0.06);
      const lampH = spec.lamps === "tall" ? 0.16 : spec.lamps === "slim" ? 0.08 : 0.12;
      p.poly([Fp(zi, yHood - 0.05), Fp(zo, yHood - 0.04), Fp(zo, yHood - 0.04 - lampH), Fp(zi, yHood - 0.08 - lampH * 0.6)], F.lens);
      p.poly([Fp(zi + s * 0.04, yHood - 0.07), Fp(zo - s * 0.04, yHood - 0.06), Fp(zo - s * 0.04, yHood - 0.06 - lampH * 0.45), Fp(zi + s * 0.04, yHood - 0.08 - lampH * 0.4)], F.chrome);
      p.rect(...Fp(s * (w1 - 0.18), y0 + 0.12), 4, 2, F.amber);
    }
    const [plx, ply] = Fp(0.165, y0 + 0.2 + 0.165);
    const [prx, pry] = Fp(-0.165, y0 + 0.2);
    plateText(p, plx, ply, prx - plx, pry - ply, !!spec.kei, kind === "van");
    void cx;
    void cy;
    void cw;
    void ch;
    void hw;
    void h;
  }
  // ---------------------------------------------------------------- rear
  {
    const [cx, cy, cw, ch] = C.rear;
    p.rect(cx, cy, cw, ch, paint);
    const R = (z: number, y: number) => canvasXY(kind, "rear", 0, y, z);
    const y0 = at(spec, 0.02, 1);
    const y1 = at(spec, 0.05, 2);
    const w1 = at(spec, 0.1, 4);
    const w2 = at(spec, Math.max(K.rr, 0.05), 5);
    const yWinBase = K.rb > 0 ? at(spec, K.rb, 2) : y1 + 0.02;
    p.poly([R(w2 - 0.06, K.top - 0.08), R(-(w2 - 0.06), K.top - 0.08), R(-(w1 - 0.1), yWinBase + 0.03), R(w1 - 0.1, yWinBase + 0.03)], F.glass);
    p.rect(...R(0.12, K.top - 0.1), (R(-0.12, 0)[0] - R(0.12, 0)[0]), 2.5, F.red);
    for (const s of [1, -1]) {
      if (spec.lamps === "tall") p.poly([R(s * (w1 - 0.02), y1 + 0.12), R(s * (w1 - 0.16), y1 + 0.12), R(s * (w1 - 0.16), y1 - 0.34), R(s * (w1 - 0.02), y1 - 0.34)], F.red);
      else p.poly([R(s * (w1 - 0.02), y1 - 0.02), R(s * (w1 - 0.42), y1 - 0.05), R(s * (w1 - 0.38), y1 - 0.16), R(s * (w1 - 0.02), y1 - 0.16)], F.red);
    }
    p.poly([R(w1 - 0.04, y0 + 0.16), R(-(w1 - 0.04), y0 + 0.16), R(-(w1 - 0.1), y0 + 0.0), R(w1 - 0.1, y0)], F.black);
    const yp = Math.max(y0 + 0.24, Math.min(y1 - 0.4, 0.75));
    const [plx, ply] = R(-0.165, yp + 0.165);
    const [prx, pry] = R(0.165, yp);
    plateText(p, plx, ply, prx - plx, pry - ply, !!spec.kei, kind === "van");
    void cx;
    void cy;
    void cw;
    void ch;
  }
  // ----------------------------------------------------------------- top
  {
    const [cx, cy, cw, ch] = C.top;
    p.rect(cx, cy, cw, ch, paint);
    const T = (x: number, z: number) => canvasXY(kind, "top", xc(x), 0, z);
    const w2 = at(spec, (K.rf + K.rr) / 2, 5);
    // Windscreen and rear window, side glass along the roof edges.
    p.poly([T(K.rf - 0.02, w2), T(K.a, at(spec, K.a, 4) - 0.05), T(K.a, -(at(spec, K.a, 4) - 0.05)), T(K.rf - 0.02, -w2)], F.glass);
    if (K.rb > 0) p.poly([T(K.rr + 0.02, w2), T(K.rb, at(spec, K.rb, 4) - 0.06), T(K.rb, -(at(spec, K.rb, 4) - 0.06)), T(K.rr + 0.02, -w2)], F.glass);
    for (const s of [1, -1]) p.poly([T(K.rr + 0.1, s * (w2 + 0.1)), T(K.rf - 0.1, s * (w2 + 0.1)), T(K.rf - 0.1, s * (w2 - 0.02)), T(K.rr + 0.1, s * (w2 - 0.02))], F.glass);
    if (kind === "suv")
      for (const s of [1, -1]) {
        const [ax, ay] = T(K.rr + 0.2, s * (w2 - 0.12));
        const [bx] = T(K.rf - 0.3, 0);
        p.rect(ax, ay - 1.5, bx - ax, 3, F.black);
      }
    if (p.albedo) {
      const grd = g.createLinearGradient(cx, 0, cx + cw, 0);
      grd.addColorStop(0, "rgba(0,0,0,0.05)");
      grd.addColorStop(0.5, "rgba(255,255,255,0.05)");
      grd.addColorStop(1, "rgba(0,0,0,0.05)");
      g.fillStyle = grd;
      g.fillRect(cx, cy, cw, ch);
    }
  }
}

function paintShared(p: Pen): void {
  const g = p.g;
  const finishes: Record<Shared, Finish> = {
    tyre: F.tyre,
    rim: F.rim,
    black: F.black,
    chrome: F.chrome,
    glass: F.glass,
    red: F.red,
    amber: F.amber,
    lens: F.lens,
    helmet: F.helmet,
    jacket: F.jacket,
    jeans: F.jeans,
    skin: F.skin,
    jersey: F.jersey,
    white: F.white,
    frame: F.frame,
    silver: F.silver,
  };
  for (const n of SHARED) {
    const [x, y] = sharedXY(n);
    p.rect(x, y, 64, 64, finishes[n]);
  }
  // Alloy wheel face: dark tyre ring, rim lip, five twin spokes, hub.
  const [x, y] = sharedXY("rim");
  const cx = x + 32;
  const cy = y + 32;
  g.beginPath();
  g.arc(cx, cy, 31, 0, Math.PI * 2);
  p.fill(F.tyre);
  g.beginPath();
  g.arc(cx, cy, 23, 0, Math.PI * 2);
  p.fill(F.rim);
  g.beginPath();
  g.arc(cx, cy, 20, 0, Math.PI * 2);
  p.fill({ c: "#2a2c2e", r: 0.5, m: 0.5 });
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 + (k % 2 ? 0.12 : -0.12);
    g.beginPath();
    g.moveTo(cx + Math.cos(a - 0.08) * 6, cy + Math.sin(a - 0.08) * 6);
    g.lineTo(cx + Math.cos(a - 0.05) * 21, cy + Math.sin(a - 0.05) * 21);
    g.lineTo(cx + Math.cos(a + 0.05) * 21, cy + Math.sin(a + 0.05) * 21);
    g.lineTo(cx + Math.cos(a + 0.08) * 6, cy + Math.sin(a + 0.08) * 6);
    g.closePath();
    p.fill(F.rim);
  }
  g.beginPath();
  g.arc(cx, cy, 6, 0, Math.PI * 2);
  p.fill(F.chrome);
}

function paintAtlas(mode: Mode, scale: number): HTMLCanvasElement {
  const { c, g } = canvas(A * scale, A * scale);
  g.setTransform(scale, 0, 0, scale, 0, 0);
  const p = new Pen(g, mode);
  p.rect(0, 0, A, A, F.black);
  for (const k of SLOTS) paintCar(p, k);
  paintShared(p);
  return c;
}

function tex(c: HTMLCanvasElement, srgb: boolean, name: string): Texture {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = 8;
  t.name = name;
  return t;
}

/** The one material every Route 134 vehicle shares. */
export function vehicleMaterial(): MeshStandardMaterial {
  const map = tex(paintAtlas("albedo", 1), true, "route134-vehicles");
  const orm = tex(paintAtlas("orm", 0.5), false, "route134-vehicles-orm");
  const m = new MeshStandardMaterial({ map, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1, envMapIntensity: 1.15 });
  m.name = "route134-vehicles";
  return m;
}

// --------------------------------------------------------------- geometry

/** Every UV at one point of a shared cell. */
function flat(g: BufferGeometry, n: Shared): BufferGeometry {
  const [u, v] = sharedUV(n);
  const c = g.getAttribute("position").count;
  const a = new Float32Array(c * 2);
  for (let i = 0; i < c; i++) {
    a[i * 2] = u;
    a[i * 2 + 1] = v;
  }
  g.setAttribute("uv", new Float32BufferAttribute(a, 2));
  return g;
}

/** Cross-section of the body at a station: half outline from the bottom centre to the roof centre. */
function section(y0: number, y1: number, y2: number, w1: number, w2: number): [number, number][] {
  const gh = y2 - y1;
  const yRoof = Math.max(y1 + 0.005, y2);
  return [
    [0, y0],
    [w1 - 0.07, y0],
    [w1 - 0.015, y0 + 0.07],
    [w1, y0 + 0.5 * (y1 - y0)],
    [w1 - 0.012, y1],
    [w1 - 0.03 - 0.6 * (w1 - w2), y1 + 0.55 * gh],
    [w2, Math.max(y1 + 0.004, yRoof - 0.05)],
    [w2 - 0.09, yRoof - 0.005],
    [0, yRoof + 0.012],
  ];
}

/**
 * Lofted body with box-projected UVs into the vehicle's view cells, wheels
 * flush in the painted arches, door mirrors.
 */
export function carGeometry(kind: CarKind): BufferGeometry {
  const spec = CARS[kind];
  const half = spec.len / 2;
  const rings: Vector3[][] = spec.stations.map(([x, y0, y1, y2, w1, w2]) => {
    const s = section(y0, y1, y2, w1, w2);
    const ring: Vector3[] = [];
    for (let i = 0; i < s.length; i++) ring.push(new Vector3(x - half, s[i][1], s[i][0]));
    for (let i = s.length - 2; i >= 0; i--) ring.push(new Vector3(x - half, s[i][1], -s[i][0]));
    return ring;
  });
  // Indexed loft for smooth normals, then per-triangle projection.
  const n = rings[0].length;
  const pos: number[] = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  const idx: number[] = [];
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      idx.push(a, a + n, a + n + 1, a, a + n + 1, a + 1);
    }
  // End caps (fan around the section's centre).
  const capCentre = (i: number) => {
    const r = rings[i];
    const c = r.reduce((s, p) => s.add(p), new Vector3()).multiplyScalar(1 / r.length);
    pos.push(c.x, c.y, c.z);
    return pos.length / 3 - 1;
  };
  const c0 = capCentre(0);
  for (let j = 0; j < n - 1; j++) idx.push(c0, j, j + 1);
  const last = (rings.length - 1) * n;
  const c1 = capCentre(rings.length - 1);
  for (let j = 0; j < n - 1; j++) idx.push(c1, last + j + 1, last + j);
  const body = new BufferGeometry();
  body.setAttribute("position", new Float32BufferAttribute(pos, 3));
  body.setIndex(idx);
  // Wind outward: compare with the direction from the car's axis.
  {
    let score = 0;
    const P = (i: number) => new Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    for (let t = 0; t < idx.length; t += 3) {
      const a = P(idx[t]);
      const b = P(idx[t + 1]);
      const c = P(idx[t + 2]);
      const nrm = b.clone().sub(a).cross(c.clone().sub(a));
      const m = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      score += nrm.dot(new Vector3(m.x * 0.3, m.y - 0.8, m.z));
    }
    if (score < 0) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    body.setIndex(idx);
  }
  body.computeVertexNormals();
  const flatBody = body.toNonIndexed();
  const P = flatBody.getAttribute("position");
  const uv = new Float32Array(P.count * 2);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let t = 0; t < P.count; t += 3) {
    a.fromBufferAttribute(P, t);
    b.fromBufferAttribute(P, t + 1);
    c.fromBufferAttribute(P, t + 2);
    const nrm = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const ax = Math.abs(nrm.x);
    const ay = Math.abs(nrm.y);
    const az = Math.abs(nrm.z);
    const view: View = az >= ax && az >= ay * 0.9 ? "side" : ay >= ax ? "top" : nrm.x > 0 ? "front" : "rear";
    [a, b, c].forEach((v, k) => {
      const [u, w] = uvOf(kind, view, v.x, v.y, v.z);
      uv[(t + k) * 2] = u;
      uv[(t + k) * 2 + 1] = w;
    });
  }
  flatBody.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  const parts: BufferGeometry[] = [flatBody];
  // Wheels: tyre tread, alloy face flush with the body side.
  for (const [ax, x] of [
    [spec.axles[0], half - spec.axles[0]],
    [spec.axles[1], -half + spec.axles[1]],
  ]) {
    const w1 = at(spec, x + half, 4);
    void ax;
    for (const s of [1, -1]) {
      const tw = 0.2;
      const zc = s * (w1 - tw / 2 + 0.01);
      const wheel = new CylinderGeometry(spec.wheel, spec.wheel, tw, 16, 1);
      wheel.rotateX(Math.PI / 2);
      wheel.translate(x, spec.wheel, zc);
      // Tread from the tyre cell, the outer face from the rim cell.
      const wuv = wheel.getAttribute("uv");
      const wp = wheel.getAttribute("position");
      const wn = wheel.getAttribute("normal");
      for (let i = 0; i < wuv.count; i++) {
        const [u, v] = wn.getZ(i) * s > 0.5 ? sharedUV("rim", 0.5 + (wp.getX(i) - x) / (2 * spec.wheel), 0.5 + (wp.getY(i) - spec.wheel) / (2 * spec.wheel)) : sharedUV("tyre");
        wuv.setXY(i, u, v);
      }
      parts.push(wheel);
    }
  }
  // Contact shade: the ground under the body, which the static sun shadow map cannot darken for a moving car.
  {
    const hw = Math.max(...spec.stations.map((st) => st[4])) - 0.1;
    const hx = half - 0.2;
    const y = 0.012;
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute([-hx, y, hw, hx, y, hw, hx, y, -hw, -hx, y, hw, hx, y, -hw, -hx, y, -hw], 3));
    g.computeVertexNormals();
    parts.push(flat(g, "tyre"));
  }
  // Door mirrors on short stalks at the windscreen base.
  const K = keys(spec);
  const mx = K.a - half - 0.12;
  const my = at(spec, K.a, 2) + 0.1;
  const mw = at(spec, K.a, 4);
  for (const s of [1, -1]) {
    const m = new SphereGeometry(0.09, 6, 4);
    m.scale(0.7, 0.75, 1.1);
    m.translate(mx, my, s * (mw + 0.12));
    const [u, v] = uvOf(kind, "side", mx, at(spec, K.a, 2) - 0.25, 0);
    const muv = m.getAttribute("uv");
    for (let i = 0; i < muv.count; i++) muv.setXY(i, u, v);
    parts.push(m);
    parts.push(flat(rod(new Vector3(mx, my - 0.02, s * (mw - 0.02)), new Vector3(mx, my - 0.02, s * (mw + 0.06)), 0.015, 4), "black"));
  }
  return merge(parts);
}

/** Motorcycle with its rider (dark riding jacket, jeans, white helmet), nose toward +x. */
export function motoGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const wheel = (x: number) => {
    const t = new TorusGeometry(0.28, 0.065, 6, 16);
    t.translate(x, 0.33, 0);
    parts.push(flat(t, "tyre"));
    const d = new CylinderGeometry(0.22, 0.22, 0.05, 12);
    d.rotateX(Math.PI / 2);
    d.translate(x, 0.33, 0);
    parts.push(flat(d, "silver"));
  };
  wheel(0.72);
  wheel(-0.68);
  const v = (x: number, y: number, z = 0) => new Vector3(x, y, z);
  // Fork, frame, engine, tank, seat, tail.
  parts.push(flat(rod(v(0.72, 0.33), v(0.5, 0.98), 0.03, 5), "chrome"));
  parts.push(flat(rod(v(0.5, 0.95), v(-0.2, 0.62), 0.045, 5), "black"));
  parts.push(flat(rod(v(-0.68, 0.33), v(-0.1, 0.42), 0.035, 4), "black"));
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, n: Shared, rz = 0) => {
    const g = new CylinderGeometry(0.5, 0.5, 1, 4).scale(1, 1, 1);
    g.rotateY(Math.PI / 4);
    g.scale(w * 1.414, h, d * 1.414);
    g.rotateZ(rz);
    g.translate(x, y, z);
    parts.push(flat(g, n));
  };
  box(0.48, 0.34, 0.3, 0.12, 0.5, 0, "silver");
  box(0.5, 0.2, 0.32, 0.22, 0.86, 0, "jersey", -0.12);
  box(0.62, 0.1, 0.26, -0.28, 0.82, 0, "black", 0.08);
  box(0.42, 0.12, 0.2, -0.68, 0.86, 0, "jersey", 0.18);
  parts.push(flat(rod(v(-0.2, 0.5, 0.12), v(-0.75, 0.62, 0.14), 0.045, 6), "chrome"));
  parts.push(flat(rod(v(0.48, 1.0, -0.36), v(0.48, 1.0, 0.36), 0.018, 4), "black"));
  const lamp = new SphereGeometry(0.08, 6, 4);
  lamp.translate(0.62, 0.92, 0);
  parts.push(flat(lamp, "lens"));
  // Rider: hips on the seat, torso leaning to the bars, arms, legs on the pegs, helmet.
  box(0.32, 0.18, 0.34, -0.26, 0.95, 0, "jeans");
  for (const s of [1, -1]) {
    parts.push(flat(rod(v(-0.2, 0.95, s * 0.13), v(0.08, 0.72, s * 0.2), 0.065, 5), "jeans"));
    parts.push(flat(rod(v(0.08, 0.72, s * 0.2), v(-0.04, 0.38, s * 0.19), 0.055, 5), "jeans"));
    parts.push(flat(rod(v(-0.04, 0.38, s * 0.19), v(0.1, 0.36, s * 0.19), 0.045, 4), "black"));
    parts.push(flat(rod(v(-0.02, 1.4, s * 0.19), v(0.24, 1.15, s * 0.24), 0.05, 5), "jacket"));
    parts.push(flat(rod(v(0.24, 1.15, s * 0.24), v(0.46, 1.02, s * 0.3), 0.042, 5), "jacket"));
  }
  const torso = new CylinderGeometry(0.17, 0.15, 0.55, 8);
  torso.scale(1, 1, 1.3);
  torso.rotateZ(-0.55);
  torso.translate(-0.12, 1.22, 0);
  parts.push(flat(torso, "jacket"));
  const helmet = new SphereGeometry(0.15, 10, 8);
  helmet.scale(1.1, 1, 1);
  helmet.translate(0.08, 1.6, 0);
  parts.push(flat(helmet, "helmet"));
  const visor = new SphereGeometry(0.152, 8, 4, -0.9, 1.8, 1.1, 0.6);
  visor.rotateY(Math.PI / 2);
  visor.translate(0.1, 1.6, 0);
  parts.push(flat(visor, "glass"));
  return merge(parts);
}

/** Road bicycle with a rider in a cycling jersey, nose toward +x. */
export function cyclistGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const v = (x: number, y: number, z = 0) => new Vector3(x, y, z);
  for (const x of [0.5, -0.5]) {
    const t = new TorusGeometry(0.335, 0.018, 4, 18);
    t.translate(x, 0.34, 0);
    parts.push(flat(t, "tyre"));
    const r = new TorusGeometry(0.3, 0.014, 3, 18);
    r.translate(x, 0.34, 0);
    parts.push(flat(r, "black"));
    parts.push(flat(rod(v(x, 0.34, -0.05), v(x, 0.34, 0.05), 0.03, 6), "silver"));
  }
  const bb = v(0.0, 0.3);
  const seat = v(-0.16, 0.86);
  const head = v(0.44, 0.88);
  const lines: [Vector3, Vector3][] = [
    [bb, seat],
    [bb, head.clone().setY(0.78)],
    [seat, head],
    [bb, v(-0.5, 0.34)],
    [seat, v(-0.5, 0.34)],
    [head, v(0.5, 0.34)],
    [seat, v(-0.2, 0.98)],
    [head, v(0.47, 1.02)],
  ];
  for (const [a, b] of lines) parts.push(flat(rod(a, b, 0.018, 4), "frame"));
  parts.push(flat(rod(v(0.47, 1.0, -0.21), v(0.47, 1.0, 0.21), 0.015, 4), "black"));
  for (const s of [1, -1]) parts.push(flat(rod(v(0.47, 1.0, s * 0.21), v(0.56, 0.88, s * 0.2), 0.016, 4), "black"));
  const saddle = new CylinderGeometry(0.06, 0.06, 0.26, 6);
  saddle.rotateZ(Math.PI / 2);
  saddle.scale(1, 0.4, 1);
  saddle.translate(-0.2, 1.0, 0);
  parts.push(flat(saddle, "black"));
  // Rider, low over the bars.
  const hip = v(-0.2, 1.08);
  const sh = v(0.3, 1.38);
  const torso = rod(hip, sh, 0.15, 7, 0.17);
  torso.scale(1, 1, 1.2);
  parts.push(flat(torso, "jersey"));
  for (const s of [1, -1]) {
    const knee = v(0.12, 0.82 + (s > 0 ? 0.12 : -0.02), s * 0.11);
    const foot = v(0.0 + (s > 0 ? 0.12 : -0.12), 0.32 + (s > 0 ? 0.08 : -0.06), s * 0.1);
    parts.push(flat(rod(hip.clone().setZ(s * 0.1), knee, 0.065, 5), "black"));
    parts.push(flat(rod(knee, foot, 0.05, 5), "skin"));
    parts.push(flat(rod(foot, foot.clone().add(v(0.14, 0, 0)), 0.035, 4), "white"));
    parts.push(flat(rod(sh.clone().setZ(s * 0.18), v(0.47, 1.02, s * 0.2), 0.04, 5), "skin"));
  }
  const h = new SphereGeometry(0.13, 8, 6);
  h.scale(1.2, 0.9, 1);
  h.translate(0.42, 1.55, 0);
  parts.push(flat(h, "white"));
  const face = new SphereGeometry(0.1, 6, 4);
  face.translate(0.44, 1.49, 0);
  parts.push(flat(face, "skin"));
  return merge(parts);
}
