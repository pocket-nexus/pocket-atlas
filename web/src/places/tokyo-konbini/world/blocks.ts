import {
  CylinderGeometry,
  LatheGeometry,
  PlaneGeometry,
  PointLight,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
} from "three";
import { Rng } from "../../../core/random";
import { mapUV, type AtlasRect } from "../../shared/atlas";
import { JP_SANS, JP_SERIF, LATIN, lanternWrap, lightboxSign, neonSign, norenCloth, productAtlas, toTexture, type SignStyle } from "../gfx/canvas";
import { box } from "../../shared/geo";
import { seedWindowUV } from "../gfx/interior";
import type { World } from "./context";
import { acUnit } from "./konbini";
import { L } from "./layout";

type WallKind = "beige" | "brown" | "gray" | "white" | "green";
type Upper = "grid" | "balcony" | "ribbon" | "old";
type Ground = "shutter" | "shop" | "lobby" | "blank" | "laundry" | "custom";

interface Spec {
  /** World position of the facade's local origin (left end at street level). */
  x: number;
  z: number;
  ry: number;
  width: number;
  depth: number;
  floors: number;
  groundH?: number;
  floorH?: number;
  wall: WallKind | "concrete";
  upper: Upper;
  ground: Ground;
  shopName?: string;
  shopColor?: string;
  signs?: number;
  roof?: "billboard" | "tank" | "plain";
  seed: number;
  detail?: boolean;
}

const VERTICAL_SIGNS: SignStyle[] = [
  { text: "スナック雫", bg: "#1a0b2e", fg: "#ff7ad9" },
  { text: "BAR月光", bg: "#0b1a2e", fg: "#ffe07a" },
  { text: "カラオケ", bg: "#e8332a", fg: "#ffffff" },
  { text: "麻雀東風", bg: "#0f5a2a", fg: "#ffffff" },
  { text: "居酒屋", bg: "#f7efe0", fg: "#b3140e", serif: true },
  { text: "焼鳥", bg: "#1a1a1a", fg: "#ffb03a", serif: true },
  { text: "整骨院", bg: "#ffffff", fg: "#1a7a3a" },
  { text: "美容室", bg: "#ffffff", fg: "#d0408a" },
  { text: "歯科", bg: "#ffffff", fg: "#0b4ea2" },
  { text: "占い", bg: "#3a1a6a", fg: "#ffd85a" },
  { text: "ホルモン", bg: "#ffd21a", fg: "#1a1a1a" },
  { text: "寿司", bg: "#f7efe0", fg: "#111111", serif: true },
  { text: "中華龍園", bg: "#c8141a", fg: "#ffe07a" },
  { text: "喫茶純", bg: "#3a2414", fg: "#f7e7c7", serif: true },
  { text: "英会話", bg: "#1f6fd1", fg: "#ffffff" },
  { text: "ネイル", bg: "#ffe3f0", fg: "#c0307a" },
  { text: "漫画喫茶", bg: "#ff7a1a", fg: "#ffffff" },
  { text: "鍼灸", bg: "#ffffff", fg: "#2a2a2a", serif: true },
  { text: "学習塾", bg: "#1a5ab8", fg: "#ffffff" },
  { text: "天ぷら", bg: "#f7efe0", fg: "#1a1a1a", serif: true },
  { text: "餃子", bg: "#e8332a", fg: "#ffffff" },
  { text: "古本", bg: "#2a3a2a", fg: "#e8e0c8", serif: true },
  { text: "質", bg: "#ffffff", fg: "#c8141a", serif: true },
  { text: "ダーツ", bg: "#101010", fg: "#39e0ff" },
];

const SHOP_NAMES: [string, string][] = [
  ["クリーニング", "#1f6fd1"],
  ["たばこ", "#b3140e"],
  ["酒のやまだ", "#1a1a1a"],
  ["青果 八百甚", "#1f8a3a"],
  ["花屋", "#c0307a"],
  ["理容 ヤマグチ", "#1a4ab8"],
  ["不動産", "#0b3f85"],
  ["和菓子 松月", "#5a2a14"],
];

