// The static sun map from its samples. The casters are drawn with four
// samples a texel, and a texel of the map takes the nearest of the four
// depths: a caster narrower than a texel (a wire, a railing's bar) that
// covers any sample is in the map, where one sample a texel leaves its
// shadow a row of dots.

@group(0) @binding(0) var t_samples: texture_depth_multisampled_2d;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) at: vec4<f32>) -> @builtin(frag_depth) f32 {
  let texel = vec2<i32>(at.xy);
  var depth = textureLoad(t_samples, texel, 0);
  for (var i = 1; i < 4; i++) {
    depth = min(depth, textureLoad(t_samples, texel, i));
  }
  return depth;
}
