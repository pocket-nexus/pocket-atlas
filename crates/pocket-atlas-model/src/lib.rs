//! Atlas domain semantics shared by its compiler and device pack readers.
//! This crate defines no GPU API, byte offsets, device formats or BSP types.
use serde::{Deserialize, Serialize};
pub mod color;

pub type Vec3 = [f32; 3];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Wrap {
    Repeat,
    Clamp,
    Mirror,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TexRole {
    /// sRGB colour (albedo, emission); shaders decode to linear.
    Color,
    /// Tangent-space normal, X in R and Y in G (BC5); shaders rebuild Z.
    Normal,
    /// Occlusion / roughness / metalness in R / G / B.
    Orm,
    /// Linear data.
    Data,
    /// Octahedral HDR environment map; mip n is prefiltered for roughness n/(mips-1).
    Environment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Lit surface: albedo / normal / ORM / emission, optional wet or damp film.
    Standard,
    /// HDR colour × texture, no lighting.
    Unlit,
    /// Premultiplied glass with rain beads and running drops.
    Glass,
    /// Window pane over a parallax room (UV integer part = room seed).
    InteriorWindow,
    /// Shop stock: vertex colour picks a design from the packaging atlas.
    Products,
    /// Distant tower lattice (procedural).
    Tower,
    /// Distant skyline boxes (procedural windows; vertex colour = per-box info).
    Skyline,
    /// Open water (sea, lake, river): `Material::water`, the normal map as
    /// the wave texture, `roughness` near the camera.
    Water,
    /// A field of point lights (`VertexLayout::Lights`, one vertex per
    /// light, no indices): street and window lights, traffic, beacons drawn
    /// as additive sprites sized by distance (`Material::lights`).
    Lights,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Blend {
    Opaque,
    Alpha,
    Premultiplied,
    Additive,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Wet {
    pub puddles: f32,
    pub darken: f32,
    pub roughness: f32,
    pub planar: bool,
    pub ripple: f32,
    pub puddle_scale: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Damp {
    pub darken: f32,
    pub roughness: f32,
    pub streaks: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Material {
    pub name: String,
    pub kind: Kind,
    pub blend: Blend,
    pub double_sided: bool,
    pub depth_write: bool,
    pub alpha_test: f32,
    /// Linear RGBA (alpha = opacity).
    pub color: [f32; 4],
    /// Linear HDR emission (already multiplied by intensity). Products:
    /// (light level, packaging mix, 0); interior windows: (room intensity, 0, 0).
    pub emissive: Vec3,
    pub roughness: f32,
    pub metalness: f32,
    pub normal_scale: f32,
    pub ao_strength: f32,
    pub env_strength: f32,
    pub albedo: Option<u32>,
    pub normal: Option<u32>,
    pub orm: Option<u32>,
    pub emission: Option<u32>,
    pub vertex_color: bool,
    /// Interior surface: emission carries its lighting (no scene lights, no fog).
    pub interior: bool,
    pub fog: bool,
    pub wet: Option<Wet>,
    pub damp: Option<Damp>,
    /// Glass bead density, 0..1.
    pub drops: f32,
    pub clearcoat: f32,
    pub polygon_offset: Option<[f32; 2]>,
    /// Index into `Meta::material_tracks` driving emission (neon flicker).
    pub emissive_track: Option<u32>,
    /// Animated texture coordinates (LED signs, screens, tickers).
    #[serde(default)]
    pub uv_anim: Option<UvAnim>,
    #[serde(default)]
    pub water: Option<Water>,
    #[serde(default)]
    pub lights: Option<LightField>,
    /// Interior windows: linear colour the traced room is multiplied by
    /// (a museum hall's warm light); white when absent.
    #[serde(default)]
    pub tint: Option<Vec3>,
}

/// A light field's sprites (web `places/shared/lights.ts`). Per light and
/// frame, at distance d: the physical diameter in render pixels
/// `D = radius · H / (d · tan(fovY / 2))`, the sprite diameter
/// `S = clamp(D, min_pixels, max_pixels)`, the energy kept by `(D / S)²`
/// while D < S, value `colour · intensity · gain · (D / S)² · twinkle · T`
/// (T: the vista haze's transmittance) over a `(1 − r²)²` profile, added to
/// the scene with depth test and no depth write.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LightField {
    /// Sprite diameter range in pixels of a 272-pixel-high frame (scaled by
    /// H / 272 for other render heights).
    pub min_pixels: f32,
    pub max_pixels: f32,
    pub gain: f32,
    /// Depth pull per km: a light's depth moves toward the eye by
    /// `clamp(depth_pull · d / 1 km, 0.002, 0.5)` of its distance d, its
    /// screen position unchanged (at grazing angles the ground under the
    /// pixels below a far light is nearer than the light).
    #[serde(default)]
    pub depth_pull: f32,
    /// Seconds the moving and blinking lights repeat over (the place's loop):
    /// position + path · fract(phase + cycles · t / period), on while
    /// fract(phase + blink cycles · t / period) < duty.
    pub period: f32,
}

/// One light of a field as the cooker reads it (place frame, linear colour).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LightPoint {
    pub position: Vec3,
    /// Linear RGB, largest channel 1.
    pub color: Vec3,
    /// Linear HDR peak at the physical size.
    pub intensity: f32,
    /// Physical radius (m).
    pub radius: f32,
    /// 0..1: offsets the path, the blink and the twinkle.
    pub phase: f32,
    /// 0..1: scintillation through the air, growing with distance.
    pub twinkle: f32,
    /// Travel over one cycle (m) and whole cycles per period.
    pub path: Vec3,
    pub path_cycles: f32,
    /// Whole blinks per period and the share of each blink the light is on
    /// (0 cycles and duty 1: always on).
    pub blink_cycles: f32,
    pub duty: f32,
}

/// Open water: two layers of the normal map laid on the world's x/z plane
/// and scrolled, the environment reflected by Fresnel, the sun's highlight
/// and light scattered out of the body.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Water {
    /// Per layer: repeats per metre, scroll (m/s along x, along z).
    pub waves: [[f32; 3]; 2],
    /// Linear colour of the light the body scatters back, × sky irradiance.
    pub body: Vec3,
    /// Roughness² added per metre of distance: waves smaller than a pixel
    /// widen the sun's reflection into a glitter path.
    pub distance_roughness: f32,
    /// Body colour over a sandy bottom, blended by the mesh's vertex colour
    /// (red); the body colour alone without one.
    #[serde(default)]
    pub shallow: Option<Vec3>,
    /// Mean slope of the wave faces toward the eye (tan of the tilt): the
    /// backs of the waves hide at grazing views, so far water reflects less
    /// sky and reads darker than the horizon.
    #[serde(default)]
    pub mask: f32,
}

/// A material's texture coordinates over time: a flipbook of `frames`
/// cells in a `cols` × `rows` grid (cell `f` at column `f % cols`, row
/// `f / cols`, from the top left) played at `fps`, then a scroll in texture
/// widths per second. The mesh's coordinates span one cell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UvAnim {
    pub cols: u32,
    pub rows: u32,
    pub frames: u32,
    pub fps: f32,
    pub scroll: [f32; 2],
    /// Seconds added to the place's clock.
    #[serde(default)]
    pub phase: f32,
}

impl UvAnim {
    /// `uv` = (scale u, scale v, offset u, offset v) at `time` seconds.
    pub fn apply(&self, uv: [f32; 4], time: f32) -> [f32; 4] {
        let time = time + self.phase;
        let mut uv = uv;
        if self.frames > 1 {
            let (cols, rows) = (self.cols.max(1), self.rows.max(1));
            let f = ((time * self.fps).floor() as i64).rem_euclid(self.frames as i64) as u32;
            let (cw, ch) = (1.0 / cols as f32, 1.0 / rows as f32);
            uv = [uv[0] * cw, uv[1] * ch, uv[2] * cw + (f % cols) as f32 * cw, uv[3] * ch + (f / cols) as f32 * ch];
        }
        uv[2] += (time * self.scroll[0]).rem_euclid(1.0);
        uv[3] += (time * self.scroll[1]).rem_euclid(1.0);
        uv
    }
}

#[cfg(test)]
mod uv_anim_tests {
    use super::UvAnim;

    #[test]
    fn flipbook_then_scroll() {
        let a = UvAnim { cols: 4, rows: 2, frames: 8, fps: 2.0, scroll: [0.0, -0.25], phase: 0.0 };
        // t = 2.6 s → frame 5: column 1, row 1 of a 4 × 2 grid.
        let uv = a.apply([1.0, 1.0, 0.0, 0.0], 2.6);
        assert_eq!([uv[0], uv[1]], [0.25, 0.5]);
        assert!((uv[2] - 0.25).abs() < 1e-6);
        // Scroll −0.25/s × 2.6 s wraps to +0.35, added after the cell offset.
        assert!((uv[3] - (0.5 + 0.35)).abs() < 1e-5, "{}", uv[3]);
    }

    #[test]
    fn phase_shifts_the_clock() {
        let a = UvAnim { cols: 2, rows: 1, frames: 2, fps: 1.0, scroll: [0.0, 0.0], phase: 1.0 };
        assert_eq!(a.apply([1.0, 1.0, 0.0, 0.0], 0.0)[2], 0.5);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LightKind {
    Point,
    Spot,
    /// Rectangular emitter approximated by the shaders as a soft spot.
    Rect,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Light {
    pub kind: LightKind,
    pub position: Vec3,
    pub direction: Vec3,
    /// Linear colour × intensity (candela-like units as authored).
    pub color: Vec3,
    pub range: f32,
    pub cos_outer: f32,
    pub cos_inner: f32,
    pub size: [f32; 2],
    /// Rect lights: the emitter's width axis (height axis = direction × right).
    #[serde(default)]
    pub right: Vec3,
    pub node: Option<u32>,
    pub cast_shadow: bool,
}

/// A light that scatters in the rain haze (and tints nearby drops).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FogLight {
    pub position: Vec3,
    pub color: Vec3,
    pub intensity: f32,
    pub radius: f32,
    pub spot: Option<(Vec3, f32, f32)>,
    /// Index into `Meta::fog_tracks`.
    pub track: Option<u32>,
}

// -------------------------------------------------------------- atmosphere

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Atmosphere {
    pub fog_color: Vec3,
    pub fog_density: f32,
    pub haze_density: f32,
    pub haze_ambient: Vec3,
    pub haze_ambient_density: f32,
    /// Dry interior box excluded from haze and rain.
    pub dry_min: Vec3,
    pub dry_max: Vec3,
    pub hemisphere_sky: Vec3,
    pub hemisphere_ground: Vec3,
    pub sky_zenith: Vec3,
    pub sky_horizon: Vec3,
    pub sky_glow: Vec3,
    pub environment: Option<u32>,
    pub environment_strength: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Rain {
    /// The place has rain: streaks, splashes, the wet film's rain factor.
    #[serde(default)]
    pub active: bool,
    pub dry_boxes: Vec<[Vec3; 2]>,
    pub drip_edges: Vec<[Vec3; 2]>,
    pub steam_vents: Vec<[Vec3; 2]>,
}

// --------------------------------------------------------------------- sun

/// A directional light evaluated per pixel with a shadow map, not baked.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sun {
    /// Direction towards the sun.
    pub direction: Vec3,
    /// Linear colour × intensity.
    pub radiance: Vec3,
    pub shadow: Option<SunShadow>,
}

/// The sun's orthographic shadow camera, as authored (three.js conventions).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SunShadow {
    /// Camera position; it looks along −`Sun::direction`.
    pub position: Vec3,
    /// left, right, bottom, top, near, far (metres, camera space).
    pub ortho: [f32; 6],
    pub map_size: u32,
    pub bias: f32,
    pub normal_bias: f32,
    /// Filter radius in shadow-map texels.
    pub radius: f32,
}

/// Daytime sky: a zenith/horizon gradient, the sun's glow and disc, and a
/// cloud panorama (two 180° halves side by side in v, rows by the square
/// root of elevation; R opacity, G sunlit / `cloud_sun`, B skylit).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DaySky {
    pub zenith: Vec3,
    pub horizon: Vec3,
    pub ground: Vec3,
    pub gradient_power: f32,
    pub ground_blend: f32,
    pub sun_direction: Vec3,
    pub sun_color: Vec3,
    pub glow: f32,
    /// (weight, exponent) of the wide and tight glow lobes.
    pub glow_wide: [f32; 2],
    pub glow_tight: [f32; 2],
    pub disc: f32,
    pub disc_cos_inner: f32,
    pub disc_cos_outer: f32,
    pub clouds: Option<u32>,
    /// Sunlit cloud colour (× the panorama's G) and skylit colour (× B).
    pub cloud_sun: Vec3,
    pub cloud_ambient: Vec3,
    pub fade_elevation: f32,
    /// Panorama turns per second.
    pub drift: f32,
    /// After sunset: afterglow, anti-twilight arch and the Earth's shadow.
    #[serde(default)]
    pub twilight: Option<Twilight>,
}

/// Twilight terms over the daytime sky (web `places/shared/sky.ts`), with
/// h the ray's elevation sine and a the cosine of its azimuth to the sun:
/// `band · e^(−|h|/height) · mix(1, ((a+1)/2)^sun_power, sun_bias)` along the
/// horizon, `belt · e^(−((h−elevation)/width)²) · ((1−a)/2)^power` opposite
/// the sun, and the sky scaled by `1 − strength · e^(−|h|/height) · ((1−a)/2)^power`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Twilight {
    pub band: TwilightBand,
    pub belt: TwilightBelt,
    pub shadow: TwilightShadow,
}

