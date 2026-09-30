import {
  Color,
  DoubleSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Vector2,
  type Texture,
} from "three";
import type { Quality } from "../../../core/quality";
import type { Baker, SurfaceMaps } from "../../shared/bake";
import { makeRainGlass } from "./glass";
import { makeInteriorWindows } from "./interior";
import * as SURF from "./surfaces";
import { makeDamp, makeWet, type WetShared } from "./wet";

type Tint = [number, number, number];

// Baked maps are render-target textures, which cannot be cloned; each surface
// therefore has exactly one physical tile size, set on the shared textures.
function withMaps(maps: SurfaceMaps, params: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.ormMap,
    metalnessMap: maps.ormMap,
    aoMap: maps.ormMap,
    aoMapIntensity: 0.8,
    roughness: 1,
    metalness: 1,
    ...params,
  });
}

/**
 * Every shared material in the Tokyo scene. Surfaces are baked once on the
 * GPU and tinted per use; wet/damp/glass patches hook the rain uniforms.
 */
export class MaterialLib {
  readonly wet: WetShared;
  private baker: Baker;
  private size: number;
  private maps = new Map<string, SurfaceMaps>();
  private cache = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();

  constructor(baker: Baker, wet: WetShared, quality: Quality) {
    this.baker = baker;
    this.wet = wet;
    this.size = quality.textureSize;
  }

