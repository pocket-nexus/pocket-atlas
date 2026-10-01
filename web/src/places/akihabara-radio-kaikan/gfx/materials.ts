import { Color, DoubleSide, MeshBasicMaterial, MeshStandardMaterial, Vector2, type Texture } from "three";
import type { Quality } from "../../../core/quality";
import type { Baker, SurfaceMaps } from "../../shared/bake";
import { makeInteriorWindows } from "../../tokyo-konbini/gfx/interior";
import type { WetShared } from "../../tokyo-konbini/gfx/wet";
import * as SURF from "./surfaces";

export type Tint = [number, number, number];

/*
 * The handheld pays per distinct material (draw calls per 32 m chunk), so
 * colours snap to small palettes: every requested paint, light or tint is
 * served by the nearest entry.
 */
const PAINTS = [0xffffff, 0x111214, 0x2a2c2e, 0x3e4144, 0x5e6268, 0x8a8e92, 0xbfc3c6, 0xe2e2dc, 0xd2a812, 0x2a4a7a, 0xc8141e, 0x1e3a1a, 0x2e8b57, 0x7d8c86];
const ROUGH = [0.3, 0.55, 0.8];
const LIGHTS = [0xffd9a0, 0xfff0dc, 0xf2f4ff, 0xffd6ec, 0x2ee86a, 0xff2a1a, 0x8a8580, 0x4a3020, 0xc9c4b8];
const LEVELS = [0.5, 1.5, 4.5, 14];
const PANELS: Tint[] = [[1.0, 1.0, 0.98], [0.85, 0.85, 0.83], [0.62, 0.66, 0.72], [0.84, 0.76, 0.64], [0.22, 0.22, 0.24], [0.25, 0.36, 0.62]];
const TILES: Tint[] = [[0.82, 0.8, 0.76], [0.64, 0.62, 0.6], [0.35, 0.34, 0.36]];
/** Light metal reads as brushed steel; every other paint is a matte finish. */
const METALLIC = new Set([0xbfc3c6, 0x8a8e92]);

function nearestHex(hex: number, palette: number[]): number {
  const c = new Color(hex);
  let best = palette[0];
  let bd = Infinity;
  for (const p of palette) {
    const q = new Color(p);
    const d = (c.r - q.r) ** 2 + (c.g - q.g) ** 2 * 1.4 + (c.b - q.b) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
const nearest = (v: number, list: number[]) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
const nearestTint = (t: Tint, list: Tint[]): Tint => list.reduce((a, b) => (dist(b, t) < dist(a, t) ? b : a));
const dist = (a: Tint, b: Tint) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function withMaps(maps: SurfaceMaps, params: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.ormMap,
    metalnessMap: maps.ormMap,
    aoMap: maps.ormMap,
    aoMapIntensity: 0.85,
    roughness: 1,
    metalness: 1,
    ...params,
  });
}

/**
 * Materials for a dry street at blue hour. Lit surfaces are plain
 * MeshStandardMaterials with baked albedo / normal / ORM maps (the cooker
 * bakes the lamps, signs and sky into their vertices); everything that emits
 * light (signs, backlit posters, lamp globes, screens) is unlit HDR colour ×
 * texture. Only the interior-mapped office windows patch a shader (the
 * `interiorWindow` kind the cooker knows).
 */
export class DuskLib {
  private baker: Baker;
  private size: number;
  private maps = new Map<string, SurfaceMaps>();
  private cache = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();
  /** Clock for the interior-window shader (TV flicker in the rooms). */
  readonly clock = { uTime: { value: 0 } };

  constructor(baker: Baker, quality: Quality) {
    this.baker = baker;
    this.size = Math.min(1024, quality.textureSize);
  }

  private surf(key: string, glsl: string, size: number, tileMeters: number, bump: number): SurfaceMaps {
    let m = this.maps.get(key);
    if (!m) {
      m = this.baker.surface(Math.min(size, this.size), glsl, { bump });
      for (const t of [m.map, m.normalMap, m.ormMap]) {
        t.repeat.set(1 / tileMeters, 1 / tileMeters);
        t.name = key;
      }
      this.maps.set(key, m);
    }
    return m;
  }

