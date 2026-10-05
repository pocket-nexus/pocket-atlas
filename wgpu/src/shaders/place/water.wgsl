// Open water (vita/shaders/water_f.cg): two layers of the wave normal map
// (coordinates on the world's x/z plane from the vertex stage), the
// environment reflected by Fresnel, the sun's highlight and the light the
// body scatters back. The waves flatten with distance and their slope goes
// into the roughness, so far water shows the sun as a glitter path.
//
// Defines: SUN, FOG, VISTA, SHALLOW (vertex colour red blends the body
// colour toward the shallow colour over a sandy bottom).

@fragment
fn fs(in: Varyings) -> @location(0) vec4<f32> {
  let n1 = textureSample(t_normal, s_normal, in.uv).rg * 2.0 - 1.0;
  let n2 = textureSample(t_normal, s_normal, in.uv2).rg * 2.0 - 1.0;
  let to_eye = pass_.eye.xyz - in.world;
  let dist = length(to_eye);
  let V = to_eye / dist;
  let a2 = draw.pbr.x * draw.pbr.x + dist * draw.water_k.w;
  let calm = 1.0 / (1.0 + dist * draw.water_k.w * 40.0);
  var slope = (n1 + n2) * (draw.pbr.z * calm);
  // The faces toward the eye: the wave backs hide at grazing views.
  slope += V.xz * (draw.pbr.y / max(length(V.xz), 1e-4));
  let N = normalize(vec3<f32>(slope.x, 1.0, slope.y));
  let dot_nv = max(dot(N, V), 1e-3);
  let F = 0.02 + 0.98 * exp2((-5.55473 * dot_nv - 6.98316) * dot_nv);
  var R = reflect(-V, N);
  R.y = abs(R.y);
  let sky = env(R, 0.0) * draw.env_k.x;
#ifdef SHALLOW
  let w = saturate(srgb_to_linear(in.color.rgb).r);
  let body = mix(draw.water_k.rgb, draw.water_shallow.rgb, w) * pass_.hemi_sky.rgb;
#else
  let body = draw.water_k.rgb * pass_.hemi_sky.rgb;
#endif
  var color = mix(body, sky, F);
#ifdef SUN
  {
    let L = pass_.sun_dir.xyz;
    let H = normalize(L + V);
    let dot_nl = saturate(dot(N, L));
    let dot_nh = saturate(dot(N, H));
    let dot_vh = saturate(dot(V, H));
    let alpha = sqrt(a2);
    let Fs = 0.02 + 0.98 * exp2((-5.55473 * dot_vh - 6.98316) * dot_vh);
    color += pass_.sun_rad.rgb * (dot_nl * Fs * v_ggx(alpha, dot_nl, dot_nv) * d_ggx(alpha, dot_nh));
  }
#endif
  return finish(hazed(color, in.haze, dist), 1.0, dist);
}
