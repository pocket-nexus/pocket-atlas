// Tokyo Tower (vita/shaders/tower_f.cg): additive lattice glow (legs, chords,
// X-bracing), decks and the blinking aviation light. The blend is ONE, ONE on
// colour, the destination's alpha kept.

@fragment
fn fs(in: Varyings) -> @location(0) vec4<f32> {
  let y = in.world.y;
  let fu = fract(in.uv.x * 4.0);
  let legs = (1.0 - smoothstep(0.0, 0.07, min(fu, 1.0 - fu)));
  let t = fract(y / 22.0);
  let chord = (1.0 - smoothstep(0.0, 0.05, min(t, 1.0 - t)));
  let diag = (1.0 - smoothstep(0.0, 0.045, min(abs(fu - t), abs(fu - (1.0 - t)))));
  let lattice = max(max(legs, chord * 0.8), diag * 0.6);
  let orange = vec3<f32>(1.0, 0.38, 0.1);
  let white = vec3<f32>(1.0, 0.92, 0.82);
  var col = mix(orange, white, smoothstep(215.0, 262.0, y) * 0.6) * lattice * 1.6;
  col += orange * 0.12;
  col += white * 3.0 * ((1.0 - smoothstep(0.0, 4.0, abs(y - 150.0))) + (1.0 - smoothstep(0.0, 2.5, abs(y - 250.0))));
  col += vec3<f32>(1.0, 0.05, 0.02) * 30.0 * (1.0 - smoothstep(0.0, 3.0, abs(y - 330.0))) * step(0.5, fract(pass_.eye.w * 0.5));
  let fog = 1.0 - exp(-length(in.world.xz) * 0.00045);
  return vec4<f32>(col * (1.0 - fog * 0.6), 0.0);
}
