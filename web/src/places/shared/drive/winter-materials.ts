import { Color, DoubleSide, MeshStandardMaterial, Vector2, type Material, type Texture } from "three";
import { Atlas, type AtlasRect } from "../atlas";
import type { Baker, SurfaceMaps } from "../bake";
import { PbrAtlas, type CellDef } from "../pbr-atlas";
import { Rng } from "../../../core/random";

/** Shared, exportable PBR palette for snowy rural roads; no runtime shader patches. */
export interface WinterMaterials {
  snow: MeshStandardMaterial;
  road: MeshStandardMaterial;
  shoulder: MeshStandardMaterial;
  roof: MeshStandardMaterial;
  equipment: PbrAtlas<EquipmentCell>;
  windows: MeshStandardMaterial;
  vegetation: MeshStandardMaterial;
  leaves: { spruce: AtlasRect; spruceSnow: AtlasRect; snowVariants: AtlasRect[]; bare: AtlasRect };
  signs: MeshStandardMaterial;
  signCells: Record<"route" | "ice" | "biei" | "furano" | "service" | "delivery" | "finish", AtlasRect>;
  /** Call after every chunk is gone; the stage separately owns and disposes Baker. */
  dispose(): void;
}
export type EquipmentCell = "white" | "red" | "steel" | "dark" | "birch" | "wood" | "cream" | "blue" | "ochre" | "window";

const SNOW = /* glsl */ `
Surface surface(vec2 uv) {
  float swell = fbm(uv * 4.0, vec2(4.0), 4);
  float fine = fbm(uv * 115.0, vec2(115.0), 3);
  float ripple = pow(0.5 + 0.5 * sin((uv.y * 31.0 + 0.9 * gnoise(uv * 4.0, vec2(4.0))) * 6.283185), 5.0);
  float grain = hash12(floor(uv * 512.0));
  vec3 c = mix(vec3(0.60, 0.665, 0.70), vec3(0.88, 0.90, 0.905), swell);
  c *= 0.94 + 0.06 * fine + 0.012 * grain + ripple * 0.035;
  return S(c, swell * 0.35 + fine * 0.15 + ripple * 0.045, 0.84 + fine * 0.12, 0.96 + fine * 0.04, 0.0);
}`;

// A seven-metre road across U; V repeats every 22 metres. Four wheel paths,
// coarse grit and compressed ice remain readable in the baked albedo on Vita.
const WINTER_ROAD = /* glsl */ `
float rut(float x, float at, float w) { return 1.0 - smoothstep(w * 0.45, w, abs(x - at)); }
Surface surface(vec2 uv) {
  float x = uv.x * 7.0 - 3.5;
  float coarse = fbm(uv * vec2(14.0, 30.0), vec2(14.0, 30.0), 4);
  float granular = fbm(uv * vec2(120.0, 240.0), vec2(120.0, 240.0), 3);
  float drift = 0.16 * gnoise(vec2(uv.y * 4.0, 0.2), vec2(4.0));
  float rutWidth = 0.36 + 0.18 * fbm(uv * vec2(2.0, 9.0), vec2(2.0, 9.0), 3);
  float tracks = max(max(rut(x + drift, -2.42, rutWidth), rut(x + drift, -1.10, rutWidth)), max(rut(x - drift, 1.10, rutWidth), rut(x - drift, 2.42, rutWidth)));
  float lane = max(rut(x, -1.76, 1.25), rut(x, 1.76, 1.25));
  float edge = smoothstep(2.6, 3.5, abs(x));
  vec3 snow = mix(vec3(0.48, 0.53, 0.56), vec3(0.73, 0.76, 0.77), coarse);
  vec3 slush = mix(vec3(0.22, 0.245, 0.25), vec3(0.42, 0.445, 0.44), granular);
  float broken = smoothstep(0.24, 0.64, fbm(uv * vec2(7.0, 7.0), vec2(7.0), 3));
  float scrape = tracks * (0.17 + broken * 0.61);
  vec3 c = mix(snow * (1.0 - lane * 0.12), slush, scrape);
  float grit = step(0.92, hash12(floor(uv * vec2(380.0, 650.0)))) * smoothstep(0.52, 0.74, granular);
  c *= 1.0 - grit * (0.10 + lane * 0.15);
  c = mix(c, vec3(0.78, 0.815, 0.83) * (0.93 + granular * 0.08), edge);
  float furrow = abs(sin((uv.x * 160.0 + coarse * 0.3) * 6.283185));
  float h = coarse * 0.22 + granular * 0.10 - tracks * 0.12 + edge * 0.18 + furrow * tracks * 0.012;
  float ice = tracks * smoothstep(0.58, 0.76, coarse);
  return S(c, h, mix(mix(0.91, 0.55 + granular * 0.17, tracks), 0.28, ice), 0.93 + granular * 0.07, 0.0);
}`;

