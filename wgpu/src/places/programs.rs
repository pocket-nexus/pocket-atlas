//! The programs of a place: WGSL sources run through a small preprocessor,
//! and the pipelines made from them the first time a draw needs one.
//!
//! The PS Vita compiles one Cg program per set of definitions (864 for the
//! seven places). Here a variant is keyed the same way, by its source and its
//! definitions, but several of the PS Vita's dimensions are values of a draw
//! instead of definitions: the number of lights (a loop bound in the draw's
//! constants), the reduced tiers for far and light draws (every draw takes
//! the full program) and lights per vertex (every draw lights per pixel). A
//! pipeline is a variant with a vertex layout, a blend, a cull side, a depth
//! mode and a target.

use std::collections::HashMap;

use pocket_web_wgpu::gpu::Gpu;
use pocket_web_wgpu::wgpu::{self, TextureFormat};

const COMMON: &str = include_str!("../shaders/place/common.wgsl");
const SURFACE_VS: &str = include_str!("../shaders/place/surface_vs.wgsl");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Program {
    Standard,
    Unlit,
    Glass,
    Window,
    Products,
    Skyline,
    Tower,
    Water,
    /// A caster in a sun map: depth alone, no fragment stage.
    Shadow,
    /// A cut-out caster: its fragment stage discards.
    ShadowCut,
    Sky,
    Lights,
    Fx,
    Post,
    /// The static sun map from its four samples a texel.
    SunResolve,
}

impl Program {
    fn source(self) -> String {
        let surface = |fragment: &str| format!("{COMMON}\n{SURFACE_VS}\n{fragment}");
        match self {
            Program::Standard => surface(include_str!("../shaders/place/standard.wgsl")),
            Program::Unlit => surface(include_str!("../shaders/place/unlit.wgsl")),
            Program::Glass => surface(include_str!("../shaders/place/glass.wgsl")),
            Program::Window => surface(include_str!("../shaders/place/window.wgsl")),
            Program::Products => surface(include_str!("../shaders/place/products.wgsl")),
            Program::Skyline => surface(include_str!("../shaders/place/skyline.wgsl")),
            Program::Tower => surface(include_str!("../shaders/place/tower.wgsl")),
            Program::Water => surface(include_str!("../shaders/place/water.wgsl")),
            Program::Shadow => surface(""),
            Program::ShadowCut => surface(include_str!("../shaders/place/shadow.wgsl")),
            Program::Sky => format!("{COMMON}\n{}", include_str!("../shaders/place/sky.wgsl")),
            Program::Lights => format!("{COMMON}\n{}", include_str!("../shaders/place/lights.wgsl")),
            Program::Fx => format!("{COMMON}\n{}", include_str!("../shaders/place/fx.wgsl")),
            Program::Post => include_str!("../shaders/place/post.wgsl").to_string(),
            Program::SunResolve => include_str!("../shaders/place/sun_resolve.wgsl").to_string(),
        }
    }
}

/// The vertex buffers a pipeline reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Layout {
    /// 24 bytes: position s16n x 4, normal s8n x 4, tangent s8n x 4, uv s16n x 2, colour u8n x 4.
    Static,
    /// Static, then joints u8 x 4 and weights u8n x 4 (32 bytes).
    Skinned,
    /// Static, then the baked irradiance as square-root RGBM u8n x 4 (28 bytes).
    Baked,
    /// One light of a field to an instance (40 bytes).
    Lights,
    /// A particle's corner: seed u16n x 4, corner f32 x 2, two points f32 x 3 (40 bytes).
    Fx,
    /// No buffer: a triangle over the whole target from the vertex index.
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Blend {
    Opaque,
    Alpha,
    Premultiplied,
    Additive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cull {
    None,
    Back,
    Front,
}

/// Depth runs 1 (near) to 0 (infinity) in a scene; a sun map runs 0 to 1 away from the sun.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Depth {
    None,
    Test,
    TestWrite,
    /// A sun map: nearer the sun wins.
    Sun,
    /// The fragment stage's depth, written whatever is there.
    Fill,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    pub program: Program,
    pub defines: Vec<&'static str>,
    pub layout: Layout,
    pub blend: Blend,
    pub cull: Cull,
    pub depth: Depth,
    /// Slope and constant depth bias (a decal over its wall).
    pub bias: (i32, i32),
    /// The colour target; `None` for a sun map.
    pub format: Option<TextureFormat>,
    pub samples: u32,
}

