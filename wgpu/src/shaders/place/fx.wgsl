// Rain and atmosphere particles (vita/shaders/fx_v.cg, fx_f.cg), animated
// entirely on the GPU from per-vertex seeds (every quad repeats its seed on
// four corners). Lit by the nearest haze lights with a soft 1 / (d^2 + r^2)
// falloff. The destination's alpha (eye distance) is never written.
//
// Defines (one of): STREAK, DRIP, SPLASH, STEAM, BEACON.

struct Particle {
  @location(0) seed: vec4<f32>,
  @location(1) corner: vec2<f32>,
  @location(2) a: vec3<f32>,
  @location(3) b: vec3<f32>,
}

struct Fx {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) life: vec2<f32>,
}

fn r_hash(p: vec2<f32>) -> f32 {
  var p3 = fract(p.xyx * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn light_at(p: vec3<f32>) -> vec3<f32> {
  var c = vec3<f32>(0.05, 0.06, 0.08);
  for (var i = 0; i < 8; i++) {
    let d = pass_.fx_pos[i].xyz - p;
    let r2 = pass_.fx_pos[i].w * pass_.fx_pos[i].w;
    c += pass_.fx_col[i].rgb * r2 / (dot(d, d) + r2);
  }
  return c;
}

fn is_dry(p: vec3<f32>) -> bool {
  let a = all(p > pass_.fx_dry[0].xyz) && all(p < pass_.fx_dry[1].xyz);
  let b = all(p > pass_.fx_dry[2].xyz) && all(p < pass_.fx_dry[3].xyz);
  return a || b;
}

@vertex
fn vs(v: Particle) -> Fx {
  let t = pass_.fx_time.x;
  let cam = pass_.eye.xyz;
  let pixel = pass_.refl.w;
  var wp = vec3<f32>(0.0);
  var hidden = false;
  var alpha = 1.0;
  var life = 0.0;
  var uv = v.corner;
  var color = vec3<f32>(0.0);
#ifdef STREAK
  {
    let sp = pass_.fx_time.y * (0.85 + 0.3 * v.seed.w);
    let vel = vec3<f32>(pass_.fx_wind.x, -sp, pass_.fx_wind.z);
    let box = vec3<f32>(30.0, 18.0, 30.0);
    let origin = cam - vec3<f32>(box.x * 0.5, box.y * 0.3, box.z * 0.5);
    var p = v.seed.xyz * box + vel * t;
    let r = p - origin;
    p = origin + r - box * floor(r / box);
    let to_cam = cam - p;
    let dist = length(to_cam);
    hidden = p.y < 0.0 || is_dry(p);
    let axis = normalize(vel);
    let side = normalize(cross(axis, to_cam / dist));
    let wdt = max(pass_.fx_time.w, dist * pixel * 1.3);
    let len = pass_.fx_time.z * (0.7 + 0.6 * v.seed.w);
    wp = p + side * v.corner.x * wdt + axis * (v.corner.y - 0.5) * len;
    uv = vec2<f32>(v.corner.x + 0.5, v.corner.y);
    color = light_at(p);
    alpha = (pass_.fx_time.w / wdt) * smoothstep(0.35, 1.4, dist) * (1.0 - smoothstep(box.x * 0.32, box.x * 0.5, dist));
  }
#endif
#ifdef SPLASH
  {
    let rate = 1.1 + v.seed.z * 1.3;
    let cyc = t * rate + v.seed.w * 17.0;
    let id = floor(cyc);
    life = fract(cyc);
    let r = vec2<f32>(r_hash(v.seed.xy * 131.7 + id), r_hash(v.seed.yx * 71.3 + id * 1.7));
    let area = pass_.fx_center.w;
    let p = vec3<f32>(pass_.fx_center.x + (r.x - 0.5) * area, 0.0, pass_.fx_center.z + (r.y - 0.5) * area);
    alpha = r_hash(vec2<f32>(id, v.seed.z * 97.0));
    let size = mix(0.05, 0.11, v.seed.x);
    let to_cam = cam - p;
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), to_cam));
    wp = p + right * v.corner.x * size * 2.0 + vec3<f32>(0.0, 1.0, 0.0) * v.corner.y * size * 1.4;
    let d = length(to_cam);
    hidden = is_dry(p + vec3<f32>(0.0, 0.05, 0.0)) || d > area * 0.55;
    color = light_at(p + vec3<f32>(0.0, 0.1, 0.0)) * (1.0 - smoothstep(area * 0.3, area * 0.55, d));
  }
