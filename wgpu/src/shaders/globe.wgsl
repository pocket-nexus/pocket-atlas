// The atlas screen's globe: the programs of ipod/src/globe.c, in WGSL.
//
// The sphere is a unit sphere turned by `turn` and laid on the screen at
// `place` (centre and radii in normalized device coordinates): no camera, no
// perspective. Its surface holds the daylight albedo, with the city lights in
// the alpha channel. The halo is a square behind it; the pins are squares of
// a few logical pixels over it, one instance each.

struct Globe {
  // The turn's three columns.
  turn0: vec4<f32>,
  turn1: vec4<f32>,
  turn2: vec4<f32>,
  // The centre (x, y) and the radii (x, y) on the screen.
  place: vec4<f32>,
  // One logical pixel (x, y).
  pixel: vec4<f32>,
}

@group(0) @binding(0) var<uniform> globe: Globe;
@group(0) @binding(1) var surface: texture_2d<f32>;
@group(0) @binding(2) var texels: sampler;

// ---------------------------------------------------------------- the sphere

struct Sphere {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) normal: vec3<f32>,
}

@vertex
fn sphere_vertex(@location(0) at: vec3<f32>, @location(1) uv: vec2<f32>) -> Sphere {
  var out: Sphere;
  let turn = mat3x3<f32>(globe.turn0.xyz, globe.turn1.xyz, globe.turn2.xyz);
  out.normal = turn * at;
  out.uv = uv;
  let p = globe.place.xy + out.normal.xy * globe.place.zw;
  // The near half in front of the far one: depth runs 0.25 (facing the eye) to 0.75.
  out.position = vec4<f32>(p, 0.5 - out.normal.z * 0.25, 1.0);
  return out;
}

@fragment
fn sphere_fragment(in: Sphere) -> @location(0) vec4<f32> {
  let t = textureSample(surface, texels, in.uv);
  let n = normalize(in.normal);
  // The sun stands behind the left shoulder: a lit limb, night across the face.
  let day = smoothstep(-0.05, 0.4, dot(n, vec3<f32>(-0.82, 0.30, -0.49)));
  let rim = pow(max(1.0 - n.z, 0.0), 3.0);
  let c = t.rgb * (vec3<f32>(0.07, 0.10, 0.16) + day * 1.15) + vec3<f32>(1.0, 0.72, 0.42) * t.a * (1.0 - day)
    + vec3<f32>(0.20, 0.42, 0.85) * rim * (0.35 + 0.65 * day);
  return vec4<f32>(c, 1.0);
}

// ---------------------------------------------------------------- the halo

struct Halo {
  @builtin(position) position: vec4<f32>,
  @location(0) at: vec2<f32>,
}

@vertex
fn halo_vertex(@location(0) corner: vec3<f32>) -> Halo {
  var out: Halo;
  out.at = corner.xy * 1.3;
  out.position = vec4<f32>(globe.place.xy + out.at * globe.place.zw, 0.95, 1.0);
  return out;
}

@fragment
fn halo_fragment(in: Halo) -> @location(0) vec4<f32> {
  let d = length(in.at);
  let a = exp(-(d - 1.0) * 14.0) * step(1.0, d) * (0.55 - 0.35 * in.at.x);
  return vec4<f32>(vec3<f32>(0.22, 0.46, 1.0) * a, 1.0);
}

// ---------------------------------------------------------------- the pins

struct Dot {
  @builtin(position) position: vec4<f32>,
  @location(0) colour: vec4<f32>,
  // The square's own coordinates, -1…1.
  @location(1) within: vec2<f32>,
}

@vertex
fn dot_vertex(@builtin(vertex_index) index: u32, @location(0) at: vec3<f32>, @location(1) colour: vec4<f32>) -> Dot {
  var out: Dot;
  out.within = vec2<f32>(f32(index & 1u), f32(index >> 1u)) * 2.0 - 1.0;
  out.colour = colour;
  // `at.z` is the pin's width in logical pixels.
  let p = globe.place.xy + at.xy * globe.place.zw + out.within * at.z * 0.5 * globe.pixel.xy;
  out.position = vec4<f32>(p, 0.05, 1.0);
  return out;
}

@fragment
fn dot_fragment(in: Dot) -> @location(0) vec4<f32> {
  let d = length(in.within);
  if (d > 1.0) {
    discard;
  }
  // A lit pin is a ring around its colour; the others are plain dots.
  let c = mix(in.colour.rgb, vec3<f32>(1.0), in.colour.a * step(0.62, d));
  return vec4<f32>(c * (1.0 - 0.5 * step(0.8, d) * (1.0 - in.colour.a)), 1.0);
}
