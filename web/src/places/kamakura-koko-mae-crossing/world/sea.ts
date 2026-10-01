import { BufferGeometry, Color, Float32BufferAttribute, Group, PlaneGeometry, RepeatWrapping, ShapeUtils, SRGBColorSpace, Vector2, Vector3, type Texture } from "three";
import { Rng } from "../../../core/random";
import type { Baker } from "../../shared/bake";
import type { Ctx } from "../../shared/canvas";
import { merge } from "../../shared/shapes";
import { bakeWaveNormals, createWater, foamMaterial, type Water } from "../../shared/water";
import type { KamakuraWorld } from "./context";
import { COAST, LOOP, SEA_Y } from "./layout";
import { DAYLIGHT } from "./sky";

/**
 * Sagami Bay: one water surface from under the beach to past the horizon
 * (15.8 km from the canonical eye), the surf of Shichirigahama, and sailboats
 * off the beach. The coast in the haze is `far.ts`.
 *
 * Shichirigahama's waterline lies about 60 m south of the track (s = 60 on
 * `COAST`); the sandy bottom shoals out to about 500 m, the water turning
 * from turquoise over the sand to the bay's teal-blue. Surf breaks on the bar
 * 40–135 m out (s ≈ 100–195) and again at the beach face.
 */

/** Linear colour ÷ the hemisphere sky's irradiance (colour × intensity). */
const perSky = (r: number, g: number, b: number) => {
  const { hemiSky: s, hemiIntensity: k } = DAYLIGHT;
  return new Color(r / (s.r * k), g / (s.g * k), b / (s.b * k));
};

/** The bay's water in late July: swell from the south-south-west, an onshore wind chop. */
export const WATER = {
  name: "sea",
  waves: [
    // Swell and wind sea on a 57 m tile; chop on an 8.9 m tile (ratio 0.155,
    // not a simple fraction) drifting across it, so neither repeat lines up.
    { repeatsPerMetre: 1 / 57.3, scroll: [0.35, 1.15] as [number, number] },
    { repeatsPerMetre: 1 / 8.9, scroll: [-0.75, 0.55] as [number, number] },
  ] as [{ repeatsPerMetre: number; scroll: [number, number] }, { repeatsPerMetre: number; scroll: [number, number] }],
  slope: 0.26,
  roughness: 0.07,
  distanceRoughness: 0.000012,
  // Wave faces turned to the viewer (about 8°): the far sea reflects the bluer
  // sky 15–20° up and stays darker than the horizon haze above it.
  mask: 0.14,
  // The body colours multiply the hemisphere sky (DAYLIGHT, colour ×
  // intensity), so they are the scattered colours divided by it.
  /** Teal-blue of the open bay. */
  body: perSky(0.00194, 0.1084, 0.2207),
  /** Turquoise over the sand of the shelf off the beach. */
  shallow: perSky(0.0097, 0.187, 0.2472),
  envMapIntensity: 0.72,
};

/** Offsets south of the track and the shallow-water weight there. */
const SHELF: [number, number][] = [
  [44, 1],
  [120, 0.92],
  [220, 0.62],
  [360, 0.25],
  [520, 0],
];
/** Coast stations the shelf follows (u, m east of the crossing along `COAST`). */
const SHORE_U = [-700, -420, -150, 420, 1120, 1500, 1900];
/** The shelf fades out at both ends (Koshigoe, the rocks under Inamuragasaki). */
const shoreFade = (u: number) => Math.max(0, Math.min(1, (u + 700) / 280, (1900 - u) / 400));

