import { CylinderGeometry, LatheGeometry, SpotLight, TorusGeometry, Vector2, Vector3, type BufferGeometry, type Material } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mapUV, type AtlasRect } from "../../gfx/atlas";
import { JP_SANS, LATIN, verticalText, type Ctx } from "../../gfx/canvas";
import { box, cable } from "../../gfx/geo";
import type { World } from "../context";
import { atlasPlane, cablePoint, palette, rod, tube, v3, type Kit } from "./util";

type XZ = [number, number];

/**
 * Concrete distribution pole (コンクリート柱). Everything hangs off the side
 * facing the carriageway (`road`); crossarms reach mostly over the road so
 * nothing pokes into the facades 0.7 m behind the pole.
 */
interface PoleDef {
  id: string;
  x: number;
  z: number;
  h: number;
  road: XZ;
  /** High-voltage crossarms (腕金): reach direction and depth below the top. */
  arms?: { dir: XZ; drop: number }[];
  /**
   * Street lamp on an arm. `shadow` is off everywhere: each shadowed spot
   * re-renders every merged caster batch (~130 draw calls at the current
   * street size) for a barely visible gain under a 120° cone.
   */
  lamp?: { reach: number; shadow: boolean; dir?: XZ };
  transformer?: boolean;
  /** Wrap-around address plate (巻看板) variant. */
  plate?: number;
  /** Projecting advert (袖看板) variant. */
  ad?: number;
  guy?: XZ;
  coil?: boolean;
  sign?: "bouhan" | "hydrant";
  /** Far poles skip step bolts and plates. */
  far?: boolean;
}

interface SpanDef {
  a: string;
  b: string;
  hv?: [number, number];
  lv?: number;
  tel?: number;
}

interface PoleInfo {
  def: PoleDef;
  base: Vector3;
  road: Vector3;
  along: Vector3;
  hv: Vector3[][];
  lv: Vector3[];
  tel: Vector3[];
}

const R0 = 0.19;
const R1 = 0.1;

/** 4000 K LED street lamps (道路灯) on the poles. */
export const LAMP = { color: 0xeef3ff, intensity: 480, distance: 24, angle: 1.0, penumbra: 0.7, face: 26, y: 5.72, haze: 2.5 };

const run = (prefix: string, xs: number[], z: number, def: Partial<PoleDef>): PoleDef[] =>
  xs.map((x, i) => ({ id: `${prefix}${i}`, x, z, h: 10.4 - (i % 2) * 0.25, road: [0, 1], far: true, ...def }));

const POLES: PoleDef[] = [
  // North side of the main street, west to east.
  ...run("NW", [-66, -52], -0.72, { arms: [{ dir: [0, 1], drop: 0.5 }], road: [0, 1] }),
  { id: "N3", x: -38, z: -0.72, h: 10.6, road: [0, 1], arms: [{ dir: [0, 1], drop: 0.5 }], plate: 3, far: true },
  { id: "N2", x: -24.5, z: -0.72, h: 10.9, road: [0, 1], arms: [{ dir: [0, 1], drop: 0.5 }], transformer: true, plate: 1, ad: 2, guy: [-27.9, -0.82] },
  { id: "N1", x: -11, z: -0.72, h: 10.8, road: [0, 1], arms: [{ dir: [0, 1], drop: 0.5 }], lamp: { reach: 1.55, shadow: false }, plate: 0, ad: 0, sign: "bouhan" },
  // Konbini corner: an angle pole carrying lines west, north and east.
  { id: "C0", x: 6.8, z: -1.2, h: 11.3, road: [0.6, 0.8], arms: [{ dir: [0, 1], drop: 0.5 }, { dir: [1, 0], drop: 1.05 }], lamp: { reach: 1.5, shadow: false }, transformer: true, coil: true, plate: 2, ad: 1 },
  { id: "NE1", x: 24, z: -0.72, h: 10.8, road: [0, 1], arms: [{ dir: [0, 1], drop: 0.5 }], plate: 3 },
  { id: "NE2", x: 38, z: -0.72, h: 10.6, road: [0, 1], arms: [{ dir: [0, 1], drop: 0.5 }], far: true },
  ...run("NX", [52, 66], -0.72, { arms: [{ dir: [0, 1], drop: 0.5 }] }),
  // South side.
  ...run("SW", [-58, -44], 7.12, { road: [0, -1], arms: [{ dir: [0, -1], drop: 0.45 }] }),
  { id: "S3", x: -30, z: 7.12, h: 10.2, road: [0, -1], arms: [{ dir: [0, -1], drop: 0.45 }], plate: 1 },
  { id: "S2", x: -16.5, z: 7.12, h: 10.3, road: [0, -1], arms: [{ dir: [0, -1], drop: 0.45 }], guy: [-19.9, 7.2], ad: 2, plate: 3 },
  { id: "S1", x: -2.5, z: 7.12, h: 10.4, road: [0, -1], arms: [{ dir: [0, -1], drop: 0.45 }], transformer: true, plate: 0, sign: "hydrant" },
  { id: "S0", x: 14.6, z: 7.12, h: 10.6, road: [0, -1], arms: [{ dir: [0, -1], drop: 0.45 }], lamp: { reach: 1.6, shadow: false, dir: [-0.62, -0.78] }, plate: 2 },
  { id: "SE1", x: 27, z: 7.12, h: 10.2, road: [0, -1], arms: [{ dir: [0, -1], drop: 0.45 }], plate: 1 },
  ...run("SX", [41, 55], 7.12, { road: [0, -1], arms: [{ dir: [0, -1], drop: 0.45 }] }),
  // Cross street.
  { id: "C1", x: 7.25, z: -24, h: 10.8, road: [1, 0], arms: [{ dir: [1, 0], drop: 0.5 }], transformer: true, plate: 1 },
  { id: "C2", x: 7.25, z: -44, h: 10.6, road: [1, 0], arms: [{ dir: [1, 0], drop: 0.5 }], far: true },
  { id: "C3", x: 7.25, z: -64, h: 10.4, road: [1, 0], arms: [{ dir: [1, 0], drop: 0.5 }], far: true },
  { id: "E1", x: 12.75, z: -12.4, h: 10.4, road: [-1, 0], lamp: { reach: 1.5, shadow: false }, plate: 3, ad: 0 },
  { id: "E2", x: 12.75, z: -31, h: 10.2, road: [-1, 0], far: true },
  { id: "E3", x: 12.75, z: -50, h: 10.2, road: [-1, 0], far: true },
  { id: "CS1", x: 7.25, z: 21, h: 10.2, road: [1, 0], plate: 2 },
  { id: "CS2", x: 7.25, z: 40, h: 10.0, road: [1, 0], far: true },
  { id: "CS3", x: 7.25, z: 60, h: 10.0, road: [1, 0], far: true },
];