/// Runs `source` through the preprocessor with `defines` set. Directives, one to a line: `#ifdef A`,
/// `#ifndef A`, `#if` with `defined(A)`, `!`, `&&`, `||` and brackets, `#else`, `#endif`, `#define A`,
/// `#undef A`. A line of a branch not taken is left out.
pub fn preprocess(source: &str, defines: &[&str]) -> Result<String, String> {
    let mut set: Vec<String> = defines.iter().map(|d| d.to_string()).collect();
    // One entry an open #if: (the branch being read is taken, a branch of it was taken, the lines around it are).
    let mut open: Vec<(bool, bool, bool)> = Vec::new();
    let mut out = String::with_capacity(source.len());
    for (number, line) in source.lines().enumerate() {
        let trimmed = line.trim_start();
        let live = open.last().map_or(true, |o| o.0);
        let Some(directive) = trimmed.strip_prefix('#') else {
            if live {
                out.push_str(line);
            }
            // (every line keeps its number, for a compiler's message)
            out.push('\n');
            continue;
        };
        let (word, rest) = directive.split_once(char::is_whitespace).unwrap_or((directive, ""));
        let rest = rest.trim();
        match word {
            "ifdef" | "ifndef" | "if" => {
                let truth = match word {
                    "ifdef" => set.iter().any(|d| d == rest),
                    "ifndef" => !set.iter().any(|d| d == rest),
                    _ => condition(rest, &set).map_err(|e| format!("line {}: {e}", number + 1))?,
                };
                open.push((live && truth, truth, live));
            }
            "else" => {
                let o = open.last_mut().ok_or_else(|| format!("line {}: #else without #if", number + 1))?;
                *o = (o.2 && !o.1, true, o.2);
            }
            "endif" => {
                open.pop().ok_or_else(|| format!("line {}: #endif without #if", number + 1))?;
            }
            "define" if live => {
                if !set.iter().any(|d| d == rest) {
                    set.push(rest.to_string());
                }
            }
            "undef" if live => set.retain(|d| d != rest),
            "define" | "undef" => {}
            other => return Err(format!("line {}: #{other} is not a directive", number + 1)),
        }
        out.push('\n');
    }
    if !open.is_empty() {
        return Err("an #if is not closed".into());
    }
    Ok(out)
}

/// `defined(A) && !defined(B) || (C)`: a bare name is `defined(name)`.
fn condition(text: &str, set: &[String]) -> Result<bool, String> {
    fn tokens(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut chars = text.chars().peekable();
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() {
                chars.next();
            } else if c.is_alphanumeric() || c == '_' {
                let mut word = String::new();
                while let Some(&c) = chars.peek().filter(|c| c.is_alphanumeric() || **c == '_') {
                    word.push(c);
                    chars.next();
                }
                out.push(word);
            } else if c == '&' || c == '|' {
                chars.next();
                chars.next();
                out.push(if c == '&' { "&&" } else { "||" }.to_string());
            } else {
                out.push(c.to_string());
                chars.next();
            }
        }
        out
    }
    fn atom(t: &[String], at: &mut usize, set: &[String]) -> Result<bool, String> {
        let token = t.get(*at).ok_or("a condition ends too soon")?.as_str();
        *at += 1;
        match token {
            "!" => Ok(!atom(t, at, set)?),
            "(" => {
                let value = either(t, at, set)?;
                *at += 1;
                Ok(value)
            }
            "defined" => {
                // defined ( NAME )
                let name = t.get(*at + 1).ok_or("defined() has no name")?;
                *at += 3;
                Ok(set.iter().any(|d| d == name))
            }
            name => Ok(set.iter().any(|d| d == name)),
        }
    }
    fn both(t: &[String], at: &mut usize, set: &[String]) -> Result<bool, String> {
        let mut value = atom(t, at, set)?;
        while t.get(*at).is_some_and(|x| x == "&&") {
            *at += 1;
            value &= atom(t, at, set)?;
        }
        Ok(value)
    }
    fn either(t: &[String], at: &mut usize, set: &[String]) -> Result<bool, String> {
        let mut value = both(t, at, set)?;
        while t.get(*at).is_some_and(|x| x == "||") {
            *at += 1;
            value |= both(t, at, set)?;
        }
        Ok(value)
    }
    let t = tokens(text);
    let mut at = 0;
    let value = either(&t, &mut at, set)?;
    if at != t.len() {
        return Err(format!("a condition does not end where it should: {text}"));
    }
    Ok(value)
}

