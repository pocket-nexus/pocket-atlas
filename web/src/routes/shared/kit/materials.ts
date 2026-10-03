import { Color, MeshStandardMaterial, Vector2, type Material } from "three";
import type { Quality } from "../../../core/quality";
import type { Baker, SurfaceMaps } from "../../../places/shared/bake";
import { addBuildingMaterials } from "./buildings";
import { addPlantMaterials } from "./plants";
import { addRoadsideMaterials } from "./roadside";
import { addStructureMaterials } from "./structures";
import * as SURF from "./surfaces";

/**
 * The kit: every material a route's cells are drawn with, by name. The
 * generators (`gen/*.ts`) name materials; the page looks them up here, and
 * the kit's export carries one swatch of each so the compiler finds the
 * same names (`kit/swatches.ts`). Add a material here, use its name in a
 * generator, and it reaches the handheld.
 *
 *   snow   open ground, banks and verges; tinted by vertex colour   4 m per repeat
 *   road   the driven road's surface, u across its width             8 m per repeat along
 *   lane   packed snow of side streets and road mouths               4 m per repeat
 */
export class Kit {
  private mats = new Map<string, Material>();
  private size: number;

  constructor(
    private baker: Baker,
    quality: Quality,
  ) {
    this.size = Math.min(1024, quality.textureSize);
    this.build();
  }

  /** Bakes a procedural surface (`Baker.surface`) at the kit's texture size. */
  surface(key: string, glsl: string, bump: number, size = this.size): SurfaceMaps {
    const m = this.baker.surface(size, glsl, { bump });
    for (const t of [m.map, m.normalMap, m.ormMap]) t.name = key;
    return m;
  }

  /** Adds a lit material under `name`, with a baked surface's maps when given. */
  standard(name: string, maps: SurfaceMaps | null, params: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}): MeshStandardMaterial {
    const m = new MeshStandardMaterial(
      maps
        ? { map: maps.map, normalMap: maps.normalMap, roughnessMap: maps.ormMap, metalnessMap: maps.ormMap, aoMap: maps.ormMap, aoMapIntensity: 0.8, roughness: 1, metalness: 1, ...params }
        : params,
    );
    m.name = name;
    this.mats.set(name, m);
    return m;
  }

  private build(): void {
    this.standard("snow", this.surface("snow", SURF.SNOW, 1.6), { vertexColors: true, normalScale: new Vector2(0.7, 0.7) });
    const road = this.standard("road", this.surface("road", SURF.ROAD, 2.2), { normalScale: new Vector2(0.9, 0.9) });
    // Polished wheel tracks keep their sheen at a distance on the handheld (the wet-film path).
    road.userData.pocketAtlas = { wet: { puddles: 0, darken: 1, roughness: 1, ripple: 0, puddleScale: 14 } };
    this.standard("lane", this.surface("lane", SURF.LANE, 1.4), { normalScale: new Vector2(0.6, 0.6) });
    // Each generator's materials, next to its atlas layout.
    addRoadsideMaterials(this);
    addBuildingMaterials(this);
    addPlantMaterials(this);
    addStructureMaterials(this);
  }

  /** Adds any material under `name` (unlit signs, cut-outs, glass). */
  add<T extends Material>(name: string, material: T): T {
    material.name = name;
    this.mats.set(name, material);
    return material;
  }

  /** The preset's largest texture edge, capped at 1024 (what the handheld keeps). */
  get textureSize(): number {
    return this.size;
  }

  /** A kit material by name; an unknown name is a generator's mistake and shows magenta. */
  material(name: string): Material {
    let m = this.mats.get(name);
    if (!m) {
      console.warn(`[route] no kit material "${name}"`);
      m = this.standard(name, null, { color: new Color(1, 0, 1) });
    }
    return m;
  }

  names(): string[] {
    return [...this.mats.keys()];
  }

  dispose(): void {
    for (const m of this.mats.values()) m.dispose();
  }
}
