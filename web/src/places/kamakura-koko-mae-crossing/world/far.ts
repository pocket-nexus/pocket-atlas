import { BufferGeometry, ClampToEdgeWrapping, CylinderGeometry, Float32BufferAttribute, LinearMipmapLinearFilter, SphereGeometry, Vector3 } from "three";
import { canvas, toTexture } from "../../shared/canvas";
import { merge } from "../../shared/shapes";
import type { KamakuraWorld } from "./context";
import { bearing, SEA_Y, VIEW } from "./layout";

/**
 * The coast in the haze: Inamuragasaki (105.8°, 2.5 km) at the end of the
 * Shichirigahama hills, the Miura peninsula from Futagoyama and Zushi (97–
 * 102°, 7–9 km) past Hayama and Ōkusu-yama (125°, 13 km) to Jogashima
 * (152°, 22 km), Enoshima (248.5°, 2.2 km) with the Sea Candle, the hills
 * behind the school and Koshigoe, and the Shonan shore to the west.
 *
 * The three main landforms are cards: a few large quads standing at their
 * true distance (so the fog greys them as it greys the sea), whose ridgelines,
 * relief, woods and towns are painted into one alpha-tested texture. The
 * ridgelines come from the angles above the sea horizon measured from the
 * canonical eye (`sun-landmarks.txt`), so the silhouettes sit where the
 * photographs show them although the world here is flat. Fuji, Hakone, Izu
 * and Ōshima are hidden in the July haze and not modelled.
 */

const EYE = new Vector3(VIEW.crossing.x, 6.8, VIEW.crossing.z);
/** The flat world's sea horizon (the water ends 25 km out) is 0.04° below level; the real one 0.123°. */
const HORIZON = -0.039;

/** Ground point at a bearing and distance (km) from the canonical eye, at the height that subtends `elev`° there. */
function at(az: number, km: number, elev: number): Vector3 {
  const d = bearing(az).multiplyScalar(km * 1000);
  return new Vector3(EYE.x + d.x, EYE.y + km * 1000 * Math.tan((elev * Math.PI) / 180), EYE.z + d.z);
}

/** A curtain from a ridgeline down below the sea, leaning back so the sun lights it. */
function curtain(ridge: Vector3[], foot = -40, lean = 0.35): BufferGeometry {
  const pos: number[] = [];
  for (let i = 0; i < ridge.length - 1; i++) {
    const a = ridge[i];
    const b = ridge[i + 1];
    const toward = (p: Vector3) => {
      const d = EYE.clone().sub(p).setY(0).normalize();
      return p.clone().addScaledVector(d, (p.y - foot) / lean).setY(foot);
    };
    const a0 = toward(a);
    const b0 = toward(b);
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(a0, a));
    const toEye = EYE.clone().sub(a);
    const q = n.dot(toEye) > 0 ? [a, b, a0, b, b0, a0] : [a, a0, b, b, a0, b0];
    for (const p of q) pos.push(p.x, p.y, p.z);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ noise

function hash(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1]. */
function vnoise(x: number, y: number, s: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s);
  const b = hash(ix + 1, iy, s);
  const c = hash(ix, iy + 1, s);
  const d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Fractal value noise in [0, 1]. */
function fbm(x: number, y: number, s: number, oct = 4): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x, y, s + i * 31);
    norm += amp;
    amp *= 0.5;
    x *= 2.03;
    y *= 2.03;
  }
  return sum / norm;
}

/** Piecewise-linear profile through [bearing, value] keys, smoothed by a cosine ease. */
function profile(keys: [number, number][]): (az: number) => number {
  return (az) => {
    if (az <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [a0, v0] = keys[i];
      const [a1, v1] = keys[i + 1];
      if (az <= a1) {
        const t = (az - a0) / (a1 - a0);
        return v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * t));
      }
    }
    return keys[keys.length - 1][1];
  };
}

// ------------------------------------------------------------------ cards

type RGB = [number, number, number];

interface Card {
  /** Texture row (0 … ROWS − 1). */
  row: number;
  /** Normal tilt above the horizontal toward the eye (radians; 0.7 unless set). */
  lift?: number;
  /** Polyline of the card on the ground: [bearing °, distance km] from the canonical eye. */
  path: [number, number][];
  /** Ridgeline: degrees above the sea horizon at a bearing. */
  ridge(az: number): number;
  /**
   * sRGB colour of the land at a bearing, `e` degrees above the sea horizon,
   * under a ridge at `top`; `ew` is where the waterline lies at the card's
   * distance (below it the card is transparent).
   */
  paint(az: number, e: number, top: number, px: number, py: number, ew: number): RGB;
}

