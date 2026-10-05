// Distant skyline boxes with procedural window grids (vita/shaders/skyline_f.cg);
// vertex colour holds four per-box random values, the tangent is the facade's
// horizontal axis.
//
// Defines: REFLECTION.

@fragment
fn fs(in: Varyings) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let info = in.color;
  var col = vec3<f32>(0.018, 0.019, 0.024) * (0.6 + info.y * 0.8);
  if (abs(n.y) < 0.5) {
    let u = dot(in.world, in.tangent.xyz);
    let v = in.world.y;
    let fw = 1.8 + info.z * 1.2;
    let g = vec2<f32>(u / fw, v / 3.3);
    let cell = floor(g);
    let f = g - cell;
    let win = step(0.28, f.x) * step(f.x, 0.72) * step(0.35, f.y) * step(f.y, 0.75);
    let r = hash12(cell + info.w * 113.0);
    let lit = step(1.0 - (0.08 + info.x * 0.22), r);
    let wc = mix(vec3<f32>(1.0, 0.72, 0.42), vec3<f32>(0.7, 0.85, 1.0), step(0.6, hash12(cell * 1.7 + 5.0))) * (0.4 + 0.6 * hash12(cell + 3.3));
    col += wc * win * lit * 0.8;
    if (info.z > 0.8) {
      col += vec3<f32>(0.7, 0.85, 1.0) * 0.12 * step(0.4, f.y) * step(f.y, 0.75) * step(0.7, hash12(vec2<f32>(cell.y, info.w)));
    }
  }
  let dist = length(in.world - pass_.eye.xyz);
  let fog = 1.0 - exp(-dist * 0.0032);
  let height_fade = exp(-max(in.world.y, 0.0) * 0.004);
  col = mix(col, pass_.skyline.rgb, clamp(fog * mix(0.75, 1.0, height_fade), 0.0, 0.97));
  return finish(col, 1.0, dist);
}
