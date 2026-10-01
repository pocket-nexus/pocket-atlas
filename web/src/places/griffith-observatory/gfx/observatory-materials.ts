import { Color, DoubleSide, MeshBasicMaterial, MeshStandardMaterial, Vector2, type Texture } from "three";
import type { Quality } from "../../../core/quality";
import type { Baker, SurfaceMaps } from "../../shared/bake";
import { makeInteriorWindows } from "../../shared/interior";
import { paintArtAtlas, type ArtMaps } from "./observatory-art";
import { leafAtlas } from "./observatory-foliage";
import * as SURF from "./observatory-surfaces";

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

/** Amber of the lit interiors (p04, p05: #d1ae61 in the blue-hour photographs). */
export const WINDOW_GLOW = 2.9;
/** Room brightness behind the tall windows (traced interiors), set against p04's panes. */
export const INTERIOR_GLOW = 2.4;
/** The halls' warm light over the traced rooms' neutral walls (p02, p04: the panes read amber, not white). */
export const INTERIOR_TINT: [number, number, number] = [1.0, 0.78, 0.36];

/**
 * Materials of the observatory and its grounds. Every lit surface is a
 * MeshStandardMaterial (baked albedo / normal / ORM; R = occlusion, G =
 * roughness, B = metalness). Geometry carries UVs in metres (cylindrical on
 * the drums, along the meridian on the domes), so no material rewrites UVs.
 * The walls, the trim atlas and the ground take vertex colours: a wall's
 * tint and its baked occlusion (reveals, the arcade, the foot of a parapet)
 * ride on the vertices, so the building stays a handful of draws.
 */
export class ObsLib {
  private baker: Baker;
  private size: number;
  private maps = new Map<string, SurfaceMaps>();
  private cache = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();
  private artMaps: ArtMaps | null = null;
  /** Seconds, for the interior windows (advanced by the world's updater). */
  readonly time = { value: 0 };
  private leaves: Texture | null = null;

  constructor(baker: Baker, quality: Quality) {
    this.baker = baker;
    this.size = Math.min(1024, quality.textureSize);
  }

  private surf(key: string, glsl: string, size: number, tileMeters: number | [number, number], bump: number): SurfaceMaps {
    let m = this.maps.get(key);
    if (!m) {
      m = this.baker.surface(Math.min(size, this.size), glsl, { bump });
      const [tu, tv] = typeof tileMeters === "number" ? [tileMeters, tileMeters] : tileMeters;
      for (const t of [m.map, m.normalMap, m.ormMap]) {
        t.repeat.set(1 / tu, 1 / tv);
        t.name = `griffith-${key}`;
      }
      this.maps.set(key, m);
    }
    return m;
  }

  private memo<T extends MeshStandardMaterial | MeshBasicMaterial>(key: string, make: () => T): T {
    let m = this.cache.get(key) as T | undefined;
    if (!m) {
      m = make();
      m.name = `griffith-${key}`;
      this.cache.set(key, m);
    }
    return m;
  }

  /** Bakes the large surfaces up front so load progress is meaningful. */
  bakeAll(): void {
    this.surf("coated", SURF.COATED, 1024, 4, 1.2);
    this.surf("deck", SURF.DECK, 512, 4, 1.4);
    this.surf("walk", SURF.WALK, 512, 3, 1.2);
    this.surf("copper", SURF.COPPER, 512, 1, 1.6);
  }

  // ---------------------------------------------------------- building

  /** Warm-white coated concrete: walls, drums, pilasters, parapets, the monument. */
  wall(): MeshStandardMaterial {
    return this.memo("wall", () => withMaps(this.surf("coated", SURF.COATED, 1024, 4, 1.2), { vertexColors: true, normalScale: new Vector2(0.6, 0.6) }));
  }

  /** Roof decks, terraces and the promenade floor. */
  deck(): MeshStandardMaterial {
    return this.memo("deck", () => withMaps(this.surf("deck", SURF.DECK, 512, 4, 1.4), { vertexColors: true, normalScale: new Vector2(0.7, 0.7) }));
  }

  /**
   * Dome copper: 8 pans × 4 courses per texture tile; the dome builders set
   * UVs so u counts tiles round the dome and v tiles up the meridian.
   */
  copper(): MeshStandardMaterial {
    return this.memo("copper", () => withMaps(this.surf("copper", SURF.COPPER, 512, 1, 1.6), { normalScale: new Vector2(0.9, 0.9), envMapIntensity: 1.0 }));
  }

  /** The rotunda's green copper roof. */
  patina(): MeshStandardMaterial {
    return this.memo("patina", () => withMaps(this.surf("patina", SURF.PATINA, 256, 2, 1.2), { normalScale: new Vector2(0.8, 0.8) }));
  }

