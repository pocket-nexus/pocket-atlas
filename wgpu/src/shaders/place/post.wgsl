// The passes over the whole screen after the scene (vita/shaders/post_v.cg and
// haze_f, prefilter_f, down_f, up_f, composite_f): lit haze, the bloom chain
// and the final frame.
//
// Defines (one of): LIT_HAZE, PREFILTER, DOWN, UP, COMPOSITE; with PREFILTER:
// PER_PIXEL, HAZE; with COMPOSITE: HAZE, BLOOM.

struct Post {
  ray_x: vec4<f32>,
  ray_y: vec4<f32>,
  ray_z: vec4<f32>,
  eye: vec4<f32>,   // camera position, time (s)
  k0: vec4<f32>,
  k1: vec4<f32>,
  k2: vec4<f32>,
  k3: vec4<f32>,
  k4: vec4<f32>,
  fog_pos: array<vec4<f32>, 6>, // position, radius
  fog_col: array<vec4<f32>, 6>, // colour x gain, cos outer (< -1.5: omni)
  fog_dir: array<vec4<f32>, 6>, // spot direction, cos inner
}

@group(0) @binding(0) var<uniform> post: Post;
@group(0) @binding(1) var t_a: texture_2d<f32>;
@group(0) @binding(2) var t_b: texture_2d<f32>;
@group(0) @binding(3) var t_c: texture_2d<f32>;
@group(0) @binding(4) var t_d: texture_2d<f32>;
@group(0) @binding(5) var t_e: texture_2d<f32>;
@group(0) @binding(6) var s_linear: sampler;
@group(0) @binding(7) var s_point: sampler;
@group(0) @binding(8) var s_tile: sampler;

struct PostOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) ray: vec3<f32>,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> PostOut {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u)) * 2.0 - 1.0;
  var out: PostOut;
  out.position = vec4<f32>(p, 0.5, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  out.ray = post.ray_z.xyz + post.ray_x.xyz * p.x + post.ray_y.xyz * p.y;
  return out;
}

const LUMA: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

#ifdef LIT_HAZE
// Single scattering from point and spot lights in homogeneous rain haze,
// integrated in closed form along each view ray up to the scene distance
// (the integral of dt / (d^2 + r^2) is atan terms). The dry shop interior is
// cut out of the ray. The far rain curtain (streak columns on a 16 m cylinder
// around the camera) is added where the ray meets it in front of the scene.
// t_a: the scene, alpha = eye distance (point sampled). k0: density, ambient
// density, -, far. k1: ambient in-scatter colour. k2, k3: the dry box. k4:
// rain curtain colour, opacity (0: off).

fn c_hash(p: vec2<f32>) -> f32 {
  var p3 = fract(p.xyx * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn atan2_fast(y: f32, x: f32) -> f32 {
  let ax = abs(x);
  let ay = abs(y);
  let a = min(ax, ay) / max(max(ax, ay), 1e-6);
  var r = a * (0.7853982 - (a - 1.0) * (0.2447 + 0.0663 * a));
  r = select(r, 1.5707963 - r, ay > ax);
  r = select(r, 3.1415927 - r, x < 0.0);
  return select(r, -r, y < 0.0);
}

fn curtain_layer(uv: vec2<f32>, speed: f32, cols: f32) -> f32 {
  let col = floor(uv.x * cols);
  let h = c_hash(vec2<f32>(col, 1.0));
  let s = uv.y * 0.6 + post.eye.w * speed * (0.8 + 0.4 * h) + h * 11.0;
  let y = fract(s);
  let streak = smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.1, 0.35, y));
  let xw = abs(fract(uv.x * cols) - 0.5);
  return streak * (1.0 - smoothstep(0.0, 0.22, xw)) * step(0.55, c_hash(vec2<f32>(col, floor(s))));
}

// atan on the whole line, max error 0.0015 rad.
fn atan_fast(x: f32) -> f32 {
  let a = abs(x);
  let z = select(a, 1.0 / a, a > 1.0);
  var r = z * (0.7853982 - (z - 1.0) * (0.2447 + 0.0663 * z));
  r = select(r, 1.5707963 - r, a > 1.0);
  return select(r, -r, x < 0.0);
}

// The integral of dt / (t^2 + 1) from b to a: atan(a) - atan(b) as one atan,
// plus pi when the interval wraps past the closest point.
fn arc(b: f32, a: f32) -> f32 {
  let k = 1.0 + a * b;
  return atan_fast((a - b) / k) + select(0.0, 3.1415927, k < 0.0);
}

