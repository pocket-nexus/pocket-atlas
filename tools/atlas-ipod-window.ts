/** Interior-window seed evaluation on SGX's vertex stage. Enable only when
 * a compiler proof says every triangle has one floor(final UV) cell and one
 * pane-size RG pair, and the material cannot animate those UVs. The original
 * parallax, spatial room/TV lighting, curtain shape, reflection and grade stay
 * in the fragment stage. Seed/time-only factors use the vertex stage. Three
 * highp vec4 parameters replace the colour varying:
 * seven vectors total, or eight with Vista. No CPU reimplementation of hash. */

function replace(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`Window parameter contract changed: ${from}`);
  return source.replace(from, to);
}

function sharedFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing shared window helper ${signature}`);
  const body = source.indexOf("{", start);
  let depth = 1, end = body + 1;
  for (; end < source.length && depth; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  if (body < 0 || depth) throw new Error(`Unclosed shared window helper ${signature}`);
  return source.slice(start, end);
}

export function windowParameterVertex(source: string, common: string): string {
  // Copy the authoritative float functions verbatim, so there is no CPU hash
  // or changed polynomial/order. TEXCOORD numbers are source semantics; the
  // GLES linker packs the seven/eight active named varyings, not ten slots.
  source = sharedFunction(common, "float hash12(") + "\n" + sharedFunction(common, "float3 hash32(") + "\n" + source;
  source = replace(source,
    "#if (defined(VISTA) && !defined(FLAT)) || defined(VERTEX_FOG) || defined(LDR_COLOR)",
    "#if (defined(VISTA) && !defined(FLAT)) || defined(VERTEX_FOG) || defined(LDR_COLOR) || defined(SGX_WINDOW_PARAMS)");
  source = replace(source, "    out half4 oColor : COLOR0,", `    out float4 oRoomA : COLOR0,
    out float4 oRoomB : TEXCOORD8,
    out float4 oRoomC : TEXCOORD9,`);
  return replace(source, "    oColor = (half4)aColor;", `    float2 windowSeed = floor(oUv);
    float3 windowHash = hash32(windowSeed * 1.37 + 0.5);
    // The proved pane dimensions use the same highp parameter transport as
    // the seed-only adapter. Do not introduce a mediump size multiply here.
    float2 windowSize = aColor.rg;
    float windowLamp = hash12(windowSeed + 17.1);
    float windowFurniture = hash12(windowSeed + 9.0);
    float windowStyle = hash12(windowSeed + 5.5);
    float windowCloth = hash12(windowSeed + 8.0);
    bool windowLit = windowHash.x < 0.62;
    bool windowTv = !windowLit && windowHash.y < 0.35;
    // Discrete choices are made before interpolation. Even a hash exactly
    // at a threshold cannot change rooms due to varying-rounding noise.
    float windowFlags = (windowLit ? 1.0 : (windowTv ? 2.0 : 0.0))
        + (windowLamp < 0.68 ? 4.0 : 0.0)
        + (windowHash.z < 0.4 ? 0.0 : (windowHash.z < 0.7 ? 8.0 : 16.0))
        + (windowStyle < 0.35 ? 0.0 : (windowStyle < 0.55 ? 32.0 : (windowStyle < 0.75 ? 64.0 : 96.0)))
        + (windowCloth >= 0.7 ? 128.0 : 0.0)
        + (windowFurniture > 0.5 ? 256.0 : 0.0);
    float3 windowLampCol = windowLamp < 0.68 ? float3(1.0, 0.72, 0.45) : float3(0.82, 0.9, 1.0);
    float windowBright = 0.55 + windowHash.y * 0.9;
    float windowFlicker = 0.6 + 0.4 * sin(uEye.w * 7.0 + windowHash.x * 40.0)
        * sin(uEye.w * 3.1 + windowHash.z * 11.0);
    oRoomA = float4(max((float2)windowSize * 16.0, float2(0.3, 0.3)),
        3.2 + windowHash.z * 2.5, windowFlags);
    oRoomB = float4(hash12(windowSeed + 3.0), windowFurniture,
        0.25 + 0.35 * hash12(windowSeed + 2.0),
        0.4 + 0.6 * hash12(windowSeed + 4.0) + 0.001);
    oRoomC = float4(windowLampCol * windowBright, windowFlicker);`);
}

export function windowParameterFragment(source: string): string {
  source = replace(source, "    half4 vColor : COLOR0)", `    float4 vRoomA : COLOR0,
    float4 vRoomB : TEXCOORD8,
    float4 vRoomC : TEXCOORD9)`);
  for (const [from, to] of [
    ["max(vColor.r * 16.0, 0.3)", "vRoomA.x"],
    ["max(vColor.g * 16.0, 0.3)", "vRoomA.y"],
    ["    float2 seed = floor(vUv);\n", "    float windowFlags = floor(vRoomA.w + 0.5);\n"],
    ["        float3 h3 = hash32(seed * 1.37 + 0.5);\n", ""],
    ["        float h4 = hash12(seed + 17.1);\n", ""],
    ["3.2 + h3.z * 2.5", "vRoomA.z"],
    ["bool lit = h3.x < 0.62;", "bool lit = fmod(windowFlags, 4.0) == 1.0;"],
    ["bool tv = !lit && h3.y < 0.35;", "bool tv = fmod(windowFlags, 4.0) == 2.0;"],
    ["        float3 lampCol = h4 < 0.68 ? float3(1.0, 0.72, 0.45) : float3(0.82, 0.9, 1.0);\n", ""],
    ["        float bright = 0.55 + h3.y * 0.9;\n", ""],
    ["float3 roomLight(float3 h, float3 room, float3 lampCol, float lit)",
      "float3 roomLight(float3 h, float3 room, float3 lampLight)"],
    ["return lampCol * lit * (", "return lampLight * ("],
    ["roomLight(h, room, lampCol, bright)", "roomLight(h, room, vRoomC.rgb)"],
    ["lampCol * bright * 0.9", "vRoomC.rgb * 0.9"],
    ["0.6 + 0.4 * sin(uEye.w * 7.0 + h3.x * 40.0) * sin(uEye.w * 3.1 + h3.z * 11.0)", "vRoomC.w"],
    ["h3.z < 0.4 ?", "fmod(floor(windowFlags / 8.0), 4.0) < 0.5 ?"],
    ["h3.z < 0.7 ?", "fmod(floor(windowFlags / 8.0), 4.0) < 1.5 ?"],
    ["hash12(seed + 3.0)", "vRoomB.x"],
    ["hash12(seed + 9.0)", "vRoomB.y"],
    ["if (k > 0.5 &&", "if (windowFlags >= 256.0 &&"],
    ["hash12(seed + 5.5)", "fmod(floor(windowFlags / 32.0), 4.0)"],
    ["step(0.7, hash12(seed + 8.0))", "fmod(floor(windowFlags / 128.0), 2.0)"],
    ["style < 0.35", "style < 0.5"],
    ["style < 0.55", "style < 1.5"],
    ["style < 0.75", "style < 2.5"],
    ["0.25 + 0.35 * hash12(seed + 2.0)", "vRoomB.z"],
    ["0.4 + 0.6 * hash12(seed + 4.0) + 0.001", "vRoomB.w"],
  ]) source = replace(source, from, to);
  return source;
}