const TEX_W = 1024;
const ROW_H = 128;
const ROWS = 4;
/** Each card's v range inside its row: transparent margins keep mips from bleeding across rows. */
const ROW_TOP = 8;
const ROW_BOTTOM = 2;

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Sampled card geometry: ground points along the path by cumulative length. */
function sampler(card: Card): { at(u: number): { p: Vector3; az: number; d: number }; length: number } {
  const pts = card.path.map(([az, km]) => at(az, km, 0).setY(0));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const length = cum[cum.length - 1];
  return {
    length,
    at(u) {
      const s = u * length;
      let i = 0;
      while (i < pts.length - 2 && cum[i + 1] < s) i++;
      const t = (s - cum[i]) / (cum[i + 1] - cum[i]);
      const p = pts[i].clone().lerp(pts[i + 1], t);
      const dx = p.x - EYE.x;
      const dz = p.z - EYE.z;
      const az = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
      return { p, az, d: Math.hypot(dx, dz) };
    },
  };
}

/** Height (place y) that subtends `e`° above the flat world's sea horizon at distance d. */
const heightAt = (e: number, d: number) => EYE.y + d * Math.tan(((e + HORIZON) * Math.PI) / 180);

/** Card bottom and top heights: from under the sea to above its highest ridge. */
function extent(card: Card, smp: ReturnType<typeof sampler>): [number, number] {
  let top = SEA_Y;
  for (let k = 0; k <= 200; k++) {
    const { az, d } = smp.at(k / 200);
    top = Math.max(top, heightAt(card.ridge(az), d));
  }
  return [SEA_Y - 25, top + (top - SEA_Y) * 0.06 + 2];
}

/** Paints every card into its row of one RGBA canvas. */
function paintCards(cards: Card[]): HTMLCanvasElement {
  const { c, g } = canvas(TEX_W, ROW_H * ROWS);
  const img = g.createImageData(TEX_W, ROW_H * ROWS);
  const px = img.data;
  for (const card of cards) {
    const smp = sampler(card);
    const [yb, yt] = extent(card, smp);
    const y0 = card.row * ROW_H + ROW_TOP;
    const y1 = (card.row + 1) * ROW_H - ROW_BOTTOM;
    for (let x = 0; x < TEX_W; x++) {
      const { az, d } = smp.at((x + 0.5) / TEX_W);
      const top = card.ridge(az);
      const hTop = heightAt(top, d);
      // Canvas row of the ridge (fractional) and the elevation of each pixel.
      const yr = y1 - ((hTop - yb) / (yt - yb)) * (y1 - y0);
      const ew = (Math.atan2(SEA_Y - EYE.y, d) * 180) / Math.PI - HORIZON;
      for (let y = y0; y < y1; y++) {
        const cover = Math.max(0, Math.min(1, y + 0.5 - yr + 0.5));
        if (cover <= 0) continue;
        const h = yb + ((y1 - (y + 0.5)) / (y1 - y0)) * (yt - yb);
        const e = (Math.atan2(h - EYE.y, d) * 180) / Math.PI - HORIZON;
        // Below the waterline the card is open: the water in front or behind shows.
        if (e < ew - 0.015) continue;
        const col = card.paint(az, e, top, x, y, ew);
        const i = (y * TEX_W + x) * 4;
        px[i] = col[0];
        px[i + 1] = col[1];
        px[i + 2] = col[2];
        px[i + 3] = Math.round(cover * 255);
      }
    }
  }
  // Bleed colour into the transparent texels above the ridges (alpha stays 0) so
  // filtering at the cut edge never pulls in black.
  for (let x = 0; x < TEX_W; x++)
    for (let r = 0; r < ROWS; r++) {
      let last = -1;
      for (let y = (r + 1) * ROW_H - 1; y >= r * ROW_H; y--) {
        const i = (y * TEX_W + x) * 4;
        if (px[i + 3] > 0) last = i;
        else if (last >= 0) {
          px[i] = px[last];
          px[i + 1] = px[last + 1];
          px[i + 2] = px[last + 2];
        }
      }
    }
  g.putImageData(img, 0, 0);
  return c;
}