@fragment
fn fs(in: PostOut) -> @location(0) vec4<f32> {
  let dist = min(textureSampleLevel(t_a, s_point, in.uv, 0.0).a, post.k0.w);
  let rd = normalize(in.ray);
  let ro = post.eye.xyz;
  let inv = 1.0 / rd;
  let a = (post.k2.xyz - ro) * inv;
  let b = (post.k3.xyz - ro) * inv;
  let lo = min(a, b);
  let hi = max(a, b);
  let bx = max(max(lo.x, lo.y), lo.z);
  let by = min(min(hi.x, hi.y), hi.z);
  let in0 = max(bx, 0.0);
  let in1 = min(by, dist);
  let cut = by > bx && in1 > in0;
  var acc = vec3<f32>(0.0);
  for (var i = 0; i < 6; i++) {
    // Closest approach of the ray to the light (softened by its radius); the
    // interval ends are measured from there in units of that distance.
    let L = post.fog_pos[i].xyz - ro;
    let tca = dot(L, rd);
    let r = post.fog_pos[i].w;
    let ih = inverseSqrt(max(dot(L, L) - tca * tca, 0.0) + r * r);
    let t0 = -tca * ih;
    let t1 = (dist - tca) * ih;
    var I = arc(t0, t1);
    if (cut) {
      I = arc(t0, (in0 - tca) * ih) + arc((in1 - tca) * ih, t1);
    }
    I *= ih;
    if (post.fog_col[i].w > -1.5) {
      let P = ro + rd * clamp(tca, 0.0, dist);
      let cs = dot(normalize(P - post.fog_pos[i].xyz), post.fog_dir[i].xyz);
      I *= smoothstep(post.fog_col[i].w, post.fog_dir[i].w, cs);
    }
    acc += post.fog_col[i].rgb * I;
  }
  let outside = select(dist, dist - (in1 - in0), cut);
  let amb = 1.0 - exp(-outside * post.k0.y);
  var col = acc * post.k0.x + post.k1.rgb * amb;

  let tc = 16.0 / max(length(rd.xz), 1e-3);
  let cy = ro.y + rd.y * tc;
  if (post.k4.w > 0.0 && tc < dist && cy > -2.0 && cy < 24.0) {
    let uv = vec2<f32>(atan2_fast(rd.z, rd.x) * 6.0, cy * 0.35);
    let r = curtain_layer(uv, 1.6, 30.0) + curtain_layer(uv * 1.7 + 3.0, 2.1, 30.0) * 0.7;
    let fade_y = smoothstep(-1.0, 3.0, cy) * (1.0 - smoothstep(12.0, 22.0, cy));
    col += post.k4.rgb * (r * post.k4.w * fade_y);
  }
  return vec4<f32>(col, dist);
}
#endif

#ifdef PREFILTER
// Bloom input: 4 bilinear taps (a 4x4 box) of the scene plus optional haze,
// Karis-weighted against fireflies, soft luminance threshold. PER_PIXEL
// (places with light fields): the threshold on each scene pixel of the block
// under the output pixel, no Karis weights: a light a few pixels wide keeps
// its peak. t_a: the scene; t_b: the haze. k0: 1 / scene size, tap offset
// (texels, PER_PIXEL). k1: threshold, smoothing, haze weight.
#ifdef PER_PIXEL
fn tap(uv: vec2<f32>) -> vec3<f32> {
  let c = textureSampleLevel(t_a, s_linear, uv, 0.0).rgb;
  return c * smoothstep(post.k1.x, post.k1.x + post.k1.y, dot(c, LUMA));
}

@fragment
fn fs(in: PostOut) -> @location(0) vec4<f32> {
  let o = post.k0.xy * post.k0.z;
  var c = (tap(in.uv + vec2<f32>(-o.x, -o.y)) + tap(in.uv + vec2<f32>(o.x, -o.y)) + tap(in.uv + vec2<f32>(-o.x, o.y)) + tap(in.uv + vec2<f32>(o.x, o.y))) * 0.25;
#ifdef HAZE
  let h = textureSampleLevel(t_b, s_linear, in.uv, 0.0).rgb * post.k1.z;
  c += h * smoothstep(post.k1.x, post.k1.x + post.k1.y, dot(h, LUMA));
#endif
  return vec4<f32>(c, 1.0);
}
#else
fn tap(uv: vec2<f32>) -> vec4<f32> {
  let c = textureSampleLevel(t_a, s_linear, uv, 0.0).rgb;
  let w = 1.0 / (1.0 + dot(c, LUMA));
  return vec4<f32>(c * w, w);
}

@fragment
fn fs(in: PostOut) -> @location(0) vec4<f32> {
  let o = post.k0.xy;
  let sum = tap(in.uv + vec2<f32>(-o.x, -o.y)) + tap(in.uv + vec2<f32>(o.x, -o.y)) + tap(in.uv + vec2<f32>(-o.x, o.y)) + tap(in.uv + vec2<f32>(o.x, o.y));
  var c = sum.rgb / sum.a;
#ifdef HAZE
  c += textureSampleLevel(t_b, s_linear, in.uv, 0.0).rgb * post.k1.z;
#endif
  let k = smoothstep(post.k1.x, post.k1.x + post.k1.y, dot(c, LUMA));
  return vec4<f32>(c * k, 1.0);
}
#endif
#endif