export function buildBlocks(w: World): void {
  const specs: Spec[] = [];
  const rng = new Rng(9090);
  const walls: WallKind[] = ["beige", "brown", "gray", "white", "green"];
  const uppers: Upper[] = ["grid", "balcony", "grid", "ribbon", "old", "balcony"];

  // Hand-built neighbours next to the konbini.
  ramenShop(w);
  izakaya(w);

  // North side, west of the izakaya.
  let x = -21;
  while (x > -86) {
    const width = rng.range(6.5, 10.5);
    specs.push({
      x: x - width,
      z: L.mainNorth,
      ry: 0,
      width: width - 0.08,
      depth: rng.range(9, 14),
      floors: rng.int(3, 7),
      wall: rng.pick(walls),
      upper: rng.pick(uppers),
      ground: rng.pick(["shutter", "shop", "lobby", "shutter", "shop"] as Ground[]),
      signs: rng.chance(0.5) ? rng.int(2, 4) : 0,
      roof: rng.pick(["tank", "plain", "billboard", "plain"] as const),
      seed: rng.int(1, 1e6),
      detail: x > -50,
    });
    x -= width;
  }
  // North side, east of the coin parking.
  x = 22.5;
  while (x < 86) {
    const width = rng.range(6.5, 11);
    specs.push({
      x,
      z: L.mainNorth,
      ry: 0,
      width: width - 0.08,
      depth: rng.range(9, 14),
      floors: rng.int(3, 8),
      wall: rng.pick(walls),
      upper: rng.pick(uppers),
      ground: rng.pick(["shutter", "shop", "lobby", "shop"] as Ground[]),
      signs: rng.chance(0.55) ? rng.int(2, 4) : 0,
      roof: rng.pick(["tank", "plain", "billboard"] as const),
      seed: rng.int(1, 1e6),
      detail: x < 50,
    });
    x += width;
  }
  // South side (facing north), west of the cross street. Facades at z = 7.4, ry = π.
  const south = (x0: number, x1: number, first: Partial<Spec>[]) => {
    let cx = x1;
    let i = 0;
    while (cx > x0) {
      const width = Math.min(cx - x0, first[i]?.width ?? rng.range(6.5, 10.5));
      if (width < 3) break;
      specs.push({
        x: cx,
        z: L.mainSouth,
        ry: Math.PI,
        width: width - 0.08,
        depth: rng.range(9, 13),
        floors: rng.int(3, 7),
        wall: rng.pick(walls),
        upper: rng.pick(uppers),
        ground: rng.pick(["shutter", "shop", "lobby", "shop"] as Ground[]),
        signs: rng.chance(0.45) ? rng.int(2, 3) : 0,
        roof: rng.pick(["tank", "plain", "billboard"] as const),
        seed: rng.int(1, 1e6),
        detail: Math.abs(cx) < 45,
        ...first[i],
      });
      cx -= width;
      i++;
    }
  };
  south(-86, L.crossWest, [
    { width: 7.0, ground: "laundry", floors: 4, upper: "grid", wall: "white", signs: 2 },
    { width: 6.0, ground: "shutter", floors: 3, upper: "old", wall: "brown" },
    { width: 8.5, ground: "shop", floors: 5, upper: "balcony", wall: "beige", signs: 3 },
  ]);
  // South side, east of the cross street. Origin is the facade's left end seen from the street.
  {
    let cx = 86;
    while (cx > L.crossEast + 3) {
      const width = Math.min(cx - L.crossEast, rng.range(6.5, 10.5));
      specs.push({
        x: cx,
        z: L.mainSouth,
        ry: Math.PI,
        width: width - 0.08,
        depth: rng.range(9, 13),
        floors: rng.int(3, 8),
        wall: rng.pick(walls),
        upper: rng.pick(uppers),
        ground: rng.pick(["shutter", "shop", "lobby"] as Ground[]),
        signs: rng.chance(0.5) ? rng.int(2, 4) : 0,
        roof: rng.pick(["tank", "plain", "billboard"] as const),
        seed: rng.int(1, 1e6),
        detail: cx < 50,
      });
      cx -= width;
    }
  }
  // Cross street, west side north of the konbini (facades on x = 7 facing +x): ry = π/2, local +x runs toward −z.
  let z = L.konbini.z0 - 0.2;
  while (z > -120) {
    const width = rng.range(6, 10);
    specs.push({
      x: L.crossWest,
      z,
      ry: Math.PI / 2,
      width: width - 0.08,
      depth: rng.range(10, 14),
      floors: rng.int(4, 9),
      wall: rng.pick(walls),
      upper: rng.pick(uppers),
      ground: rng.pick(["shop", "shutter", "shop", "lobby"] as Ground[]),
      signs: rng.chance(0.8) ? rng.int(3, 5) : 0,
      roof: rng.pick(["billboard", "tank", "plain"] as const),
      seed: rng.int(1, 1e6),
      detail: z > -70,
    });
    z -= width;
  }
  // Cross street, east side north of the coin parking (facades on x = 13 facing −x): ry = −π/2, local +x runs toward +z.
  z = -120;
  while (z < -12.2) {
    const width = Math.min(-12.2 - z, rng.range(6, 10));
    if (width < 3) break;
    specs.push({
      x: L.crossEast,
      z,
      ry: -Math.PI / 2,
      width: width - 0.08,
      depth: rng.range(10, 14),
      floors: rng.int(4, 9),
      wall: rng.pick(walls),
      upper: rng.pick(uppers),
      ground: rng.pick(["shop", "shutter", "shop", "lobby"] as Ground[]),
      signs: rng.chance(0.8) ? rng.int(3, 5) : 0,
      roof: rng.pick(["billboard", "tank", "plain"] as const),
      seed: rng.int(1, 1e6),
      detail: z > -70,
    });
    z += width;
  }
  // Cross street south of the main street, both sides.
  z = L.mainSouth + 0.1;
  while (z < 90) {
    const width = rng.range(6, 10);
    // West side (facing +x): origin at the south end (local +x runs toward −z).
    specs.push({
      x: L.crossWest,
      z: z + width,
      ry: Math.PI / 2,
      width: width - 0.08,
      depth: rng.range(10, 13),
      floors: rng.int(3, 8),
      wall: rng.pick(walls),
      upper: rng.pick(uppers),
      ground: rng.pick(["shop", "shutter", "lobby"] as Ground[]),
      signs: rng.chance(0.6) ? rng.int(2, 4) : 0,
      roof: rng.pick(["billboard", "tank", "plain"] as const),
      seed: rng.int(1, 1e6),
      detail: z < 40,
    });
    // East side (facing −x): origin at the north end.
    specs.push({
      x: L.crossEast,
      z,
      ry: -Math.PI / 2,
      width: width - 0.08,
      depth: rng.range(10, 13),
      floors: rng.int(3, 8),
      wall: rng.pick(walls),
      upper: rng.pick(uppers),
      ground: rng.pick(["shop", "shutter", "lobby"] as Ground[]),
      signs: rng.chance(0.6) ? rng.int(2, 4) : 0,
      roof: rng.pick(["billboard", "tank", "plain"] as const),
      seed: rng.int(1, 1e6),
      detail: z < 40,
    });
    z += width;
  }

  const winMat = w.lib.interiorWindows();
  const signIdx = { i: 0 };
  for (const s of specs) building(w, s, winMat, signIdx);
}

// ------------------------------------------------------------------ helpers

function atlasPlane(w: number, h: number, r: AtlasRect): PlaneGeometry {
  return mapUV(new PlaneGeometry(w, h), r) as PlaneGeometry;
}

function wallMat(w: World, k: WallKind | "concrete"): Material {
  return k === "concrete" ? w.lib.concrete([0.46, 0.46, 0.45]) : w.lib.wallTile(k);
}

