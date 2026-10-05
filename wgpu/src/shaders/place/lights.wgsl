// Light field (vita/shaders/lights_v.cg, lights_f.cg; web
// places/shared/lights.ts): one record per light. The PS Vita draws each as
// a point sprite; WebGPU has no point size, so a light is an instance of a
// square of two triangles the same number of pixels wide. At distance d the
// light's physical diameter is D = radius H / (d tan(fovY/2)) render pixels;
// the sprite is S = clamp(D, min, max) pixels and keeps the light's energy,
// (D / S)^2 while D < S. Value: colour x intensity x gain x (D / S)^2 x
// twinkle x blink, x the vista haze's T; moving lights travel their path once
// per cycle. The sprite's depth moves toward the eye by clamp(pull d, 0.002,
// 0.5) of the distance, its screen position unchanged.
//
// Defines: VISTA (the haze's transmittance).

struct Light {
  @location(0) position: vec4<i32>, // s16n xyz, phase in w, as integers (common.wgsl)
  @location(1) color: vec4<f32>,    // sRGB colour, twinkle
  @location(2) light: vec2<f32>,    // intensity, radius (m)
  @location(3) path: vec4<f32>,     // travel per cycle (m), cycles per period
  @location(4) blink: vec4<u32>,    // blink cycles per period, duty x 255
}

struct Sprite {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) coord: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) index: u32, l: Light) -> Sprite {
  let corner = vec2<f32>(f32(index & 1u), f32(index >> 1u));
  let position = s16n4(l.position);
  let phase = position.w;
  var p = position.xyz * draw.dequant[0].xyz + draw.dequant[1].xyz;
  p += l.path.xyz * fract(phase + l.path.w * draw.field_t.x);
  let eye = pass_.eye.xyz;
  let d = max(length(p - eye), 0.01);
  let D = l.light.y * pass_.refl.z / d;
  let S = clamp(D, draw.field.x, draw.field.y);
  let k = min(D / S, 1.0);
  // Scintillation grows over the first 8 km of air.
  let twinkle = 1.0 + l.color.a * min(d * (1.0 / 8000.0), 1.0) * 0.35 * sin(phase * (6.2831853 * 13.7) + draw.field_t.y);
  let on = 1.0 - step(f32(l.blink.y) * (1.0 / 255.0), fract(phase + f32(l.blink.x) * draw.field_t.x));
  var c = srgb_to_linear(l.color.rgb) * (l.light.x * draw.field.z * k * k * twinkle * on);
#ifdef VISTA
  c *= vista_transmittance(p, d).t;
#endif
  let pull = clamp(draw.field_t.z * d, 0.002, 0.5);
  let centre = pass_.view_proj * vec4<f32>(eye + (p - eye) * (1.0 - pull), 1.0);
  var out: Sprite;
  // S pixels across, whatever the depth: the corner's offset in clip space.
  out.position = vec4<f32>(centre.xy + (corner * 2.0 - 1.0) * S * pass_.viewport.zw * centre.w, centre.zw);
  out.color = c;
  out.coord = corner;
  return out;
}

// The light's value over a (1 - r^2)^2 profile (r = 0 at the centre, 1 at the
// sprite's edge), added to the scene; the blend keeps the destination's alpha.
@fragment
fn fs(in: Sprite) -> @location(0) vec4<f32> {
  let q = in.coord * 2.0 - 1.0;
  let f = saturate(1.0 - dot(q, q));
  return vec4<f32>(in.color * (f * f), 0.0);
}