#endif
#ifdef DRIP
  {
    let edge = mix(v.a, v.b, v.seed.x);
    let period = 0.35 + v.seed.y * 1.1;
    let ph = fract(t / period + v.seed.z * 7.0);
    let fall_t = ph * period;
    let y = edge.y - 4.9 * fall_t * fall_t;
    let p = vec3<f32>(edge.x, y, edge.z);
    let len = clamp((9.8 * fall_t + 0.5) * 0.02, 0.03, 0.25);
    let to_cam = cam - p;
    let dist = length(to_cam);
    let axis = vec3<f32>(0.0, -1.0, 0.0);
    let side = normalize(cross(axis, to_cam / dist));
    let wdt = max(0.006, dist * 0.0012);
    wp = p + side * v.corner.x * wdt + axis * (v.corner.y - 0.5) * len;
    hidden = y < 0.0;
    uv = vec2<f32>(v.corner.x + 0.5, v.corner.y);
    color = light_at(p) * 1.4;
    alpha = (0.006 / wdt) * smoothstep(0.3, 1.0, dist) * (1.0 - smoothstep(18.0, 30.0, dist));
  }
#endif
#ifdef STEAM
  {
    let life_s = 3.2 + v.seed.y * 1.6;
    let tt = fract(t / life_s + v.seed.x);
    let age = tt * life_s;
    var p = v.a + v.b * (1.0 - exp(-age * 2.2)) * 0.55;
    p.y += age * 0.42 + age * age * 0.04;
    p.x += sin(age * 1.3 + v.seed.z * 6.28) * 0.12 * age + age * 0.18;
    p.z += cos(age * 1.1 + v.seed.w * 6.28) * 0.08 * age;
    let size = 0.18 + age * 0.34;
    let to_cam = normalize(cam - p);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), to_cam));
    let up = cross(to_cam, right);
    let rot = v.seed.w * 6.28 + age * 0.4;
    let q = vec2<f32>(cos(rot) * v.corner.x - sin(rot) * v.corner.y, sin(rot) * v.corner.x + cos(rot) * v.corner.y);
    wp = p + (right * q.x + up * q.y) * size;
    color = light_at(p);
    alpha = smoothstep(0.0, 0.08, tt) * (1.0 - tt) * (1.0 - tt);
  }
#endif
#ifdef BEACON
  {
    let to_cam = cam - v.a;
    let dist = length(to_cam);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), to_cam));
    let up = normalize(cross(to_cam, right));
    let size = clamp(900.0 / dist, 1.5, 6.0) * dist * pixel * 0.5;
    wp = v.a + (right * v.corner.x + up * v.corner.y) * size;
    color = vec3<f32>(1.0, 0.08, 0.04) * 6.0 * (0.35 + 0.65 * step(0.45, fract(t * 0.55 + v.a.x * 0.0003)));
  }
#endif
  var out: Fx;
  out.position = pass_.view_proj * vec4<f32>(wp, 1.0);
  if (hidden) {
    out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  }
  out.color = color;
  out.uv = uv;
  out.life = vec2<f32>(life, alpha);
  return out;
}

@fragment
fn fs(in: Fx) -> @location(0) vec4<f32> {
  let opacity = draw.field.w;
#ifdef STEAM
  let n = textureSample(t_puddles, s_repeat, in.uv * 0.75 + 1.25).g * 0.6 + textureSample(t_puddles, s_repeat, in.uv * 1.75).r * 0.4;
  let r = length(in.uv);
  var a = (1.0 - smoothstep(0.0, 1.0, r + (n - 0.5) * 0.6));
  a = a * a * in.life.y * opacity;
  return vec4<f32>(in.color * a * 0.28, a * 0.16);
#else
#ifdef SPLASH
  let t = in.life.x;
  let kind = in.life.y;
  var a = 0.0;
  for (var i = 0; i < 5; i++) {
    let dir = (f32(i) - 2.0) * 0.5;
    let x = dir * t * 0.9;
    let y = (4.0 * t * (1.0 - t)) * (0.55 + 0.35 * fract(f32(i) * 0.618 + kind));
    let d = vec2<f32>(in.uv.x - x, in.uv.y - y);
    a += (1.0 - smoothstep(0.0, 0.08, length(d * vec2<f32>(1.0, 0.8))));
  }
  let ring = abs(length(vec2<f32>(in.uv.x, in.uv.y * 5.0)) - t * 0.9);
  a += (1.0 - smoothstep(0.0, 0.06, ring)) * 0.6 * step(in.uv.y, 0.12);
  a *= (1.0 - t) * (1.0 - t) * opacity;
  return vec4<f32>(in.color * a, a);
#else
#ifdef BEACON
  let a = (1.0 - smoothstep(0.0, 1.0, length(in.uv)));
  return vec4<f32>(in.color * a, a);
#else
  // A streak, falling or dripping.
  let e = 1.0 - abs(in.uv.x * 2.0 - 1.0);
  let along = smoothstep(0.0, 0.35, in.uv.y) * (1.0 - smoothstep(0.75, 1.0, in.uv.y));
  let a = e * e * along * in.life.y * opacity;
  return vec4<f32>(in.color * a, a);
#endif
#endif
#endif
}
