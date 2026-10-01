import { Color, DoubleSide, MeshStandardMaterial, RepeatWrapping, Vector2, Vector4, type Texture } from "three";
import { Rng } from "../../core/random";
import type { Baker } from "./bake";

/**
 * Open water (sea, lake, river) for the web and the handheld: one model,
 * evaluated per pixel on both.
 *
 * The surface is flat geometry. Two layers of one tileable wave normal map
 * are laid on the world's x/z plane and scrolled; their slopes perturb the
 * up vector, the environment is reflected by Fresnel and the light scattered
 * out of the body fills the rest; the sun adds a GGX highlight whose
 * roughness grows with distance (waves smaller than a pixel widen the sun's
 * reflection into a glitter path), while the slopes flatten.
 *
 *   uv_i  = world.xz · rpm_i + fract(t · scroll_i · rpm_i)          (i = 1, 2)
 *   n_i   = tex(uv_i).rg · 2 − 1
 *   a2    = roughness² + d · distanceRoughness                       d = eye distance
 *   calm  = 1 / (1 + d · distanceRoughness · 40)
 *   slope = (n_1 + n_2) · normalScale · calm
 *   N     = normalize(slope.x, 1, slope.y)
 *   F     = 0.02 + 0.98 · 2^((−5.55473 N·V − 6.98316) N·V)
 *   R     = reflect(−V, N),  R.y = |R.y|
 *   sky   = environment(R) · envMapIntensity · scene environment intensity
 *   body  = bodyColour · hemisphere sky (colour × intensity)
 *   L_o   = mix(body, sky, F) + sun · N·L · F(V·H) · D_GGX(√a2, N·H) · V_SmithGGXCorrelated(√a2, N·L, N·V)
 *
 * then FogExp2. No shadows. The pattern at texture coordinate u₀ sits at
 * world u₀ / rpm − t · scroll, so a layer moves against its scroll vector.
 *
 * Export contract (`extras.pocketAtlas` on a MeshStandardMaterial, passed
 * through by `export.ts`; the cooker reads it as `Kind::Water`):
 *   kind: "water"
 *   normalMap          the wave texture (cooked to BC5 with mips; RG only:
 *                      tangent-space XY, the plane's up is Z), repeat wrapping
 *   normalScale.x      wave slope scale
 *   roughness          GGX α near the camera
 *   envMapIntensity    × the scene's environment intensity
 *   waves: [[repeatsPerMetre, scrollX, scrollZ], [...]]   scroll in m/s along world x and z
 *   body: [r, g, b]    linear colour of the light the body scatters back, × sky irradiance
 *   distanceRoughness  α² added per metre of distance
 */

export interface WaveLayer {
  /** Texture repeats per metre. */
  repeatsPerMetre: number;
  /** Scroll in m/s along world x and z (the pattern moves the other way). */
  scroll: [number, number];
}

export interface WaterSpec {
  name?: string;
  waves: [WaveLayer, WaveLayer];
  /** Wave slope scale (normalScale.x). */
  slope: number;
  /** GGX α near the camera. */
  roughness: number;
  /** α² added per metre of eye distance. */
  distanceRoughness: number;
  /** Linear colour scattered out of the body, × the hemisphere sky colour. */
  body: Color;
  envMapIntensity: number;
}

const WAVE_SIZE = 1024;

/** One sinusoid of the wave texture: integer wave numbers keep it tileable. */
interface Component {
  k: [number, number];
  a: number;
  phase: number;
}

/**
 * Wave components for a wind sea plus swell travelling toward `heading`
 * (radians in texture space: 0 = +u, π/2 = +v), with a cos²-spread around
 * it. Wave numbers count repeats per texture tile.
 */