/// The three groups every program but the screen passes binds: the pass (its constants and the textures of
/// the whole frame), the material's textures, the draw (its constants and its bones).
pub struct Groups {
    pub pass: wgpu::BindGroupLayout,
    pub material: wgpu::BindGroupLayout,
    pub draw: wgpu::BindGroupLayout,
    pub post: wgpu::BindGroupLayout,
    /// The sun map's samples, for [`Program::SunResolve`].
    pub resolve: wgpu::BindGroupLayout,
    surface: wgpu::PipelineLayout,
    screen: wgpu::PipelineLayout,
    resolving: wgpu::PipelineLayout,
}

/// Bytes of a draw's constants (`Draw` in common.wgsl) and of a skin's bones.
pub const DRAW_BYTES: u64 = 39 * 16;
pub const BONES_BYTES: u64 = 72 * 16;

impl Groups {
    pub fn new(gpu: &Gpu) -> Groups {
        let device = &gpu.device;
        let texture = |binding, sample_type| wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Texture { sample_type, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None };
        let float = wgpu::TextureSampleType::Float { filterable: true };
        let sampler = |binding, ty| wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Sampler(ty), count: None };
        let filtering = wgpu::SamplerBindingType::Filtering;
        let uniform = |binding, dynamic, bytes: u64| wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: dynamic, min_binding_size: wgpu::BufferSize::new(bytes) }, count: None };
        let layout = |label, entries: &[wgpu::BindGroupLayoutEntry]| device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries });
        let pass = layout(
            "place pass",
            &[
                uniform(0, false, 0),
                texture(1, float),
                texture(2, float),
                texture(3, float),
                texture(4, float),
                texture(5, float),
                texture(6, wgpu::TextureSampleType::Depth),
                texture(7, wgpu::TextureSampleType::Depth),
                texture(8, float),
                texture(9, float),
                sampler(10, filtering),
                sampler(11, filtering),
                sampler(12, wgpu::SamplerBindingType::Comparison),
            ],
        );
        let material = layout("place material", &[texture(0, float), texture(1, float), texture(2, float), texture(3, float), sampler(4, filtering), sampler(5, filtering), sampler(6, filtering), sampler(7, filtering)]);
        let draw = layout("place draw", &[uniform(0, true, DRAW_BYTES), uniform(1, true, BONES_BYTES)]);
        let post = layout("place screen pass", &[uniform(0, false, 0), texture(1, float), texture(2, float), texture(3, float), texture(4, float), texture(5, float), sampler(6, filtering), sampler(7, filtering), sampler(8, filtering)]);
        let surface = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("place"), bind_group_layouts: &[&pass, &material, &draw], push_constant_ranges: &[] });
        let screen = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("place screen pass"), bind_group_layouts: &[&post], push_constant_ranges: &[] });
        let resolve = layout("place sun map samples", &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2, multisampled: true }, count: None }]);
        let resolving = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("place sun map samples"), bind_group_layouts: &[&resolve], push_constant_ranges: &[] });
        Groups { pass, material, draw, post, resolve, surface, screen, resolving }
    }
}

/// The pipelines made so far, and the modules they were made from.
#[derive(Default)]
pub struct Programs {
    modules: HashMap<(Program, Vec<&'static str>), wgpu::ShaderModule>,
    pipelines: HashMap<Key, usize>,
    made: Vec<wgpu::RenderPipeline>,
}

/// The depth buffer of a scene target and of a sun map.
pub const DEPTH: TextureFormat = TextureFormat::Depth32Float;

impl Programs {
    /// Variants compiled, and pipelines made from them.
    pub fn counts(&self) -> (usize, usize) {
        (self.modules.len(), self.made.len())
    }