/** One generic mid-rise. Local frame: facade on z = 0 facing +z, x ∈ [0, width], body toward −z. */
function building(w: World, s: Spec, winMat: Material, signIdx: { i: number }): void {
  const lib = w.lib;
  const r = new Rng(s.seed);
  const g = w.group(s.x, 0, s.z, s.ry);
  const gh = s.groundH ?? r.range(3.3, 3.8);
  const fh = s.floorH ?? r.range(2.85, 3.2);
  const H = gh + fh * (s.floors - 1);
  const W = s.width;
  const D = s.depth;
  const wall = wallMat(w, s.wall);
  const frame = lib.brushed(r.chance(0.6) ? [0.6, 0.62, 0.64] : [0.16, 0.16, 0.17]);
  const detail = s.detail !== false;

  // Mass (upper floors sit flush; ground floor front is handled by the shopfront).
  w.mesh(box(W, H - gh, D), wall, W / 2, gh + (H - gh) / 2, -D / 2, g);
  // Ground-floor mass starts behind the shop interior (which sits at z ≈ -0.9).
  w.mesh(box(W, gh, D - 1.2), wall, W / 2, gh / 2, -D / 2 - 0.6, g);
  // Side pilasters on the ground floor frame the shopfront.
  w.mesh(box(0.3, gh, 0.4), wall, 0.15, gh / 2, -0.2, g);
  w.mesh(box(0.3, gh, 0.4), wall, W - 0.15, gh / 2, -0.2, g);
  // Floor band between ground and first floor.
  w.mesh(box(W + 0.04, 0.35, 0.12), lib.concrete([0.42, 0.42, 0.41]), W / 2, gh - 0.1, 0.04, g);

  groundFloor(w, g, s, r, W, gh);

  // Upper floors.
  const bays = Math.max(1, Math.round(W / r.range(2.0, 2.8)));
  const bayW = W / bays;
  for (let f = 1; f < s.floors; f++) {
    const y0 = gh + (f - 1) * fh;
    if (s.upper === "ribbon") {
      const band = seedWindowUV(new PlaneGeometry(W - 0.5, fh * 0.55), r.int(0, 999), f + (s.seed % 97));
      w.mesh(band, winMat, W / 2, y0 + fh * 0.52, 0.01, g, { cast: false });
      for (let b = 0; b <= bays; b++) w.mesh(box(0.06, fh * 0.58, 0.08), frame, 0.25 + ((W - 0.5) * b) / bays, y0 + fh * 0.52, 0.04, g);
      w.mesh(box(W - 0.4, 0.08, 0.1), frame, W / 2, y0 + fh * 0.23, 0.05, g);
      continue;
    }
    if (s.upper === "balcony") {
      w.mesh(box(W - 0.2, 0.16, 1.0), lib.concrete([0.5, 0.5, 0.49]), W / 2, y0 + 0.08, 0.5, g);
      w.mesh(box(W - 0.2, 0.9, 0.08), r.chance(0.5) ? wall : lib.paint(0xcfd2d0, 0.4), W / 2, y0 + 0.6, 0.96, g);
      w.mesh(box(W - 0.16, 0.04, 0.1), frame, W / 2, y0 + 1.07, 0.96, g);
    }
    for (let b = 0; b < bays; b++) {
      const bx = (b + 0.5) * bayW;
      const ww = s.upper === "balcony" ? bayW - 0.5 : Math.min(bayW - 0.6, r.range(1.1, 1.7));
      const wh = s.upper === "balcony" ? fh * 0.68 : s.upper === "old" ? fh * 0.42 : fh * 0.48;
      const wy = y0 + (s.upper === "balcony" ? 0.2 + wh / 2 : fh * 0.55);
      const quad = seedWindowUV(new PlaneGeometry(ww, wh), r.int(0, 999), f + (s.seed % 97));
      w.mesh(quad, winMat, bx, wy, -0.1, g, { cast: false });
      if (detail) {
        // Frame and sill.
        w.mesh(box(ww + 0.08, 0.05, 0.14), frame, bx, wy + wh / 2, -0.05, g);
        w.mesh(box(ww + 0.08, 0.05, 0.14), frame, bx, wy - wh / 2, -0.05, g);
        w.mesh(box(0.05, wh, 0.14), frame, bx - ww / 2, wy, -0.05, g);
        w.mesh(box(0.05, wh, 0.14), frame, bx + ww / 2, wy, -0.05, g);
        w.mesh(box(0.04, wh, 0.06), frame, bx, wy, -0.07, g);
        if (s.upper !== "balcony") w.mesh(box(ww + 0.2, 0.05, 0.12), lib.concrete([0.4, 0.4, 0.4]), bx, wy - wh / 2 - 0.05, 0.02, g);
        // Security grille on old buildings.
        if (s.upper === "old") for (let k = 1; k < 6; k++) w.mesh(box(0.015, wh, 0.015), lib.paint(0x3a3a3a, 0.5), bx - ww / 2 + (ww * k) / 6, wy, 0.06, g, { cast: false });
        // Hung AC outdoor units.
        if (r.chance(s.upper === "old" ? 0.45 : 0.22)) {
          const ac = w.group(bx + (r.chance(0.5) ? -1 : 1) * (ww / 2 + 0.2), s.upper === "balcony" ? y0 + 0.16 : wy - wh / 2 - 0.7, s.upper === "balcony" ? 0.5 : 0.18, 0, g);
          acUnit(w, ac);
        }
      }
    }
  }

  // Drain pipe and meter box.
  if (detail) {
    const pipe = new CylinderGeometry(0.05, 0.05, H, 8);
    w.mesh(pipe, lib.paint(0x8a8d8a, 0.5), r.chance(0.5) ? 0.35 : W - 0.35, H / 2, 0.08, g);
  }

  // Roof: parapet and furniture.
  w.mesh(box(W, 0.8, 0.18), wall, W / 2, H + 0.4, -0.09, g);
  w.mesh(box(W, 0.8, 0.18), wall, W / 2, H + 0.4, -D + 0.09, g);
  w.mesh(box(0.18, 0.8, D), wall, 0.09, H + 0.4, -D / 2, g);
  w.mesh(box(0.18, 0.8, D), wall, W - 0.09, H + 0.4, -D / 2, g);
  if (s.roof === "tank") w.mesh(new CylinderGeometry(0.8, 0.8, 1.5, 16), lib.paint(0xb8bcb4, 0.5), W * 0.6, H + 0.75, -D * 0.55, g);
  if (s.roof !== "plain" && detail) {
    const n = r.int(1, 3);
    for (let i = 0; i < n; i++) {
      const ac = w.group(r.range(1, W - 1), H, -r.range(2, D - 2), r.range(0, 3), g);
      acUnit(w, ac);
    }
  }
  if (s.roof === "billboard") rooftopBillboard(w, g, r, W, H);

  // Vertical tenant signs (袖看板), perpendicular to the facade.
  if (s.signs && s.signs > 0) {
    const side = r.chance(0.5) ? 0.45 : W - 0.45;
    const stack = w.group(side, gh + 0.4, 0.62, 0, g);
    for (let i = 0; i < s.signs; i++) {
      const si = (signIdx.i++ * 7 + s.seed) % VERTICAL_SIGNS.length;
      const style = VERTICAL_SIGNS[si];
      // Dark-backed styles are drawn as neon tubes; one atlas cell per style.
      const neon = style.bg.startsWith("#0") || style.bg.startsWith("#1");
      const rect = w.atlas.shared(`vsign-${style.text}-${neon}`, 180, 512, (c, cw, ch) => {
        const src = neon ? neonSign(style.text, style.fg, cw, ch, true) : lightboxSign({ ...style, vertical: true }, cw, ch);
        c.drawImage(src, 0, 0);
      });
      const hh = r.range(1.1, 1.5);
      const y = i * (hh + 0.12);
      w.mesh(box(0.2, hh + 0.05, 0.64), lib.paint(0x1c1c1e, 0.5), 0, y + hh / 2, 0, stack);
      for (const sd of [-1, 1]) {
        const p = atlasPlane(0.6, hh, rect);
        p.rotateY((sd * Math.PI) / 2);
        w.mesh(p, lib.sign(w.atlas.texture, neon ? 2.6 : 1.7, { key: "atlas-signs" }), sd * 0.102, y + hh / 2, 0, stack, { cast: false });
      }
      if (i === 0 && r.chance(0.5)) {
        const wp = new Vector3(side, gh + 0.4 + y + hh / 2, 1.0).applyAxisAngle(new Vector3(0, 1, 0), s.ry).add(new Vector3(s.x, 0, s.z));
        w.fog(wp, style.bg === "#ffffff" || style.bg.startsWith("#f") ? style.fg : style.bg, 0.12, 0.9);
      }
    }
    w.mesh(box(0.06, s.signs * 1.5, 0.06), lib.paint(0x2a2a2a, 0.5), 0, (s.signs * 1.5) / 2, -0.35, stack);
  }
}

