// Shared by every program that draws a place: the constants of a pass and of
// a draw, the textures a pass binds, and the helpers of vita/shaders/common.cgh
// and vista.cgh. Lighting follows three.js MeshPhysicalMaterial, as the PS
// Vita's programs do.
//
// The sources are run through a small preprocessor (wgpu/src/places/programs.rs):
// #ifdef, #ifndef, #if with defined(), #else, #endif, #define, #undef.

struct Pass {
  view_proj: mat4x4<f32>,
  eye: vec4<f32>,          // camera position, time (s)
  fog: vec4<f32>,          // FogExp2 colour, density
  hemi_sky: vec4<f32>,     // hemisphere irradiance from above
  hemi_ground: vec4<f32>,  // and from below
  ripple: vec4<f32>,       // frame a, frame b, blend, 1 / tile (m)
  refl: vec4<f32>,         // planar weight, rain, H / tan(fovY / 2) in target pixels, pixel footprint at 1 m
  skyline: vec4<f32>,      // skyline haze colour
  sun_dir: vec4<f32>,      // direction towards the sun
  sun_rad: vec4<f32>,      // radiance, normal offset (m)
  sun_mat0: vec4<f32>,     // world to shadow-map u
  sun_mat1: vec4<f32>,     // and v
  shadow_k: vec4<f32>,     // near-plane distance along the light, 1 / range, bias, map size (texels)
  moving_k: vec4<f32>,     // the same for the moving casters' map; w = 0: none
  vista: vec4<f32>,        // rho0, H, 1 / (s ln 2), rho0 s
  vista_eye: vec4<f32>,    // eye y, G(y_e), rho(y_e)
  vista_sun: vec4<f32>,    // horizontal direction toward the sun (x, z)
  vista_glow: vec4<f32>,   // city glow in the haze layer, band
  vista_sky: array<vec4<f32>, 17>,
  vista_sun_sky: array<vec4<f32>, 17>,
  ray_x: vec4<f32>,        // right x tan(fov x / 2)
  ray_y: vec4<f32>,        // up x tan(fov y / 2)
  ray_z: vec4<f32>,        // forward
  zenith: vec4<f32>,
  horizon: vec4<f32>,
  glow: vec4<f32>,
  sky_day: vec4<f32>,
  sky_sun: vec4<f32>,
  sky_glow: vec4<f32>,
  sky_disc: vec4<f32>,
  cloud_sun: vec4<f32>,
  cloud_amb: vec4<f32>,
  tw_band: vec4<f32>,
  tw_belt: vec4<f32>,
  tw_shape: vec4<f32>,
  tw_shadow: vec4<f32>,
  viewport: vec4<f32>,     // target width, height, and their inverses
  fx_time: vec4<f32>,      // time, streak speed, length, width
  fx_wind: vec4<f32>,      // wind velocity (m/s)
  fx_center: vec4<f32>,    // splash area centre, area size
  fx_dry: array<vec4<f32>, 4>,
  fx_pos: array<vec4<f32>, 8>,
  fx_col: array<vec4<f32>, 8>,
}

struct Draw {
  model: array<vec4<f32>, 3>,   // rows of the world transform
  dequant: array<vec4<f32>, 2>, // position = q x scale + offset
  uv: vec4<f32>,                // scale, offset
  base: vec4<f32>,
  emissive: vec4<f32>,
  pbr: vec4<f32>,               // roughness, metalness, normal scale, AO strength
  env_k: vec4<f32>,             // env intensity, clearcoat, clearcoat roughness, rain
  wet: vec4<f32>,               // puddles, darken, roughness factor, ripple strength
  wet2: vec4<f32>,              // 1 / puddle scale, damp darken, damp roughness, damp streaks
  wave: array<vec4<f32>, 2>,    // per layer: repeats per metre, -, offset
  water_k: vec4<f32>,           // body colour, roughness squared per metre
  water_shallow: vec4<f32>,
  field: vec4<f32>,             // min pixels, max pixels, gain, opacity (particles)
  field_t: vec4<f32>,           // t / period, 2 pi fract(4 t), depth pull per metre
  counts: vec4<f32>,            // lights, texture level bias, -, -
  light_pos: array<vec4<f32>, 4>,   // position, 1 / range
  light_col: array<vec4<f32>, 4>,   // radiant intensity, spot offset
  light_dir: array<vec4<f32>, 4>,   // emission direction, spot scale
  light_right: array<vec4<f32>, 4>, // rect width axis, half width
  light_up: array<vec4<f32>, 4>,    // rect height axis, half height
}