const COMPACTED_SNOW = /* glsl */ `
Surface surface(vec2 uv) {
  float n = fbm(uv * vec2(18.0, 3.0), vec2(18.0, 3.0), 4);
  float fine = fbm(uv * 100.0, vec2(100.0), 3);
  float scrape = pow(0.5 + 0.5 * sin(uv.x * 56.0 * 6.283185 + n * 2.0), 4.0);
  vec3 c = mix(vec3(0.48, 0.52, 0.54), vec3(0.70, 0.74, 0.76), n);
  return S(c * (0.97 + fine * 0.05), n * 0.15 + fine * 0.1 + scrape * 0.04, 0.73 + fine * 0.14, 0.98, 0.0);
}`;

const ROOF = /* glsl */ `
Surface surface(vec2 uv) {
  float rib = pow(0.5 + 0.5 * cos(uv.x * 8.0 * 6.283185), 12.0);
  float n = fbm(uv * 10.0, vec2(10.0), 4);
  float streak = fbm(uv * vec2(26.0, 2.0), vec2(26.0, 2.0), 3);
  vec3 c = mix(vec3(0.075, 0.105, 0.125), vec3(0.17, 0.195, 0.21), n);
  c *= 0.78 + streak * 0.3 + rib * 0.18;
  return S(c, rib * 0.42 + n * 0.06, 0.61 + streak * 0.13, 0.87 + rib * 0.13, 0.35);
}`;

function pbr(baker: Baker, name: string, size: number, body: string, metres: number, bump: number): MeshStandardMaterial {
  const maps: SurfaceMaps = baker.surface(size, body, { bump });
  for (const [kind, t] of Object.entries(maps)) {
    t.name = `${name}-${kind}`;
    t.repeat.set(1 / metres, 1 / metres);
  }
  const m = new MeshStandardMaterial({ map: maps.map, normalMap: maps.normalMap, roughnessMap: maps.ormMap, metalnessMap: maps.ormMap, aoMap: maps.ormMap, roughness: 1, metalness: 1, normalScale: new Vector2(0.8, 0.8) });
  m.name = name;
  return m;
}

function equipment(): PbrAtlas<EquipmentCell> {
  const flat = (c: string, r: number, metal = 0): CellDef => ({ w: 128, h: 128, bump: 0.35, paint: (p) => {
    p.base(c, r, metal);
    p.speckle(700, ["rgba(255,255,255,.055)", "rgba(0,0,0,.05)"], [0.25, 1.5]);
  } });
  const siding = (c: string): CellDef => ({ w: 256, h: 256, bump: 0.8, paint: (p) => {
    p.base(c, 0.82, 0.05);
    for (let y = 0; y < p.ht; y += p.ht / 18) {
      p.a.fillStyle = "rgba(25,35,39,.3)"; p.a.fillRect(0, y, p.w, 1.5);
      p.h.fillStyle = "#444"; p.h.fillRect(0, y, p.w, 1.5);
      p.a.fillStyle = "rgba(255,255,255,.13)"; p.a.fillRect(0, y + 2, p.w, 1);
    }
    p.speckle(700, ["rgba(255,255,255,.05)", "rgba(0,0,0,.045)"], [0.2, 1.1]);
    p.streaks(18, "rgba(44,39,28,.13)", [12, 65], [0.5, 2]);
  } });
  return new PbrAtlas(1024, {
    white: flat("#dce0d9", 0.7), red: flat("#a7352f", 0.64), steel: flat("#899296", 0.43, 0.65), dark: flat("#303a3c", 0.83),
    cream: siding("#d0c6aa"), blue: siding("#647f86"), ochre: siding("#a28b6c"),
    birch: { w: 128, h: 512, bump: 1.1, paint: (p) => {
      p.base("#c9ccc4", 0.92);
      for (let i = 0; i < 85; i++) {
        const x = p.r.next() * p.w, y = p.r.next() * p.ht, w = p.r.range(3, 30), h = p.r.range(1, 5);
        p.a.fillStyle = i % 4 === 0 ? "#3e4140" : "#899087"; p.a.fillRect(x, y, w, h);
        p.h.fillStyle = "#555"; p.h.fillRect(x, y, w, h);
      }
    } },
    wood: { w: 128, h: 256, bump: 0.8, paint: (p) => {
      p.base("#64554b", 0.94);
      p.streaks(180, "rgba(15,20,16,.5)", [12, 140], [0.4, 1.5]);
    } },
    window: { w: 256, h: 256, bump: 0.2, paint: (p) => {
      p.base("#cca66d", 0.28);
      const grad = p.a.createLinearGradient(0, 0, 0, p.ht); grad.addColorStop(0, "#6e6553"); grad.addColorStop(0.5, "#d2bd85"); grad.addColorStop(1, "#b79a68");
      p.a.fillStyle = grad; p.a.fillRect(0, 0, p.w, p.ht);
      p.a.fillStyle = "rgba(238,230,197,.22)"; p.a.fillRect(p.w * 0.07, 0, p.w * 0.18, p.ht);
      p.a.fillStyle = "#67645c"; p.a.fillRect(0, p.ht * 0.68, p.w, 4);
    } },
  }, { name: "winter-road-equipment", seed: 23761 });
}

