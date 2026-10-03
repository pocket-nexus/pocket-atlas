/** SGX535 samples half float textures but cannot attach them to an FBO.
 * Store reversible HDR radiance in RGBA8; preserve linear blending using
 * framebuffer fetch, and logarithmic eye distance in alpha for the haze pass.
 * This adapter changes storage, not the shared lighting/material algorithms. */
export function hdrFragment(
  source: string,
  name: string,
  defines: Record<string, number> = {},
): string {
  if (defines.ATLAS_COVERAGE_TARGET && (!defines.ATLAS_LDR || !defines.ATLAS_OUTPUT_LDR))
    throw new Error("Coverage targets require opaque display output");
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
    name === "composite_f" || name === "color_f" || name === "blit_f" || name.startsWith("shadow");
  const codec = `
highp vec4 atlasDecode(highp vec4 c) {
 mediump vec3 rgb=c.rgb;
 mediump vec3 q=rgb*rgb;
 mediump vec3 radiance=q / max(vec3(1.0)-q,vec3(1.0/255.0));
 return vec4(radiance, exp2(c.a*16.0)-1.0);
}
highp vec4 atlasEncode(highp vec4 c) {
 mediump vec3 rgb=clamp(c.rgb,vec3(0.0),vec3(126.0));
 mediump vec3 encoded=sqrt(rgb/(vec3(1.0)+rgb));
 return vec4(encoded, clamp(log2(1.0+max(c.a,0.0))/16.0,0.0,1.0));
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
    if (defines.ATLAS_LDR) {
      if (defines.ATLAS_COVERAGE_TARGET && (!defines.ATLAS_OUTPUT_LDR || mode !== 0))
        throw new Error("Coverage targets require opaque display output");
      source = source.replace("void main(", "void atlasMaterial(")
        .replace(/gl_FragData\[0\]/g, "atlasColor")
        .replace("void atlasMaterial(", "highp vec4 atlasColor;\nvoid atlasMaterial(");
      if (defines.ATLAS_OUTPUT_LDR)
        return source + `\nvoid main() { atlasMaterial(); gl_FragColor=vec4(atlasColor.rgb,${defines.ATLAS_COVERAGE_TARGET ? "1.0" : mode === 0 ? "1.0/(1.0+max(atlasColor.a,0.0)/32.0)" : "clamp(atlasColor.a,0.0,1.0)"}); }\n`;
      return source + `
uniform mediump sampler2D uAtlasLut;
uniform mediump vec4 uAtlasBlack;
mediump vec3 atlasDisplay(highp vec3 c) {
 mediump vec3 cell=sqrt(max(c,vec3(0.0))/(1.0+max(c,vec3(0.0))))*15.0;
 mediump float b=floor(cell.b);
 mediump vec2 uv=vec2((b*16.0+cell.r+0.5)/256.0,(cell.g+0.5)/16.0);
 return mix(texture2D(uAtlasLut,uv).rgb,
   texture2D(uAtlasLut,uv+vec2(min(b+1.0,15.0)-b,0.0)/16.0).rgb,cell.b-b);
}
void main() {
 atlasMaterial();
 ${mode === 3 ? "mediump float a=clamp(atlasColor.a,0.0,1.0); gl_FragColor=vec4(atlasDisplay(atlasColor.rgb/max(a,0.001))*a,a);" :
  mode === 0 ? "gl_FragColor=vec4(atlasDisplay(atlasColor.rgb),1.0/(1.0+max(atlasColor.a,0.0)/32.0));" :
  mode === 2 && defines.ATLAS_COVERAGE ? "mediump float a=max(atlasColor.a,0.0); gl_FragColor=vec4(max(atlasDisplay(atlasColor.rgb/max(a,0.001))-uAtlasBlack.rgb,0.0)*a,a);" :
  mode === 2 ? "gl_FragColor=vec4(max(atlasDisplay(atlasColor.rgb)-uAtlasBlack.rgb,0.0),0.0);" :
  "gl_FragColor=vec4(atlasDisplay(atlasColor.rgb),clamp(atlasColor.a,0.0,1.0));"}
}
`;
    }
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
  highp vec4 dst=atlasDecode(vec4(gl_LastFragData[0].rgb,0.0));
  highp float a=clamp(result.a,0.0,1.0);
  if(${mode}.0<1.5) result.rgb=result.rgb*a+dst.rgb*(1.0-a);
  else if(${mode}.0<2.5) result.rgb+=dst.rgb;
  else result.rgb+=dst.rgb*(1.0-a);
  result.a=dst.a;
 }
 ${mode === 0 ? "*/" : ""}
 gl_FragColor=atlasEncode(result);
 ${mode === 0 ? "" : "gl_FragColor.a=gl_LastFragData[0].a;"}
}\n`;
  }
  return source;
}
