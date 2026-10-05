// Shelf stock under the shop's even LED light (vita/shaders/products_f.cg):
// the instance colour seeds a design from the packaging atlas; alpha of the
// vertex colour is the item-local height.
//
// Defines: REFLECTION.

fn p_hash(n: f32) -> f32 {
  return fract(sin(n * 12.9898) * 43758.5453);
}

@fragment
fn fs(in: Varyings) -> @location(0) vec4<f32> {
  let c = srgb_to_linear(in.color.rgb);
  let run_seed = dot(c, vec3<f32>(12.9898, 78.233, 37.719));
  let h1 = p_hash(run_seed * 0.37 + 1.0);
  let h2 = p_hash(run_seed * 0.71 + 7.0);
  let y = in.color.a;
  let band = floor(h2 * 8.0);
  let puv = vec2<f32>(h1 * 0.93 + fract(in.uv.x) * 0.055, (band + 0.08 + saturate(in.uv.y) * 0.8) / 8.0);
  // (the band and the design change from one item to the next: the level is fixed)
  let pack = srgb_to_linear(textureSampleLevel(t_albedo, s_albedo, puv, 0.0).rgb);
  let side = step(0.004, y) * step(y, 0.996);
  var col = draw.base.rgb * c;
  col = mix(col, pack * 1.15, 0.85 * side * (0.75 + 0.25 * h1));
  col *= (0.78 + 0.22 * saturate(y)) * draw.base.a;
  return finish(col, 1.0, length(pass_.eye.xyz - in.world));
}