/// The afterglow along the horizon, strongest toward the sun's azimuth.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TwilightBand {
    pub color: Vec3,
    pub height: f32,
    pub sun_bias: f32,
    pub sun_power: f32,
}

/// The anti-twilight arch opposite the sun.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TwilightBelt {
    pub color: Vec3,
    pub elevation: f32,
    pub width: f32,
    pub power: f32,
}

/// The Earth's shadow under the arch.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TwilightShadow {
    pub strength: f32,
    pub height: f32,
    pub power: f32,
}

impl DaySky {
    /// The dome on the horizon (elevation 0) toward a horizontal direction
    /// whose azimuth cosine to the sun is `a` (`sky_day_f.cg` and the web's
    /// `places/shared/sky.ts` at h = 0; no clouds, no disc).
    pub fn horizon_at(&self, a: f32) -> Vec3 {
        let (base, sun) = self.horizon_parts(a);
        core::array::from_fn(|k| base[k] + sun[k])
    }

    /// [`DaySky::horizon_at`] in two parts, both under the Earth's shadow:
    /// the base (the gradient's horizon and the anti-twilight belt) and the
    /// sun side (the glow lobes and the afterglow band), which the vista
    /// haze weighs by its optical depth.
    pub fn horizon_parts(&self, a: f32) -> (Vec3, Vec3) {
        let a = a.clamp(-1.0, 1.0);
        let t = 1e-5f32.powf(self.gradient_power);
        let mut base: Vec3 = core::array::from_fn(|k| self.horizon[k] + (self.zenith[k] - self.horizon[k]) * t);
        let s = self.sun_direction;
        let mu = (a * (s[0] * s[0] + s[2] * s[2]).sqrt()).max(0.0);
        let lobe = |w: [f32; 2]| if mu > 0.0 { w[0] * mu.powf(w[1]) } else { 0.0 };
        let glow = self.glow * (lobe(self.glow_wide) + lobe(self.glow_tight));
        let mut sun: Vec3 = self.sun_color.map(|c| c * glow);
        if let Some(tw) = &self.twilight {
            let toward = (a + 1.0) * 0.5;
            let away = ((1.0 - a) * 0.5).max(0.0);
            let band = 1.0 + (toward.powf(tw.band.sun_power) - 1.0) * tw.band.sun_bias;
            let bz = tw.belt.elevation / tw.belt.width.max(1e-6);
            let belt = (-bz * bz).exp() * away.powf(tw.belt.power);
            let shadow = 1.0 - tw.shadow.strength * away.powf(tw.shadow.power);
            for k in 0..3 {
                base[k] = (base[k] + tw.belt.color[k] * belt) * shadow;
                sun[k] = (sun[k] + tw.band.color[k] * band) * shadow;
            }
        }
        (base, sun)
    }
}

