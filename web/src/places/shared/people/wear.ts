import type { MeshStandardMaterial, Texture } from "three";

/** What a wardrobe asks of a place's material library. */
export interface WearLib {
  /** Plain PBR paint. */
  plain(hex: number, rough?: number): MeshStandardMaterial;
  /** Interior-lit surface whose emission carries the room light; indoor wardrobes only. */
  interior?(hex: number, lit?: number, rough?: number, map?: Texture, key?: string): MeshStandardMaterial;
}

const shaded = new WeakMap<MeshStandardMaterial, MeshStandardMaterial>();
const toned = new WeakMap<MeshStandardMaterial, MeshStandardMaterial>();

/**
 * Clothing and skin materials. Outdoors: the place's plain PBR, lit by its
 * lights. Indoors (an interior without real lights, such as the konbini):
 * `lib.interior` surfaces with the emission shaded by the world normal and
 * height, so a figure under an LED ceiling keeps its form instead of reading
 * as a flat cut-out: tops of shoulders and heads brightest, legs darker.
 */
export class Wear {
  private lib: WearLib;
  readonly indoor: boolean;

  constructor(lib: WearLib, indoor: boolean) {
    if (indoor && !lib.interior) throw new Error("an indoor wardrobe needs lib.interior");
    this.lib = lib;
    this.indoor = indoor;
  }

  /** White base for vertex-coloured figures (one per roughness class). */
  body(rough: number): MeshStandardMaterial {
    const base = this.cloth(0xffffff, rough, 0.8);
    let m = toned.get(base);
    if (!m) {
      m = base.clone();
      m.name = `${base.name}-vc`;
      m.vertexColors = true;
      m.onBeforeCompile = base.onBeforeCompile;
      m.customProgramCacheKey = base.customProgramCacheKey;
      toned.set(base, m);
    }
    return m;
  }

  cloth(hex: number, rough = 0.6, lit = 0.8, map?: Texture): MeshStandardMaterial {
    if (!this.indoor) return this.lib.plain(hex, rough);
    const base = this.lib.interior!(hex, lit, rough, map, "people");
    let m = shaded.get(base);
    if (!m) {
      m = base.clone();
      m.name = `${base.name}-shaded`;
      m.userData.pocketAtlas = { ...m.userData.pocketAtlas, emissionShading: "indoor-wardrobe" };
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace(
          "#include <emissivemap_fragment>",
          /* glsl */ `#include <emissivemap_fragment>
          {
            vec3 pplN = inverseTransformDirection( normal, viewMatrix );
            vec3 pplW = cameraPosition + ( vec4( -vViewPosition, 0.0 ) * viewMatrix ).xyz;
            float pplK = 0.6 + 0.4 * pplN.y + 0.12 * abs( pplN.x );
            pplK *= mix( 0.62, 1.0, smoothstep( 0.05, 1.45, pplW.y ) );
            totalEmissiveRadiance *= pplK;
            #ifdef USE_COLOR
              totalEmissiveRadiance *= vColor.rgb;
            #endif
          }`,
        );
      };
      m.customProgramCacheKey = () => "people-indoor";
      shaded.set(base, m);
    }
    return m;
  }
}