/** Quads of a card (one per path segment) with UVs into its row; normals tilt up toward the sun's side. */
function cardGeometry(card: Card): BufferGeometry {
  const smp = sampler(card);
  const [yb, yt] = extent(card, smp);
  const H = ROW_H * ROWS;
  const vb = 1 - ((card.row + 1) * ROW_H - ROW_BOTTOM) / H;
  const vt = 1 - (card.row * ROW_H + ROW_TOP) / H;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const pts = card.path.map(([az, km]) => at(az, km, 0).setY(0));
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const l = a.distanceTo(b);
    const u0 = s / smp.length;
    const u1 = (s + l) / smp.length;
    s += l;
    // Facing the eye, tilted up (40° by default): lit by the high western sun and the sky like a hillside.
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const lift = card.lift ?? 0.7;
    const n = EYE.clone().sub(mid).setY(0).normalize().multiplyScalar(Math.cos(lift)).setY(Math.sin(lift));
    const quad: [Vector3, number, number][] = [
      [new Vector3(a.x, yb, a.z), u0, vb],
      [new Vector3(b.x, yb, b.z), u1, vb],
      [new Vector3(b.x, yt, b.z), u1, vt],
      [new Vector3(a.x, yt, a.z), u0, vt],
    ];
    // Wind so the front face looks at the eye.
    const f = new Vector3().subVectors(quad[1][0], quad[0][0]).cross(new Vector3().subVectors(quad[3][0], quad[0][0]));
    const order = f.dot(EYE.clone().sub(a)) > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const k of order) {
      const [p, u, v] = quad[k];
      pos.push(p.x, p.y, p.z);
      nrm.push(n.x, n.y, n.z);
      uv.push(u, v);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  return g;
}

// ------------------------------------------------------------------ the landforms

/** Miura: Futagoyama and the Zushi hills, the Hayama coast, Ōkusu-yama, the low south to Jogashima. */
const MIURA: Card = (() => {
  const back = profile([
    [95.5, 0.98], [97.2, 1.3], [98.2, 1.12], [99.4, 1.42], [100.6, 1.18], [102.5, 0.94], [104.5, 0.74], [107, 0.86], [110, 0.72], [113, 0.9],
    [116.5, 0.82], [119.5, 0.98], [122, 0.9], [124.9, 1.16], [126.8, 0.98], [129.5, 0.74], [132.5, 0.6], [136.5, 0.45], [140.5, 0.36], [145, 0.24], [149, 0.15], [151.6, 0.07], [153, -0.05],
  ]);
  const front = profile([
    [95.5, 0.78], [100, 0.86], [102.4, 0.77], [104, 0.48], [106, 0.6], [110, 0.7], [113, 0.56], [117, 0.68], [121, 0.62], [125.2, 0.58], [128, 0.42],
    [133, 0.38], [138, 0.28], [143, 0.19], [148, 0.1], [153, -0.05],
  ]);
  const detail = (az: number, s: number, amp: number) => (fbm(az * 1.6, 0.5, s, 5) - 0.5) * amp;
  // Spurs and saddles, then the tree crowns on the skyline (about 0.04° at 10 km).
  const crowns = (az: number, s: number) => (vnoise(az * 40, 0.5, s) - 0.5) * 0.035;
  const backAt = (az: number) => back(az) + (detail(az, 3, 0.14) + crowns(az, 61)) * Math.min(1, back(az) / 0.4);
  const frontAt = (az: number) => front(az) + (detail(az, 7, 0.12) + crowns(az, 63)) * Math.min(1, front(az) / 0.3);
  const towns: [number, number][] = [
    [100.6, 103.6],
    [107.5, 116],
    [118, 123.5],
    [132.5, 140],
    [146, 150],
  ];
  const BACK: RGB = [84, 100, 112];
  const FRONT: RGB = [62, 82, 84];
  const TOWN: RGB = [196, 200, 202];
  return {
    row: 0,
    path: [
      [95.5, 8.6],
      [153, 22.0],
    ],
    ridge: (az) => Math.max(backAt(az), frontAt(az)),
    paint(az, e, _top, x, y, ew) {
      const f = frontAt(az);
      const inFront = e <= f;
      const top = inFront ? f : backAt(az);
      // Gullies and spurs across the slope, canopy speckle, darker lower slopes.
      const gully = fbm(az * 6 + e * 6, e * 12, inFront ? 11 : 13, 4);
      const speck = vnoise(x * 0.9, y * 0.9, 5);
      const depth = Math.max(0, Math.min(1, (top - e) / Math.max(0.15, top)));
      let col = inFront ? FRONT : BACK;
      // Lit spurs and shaded valleys running down the slopes (the sun is behind the viewer).
      const spur = fbm(az * 2.2 + e * 3.0, e * 5.0 - az * 0.6, inFront ? 15 : 17, 4);
      col = scale(col, 0.72 + 0.45 * spur + 0.18 * gully + 0.08 * (speck - 0.5) - 0.1 * depth);
      // The shore: towns and the sea wall glint along the waterline.
      if (e < ew + 0.07) {
        // Towns in clusters of buildings, not a continuous wall.
        const town = towns.some(([a0, a1]) => az > a0 && az < a1) && fbm(az * 5, 0.5, 8, 3) > 0.48;
        if (town && hash(Math.floor(x / 2), y, 9) > 0.55) col = mix(col, TOWN, 0.45 + 0.4 * hash(x, y, 4));
        else if (e < ew + 0.05 && fbm(az * 9, 0.5, 12, 3) > 0.62) col = mix(col, [176, 168, 150], 0.6);
        else if (e < ew + 0.02) col = mix(col, [150, 150, 140], 0.35);
      }
      return col;
    },
  };
})();