// --------------------------------------------------------------- vista haze

/// Height-dependent haze under a temperature inversion (`dusk-vista`
/// places; web `places/shared/haze.ts`): extinction `ρ(y) = density` up to
/// the inversion top `inversion` (place y), `density · e^(−(y − inversion) /
/// scale)` above. Between the eye and a point d metres away the optical
/// depth is `d · (G(y_p) − G(y_e)) / (y_p − y_e)` with G the antiderivative
/// of ρ; a surface keeps `T = e^(−τ)` of its colour and gains
/// `(gain · (base + w · sun) + glow · ρ(y_p) / density) · (1 − T)`, with
/// base and sun the two parts of the sky on the horizon toward the point
/// ([`DaySky::horizon_parts`]) and `w = band + (1 − band) · (1 − T)`: the
/// afterglow's share grows with the optical depth, so far terrain meets the
/// sky in every azimuth. Additive surfaces and the light field take `T`
/// only. Replaces the uniform fog on every material that has fog.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct VistaHaze {
    pub density: f32,
    pub inversion: f32,
    pub scale: f32,
    pub gain: f32,
    pub glow: Vec3,
    /// Weight of the sky's sun side in the inscatter of clear air (`w` at
    /// T = 1; 1: the dome at any depth).
    #[serde(default = "one")]
    pub band: f32,
}

