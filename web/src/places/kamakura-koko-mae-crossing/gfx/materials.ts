import { Color, DoubleSide, MeshBasicMaterial, MeshStandardMaterial, Vector2, type Texture } from "three";
import type { Quality } from "../../../core/quality";
import type { Baker, SurfaceMaps } from "../../shared/bake";
import * as SURF from "./surfaces";

export type Tint = [number, number, number];

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
 * Plain paints of the place. The handheld pays for every distinct material
 * in every 32 m chunk it appears in, so props share this fixed set instead
 * of asking for colours one by one.
 */
export const PAINT = {
  white: [0xe9e8e2, 0.55, 0],
  black: [0x141516, 0.55, 0],
  brown: [0x4a3a2e, 0.7, 0],
  galv: [0x9aa0a3, 0.42, 0.75],
  steel: [0x6a6f72, 0.5, 0.6],
  orange: [0xe0601a, 0.45, 0],
  yellow: [0xe8b812, 0.5, 0],
  beige: [0xc9bc9f, 0.6, 0],
  rail: [0x6a4a36, 0.45, 0.5],
  cable: [0x101112, 0.6, 0],
  wood: [0x5e4632, 0.8, 0],
  aluminium: [0xc4c7c8, 0.35, 0.8],
  roofGrey: [0x3e4246, 0.6, 0.1],
  roofRed: [0x7a3a28, 0.65, 0],
  green: [0x2d6a3c, 0.6, 0],
} as const;
export type PaintName = keyof typeof PAINT;

/**
 * Materials for the seaside crossing on a summer afternoon. Every lit
 * surface is a MeshStandardMaterial (baked albedo / normal / ORM maps where
 * the surface needs texture; R = occlusion, G = roughness, B = metalness);
 * nothing patches the shaders except the sea (`shared/water.ts`).
 */
export class CoastLib {
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

  /** Materials made so far (the export report counts them). */
  get count(): number {
    return this.cache.size;
  }

  /** Bakes the large surfaces up front so load progress is meaningful. */
  bakeAll(): void {
    this.surf("asphalt", SURF.ASPHALT, 1024, 4, 2);
    this.surf("concrete", SURF.CONCRETE, 512, 2, 1.5);
    this.surf("rubble", SURF.RUBBLE, 1024, 2.4, 3.2);
    this.surf("sand", SURF.SAND, 512, 6, 1.2);
  }

  // ---------------------------------------------------------- ground

  asphalt(): MeshStandardMaterial {
    return this.memo("asphalt", () => {
      const m = withMaps(this.surf("asphalt", SURF.ASPHALT, 1024, 4, 2), { normalScale: new Vector2(0.5, 0.5) });
      m.userData.worldUV = true;
      return m;
    });
  }