function spectrum(seed: number, heading: number, spreadK = 0.9, falloff = 1.7): Component[] {
  const rng = new Rng(seed);
  const out: Component[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 96; i++) {
    // Wave numbers from 1 to ~22 repeats per tile, denser at the long end.
    const kmag = 1.2 * Math.pow(18, rng.next());
    const spread = (rng.next() + rng.next() + rng.next() - 1.5) * spreadK;
    const dir = heading + spread;
    let kx = Math.round(Math.cos(dir) * kmag);
    let ky = Math.round(Math.sin(dir) * kmag);
    if (kx === 0 && ky === 0) ky = 1;
    const key = `${kx},${ky}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const k = Math.hypot(kx, ky);
    // Height ∝ k^-falloff (1.7 by default): the slope spectrum falls slowly toward short waves.
    out.push({ k: [kx, ky], a: Math.pow(k, -falloff) * (0.6 + 0.8 * rng.next()), phase: rng.next() * Math.PI * 2 });
  }
  return out;
}

/**
 * Bakes the tileable wave normal texture: a sum of sinusoids with integer
 * wave numbers (sharpened toward Stokes-like crests) plus a fine noise
 * ripple. RGB holds the unit normal (x = −∂h/∂u, y = −∂h/∂v, z up) as
 * n · 0.5 + 0.5, as the cooker's BC5 encoder expects.
 *
 * `tilt` adds a constant slope (texture u, v): seen from land at a grazing
 * angle, the faces of the waves turned toward the viewer hide their backs,
 * so the water reflects higher, bluer sky than a symmetric slope
 * distribution gives. A place whose cameras all stand on one shore tilts
 * the mean normal toward that shore to stand in for the masking.
 */
export function bakeWaveNormals(baker: Baker, opts: { seed?: number; heading?: number; size?: number; strength?: number; spread?: number; falloff?: number; tilt?: [number, number] } = {}): Texture {
  const comps = spectrum(opts.seed ?? 7, opts.heading ?? -Math.PI / 2, opts.spread ?? 0.9, opts.falloff ?? 1.7);
  const tilt = opts.tilt ?? [0, 0];
  // Normalise so the RMS slope of the texture is about `strength`.
  let ms = 0;
  for (const c of comps) ms += 0.5 * (c.a * 2 * Math.PI * Math.hypot(c.k[0], c.k[1])) ** 2;
  const norm = (opts.strength ?? 0.32) / Math.sqrt(ms);
  const decl = comps.map((c) => `  w = wave(p, vec2(${c.k[0].toFixed(1)}, ${c.k[1].toFixed(1)}), ${(c.a * norm).toFixed(6)}, ${c.phase.toFixed(4)}); g += w;`).join("\n");
  const size = opts.size ?? WAVE_SIZE;
  const tex = baker.bake(
    size,
    size,
    /* glsl */ `
      vec2 p = vUv;
      vec2 g = vec2(0.0);
      vec2 w;
${decl}
      // Capillary ripple: finite differences of tileable noise.
      vec2 e = 1.0 / uRes;
      float r0 = fbm(p * 48.0, vec2(48.0), 3);
      float rx = fbm((p + vec2(e.x, 0.0)) * 48.0, vec2(48.0), 3);
      float ry = fbm((p + vec2(0.0, e.y)) * 48.0, vec2(48.0), 3);
      g += vec2(rx - r0, ry - r0) / e * 0.0016;
      vec3 n = normalize(vec3(-g + vec2(${tilt[0].toFixed(4)}, ${tilt[1].toFixed(4)}), 1.0));
      outColor = vec4(n * 0.5 + 0.5, 1.0);`,
    {
      header: /* glsl */ `
        #define TAU 6.2831853
        // Gradient of a sharpened sinusoid a · (sin θ − 0.18 cos 2θ): crests
        // narrower than troughs, as on a real sea.
        vec2 wave(vec2 p, vec2 k, float a, float ph) {
          float th = TAU * dot(k, p) + ph;
          return a * TAU * k * (cos(th) + 0.36 * sin(2.0 * th));
        }`,
    },
  );
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.name = "water-waves";
  return tex;
}

/** The water surface material and the per-frame clock for its wave layers. */
export interface Water {
  material: MeshStandardMaterial;
  /** Steps the wave layers to place time `t` (seconds). */
  update(t: number): void;
}

/**
 * Builds the water material: a MeshStandardMaterial (so the exporter keeps
 * the normal map, roughness, normal scale and environment intensity) whose
 * lighting is replaced by the water model above.
 */
export function createWater(spec: WaterSpec, waves: Texture): Water {
  const material = new MeshStandardMaterial({
    color: spec.body.clone().multiplyScalar(4),
    roughness: spec.roughness,
    metalness: 0,
    normalMap: waves,
    normalScale: new Vector2(spec.slope, spec.slope),
    envMapIntensity: spec.envMapIntensity,
  });
  material.name = spec.name ?? "water";
  const layer = (l: WaveLayer): [number, number, number] => [l.repeatsPerMetre, l.scroll[0], l.scroll[1]];
  material.userData.pocketAtlas = {
    kind: "water",
    waves: [layer(spec.waves[0]), layer(spec.waves[1])],
    body: spec.body.toArray(),
    distanceRoughness: spec.distanceRoughness,
  };
  const uWave = { value: [new Vector4(), new Vector4()] };
  const uniforms = {
    uWaveMap: { value: waves },
    uWave,
    uWaterK: { value: new Vector4(spec.body.r, spec.body.g, spec.body.b, spec.distanceRoughness) },
    uWaterPbr: { value: new Vector4(spec.roughness, spec.slope, spec.envMapIntensity, 0) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform vec4 uWave[2];
        varying vec3 vWaterWorld;
        varying vec2 vWaterUv1;
        varying vec2 vWaterUv2;`,
      )
      .replace(
        "#include <project_vertex>",
        /* glsl */ `#include <project_vertex>
        vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWaterUv1 = vWaterWorld.xz * uWave[0].x + uWave[0].zw;
        vWaterUv2 = vWaterWorld.xz * uWave[1].x + uWave[1].zw;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform sampler2D uWaveMap;
        uniform vec4 uWaterK;
        uniform vec4 uWaterPbr;
        varying vec3 vWaterWorld;
        varying vec2 vWaterUv1;
        varying vec2 vWaterUv2;`,
      )
      // The standard path's normal map and lights are replaced below.
      .replace("#include <normal_fragment_maps>", "")
      .replace("#include <lights_fragment_begin>", "")
      .replace("#include <lights_fragment_maps>", "")
      .replace("#include <lights_fragment_end>", "")
      .replace(
        "#include <opaque_fragment>",
        /* glsl */ `{
          vec3 toEye = cameraPosition - vWaterWorld;
          float dist = length(toEye);
          vec3 V = toEye / dist;
          vec2 n1 = texture2D(uWaveMap, vWaterUv1).rg * 2.0 - 1.0;
          vec2 n2 = texture2D(uWaveMap, vWaterUv2).rg * 2.0 - 1.0;
          float a2 = uWaterPbr.x * uWaterPbr.x + dist * uWaterK.w;
          float calm = 1.0 / (1.0 + dist * uWaterK.w * 40.0);
          vec2 slope = (n1 + n2) * (uWaterPbr.y * calm);
          vec3 N = normalize(vec3(slope.x, 1.0, slope.y));
          float dotNV = max(dot(N, V), 1e-3);
          float F = 0.02 + 0.98 * exp2((-5.55473 * dotNV - 6.98316) * dotNV);
          vec3 R = reflect(-V, N);
          R.y = abs(R.y);
          vec3 sky = vec3(0.0);
          #ifdef ENVMAP_TYPE_CUBE_UV
            sky = textureCubeUV(envMap, envMapRotation * R, 0.0).rgb * envMapIntensity * uWaterPbr.z;
          #endif
          vec3 hemi = vec3(0.0);
          #if NUM_HEMI_LIGHTS > 0
            hemi = hemisphereLights[0].skyColor;
          #endif
          vec3 water = mix(uWaterK.rgb * hemi, sky, F);
          #if NUM_DIR_LIGHTS > 0
          {
            vec3 L = normalize((vec4(directionalLights[0].direction, 0.0) * viewMatrix).xyz);
            vec3 H = normalize(L + V);
            float dotNL = saturate(dot(N, L));
            float dotNH = saturate(dot(N, H));
            float dotVH = saturate(dot(V, H));
            float alpha = sqrt(a2);
            float Fs = 0.02 + 0.98 * exp2((-5.55473 * dotVH - 6.98316) * dotVH);
            water += directionalLights[0].color * (dotNL * Fs * V_GGX_SmithCorrelated(alpha, dotNL, dotNV) * D_GGX(alpha, dotNH));
          }
          #endif
          outgoingLight = water;
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => "pocket-atlas-water-1";
  const fract = (v: number) => v - Math.floor(v);
  const set = (u: Vector4, l: WaveLayer, t: number) => u.set(l.repeatsPerMetre, 0, fract(t * l.scroll[0] * l.repeatsPerMetre), fract(t * l.scroll[1] * l.repeatsPerMetre));
  const update = (t: number) => {
    set(uWave.value[0], spec.waves[0], t);
    set(uWave.value[1], spec.waves[1], t);
  };
  update(0);
  return { material, update };
}

/**
 * Foam bands of breaking waves: a lit, alpha-blended strip whose texture
 * scrolls toward the shore (`scroll: [du, dv]` in the annotation, the
 * cooker's UV animation). The strip's vertex alpha fades the bands in and
 * out across the surf zone; `update(t)` drives the same offset on the web.
 */
export function foamMaterial(map: Texture, scroll: [number, number], name = "surf-foam"): { material: MeshStandardMaterial; update(t: number): void } {
  const material = new MeshStandardMaterial({
    map,
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  material.name = name;
  material.userData.pocketAtlas = { scroll };
  const fract = (v: number) => v - Math.floor(v);
  return {
    material,
    update: (t) => map.offset.set(fract(scroll[0] * t), fract(scroll[1] * t)),
  };
}