const MAIN: SpanDef = { a: "", b: "", hv: [0, 0], lv: 2, tel: 2 };
const SPANS: SpanDef[] = [
  { ...MAIN, a: "NW0", b: "NW1" },
  { ...MAIN, a: "NW1", b: "N3" },
  { ...MAIN, a: "N3", b: "N2" },
  { ...MAIN, a: "N2", b: "N1" },
  { ...MAIN, a: "N1", b: "C0", tel: 3 },
  { ...MAIN, a: "C0", b: "NE1" },
  { ...MAIN, a: "NE1", b: "NE2" },
  { ...MAIN, a: "NE2", b: "NX0" },
  { ...MAIN, a: "NX0", b: "NX1" },
  { a: "C0", b: "C1", hv: [1, 0], lv: 1, tel: 2 },
  { a: "C1", b: "C2", hv: [0, 0], lv: 1, tel: 2 },
  { a: "C2", b: "C3", hv: [0, 0], lv: 1, tel: 2 },
  { a: "SW0", b: "SW1", hv: [0, 0], lv: 1, tel: 1 },
  { a: "SW1", b: "S3", hv: [0, 0], lv: 1, tel: 1 },
  { a: "S3", b: "S2", hv: [0, 0], lv: 1, tel: 1 },
  { a: "S2", b: "S1", hv: [0, 0], lv: 1, tel: 2 },
  { a: "S1", b: "S0", hv: [0, 0], lv: 1, tel: 2 },
  { a: "S0", b: "SE1", hv: [0, 0], lv: 1, tel: 1 },
  { a: "SE1", b: "SX0", hv: [0, 0], lv: 1, tel: 1 },
  { a: "SX0", b: "SX1", hv: [0, 0], lv: 1, tel: 1 },
  { a: "C0", b: "E1", lv: 1, tel: 2 },
  { a: "E1", b: "E2", lv: 1, tel: 2 },
  { a: "E2", b: "E3", lv: 1, tel: 2 },
  { a: "S0", b: "CS1", lv: 1, tel: 1 },
  { a: "CS1", b: "CS2", lv: 1, tel: 1 },
  { a: "CS2", b: "CS3", lv: 1, tel: 1 },
  // Spans across the main street and the intersection.
  { a: "N1", b: "S1", lv: 1, tel: 1 },
  { a: "N2", b: "S2", lv: 1, tel: 1 },
  { a: "C0", b: "S1", tel: 1 },
  { a: "C0", b: "S0", lv: 1, tel: 1 },
];

