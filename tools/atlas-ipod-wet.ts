/** SGX535 lowering of the shared wet display material. Reflection, puddle
 * coverage and ripple samples stay per fragment. View Fresnel is interpolated
 * across the cooked lit mesh; immutable material/atlas arithmetic is uniform. */
export function wetVertex(source: string): string {
  const replace = (from: string, to: string) => {
    if (!source.includes(from)) throw new Error(`Wet vertex contract changed: ${from}`);
    source = source.replace(from, to);
  };
  replace("    out float3 oWorld : TEXCOORD0)", `    uniform half4 uWet2,
    uniform float4 uRipple,
    out half oWetFresnel : TEXCOORD2,
    out float4 oWetUv : TEXCOORD0)`);
  replace("    oWorld = world;", `    oWetUv = float4(world.xz * uWet2.x, world.xz * uRipple.w);
    float3 toEye = uEye.xyz - world;
    half facing = (half)saturate(toEye.y * rsqrt(max(dot(toEye, toEye), 1e-8)));
    half k = (half)1.0 - facing;
    oWetFresnel = (half)0.04 + (half)0.96 * k * k * k * k;`);
  // Wet scenes use uEye even when they do not require distance in alpha.
  replace("#if (defined(VISTA) && !defined(FLAT)) || defined(VERTEX_FOG) || defined(LDR_COLOR)",
    "#if 1 // SGX wet view Fresnel");
  return source;
}

export function wetFragment(source: string): string {
  const replace = (from: string, to: string) => {
    if (!source.includes(from)) throw new Error(`Wet fragment contract changed: ${from}`);
    source = source.replace(from, to);
  };
  replace("uniform float4 uRipple;", "uniform float4 uRipple;\nuniform half4 uWetCurve;\nuniform float4 uRippleCell;");
  replace("    float3 vWorld : TEXCOORD0,", "    float4 vWetUv : TEXCOORD0,\n    half vWetFresnel : TEXCOORD2,");
  replace("vWorld.xz * uWet2.x", "vWetUv.xy");
  replace("half threshold = (half)0.71 - uWet.x * (half)0.25;", "half threshold = uWetCurve.z;");
  replace("* uEnvK.w * (half)step((half)0.001, uWet.x)", "* uWetCurve.w");
  replace("lerp((half)1.0, uWet.y, uEnvK.w)", "uWetCurve.y");
  replace("lerp(uPbr.x, uPbr.x * uWet.z, uEnvK.w)", "uWetCurve.x");
  replace("float2 cell = float2(fmod(uRipple.x, 4.0), floor(uRipple.x * 0.25));", "float2 cell = uRippleCell.xy;");
  replace("frac(vWorld.xz * uRipple.w)", "frac(vWetUv.zw)");
  replace("    half facing = (half)saturate(normalize(uEye.xyz - vWorld).y);\n    half k = (half)1.0 - facing;\n    half fresnel = (half)0.04 + (half)0.96 * k * k * k * k;", "    half fresnel = vWetFresnel;");
  return source;
}

const wetBody = /#ifdef WET\n(    \/\/ Preserve the authored puddle field[\s\S]*?)\n#endif/;

/** Evaluate exactly the current display wet kernel into an RGBA8 response.
 * RGB is additive reflection; alpha multiplies the native-resolution diffuse.
 * The 1/3-size geometry target softens puddle/ripple detail, not mesh edges.
 * Clear (0,0,0,1), use depth testing/writes, and resolve with linear filtering. */
export function wetResponseFragment(source: string): string {
  source = wetFragment(source);
  const body = source.match(wetBody);
  if (!body) throw new Error("Wet response kernel contract changed");
  const darkening = "    c.rgb *= uWetCurve.y * lerp((half)1.0, (half)0.67, puddle);";
  const reflection = "    c.rgb += reflected * (fresnel * weight);";
  if (!body[1].includes(darkening) || !body[1].includes(reflection))
    throw new Error("Wet response decomposition contract changed");
  const kernel = body[1]
    .replace(darkening, "    half darkening = uWetCurve.y * lerp((half)1.0, (half)0.67, puddle);")
    .replace(reflection, "    return half4(reflected * (fresnel * weight), darkening);");
  // Retain the authoritative material coverage before the wet block. A wet
  // cutout must not hide another wet surface in the response depth target.
  // Without ALPHA_TEST, the compiler eliminates this unused base-color work.
  return source.slice(0, body.index!) + kernel + "\n}\n";
}

/** Native-resolution geometry still owns UV detail, emission, alpha discard,
 * fog and inverse eye depth. Only the separated wet kernel is reconstructed. */
export function wetResolveFragment(source: string): string {
  const uniforms = /#ifdef WET\nuniform sampler2D uPuddles;[\s\S]*?\n#endif/;
  if (!uniforms.test(source) || !wetBody.test(source))
    throw new Error("Wet resolve contract changed");
  return source
    .replace(uniforms, "#ifdef WET\nuniform sampler2D uWetResponse;\n#endif")
    .replace(wetBody, `#ifdef WET
    float2 wetUv = vScreen.xy / vScreen.w * float2(0.5, -0.5) + 0.5;
    half4 response = tex2D(uWetResponse, wetUv);
    c.rgb = c.rgb * response.a + response.rgb;
#endif`);
}