fn one() -> f32 {
    1.0
}

impl VistaHaze {
    /// Knots of [`VistaHaze::sky_tables`]: the horizon at
    /// `sqrt((1 − a) / 2) = k / (SKY_KNOTS − 1)` (finer toward the sun).
    pub const SKY_KNOTS: usize = 17;

    /// ρ(y) / ρ0.
    pub fn relative_density(&self, y: f32) -> f32 {
        if y <= self.inversion { 1.0 } else { (-(y - self.inversion) / self.scale.max(1e-3)).exp() }
    }

    /// G(y), the antiderivative of ρ.
    pub fn column(&self, y: f32) -> f32 {
        if y <= self.inversion {
            self.density * y
        } else {
            self.density * (self.inversion + self.scale * (1.0 - (-(y - self.inversion) / self.scale.max(1e-3)).exp()))
        }
    }

    /// T between the eye and a point.
    pub fn transmittance(&self, eye: Vec3, p: Vec3) -> f32 {
        let d = ((p[0] - eye[0]).powi(2) + (p[1] - eye[1]).powi(2) + (p[2] - eye[2]).powi(2)).sqrt();
        let dy = p[1] - eye[1];
        let tau = if dy.abs() < 0.01 { d * self.density * self.relative_density(eye[1]) } else { d * (self.column(p[1]) - self.column(eye[1])) / dy };
        (-tau.max(0.0)).exp()
    }