  private memo<T extends MeshStandardMaterial | MeshBasicMaterial>(key: string, make: () => T): T {
    let m = this.cache.get(key) as T | undefined;
    if (!m) {
      m = make();
      m.name = key;
      this.cache.set(key, m);
    }
    return m;
  }

  /** Bakes the large surfaces up front so load progress is meaningful. */
  bakeAll(): void {
    this.surf("asphalt", SURF.ASPHALT, 1024, 4, 2);
    this.surf("pavers", SURF.PAVERS, 1024, 2.4, 1.6);
    this.surf("panel", SURF.PANEL, 1024, 2.4, 1);
    this.surf("tile", SURF.TILE, 512, 1, 1.2);
    this.surf("concrete", SURF.CONCRETE, 512, 3, 1.5);
    this.surf("granite", SURF.GRANITE, 512, 1.2, 1.2);
    this.surf("aluminium", SURF.ALUMINIUM, 256, 1, 0.4);
  }

  // ------------------------------------------------------------ ground

  asphalt(): MeshStandardMaterial {
    return this.memo("asphalt", () => {
      const m = withMaps(this.surf("asphalt", SURF.ASPHALT, 1024, 4, 2), { normalScale: new Vector2(0.45, 0.45) });
      m.userData.worldUV = true;
      return m;
    });
  }

  pavers(): MeshStandardMaterial {
    return this.memo("pavers", () => {
      const m = withMaps(this.surf("pavers", SURF.PAVERS, 1024, 2.4, 1.6), { normalScale: new Vector2(0.8, 0.8) });
      m.userData.worldUV = true;
      return m;
    });
  }

  granite(_want: Tint = [1, 1, 1]): MeshStandardMaterial {
    const tint: Tint = [0.85, 0.85, 0.83];
    return this.memo(`granite-${tint.join(",")}`, () => {
      const m = withMaps(this.surf("granite", SURF.GRANITE, 512, 1.2, 1.2), { color: new Color(...tint) });
      m.userData.worldUV = true;
      return m;
    });
  }

  /** Road paint (zebra crossings) following the asphalt relief. */
  roadPaint(hex = 0xd6d6cf): MeshStandardMaterial {
    return this.memo(`roadpaint-${hex.toString(16)}`, () => {
      const a = this.surf("asphalt", SURF.ASPHALT, 1024, 4, 2);
      const m = new MeshStandardMaterial({
        color: hex,
        normalMap: a.normalMap,
        normalScale: new Vector2(0.8, 0.8),
        roughness: 0.68,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      m.userData.worldUV = true;
      return m;
    });
  }

  // -------------------------------------------------------- buildings

  /** Composite cladding panels (Radio Kaikan's white walls; tinted for neighbours). */
  panel(want: Tint = [1, 1, 1]): MeshStandardMaterial {
    const tint = nearestTint(want, PANELS);
    return this.memo(`panel-${tint.join(",")}`, () => {
      const m = withMaps(this.surf("panel", SURF.PANEL, 1024, 2.4, 1), { color: new Color(...tint) });
      m.userData.worldUV = true;
      return m;
    });
  }

  tile(want: Tint = [0.82, 0.8, 0.76]): MeshStandardMaterial {
    const tint = nearestTint(want, TILES);
    return this.memo(`tile-${tint.join(",")}`, () => {
      const m = withMaps(this.surf("tile", SURF.TILE, 512, 1, 1.2), { color: new Color(...tint) });
      m.userData.worldUV = true;
      return m;
    });
  }

  concrete(_want: Tint = [1, 1, 1]): MeshStandardMaterial {
    const tint: Tint = [0.72, 0.72, 0.7];
    return this.memo(`concrete-${tint.join(",")}`, () => {
      const m = withMaps(this.surf("concrete", SURF.CONCRETE, 512, 3, 1.5), { color: new Color(...tint) });
      m.userData.worldUV = true;
      return m;
    });
  }

  aluminium(tint: Tint = [1, 1, 1]): MeshStandardMaterial {
    return this.memo(`aluminium-${tint.join(",")}`, () => {
      const m = withMaps(this.surf("aluminium", SURF.ALUMINIUM, 256, 1, 0.4), { color: new Color(...tint), envMapIntensity: 1.1 });
      m.userData.worldUV = true;
      return m;
    });
  }

  /** Plain PBR without maps (small props, painted steel, far field). */
  plain(want: number, wantRough = 0.55, wantMetal = 0, fog = true): MeshStandardMaterial {
    const hex = nearestHex(want, PAINTS);
    // White is the vertex-coloured base of the people (three roughness classes); other paints have one finish each.
    const metallic = METALLIC.has(hex) && wantMetal >= 0.35;
    const rough = hex === 0xffffff ? nearest(wantRough, ROUGH) : metallic ? 0.35 : 0.6;
    const metal = metallic ? 0.6 : 0;
    return this.memo(`plain-${hex.toString(16)}-${rough}-${metal}-${fog}`, () => new MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal, fog }));
  }