/** Service drops (引込線) from a pole's low-voltage rack to a facade anchor. */
const DROPS: [string, number, number, number][] = [
  ["N1", -13.4, 5.3, -1.02],
  ["N1", -8.6, 5.8, 7.42],
  ["N2", -27.2, 5.4, -1.02],
  ["N2", -21.8, 5.6, 7.42],
  ["S1", -5.2, 5.2, 7.42],
  ["S1", 0.6, 5.5, 7.42],
  ["S2", -18.8, 5.4, 7.42],
  ["C0", 5.42, 6.3, -4.6],
  ["S0", 16.8, 5.3, 7.42],
  ["NE1", 26.5, 5.2, -1.02],
];

const PLATES = [
  { town: "谷中", block: "三丁目", ad: "山田歯科医院", sub: "この先50m", color: "#1a7a3a" },
  { town: "谷中", block: "二丁目", ad: "佐藤内科", sub: "↑ 100m", color: "#0b4ea2" },
  { town: "谷中", block: "三丁目", ad: "あおぞら整骨院", sub: "この先右", color: "#d8201a" },
  { town: "千駄木", block: "二丁目", ad: "中村眼科", sub: "→ 80m", color: "#6a2a8a" },
];

const ADS = [
  { head: "内科・小児科", name: "さくら診療所", foot: "この先 30m →", color: "#0b6ea2" },
  { head: "学習塾", name: "明星ゼミナール", foot: "谷中教室 2F", color: "#d8201a" },
  { head: "不動産", name: "谷中ハウジング", foot: "03-3821-4410", color: "#1a7a3a" },
];

interface PoleMats {
  concrete: Material;
  galv: Material;
  porcelain: Material;
  cable: Material;
  gray: Material;
  labels: Material;
  led: Material;
}

interface PoleAtlas {
  stripe: AtlasRect;
  guard: AtlasRect;
  plates: AtlasRect[];
  ads: AtlasRect[];
  tags: AtlasRect;
  bouhan: AtlasRect;
  hydrant: AtlasRect;
}