    /// `gain` × the two parts of the sky on the horizon at the knots (see
    /// `SKY_KNOTS`): the base, then the sun side; the renderer interpolates
    /// linearly between knots and adds `w` × the sun side. Without a day
    /// sky, the night sky's horizon colour as the base.
    pub fn sky_tables(&self, sky: Option<&DaySky>, night_horizon: Vec3) -> ([Vec3; Self::SKY_KNOTS], [Vec3; Self::SKY_KNOTS]) {
        let parts: [(Vec3, Vec3); Self::SKY_KNOTS] = core::array::from_fn(|k| {
            let u = k as f32 / (Self::SKY_KNOTS - 1) as f32;
            sky.map_or((night_horizon, [0.0; 3]), |s| s.horizon_parts(1.0 - 2.0 * u * u))
        });
        (core::array::from_fn(|k| parts[k].0.map(|x| x * self.gain)), core::array::from_fn(|k| parts[k].1.map(|x| x * self.gain)))
    }

    /// The sun side's weight at transmittance `t`.
    pub fn sun_weight(&self, t: f32) -> f32 {
        self.band + (1.0 - self.band) * (1.0 - t)
    }
}

#[cfg(test)]
mod haze_tests {
    use super::*;

    /// Griffith Observatory at blue hour (web `world/sky.ts`, `world/haze.ts`).
    fn blue_hour() -> DaySky {
        let (el, az) = ((-5.0f32).to_radians(), 280.1f32.to_radians());
        DaySky {
            zenith: [0.01, 0.025, 0.09],
            horizon: [0.09, 0.08, 0.14],
            ground: [0.02, 0.02, 0.03],
            gradient_power: 0.45,
            ground_blend: 6.0,
            sun_direction: [az.sin() * el.cos(), el.sin(), -az.cos() * el.cos()],
            sun_color: [0.5, 0.22, 0.08],
            glow: 0.4,
            glow_wide: [0.4, 3.0],
            glow_tight: [0.6, 24.0],
            disc: 0.0,
            disc_cos_inner: 1.0,
            disc_cos_outer: 1.0,
            clouds: None,
            cloud_sun: [0.0; 3],
            cloud_ambient: [0.0; 3],
            fade_elevation: 0.04,
            drift: 0.0,
            twilight: Some(Twilight {
                band: TwilightBand { color: [0.45, 0.17, 0.05], height: 0.08, sun_bias: 0.9, sun_power: 2.4 },
                belt: TwilightBelt { color: [0.08, 0.04, 0.07], elevation: 0.12, width: 0.09, power: 1.5 },
                shadow: TwilightShadow { strength: 0.35, height: 0.07, power: 1.6 },
            }),
        }
    }

