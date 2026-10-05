// A caster in the sun's map (vita/shaders/shadow_f.cg): depth alone, from the
// orthographic light volume. A cut-out keeps its discard (leaves, wire mesh,
// railings).

@fragment
fn fs(in: Varyings) {
  if (textureSampleLevel(t_albedo, s_albedo, in.uv, 0.0).a * draw.base.a < draw.emissive.w) {
    discard;
  }
}
