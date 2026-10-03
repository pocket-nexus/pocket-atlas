import { Color, DoubleSide, MeshBasicMaterial, MeshStandardMaterial, Vector2, type Texture } from "three";
import type { Quality } from "../../../core/quality";
import type { Baker, SurfaceMaps } from "../bake";
import * as SURF from "./surfaces";
import { glassMaterial } from "../glass";

export type Tint = [number, number, number];

function withMaps(maps: SurfaceMaps, params: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.ormMap,
    metalnessMap: maps.ormMap,
    aoMap: maps.ormMap,
    aoMapIntensity: 0.9,
    roughness: 1,
    metalness: 1,
    ...params,
  });
}

/**
 * Materials for a dry daytime place. Every surface is a MeshStandardMaterial
 * with baked albedo / normal / ORM maps (R = occlusion, G = roughness,
 * B = metalness), tinted per use through `color`; cut-outs use `alphaTest`.
 * Nothing patches the shaders, so the cooker reads them as plain glTF PBR.
 */
export class DayLib {
  private baker: Baker;
  private size: number;
  private maps = new Map<string, SurfaceMaps>();
  private cache = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();

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
    this.surf("granite", SURF.GRANITE, 1024, 2, 1.2);
    this.surf("rubble", SURF.RUBBLE, 1024, 2.4, 3.5);
    this.surf("form", SURF.FORM_CONCRETE, 1024, 3.6, 1.2);
    this.surf("asphalt", SURF.ASPHALT, 1024, 4, 2);
  }

  // ------------------------------------------------------------ stone

  /** Granite tread or riser; `tint` multiplies the grey stone (a few steps are warmer or darker). */
  granite(tint: Tint = [1, 1, 1], rough = 1): MeshStandardMaterial {
    return this.memo(`granite-${tint.join(",")}-${rough}`, () =>
      withMaps(this.surf("granite", SURF.GRANITE, 1024, 2, 1.2), { color: new Color(...tint), roughness: rough, normalScale: new Vector2(0.8, 0.8) }),
    );
  }

  rubble(): MeshStandardMaterial {
    return this.memo("rubble", () => {
      const m = withMaps(this.surf("rubble", SURF.RUBBLE, 1024, 2.4, 3.5), { normalScale: new Vector2(1.3, 1.3), aoMapIntensity: 1 });
      return m;
    });
  }

  cutStone(): MeshStandardMaterial {
    return this.memo("cutstone", () => {
      const m = withMaps(this.surf("cutstone", SURF.CUTSTONE, 512, 1.8, 2));
      m.userData.worldUV = true;
      return m;
    });
  }

  formConcrete(tint: Tint = [1, 1, 1]): MeshStandardMaterial {
    return this.memo(`form-${tint.join(",")}`, () => {
      const m = withMaps(this.surf("form", SURF.FORM_CONCRETE, 1024, 3.6, 1.2), { color: new Color(...tint) });
      m.userData.worldUV = true;
      return m;
    });
  }

  concrete(tint: Tint = [1, 1, 1], worldUV = true): MeshStandardMaterial {
    return this.memo(`concrete-${tint.join(",")}-${worldUV}`, () => {
      const m = withMaps(this.surf("concrete", SURF.CONCRETE, 512, 2, 1.5), { color: new Color(...tint) });
      m.userData.worldUV = worldUV;
      return m;
    });
  }

  block(): MeshStandardMaterial {
    return this.memo("block", () => {
      const m = withMaps(this.surf("block", SURF.BLOCK, 512, 1.6, 1.5));
      m.userData.worldUV = true;
      return m;
    });
  }

  // ---------------------------------------------------------- ground

  asphalt(tileMeters = 4, tint = 0xffffff): MeshStandardMaterial {
    return this.memo(`asphalt-${tileMeters}-${tint}`, () => {
      const m = withMaps(this.surf(tileMeters === 4 ? "asphalt" : `asphalt-${tileMeters}`, SURF.ASPHALT, 1024, tileMeters, 2), { color: tint, normalScale: new Vector2(0.5, 0.5) });
      m.userData.worldUV = true;
      return m;
    });
  }

  /** Road paint follows the asphalt relief. */
  roadPaint(hex = 0xd8d8d0): MeshStandardMaterial {
    return this.memo(`roadpaint-${hex.toString(16)}`, () => {
      const a = this.surf("asphalt", SURF.ASPHALT, 1024, 4, 2);
      const m = new MeshStandardMaterial({
        color: hex,
        normalMap: a.normalMap,
        normalScale: new Vector2(0.9, 0.9),
        roughness: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      m.userData.worldUV = true;
      return m;
    });
  }

  /** Painted text on the road (止まれ): an alpha-tested stencil. */
  roadText(tex: Texture): MeshStandardMaterial {
    return this.memo(`roadtext-${tex.uuid}`, () => {
      const m = new MeshStandardMaterial({
        color: 0xdcdcd4,
        map: tex,
        alphaTest: 0.5,
        roughness: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      return m;
    });
  }

  ground(): MeshStandardMaterial {
    return this.memo("ground", () => {
      const m = withMaps(this.surf("ground", SURF.GROUND, 512, 3, 2.5));
      m.userData.worldUV = true;
      return m;
    });
  }

  // -------------------------------------------------------- buildings

  siding(hex: number): MeshStandardMaterial {
    return this.memo(`siding-${hex.toString(16)}`, () => withMaps(this.surf("siding", SURF.SIDING, 512, 1, 2), { color: new Color(hex).multiplyScalar(0.92) }));
  }

  stucco(hex: number): MeshStandardMaterial {
    return this.memo(`stucco-${hex.toString(16)}`, () => withMaps(this.surf("stucco", SURF.STUCCO, 512, 1, 1.5), { color: new Color(hex).multiplyScalar(0.95) }));
  }

  sheetRoof(hex: number): MeshStandardMaterial {
    return this.memo(`sheet-${hex.toString(16)}`, () => withMaps(this.surf("sheet", SURF.SHEET_ROOF, 512, 1, 1.5), { color: new Color(hex).multiplyScalar(1.3) }));
  }

  tileRoof(hex: number): MeshStandardMaterial {
    return this.memo(`tile-${hex.toString(16)}`, () =>
      withMaps(this.surf("tile", SURF.TILE_ROOF, 512, 1.2, 3), { color: new Color(hex).multiplyScalar(1.2), normalScale: new Vector2(1.2, 1.2) }),
    );
  }

  bark(tint = 0xffffff): MeshStandardMaterial {
    return this.memo(`bark-${tint}`, () => withMaps(this.surf("bark", SURF.BARK, 512, 1, 3), { color: tint, normalScale: new Vector2(1.4, 1.4) }));
  }

  /** Painted steel in any colour (rails, poles, frames). */
  paint(hex: number, rough = 0.45): MeshStandardMaterial {
    return this.memo(`paint-${hex.toString(16)}-${rough}`, () =>
      withMaps(this.surf("paint", SURF.PAINT, 512, 1, 1), { color: hex, roughness: rough / 0.5, normalScale: new Vector2(0.6, 0.6) }),
    );
  }

  /** Brushed stainless sheets with restrained relief at close viewing distances. */
  stainless(): MeshStandardMaterial {
    return this.memo("stainless", () => withMaps(this.surf("stainless", SURF.STAINLESS, 1024, 1, 0.05), {
      normalScale: new Vector2(0.07, 0.07), envMapIntensity: 0.85,
    }));
  }

  /** Thin railway glazing: real openings and interior geometry behind the reflection. */
  clearGlass(): MeshStandardMaterial {
    return this.memo("clear-glass", () => glassMaterial({
      color: 0x708f91, roughness: 0.13, metalness: 0.18,
      transparent: true, opacity: 0.24, depthWrite: false, side: DoubleSide,
      envMapIntensity: 0.85,
    }));
  }

  /** Plain PBR without maps (small props, far field). */
  plain(hex: number, rough = 0.6, metal = 0): MeshStandardMaterial {
    return this.memo(`plain-${hex.toString(16)}-${rough}-${metal}`, () => new MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal }));
  }

  /** Window glass seen from outside in daylight: dark, glossy, reflecting the sky probe. */
  glass(kind: "dark" | "curtain" | "frosted" = "dark"): MeshStandardMaterial {
    const spec = { dark: [0x0e1318, 0.04, 1.5], curtain: [0x5d605f, 0.12, 1.2], frosted: [0x8e979c, 0.2, 1.1] } as const;
    const [hex, rough, env] = spec[kind];
    return this.memo(`glass-${kind}`, () => {
      const m = new MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0, envMapIntensity: env });
      m.userData.pocketAtlas = { window: kind };
      return m;
    });
  }

  /** Alpha-tested card (leaves, wire mesh, balcony bars). */
  cutout(key: string, tex: Texture, opts: { color?: number; rough?: number; metal?: number; normal?: Texture } = {}): MeshStandardMaterial {
    return this.memo(`cutout-${key}`, () => {
      const m = new MeshStandardMaterial({
        map: tex,
        normalMap: opts.normal ?? null,
        color: opts.color ?? 0xffffff,
        alphaTest: 0.5,
        // Web only (MSAA): smooths the cut edges; the pack keeps the plain alpha test.
        alphaToCoverage: true,
        side: DoubleSide,
        roughness: opts.rough ?? 0.6,
        metalness: opts.metal ?? 0,
      });
      return m;
    });
  }

  /** A textured surface drawn from a canvas (signs, plates); `glow` > 0 adds the map as emission (backlit displays). */
  printed(key: string, tex: Texture, rough = 0.55, glow = 0): MeshStandardMaterial {
    return this.memo(`printed-${key}`, () => {
      const m = new MeshStandardMaterial({ map: tex, roughness: rough, metalness: 0 });
      if (glow > 0) {
        m.emissive.set(0xffffff);
        m.emissiveMap = tex;
        m.emissiveIntensity = glow;
      }
      return m;
    });
  }

  /** Light-emitting surface (unlit, HDR colour). */
  glow(hex: number, intensity: number): MeshBasicMaterial {
    return this.memo(`glow-${hex.toString(16)}-${intensity}`, () => {
      const c = new Color(hex).multiplyScalar(intensity);
      const m = new MeshBasicMaterial({ color: c });
      m.userData.pocketAtlas = { kind: "unlit", color: c.toArray(), fog: true };
      return m;
    });
  }
}