  /** Trim atlas: windows, entrance, lettering, Greek key, flutes, panels, the Zeiss slit (gfx/observatory-art.ts). */
  art(): MeshStandardMaterial {
    return this.memo("art", () => {
      const a = (this.artMaps ??= paintArtAtlas(this.size >= 1024 ? 2048 : 1024));
      return new MeshStandardMaterial({
        map: a.map,
        normalMap: a.normalMap,
        normalScale: new Vector2(0.8, 0.8),
        roughnessMap: a.ormMap,
        metalnessMap: a.ormMap,
        aoMap: a.ormMap,
        roughness: 1,
        metalness: 1,
        emissive: new Color(1, 1, 1),
        emissiveMap: a.emissiveMap,
        emissiveIntensity: WINDOW_GLOW,
        vertexColors: true,
      });
    });
  }

  /**
   * Glass of the tall windows with a traced room behind it (`shared/interior.ts`,
   * the `interiorWindow` kind on the handheld); the room seeds pick lit, warm,
   * open rooms (world/observatory/windows.ts).
   */
  interior(): MeshStandardMaterial {
    return this.memo("interior", () => makeInteriorWindows(this.time, INTERIOR_GLOW, INTERIOR_TINT));
  }

  /** Cast bronze: door surrounds, window frames in relief, the armillary sphere, the bust. */
  bronze(): MeshStandardMaterial {
    return this.memo("bronze", () => new MeshStandardMaterial({ color: new Color(0.13, 0.085, 0.05), roughness: 0.42, metalness: 0.85 }));
  }

  /** Painted steel: pipe railings, fences, binocular viewers, lamp heads. */
  steel(): MeshStandardMaterial {
    return this.memo("steel", () => new MeshStandardMaterial({ color: new Color(0.05, 0.052, 0.055), roughness: 0.5, metalness: 0.6 }));
  }

  /** The Gottlieb Transit Corridor's glass wall and other glazing: dark, glossy, the interior a warm haze. */
  glazing(): MeshStandardMaterial {
    return this.memo("glazing", () => new MeshStandardMaterial({ color: new Color(0.02, 0.022, 0.026), roughness: 0.06, metalness: 0.1, emissive: new Color(1.0, 0.72, 0.42), emissiveIntensity: 0.22 }));
  }

  /** Lamp globes and fixture lenses: HDR, unlit. */
  glow(color: Color, intensity: number, key: string): MeshBasicMaterial {
    return this.memo(`glow-${key}`, () => {
      const c = color.clone().multiplyScalar(intensity);
      const m = new MeshBasicMaterial({ color: c });
      m.userData.pocketAtlas = { kind: "unlit", color: c.toArray(), fog: true };
      return m;
    });
  }

  // ---------------------------------------------------------- grounds

  /** Road paint: kerb-side stall lines and the zebra crossing (polygon-offset over the asphalt). */
  paint(): MeshStandardMaterial {
    return this.memo("paint", () => new MeshStandardMaterial({ color: new Color(0.62, 0.62, 0.6), roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  }

  walk(): MeshStandardMaterial {
    return this.memo("walk", () => withMaps(this.surf("walk", SURF.WALK, 512, 3, 1.2), { vertexColors: true, normalScale: new Vector2(0.7, 0.7) }));
  }

  asphalt(): MeshStandardMaterial {
    return this.memo("asphalt", () => withMaps(this.surf("asphalt", SURF.ASPHALT, 1024, 4, 2), { vertexColors: true, normalScale: new Vector2(0.5, 0.5) }));
  }

  lawn(): MeshStandardMaterial {
    return this.memo("lawn", () => withMaps(this.surf("lawn", SURF.LAWN, 512, 2, 2.2), { vertexColors: true, normalScale: new Vector2(1, 1) }));
  }

  hillside(): MeshStandardMaterial {
    return this.memo("hillside", () => withMaps(this.surf("hillside", SURF.HILLSIDE, 1024, 6, 2.2), { vertexColors: true, normalScale: new Vector2(1.1, 1.1) }));
  }

  /**
   * Leaf cards (gfx/observatory-foliage.ts): alpha-tested, double-sided,
   * vertex-coloured per plant, with a faint emission of the leaf colour so
   * cards in shade read as translucent leaves rather than black paper.
   */
  foliage(): MeshStandardMaterial {
    return this.memo("foliage", () => {
      const tex = (this.leaves ??= leafAtlas());
      return new MeshStandardMaterial({
        map: tex,
        alphaTest: 0.5,
        // Web only (MSAA): smooths the cut edges; the pack keeps the plain alpha test.
        alphaToCoverage: true,
        side: DoubleSide,
        roughness: 0.6,
        metalness: 0,
        vertexColors: true,
        emissive: new Color(0.4, 0.5, 0.3),
        emissiveMap: tex,
        emissiveIntensity: 0.04,
      });
    });
  }

  /** Bark of the oaks and pines (opaque cells of the leaf atlas). */
  bark(): MeshStandardMaterial {
    return this.memo("bark", () => new MeshStandardMaterial({ map: (this.leaves ??= leafAtlas()), roughness: 0.9, metalness: 0 }));
  }

  /** Materials made so far. */
  get count(): number {
    return this.cache.size;
  }
}