function vegetation(): { atlas: Atlas; cells: WinterMaterials["leaves"] } {
  const atlas = new Atlas(2048, { transparent: true, pad: 16 });
  atlas.texture.name = "winter-spruce-and-birch-cards";
  const conifer = (seed: number, snowy: boolean) => atlas.draw(960, 1920, (g, w, h) => {
    const r = new Rng(seed);
    g.lineCap = "round";
    g.strokeStyle = "#454a43"; g.lineWidth = w * 0.035;
    g.beginPath(); g.moveTo(w * 0.5, h * 0.98); g.lineTo(w * 0.5, h * 0.07); g.stroke();
    // Many broken boughs form a silhouette. Transparent space between boughs
    // and needles survives alpha testing, unlike a solid cone of foliage.
    for (let layer = 1; layer <= 23; layer++) {
      const y = h * (0.06 + layer * 0.036 + r.range(-0.009, 0.009)), span = w * (0.028 + layer * 0.019) * r.range(0.76, 1.04);
      for (const side of [-1, 1]) {
        const tipX = w * 0.5 + side * span, tipY = y + h * r.range(0.018, 0.063);
        g.strokeStyle = "#394d46"; g.lineWidth = Math.max(1, h * 0.010);
        g.beginPath(); g.moveTo(w * 0.5, y); g.lineTo(tipX, tipY); g.stroke();
        for (let n = 0; n < 24; n++) {
          const t = n / 24, x = w * 0.5 + side * span * t, by = y + (tipY - y) * t;
          const length = h * r.range(0.027, 0.053) * (1 - t * 0.38);
          g.strokeStyle = n % 3 === 0 ? "#40584d" : "#283c35";
          g.lineWidth = Math.max(0.8, w * r.range(0.008, 0.018));
          g.beginPath(); g.moveTo(x, by); g.lineTo(x + side * w * 0.033, by + length); g.stroke();
        }
        if (snowy && r.chance(0.84)) {
          g.strokeStyle = r.chance(0.5) ? "#d4dcda" : "#b6c4c1"; g.lineWidth = h * r.range(0.012, 0.025);
          g.beginPath(); g.moveTo(w * 0.5 + side * span * 0.12, y - h * 0.003); g.quadraticCurveTo(w * 0.5 + side * span * 0.52, y - h * r.range(0.004, 0.019), tipX - side * span * 0.11, tipY - h * 0.009); g.stroke();
          for (let n = 0; n < 11; n++) {
            const t = r.range(0.12, 0.9), cx = w * 0.5 + side * span * t, cy = y + (tipY - y) * t - h * r.range(0.007, 0.018);
            g.fillStyle = r.chance(0.6) ? "#d4dcda" : "#bdc9c7";
            g.beginPath(); g.ellipse(cx, cy, w * r.range(0.022, 0.058), h * r.range(0.006, 0.018), side * 0.18, 0, Math.PI * 2); g.fill();
          }
        }
      }
    }
  });
  const spruce = conifer(637, false), spruceSnow = conifer(721, true);
  const snowVariants = [spruceSnow, conifer(1081, true), conifer(809, true)];
  const bare = atlas.draw(1536, 1536, (g, w, h) => {
    const r = new Rng(743);
    g.lineCap = "round";
    const branch = (x: number, y: number, a: number, length: number, width: number, depth: number): void => {
      const nx = x + Math.cos(a) * length, ny = y + Math.sin(a) * length;
      g.strokeStyle = depth > 3 ? "#b5b9ad" : "#737c76"; g.lineWidth = width;
      g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
      if (depth === 0) return;
      branch(nx, ny, a + r.range(-0.16, 0.16), length * r.range(0.65, 0.83), Math.max(0.8, width * 0.61), depth - 1);
      branch(x + (nx - x) * 0.62, y + (ny - y) * 0.62, a + r.pick([-1, 1]) * r.range(0.3, 0.78), length * 0.65, Math.max(0.65, width * 0.47), depth - 1);
    };
    branch(w * 0.5, h * 0.96, -Math.PI / 2, h * 0.28, w * 0.035, 7);
    branch(w * 0.52, h * 0.65, -2.05, h * 0.2, w * 0.012, 6);
    branch(w * 0.49, h * 0.6, -1.03, h * 0.21, w * 0.014, 6);
  });
  return { atlas, cells: { spruce, spruceSnow, snowVariants, bare } };
}