  /** Road markings (white lines, the zebra, the orange centre line) follow the asphalt relief. */
  roadPaint(kind: "white" | "orange"): MeshStandardMaterial {
    return this.memo(`roadpaint-${kind}`, () => {
      const a = this.surf("asphalt", SURF.ASPHALT, 1024, 4, 2);
      const m = new MeshStandardMaterial({
        color: kind === "white" ? 0xd9d8d0 : 0xd2721c,
        normalMap: a.normalMap,
        normalScale: new Vector2(0.8, 0.8),
        roughness: 0.72,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      m.userData.worldUV = true;
      return m;
    });
  }

  concrete(): MeshStandardMaterial {
    return this.memo("concrete", () => {
      const m = withMaps(this.surf("concrete", SURF.CONCRETE, 512, 2, 1.5), { color: new Color(0.88, 0.87, 0.85) });
      m.userData.worldUV = true;
      return m;
    });
  }

  /** Light concrete paving (sidewalks, the platform, the sea-wall top). */
  paving(): MeshStandardMaterial {
    return this.memo("paving", () => {
      const m = withMaps(this.surf("concrete", SURF.CONCRETE, 512, 2, 1.5), { normalScale: new Vector2(0.6, 0.6) });
      m.userData.worldUV = true;
      return m;
    });
  }

  rubble(): MeshStandardMaterial {
    return this.memo("rubble", () => {
      const m = withMaps(this.surf("rubble", SURF.RUBBLE, 1024, 2.4, 3.2), { normalScale: new Vector2(1.3, 1.3), aoMapIntensity: 1 });
      m.userData.worldUV = true;
      return m;
    });
  }

  stoneClad(): MeshStandardMaterial {
    return this.memo("stoneclad", () => {
      const m = withMaps(this.surf("stoneclad", SURF.STONE_CLAD, 512, 1.8, 2.2));
      m.userData.worldUV = true;
      return m;
    });
  }

  block(): MeshStandardMaterial {
    return this.memo("block", () => {
      const m = withMaps(this.surf("block", SURF.BLOCK, 512, 1.131, 1.5));
      m.userData.worldUV = true;
      return m;
    });
  }

  ballast(): MeshStandardMaterial {
    return this.memo("ballast", () => {
      const m = withMaps(this.surf("ballast", SURF.BALLAST, 512, 2, 3.5), { normalScale: new Vector2(1.4, 1.4) });
      m.userData.worldUV = true;
      return m;
    });
  }

  sand(): MeshStandardMaterial {
    return this.memo("sand", () => {
      const m = withMaps(this.surf("sand", SURF.SAND, 512, 6, 1.2), { normalScale: new Vector2(0.6, 0.6) });
      m.userData.worldUV = true;
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

  /** Hedges and shrub masses (solid geometry; leaf cards sit on top). */
  shrub(): MeshStandardMaterial {
    return this.memo("shrub", () => {
      const m = withMaps(this.surf("shrub", SURF.SHRUB, 512, 2, 3), { normalScale: new Vector2(1.5, 1.5) });
      m.userData.worldUV = true;
      return m;
    });
  }

  // -------------------------------------------------------- buildings

  /** Villa stucco, white or cream. */
  stucco(kind: "white" | "cream"): MeshStandardMaterial {
    return this.memo(`stucco-${kind}`, () => {
      const m = withMaps(this.surf("stucco", SURF.STUCCO, 512, 1, 1.5), { color: kind === "white" ? new Color(1, 1, 0.99) : new Color(1, 0.93, 0.8) });
      m.userData.worldUV = true;
      return m;
    });
  }

  /** Painted facades of the hillside houses: one atlas of window bays (see gfx/art.ts). */
  facade(tex: Texture): MeshStandardMaterial {
    return this.memo("facade", () => new MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0, vertexColors: true }));
  }

  /** Window glass seen from outside in daylight: dark, glossy, reflecting the sky probe. */
  glass(): MeshStandardMaterial {
    return this.memo("glass", () => new MeshStandardMaterial({ color: 0x10161b, roughness: 0.05, metalness: 0, envMapIntensity: 1.4 }));
  }

  /** Clear glass balustrades and wind screens: thin, blended, a little green at the edges. */
  glassRail(): MeshStandardMaterial {
    return this.memo("glass-rail", () => {
      const m = new MeshStandardMaterial({ color: 0x9fb8b2, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.32, depthWrite: false, envMapIntensity: 1.2, side: DoubleSide });
      return m;
    });
  }

  /** Curve-mirror face: polished stainless steel. */
  mirror(): MeshStandardMaterial {
    return this.memo("mirror", () => new MeshStandardMaterial({ color: 0xd8dcdf, roughness: 0.04, metalness: 1, envMapIntensity: 1.3 }));
  }

  /** A plain paint from the fixed set. */
  paint(name: PaintName): MeshStandardMaterial {
    const [hex, rough, metal] = PAINT[name];
    return this.memo(`paint-${name}`, () => new MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal }));
  }

  /** Plain PBR in any colour: only the people's clothing (one white base per roughness class, vertex-coloured). */
  plain(hex: number, rough = 0.6, metal = 0): MeshStandardMaterial {
    return this.memo(`plain-${hex.toString(16)}-${rough}-${metal}`, () => new MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal }));
  }

  /** A textured surface drawn from a canvas atlas (signs, stripes, boards, the crossing deck). */
  printed(key: string, tex: Texture, rough = 0.55): MeshStandardMaterial {
    return this.memo(`printed-${key}`, () => new MeshStandardMaterial({ map: tex, roughness: rough, metalness: 0 }));
  }

  /** Alpha-tested cut-out (leaves, crossbucks, wire fences). */
  cutout(key: string, tex: Texture, opts: { rough?: number; color?: number } = {}): MeshStandardMaterial {
    return this.memo(`cutout-${key}`, () =>
      new MeshStandardMaterial({
        map: tex,
        color: opts.color ?? 0xffffff,
        alphaTest: 0.5,
        // Web only (MSAA): smooths the cut edges; the pack keeps the plain alpha test.
        alphaToCoverage: true,
        side: DoubleSide,
        roughness: opts.rough ?? 0.6,
        metalness: 0,
      }),
    );
  }

  /**
   * A crossing lamp lens: dark red glass whose emission the crossing
   * sequence drives (exported as a material track).
   */
  lamp(key: string, hex: number, peak: number): MeshStandardMaterial {
    return this.memo(`lamp-${key}`, () => {
      const m = new MeshStandardMaterial({ color: 0x2a0806, roughness: 0.2, metalness: 0, emissive: hex, emissiveIntensity: peak });
      m.userData.peak = peak;
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

  /** Distant land: hazy hills and headlands, lit by the sun and the sky. */
  farLand(kind: "forest" | "town"): MeshStandardMaterial {
    return this.memo(`far-${kind}`, () => new MeshStandardMaterial({ color: kind === "forest" ? 0x2e3d26 : 0x7a7a70, roughness: 0.95, metalness: 0 }));
  }
}
