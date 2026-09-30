import { RepeatWrapping, type MeshStandardMaterial, type Texture } from "three";
import { canvas, toTexture } from "../../gfx/canvas";
import type { MaterialLib } from "../../gfx/materials";

const shaded = new WeakMap<MeshStandardMaterial, MeshStandardMaterial>();
const toned = new WeakMap<MeshStandardMaterial, MeshStandardMaterial>();

/**
 * Clothing and skin materials. Outdoors: plain PBR lit by the street (low
 * roughness reads as rain-soaked). Indoors: `lib.interior` surfaces (the shop
 * has no real lights inside) with the emission shaded by the world normal and
 * height, so a figure under the LED ceiling keeps its form instead of reading
 * as a flat cut-out: tops of shoulders and heads brightest, legs darker.
 */
export class Wear {
  private lib: MaterialLib;
  readonly indoor: boolean;

  constructor(lib: MaterialLib, indoor: boolean) {
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
    const base = this.lib.interior(hex, lit, rough, map, "people");
    let m = shaded.get(base);
    if (!m) {
      m = base.clone();
      m.name = `${base.name}-shaded`;
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

/** Vertical pinstripes in the shop's blue and green on white (u is meters around the body). */
export function uniformStripes(): Texture {
  const { c, g } = canvas(64, 4);
  g.fillStyle = "#eef2f4";
  g.fillRect(0, 0, 64, 4);
  g.fillStyle = "#2f6fc0";
  g.fillRect(6, 0, 9, 4);
  g.fillStyle = "#1c9a78";
  g.fillRect(38, 0, 5, 4);
  const t = toTexture(c, true, 4);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(1 / 0.03, 1);
  return t;
}