#ifdef DOWN
// Dual-filter downsample (centre x 4 + four diagonal bilinear taps) / 8.
// t_a: the source. k0: half texel of the source.
@fragment
fn fs(in: PostOut) -> @location(0) vec4<f32> {
  let o = post.k0.xy;
  var c = textureSampleLevel(t_a, s_linear, in.uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(t_a, s_linear, in.uv - o, 0.0).rgb;
  c += textureSampleLevel(t_a, s_linear, in.uv + o, 0.0).rgb;
  c += textureSampleLevel(t_a, s_linear, in.uv + vec2<f32>(o.x, -o.y), 0.0).rgb;
  c += textureSampleLevel(t_a, s_linear, in.uv - vec2<f32>(o.x, -o.y), 0.0).rgb;
  return vec4<f32>(c * 0.125, 1.0);
}
#endif

#ifdef UP
// Mip-blur upsample: four bilinear taps one source texel off each diagonal (a
// 4x4 tent over the coarser level), blended with this level's downsample by
// the bloom radius. t_a: the coarser upsampled level; t_b: this level's
// downsample. k0: texel of the source, radius.
@fragment
fn fs(in: PostOut) -> @location(0) vec4<f32> {
  let o = post.k0.xy;
  var c = textureSampleLevel(t_a, s_linear, in.uv + vec2<f32>(-o.x, -o.y), 0.0).rgb * 0.25;
  c += textureSampleLevel(t_a, s_linear, in.uv + vec2<f32>(o.x, -o.y), 0.0).rgb * 0.25;
  c += textureSampleLevel(t_a, s_linear, in.uv + vec2<f32>(-o.x, o.y), 0.0).rgb * 0.25;
  c += textureSampleLevel(t_a, s_linear, in.uv + vec2<f32>(o.x, o.y), 0.0).rgb * 0.25;
  let s = textureSampleLevel(t_b, s_linear, in.uv, 0.0).rgb;
  return vec4<f32>(mix(s, c, post.k0.z), 1.0);
}
#endif

#ifdef COMPOSITE
// Final frame: scene + haze + bloom, tone mapped and graded through the
// colour table (AgX or ACES, contrast, saturation, split toning, sRGB
// encoding), then film grain and the screen mask (vignette, letterbox, dip to
// black). t_a: the scene; t_b: the haze; t_c: the bloom; t_d: the colour
// table, 32 slices of 32x32 side by side, blue picks the slice; t_e: 64^2
// white noise, repeated. k0: bloom intensity, exposure. k1: haze weight, -,
// grain. k2: grain scale and offset. k3: fade, letterbox bar, vignette, aspect.
fn tone(c: vec3<f32>) -> vec3<f32> {
  let l = clamp((log2(max(c, vec3<f32>(1e-10))) + 12.47393) * (31.0 / 16.5), vec3<f32>(0.0), vec3<f32>(31.0));
  let b0 = floor(l.b);
  let uv = vec2<f32>((b0 * 32.0 + l.r + 0.5) / 1024.0, (l.g + 0.5) / 32.0);
  let lo = textureSampleLevel(t_d, s_linear, uv, 0.0).rgb;
  let hi = textureSampleLevel(t_d, s_linear, uv + vec2<f32>(min(b0 + 1.0, 31.0) - b0, 0.0) * (32.0 / 1024.0), 0.0).rgb;
  return mix(lo, hi, l.b - b0);
}

// Vignette, letterbox bars and the dip to black (`write_mask` in
// vita/src/frame.rs, which bakes it into a texture).
fn mask(uv: vec2<f32>) -> f32 {
  let open = saturate((min(uv.y, 1.0 - uv.y) - post.k3.y) * 256.0 + 0.5) * (1.0 - post.k3.x);
  let q = vec2<f32>((uv.x - 0.5) * post.k3.w, uv.y - 0.5);
  let t = saturate((length(q) - 1.05) / (0.25 - 1.05));
  let vig = t * t * (3.0 - 2.0 * t);
  return ((1.0 - post.k3.z) + post.k3.z * vig) * open;
}

@fragment
fn fs(in: PostOut) -> @location(0) vec4<f32> {
  var c = textureSampleLevel(t_a, s_linear, in.uv, 0.0).rgb;
#ifdef HAZE
  // Haze is soft: one bilinear tap of the low-resolution buffer.
  c += textureSampleLevel(t_b, s_linear, in.uv, 0.0).rgb * post.k1.x;
#endif
#ifdef BLOOM
  c += textureSampleLevel(t_c, s_linear, in.uv, 0.0).rgb * post.k0.x;
#endif
  var d = tone(c * post.k0.y);
  // Grain on the encoded colour, strongest in the shadows.
  let n = textureSampleLevel(t_e, s_tile, in.uv * post.k2.xy + post.k2.zw, 0.0).r - 0.5;
  d += n * (post.k1.z * 2.4) * (1.0 - d.g * 0.7);
  return vec4<f32>(d * mask(in.uv), 1.0);
}
#endif