  /** Window glass seen from outside at dusk: dark and glossy, reflecting the probe. */
  glass(kind: "dark" | "smoked" | "clear" = "dark"): MeshStandardMaterial {
    const spec = { dark: [0x0b0e12, 0.04, 1.4], smoked: [0x1a1f24, 0.06, 1.2], clear: [0x26303a, 0.03, 1.3] } as const;
    const [hex, rough, env] = spec[kind];
    return this.memo(`glass-${kind}`, () => {
      const m = new MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0, envMapIntensity: env });
      m.userData.pocketAtlas = { window: kind };
      return m;
    });
  }

  /** Transparent glazing in front of lit shop interiors (shopfronts, canopies). */
  shopGlass(): MeshStandardMaterial {
    return this.memo("shop-glass", () => {
      const m = new MeshStandardMaterial({ color: 0x1c242a, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.12, depthWrite: false, side: DoubleSide, envMapIntensity: 1.2 });
      m.userData.pocketAtlas = { kind: "glass" };
      return m;
    });
  }

  /** Curved bay glazing: thin, tinted, low reflection so the lit floor shows through at an angle. */
  bayGlass(): MeshStandardMaterial {
    return this.memo("bay-glass", () => {
      const m = new MeshStandardMaterial({ color: 0x10161c, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.18, depthWrite: false, side: DoubleSide, envMapIntensity: 0.45 });
      m.userData.pocketAtlas = { kind: "glass" };
      return m;
    });
  }

  /** Office and shop floors with parallax rooms behind the glass (the `interiorWindow` kind). */
  interiorWindows(_intensity = 1.2): MeshStandardMaterial {
    return this.memo("interior-windows", () => makeInteriorWindows(this.clock as unknown as WetShared, 1.2));
  }

  // ------------------------------------------------------------ light

  /** Light-emitting surface: unlit HDR colour (bloom picks it up). */
  glow(want: number, wantLevel: number, fog = true): MeshBasicMaterial {
    const hex = nearestHex(want, LIGHTS);
    const intensity = nearest(wantLevel, LEVELS);
    return this.memo(`glow-${hex.toString(16)}-${intensity}-${fog}`, () => {
      const c = new Color(hex).multiplyScalar(intensity);
      const m = new MeshBasicMaterial({ color: c, fog });
      m.userData.pocketAtlas = { kind: "unlit", color: c.toArray(), fog };
      return m;
    });
  }

  /** Unlit texture at an HDR level: backlit posters, lightbox signs, LED letters. */
  lit(tex: Texture, wantLevel: number, key: string, opts: { alphaTest?: number; fog?: boolean; side?: typeof DoubleSide } = {}): MeshBasicMaterial {
    // Interiors and floodlit prints each come at one level.
    const intensity = key === "atlas-interior" ? 1.25 : key === "art-flood" ? 0.85 : wantLevel;
    return this.memo(`lit-${key}-${intensity}`, () => {
      const m = new MeshBasicMaterial({ map: tex, fog: opts.fog ?? true, alphaTest: opts.alphaTest ?? 0 });
      if (opts.side !== undefined) m.side = opts.side;
      m.color.setScalar(intensity);
      m.userData.pocketAtlas = { kind: "unlit", color: [intensity, intensity, intensity], fog: opts.fog ?? true };
      return m;
    });
  }

  /** A printed surface lit by the street (unlit banners, plates, wrapped panels). */
  printed(tex: Texture, key: string, rough = 0.6): MeshStandardMaterial {
    return this.memo(`printed-${key}`, () => new MeshStandardMaterial({ map: tex, roughness: rough, metalness: 0 }));
  }
}
