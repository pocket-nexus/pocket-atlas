// Apartment and office windows (vita/shaders/window_f.cg): a view ray traced
// through a box room behind the pane (interior mapping), curtains and blinds
// just behind the glass, plus the pane's own environment reflection. UV:
// floor = per-window seed, fract = position across the pane; vertex colour
// RG = pane size / 16 m.
//
// Defines: FOG, VISTA, REFLECTION.

fn room_light(h: vec3<f32>, room: vec3<f32>, lamp_col: vec3<f32>, lit: f32) -> vec3<f32> {
  let lamp = vec3<f32>(room.x * 0.5, room.y - 0.25, room.z * 0.55);
  let d = h - lamp;
  return lamp_col * lit * (0.25 + 1.6 / (1.0 + dot(d, d) * 0.45));
}

@fragment
fn fs(in: Varyings) -> @location(0) vec4<f32> {
  let to_eye = pass_.eye.xyz - in.world;
  let dist = length(to_eye);
  let V = -to_eye / dist;
  let n = normalize(in.normal);
  let t = normalize(in.tangent.xyz);
  let b = cross(n, t) * in.tangent.w;
  let W = max(in.color.r * 16.0, 0.3);
  let H = max(in.color.g * 16.0, 0.3);
  let seed = floor(in.uv);
  let local = fract(in.uv);
  let tint = draw.emissive.x * draw.emissive.yzw;

#ifdef REFLECTION
  var inside = vec3<f32>(0.02, 0.018, 0.015) * tint;
#else
  var inside = vec3<f32>(0.0);
  {
    let sheer = textureSampleLevel(t_puddles, s_repeat, local * vec2<f32>(20.0, 10.0), 0.0).g;
    let h3 = hash32(seed * 1.37 + 0.5);
    let h4 = hash12(seed + 17.1);
    let room = vec3<f32>(W + 1.4, 2.6, 3.2 + h3.z * 2.5);
    let sill = select(0.18, 0.85, H < 1.7);
    let p = vec3<f32>(0.7 + local.x * W, sill + local.y * H, 0.0);
    var d = normalize(vec3<f32>(dot(V, t), dot(V, b), -dot(V, n)));
    d.z = max(d.z, 0.05);
    // Never exactly 0 across or up the pane.
    d.x = select(min(d.x, -1e-4), max(d.x, 1e-4), d.x >= 0.0);
    d.y = select(min(d.y, -1e-4), max(d.y, 1e-4), d.y >= 0.0);
    let tw = vec3<f32>(select(-p.x, room.x - p.x, d.x > 0.0) / d.x, select(-p.y, room.y - p.y, d.y > 0.0) / d.y, (room.z - p.z) / d.z);
    let tt = min(min(tw.x, tw.y), tw.z);
    let h = p + d * tt;

    let lit = h3.x < 0.62;
    let tv = !lit && h3.y < 0.35;
    let lamp_col = select(vec3<f32>(0.82, 0.9, 1.0), vec3<f32>(1.0, 0.72, 0.45), h4 < 0.68);
    let bright = 0.55 + h3.y * 0.9;
    let wall_col = mix(vec3<f32>(0.78, 0.74, 0.66), vec3<f32>(0.62, 0.66, 0.68), hash12(seed + 3.0));
    let floor_col = select(select(vec3<f32>(0.4, 0.4, 0.42), vec3<f32>(0.6, 0.56, 0.36), h3.z < 0.7), vec3<f32>(0.55, 0.36, 0.2), h3.z < 0.4);
    var albedo: vec3<f32>;
    if (tt == tw.z) {
      albedo = wall_col;
      let k = hash12(seed + 9.0);
      if (h.y < 0.75 && abs(h.x - room.x * (0.3 + k * 0.4)) < 0.9) {
        albedo *= 0.35;
      }
      if (k > 0.5 && h.y > 0.9 && h.y < 2.0 && abs(h.x - room.x * 0.2) < 0.35) {
        albedo = vec3<f32>(0.15, 0.12, 0.1);
      }
      if (abs(h.x - room.x * 0.65) < 0.35 && abs(h.y - 1.5) < 0.25) {
        albedo = mix(albedo, vec3<f32>(0.3, 0.4, 0.6), 0.7);
      }
    } else if (tt == tw.x) {
      albedo = wall_col * 0.92;
      if (h.y < 2.05 && h.y > 0.0 && abs(h.z - room.z * 0.6) < 0.4) {
        albedo *= 0.55;
      }
    } else {
      albedo = select(vec3<f32>(0.5), floor_col, d.y < 0.0);
    }
    var light = vec3<f32>(0.015, 0.016, 0.02);
    if (lit) {
      light = room_light(h, room, lamp_col, bright);
    }
    if (tv) {
      let f = 0.6 + 0.4 * sin(pass_.eye.w * 7.0 + h3.x * 40.0) * sin(pass_.eye.w * 3.1 + h3.z * 11.0);
      let dd = h - vec3<f32>(room.x * 0.5, 0.7, room.z - 0.2);
      light += vec3<f32>(0.35, 0.55, 1.0) * f * 0.9 / (1.0 + dot(dd, dd) * 1.2);
    }
    let col = albedo * light;

    let style = hash12(seed + 5.5);
    var curtain_a = 0.0;
    var curtain_col = vec3<f32>(0.0);
    let cloth = mix(vec3<f32>(0.85, 0.8, 0.7), vec3<f32>(0.6, 0.3, 0.25), step(0.7, hash12(seed + 8.0)));
    if (style < 0.35) {
      let open = 0.25 + 0.35 * hash12(seed + 2.0);
      curtain_a = select(0.0, 0.92, local.x < open || local.x > 1.0 - open * 0.7);
      curtain_col = cloth * (0.85 + 0.15 * sin(local.x * 60.0));
    } else if (style < 0.55) {
      let slat = step(0.35, fract(local.y * H * 12.0));
      curtain_a = slat * 0.85 * step(local.y, 0.4 + 0.6 * hash12(seed + 4.0) + 0.001);
      curtain_col = vec3<f32>(0.8, 0.8, 0.78);
    } else if (style < 0.75) {
      curtain_a = 0.55;
      curtain_col = vec3<f32>(0.92, 0.9, 0.86) * (0.9 + 0.1 * sheer);
    }
    var glow = vec3<f32>(0.01);
    if (lit) {
      glow = lamp_col * bright * 0.9;
    }
    if (tv) {
      glow += vec3<f32>(0.1, 0.18, 0.35);
    }
    inside = mix(col, curtain_col * glow, curtain_a);
    let e = min(local, 1.0 - local);
    inside *= smoothstep(0.0, 0.04, min(e.x, e.y)) * 0.85 + 0.15;
    inside *= tint;
  }
#endif
  // Pane: dark glass, roughness 0.06.
  let dot_nv = saturate(dot(n, -V));
  let radiance = env(reflect(V, n), 0.3) * draw.env_k.x;
  let dfg = dfg_approx(0.06, dot_nv);
  let color = inside + radiance * (0.04 * dfg.x + dfg.y);
  return finish(hazed(color, in.haze, dist), 1.0, dist);
}