function groundFloor(w: World, g: Object3D, s: Spec, r: Rng, W: number, gh: number): void {
  const lib = w.lib;
  const inner = W - 0.6;
  if (s.ground === "shutter") {
    w.mesh(box(inner, gh - 0.75, 0.06), lib.shutter(), W / 2, (gh - 0.75) / 2, -0.28, g);
    w.mesh(box(inner + 0.1, 0.42, 0.34), lib.paint(0x9a9ea2, 0.5), W / 2, gh - 0.75 + 0.21, -0.2, g);
    // A small faded sign above the shutter.
    const [name, col] = SHOP_NAMES[s.seed % SHOP_NAMES.length];
    const rect = w.atlas.shared(`shutter-${name}`, 512, 100, (c, cw, ch) => {
      c.fillStyle = "#e9e4d8";
      c.fillRect(0, 0, cw, ch);
      c.fillStyle = col;
      c.font = `800 ${ch * 0.62}px ${JP_SANS}`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(name, cw / 2, ch / 2);
    });
    w.mesh(atlasPlane(Math.min(inner, 3.2), 0.5, rect), lib.sign(w.atlas.texture, 0.12, { key: "atlas-dim" }), W / 2, gh - 0.35, 0.03, g, { cast: false });
    return;
  }
  if (s.ground === "blank") {
    w.mesh(box(inner, gh, 0.1), wallMat(w, s.wall), W / 2, gh / 2, -0.35, g);
    return;
  }
  // Glazed shopfront with a lit interior card behind the glass.
  const laundry = s.ground === "laundry";
  const lobby = s.ground === "lobby";
  const glowCol = laundry ? 0xe8f4ff : lobby ? 0xffdca8 : r.pick([0xfff0d8, 0xe8f0ff, 0xffe2c0, 0xfff8f0]);
  const interior = shopInterior(w, laundry ? "laundry" : lobby ? "lobby" : "shop", r);
  const card = atlasPlane(inner - 0.1, gh - 0.9, interior);
  w.mesh(card, lib.sign(w.atlas.texture, laundry ? 1.6 : lobby ? 0.9 : 1.2, { key: "atlas-interior" }), W / 2, (gh - 0.9) / 2 + 0.05, -0.9, g, { cast: false });
  // Side returns so the interior reads as a room.
  for (const sx of [0.3, W - 0.3]) {
    const side = new PlaneGeometry(0.6, gh - 0.8);
    side.rotateY(sx < W / 2 ? Math.PI / 2 : -Math.PI / 2);
    w.mesh(side, lib.interior(glowCol, 0.5, 0.8), sx, (gh - 0.8) / 2, -0.6, g, { cast: false });
  }
  const floor = new PlaneGeometry(inner, 0.62);
  floor.rotateX(-Math.PI / 2);
  w.mesh(floor, lib.interior(0x6a6560, 0.35, 0.4), W / 2, 0.01, -0.6, g, { cast: false });
  const glass = new PlaneGeometry(inner, gh - 0.85);
  w.mesh(glass, lib.windowGlass(), W / 2, (gh - 0.85) / 2 + 0.05, -0.28, g, { cast: false, receive: false });
  const frame = lib.brushed([0.55, 0.57, 0.6]);
  const mull = Math.max(1, Math.round(inner / 1.6));
  for (let i = 0; i <= mull; i++) w.mesh(box(0.06, gh - 0.8, 0.1), frame, 0.3 + (inner * i) / mull, (gh - 0.8) / 2, -0.26, g);
  w.mesh(box(inner, 0.08, 0.12), frame, W / 2, 0.04, -0.26, g);
  // Fascia sign.
  const [name, col] = laundry ? ["コインランドリー", "#1f6fd1"] : lobby ? [r.pick(["メゾン雨音", "グランハイツ谷中", "コーポ月見", "パレス桜"]), "#3a2a1a"] : (s.shopName ? [s.shopName, s.shopColor ?? "#b3140e"] : SHOP_NAMES[s.seed % SHOP_NAMES.length]);
  const rect = w.atlas.shared(`fascia-${name}-${lobby}-${laundry}`, 768, 128, (c, cw, ch) => {
    c.fillStyle = lobby ? "#2a2622" : "#f6f4ee";
    c.fillRect(0, 0, cw, ch);
    c.fillStyle = lobby ? "#e8d8b8" : col;
    c.font = `800 ${ch * 0.6}px ${lobby ? JP_SERIF : JP_SANS}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(name, cw / 2, ch / 2);
    if (laundry) {
      c.font = `700 ${ch * 0.22}px ${LATIN}`;
      c.fillText("COIN LAUNDRY  24H", cw / 2, ch * 0.88);
    }
  });
  w.mesh(box(inner + 0.1, 0.62, 0.22), lib.paint(0xdedcd6, 0.4), W / 2, gh - 0.44, 0.02, g);
  w.mesh(atlasPlane(inner, 0.56, rect), lib.sign(w.atlas.texture, lobby ? 0.5 : 1.5, { key: lobby ? "atlas-dim2" : "atlas-signs" }), W / 2, gh - 0.44, 0.135, g, { cast: false });
  if (laundry) {
    const wp = new Vector3(W / 2, 1.6, 0.6).applyAxisAngle(new Vector3(0, 1, 0), s.ry).add(new Vector3(s.x, 0, s.z));
    w.fog(wp, 0xdcecff, 0.35, 1.6);
    const pl = new PointLight(0xdcecff, 5, 9, 1.8);
    pl.position.copy(wp);
    w.light(pl);
  }
}

/** Painted interior "cards" for shopfronts (depth comes from the side returns and glass). */
function shopInterior(w: World, kind: "shop" | "laundry" | "lobby", r: Rng): AtlasRect {
  const variant = kind === "shop" ? r.int(0, 5) : 0;
  const pr = new Rng(variant * 31 + 7);
  r = pr;
  return w.atlas.shared(`interior-${kind}-${variant}`, 512, 288, (c, cw, ch) => {
    if (kind === "laundry") {
      const bg = c.createLinearGradient(0, 0, 0, ch);
      bg.addColorStop(0, "#f4f8ff");
      bg.addColorStop(1, "#c8d4e0");
      c.fillStyle = bg;
      c.fillRect(0, 0, cw, ch);
      // Stacked machines with round doors.
      for (let row = 0; row < 2; row++)
        for (let i = 0; i < 6; i++) {
          const x = 20 + i * ((cw - 40) / 6);
          const y = ch * 0.28 + row * ch * 0.34;
          const s = (cw - 40) / 6 - 8;
          c.fillStyle = "#f0f0ee";
          c.fillRect(x, y, s, ch * 0.32);
          c.fillStyle = "#2a3440";
          c.beginPath();
          c.arc(x + s / 2, y + ch * 0.17, s * 0.3, 0, Math.PI * 2);
          c.fill();
          c.fillStyle = "rgba(160,200,255,0.5)";
          c.beginPath();
          c.arc(x + s / 2, y + ch * 0.17, s * 0.22, 0, Math.PI * 2);
          c.fill();
        }
      c.fillStyle = "#1f6fd1";
      c.fillRect(0, 0, cw, ch * 0.08);
      return;
    }
    if (kind === "lobby") {
      const bg = c.createRadialGradient(cw / 2, ch * 0.3, 10, cw / 2, ch / 2, cw * 0.7);
      bg.addColorStop(0, "#ffe6bf");
      bg.addColorStop(1, "#5a4028");
      c.fillStyle = bg;
      c.fillRect(0, 0, cw, ch);
      c.fillStyle = "#8a7a60";
      for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++) c.fillRect(cw * 0.1 + i * 34, ch * 0.35 + j * 26, 28, 20);
      c.fillStyle = "#3a2a1a";
      c.fillRect(cw * 0.62, ch * 0.2, cw * 0.22, ch * 0.8);
      return;
    }
    const warm = r.chance(0.6);
    const bg = c.createLinearGradient(0, 0, 0, ch);
    bg.addColorStop(0, warm ? "#fff2dc" : "#f2f6ff");
    bg.addColorStop(1, warm ? "#a88a68" : "#8a98a8");
    c.fillStyle = bg;
    c.fillRect(0, 0, cw, ch);
    // Back wall of shelving stocked from the packaging atlas, receding into the room.
    const goods = shelfGoods();
    const rows = 4;
    for (let row = 0; row < rows; row++) {
      const band = r.int(0, 7);
      const y = ch * 0.16 + row * ch * 0.19;
      const sx = r.range(0, goods.width - cw * 2.2);
      c.drawImage(goods, sx, band * 128, cw * 2.2, 128, 0, y, cw, ch * 0.17);
      c.fillStyle = "rgba(40,30,24,0.55)";
      c.fillRect(0, y + ch * 0.17, cw, 3);
    }
    // A counter or display table in front, and a shopkeeper-shaped shadow.
    c.fillStyle = "rgba(30,24,20,0.55)";
    c.fillRect(cw * r.range(0.05, 0.5), ch * 0.78, cw * 0.4, ch * 0.22);
    c.fillStyle = "rgba(0,0,0,0.28)";
    c.beginPath();
    c.ellipse(cw * r.range(0.3, 0.7), ch * 0.72, cw * 0.05, ch * 0.18, 0, 0, Math.PI * 2);
    c.fill();
    // Ceiling fixtures, then fall-off toward the edges of the room.
    for (let k = 0; k < 3; k++) {
      c.fillStyle = warm ? "rgba(255,240,215,0.9)" : "rgba(235,245,255,0.95)";
      c.fillRect(cw * (0.15 + k * 0.3), 4, cw * 0.14, 5);
    }
    const vig = c.createRadialGradient(cw / 2, ch * 0.35, cw * 0.1, cw / 2, ch * 0.5, cw * 0.75);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,0,0,0.5)");
    c.fillStyle = vig;
    c.fillRect(0, 0, cw, ch);
  });
}

let goodsCanvas: HTMLCanvasElement | null = null;
/** Packaging art shared by every small shop's shelves (a different seed from the konbini). */
function shelfGoods(): HTMLCanvasElement {
  return (goodsCanvas ??= productAtlas(2048, 1024, 23));
}

function rooftopBillboard(w: World, g: Object3D, r: Rng, W: number, H: number): void {
  const lib = w.lib;
  const bw = Math.min(W - 1, r.range(4, 7));
  const bh = bw * 0.42;
  const ads: [string, string, string][] = [
    ["雨の日は、あったかい。", "#0b1a3a", "#ffe07a"],
    ["東京メトロ", "#0b4ea2", "#ffffff"],
    ["Pocket City", "#111111", "#4fe3c1"],
    ["ビール 生", "#f5c400", "#b3140e"],
    ["24時間 ジム", "#e8332a", "#ffffff"],
    ["歯医者 ●● 駅前", "#ffffff", "#0b4ea2"],
  ];
  const [text, bg, fg] = r.pick(ads);
  const rect = w.atlas.shared(`billboard-${text}`, 768, 300, (c, cw, ch) => {
    c.fillStyle = bg;
    c.fillRect(0, 0, cw, ch);
    c.fillStyle = fg;
    c.font = `900 ${ch * 0.3}px ${JP_SANS}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, cw / 2, ch / 2);
  });
  const y = H + 1.2 + bh / 2;
  w.mesh(atlasPlane(bw, bh, rect), lib.sign(w.atlas.texture, 1.4, { key: "atlas-signs" }), W / 2, y, -0.4, g, { cast: false });
  w.mesh(box(bw + 0.1, bh + 0.1, 0.15), lib.paint(0x222222, 0.5), W / 2, y, -0.5, g);
  for (const x of [W / 2 - bw * 0.35, W / 2 + bw * 0.35]) w.mesh(box(0.08, 1.4 + bh / 2, 0.08), lib.paint(0x333333, 0.5), x, H + (1.4 + bh / 2) / 2, -0.7, g);
}