export function buildSea(w: KamakuraWorld, baker: Baker): Water {
  const waves = bakeWaveNormals(baker, { seed: 23, heading: -Math.PI / 2 - 0.3, spread: 2.6, falloff: 1.3, strength: 0.3, size: 512 });
  const water = createWater(WATER, waves);
  w.update((_dt, t) => water.update(t));

  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const emit = (q: Vector3, weight: number) => {
    pos.push(q.x, SEA_Y, q.z);
    col.push(weight, weight, weight);
    uv.push(q.x / 34, q.z / 34);
  };
  // ---- the shelf: rows of the shore band, with the shallow weight falling offshore.
  const rows = SHELF.map(([s, wt]) => SHORE_U.map((u) => ({ p: COAST.offset(u, s, new Vector3()), wt: wt * shoreFade(u) })));
  for (let r = 0; r < rows.length - 1; r++)
    for (let i = 0; i < SHORE_U.length - 1; i++) {
      const a = rows[r][i];
      const b = rows[r][i + 1];
      const c = rows[r + 1][i];
      const d = rows[r + 1][i + 1];
      // Counter-clockwise from above: the shore row runs east, offshore is +z.
      for (const v of [a, c, b, b, c, d]) emit(v.p, v.wt);
    }

  // ---- the open bay: a few large triangles from the shelf's outer row to 25 km out.
  const outer = rows[rows.length - 1];
  const ring: [number, number][] = [
    // West: Koshigoe, Katase and the bridge to Enoshima (the island stands in the water),
    // then the Shonan shore to Chigasaki (bearings 257–276°).
    [-2100, 330],
    [-1300, 360],
    [rows[0][0].p.x, rows[0][0].p.z],
    ...outer.map((o) => [o.p.x, o.p.z] as [number, number]),
    [rows[0][SHORE_U.length - 1].p.x, rows[0][SHORE_U.length - 1].p.z],
    [2350, 640],
    [2700, 960],
    [9000, 3600],
    [21000, 9000],
    [12000, 22000],
    [0, 25000],
    [-12000, 22000],
    [-21000, 9000],
    [-22000, -2300],
    [-17900, -1700],
    [-6900, 1050],
    [-2600, 520],
  ];
  // The ring runs west → along the shelf's outer edge → east → round the bay; the
  // shelf's two end columns (from the shore row out) close it at both ends.
  const pts2 = ring.map(([x, z]) => new Vector2(x, z));
  const tris = ShapeUtils.triangulateShape(pts2, []);
  for (const t of tris) {
    const [a, b, c] = t.map((i) => pts2[i]);
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const order = cross < 0 ? [t[0], t[1], t[2]] : [t[0], t[2], t[1]];
    for (const i of order) emit(new Vector3(pts2[i].x, 0, pts2[i].y), 0);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute("color", new Float32BufferAttribute(col, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  // Static, out of the web's batch (which keeps position, normal and UV only)
  // so the shallow-water weight in its vertex colours survives; the cooker
  // keeps open water in one draw however far it reaches.
  const sea = w.mesh(g, water.material, 0, 0, 0, w.root, { cast: false, receive: false });
  sea.name = "sea";
  sea.userData.noBatch = true;
  sea.frustumCulled = false;

  surf(w, baker);
  sailboats(w);
  return water;
}

/**
 * Whitewater of a breaking wave, tiling in u (along the shore) and v
 * (offshore, one wave per repeat): a bright crest line at v = 0.2 with a
 * spilling face ahead of it (toward −v, the shore) and a trail of lace foam
 * decaying behind it; the crest breaks in sections along the shore.
 * RGB is foam white, A its cover.
 */
function foamTexture(baker: Baker): Texture {
  const tex = baker.bake(
    512,
    256,
    /* glsl */ `
      vec2 p = vUv;
      // Sections of the crest: where the wave breaks and where it still runs green.
      float sect = smoothstep(0.4, 0.66, fbm(vec2(p.x * 9.0, 0.5), vec2(9.0, 0.0), 5));
      float wob = (fbm(vec2(p.x * 13.0, 3.0), vec2(13.0, 0.0), 4) - 0.5) * 0.1;
      float y = p.y - 0.2 - wob;
      y -= floor(y + 0.5);
      // Crest: a sharp edge toward the shore, a bright 3 % band, then the trail.
      float crest = smoothstep(-0.03, 0.0, y) * (1.0 - smoothstep(0.02, 0.05, y));
      float trail = y > 0.0 ? exp(-y / 0.16) : 0.0;
      vec3 w1 = worley(p * vec2(64.0, 32.0), vec2(64.0, 32.0));
      vec3 w2 = worley(p * vec2(160.0, 80.0) + 0.37, vec2(160.0, 80.0));
      // Lace: foam cells with dark holes that open up as the trail decays.
      float cells = smoothstep(0.05, 0.3, w1.y - w1.x) * 0.65 + smoothstep(0.03, 0.18, w2.y - w2.x) * 0.35;
      float n = fbm(p * vec2(40.0, 20.0), vec2(40.0, 20.0), 5);
      float lace = smoothstep(0.55 - 0.45 * trail, 0.95 - 0.3 * trail, cells * 0.6 + n * 0.6);
      float a = max(crest * (0.75 + 0.25 * n), trail * lace) * sect;
      a = max(a, trail * 0.18 * n * sect);
      outColor = vec4(vec3(0.92 + 0.08 * n), clamp(a, 0.0, 1.0));`,
    { srgb: true, tiles: 4 },
  );
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  tex.name = "surf-foam";
  return tex;
}

/**
 * Three surf strips along the beach: the outer bar, the inner bar and the
 * shore break with its swash. The foam scrolls shoreward (one wave every
 * 9 s) and each strip's vertex alpha fades it in where the wave starts to
 * break and out where the whitewater dies; the strips also surge a metre or
 * two up and down the beach with the sets. Each strip is one moving mesh
 * (one draw on the handheld); all three share one foam texture.
 */
function surf(w: KamakuraWorld, baker: Baker): void {
  // One material for all strips: every wave takes 9 s, so the scroll is shared.
  const foam = foamMaterial(foamTexture(baker), [0, 1 / 9], "surf-foam");
  w.update((_dt, t) => foam.update(t));
  const strips = [
    { name: "surf-outer", s: [150, 158, 178, 196], alpha: [0, 0.7, 0.4, 0], tile: 46, along: 233, u0: 0.0, y: 0.05 },
    { name: "surf-inshore", s: [98, 104, 124, 146], alpha: [0, 0.85, 0.5, 0], tile: 40, along: 191, u0: 0.31, y: 0.04 },
    { name: "surf-inshore", s: [55.5, 58, 64, 72], alpha: [0, 1, 0.75, 0], tile: 16, along: 97, u0: 0.62, y: 0.03 },
  ];
  // The outer bar surges less than the inner bar and the shore break.
  const surge: Record<string, number> = { "surf-outer": 1.2, "surf-inshore": 2.0 };
  const groups = new Map<string, BufferGeometry[]>();
  for (const st of strips) {
    // v runs offshore: 1 texture repeat (one wave) per `tile` metres, moving `tile` per period.
    const us: number[] = [];
    for (let u = -700; u < 1750; u += Math.abs(u) < 300 ? 25 : 60) us.push(u);
    us.push(1750);
    const pos: number[] = [];
    const col: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const p = new Vector3();
    const n = st.s.length;
    for (let i = 0; i < us.length; i++) {
      for (let j = 0; j < n; j++) {
        COAST.offset(us[i], st.s[j], p);
        pos.push(p.x, SEA_Y + st.y, p.z);
        // Fade the strip toward its ends (Koshigoe and the Inamuragasaki rocks).
        const end = Math.max(0, Math.min(1, (us[i] + 700) / 200, (1750 - us[i]) / 450));
        col.push(1, 1, 1, st.alpha[j] * end);
        uv.push(st.u0 + us[i] / st.along, (st.s[j] - st.s[0]) / st.tile);
      }
    }
    for (let i = 0; i < us.length - 1; i++)
      for (let j = 0; j < n - 1; j++) {
        const a = i * n + j;
        idx.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
      }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new Float32BufferAttribute(col, 4));
    g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    if (!groups.has(st.name)) groups.set(st.name, []);
    groups.get(st.name)!.push(g);
  }
  // One moving mesh per group (one draw each on the handheld).
  const dir = COAST.offset(0, 1, new Vector3()).sub(COAST.point(0, new Vector3())).normalize();
  const sets = Math.round(LOOP / 9);
  for (const [name, geos] of groups) {
    const holder = new Group();
    holder.name = name;
    holder.userData.dynamic = true;
    w.root.add(holder);
    const m = w.mesh(geos.length > 1 ? mergeKeepColor(geos) : geos[0], foam.material, 0, 0, 0, holder, { cast: false, receive: false });
    m.renderOrder = 1;
    // The surge: toward the shore and back, a whole number of sets per loop.
    w.update((_dt, t) => {
      const k = Math.sin((2 * Math.PI * sets * (t % LOOP)) / LOOP);
      holder.position.copy(dir).multiplyScalar(-k * surge[name]);
    });
  }
}

/** Merges indexed strips keeping their RGBA vertex colours. */
function mergeKeepColor(geos: BufferGeometry[]): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (const g of geos) {
    const base = pos.length / 3;
    pos.push(...(g.getAttribute("position").array as Float32Array));
    col.push(...(g.getAttribute("color").array as Float32Array));
    uv.push(...(g.getAttribute("uv").array as Float32Array));
    nrm.push(...(g.getAttribute("normal").array as Float32Array));
    for (const i of Array.from(g.index!.array)) idx.push(base + i);
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new Float32BufferAttribute(nrm, 3));
  out.setAttribute("color", new Float32BufferAttribute(col, 4));
  out.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

/** A sloop seen side-on: mainsail and jib on a mast, the hull's waterline below. */
function yacht(g: Ctx, cw: number, ch: number): void {
  g.clearRect(0, 0, cw, ch);
  const base = ch * 0.86;
  g.fillStyle = "#f3f3ee";
  g.beginPath();
  g.moveTo(cw * 0.5, ch * 0.02);
  g.lineTo(cw * 0.52, base - ch * 0.04);
  g.lineTo(cw * 0.9, base - ch * 0.06);
  g.closePath();
  g.fill();
  g.fillStyle = "#e4e6e4";
  g.beginPath();
  g.moveTo(cw * 0.47, ch * 0.08);
  g.lineTo(cw * 0.47, base - ch * 0.05);
  g.lineTo(cw * 0.12, base - ch * 0.05);
  g.closePath();
  g.fill();
  g.fillStyle = "#f6f6f2";
  g.beginPath();
  g.moveTo(cw * 0.04, base - ch * 0.04);
  g.lineTo(cw * 0.98, base - ch * 0.04);
  g.lineTo(cw * 0.86, base + ch * 0.06);
  g.lineTo(cw * 0.12, base + ch * 0.06);
  g.closePath();
  g.fill();
  g.fillStyle = "#2c3236";
  g.fillRect(cw * 0.12, base + ch * 0.06, cw * 0.74, ch * 0.03);
}

/** Sailboats off Shichirigahama and out toward the horizon, bobbing (one moving mesh). */
function sailboats(w: KamakuraWorld): void {
  const cell = w.draw("yacht", 128, 192, yacht);
  const r = new Rng(21);
  const geos: BufferGeometry[] = [];
  // x, z, count, spread: a regatta 1.5–3 km out (bearings 170–200° from the canonical eye),
  // scattered boats further out and toward Enoshima's harbour (p03).
  const spots: [number, number, number, number][] = [
    [-260, 1600, 5, 160],
    [380, 2400, 4, 180],
    [-750, 3200, 3, 220],
    [900, 4300, 3, 300],
    [-1500, 1900, 3, 200],
    [150, 6200, 3, 500],
    [-2100, 5200, 2, 400],
  ];
  for (const [cx, cz, count, spread] of spots) {
    for (let i = 0; i < count; i++) {
      const x = cx + r.range(-spread, spread);
      const z = cz + r.range(-spread * 0.6, spread * 0.6);
      const h = r.range(7, 11);
      const yaw = r.range(0, Math.PI * 2);
      // Two crossed cards so the sail reads from every shot.
      for (const a of [0, Math.PI / 2]) {
        const q = new PlaneGeometry(h * 0.7, h);
        const uvA = q.getAttribute("uv");
        for (let k = 0; k < uvA.count; k++) uvA.setXY(k, cell.u0 + uvA.getX(k) * (cell.u1 - cell.u0), cell.v0 + uvA.getY(k) * (cell.v1 - cell.v0));
        q.translate(0, h * 0.5 - h * 0.12, 0);
        q.rotateY(yaw + a);
        q.translate(x, SEA_Y, z);
        geos.push(q);
      }
    }
  }
  const holder = new Group();
  holder.name = "sailboats";
  holder.userData.dynamic = true;
  w.root.add(holder);
  w.mesh(merge(geos), w.cut, 0, 0, 0, holder, { cast: false, receive: false });
  w.update((_dt, t) => {
    holder.position.y = 0.12 * Math.sin((2 * Math.PI * 20 * (t % LOOP)) / LOOP);
  });
}
