/** Use the SGX texture unit's native direction lookup for display environment
 * maps. Shared radiance/reference materials retain octahedral textures. */
export function displayCubeFragment(name: string, source: string): string {
  const replace = (from: string, to: string) => {
    if (!source.includes(from)) throw new Error(`Display cube contract changed: ${from}`);
    source = source.replace(from, to);
  };
  replace("uniform sampler2D uDisplayEnv;", "uniform samplerCUBE uDisplayEnv;");
  if (name === "glass_f") {
    // Applied after the homogeneous reflection lowering: cube samplers also
    // accept an unnormalized direction, with no fragment octahedral fold.
    replace("tex2D(uDisplayEnv, octUv((float3)N * (2.0 * dot((float3)N, toEye)) - toEye))",
      "texCUBE(uDisplayEnv, (float3)N * (2.0 * dot((float3)N, toEye)) - toEye)");
  } else if (name === "water_f") {
    replace("tex2D(uDisplayEnv, envUv)", "texCUBE(uDisplayEnv, (float3)R)");
  } else throw new Error(`Unsupported display cube material: ${name}`);
  return source;
}