    pub fn get(&self, index: usize) -> &wgpu::RenderPipeline {
        &self.made[index]
    }

    /// The pipeline of `key`, made now if no draw has needed it before.
    pub fn pipeline(&mut self, gpu: &Gpu, groups: &Groups, key: &Key) -> Result<usize, String> {
        if let Some(&index) = self.pipelines.get(key) {
            return Ok(index);
        }
        let device = &gpu.device;
        let variant = (key.program, key.defines.clone());
        if !self.modules.contains_key(&variant) {
            let source = preprocess(&key.program.source(), &key.defines).map_err(|e| format!("{:?}: {e}", key.program))?;
            let label = format!("{:?}{:?}", key.program, key.defines);
            self.modules.insert(variant.clone(), device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(&label), source: wgpu::ShaderSource::Wgsl(source.into()) }));
        }
        let module = &self.modules[&variant];
        let vertex = wgpu::VertexStepMode::Vertex;
        // Positions and texture coordinates are signed 16-bit normalised in the pack and bound as integers:
        // `s16n2` and `s16n4` in common.wgsl say why.
        let surface = wgpu::vertex_attr_array![0 => Sint16x4, 1 => Snorm8x4, 2 => Snorm8x4, 3 => Sint16x2, 4 => Unorm8x4];
        let skinned = wgpu::vertex_attr_array![0 => Sint16x4, 1 => Snorm8x4, 2 => Snorm8x4, 3 => Sint16x2, 4 => Unorm8x4, 5 => Uint8x4, 6 => Unorm8x4];
        let baked = wgpu::vertex_attr_array![0 => Sint16x4, 1 => Snorm8x4, 2 => Snorm8x4, 3 => Sint16x2, 4 => Unorm8x4, 5 => Unorm8x4];
        // (a light's record: position and phase, colour and twinkle, intensity and radius, path and cycles, blink)
        let lights = [
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Sint16x4, offset: 0, shader_location: 0 },
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Unorm8x4, offset: 8, shader_location: 1 },
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 12, shader_location: 2 },
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 20, shader_location: 3 },
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Uint8x4, offset: 36, shader_location: 4 },
        ];
        let fx = wgpu::vertex_attr_array![0 => Unorm16x4, 1 => Float32x2, 2 => Float32x3, 3 => Float32x3];
        let buffers: Vec<wgpu::VertexBufferLayout> = match key.layout {
            Layout::Static => vec![wgpu::VertexBufferLayout { array_stride: 24, step_mode: vertex, attributes: &surface }],
            Layout::Skinned => vec![wgpu::VertexBufferLayout { array_stride: 32, step_mode: vertex, attributes: &skinned }],
            Layout::Baked => vec![wgpu::VertexBufferLayout { array_stride: 28, step_mode: vertex, attributes: &baked }],
            Layout::Lights => vec![wgpu::VertexBufferLayout { array_stride: 40, step_mode: wgpu::VertexStepMode::Instance, attributes: &lights }],
            Layout::Fx => vec![wgpu::VertexBufferLayout { array_stride: 40, step_mode: vertex, attributes: &fx }],
            Layout::None => vec![],
        };
        // The destination's alpha is the eye distance: a blended draw leaves it as it is.
        let keep = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
        let colour = |src_factor, dst_factor| Some(wgpu::BlendState { color: wgpu::BlendComponent { src_factor, dst_factor, operation: wgpu::BlendOperation::Add }, alpha: keep });
        let blend = match key.blend {
            Blend::Opaque => None,
            Blend::Alpha => colour(wgpu::BlendFactor::SrcAlpha, wgpu::BlendFactor::OneMinusSrcAlpha),
            Blend::Premultiplied => colour(wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrcAlpha),
            Blend::Additive => colour(wgpu::BlendFactor::One, wgpu::BlendFactor::One),
        };
        let targets = [key.format.map(|format| wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })];
        let has_fragment = key.program != Program::Shadow;
        let depth = |write, compare| Some(wgpu::DepthStencilState { format: DEPTH, depth_write_enabled: write, depth_compare: compare, stencil: Default::default(), bias: wgpu::DepthBiasState { constant: key.bias.1, slope_scale: key.bias.0 as f32, clamp: 0.0 } });
        // On the build machine a pipeline that does not validate says why here; a tab's device reports it to
        // the page's console.
        #[cfg(not(target_arch = "wasm32"))]
        device.push_error_scope(wgpu::ErrorFilter::Validation);
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(&format!("{:?}{:?}", key.program, key.defines)),
            layout: Some(match key.program {
                Program::Post => &groups.screen,
                Program::SunResolve => &groups.resolving,
                _ => &groups.surface,
            }),
            vertex: wgpu::VertexState { module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &buffers },
            fragment: has_fragment.then(|| wgpu::FragmentState { module, entry_point: Some("fs"), compilation_options: Default::default(), targets: if key.format.is_some() { &targets } else { &[] } }),
            primitive: wgpu::PrimitiveState {
                topology: if key.layout == Layout::Lights { wgpu::PrimitiveTopology::TriangleStrip } else { wgpu::PrimitiveTopology::TriangleList },
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: match key.cull {
                    Cull::None => None,
                    Cull::Back => Some(wgpu::Face::Back),
                    Cull::Front => Some(wgpu::Face::Front),
                },
                ..Default::default()
            },
            depth_stencil: match key.depth {
                Depth::None => None,
                Depth::Test => depth(false, wgpu::CompareFunction::GreaterEqual),
                Depth::TestWrite => depth(true, wgpu::CompareFunction::GreaterEqual),
                Depth::Sun => depth(true, wgpu::CompareFunction::LessEqual),
                Depth::Fill => depth(true, wgpu::CompareFunction::Always),
            },
            multisample: wgpu::MultisampleState { count: key.samples, ..Default::default() },
            multiview: None,
            cache: None,
        });
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(error) = pocket_web_wgpu::task::wait(device.pop_error_scope()) {
            return Err(format!("{:?} {:?}: {error}", key.program, key.defines));
        }
        self.made.push(pipeline);
        self.pipelines.insert(key.clone(), self.made.len() - 1);
        Ok(self.made.len() - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_keeps_the_branches_its_definitions_take() {
        let source = "a\n#ifdef X\nx\n#else\nnot x\n#endif\n#ifndef Y\nno y\n#endif\n#if defined(X) && !defined(Y) || (Z)\nboth\n#endif\nz";
        let lines = |defines: &[&str]| preprocess(source, defines).unwrap().lines().filter(|l| !l.is_empty()).map(String::from).collect::<Vec<_>>();
        assert_eq!(lines(&[]), ["a", "not x", "no y", "z"]);
        assert_eq!(lines(&["X"]), ["a", "x", "no y", "both", "z"]);
        assert_eq!(lines(&["X", "Y"]), ["a", "x", "z"]);
        assert_eq!(lines(&["Y", "Z"]), ["a", "not x", "both", "z"]);
        // Every line keeps its number.
        assert_eq!(preprocess(source, &[]).unwrap().lines().count(), source.lines().count());
        // A definition made or taken back in a branch that is read.
        let source = "#ifdef R\n#undef W\n#define N\n#endif\n#ifdef W\nwet\n#endif\n#ifdef N\nplain\n#endif\n#ifdef A\n#ifdef B\nab\n#else\na\n#endif\n#endif";
        let lines = |defines: &[&str]| preprocess(source, defines).unwrap().lines().filter(|l| !l.is_empty()).map(String::from).collect::<Vec<_>>();
        assert_eq!(lines(&["W"]), ["wet"]);
        assert_eq!(lines(&["W", "R"]), ["plain"]);
        assert_eq!(lines(&["A"]), ["a"]);
        assert_eq!(lines(&["B"]), [] as [&str; 0]);
        assert_eq!(lines(&["A", "B"]), ["ab"]);
        assert!(preprocess("#ifdef A\n", &[]).is_err());
        assert!(preprocess("#endif\n", &[]).is_err());
        assert!(preprocess("#pragma once\n", &[]).is_err());
    }

    /// Every program's source parses and validates with every definition a place can give it. (naga, on this
    /// machine; a browser's compiler reads the same text.)
    #[test]
    fn every_program_compiles() {
        use pocket_web_wgpu::task;
        let gpu = match task::wait(Gpu::headless()) {
            Ok(gpu) => gpu,
            Err(why) => {
                eprintln!("skipped: {why}");
                return;
            }
        };
        let groups = Groups::new(&gpu);
        let mut programs = Programs::default();
        let hdr = Some(TextureFormat::Rgba16Float);
        let mut make = |program, defines: &[&'static str], layout, format: Option<TextureFormat>, depth| {
            let mut defines = defines.to_vec();
            match layout {
                Layout::Skinned => defines.push("SKINNED"),
                Layout::Baked => defines.push("BAKED"),
                _ => {}
            }
            defines.sort();
            gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
            let key = Key { program, defines: defines.clone(), layout, blend: Blend::Opaque, cull: Cull::Back, depth, bias: (0, 0), format, samples: 1 };
            programs.pipeline(&gpu, &groups, &key).unwrap();
            if let Some(error) = task::wait(gpu.device.pop_error_scope()) {
                panic!("{program:?} {defines:?}: {error}");
            }
        };
        let standard: [&[&'static str]; 8] = [
            &[],
            &["ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "EMISSION_MAP", "VERTEX_COLOR", "ALPHA_TEST", "FOG"],
            &["ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "WET", "PLANAR", "FOG"],
            &["ALBEDO_MAP", "WET", "DAMP", "CLEARCOAT", "BLEND", "FOG"],
            &["ALBEDO_MAP", "NORMAL_MAP", "WET", "PLANAR", "DAMP", "CLEARCOAT", "REFLECTION", "FOG"],
            &["VERTEX_PBR", "SUN", "SUN_SPEC", "MOVING_SHADOW", "VISTA"],
            &["ALBEDO_MAP", "INTERIOR", "SUN", "FOG"],
            &["ALBEDO_MAP", "SUN", "SUN_SPEC", "REFLECTION", "VISTA"],
        ];
        for defines in standard {
            for layout in [Layout::Static, Layout::Skinned, Layout::Baked] {
                make(Program::Standard, defines, layout, hdr, Depth::TestWrite);
            }
        }
        for program in [Program::Unlit, Program::Glass, Program::Window, Program::Products, Program::Skyline, Program::Tower, Program::Water] {
            for defines in [&[][..], &["ALBEDO_MAP", "VERTEX_COLOR", "ALPHA_TEST", "FOG", "SUN", "SHALLOW"][..], &["VISTA", "REFLECTION", "BLEND", "WAVES"][..]] {
                for layout in [Layout::Static, Layout::Baked] {
                    make(program, defines, layout, hdr, Depth::TestWrite);
                }
            }
        }
        make(Program::SunResolve, &[], Layout::None, None, Depth::Fill);
        for layout in [Layout::Static, Layout::Baked] {
            make(Program::Shadow, &[], layout, None, Depth::Sun);
            make(Program::ShadowCut, &[], layout, None, Depth::Sun);
        }
        for defines in [&[][..], &["DAY"][..], &["DAY", "TWILIGHT"][..]] {
            make(Program::Sky, defines, Layout::None, hdr, Depth::TestWrite);
        }
        for defines in [&[][..], &["VISTA"][..]] {
            make(Program::Lights, defines, Layout::Lights, hdr, Depth::Test);
        }
        for define in ["STREAK", "DRIP", "SPLASH", "STEAM", "BEACON"] {
            make(Program::Fx, &[define], Layout::Fx, hdr, Depth::Test);
        }
        for defines in [&["LIT_HAZE"][..], &["PREFILTER"][..], &["PREFILTER", "HAZE"][..], &["PREFILTER", "PER_PIXEL"][..], &["PREFILTER", "PER_PIXEL", "HAZE"][..], &["DOWN"][..], &["UP"][..], &["COMPOSITE"][..], &["COMPOSITE", "HAZE", "BLOOM"][..]] {
            make(Program::Post, defines, Layout::None, hdr, Depth::None);
        }
        let (variants, pipelines) = programs.counts();
        assert_eq!(variants, pipelines);
        eprintln!("{variants} variants compiled");
    }
}