  private surf(key: string, glsl: string, size: number, tileMeters: number, bump: number, uniforms?: Record<string, { value: unknown }>): SurfaceMaps {
    let m = this.maps.get(key);
    if (!m) {
      m = this.baker.surface(Math.min(size, this.size), glsl, { bump, uniforms });
      for (const t of [m.map, m.normalMap, m.ormMap]) t.repeat.set(1 / tileMeters, 1 / tileMeters);
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

  /** Pre-bake the heavy surfaces so progress reporting is meaningful. */
  bakeAll(): void {
    this.road();
    this.pavers();
    this.wallTile("beige");
    this.concrete();
    this.floor();
    this.brushed();
  }

  // --------------------------------------------------------------- ground

  road(): MeshStandardMaterial {
    return this.memo("road", () => {
      const m = withMaps(this.surf("asphalt", SURF.ASPHALT, 2048, 4, 2), { normalScale: new Vector2(0.32, 0.32) });
      m.userData.worldUV = true;
      return makeWet(m, this.wet, { puddles: 0.62, darken: 0.7, roughness: 0.52, planar: true, ripple: 0.6 });
    });
  }

  roadPaint(): MeshStandardMaterial {
    return this.memo("roadPaint", () => {
      // Thermoplastic paint follows the asphalt relief underneath.
      const asphalt = this.surf("asphalt", SURF.ASPHALT, 2048, 4, 3);
      const m = new MeshStandardMaterial({
        color: 0xa6a6a0,
        normalMap: asphalt.normalMap,
        normalScale: new Vector2(0.7, 0.7),
        roughness: 0.62,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      m.userData.worldUV = true;
      return makeWet(m, this.wet, { puddles: 0.35, darken: 0.8, roughness: 0.55, planar: true });
    });
  }

  roadStencil(alpha: Texture): MeshStandardMaterial {
    return this.memo(`stencil-${alpha.uuid}`, () => {
      const m = new MeshStandardMaterial({
        color: 0xe8e8e2,
        alphaMap: alpha,
        transparent: true,
        depthWrite: false,
        roughness: 0.55,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      return makeWet(m, this.wet, { puddles: 0.4, darken: 0.8, roughness: 0.5, planar: true });
    });
  }

  pavers(): MeshStandardMaterial {
    return this.memo("pavers", () => {
      const m = withMaps(this.surf("pavers", SURF.PAVERS, 1024, 1.2, 2));
      m.userData.worldUV = true;
      return makeWet(m, this.wet, { puddles: 0.35, darken: 0.6, roughness: 0.45, planar: true, puddleScale: 9 });
    });
  }

  tactile(): MeshStandardMaterial {
    return this.memo("tactile", () => {
      const m = withMaps(this.surf("tactile", SURF.TACTILE, 512, 0.4, 4));
      m.userData.worldUV = true;
      return makeWet(m, this.wet, { puddles: 0.2, darken: 0.75, roughness: 0.6, planar: true });
    });
  }

  curb(): MeshStandardMaterial {
    return this.memo("curb", () => {
      const m = withMaps(this.surf("concrete", SURF.CONCRETE, 1024, 3, 1.5, { uTint: { value: [0.62, 0.61, 0.58] } }), { color: 0xb8b4ac });
      m.userData.worldUV = true;
      return makeWet(m, this.wet, { puddles: 0.2, darken: 0.55, roughness: 0.5, planar: true });
    });
  }

  // ------------------------------------------------------------- building

  wallTile(kind: "beige" | "brown" | "gray" | "white" | "green"): MeshStandardMaterial {
    const tints: Record<string, [number, number, number]> = {
      beige: [0.78, 0.68, 0.55],
      brown: [0.48, 0.33, 0.24],
      gray: [0.52, 0.52, 0.5],
      white: [0.86, 0.85, 0.82],
      green: [0.36, 0.45, 0.4],
    };
    return this.memo(`tile-${kind}`, () => {
      const maps = this.surf("walltile", SURF.WALL_TILE, 1024, 1, 1.5, {
        uTileA: { value: [0.95, 0.95, 0.95] },
        uTileB: { value: [0.78, 0.78, 0.78] },
      });
      const m = withMaps(maps, { color: new Color(...tints[kind]).multiplyScalar(0.72), envMapIntensity: 0.4 });
      m.userData.worldUV = true;
      return makeDamp(m, this.wet, { darken: 0.72, roughness: 0.55, streaks: 1 });
    });
  }

  concrete(tint: Tint = [0.55, 0.55, 0.53]): MeshStandardMaterial {
    return this.memo(`concrete-${tint.join(",")}`, () => {
      const m = withMaps(this.surf("concrete", SURF.CONCRETE, 1024, 3, 1.5, { uTint: { value: [0.62, 0.61, 0.58] } }), {
        color: new Color(tint[0] / 0.6, tint[1] / 0.6, tint[2] / 0.6),
        envMapIntensity: 0.55,
      });
      m.userData.worldUV = true;
      return makeDamp(m, this.wet, { darken: 0.7, roughness: 0.6, streaks: 1 });
    });
  }

  floor(): MeshStandardMaterial {
    return this.memo("floor", () => {
      const m = withMaps(this.surf("floor", SURF.FLOOR_TILE, 1024, 1.2, 1), { aoMapIntensity: 0.4 });
      m.userData.worldUV = true;
      // Indoors: no rain, but it is on the mirror plane so it gets the planar reflection.
      const w = makeWet(m, this.wet, { puddles: 0, darken: 1, roughness: 1, planar: true, ripple: 0 });
      w.fog = false;
      return w;
    });
  }

  ceiling(): MeshStandardMaterial {
    return this.memo("ceiling", () => {
      const m = withMaps(this.surf("ceiling", SURF.CEILING, 512, 0.6, 1));
      m.userData.worldUV = true;
      m.fog = false;
      return m;
    });
  }

  brushed(tint: Tint = [0.78, 0.8, 0.82]): MeshStandardMaterial {
    return this.memo(`brushed-${tint.join(",")}`, () => {
      const m = withMaps(this.surf("brushed", SURF.BRUSHED, 512, 1, 0.5, { uTint: { value: [1, 1, 1] } }), { color: new Color(...tint) });
      return m;
    });
  }

  shutter(tint: Tint = [0.62, 0.64, 0.66]): MeshStandardMaterial {
    return this.memo(`shutter-${tint.join(",")}`, () => {
      const m = withMaps(this.surf("shutter", SURF.SHUTTER, 1024, 1, 3, { uTint: { value: [1, 1, 1] } }), { color: new Color(...tint) });
      return makeDamp(m, this.wet, { darken: 0.8, roughness: 0.6, streaks: 0.6 });
    });
  }

  wood(tint: Tint = [0.32, 0.2, 0.12]): MeshStandardMaterial {
    return this.memo(`wood-${tint.join(",")}`, () => {
      const m = withMaps(this.surf("wood", SURF.WOOD, 1024, 2, 2, { uTint: { value: [1, 1, 1] } }), { color: new Color(...tint) });
      return makeDamp(m, this.wet, { darken: 0.75, roughness: 0.7, streaks: 0.5 });
    });
  }

  /** Painted steel in any color; `damp` for outdoor pieces. */
  paint(hex: number, rough = 0.45, damp = true): MeshStandardMaterial {
    return this.memo(`paint-${hex.toString(16)}-${rough}-${damp}`, () => {
      const m = withMaps(this.surf("painted", SURF.PAINTED, 512, 1, 1, { uTint: { value: [1, 1, 1] } }), { color: hex, roughness: rough / 0.45 });
      return damp ? makeDamp(m, this.wet, { darken: 0.85, roughness: 0.45, streaks: 0.3 }) : m;
    });
  }

  /** Plain PBR without maps (small props, interior bits). */
  plain(hex: number, rough = 0.5, metal = 0, fog = true): MeshStandardMaterial {
    return this.memo(`plain-${hex.toString(16)}-${rough}-${metal}-${fog}`, () => new MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal, fog }));
  }

  /**
   * Shop interiors are flooded with even LED light; instead of adding lights
   * that would also leak through walls, interior surfaces carry their lit
   * appearance as emission (the planar reflection and IBL add the gloss).
   */
  interior(hex: number, lit = 0.9, rough = 0.5, map?: Texture, key = ""): MeshStandardMaterial {
    return this.memo(`interior-${hex.toString(16)}-${lit}-${rough}-${map?.uuid ?? ""}-${key}`, () => {
      const m = new MeshStandardMaterial({
        color: hex,
        map: map ?? null,
        emissive: new Color(hex),
        emissiveMap: map ?? null,
        emissiveIntensity: lit,
        roughness: rough,
        metalness: 0,
        fog: false,
      });
      if (map) m.emissive.set(0xffffff);
      m.userData.pocketAtlas = { interior: true };
      return m;
    });
  }

  rubber(): MeshStandardMaterial {
    return this.plain(0x111112, 0.75, 0);
  }

  chrome(): MeshStandardMaterial {
    return this.plain(0xdddddd, 0.12, 1);
  }

  // ---------------------------------------------------------------- glass

  storeGlass(): MeshStandardMaterial {
    return this.memo("storeGlass", () => {
      const m = new MeshPhysicalMaterial({
        color: 0x223036,
        roughness: 0.03,
        metalness: 0,
        opacity: 0.05,
        side: DoubleSide,
        envMapIntensity: 1.2,
        specularIntensity: 1,
      });
      return makeRainGlass(m, this.wet, 1);
    });
  }

  windowGlass(): MeshStandardMaterial {
    return this.memo("windowGlass", () => {
      const m = new MeshPhysicalMaterial({ color: 0x0c1014, roughness: 0.05, metalness: 0, opacity: 0.25, envMapIntensity: 1.1 });
      return makeRainGlass(m, this.wet, 0.22);
    });
  }

  /** Apartment/office glazing with parallax rooms behind it (see interior.ts). */
  interiorWindows(): MeshStandardMaterial {
    return this.memo("interior-windows", () => makeInteriorWindows(this.wet, 1.25));
  }

  /** Clear vinyl (umbrellas, bus-stop panels). */
  vinyl(): MeshStandardMaterial {
    return this.memo("vinyl", () => {
      const m = new MeshPhysicalMaterial({ color: 0xdfe7ea, roughness: 0.18, metalness: 0, opacity: 0.18, side: DoubleSide, envMapIntensity: 1 });
      return makeRainGlass(m, this.wet, 0.8);
    });
  }

  // ------------------------------------------------------------- emissive

  /** Light-emitting surface: HDR color scaled by intensity (bloom picks it up). */
  glow(hex: number | string, intensity: number, fog = true): MeshBasicMaterial {
    return this.memo(`glow-${hex}-${intensity}-${fog}`, () => {
      const c = new Color(hex).multiplyScalar(intensity);
      const m = new MeshBasicMaterial({ color: c, fog, toneMapped: true });
      m.userData.pocketAtlas = { kind: "unlit", color: c.toArray(), fog };
      return m;
    });
  }

  /** Textured emissive panel (signs, vending displays, screens). */
  sign(tex: Texture, intensity: number, opts: { rough?: number; fog?: boolean; key?: string } = {}): MeshStandardMaterial {
    return this.memo(`sign-${opts.key ?? tex.uuid}-${intensity}`, () => {
      const m = new MeshStandardMaterial({
        color: 0x111111,
        map: tex,
        emissive: 0xffffff,
        emissiveMap: tex,
        emissiveIntensity: intensity,
        roughness: opts.rough ?? 0.25,
        metalness: 0,
        fog: opts.fog ?? true,
      });
      m.userData.pocketAtlas = { sign: true };
      return m;
    });
  }

  /** Unlit texture (interior displays behind glass where lighting is baked in). */
  flat(tex: Texture, intensity = 1, key?: string): MeshBasicMaterial {
    return this.memo(`flat-${key ?? tex.uuid}-${intensity}`, () => {
      const m = new MeshBasicMaterial({ map: tex, fog: false });
      m.color.setScalar(intensity);
      m.userData.pocketAtlas = { kind: "unlit", color: [intensity, intensity, intensity], fog: false };
      return m;
    });
  }
}