/** The Shichirigahama hills east of the crossing, running out to the wooded cape of Inamuragasaki and its cliff. */
const INAMURA: Card = (() => {
  const hills = profile([
    [60, 4.6], [66, 4.0], [72, 3.35], [80, 2.7], [88, 2.0], [93, 1.55], [97, 1.22], [101, 0.98], [103.5, 0.92], [105, 0.9], [106.4, 0.84],
    [107.1, 0.62], [107.8, 0.36], [108.4, 0.12], [109, -0.1],
  ]);
  // Spurs, then tree crowns and roofs on the skyline (8–10 m crowns: 0.2–0.5° at 1–2.5 km).
  const ridge = (az: number) =>
    hills(az) +
    ((fbm(az * 6, 0.5, 21, 5) - 0.5) * 0.3 + (vnoise(az * 9, 0.5, 23) - 0.5) * 0.22 + (vnoise(az * 30, 0.5, 25) - 0.5) * 0.1) * Math.min(1, hills(az) / 0.6);
  const LIT: RGB = [64, 86, 50];
  const DARK: RGB = [30, 44, 30];
  const ROCK: RGB = [150, 140, 122];
  const HOUSE: RGB[] = [
    [214, 210, 200],
    [196, 186, 168],
    [182, 186, 190],
  ];
  return {
    row: 1,
    // One straight card from the hills above the crossing to the cape (1.4 km out at 97°):
    // the ridgeline is painted at its true angles, so only the haze differs.
    path: [
      [60, 0.7],
      [109, 2.62],
    ],
    ridge,
    paint(az, e, top, x, y, ew) {
      const canopy = fbm(x * 0.12, y * 0.12, 31, 4);
      const crowns = vnoise(x * 0.7, y * 0.7, 33);
      let col = mix(DARK, LIT, Math.min(1, Math.max(0, canopy * 1.3 - 0.15 + 0.25 * (crowns - 0.5))));
      // Houses in clusters on the lower and middle slopes (Kamakura-yama, Shichirigahama):
      // 4 × 3 texel blocks, a dark roof row over a lit wall.
      // Height up the slope from the waterline (0) to the skyline (1).
      const rel = (e - ew) / Math.max(0.1, top - ew);
      const bx = Math.floor(x / 4);
      const by = Math.floor(y / 3);
      const cluster = fbm(bx * 0.09, by * 0.2, 37, 3);
      if (az < 104.5 && cluster > 0.56 && rel < 0.8 && hash(bx, by, 41) > 0.5) {
        const k = hash(bx, by, 43);
        col = y % 3 === 0 ? [72, 70, 74] : HOUSE[Math.floor(k * 3) % 3];
      }
      // Inamuragasaki: the bare cliff on its seaward face and the rocks at its foot.
      if (az > 106.6) {
        // Trees cover the cape down to its lower third; below, weathered grey-brown rock.
        const cliff = sstep(107.1, 107.8, az) * (1 - sstep(0.12, 0.26, rel + 0.12 * (fbm(x * 0.2, 0.5, 47, 3) - 0.5)));
        // Bedded mudstone: pale with darker streaks down the face.
        const streak = 0.75 + 0.3 * fbm(x * 0.9, y * 0.08, 45, 3);
        col = mix(col, scale(ROCK, streak), cliff * 0.9);
      }
      // The beach, rocks and sea wall at the waterline.
      if (e < ew + 0.06) col = az > 106.6 ? scale(ROCK, 0.6) : mix(col, [150, 142, 128], 0.6);
      // Haze already deepens with distance at 2–2.5 km.
      const far = sstep(1.0, 2.6, (az - 60) / 20);
      return mix(col, [150, 168, 182], 0.18 * far);
    },
  };
})();

