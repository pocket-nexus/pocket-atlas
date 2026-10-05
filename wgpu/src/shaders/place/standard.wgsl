// Lit surface (vita/shaders/standard_f.cg): three.js physical shading (Lambert
// + GGX, split-sum IBL from the octahedral environment), rain film, puddles
// with ripples and the planar street reflection, FogExp2.
//
// Defines: ALBEDO_MAP, NORMAL_MAP, ORM_MAP, EMISSION_MAP, VERTEX_COLOR,
// VERTEX_PBR (solid roughness/metalness in UV), ALPHA_TEST, BLEND, WET,
// PLANAR, DAMP, CLEARCOAT, INTERIOR, FOG, VISTA, REFLECTION (mirror pass:
// cheaper film, no planar lookup), BAKED (static diffuse lighting from the
// vertices; the draw's lights are then the moving ones), SUN (a directional
// light per pixel with the sun's shadow maps), SUN_SPEC (its highlight),
// MOVING_SHADOW (the place has a map of moving casters).
//
// The mirror pass lands in a half-resolution, blurred buffer: diffuse and
// emission are all that survive.
#ifdef REFLECTION
#undef NORMAL_MAP
#undef ORM_MAP
#undef DAMP
#undef CLEARCOAT
#undef WET
#undef PLANAR
#define NO_SPECULAR
#endif

#ifdef SUN
// Share of the sun that reaches a point: the four map texels around it
// compared and blended by the position between their centres, in both maps.
fn sun_lit(shadow: vec3<f32>) -> f32 {
  let uv = shadow.xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    return 1.0;
  }
  var lit = textureSampleCompareLevel(t_shadow, s_compare, uv, shadow.z - pass_.shadow_k.z);
#ifdef MOVING_SHADOW
  lit = min(lit, textureSampleCompareLevel(t_moving, s_compare, uv, shadow.z - pass_.moving_k.z));
#endif
  return lit;
}
#endif

// One frame of the ripple flipbook (4x4 atlas, frames laid out row-major).
fn ripple_frame(uv: vec2<f32>, frame: f32) -> vec2<f32> {
  let cell = vec2<f32>(frame % 4.0, floor(frame * 0.25));
  let local = clamp(fract(uv), vec2<f32>(0.004), vec2<f32>(0.996));
  return textureSampleLevel(t_ripples, s_repeat, (cell + local) * 0.25, 0.0).rg * 2.0 - 1.0;
}

