/** SGX535 samples half float textures but cannot attach them to an FBO.
 * Store reversible HDR radiance in RGBA8; preserve linear blending using
 * framebuffer fetch, and logarithmic eye distance in alpha for the haze pass.
 * This adapter changes storage, not the shared lighting/material algorithms. */
export function hdrFragment(
  source: string,
  name: string,
  defines: Record<string, number> = {},
): string {
  if (name === "blit_f") return source;
  const targets = new Set([
    "uInscatter",
    "uEnv",
    "uScene",
    "uSource",
    "uSupport",
    "uBloom",
    "uHazeTex",
    "uReflSharp",
    "uReflBlur",
  ]);
  // Match balanced texture arguments (UV expressions can contain function calls).
  const call = /\btexture2D(?:LodEXT)?\s*\(\s*(\w+)\s*,/g;
  const replacements: { start: number; end: number }[] = [];
  for (let match; (match = call.exec(source)); ) {
    if (!targets.has(match[1])) continue;
    let depth = 1,
      end = call.lastIndex;
    for (; end < source.length && depth; end++) {
      if (source[end] === "(") depth++;
      if (source[end] === ")") depth--;
    }
    if (depth) throw new Error("Unclosed texture sample");
    replacements.push({ start: match.index, end });
    call.lastIndex = end;
  }
  for (const { start, end } of replacements.reverse())
    source =
      source.slice(0, start) +
      "atlasDecode(" +
      source.slice(start, end) +
      ")" +
      source.slice(end);
  const final =
    name === "composite_f" || name === "blit_f" || name.startsWith("shadow");
  const codec = `
highp vec4 atlasDecode(highp vec4 c) {
 highp vec3 q=c.rgb*c.rgb;
 return vec4(q / max(vec3(1.0)-q,vec3(1.0/255.0)), exp2(c.a*16.0)-1.0);
}
highp vec4 atlasEncode(highp vec4 c) {
 highp vec3 rgb=clamp(c.rgb,vec3(0.0),vec3(126.0));
 return vec4(sqrt(rgb/(vec3(1.0)+rgb)), clamp(log2(1.0+max(c.a,0.0))/16.0,0.0,1.0));
}
`;
  const start = source.indexOf("void main(");
  if (start < 0) throw new Error("GLSL main missing");
  source = source.slice(0, start) + codec + source.slice(start);
  if (!final) {
    const mode =
      defines.ATLAS_BLEND ??
      (name === "fx_f"
        ? defines.STEAM
          ? 3
          : 2
        : name === "lights_f" || name === "tower_f"
          ? 2
          : 0);
    if (mode !== 0)
      source = source.replace(
        "#version 100",
        "#version 100\n#extension GL_EXT_shader_framebuffer_fetch : require",
      );
    source = source
      .replace("void main(", "void atlasMaterial(")
      .replace(/gl_FragData\[0\]/g, "atlasColor");
    source = source.replace(
      "void atlasMaterial(",
      "highp vec4 atlasColor;\nvoid atlasMaterial(",
    );
    source += `\nvoid main() {
 atlasMaterial();
 highp vec4 result=atlasColor;
 ${mode === 0 ? "/* Opaque: no framebuffer fetch or hidden surface dependency. */" : ""}
 ${mode === 0 ? "/*" : ""}
 {
  highp vec4 dst=atlasDecode(gl_LastFragData[0]);
  highp float a=clamp(result.a,0.0,1.0);
  if(${mode}.0<1.5) result.rgb=result.rgb*a+dst.rgb*(1.0-a);
  else if(${mode}.0<2.5) result.rgb+=dst.rgb;
  else result.rgb+=dst.rgb*(1.0-a);
  result.a=dst.a;
 }
 ${mode === 0 ? "*/" : ""}
 gl_FragColor=atlasEncode(result);
}\n`;
  }
  return source;
}