struct Bones {
  rows: array<vec4<f32>, 72>, // 24 joints, three rows each
}

@group(0) @binding(0) var<uniform> pass_: Pass;
@group(0) @binding(1) var t_env: texture_2d<f32>;
@group(0) @binding(2) var t_puddles: texture_2d<f32>;
@group(0) @binding(3) var t_ripples: texture_2d<f32>;
@group(0) @binding(4) var t_beads: texture_2d<f32>;
@group(0) @binding(5) var t_clouds: texture_2d<f32>;
@group(0) @binding(6) var t_shadow: texture_depth_2d;
@group(0) @binding(7) var t_moving: texture_depth_2d;
@group(0) @binding(8) var t_refl_sharp: texture_2d<f32>;
@group(0) @binding(9) var t_refl_blur: texture_2d<f32>;
@group(0) @binding(10) var s_repeat: sampler;
@group(0) @binding(11) var s_clamp: sampler;
@group(0) @binding(12) var s_compare: sampler_comparison;

@group(1) @binding(0) var t_albedo: texture_2d<f32>;
@group(1) @binding(1) var t_normal: texture_2d<f32>;
@group(1) @binding(2) var t_orm: texture_2d<f32>;
@group(1) @binding(3) var t_emission: texture_2d<f32>;
@group(1) @binding(4) var s_albedo: sampler;
@group(1) @binding(5) var s_normal: sampler;
@group(1) @binding(6) var s_orm: sampler;
@group(1) @binding(7) var s_emission: sampler;

@group(2) @binding(0) var<uniform> draw: Draw;
@group(2) @binding(1) var<uniform> bones: Bones;

const PI: f32 = 3.14159265;

// A signed 16-bit normalised attribute, bound as integers: wgpu 25's Metal
// backend reads vertex buffers in the shader, and naga 25.0.1 unpacks
// snorm16x2 and snorm16x4 with each pair of components in the other's place.
fn s16n2(v: vec2<i32>) -> vec2<f32> {
  return max(vec2<f32>(v) * (1.0 / 32767.0), vec2<f32>(-1.0));
}

fn s16n4(v: vec4<i32>) -> vec4<f32> {
  return max(vec4<f32>(v) * (1.0 / 32767.0), vec4<f32>(-1.0));
}
const INV_PI: f32 = 0.31830989;

// What a surface's vertex program hands its fragment program.
struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) tangent: vec4<f32>,
  @location(3) uv: vec2<f32>,
  @location(4) screen: vec4<f32>,
  @location(5) light: vec3<f32>,
  @location(6) shadow: vec3<f32>,
  @location(7) haze: vec4<f32>,
  @location(8) color: vec4<f32>,
  @location(9) uv2: vec2<f32>,
}

fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(p.xyx * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash32(p: vec2<f32>) -> vec3<f32> {
  var p3 = fract(p.xyx * vec3<f32>(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// sRGB-encoded 8-bit colour to linear (fitted polynomial, max error 0.4%).
fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
  return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
}

// Octahedral direction to UV; inverse of the cooker's oct_decode (y folded).
fn oct_uv(dir: vec3<f32>) -> vec2<f32> {
  let d = dir / (abs(dir.x) + abs(dir.y) + abs(dir.z));
  var p = d.xz;
  if (d.y < 0.0) {
    let s = step(vec2<f32>(0.0), p) * 2.0 - 1.0;
    p = (1.0 - abs(p.yx)) * s;
  }
  return p * 0.5 + 0.5;
}

fn env(dir: vec3<f32>, level: f32) -> vec3<f32> {
  return textureSampleLevel(t_env, s_clamp, oct_uv(dir), level).rgb;
}

fn f_schlick(f0: vec3<f32>, dot_vh: f32) -> vec3<f32> {
  let fresnel = exp2((-5.55473 * dot_vh - 6.98316) * dot_vh);
  return f0 * (1.0 - fresnel) + fresnel;
}

fn v_ggx(alpha: f32, dot_nl: f32, dot_nv: f32) -> f32 {
  let a2 = alpha * alpha;
  let gv = dot_nl * sqrt(a2 + (1.0 - a2) * dot_nv * dot_nv);
  let gl = dot_nv * sqrt(a2 + (1.0 - a2) * dot_nl * dot_nl);
  return 0.5 / max(gv + gl, 1e-6);
}

fn d_ggx(alpha: f32, dot_nh: f32) -> f32 {
  let a2 = alpha * alpha;
  let d = dot_nh * dot_nh * (a2 - 1.0) + 1.0;
  return INV_PI * a2 / (d * d);
}

// Split-sum environment BRDF (Karis), as three's DFGApprox.
fn dfg_approx(roughness: f32, dot_nv: f32) -> vec2<f32> {
  let r = roughness * vec4<f32>(-1.0, -0.0275, -0.572, 0.022) + vec4<f32>(1.0, 0.0425, 1.04, -0.04);
  let a004 = min(r.x * r.x, exp2(-9.28 * dot_nv)) * r.x + r.y;
  return vec2<f32>(-1.04, 1.04) * a004 + r.zw;
}

struct Lit {
  diffuse: vec3<f32>,
  specular: vec3<f32>,
}

// Direct light: irradiance x (Lambert + GGX), added to `lit`.
fn direct_light(L: vec3<f32>, irradiance: vec3<f32>, N: vec3<f32>, V: vec3<f32>, diffuse_color: vec3<f32>, specular_color: vec3<f32>, alpha: f32, lit: Lit) -> Lit {
  var out = lit;
  let dot_nl = saturate(dot(N, L));
  if (dot_nl <= 0.0) {
    return out;
  }
  let H = normalize(L + V);
  let dot_nv = saturate(dot(N, V));
  let dot_nh = saturate(dot(N, H));
  let dot_vh = saturate(dot(V, H));
  let E = irradiance * dot_nl;
  out.diffuse += E * diffuse_color * INV_PI;
  out.specular += E * f_schlick(specular_color, dot_vh) * (v_ggx(alpha, dot_nl, dot_nv) * d_ggx(alpha, dot_nh));
  return out;
}

// three's getDistanceAttenuation with decay 2 and a cutoff range.
fn distance_falloff(d2: f32, inv_range: f32) -> f32 {
  let falloff = 1.0 / max(d2, 0.01);
  let x = d2 * inv_range * inv_range;
  let w = saturate(1.0 - x * x);
  return falloff * w * w;
}

// The draw's lights on a surface point, with the full BRDF: closest point of
// rect emitters, spot cone, three's distance falloff.
fn lights_ggx(world: vec3<f32>, N: vec3<f32>, V: vec3<f32>, diffuse_color: vec3<f32>, specular_color: vec3<f32>, alpha: f32) -> Lit {
  var lit = Lit(vec3<f32>(0.0), vec3<f32>(0.0));
  let count = i32(draw.counts.x);
  for (var i = 0; i < count; i++) {
    let P = draw.light_pos[i].xyz;
    let d = world - P;
    let R = draw.light_right[i];
    let U = draw.light_up[i];
    let q = P + R.xyz * clamp(dot(d, R.xyz), -R.w, R.w) + U.xyz * clamp(dot(d, U.xyz), -U.w, U.w);
    let Lv = q - world;
    let d2 = dot(Lv, Lv);
    let L = Lv * inverseSqrt(max(d2, 1e-6));
    var s = saturate(dot(-L, draw.light_dir[i].xyz) * draw.light_dir[i].w + draw.light_col[i].w);
    s = s * s * (3.0 - 2.0 * s);
    // Outside the spot cone or the range nothing is lit.
    let att = distance_falloff(d2 + R.w * U.w, draw.light_pos[i].w) * s;
    if (att > 0.0) {
      lit = direct_light(L, draw.light_col[i].rgb * att, N, V, diffuse_color, specular_color, alpha, lit);
    }
  }
  return lit;
}

// FogExp2 as in three: 1 - exp(-density^2 d^2).
fn fog_factor(dist: f32, density: f32) -> f32 {
  return 1.0 - exp(-density * density * dist * dist);
}

// ---------------------------------------------------------------- vista haze
// (`dusk-vista` places; web places/shared/haze.ts), per vertex. Extinction
// rho0 up to the inversion top H, rho0 e^(-(y - H)/s) above; T = e^(-tau)
// over the column between the eye and the point. A surface keeps
// c T + inscatter (1 - T); additive surfaces and lights take c T.

struct Transmittance {
  t: f32,
  rho: f32,
}

fn vista_transmittance(p: vec3<f32>, d: f32) -> Transmittance {
  let above = p.y - pass_.vista.y;
  let rho = exp2(-max(above, 0.0) * pass_.vista.z);
  var G = pass_.vista.x * p.y;
  if (above > 0.0) {
    G = pass_.vista.x * pass_.vista.y + pass_.vista.w * (1.0 - rho);
  }
  let dy = p.y - pass_.vista_eye.x;
  var tau = d * pass_.vista_eye.z;
  if (abs(dy) >= 0.01) {
    tau = d * (G - pass_.vista_eye.y) / dy;
  }
  return Transmittance(exp2(-max(tau, 0.0) * 1.442695), rho);
}

// (inscatter (1 - T), T) toward the world point p.
fn vista_haze(p: vec3<f32>, eye: vec3<f32>) -> vec4<f32> {
  let v = p - eye;
  let d = length(v);
  let tr = vista_transmittance(p, d);
  let h = v.xz * inverseSqrt(max(dot(v.xz, v.xz), 1e-8));
  let u = sqrt(saturate(0.5 - 0.5 * dot(h, pass_.vista_sun.xy))) * 16.0;
  let i = min(floor(u), 15.0);
  let k = i32(i);
  let f = u - i;
  let w = pass_.vista_glow.w + (1.0 - pass_.vista_glow.w) * (1.0 - tr.t);
  let sky = mix(pass_.vista_sky[k].rgb, pass_.vista_sky[k + 1].rgb, f) + w * mix(pass_.vista_sun_sky[k].rgb, pass_.vista_sun_sky[k + 1].rgb, f);
  return vec4<f32>((sky + pass_.vista_glow.rgb * tr.rho) * (1.0 - tr.t), tr.t);
}

// What a surface program writes: HDR radiance and, in alpha, the eye distance
// the haze pass integrates to. A blended program writes its coverage there
// (the blend keeps the destination's distance); the mirror pass writes 1.
fn finish(color: vec3<f32>, coverage: f32, dist: f32) -> vec4<f32> {
#ifdef BLEND
  return vec4<f32>(color, coverage);
#else
#ifdef REFLECTION
  return vec4<f32>(color, 1.0);
#else
  return vec4<f32>(color, dist);
#endif
#endif
}

// The vista haze from the vertex stage, or the fog.
fn hazed(color: vec3<f32>, haze: vec4<f32>, dist: f32) -> vec3<f32> {
#ifdef VISTA
  return color * haze.a + haze.rgb;
#else
#ifdef FOG
  return mix(color, pass_.fog.rgb, fog_factor(dist, pass_.fog.w));
#else
  return color;
#endif
#endif
}
