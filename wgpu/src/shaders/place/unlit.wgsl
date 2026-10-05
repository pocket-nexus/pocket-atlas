// HDR colour x texture x vertex colour, no lighting: signs, screens, lamps
// (vita/shaders/unlit_f.cg).
//
// Defines: ALBEDO_MAP, VERTEX_COLOR, FOG, VISTA, ALPHA_TEST, BLEND, REFLECTION.

@fragment
fn fs(in: Varyings) -> @location(0) vec4<f32> {
  var c = draw.base;
#ifdef ALBEDO_MAP
  let t = textureSampleBias(t_albedo, s_albedo, in.uv, draw.counts.y);
  c *= vec4<f32>(srgb_to_linear(t.rgb), t.a);
#endif
#ifdef VERTEX_COLOR
  c *= vec4<f32>(srgb_to_linear(in.color.rgb), in.color.a);
#endif
#ifdef ALPHA_TEST
  if (c.a < draw.emissive.w) {
    discard;
  }
#endif
  let dist = length(pass_.eye.xyz - in.world);
  return finish(hazed(c.rgb, in.haze, dist), c.a, dist);
}