    const HAZE: VistaHaze = VistaHaze { density: 1.2e-4, inversion: -60.0, scale: 120.0, gain: 1.0, glow: [0.01, 0.009, 0.007], band: 1.0 };

    #[test]
    fn transmittance_in_and_above_the_layer() {
        // Level inside the layer: e^(−ρ0 d).
        let t = HAZE.transmittance([0.0, -100.0, 0.0], [10_000.0, -100.0, 0.0]);
        assert!((t - (-1.2f32).exp()).abs() < 1e-5, "{t}");
        // From the terrace (above the inversion) down to the basin floor
        // 20 km away: the column from −300 m to +2 m over the drop.
        let (eye, p) = ([0.0, 2.0, 0.0], [0.0, -300.0, 20_000.0]);
        let d = (20_000.0f32.powi(2) + 302.0f32.powi(2)).sqrt();
        let g = |y: f32| if y <= -60.0 { 1.2e-4 * y } else { 1.2e-4 * (-60.0 + 120.0 * (1.0 - (-(y + 60.0) / 120.0).exp())) };
        let want = (-(d * (g(-300.0) - g(2.0)) / -302.0)).exp();
        assert!((HAZE.transmittance(eye, p) - want).abs() < 1e-5);
        // Continuous across the |dy| < 1 cm branch.
        let a = HAZE.transmittance([0.0, 10.0, 0.0], [5000.0, 10.009, 0.0]);
        let b = HAZE.transmittance([0.0, 10.0, 0.0], [5000.0, 10.011, 0.0]);
        assert!((a - b).abs() < 1e-4, "{a} {b}");
        assert_eq!(HAZE.relative_density(-61.0), 1.0);
        assert!((HAZE.relative_density(60.0) - (-1.0f32).exp()).abs() < 1e-6);
    }

