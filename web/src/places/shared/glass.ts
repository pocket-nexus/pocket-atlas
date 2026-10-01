import { CustomBlending, MeshStandardMaterial, OneFactor, OneMinusSrcAlphaFactor, type MeshPhysicalMaterial, type MeshStandardMaterialParameters, type WebGLProgramParametersWithUniforms } from "three";

/**
 * Fragment output of glass, premultiplied: reflections and highlights are
 * added at full strength while the tint (diffuse) scales with coverage, like
 * real glass over a bright interior. `glassDrop` (0..1) is water on the pane
 * (a place's patch may set it): a little more cover, brighter highlights.
 */
const GLASS_OUT = /* glsl */ `
{
  // Premultiplied: reflections are added at full strength while the tint
  // (diffuse) scales with coverage, like real glass over a bright interior.
  float cover = clamp(diffuseColor.a + glassDrop * 0.12, 0.0, 1.0);
  gl_FragColor = vec4(totalDiffuse * cover + totalSpecular * (1.0 + glassDrop * 0.6) + totalEmissiveRadiance, cover);
}
`;

export interface GlassOptions {
  /** Extra annotation keys (e.g. `glass: { drops }`). */
  annotation?: Record<string, unknown>;
  /** The place's own shader work (rain on the pane); it declares and sets `float glassDrop` after the normal maps. */
  patch?: (shader: WebGLProgramParametersWithUniforms) => void;
  /** Program cache key (one per distinct patch). */
  cacheKey?: string;
}

/**
 * Makes a lit material glass the way the cooker cooks `kind: "glass"` for
 * the handheld: transparent without depth writes, premultiplied blending
 * (One, OneMinusSrcAlpha) and the matching fragment output, so web and
 * device blend the same way.
 */
export function asGlass<T extends MeshStandardMaterial | MeshPhysicalMaterial>(material: T, opts: GlassOptions = {}): T {
  material.userData.pocketAtlas = { ...(material.userData.pocketAtlas ?? {}), kind: "glass", ...opts.annotation };
  material.transparent = true;
  material.depthWrite = false;
  material.blending = CustomBlending;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;
  material.onBeforeCompile = (shader) => {
    if (opts.patch) opts.patch(shader);
    else shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\nfloat glassDrop = 0.0;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", GLASS_OUT);
  };
  material.customProgramCacheKey = () => opts.cacheKey ?? "glass";
  return material;
}

/** Plain glass: a MeshStandardMaterial with `params` (colour, roughness, opacity as coverage, …) made glass. */
export function glassMaterial(params: MeshStandardMaterialParameters, opts: GlassOptions = {}): MeshStandardMaterial {
  return asGlass(new MeshStandardMaterial(params), opts);
}
