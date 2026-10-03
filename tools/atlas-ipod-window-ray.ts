/** Optional SGX window adapter. Requires the independently validated
 * window_ray_params recipe, in addition to window_vertex_params. Apply after
 * the parameter adapter. Pipelines select it only for the independent recipe.
 *
 * With one normal/tangent frame over a triangle, perspective interpolation
 * commutes with both basis projection and reflection. Keep the ray unnormalised
 * until the fragment, including the original unit-ray z and xy clamps there.
 * The reflected world vector retains world distance (up to float rounding),
 * even when the tangent and normal are not orthogonal. Do not substitute the
 * tangent-ray length: that would change distance/Fresnel for a skew frame.
 *
 * This removes fragment basis construction and four varying components. It
 * does not bake rooms, change coverage, or replace any spatial room lighting.
 * Normal/tangent use the original half stage boundary, then float normalise;
 * changing the interpolation order is not a bit-identical GPU claim.
 */
function replace(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`Window ray contract changed: ${from}`);
  return source.replace(from, to);
}

export function windowRayVertex(source: string): string {
  if (!source.includes("out float4 oRoomA : COLOR0,"))
    throw new Error("Window ray requires the proved window parameter adapter");
  source = replace(source, "    out half3 oNormal : TEXCOORD1,\n", "");
  source = replace(source, "    out half4 oTangent : TEXCOORD2,\n", "");
  source = replace(source, "    out float3 oWorld : TEXCOORD0)",
    "    out float3 oWindowRay : TEXCOORD0,\n    out float3 oWindowReflect : TEXCOORD1)");
  source = replace(source, "    oNormal = (half3)normalize(n);\n", "");
  source = replace(source, "    oTangent = half4((half3)normalize(t), (half)aTangent.w);\n", "");
  return replace(source, "    oWorld = world;", `    // Recreate the original half normal/tangent transport before the float
    // fragment normalisation. Only the independent flat-frame proof allows
    // these operations to be moved ahead of perspective interpolation.
    half3 windowNormal = (half3)normalize(n);
    half4 windowTangent = half4((half3)normalize(t), (half)aTangent.w);
    float3 windowN = normalize((float3)windowNormal);
    float3 windowT = normalize((float3)windowTangent.xyz);
    float3 windowB = cross(windowN, windowT) * windowTangent.w;
    float3 windowIncident = world - uEye.xyz;
    oWindowRay = float3(dot(windowIncident, windowT),
        dot(windowIncident, windowB), -dot(windowIncident, windowN));
    oWindowReflect = reflect(windowIncident, windowN);`);
}

export function windowRayFragment(source: string): string {
  if (!source.includes("    float4 vRoomA : COLOR0,"))
    throw new Error("Window ray requires the proved window parameter adapter");
  source = replace(source, "uniform float4 uEye;\n", "");
  source = replace(source, `    float3 vWorld : TEXCOORD0,
    half3 vNormal : TEXCOORD1,
    half4 vTangent : TEXCOORD2,`, `    float3 vWindowRay : TEXCOORD0,
    float3 vWindowReflect : TEXCOORD1,`);
  source = replace(source, `    float3 toEye = uEye.xyz - vWorld;
    float dist = length(toEye);
    float3 V = -toEye / dist;
    float3 n = normalize((float3)vNormal);
    float3 t = normalize((float3)vTangent.xyz);
    float3 b = cross(n, t) * vTangent.w;`, `    float dist = length(vWindowReflect);`);
  source = replace(source,
    "float3 d = normalize(float3(dot(V, t), dot(V, b), -dot(V, n)));",
    "float3 d = normalize(vWindowRay);");
  source = replace(source, `    float3 N = n;
    float dotNV = saturate(dot(N, -V));`, `    float dotNV = saturate(vWindowRay.z / dist);`);
  return replace(source, "octUv(reflect(V, N))", "octUv(vWindowReflect)");
}
