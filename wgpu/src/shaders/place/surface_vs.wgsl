// Vertex stage for every mesh material (vita/shaders/surface_v.cg).
// Positions arrive quantised (s16n) and are dequantised by the draw's
// constants; `model` carries the node transform of a rigid moving part.
// Skinned vertices blend up to four bone rows. Baked vertices carry the
// static diffuse lighting as square-root RGBM.
//
// Defines: SKINNED, BAKED (the vertex layout), WAVES (water: the two UV sets
// are the world's x/z plane in two wave layers), VISTA, SUN.

struct Vertex {
  @location(0) position: vec4<i32>, // s16n, as integers (common.wgsl)
  @location(1) normal: vec4<f32>,
  @location(2) tangent: vec4<f32>,
  @location(3) uv: vec2<i32>,       // s16n
  @location(4) color: vec4<f32>,
#ifdef SKINNED
  @location(5) joints: vec4<u32>,
  @location(6) weights: vec4<f32>,
#endif
#ifdef BAKED
  @location(5) light: vec4<f32>,
#endif
}

@vertex
fn vs(v: Vertex) -> Varyings {
  var out: Varyings;
  var local = vec4<f32>(s16n4(v.position).xyz * draw.dequant[0].xyz + draw.dequant[1].xyz, 1.0);
  var n = v.normal.xyz;
  var t = v.tangent.xyz;
#ifdef SKINNED
  var sp = vec3<f32>(0.0);
  var sn = vec3<f32>(0.0);
  var st = vec3<f32>(0.0);
  for (var k = 0; k < 4; k++) {
    let j = i32(v.joints[k]) * 3;
    let w = v.weights[k];
    let r0 = bones.rows[j];
    let r1 = bones.rows[j + 1];
    let r2 = bones.rows[j + 2];
    sp += w * vec3<f32>(dot(r0, local), dot(r1, local), dot(r2, local));
    sn += w * vec3<f32>(dot(r0.xyz, n), dot(r1.xyz, n), dot(r2.xyz, n));
    st += w * vec3<f32>(dot(r0.xyz, t), dot(r1.xyz, t), dot(r2.xyz, t));
  }
  local = vec4<f32>(sp, 1.0);
  n = sn;
  t = st;
#endif
  let world = vec3<f32>(dot(draw.model[0], local), dot(draw.model[1], local), dot(draw.model[2], local));
  n = normalize(vec3<f32>(dot(draw.model[0].xyz, n), dot(draw.model[1].xyz, n), dot(draw.model[2].xyz, n)));
  t = vec3<f32>(dot(draw.model[0].xyz, t), dot(draw.model[1].xyz, t), dot(draw.model[2].xyz, t));
  let clip = pass_.view_proj * vec4<f32>(world, 1.0);
  out.position = clip;
  out.world = world;
  out.normal = n;
  out.tangent = vec4<f32>(normalize(t + vec3<f32>(1e-12, 0.0, 0.0)), v.tangent.w);
  out.screen = clip;
  out.color = v.color;
  out.light = vec3<f32>(0.0);
  out.shadow = vec3<f32>(0.0);
  out.haze = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  out.uv2 = vec2<f32>(0.0);
#ifdef SUN
  // The sun projection is affine: its result is interpolated.
  let shadow_world = vec4<f32>(world + n * pass_.sun_rad.w, 1.0);
  out.shadow = vec3<f32>(dot(pass_.sun_mat0, shadow_world), dot(pass_.sun_mat1, shadow_world), (-dot(pass_.sun_dir.xyz, shadow_world.xyz) - pass_.shadow_k.x) * pass_.shadow_k.y);
#endif
#ifdef WAVES
  out.uv = world.xz * draw.wave[0].x + draw.wave[0].zw;
  out.uv2 = world.xz * draw.wave[1].x + draw.wave[1].zw;
#else
  out.uv = s16n2(v.uv) * draw.uv.xy + draw.uv.zw;
#endif
#ifdef VISTA
  out.haze = vista_haze(world, pass_.eye.xyz);
#endif
#ifdef BAKED
  let s = v.light.rgb * v.light.a;
  out.light = s * s * 64.0;
#endif
  return out;
}
