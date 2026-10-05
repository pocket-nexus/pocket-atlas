// The sky: a triangle over the whole screen on the far plane (reversed depth:
// z = 0) carrying the world-space view ray of each corner
// (vita/shaders/sky_v.cg), then the night sky (sky_f.cg) or the day sky
// (sky_day_f.cg). Alpha is the far distance the haze pass integrates to.
//
// Defines: DAY, TWILIGHT.

struct SkyOut {
  @builtin(position) position: vec4<f32>,
  @location(0) ray: vec3<f32>,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> SkyOut {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u)) * 2.0 - 1.0;
  var out: SkyOut;
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.ray = pass_.ray_z.xyz + pass_.ray_x.xyz * p.x + pass_.ray_y.xyz * p.y;
  return out;
}

#ifdef DAY
// Daytime sky (the web's gradient, sun and cloud panorama model): zenith and
// horizon gradient, the sun's glow and disc, and a cloud panorama: two 180
// degree halves of azimuth side by side in v, rows by the square root of
// elevation (R opacity, G sunlit, B skylit). TWILIGHT (sun below the
// horizon): the afterglow band along the horizon toward the sun, the
// anti-twilight arch opposite it and the Earth's shadow under the arch.
@fragment
fn fs(in: SkyOut) -> @location(0) vec4<f32> {
  let d = normalize(in.ray);
  let h = d.y;
  var col = mix(pass_.horizon.rgb, pass_.zenith.rgb, pow(saturate(h) + 1e-5, pass_.zenith.w));
  if (h < 0.0) {
    col = mix(pass_.horizon.rgb, pass_.glow.rgb, saturate(-h * pass_.horizon.w));
  }
  let mu = max(dot(d, pass_.sky_sun.xyz), 0.0);
  col += pass_.sky_glow.rgb * (pass_.sky_glow.w * pow(mu, pass_.cloud_sun.w) + pow(mu, pass_.sky_day.w));
  col += pass_.sky_disc.rgb * smoothstep(pass_.sky_disc.w, pass_.cloud_amb.w, mu);
#ifdef TWILIGHT
  {
    let dh = normalize(d.xz + vec2<f32>(1e-5));
    let sh = normalize(pass_.sky_sun.xz + vec2<f32>(1e-5));
    let a = clamp(dot(dh, sh), -1.0, 1.0);
    let hp = abs(h);
    let toward = max((a + 1.0) * 0.5, 0.0);
    let away = max((1.0 - a) * 0.5, 0.0);
    col += pass_.tw_band.rgb * (exp(-hp / pass_.tw_band.w) * mix(1.0, pow(toward + 1e-6, pass_.tw_shape.y), pass_.tw_shape.x));
    let bz = (h - pass_.tw_belt.w) / pass_.tw_shape.z;
    col += pass_.tw_belt.rgb * (exp(-bz * bz) * pow(away + 1e-6, pass_.tw_shape.w));
    col *= 1.0 - pass_.tw_shadow.x * exp(-hp / pass_.tw_shadow.y) * pow(away + 1e-6, pass_.tw_shadow.z);
  }
#endif
  // (the panorama's row comes from the ray, not from the screen: its level is fixed)
  let a01 = fract(atan2(d.x, -d.z) / (2.0 * PI) + pass_.sky_day.x);
  let half_index = floor(a01 * 2.0);
  let u = fract(a01 * 2.0);
  let lv = sqrt(asin(saturate(h)) / (PI * 0.5));
  let v = (half_index + clamp(lv, 0.5 / 512.0, 1.0 - 0.5 / 512.0)) * 0.5;
  let c = textureSampleLevel(t_clouds, s_repeat, vec2<f32>(u, v), 0.0).rgb;
  if (h > 0.0 && pass_.sky_day.z > 0.5) {
    let f = smoothstep(0.0, pass_.sky_day.y, h);
    col = col * (1.0 - c.r * f) + (pass_.cloud_sun.rgb * c.g + pass_.cloud_amb.rgb * c.b) * f;
  }
  return vec4<f32>(col, pass_.glow.w);
}
#else
// Night sky: zenith-horizon gradient and a low rain-cloud deck lit from below
// by the city (sodium orange at the horizon, violet overhead).
@fragment
fn fs(in: SkyOut) -> @location(0) vec4<f32> {
  let d = normalize(in.ray);
  let h = max(d.y, 0.0);
  var col = mix(pass_.horizon.rgb, pass_.zenith.rgb, pow(h + 1e-4, 0.4));
  let uv = d.xz / max(d.y + 0.06, 0.03);
  let t = pass_.zenith.w;
  let c1 = textureSample(t_clouds, s_repeat, (uv * 0.28 + vec2<f32>(t * 0.005, t * 0.002)) * pass_.horizon.w).r;
  let c2 = textureSample(t_clouds, s_repeat, (uv * 0.85 - vec2<f32>(t * 0.009, 0.0)) * pass_.horizon.w).g;
  let dens = c1 * 0.72 + c2 * 0.28;
  let clouds = smoothstep(0.42, 0.78, dens);
  let under = smoothstep(0.5, 0.7, c2);
  let lit = exp(-h * 3.2);
  let city_glow = mix(pass_.glow.rgb, vec3<f32>(0.16, 0.1, 0.22), smoothstep(0.05, 0.5, h));
  col += city_glow * clouds * (0.35 + 0.65 * lit) * (0.7 + 0.5 * under);
  col += pass_.glow.rgb * lit * lit * 0.3;
  col *= mix(0.72, 1.0, clouds);
  return vec4<f32>(col, pass_.glow.w);
}
#endif
