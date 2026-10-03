//! Derived state of the optional display-referred float vertex path.
//!
//! This does not change PLCE or its materials. The color baker has already
//! applied base RGB, lighting, AO, metalness, vertex RGB and static emission.
//! Only values still read by `color_f` / its static float vertex shader belong
//! in this key. Cooker and runtime use the same derivation before sharing a
//! page across original materials. Approximation flags remain per source draw.
use crate::{Blend, Draw, Kind, Meta, TexFormat, TexRole, UvAnim, VertexLayout};
use num_traits::Float;
use serde::{Deserialize, Serialize};

pub const FRAME_ZERO_LIGHTING: u32 = 1;
pub const SHARED_EMISSION_APPROX: u32 = 2;
pub const GOURAUD_SUN: u32 = 4;
pub const INDEPENDENT_EMISSION: u32 = 8;
pub const PLANAR_WET: u32 = 16;
pub const GLASS_DIFFUSE: u32 = 32;
pub const PRODUCTS_APPEARANCE: u32 = 64;
pub const ALL_FLAGS: u32 = 127;
pub const RUNTIME_FLAGS: u32 = INDEPENDENT_EMISSION | PLANAR_WET | GLASS_DIFFUSE;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fog {
    None,
    Vertex,
    /// The current runtime evaluates haze at each source draw's center.
    /// A shared page is valid, but these draws must still submit separately.
    Vista,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Emission {
    pub texture: u32,
    /// Linear radiance, graded using the scene's post settings at runtime.
    pub radiance: [f32; 3],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wet {
    /// Puddle coverage, display darkening, wet roughness multiplier, ripple.
    pub params: [f32; 4],
    pub inverse_puddle_scale: f32,
    /// Authored roughness multiplied by the ORM map's mean green channel.
    pub roughness: f32,
}

/// All float pages are static, opaque, depth-writing standard/unlit surfaces.
/// Glass, dynamic geometry and transparent sorting retain their original VAO.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub texture: Option<u32>,
    /// (base opacity, discard threshold). Opacity is unused for opaque output
    /// without alpha testing, so it must not divide those pages unnecessarily.
    pub alpha: Option<[f32; 2]>,
    pub fog: Fog,
    pub cull: bool,
    pub polygon_offset: Option<[f32; 2]>,
    pub uv_anim: Option<UvAnim>,
    pub emission: Option<Emission>,
    pub wet: Option<Wet>,
}

fn canonical(v: f32) -> f32 {
    if v == 0.0 {
        0.0
    } else {
        v
    }
}

impl State {
    pub fn for_draw(
        meta: &Meta,
        draw: &Draw,
        texture: Option<u32>,
        flags: u32,
    ) -> Result<Self, &'static str> {
        let m = meta
            .materials
            .get(draw.material as usize)
            .ok_or("display material reference")?;
        if draw.node.is_some()
            || draw.skin.is_some()
            || !matches!(draw.layout, VertexLayout::Static | VertexLayout::Baked)
            || !(matches!(m.kind, Kind::Standard | Kind::Unlit)
                || (m.kind == Kind::Products && flags == PRODUCTS_APPEARANCE))
            || m.blend != Blend::Opaque
            || !m.depth_write
            || flags & !ALL_FLAGS != 0
            || flags & GLASS_DIFFUSE != 0
            || m.emissive_track.is_some()
        {
            return Err("display state requires static opaque color geometry");
        }
        if flags & PRODUCTS_APPEARANCE != 0
            && (m.kind != Kind::Products
                || flags != PRODUCTS_APPEARANCE
                || texture.is_none()
                || m.uv_anim.is_some()
                || m.alpha_test > 0.0
                || m.wet.is_some()
                || m.emission.is_some()
                || m.emission_shade.is_some())
        {
            return Err("display Products appearance contract");
        }
        let color_texture = |index: u32| {
            meta.textures
                .get(index as usize)
                .is_some_and(|t| t.format == TexFormat::Rgba8 && t.role == TexRole::Color)
        };
        if texture.is_some_and(|i| !color_texture(i)) {
            return Err("display state color texture reference");
        }
        let emission = if flags & INDEPENDENT_EMISSION != 0 {
            if m.kind != Kind::Standard || m.emission_shade.is_some() || texture != m.albedo {
                return Err("display independent emission contract");
            }
            let index = m.emission.ok_or("display emission texture missing")?;
            if !color_texture(index) || m.emissive.iter().any(|v| !v.is_finite()) {
                return Err("display emission texture/radiance");
            }
            Some(Emission {
                texture: index,
                radiance: m.emissive.map(canonical),
            })
        } else {
            None
        };
        if (flags & PLANAR_WET != 0) != m.wet.is_some() {
            return Err("display wet flag mismatch");
        }
        let wet = if let Some(w) = &m.wet {
            if m.kind != Kind::Standard || draw.layout != VertexLayout::Baked || !w.planar {
                return Err("display wet requires static baked planar geometry");
            }
            if [
                w.puddles,
                w.darken,
                w.roughness,
                w.ripple,
                w.puddle_scale,
                m.roughness,
            ]
            .iter()
            .any(|v| !v.is_finite())
            {
                return Err("non-finite display wet material");
            }
            let mean = match m.orm {
                Some(i) => {
                    meta.textures
                        .get(i as usize)
                        .ok_or("display ORM reference")?
                        .mean[1]
                }
                None => 1.0,
            };
            let wet = Wet {
                params: [
                    w.puddles,
                    Float::sqrt(w.darken.max(0.0)),
                    w.roughness,
                    w.ripple,
                ]
                .map(canonical),
                inverse_puddle_scale: 1.0 / w.puddle_scale.max(0.01),
                roughness: canonical(m.roughness * mean),
            };
            if wet
                .params
                .iter()
                .chain([&wet.inverse_puddle_scale, &wet.roughness])
                .any(|v| !v.is_finite())
            {
                return Err("non-finite display wet state");
            }
            Some(wet)
        } else {
            None
        };
        if !m.alpha_test.is_finite()
            || !m.color[3].is_finite()
            || m.polygon_offset
                .is_some_and(|v| v.iter().any(|x| !x.is_finite()))
            || m.uv_anim.is_some_and(|a| {
                [a.fps, a.phase, a.scroll[0], a.scroll[1]]
                    .iter()
                    .any(|x| !x.is_finite())
            })
        {
            return Err("non-finite display state");
        }
        Ok(Self {
            texture,
            alpha: (m.alpha_test > 0.0).then_some([canonical(m.color[3]), m.alpha_test]),
            fog: if !m.fog || m.interior {
                Fog::None
            } else if meta.vista_haze.is_some() {
                Fog::Vista
            } else {
                Fog::Vertex
            },
            cull: !m.double_sided,
            polygon_offset: m.polygon_offset.map(|v| v.map(canonical)),
            uv_anim: if texture.is_some() || emission.is_some() {
                m.uv_anim.map(|mut a| {
                    a.fps = canonical(a.fps);
                    a.phase = canonical(a.phase);
                    a.scroll = a.scroll.map(canonical);
                    a
                })
            } else {
                None
            },
            emission,
            wet,
        })
    }
}