    #[test]
    fn horizon_matches_the_web_dome() {
        let sky = blue_hour();
        // Opposite the sun: no lobes; band × (1 − bias); belt; shadow.
        let c = sky.horizon_at(-1.0);
        let base = 0.09 + (0.01 - 0.09) * 1e-5f32.powf(0.45);
        let belt = (-(0.12f32 / 0.09).powi(2)).exp() * 0.08;
        let want = (base + 0.45 * 0.1 + belt) * (1.0 - 0.35);
        assert!((c[0] - want).abs() < 1e-5, "{} {want}", c[0]);
        // Toward the sun the afterglow band and the glow lobes add up.
        assert!(sky.horizon_at(1.0)[0] > 0.5);
    }

    #[test]
    fn parts_split_the_dome() {
        let sky = blue_hour();
        // Toward the sun (a = 1): mu = |sun.xz|, toward = 1, away = 0.
        let s = sky.sun_direction;
        let mu = (s[0] * s[0] + s[2] * s[2]).sqrt();
        let base = 0.09 + (0.01 - 0.09) * 1e-5f32.powf(0.45);
        let sun = 0.5 * 0.4 * (0.4 * mu.powf(3.0) + 0.6 * mu.powf(24.0)) + 0.45;
        let (b, u) = sky.horizon_parts(1.0);
        assert!((b[0] - base).abs() < 1e-6 && (u[0] - sun).abs() < 1e-5, "{b:?} {u:?}");
        // Opposite the sun: the belt in the base, the band's floor on the
        // sun side, both under the Earth's shadow.
        let belt = (-(0.12f32 / 0.09).powi(2)).exp() * 0.08;
        let (b, u) = sky.horizon_parts(-1.0);
        assert!((b[0] - (base + belt) * 0.65).abs() < 1e-6 && (u[0] - 0.45 * 0.1 * 0.65).abs() < 1e-6);
        // The parts add up to the dome.
        let (b, u) = sky.horizon_parts(0.3);
        let d = sky.horizon_at(0.3);
        assert!((0..3).all(|k| (b[k] + u[k] - d[k]).abs() < 1e-6));
        // Griffith: w runs from `band` in clear air to 1 at full depth, so
        // gain 1 without glow meets the dome where T → 0.
        let griffith = VistaHaze { density: 1.6e-4, inversion: -60.0, scale: 60.0, gain: 1.0, glow: [0.0; 3], band: 0.25 };
        assert_eq!((griffith.sun_weight(1.0), griffith.sun_weight(0.0)), (0.25, 1.0));
        assert!((griffith.sun_weight(0.6) - 0.55).abs() < 1e-6);
        let (ta, tb) = VistaHaze { gain: 1.25, ..griffith }.sky_tables(Some(&sky), [0.0; 3]);
        let (b, u) = sky.horizon_parts(1.0);
        assert!((ta[0][1] - 1.25 * b[1]).abs() < 1e-6 && (tb[0][1] - 1.25 * u[1]).abs() < 1e-6);
        // Absent from older packs, `band` reads as 1.
        let h: VistaHaze = serde_json::from_str(r#"{"density":1e-4,"inversion":0,"scale":50,"gain":1,"glow":[0,0,0]}"#).unwrap();
        assert_eq!(h.band, 1.0);
    }

    #[test]
    fn sky_table_interpolates_within_two_percent() {
        let sky = blue_hour();
        let (base, sun) = HAZE.sky_tables(Some(&sky), [0.0; 3]);
        let n = (VistaHaze::SKY_KNOTS - 1) as f32;
        let mut worst = 0.0f32;
        for i in 0..=720 {
            let theta = i as f32 / 720.0 * core::f32::consts::PI;
            let a = theta.cos();
            let u = ((1.0 - a) * 0.5).max(0.0).sqrt() * n;
            let k = (u.floor() as usize).min(VistaHaze::SKY_KNOTS - 2);
            let f = u - k as f32;
            let exact = sky.horizon_at(a);
            for c in 0..3 {
                let at = |t: &[Vec3; VistaHaze::SKY_KNOTS]| t[k][c] + (t[k + 1][c] - t[k][c]) * f;
                let lerp = at(&base) + at(&sun);
                // Relative to the brightest channel at that azimuth.
                let peak = exact[0].max(exact[1]).max(exact[2]);
                worst = worst.max((lerp - exact[c]).abs() / peak);
            }
        }
        assert!(worst < 0.02, "worst {worst}");
    }
}

// -------------------------------------------------------------------- post

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToneCurve {
    Agx,
    Aces,
}

/// Tone mapping and grade after the scene (the web's grade effect), and bloom.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Post {
    pub tone: ToneCurve,
    pub exposure: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub lift: Vec3,
    pub gain: Vec3,
    /// Darkening at the corners (1 − vignette at full strength).
    pub vignette: f32,
    pub grain: f32,
    pub bloom_threshold: f32,
    pub bloom_smoothing: f32,
    pub bloom_intensity: f32,
}

