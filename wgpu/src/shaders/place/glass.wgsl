// Storefront glass, premultiplied (vita/shaders/glass_f.cg): specular (lights
// and environment) at full strength, tint scaled by coverage, rain beads and
// running drops bending the normal. The blend is ONE, ONE_MINUS_SRC_ALPHA on
// colour; the destination's alpha (eye distance) is kept.
//
// Defines: FOG, VISTA, REFLECTION, BAKED.

@fragment
fn fs(in: Varyings) -> @location(0) vec4<f32> {
  let to_eye = pass_.eye.xyz - in.world;
  let dist = length(to_eye);
  let V = to_eye / dist;
  var N = normalize(in.normal);
  if (dot(N, V) < 0.0) {
    N = -N;
  }

  var drop = 0.0;
#ifndef REFLECTION
  {
    let x_facing = abs(N.x) > abs(N.z);
    let guv = select(in.world.xy, in.world.zy, x_facing);
    let b = textureSample(t_beads, s_repeat, guv).rgb;
    let beads = vec3<f32>((b.xy - 0.5) * 4.0, b.z);
    // Running drops: the bead pattern stretched and scrolled down.
    let r = textureSample(t_beads, s_repeat, guv * vec2<f32>(1.3, 0.35) + vec2<f32>(0.0, pass_.eye.w * 0.09)).rgb;
    let runs = vec3<f32>((r.xy - 0.5) * 2.5, r.z * 0.6);
    let all = (beads + runs) * (draw.env_k.w * draw.env_k.y);
    drop = saturate(all.z);
    let t_u = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), x_facing);
    N = normalize(N + (t_u * all.x + vec3<f32>(0.0, 1.0, 0.0) * all.y) * 0.9);
  }
#endif

  let roughness = max(draw.pbr.x, 0.0525);
  let diffuse_color = draw.base.rgb;
  let specular_color = vec3<f32>(0.04);
  let lit = lights_ggx(in.world, N, V, diffuse_color, specular_color, roughness * roughness);
  let dot_nv = saturate(dot(N, V));
#ifdef BAKED
  let irradiance = in.light;
#else
  let irradiance = mix(pass_.hemi_ground.rgb, pass_.hemi_sky.rgb, N.y * 0.5 + 0.5) * INV_PI + env(N, 5.0) * draw.env_k.x;
#endif
  let radiance = env(reflect(-V, N), roughness * 5.0) * draw.env_k.x;
  let dfg = dfg_approx(roughness, dot_nv);
  let spec = lit.specular + radiance * (specular_color * dfg.x + dfg.y);
  let diff = lit.diffuse + irradiance * diffuse_color;

  let cover = saturate(draw.base.a + drop * 0.12);
  var color = diff * cover + spec * (1.0 + drop * 0.6);
#ifdef VISTA
  color = color * in.haze.a + in.haze.rgb * cover;
#else
#ifdef FOG
  color = mix(color, pass_.fog.rgb * cover, fog_factor(dist, pass_.fog.w));
#endif
#endif
  return vec4<f32>(color, cover);
}