/** 45° hazard stripes that wrap seamlessly around a cylinder (period divides the width). */
export function hazardStripes(g: Ctx, cw: number, ch: number, period: number): void {
  g.fillStyle = "#f2c200";
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = "#151515";
  const n = Math.ceil((cw + ch) / period) + 2;
  for (let i = -n; i < n; i++) {
    const x0 = i * period;
    g.beginPath();
    g.moveTo(x0, ch);
    g.lineTo(x0 + period / 2, ch);
    g.lineTo(x0 + period / 2 + ch, 0);
    g.lineTo(x0 + ch, 0);
    g.closePath();
    g.fill();
  }
  // Road grime and scuffs.
  const grd = g.createLinearGradient(0, ch, 0, ch * 0.6);
  grd.addColorStop(0, "rgba(40,30,20,0.45)");
  grd.addColorStop(1, "rgba(40,30,20,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, cw, ch);
}

function drawAtlas(a: Kit): PoleAtlas {
  const stripe = a.draw("stripe", 128, 176, (g, cw, ch) => hazardStripes(g, cw, ch, cw / 4));
  const guard = a.draw("guard", 32, 320, (g, cw, ch) => hazardStripes(g, cw, ch, cw));
  const plates = PLATES.map((p, i) =>
    a.draw(`plate${i}`, 128, 384, (g, cw, ch) => {
      const split = ch * 0.4;
      g.fillStyle = "#1f4fa3";
      g.fillRect(0, 0, cw, split);
      g.strokeStyle = "#fff";
      g.lineWidth = cw * 0.035;
      g.strokeRect(cw * 0.07, cw * 0.07, cw * 0.86, split - cw * 0.14);
      g.fillStyle = "#fff";
      const tn = Array.from(p.town).length;
      const ts = Math.min(cw * 0.5, (split * 0.52) / (tn * 1.08));
      g.font = `900 ${ts}px ${JP_SANS}`;
      verticalText(g, p.town, cw / 2, cw * 0.14, ts);
      const bn = Array.from(p.block).length;
      const bs = Math.min(cw * 0.3, (split * 0.3) / (bn * 1.08));
      g.font = `700 ${bs}px ${JP_SANS}`;
      verticalText(g, p.block, cw / 2, cw * 0.18 + ts * 1.08 * tn, bs);
      // Sponsor half.
      g.fillStyle = "#f3f1e9";
      g.fillRect(0, split, cw, ch - split);
      g.fillStyle = p.color;
      g.fillRect(0, split, cw, cw * 0.08);
      const an = Array.from(p.ad).length;
      const as = Math.min(cw * 0.46, ((ch - split) * 0.7) / (an * 1.06));
      g.font = `900 ${as}px ${JP_SANS}`;
      verticalText(g, p.ad, cw / 2, split + cw * 0.16, as, 1.06);
      g.fillStyle = "#222";
      g.font = `700 ${cw * 0.13}px ${JP_SANS}`;
      g.textAlign = "center";
      g.fillText(p.sub, cw / 2, ch - cw * 0.16);
      g.fillStyle = "rgba(60,50,40,0.18)";
      g.fillRect(0, ch * 0.92, cw, ch * 0.08);
    }),
  );
  const ads = ADS.map((d, i) =>
    a.draw(`ad${i}`, 128, 256, (g, cw, ch) => {
      g.fillStyle = "#f5f4ee";
      g.fillRect(0, 0, cw, ch);
      g.fillStyle = d.color;
      g.fillRect(0, 0, cw, ch * 0.16);
      g.fillStyle = "#fff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `800 ${ch * 0.075}px ${JP_SANS}`;
      g.fillText(d.head, cw / 2, ch * 0.08);
      g.fillStyle = d.color;
      const n = Array.from(d.name).length;
      const s = Math.min(cw * 0.34, (ch * 0.64) / (n * 1.05));
      g.font = `900 ${s}px ${JP_SANS}`;
      verticalText(g, d.name, cw / 2, ch * 0.19, s, 1.05);
      g.fillStyle = "#222";
      g.font = `700 ${ch * 0.05}px ${JP_SANS}`;
      g.textAlign = "center";
      g.fillText(d.foot, cw / 2, ch * 0.92);
      g.strokeStyle = d.color;
      g.lineWidth = 3;
      g.strokeRect(1.5, 1.5, cw - 3, ch - 3);
    }),
  );
  // Pole number tags: eight per cell.
  const tags = a.draw("tags", 256, 128, (g, cw, ch) => {
    const tw = cw / 8;
    for (let i = 0; i < 8; i++) {
      const x = i * tw;
      g.fillStyle = "#eeeeea";
      g.fillRect(x + 2, 0, tw - 4, ch);
      g.strokeStyle = "#222";
      g.lineWidth = 1.5;
      g.strokeRect(x + 3, 2, tw - 6, ch - 4);
      g.fillStyle = "#111";
      g.font = `800 ${tw * 0.42}px ${JP_SANS}`;
      verticalText(g, i % 3 === 0 ? "谷中支" : "谷中幹", x + tw / 2, ch * 0.06, tw * 0.42);
      g.font = `800 ${tw * 0.36}px ${LATIN}`;
      g.textAlign = "center";
      g.fillText(String(12 + i * 7), x + tw / 2, ch * 0.72);
      g.font = `700 ${tw * 0.26}px ${LATIN}`;
      g.fillText(`${(i * 37) % 90 + 10}`, x + tw / 2, ch * 0.88);
    }
  });
  const bouhan = a.draw("bouhan", 128, 180, (g, cw, ch) => {
    g.fillStyle = "#f5d000";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = "#111";
    g.fillRect(0, ch * 0.8, cw, ch * 0.2);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `900 ${cw * 0.18}px ${JP_SANS}`;
    g.fillText("ひったくり", cw / 2, ch * 0.2);
    g.fillStyle = "#d8201a";
    g.font = `900 ${cw * 0.3}px ${JP_SANS}`;
    g.fillText("注意!", cw / 2, ch * 0.47);
    g.fillStyle = "#111";
    g.font = `700 ${cw * 0.09}px ${JP_SANS}`;
    g.fillText("自転車のカゴにはネットを", cw / 2, ch * 0.68);
    g.fillStyle = "#f5d000";
    g.font = `700 ${cw * 0.1}px ${JP_SANS}`;
    g.fillText("谷中警察署", cw / 2, ch * 0.9);
  });
  const hydrant = a.draw("hydrant", 96, 180, (g, cw, ch) => {
    g.fillStyle = "#d21f1a";
    g.fillRect(0, 0, cw, ch);
    g.strokeStyle = "#fff";
    g.lineWidth = 4;
    g.strokeRect(5, 5, cw - 10, ch - 10);
    g.fillStyle = "#fff";
    g.font = `900 ${cw * 0.42}px ${JP_SANS}`;
    verticalText(g, "消火栓", cw / 2, ch * 0.08, cw * 0.42, 1.12);
  });
  return { stripe, guard, plates, ads, tags, bouhan, hydrant };
}

function insulatorGeo(scale: number): BufferGeometry {
  const prof = [
    [0.018, 0],
    [0.018, 0.03],
    [0.063, 0.05],
    [0.03, 0.066],
    [0.05, 0.103],
    [0.024, 0.118],
    [0.0, 0.15],
  ].map(([x, y]) => new Vector2(x * scale, y * scale));
  return new LatheGeometry(prof, 7);
}

/** Utility poles, their hardware, the cables between them, and the street lamps. */
export function buildPoles(w: World, kit: Kit): void {
  const lib = w.lib;
  const rng = w.rng;
  const root = w.group();
  root.name = "poles";
  const P = palette(lib);
  const M: PoleMats = {
    concrete: lib.concrete([0.6, 0.6, 0.58]),
    galv: P.galv,
    porcelain: P.porcelain,
    cable: P.black,
    gray: P.gray,
    labels: kit.labels,
    led: lib.glow(0xf4f7ff, LAMP.face),
  };
  const A = drawAtlas(kit);
  const ins = insulatorGeo(1);
  const spool = insulatorGeo(0.62);
  const info = new Map<string, PoleInfo>();
  let tagIdx = 0;

  // Segment count follows span length: short drops need few, long spans keep a smooth catenary.
  const addCable = (a: Vector3, b: Vector3, sag: number, r: number) =>
    w.mesh(cable(a, b, sag, r, Math.max(6, Math.min(22, Math.round(a.distanceTo(b) * 1.1)))), M.cable, 0, 0, 0, root, { cast: false, receive: false });

  for (const d of POLES) {
    const base = v3(d.x, 0, d.z);
    const road = v3(d.road[0], 0, d.road[1]).normalize();
    const along = v3(-road.z, 0, road.x);
    const h = d.h;
    const rAt = (y: number) => R0 + (R1 - R0) * (y / h);
    const at = (r: number, y: number, s = 0) => base.clone().addScaledVector(road, r).addScaledVector(along, s).setY(y);
    const faceRoad = Math.atan2(road.x, road.z);
    const faceAlong = Math.atan2(along.x, along.z);
    const band = (y: number, hgt = 0.035) => w.mesh(new CylinderGeometry(rAt(y) + 0.01, rAt(y) + 0.01, hgt, 10, 1, true), M.galv, d.x, y, d.z, root, { cast: false });
    const pi: PoleInfo = { def: d, base, road, along, hv: [], lv: [], tel: [] };
    info.set(d.id, pi);

    // Shaft and cap.
    w.mesh(new CylinderGeometry(R1, R0, h, 16, 1, true), M.concrete, d.x, h / 2, d.z, root);
    w.mesh(new CylinderGeometry(0.035, R1 + 0.006, 0.08, 12), M.concrete, d.x, h + 0.04, d.z, root);

    if (!d.far) {
      // Tiger-striped sleeve (トラ巻き) at the road edge.
      const sl = new CylinderGeometry(rAt(1.9) + 0.005, rAt(0.3) + 0.005, 1.6, 18, 1, true);
      mapUV(sl, A.stripe);
      sl.rotateY(faceRoad);
      w.mesh(sl, M.labels, d.x, 1.1, d.z, root, { cast: false });

      // Wrap-around address plate with its sponsor.
      if (d.plate !== undefined) {
        const y0 = 2.05;
        const y1 = 3.35;
        const g = new CylinderGeometry(rAt(y1) + 0.008, rAt(y0) + 0.008, y1 - y0, 10, 1, true, -1.05, 2.1);
        mapUV(g, A.plates[d.plate % A.plates.length]);
        g.rotateY(faceRoad);
        w.mesh(g, M.labels, d.x, (y0 + y1) / 2, d.z, root, { cast: false });
        band(y0 + 0.02, 0.025);
        band(y1 - 0.02, 0.025);
      }

      // Pole number tag.
      const t = tagIdx++ % 8;
      const tr = A.tags;
      const tw = (tr.u1 - tr.u0) / 8;
      const tg = atlasPlane(0.075, 0.26, { u0: tr.u0 + tw * t + tw * 0.06, u1: tr.u0 + tw * (t + 1) - tw * 0.06, v0: tr.v0, v1: tr.v1 });
      tg.rotateY(faceAlong);
      const tp = at(0, 2.5, rAt(2.5) + 0.004);
      w.mesh(tg, M.labels, tp.x, tp.y, tp.z, root, { cast: false });

      // Projecting advert.
      if (d.ad !== undefined) {
        const r = A.ads[d.ad % A.ads.length];
        const c = at(rAt(4.1) + 0.28, 4.1);
        for (const s of [1, -1]) {
          const p = atlasPlane(0.4, 0.8, r);
          p.rotateY(faceAlong + (s < 0 ? Math.PI : 0));
          w.mesh(p, M.labels, c.x + along.x * 0.007 * s, c.y, c.z + along.z * 0.007 * s, root, { cast: false });
        }
        w.mesh(box(0.42, 0.82, 0.012), M.gray, c.x, c.y, c.z, root, { ry: faceAlong });
        for (const y of [3.78, 4.42]) w.mesh(rod(at(rAt(y), y), at(rAt(y) + 0.1, y), 0.012, 5), M.galv, 0, 0, 0, root, { cast: false });
      }

      if (d.sign === "bouhan") {
        const p = atlasPlane(0.3, 0.42, A.bouhan);
        p.rotateY(faceAlong + Math.PI);
        const c = at(0.02, 2.55, -(rAt(2.55) + 0.012));
        w.mesh(p, M.labels, c.x, c.y, c.z, root, { cast: false });
        band(2.4, 0.02);
        band(2.7, 0.02);
      } else if (d.sign === "hydrant") {
        const c = at(rAt(3.9) + 0.2, 3.9);
        for (const s of [1, -1]) {
          const p = atlasPlane(0.3, 0.54, A.hydrant);
          p.rotateY(faceAlong + (s < 0 ? Math.PI : 0));
          w.mesh(p, M.labels, c.x + along.x * 0.007 * s, c.y, c.z + along.z * 0.007 * s, root, { cast: false });
        }
        w.mesh(box(0.31, 0.55, 0.012), M.gray, c.x, c.y, c.z, root, { ry: faceAlong });
        for (const y of [3.7, 4.1]) w.mesh(rod(at(rAt(y), y), at(rAt(y) + 0.06, y), 0.012, 5), M.galv, 0, 0, 0, root, { cast: false });
      }

      // Step bolts (足場ボルト), alternating sides along the street.
      let side = 1;
      for (let y = 2.75; y < h - 1.4; y += 0.42) {
        const r = rAt(y);
        const a = at(0, y, side * r * 0.8);
        const b = at(0, y, side * (r + 0.2));
        w.mesh(rod(a, b, 0.011, 4), M.galv, 0, 0, 0, root, { cast: false });
        w.mesh(rod(b, b.clone().setY(y + 0.04), 0.01, 3), M.galv, 0, 0, 0, root, { cast: false });
        side = -side;
      }
    }

    // High-voltage crossarms with pin insulators.
    for (const arm of d.arms ?? []) {
      const dir = v3(arm.dir[0], 0, arm.dir[1]).normalize();
      const y = h - arm.drop;
      const c = base.clone().addScaledVector(dir, 0.525).setY(y);
      w.mesh(box(1.75, 0.075, 0.075), M.galv, c.x, c.y, c.z, root, { ry: Math.atan2(-dir.z, dir.x) });
      const brace = (o: number) => w.mesh(rod(base.clone().addScaledVector(dir, o).setY(y - 0.03), base.clone().addScaledVector(dir, Math.sign(o) * (R1 + 0.03)).setY(y - 0.5), 0.013, 5), M.galv, 0, 0, 0, root, { cast: false });
      brace(0.95);
      brace(-0.28);
      band(y);
      band(y - 0.5);
      const tops: Vector3[] = [];
      for (const o of [0.3, 0.8, 1.3]) {
        const p = base.clone().addScaledVector(dir, o).setY(y + 0.037);
        w.mesh(ins, M.porcelain, p.x, p.y, p.z, root, { cast: false });
        tops.push(p.clone().setY(p.y + 0.145));
      }
      pi.hv.push(tops);
    }

    // Low-voltage rack (spool insulators on a vertical strap).
    const lvY = [h - 2.0, h - 2.4];
    const rack = at(rAt(lvY[0]) + 0.03, (lvY[0] + lvY[1]) / 2);
    w.mesh(box(0.05, 0.62, 0.012), M.galv, rack.x, rack.y, rack.z, root, { ry: faceAlong, cast: false });
    band(lvY[0] + 0.18, 0.03);
    band(lvY[1] - 0.18, 0.03);
    for (const y of lvY) {
      const p = at(rAt(y) + 0.1, y - 0.045);
      w.mesh(rod(at(rAt(y) + 0.03, y), at(rAt(y) + 0.1, y), 0.008, 5), M.galv, 0, 0, 0, root, { cast: false });
      const sp = spool.clone();
      w.mesh(sp, M.porcelain, p.x, p.y, p.z, root, { cast: false });
      pi.lv.push(p.clone().setY(y + 0.02));
    }

    // Telecom cable clamps (NTT lines ride lowest).
    for (const y of [h - 4.3, h - 4.65, h - 4.95]) {
      const p = at(rAt(y) + 0.045, y);
      w.mesh(box(0.06, 0.07, 0.05), M.galv, p.x, p.y, p.z, root, { ry: faceRoad, cast: false });
      pi.tel.push(p);
    }
    band(h - 4.62, 0.9);

    // Pole-top transformer (柱上変圧器) hung on the side along the street.
    if (d.transformer) {
      const ty = 7.6;
      const cpos = at(0, ty, rAt(ty) + 0.3);
      w.mesh(new CylinderGeometry(0.23, 0.23, 0.82, 16, 1, true), M.gray, cpos.x, cpos.y, cpos.z, root);
      w.mesh(new CylinderGeometry(0.25, 0.25, 0.04, 16), M.gray, cpos.x, cpos.y + 0.43, cpos.z, root);
      w.mesh(new CylinderGeometry(0.24, 0.22, 0.05, 16), M.gray, cpos.x, cpos.y - 0.43, cpos.z, root);
      for (let i = 0; i < 7; i++) {
        const a = -1.2 + (i / 6) * 2.4 + faceAlong;
        w.mesh(box(0.025, 0.58, 0.1), M.gray, cpos.x + Math.sin(a) * 0.27, cpos.y - 0.04, cpos.z + Math.cos(a) * 0.27, root, { ry: a, cast: false });
      }
      for (const y of [ty - 0.25, ty + 0.25]) {
        w.mesh(rod(at(0, y, rAt(y)), at(0, y, rAt(y) + 0.1), 0.03, 6), M.galv, 0, 0, 0, root);
        band(y, 0.06);
      }
      const hv0 = pi.hv[0] ?? [];
      [-0.09, 0.09].forEach((o, i) => {
        const bp = cpos.clone().addScaledVector(road, o).setY(ty + 0.45);
        w.mesh(spool, M.porcelain, bp.x, bp.y, bp.z, root, { cast: false });
        const top = bp.clone().setY(bp.y + 0.09);
        const target = hv0[i];
        if (target) addCable(top, target, 0.08, 0.007);
      });
      // Low-voltage leads down to the rack.
      const lvp = pi.lv[1];
      const side = cpos.clone().addScaledVector(road, 0.2).setY(ty + 0.2);
      addCable(side, lvp, 0.12, 0.007);
      addCable(side.clone().setY(ty + 0.1), pi.lv[0], 0.1, 0.007);
      // Cutout switch.
      const cut = at(-(rAt(h - 1.5) + 0.07), h - 1.5);
      w.mesh(box(0.1, 0.24, 0.08), M.gray, cut.x, cut.y, cut.z, root, { ry: faceRoad });
    }

    // Slack coil on the telecom line.
    if (d.coil) {
      const p = at(rAt(6.4) + 0.07, 6.4, 0.18);
      const tor = new TorusGeometry(0.22, 0.016, 5, 28);
      tor.rotateY(faceAlong);
      w.mesh(tor, M.cable, p.x, p.y, p.z, root, { cast: false, receive: false });
      const tor2 = new TorusGeometry(0.2, 0.014, 5, 28);
      tor2.rotateY(faceAlong + 0.3);
      w.mesh(tor2, M.cable, p.x, p.y + 0.03, p.z, root, { cast: false, receive: false });
    }

    // Guy wire (支線) with its yellow guard (支線ガード).
    if (d.guy) {
      const anchor = v3(d.guy[0], 0.02, d.guy[1]);
      const top = at(0, h - 1.25, 0);
      w.mesh(rod(anchor, top, 0.008, 4), M.cable, 0, 0, 0, root, { cast: false, receive: false });
      const dir = top.clone().sub(anchor).normalize();
      const gd = rod(anchor.clone().addScaledVector(dir, 0.05), anchor.clone().addScaledVector(dir, 1.95), 0.034, 10);
      mapUV(gd, A.guard);
      w.mesh(gd, M.labels, 0, 0, 0, root, { cast: false });
      w.mesh(box(0.22, 0.06, 0.22), M.concrete, anchor.x, 0.03, anchor.z, root);
      band(h - 1.25, 0.05);
    }

    // Street lamp.
    if (d.lamp) {
      const ld = d.lamp.dir ? v3(d.lamp.dir[0], 0, d.lamp.dir[1]).normalize() : road.clone();
      const at2 = (r: number, y: number) => base.clone().addScaledVector(ld, r).setY(y);
      const y = LAMP.y;
      w.mesh(tube([at2(rAt(5.3) - 0.02, 5.3), at2(0.55, 5.56), at2(d.lamp.reach * 0.8, 5.7), at2(d.lamp.reach, y + 0.02)], 0.028, 7), M.galv, 0, 0, 0, root);
      w.mesh(rod(at2(rAt(4.95), 4.95), at2(0.6, 5.54), 0.016, 5), M.galv, 0, 0, 0, root, { cast: false });
      band(5.3, 0.07);
      band(4.95, 0.05);
      const hc = at2(d.lamp.reach + 0.22, y);
      const yaw = Math.atan2(-ld.z, ld.x);
      w.mesh(new RoundedBoxGeometry(0.64, 0.085, 0.25, 2, 0.03), M.gray, hc.x, hc.y, hc.z, root, { ry: yaw });
      const led = box(0.46, 0.012, 0.15);
      w.mesh(led, M.led, hc.x, hc.y - 0.043, hc.z, root, { ry: yaw, cast: false });
      w.mesh(new CylinderGeometry(0.018, 0.018, 0.03, 8), M.porcelain, hc.x - ld.x * 0.2, hc.y + 0.055, hc.z - ld.z * 0.2, root, { cast: false });

      const pos = hc.clone().setY(y - 0.07);
      const spot = new SpotLight(LAMP.color, LAMP.intensity, LAMP.distance, LAMP.angle, LAMP.penumbra, 2);
      spot.position.copy(pos);
      // Aimed ~25° out over the carriageway, so the cone clears its own pole.
      spot.target.position.copy(pos).addScaledVector(ld, 2.6).setY(0);
      const shadow = d.lamp.shadow && w.quality.shadows;
      spot.castShadow = shadow;
      if (shadow) {
        const s = Math.min(2048, w.quality.shadowMapSize);
        spot.shadow.mapSize.set(s, s);
        spot.shadow.bias = -0.0005;
        spot.shadow.normalBias = 0.025;
        spot.shadow.camera.near = 0.4;
        spot.shadow.camera.far = 16;
      }
      w.light(spot, root);
      w.light(spot.target, root);
      const fd = spot.target.position.clone().sub(pos).normalize();
      w.fog(pos, 0xe2eaff, LAMP.haze, 0.35, { direction: fd, cosOuter: Math.cos(LAMP.angle * 0.92), cosInner: Math.cos(LAMP.angle * 0.35) });
    }
  }

  // ------------------------------------------------------------- cables
  const get = (id: string) => {
    const p = info.get(id);
    if (!p) throw new Error(`props: unknown pole ${id}`);
    return p;
  };
  for (const s of SPANS) {
    const A = get(s.a);
    const B = get(s.b);
    const d = B.base.clone().sub(A.base).setY(0);
    const len = d.length();
    d.normalize();
    const perp = v3(-d.z, 0, d.x);
    const j = () => rng.range(0.85, 1.2);
    if (s.hv && A.hv[s.hv[0]] && B.hv[s.hv[1]]) {
      const key = (base: Vector3) => (p: Vector3) => p.clone().sub(base).dot(perp);
      const ka = key(A.base);
      const kb = key(B.base);
      const pa = [...A.hv[s.hv[0]]].sort((p, q) => ka(p) - ka(q));
      const pb = [...B.hv[s.hv[1]]].sort((p, q) => kb(p) - kb(q));
      const sag = len * 0.016 * j();
      for (let i = 0; i < 3; i++) addCable(pa[i], pb[i], sag * (1 + i * 0.04), 0.011);
    }
    for (let k = 0; k < (s.lv ?? 0); k++) addCable(A.lv[k % A.lv.length], B.lv[k % B.lv.length], len * 0.026 * j(), 0.0095);
    for (let k = 0; k < (s.tel ?? 0); k++) {
      const a = A.tel[k % A.tel.length];
      const b = B.tel[k % B.tel.length];
      const sag = len * (0.03 + k * 0.006) * j();
      addCable(a, b, sag, k === 0 ? 0.024 : 0.015);
      // Telecom closure (クロージャ) hanging near the corner pole.
      if (k === 0 && (s.a === "N1" && s.b === "C0")) {
        const t = 0.9;
        const p = cablePoint(a, b, sag, t);
        const cl = new CylinderGeometry(0.075, 0.075, 0.6, 12);
        cl.rotateZ(Math.PI / 2);
        cl.rotateY(Math.atan2(-d.z, d.x));
        w.mesh(cl, M.cable, p.x, p.y - 0.09, p.z, root, { cast: false, receive: false });
        const lashed = cablePoint(a, b, sag, 0.97);
        addCable(p.clone().setY(p.y - 0.09), lashed.setY(lashed.y - 0.05), 0.06, 0.012);
      }
    }
  }

  // Service drops with a small hook at the facade end.
  for (const [id, x, y, z] of DROPS) {
    const p = info.get(id);
    if (!p) continue;
    const end = v3(x, y, z);
    const len = end.distanceTo(p.lv[1]);
    addCable(p.lv[1], end, len * 0.05 + 0.1, 0.008);
    w.mesh(spool, M.porcelain, x, y - 0.1, z, root, { cast: false });
  }

}