/** Enoshima from the east: the yacht harbour, the wooded hill and its shrines; the Sea Candle is modelled. */
const ENOSHIMA: Card = (() => {
  const isle = profile([
    [240.6, -0.1], [241, 0.04], [242.4, 0.06], [243.2, 0.14], [244.8, 0.18], [245.6, 0.46], [246.6, 0.86], [247.6, 1.08], [248.5, 1.24], [250, 1.2],
    [251.5, 1.12], [252.8, 0.92], [254, 0.52], [255, 0.22], [256, 0.06], [256.8, -0.1],
  ]);
  // Trees on the hill; on the flat east end, the harbour's buildings, cranes and masts.
  const ridge = (az: number) =>
    isle(az) + (fbm(az * 9, 0.5, 51, 4) - 0.5) * 0.1 * Math.min(1, isle(az) / 0.5) + (az < 245.4 ? (vnoise(az * 60, 0.5, 53) - 0.45) * 0.09 : 0);
  return {
    row: 2,
    // Its east face is in shadow; nearly upright normals light it like the sunlit
    // island seen through the bright haze toward the sun.
    lift: 1.0,
    path: [
      [240.6, 2.32],
      [256.8, 2.02],
    ],
    ridge,
    paint(az, e, top, x, y, ew) {
      const canopy = fbm(x * 0.15, y * 0.15, 55, 4);
      let col: RGB = mix([30, 44, 32], [62, 80, 54], canopy);
      // Harbour buildings, masts and the breakwater on the flat east end.
      if (az < 245.2) {
        const b = hash(Math.floor(x / 3), Math.floor(y / 2), 57);
        col = b > 0.62 ? [196, 196, 190] : b > 0.3 ? [138, 142, 140] : mix(col, [120, 124, 126], 0.5);
      }
      // Shrine roofs and inns among the trees on the lower slopes.
      else if (e < top * 0.6 && hash(Math.floor(x / 3), Math.floor(y / 2), 59) > 0.93) col = [120, 104, 92];
      if (e < ew + 0.05) col = mix(col, [130, 126, 118], 0.7);
      // Seen against the afternoon sun: the haze in front glows (FogExp2 has no sun term).
      return mix(col, [150, 160, 166], 0.2);
    },
  };
})();

export function buildFar(w: KamakuraWorld): void {
  const lib = w.lib;
  const forest = lib.farLand("forest");
  const town = lib.farLand("town");
  const land: BufferGeometry[] = [];
  const towns: BufferGeometry[] = [];

  // ---- the painted cards: one material, one texture.
  const cards = [MIURA, INAMURA, ENOSHIMA];
  const tex = toTexture(paintCards(cards));
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.name = "far-coast";
  const mat = lib.cutout("far-coast", tex, { rough: 0.95 });
  w.mesh(merge(cards.map(cardGeometry)), mat, 0, 0, 0, w.root, { cast: false, receive: false });

  // The ridge behind Kamakura High School and the hills along the coast both ways (behind the modelled slope).
  land.push(curtain([at(300, 0.9, 3.8), at(335, 0.65, 5.4), at(10, 0.6, 5.7), at(45, 0.9, 3.9), at(60, 0.75, 4.6)], -5, 0.6));
  // Koshigoe and the hills toward Enoshima; the Shonan shore beyond, low and grey.
  land.push(curtain([at(258, 1.1, 1.0), at(262, 0.9, 2.2), at(280, 1.0, 3.2), at(300, 0.9, 3.8)], -5, 0.6));
  towns.push(curtain([at(256.8, 2.0, 0.06), at(262, 7, 0.1), at(276, 18, 0.06)], -20, 0.3));
  // The Sea Candle (lighthouse and observation tower, top 119.6 m T.P.) on Enoshima's summit.
  {
    const t = at(248.7, 2.07, 0);
    const base = 60 + SEA_Y;
    const shaft = new CylinderGeometry(3.2, 4.6, 46, 10, 1, true);
    shaft.translate(t.x, base + 23, t.z);
    const deck = new CylinderGeometry(9, 6.5, 6, 12);
    deck.translate(t.x, base + 49, t.z);
    const lantern = new CylinderGeometry(2.6, 2.8, 7, 8);
    lantern.translate(t.x, base + 55.5, t.z);
    const cap = new SphereGeometry(2.8, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.translate(t.x, base + 59, t.z);
    w.mesh(w.tint(merge([shaft, deck, lantern, cap]), "white"), w.printed, 0, 0, 0, w.root, { cast: false, receive: false });
  }
  w.mesh(merge(land), forest, 0, 0, 0, w.root, { cast: false, receive: false });
  w.mesh(merge(towns), town, 0, 0, 0, w.root, { cast: false, receive: false });
}