// ------------------------------------------------------------- ramen shop

function ramenShop(w: World): void {
  const lib = w.lib;
  const x0 = -13;
  const x1 = L.alley.x0;
  const W = x1 - x0;
  const g = w.group(x0, 0, L.mainNorth, 0);
  const gh = 3.4;
  const fh = 3.0;
  const floors = 4;
  const H = gh + fh * (floors - 1);
  const wall = lib.wallTile("brown");
  w.mesh(box(W, H - gh, 12), wall, W / 2, gh + (H - gh) / 2, -6, g);
  w.mesh(box(W, gh, 10.4), wall, W / 2, gh / 2, -6.8, g);
  // Wooden storefront.
  const wood = lib.wood([0.36, 0.22, 0.12]);
  w.mesh(box(W, 0.5, 0.25), wood, W / 2, gh - 0.25, -0.1, g);
  w.mesh(box(0.25, gh, 0.3), wood, 0.12, gh / 2, -0.15, g);
  w.mesh(box(0.25, gh, 0.3), wood, W - 0.12, gh / 2, -0.15, g);
  // Warm interior behind frosted sliding doors.
  const inside = w.atlas.draw(640, 360, (c, cw, ch) => {
    const bg = c.createLinearGradient(0, 0, 0, ch);
    bg.addColorStop(0, "#ffd8a0");
    bg.addColorStop(1, "#8a4a20");
    c.fillStyle = bg;
    c.fillRect(0, 0, cw, ch);
    // Counter and stools, a steam haze, menu tags on the wall.
    c.fillStyle = "#5a3018";
    c.fillRect(0, ch * 0.62, cw, ch * 0.1);
    for (let i = 0; i < 6; i++) {
      c.fillStyle = "#c83a1a";
      c.beginPath();
      c.arc(40 + i * 100, ch * 0.8, 18, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#2a1a10";
      c.fillRect(37 + i * 100, ch * 0.8, 6, ch * 0.2);
    }
    for (let i = 0; i < 9; i++) {
      c.fillStyle = "#f7efe0";
      c.fillRect(20 + i * 68, ch * 0.08, 52, ch * 0.3);
      c.fillStyle = "#1a1a1a";
      c.font = `700 22px ${JP_SERIF}`;
      c.textAlign = "center";
      verticalMenu(c, ["醤油", "味噌", "塩", "豚骨", "餃子", "炒飯", "ビール", "替玉", "味玉"][i], 46 + i * 68, ch * 0.1);
    }
    const steam = c.createRadialGradient(cw * 0.5, ch * 0.5, 10, cw * 0.5, ch * 0.5, cw * 0.5);
    steam.addColorStop(0, "rgba(255,240,220,0.35)");
    steam.addColorStop(1, "rgba(255,240,220,0)");
    c.fillStyle = steam;
    c.fillRect(0, 0, cw, ch);
  });
  w.mesh(atlasPlane(W - 0.6, gh - 0.7, inside), lib.sign(w.atlas.texture, 1.3, { key: "atlas-interior" }), W / 2, (gh - 0.7) / 2 + 0.05, -1.2, g, { cast: false });
  const frost = lib.windowGlass();
  w.mesh(new PlaneGeometry(W - 0.5, gh - 0.6), frost, W / 2, (gh - 0.6) / 2, -0.3, g, { cast: false, receive: false });
  for (let i = 0; i <= 4; i++) w.mesh(box(0.06, gh - 0.55, 0.08), wood, 0.25 + ((W - 0.5) * i) / 4, (gh - 0.55) / 2, -0.28, g);
  w.mesh(box(W - 0.5, 0.06, 0.08), wood, W / 2, 1.0, -0.28, g);
  // Noren over the entrance (animated sway handled by a gentle static tilt).
  const noren = toTexture(norenCloth("らーめん", "#1a2340"));
  const nMat = lib.sign(noren, 0.18, { rough: 0.9, key: "noren" });
  for (let i = 0; i < 4; i++) {
    const p = new PlaneGeometry(0.48, 0.95);
    mapUV(p, { u0: i / 4 + 0.005, u1: (i + 1) / 4 - 0.005, v0: 0, v1: 1 });
    const m = w.mesh(p, nMat, W / 2 - 0.75 + i * 0.5, gh - 0.95, 0.12, g, { cast: false });
    m.rotation.x = -0.04 - i * 0.01;
  }
  w.mesh(box(2.2, 0.04, 0.04), wood, W / 2, gh - 0.46, 0.12, g);
  // Sign board over the door: lit.
  const board = w.atlas.draw(1024, 200, (c, cw, ch) => {
    c.fillStyle = "#f4ead2";
    c.fillRect(0, 0, cw, ch);
    c.fillStyle = "#b3140e";
    c.font = `900 ${ch * 0.62}px ${JP_SERIF}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("らーめん 雨宿", cw / 2, ch * 0.52);
  });
  w.mesh(box(W - 0.3, 0.7, 0.22), lib.paint(0x2a1a10, 0.6), W / 2, gh + 0.4, 0.05, g);
  w.drip([x0 + 0.2, gh + 0.03, L.mainNorth + 0.17], [x1 - 0.2, gh + 0.03, L.mainNorth + 0.17]);
  // Kitchen exhaust hood above the door: steam rolls out into the rain.
  const hood = w.group(W - 0.9, gh + 1.35, 0.05, 0, g);
  w.mesh(box(0.55, 0.42, 0.3), lib.brushed([0.5, 0.52, 0.54]), 0, 0, 0.15, hood);
  for (let i = 0; i < 5; i++) w.mesh(box(0.5, 0.025, 0.06), lib.plain(0x1a1a1a, 0.6), 0, -0.15 + i * 0.075, 0.31, hood, { cast: false });
  w.steamVents.push({ origin: new Vector3(x0 + W - 0.9, gh + 1.3, L.mainNorth + 0.45), dir: new Vector3(0.15, 0.25, 1) });
  w.mesh(atlasPlane(W - 0.45, 0.6, board), lib.sign(w.atlas.texture, 1.5, { key: "atlas-signs" }), W / 2, gh + 0.4, 0.165, g, { cast: false });
  // Red lanterns either side.
  lantern(w, g, 0.6, gh - 0.55, 0.45, "ラーメン");
  lantern(w, g, W - 0.6, gh - 0.55, 0.45, "ラーメン");
  // Menu stand on the street.
  const menu = w.atlas.draw(300, 420, (c, cw, ch) => {
    c.fillStyle = "#1a1410";
    c.fillRect(0, 0, cw, ch);
    c.fillStyle = "#f4ead2";
    c.font = `800 ${cw * 0.13}px ${JP_SERIF}`;
    c.textAlign = "center";
    c.fillText("本日のおすすめ", cw / 2, ch * 0.12);
    c.font = `600 ${cw * 0.1}px ${JP_SANS}`;
    ["醤油らーめん 850", "味噌らーめん 900", "餃子 (6) 450", "生ビール 550"].forEach((t, i) => c.fillText(t, cw / 2, ch * (0.3 + i * 0.16)));
  });
  const stand = w.group(W - 1.2, 0, 0.5, -0.25, g);
  w.mesh(box(0.5, 0.75, 0.04), lib.paint(0x3a2a1a, 0.6), 0, 0.55, 0, stand);
  w.mesh(atlasPlane(0.44, 0.62, menu), lib.sign(w.atlas.texture, 0.35, { key: "atlas-menus" }), 0, 0.58, 0.022, stand, { cast: false });
  w.mesh(box(0.04, 0.3, 0.04), lib.paint(0x3a2a1a, 0.6), -0.2, 0.15, 0, stand);
  w.mesh(box(0.04, 0.3, 0.04), lib.paint(0x3a2a1a, 0.6), 0.2, 0.15, 0, stand);

  // Upper floors: small windows and a sign stack by the alley.
  const winMat = lib.interiorWindows();
  const frame = lib.brushed([0.6, 0.62, 0.64]);
  for (let f = 1; f < floors; f++) {
    for (let b = 0; b < 2; b++) {
      const bx = 1.5 + b * 2.9;
      const wy = gh + (f - 1) * fh + 1.6;
      const q = seedWindowUV(new PlaneGeometry(1.3, 1.25), 400 + b * 7 + f * 13, 50 + f);
      w.mesh(q, winMat, bx, wy, -0.08, g, { cast: false });
      w.mesh(box(1.38, 0.05, 0.12), frame, bx, wy + 0.64, -0.04, g);
      w.mesh(box(1.38, 0.05, 0.12), frame, bx, wy - 0.64, -0.04, g);
      w.mesh(box(0.05, 1.3, 0.12), frame, bx - 0.67, wy, -0.04, g);
      w.mesh(box(0.05, 1.3, 0.12), frame, bx + 0.67, wy, -0.04, g);
    }
  }
  w.mesh(box(W, 0.7, 0.18), wall, W / 2, H + 0.35, -0.09, g);
  const stackSigns: SignStyle[] = [
    { text: "スナック雫", bg: "#1a0b2e", fg: "#ff7ad9" },
    { text: "BAR月光", bg: "#0b1a2e", fg: "#ffe07a" },
    { text: "麻雀東風", bg: "#0f5a2a", fg: "#ffffff" },
  ];
  const stack = w.group(W - 0.4, gh + 0.9, 0.6, 0, g);
  // The snack bar's neon is on its last legs: its own material so it can stutter.
  const flickerMat = lib.sign(w.atlas.texture, 2.6, { key: "atlas-signs-flicker" });
  stackSigns.forEach((st, i) => {
    const neon = i === 0;
    const rect = w.atlas.draw(180, 512, (c, cw, ch) => c.drawImage(neon ? neonSign(st.text, st.fg, cw, ch, true) : lightboxSign({ ...st, vertical: true }, cw, ch), 0, 0));
    const y = i * 1.55;
    w.mesh(box(0.2, 1.45, 0.64), lib.paint(0x1c1c1e, 0.5), 0, y + 0.72, 0, stack);
    for (const sd of [-1, 1]) {
      const p = atlasPlane(0.6, 1.4, rect);
      p.rotateY((sd * Math.PI) / 2);
      w.mesh(p, neon ? flickerMat : lib.sign(w.atlas.texture, 1.7, { key: "atlas-signs" }), sd * 0.102, y + 0.72, 0, stack, { cast: false });
    }
  });
  const neonFog = w.fog(new Vector3(x0 + W - 0.4, gh + 1.6, L.mainNorth + 0.9), 0xff5ad0, 0.22, 0.8);
  w.update((_dt, t) => {
    // Mostly on; every few seconds a burst of stutters, sometimes a dropout.
    const cycle = t % 7.3;
    let on = 1;
    if (cycle > 5.9 && cycle < 6.6) on = Math.sin(t * 90) * Math.sin(t * 37) > 0.1 ? 1 : 0.08;
    else if (cycle > 6.6 && cycle < 6.9) on = 0.05;
    const hum = 0.94 + 0.06 * Math.sin(t * 120);
    flickerMat.emissiveIntensity = 2.6 * on * hum;
    neonFog.gain = on * hum;
  });
  // Warm spill from the shop.
  const warm = new PointLight(0xffb070, 7, 8, 1.8);
  warm.position.set(x0 + W / 2, 2.0, L.mainNorth + 0.9);
  w.light(warm);
  w.fog(new Vector3(x0 + W / 2, 2.2, L.mainNorth + 0.6), 0xffa060, 0.3, 1.2);
}

function verticalMenu(c: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  Array.from(text).forEach((ch, i) => c.fillText(ch, x, y + 26 + i * 26));
}

/** Red paper lantern (chōchin) on a bracket, glowing from inside. */
function lantern(w: World, parent: Object3D, x: number, y: number, z: number, text: string): void {
  const lib = w.lib;
  const pts: Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    pts.push(new Vector2(0.03 + Math.sin(t * Math.PI) * 0.19, -0.3 + t * 0.6));
  }
  const geo = new LatheGeometry(pts, 24);
  const tex = toTexture(lanternWrap(text));
  const mat = lib.sign(tex, 2.2, { rough: 0.8, key: `lantern-${text}` });
  const m = w.mesh(geo, mat, x, y, z, parent, { cast: false });
  m.rotation.y = -Math.PI / 2;
  w.mesh(new CylinderGeometry(0.1, 0.1, 0.05, 16), lib.paint(0x111111, 0.5), x, y + 0.31, z, parent);
  w.mesh(new CylinderGeometry(0.1, 0.1, 0.05, 16), lib.paint(0x111111, 0.5), x, y - 0.31, z, parent);
  w.mesh(box(0.03, 0.03, 0.45), lib.paint(0x111111, 0.5), x, y + 0.36, z - 0.22, parent);
}

// ----------------------------------------------------------------- izakaya

function izakaya(w: World): void {
  const lib = w.lib;
  const x0 = -21;
  const x1 = -13;
  const W = x1 - x0;
  const g = w.group(x0, 0, L.mainNorth, 0);
  const gh = 3.1;
  const wood = lib.wood([0.22, 0.13, 0.08]);
  const plaster = lib.concrete([0.62, 0.58, 0.5]);
  // Two-storey timber house.
  w.mesh(box(W, 6.2, 11), plaster, W / 2, 3.1, -5.7, g);
  w.mesh(box(W, gh, 0.2), wood, W / 2, gh / 2, -0.35, g);
  // Tiled eave (sloped) over the ground floor.
  const eave = box(W + 0.4, 0.08, 1.1);
  const e = w.mesh(eave, lib.paint(0x2a2c30, 0.45), W / 2, gh + 0.25, 0.25, g);
  e.rotation.x = 0.32;
  // The eave's low front edge sheds a curtain of drips; under it stays dry.
  w.drip([x0 - 0.2, gh + 0.06, L.mainNorth + 0.78], [x1 + 0.2, gh + 0.06, L.mainNorth + 0.78]);
  w.dry([x0, 0, L.mainNorth - 1], [x1, gh + 0.2, L.mainNorth + 0.7]);
  for (let i = 0; i < 18; i++) w.mesh(box(0.05, 0.06, 1.1), lib.paint(0x1c1d20, 0.45), 0.2 + (W * i) / 18, gh + 0.3, 0.25, g).rotation.x = 0.32;
  // Sliding lattice doors with warm light behind shoji paper.
  const shoji = w.atlas.draw(512, 300, (c, cw, ch) => {
    c.fillStyle = "#ffcf8a";
    c.fillRect(0, 0, cw, ch);
    c.strokeStyle = "#3a2010";
    c.lineWidth = 5;
    for (let x = 0; x <= cw; x += cw / 6) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, ch);
      c.stroke();
    }
    for (let y = 0; y <= ch; y += ch / 5) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(cw, y);
      c.stroke();
    }
    c.fillStyle = "rgba(40,20,10,0.35)";
    c.beginPath();
    c.ellipse(cw * 0.3, ch * 0.62, 34, 60, 0, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.ellipse(cw * 0.52, ch * 0.6, 30, 56, 0, 0, Math.PI * 2);
    c.fill();
  });
  // 5 cm proud of the plaster front (z = -0.2): on its plane the two z-fight.
  w.mesh(atlasPlane(W - 1.2, 2.2, shoji), lib.sign(w.atlas.texture, 0.75, { key: "atlas-interior-shoji" }), W / 2, 1.2, -0.15, g, { cast: false });
  // Hanging sign.
  const sign = w.atlas.draw(900, 220, (c, cw, ch) => {
    c.fillStyle = "#2a1a0e";
    c.fillRect(0, 0, cw, ch);
    c.fillStyle = "#f7e7c7";
    c.font = `900 ${ch * 0.62}px ${JP_SERIF}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("居酒屋 とり吉", cw / 2, ch * 0.54);
  });
  w.mesh(atlasPlane(3.6, 0.8, sign), lib.sign(w.atlas.texture, 0.9, { key: "atlas-menus2" }), W / 2, gh + 1.2, 0.03, g, { cast: false });
  // A string of lanterns along the eave.
  for (let i = 0; i < 5; i++) lantern(w, g, 0.8 + i * ((W - 1.6) / 4), gh - 0.1, 0.72, i % 2 ? "焼鳥" : "酒");
  // Upper floor windows (shoji glow).
  for (let i = 0; i < 3; i++) {
    w.mesh(atlasPlane(1.8, 1.2, shoji), lib.sign(w.atlas.texture, 0.45, { key: "atlas-interior-dim" }), 1.4 + i * 2.6, 4.7, 0.01, g, { cast: false });
  }
  w.fog(new Vector3(x0 + W / 2, 2.6, L.mainNorth + 0.9), 0xff4020, 0.35, 1.3);
  const red = new PointLight(0xff5a30, 6, 8, 1.8);
  red.position.set(x0 + W / 2, 2.5, L.mainNorth + 1.0);
  w.light(red);
  // Timber roof.
  const roof = box(W + 0.6, 0.12, 6.4);
  const rf = w.mesh(roof, lib.paint(0x26282c, 0.4), W / 2, 6.9, -2.6, g);
  rf.rotation.x = 0.36;
}