@fragment
fn fs(in: Varyings) -> @location(0) vec4<f32> {
  // Every lookup that takes its level from the screen comes first.
  let bias = draw.counts.y;
#ifdef ALBEDO_MAP
  let albedo_texel = textureSampleBias(t_albedo, s_albedo, in.uv, bias);
#endif
#ifdef ORM_MAP
  let orm = textureSampleBias(t_orm, s_orm, in.uv, bias).rgb;
#endif
#ifdef NORMAL_MAP
  let normal_texel = textureSampleBias(t_normal, s_normal, in.uv, bias).rg;
#endif
#ifdef EMISSION_MAP
  let emission_texel = textureSampleBias(t_emission, s_emission, in.uv, bias).rgb;
#endif
#ifdef WET
  let pf = textureSample(t_puddles, s_repeat, in.world.xz * draw.wet2.x).rg;
#endif
#ifdef DAMP
  let lane_u = in.world.x + in.world.z;
  let lane = textureSample(t_puddles, s_repeat, vec2<f32>(lane_u * 1.75, in.world.y * 0.0875)).r;
  let lane2 = textureSample(t_puddles, s_repeat, vec2<f32>(lane_u * 4.75 + 0.75, in.world.y * 0.2 - pass_.eye.w * 0.0125)).g;
#endif

  let to_eye = pass_.eye.xyz - in.world;
  let dist = length(to_eye);
  let V = to_eye / dist;
  let Ng = normalize(in.normal);
  let rain = draw.env_k.w;

  // ------------------------------------------------------------ material
  var albedo = draw.base.rgb;
  var opacity = draw.base.a;
#ifdef ALBEDO_MAP
  albedo *= srgb_to_linear(albedo_texel.rgb);
  opacity *= albedo_texel.a;
#endif
#ifdef VERTEX_COLOR
  albedo *= srgb_to_linear(in.color.rgb);
  opacity *= in.color.a;
#endif
#ifdef ALPHA_TEST
  if (opacity < draw.emissive.w) {
    discard;
  }
#endif
  var roughness = draw.pbr.x;
  var metalness = draw.pbr.y;
#ifdef VERTEX_PBR
  // Solid-material batches carry each surface's constants through UVs.
  roughness = saturate(in.uv.x);
  metalness = saturate(in.uv.y);
#endif
#ifdef ORM_MAP
  roughness *= orm.g;
  metalness *= orm.b;
  let ao = (orm.r - 1.0) * draw.pbr.w + 1.0;
#else
  // Without the map the draw's constants are scaled by its means, and the
  // occlusion is in w.
  let ao = draw.pbr.w;
#endif

  var N = Ng;
#ifdef NORMAL_MAP
  {
    let nm = (normal_texel * 2.0 - 1.0) * draw.pbr.z;
    let nz = sqrt(saturate(1.0 - dot(nm, nm)));
    let T = normalize(in.tangent.xyz);
    let B = cross(Ng, T) * in.tangent.w;
    N = normalize(T * nm.x + B * nm.y + Ng * nz);
  }
#endif

  // ------------------------------------------------------------ rain film
#ifdef WET
  var puddle = 0.0;
  var wet_n = vec3<f32>(0.0, 1.0, 0.0);
  {
    let field = pf.r * 0.8 + pf.g * 0.2;
    let thr = 0.71 - draw.wet.x * 0.25;
    puddle = smoothstep(thr - 0.012, thr + 0.03, field) * rain * step(0.001, draw.wet.x);
    let damp = smoothstep(thr - 0.09, thr, field);
    albedo *= mix(1.0, draw.wet.y, rain) * mix(1.0, 0.82, damp * rain);
    albedo = mix(albedo, albedo * 0.45 + vec3<f32>(0.002, 0.0025, 0.003), puddle);
    var rip = vec2<f32>(0.0);
    if (puddle > 0.01) {
      rip = ripple_frame(in.world.xz * pass_.ripple.w, pass_.ripple.x) * 1.4 * rain;
    }
    let micro = (pf - 0.5) * 0.06;
    let ws = draw.wet.w;
    wet_n = normalize(vec3<f32>(-(rip.x * ws + micro.x), 1.0, -(rip.y * ws + micro.y)));
    roughness = mix(roughness, roughness * draw.wet.z, rain);
    roughness = mix(roughness, 0.02, puddle);
    N = normalize(mix(N, wet_n, puddle * 0.96));
  }
#endif
#ifdef DAMP
  {
    let streak = smoothstep(0.55, 0.85, lane) * (0.6 + 0.4 * lane2) * draw.wet2.w;
    albedo *= mix(1.0, draw.wet2.y, rain) * (1.0 - streak * 0.35 * rain);
    roughness = mix(roughness, roughness * draw.wet2.z, rain);
    roughness = mix(roughness, 0.12, streak * rain);
  }
#endif

  roughness = clamp(roughness, 0.0525, 1.0);
  let diffuse_color = albedo * (1.0 - metalness);
  let specular_color = mix(vec3<f32>(0.04), albedo, metalness);
  let dot_nv = saturate(dot(N, V));

  // ------------------------------------------------------------ direct
  var diffuse = vec3<f32>(0.0);
  var specular = vec3<f32>(0.0);
#ifndef INTERIOR
#ifdef BAKED
  {
    // Moving lights on baked surfaces (a passing car's headlights): points
    // and spots, Lambert and a Blinn-Phong lobe for the wet sheen.
    let e = min(2.0 / max(roughness * roughness * roughness * roughness, 0.001), 1024.0);
    let norm = (e + 8.0) * (1.0 / 25.13274);
    let count = i32(draw.counts.x);
    for (var i = 0; i < count; i++) {
      let Lv = draw.light_pos[i].xyz - in.world;
      let d2 = max(dot(Lv, Lv), 0.01);
      let il = inverseSqrt(d2);
      let L = Lv * il;
      let s = saturate(dot(-L, draw.light_dir[i].xyz) * draw.light_dir[i].w + draw.light_col[i].w);
      let x = d2 * draw.light_pos[i].w * draw.light_pos[i].w;
      let wr = saturate(1.0 - x * x);
      let E = draw.light_col[i].rgb * (wr * wr * s * s * (3.0 - 2.0 * s) * il * il * saturate(dot(N, L)));
      let nh = saturate(dot(N, normalize(L + V)));
      diffuse += E * diffuse_color * INV_PI;
      // nh^e as exp2(e log2 nh), with log nh about nh - 1 near the peak.
      specular += E * specular_color * (norm * exp2(e * 1.4427 * (nh - 1.0)));
    }
  }
#else
  {
    let lit = lights_ggx(in.world, N, V, diffuse_color, specular_color, roughness * roughness);
    diffuse = lit.diffuse;
    specular = lit.specular;
  }
#endif
#endif

#ifdef SUN
  {
    let L = pass_.sun_dir.xyz;
    let ndl = saturate(dot(N, L));
    // Both Lambert and GGX are multiplied by ndl: back-facing surfaces need
    // neither shadow lookup.
    if (ndl > 0.0) {
      let lit = sun_lit(in.shadow);
      let E = pass_.sun_rad.rgb * (lit * ndl);
      diffuse += E * INV_PI * diffuse_color;
#ifdef SUN_SPEC
#ifndef NO_SPECULAR
      var shines = lit > 0.0;
#ifdef VERTEX_PBR
      shines = shines && (roughness < 0.6 || metalness > 0.3);
#endif
      if (shines) {
        let H = normalize(L + V);
        let alpha = roughness * roughness;
        specular += E * f_schlick(specular_color, saturate(dot(V, H))) * (v_ggx(alpha, ndl, dot_nv) * d_ggx(alpha, saturate(dot(N, H))));
      }
#endif
#endif
    }
  }
#endif

  // ------------------------------------------------------------ indirect
  let env_k = draw.env_k.x;
#ifdef BAKED
  // Static lights, hemisphere and environment diffuse, already over pi.
  let irradiance = in.light;
#else
  let irradiance = mix(pass_.hemi_ground.rgb, pass_.hemi_sky.rgb, N.y * 0.5 + 0.5) * INV_PI + env(N, 5.0) * env_k;
#endif
#ifdef NO_SPECULAR
  var color = diffuse + irradiance * diffuse_color * ao;
#else
  var radiance = env(reflect(-V, N), roughness * 5.0) * env_k;
#ifdef PLANAR
  {
    var ruv = in.screen.xy / in.screen.w * vec2<f32>(0.5, -0.5) + 0.5;
    let n_w = normalize(mix(vec3<f32>(0.0, 1.0, 0.0), wet_n, max(puddle, 0.35)));
    ruv += n_w.xz * vec2<f32>(0.05, 0.09);
    // One tap: the sharp mirror for puddles and polished surfaces, its
    // blurred copy for rough wet asphalt.
    let sharp = textureSampleLevel(t_refl_sharp, s_clamp, ruv, 0.0).rgb;
    let blurred = textureSampleLevel(t_refl_blur, s_clamp, ruv, 0.0).rgb;
    let refl = select(blurred, sharp, roughness < 0.15);
    let e2 = saturate(min(ruv, 1.0 - ruv) * 33.3);
    let w = pass_.refl.x * (1.0 - smoothstep(0.5, 0.8, roughness)) * mix(0.35, 1.0, e2.x * e2.y);
    radiance = mix(radiance, refl, w);
  }
#endif
  let dfg = dfg_approx(roughness, dot_nv);
  let spec_env = specular_color * dfg.x + dfg.y;
  var color = diffuse + specular + irradiance * diffuse_color * ao + radiance * spec_env * ao;
#endif

#ifdef CLEARCOAT
  {
    let fc = f_schlick(vec3<f32>(0.04), dot_nv).x * draw.env_k.y;
    let cc = env(reflect(-V, Ng), draw.env_k.z * 5.0) * env_k;
    color = color * (1.0 - fc) + cc * fc;
  }
#endif

  var emission = draw.emissive.rgb;
#ifdef EMISSION_MAP
  emission *= srgb_to_linear(emission_texel);
#endif
  color += emission;
#ifndef INTERIOR
  color = hazed(color, in.haze, dist);
#endif
  return finish(color, opacity, dist);
}