export function createWinterMaterials(baker: Baker): WinterMaterials {
  const snow = pbr(baker, "winter-fresh-snow", 512, SNOW, 7, 0.8);
  snow.userData.worldUV = true;
  const road = pbr(baker, "winter-compacted-road", 1024, WINTER_ROAD, 1, 1.5);
  road.userData.pocketAtlas = { dynamicLights: true };
  const shoulder = pbr(baker, "winter-ploughed-shoulder", 512, COMPACTED_SNOW, 7, 1.2);
  shoulder.userData.worldUV = true;
  shoulder.userData.pocketAtlas = { dynamicLights: true };
  const roof = pbr(baker, "winter-standing-seam-roof", 512, ROOF, 2, 0.75);
  const eq = equipment();
  const windows = new MeshStandardMaterial({ map: eq.albedo, emissiveMap: eq.albedo, emissive: new Color("#ffe1a4"), emissiveIntensity: 0.32, roughness: 0.34 });
  windows.name = "winter-warm-windows";
  const plants = vegetation();
  const foliage = new MeshStandardMaterial({ map: plants.atlas.texture, alphaTest: 0.45, side: DoubleSide, roughness: 0.97, metalness: 0 });
  foliage.name = "winter-alpha-tested-foliage";
  foliage.alphaToCoverage = true;
  const signsAtlas = new Atlas(1024, { pad: 8 });
  signsAtlas.texture.name = "winter-road-signs";
  const sign = (japanese: string, english: string, bg = "#184877", arrow = false): AtlasRect => signsAtlas.draw(1536, 768, (g, w, h) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#d7e2df"; g.lineWidth = h * 0.022; g.strokeRect(w * 0.025, h * 0.055, w * 0.95, h * 0.89);
    g.fillStyle = "#eef0e5"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `600 ${Math.round(h * 0.35)}px sans-serif`; g.fillText(japanese, w * (arrow ? 0.59 : 0.5), h * 0.36, w * (arrow ? 0.72 : 0.91));
    g.font = `500 ${Math.round(h * 0.14)}px sans-serif`; g.fillText(english, w * (arrow ? 0.59 : 0.5), h * 0.75, w * 0.88);
    if (arrow) {
      g.beginPath(); g.moveTo(w * 0.13, h * 0.19); g.lineTo(w * 0.065, h * 0.42); g.lineTo(w * 0.106, h * 0.42); g.lineTo(w * 0.106, h * 0.78); g.lineTo(w * 0.154, h * 0.78); g.lineTo(w * 0.154, h * 0.42); g.lineTo(w * 0.195, h * 0.42); g.closePath(); g.fill();
    }
  });
  const route = signsAtlas.draw(512, 768, (g, w, h) => {
    g.fillStyle = "#d8ddda"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#145589"; g.beginPath(); g.moveTo(w * 0.15, h * 0.14); g.lineTo(w * 0.85, h * 0.14); g.quadraticCurveTo(w, h * 0.27, w * 0.8, h * 0.57); g.lineTo(w * 0.5, h * 0.9); g.lineTo(w * 0.2, h * 0.57); g.quadraticCurveTo(0, h * 0.27, w * 0.15, h * 0.14); g.fill();
    g.fillStyle = "#f4f2e8"; g.textAlign = "center"; g.font = `700 ${h * 0.3}px sans-serif`; g.fillText("237", w * 0.5, h * 0.53);
    g.font = `${h * 0.085}px sans-serif`; g.fillText("国道", w * 0.5, h * 0.29);
  });
  const signCells = { route, ice: sign("凍結注意", "ICY ROAD", "#97732c"), biei: sign("美 瑛", "Biei", "#184877", true), furano: sign("富良野", "Furano", "#184877", true), service: sign("冬の休憩所", "WARM STOP  /  P", "#4c665d"), delivery: sign("冬の配達便", "WINTER DELIVERY", "#5a635c"), finish: sign("美瑛駅", "BIEI STATION", "#184877") };
  const signs = new MeshStandardMaterial({ map: signsAtlas.texture, roughness: 0.55, metalness: 0.15 });
  signs.name = "winter-reflective-road-signs";
  const materials: Material[] = [snow, road, shoulder, roof, eq.material, windows, foliage, signs];
  return {
    snow, road, shoulder, roof, equipment: eq, windows, vegetation: foliage, leaves: plants.cells, signs, signCells,
    dispose() {
      // Baker owns its render targets. These canvas atlases are ours.
      const textures = new Set<Texture>();
      for (const m of [eq.material, windows, foliage, signs]) for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap, m.emissiveMap]) if (t) textures.add(t);
      for (const t of textures) t.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