impl Default for Post {
    /// The first place's look (Rainy Night Konbini), as the renderer had it
    /// before places carried their own.
    fn default() -> Self {
        Self {
            tone: ToneCurve::Agx,
            exposure: 1.0,
            contrast: 1.16,
            saturation: 1.18,
            lift: [0.1, 0.35, 0.45],
            gain: [1.04, 0.99, 0.94],
            vignette: 0.2475,
            grain: 0.03,
            bloom_threshold: 1.1,
            bloom_smoothing: 0.4,
            bloom_intensity: 0.85,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShotKey {
    pub pos: Vec3,
    pub target: Vec3,
    pub fov: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shot {
    pub name: String,
    pub from: ShotKey,
    pub to: ShotKey,
    pub duration: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CameraSet {
    pub shots: Vec<Shot>,
    /// [min.xyz, max.xyz] boxes the free camera may occupy.
    pub walkable: Vec<[f32; 6]>,
    pub intro: ShotKey,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Doors {
    pub left: u32,
    pub right: u32,
    pub travel: f32,
    pub trigger: Vec3,
    pub radius: f32,
}

/// Tileable lookup textures baked by the cooker for effects that would
/// otherwise evaluate noise per pixel.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Effects {
    /// RG: puddle field and detail noise; one tile per puddle-UV unit.
    pub puddles: Option<u32>,
    /// Rain-ripple flipbook: `ripple_grid`² frames, RG = normal offset.
    pub ripples: Option<u32>,
    pub ripple_grid: u32,
    /// World metres covered by one ripple frame.
    pub ripple_tile: f32,
    /// Static glass beads for a 1 m tile: RG = normal offset, B = coverage.
    pub beads: Option<u32>,
    /// Cloud deck: R, G = two fbm fields periodic over `cloud_cells` cells.
    pub clouds: Option<u32>,
    pub cloud_cells: f32,
}


impl LightPoint {
    /// World bounds over its path.
    pub fn bounds(&self) -> (Vec3, Vec3) {
        let end: Vec3 = core::array::from_fn(|k| self.position[k] + self.path[k]);
        (core::array::from_fn(|k| self.position[k].min(end[k])), core::array::from_fn(|k| self.position[k].max(end[k])))
    }
}
