//! The atlas screen's globe: the night side of the Earth with its city lights
//! and a lit limb, turned to face a place, a pin on every place. A port of
//! `ipod/src/globe.c`: the same mesh, the same three programs
//! (`shaders/globe.wgsl`), the same easing.
//!
//! [`Turn`] is where the globe sits, what it faces and its pins: no GPU, the
//! interface's commands change it. [`Globe`] draws a `Turn` into a frame's
//! scene pass.

use bytemuck::{Pod, Zeroable};
use pocket_web_wgpu::gpu::Gpu;
use pocket_web_wgpu::wgpu::{self, util::DeviceExt, TextureFormat};

const RINGS: u32 = 24;
const SEGMENTS: u32 = 48;
const MAX_PINS: usize = 48;
const RADIANS: f32 = core::f32::consts::PI / 180.0;

/// The unit vector of a latitude and a longitude, degrees: +Y the north pole, +Z where both are zero.
fn point(lat: f32, lon: f32) -> [f32; 3] {
    let (lat, lon) = (lat * RADIANS, lon * RADIANS);
    [lat.cos() * lon.sin(), lat.sin(), lat.cos() * lon.cos()]
}

/// The IEEE remainder: `x` less the nearest multiple of `y`.
fn remainder(x: f32, y: f32) -> f32 {
    x - y * (x / y).round()
}

/// Where the globe sits on the primary screen, what it faces and its pins.
#[derive(Clone, Debug)]
pub struct Turn {
    /// Centre (x, y) and radius, logical pixels of the primary screen.
    pub place: [f32; 3],
    /// Latitude and longitude at the middle of the disc, degrees.
    pub facing: [f32; 2],
    goal: [f32; 2],
    following: bool,
    settle: f32,
    pins: Vec<([f32; 3], [f32; 3])>,
    lit: Option<usize>,
}

impl Default for Turn {
    fn default() -> Turn {
        Turn { place: [130.0, 160.0, 100.0], facing: [31.0, 131.0], goal: [31.0, 131.0], following: true, settle: 0.0, pins: Vec::new(), lit: None }
    }
}

impl Turn {
    /// The interface's `globe` command: where the disc sits, the place it turns to face, the pin that is lit.
    pub fn face(&mut self, x: f32, y: f32, r: f32, lat: f32, lon: f32, pin: Option<usize>) {
        self.place = [x, y, r];
        self.goal = [lat, lon];
        self.lit = pin;
        self.following = true;
    }

    /// Every place on the globe: latitude, longitude, colour (0xrrggbb).
    pub fn pins(&mut self, list: &[(f32, f32, u32)]) {
        self.pins = list.iter().take(MAX_PINS).map(|&(lat, lon, rgb)| (point(lat, lon), [16u32, 8, 0].map(|shift| (rgb >> shift & 255) as f32 / 255.0))).collect();
    }

    pub fn pin_count(&self) -> usize {
        self.pins.len()
    }

    pub fn lit(&self) -> Option<usize> {
        self.lit
    }

    /// A finger's travel across the disc, logical pixels: the surface follows the finger.
    pub fn drag(&mut self, dx: f32, dy: f32) {
        self.following = false;
        self.facing[1] -= dx / self.place[2] / RADIANS;
        self.facing[0] = (self.facing[0] + dy / self.place[2] / RADIANS).clamp(-80.0, 80.0);
        self.settle = 0.4;
    }

    /// A stick's push: degrees to the east and to the north.
    pub fn spin(&mut self, east: f32, north: f32) {
        self.following = false;
        self.facing[1] += east;
        self.facing[0] = (self.facing[0] + north).clamp(-80.0, 80.0);
        self.settle = 0.4;
    }

    /// Advances the turn `dt` seconds. `Some` once after a spin has settled, with where the globe faces: what
    /// the interface's Explore list sorts from.
    pub fn update(&mut self, dt: f32) -> Option<[f32; 2]> {
        if self.following {
            let ease = 1.0 - (-dt * 5.0).exp();
            self.facing[0] += (self.goal[0] - self.facing[0]) * ease;
            self.facing[1] += remainder(self.goal[1] - self.facing[1], 360.0) * ease;
        } else if self.settle > 0.0 {
            self.settle -= dt;
            if self.settle <= 0.0 {
                self.facing[1] = remainder(self.facing[1], 360.0);
                return Some(self.facing);
            }
        }
        None
    }

    /// The turn that brings `facing` to +Z, as three columns: about Y by the longitude, then about X by the
    /// latitude.
    pub fn columns(&self) -> [[f32; 3]; 3] {
        let (a, b) = (self.facing[0] * RADIANS, -self.facing[1] * RADIANS);
        let (ca, sa, cb, sb) = (a.cos(), a.sin(), b.cos(), b.sin());
        [[cb, sa * sb, -ca * sb], [0.0, ca, sa], [sb, -sa * cb, ca * cb]]
    }

    /// The pins on the near side as the pin program's instances: x and y on the unit disc, width in logical
    /// pixels, colour, and 1 for the lit one, which comes last and larger.
    pub fn dots(&self) -> Vec<Dot> {
        let t = self.columns();
        let mut dots = Vec::with_capacity(self.pins.len());
        for pass in [false, true] {
            for (i, (p, colour)) in self.pins.iter().enumerate() {
                if (Some(i) == self.lit) != pass {
                    continue;
                }
                let turned = |row: usize| t[0][row] * p[0] + t[1][row] * p[1] + t[2][row] * p[2];
                if turned(2) < 0.08 {
                    continue;
                }
                dots.push(Dot { at: [turned(0), turned(1), if pass { 11.0 } else { 5.0 }], colour: [colour[0], colour[1], colour[2], pass as u32 as f32] });
            }
        }
        dots
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Dot {
    pub at: [f32; 3],
    pub colour: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    at: [f32; 3],
    uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    turn: [[f32; 4]; 3],
    place: [f32; 4],
    pixel: [f32; 4],
}

/// Rings of latitude from the north pole, then a square for the halo.
fn mesh() -> (Vec<Vertex>, Vec<u16>) {
    let mut vertices = Vec::with_capacity(((RINGS + 1) * (SEGMENTS + 1) + 4) as usize);
    for j in 0..=RINGS {
        for i in 0..=SEGMENTS {
            vertices.push(Vertex { at: point(90.0 - 180.0 * j as f32 / RINGS as f32, 360.0 * i as f32 / SEGMENTS as f32 - 180.0), uv: [i as f32 / SEGMENTS as f32, j as f32 / RINGS as f32] });
        }
    }
    let mut triangles = Vec::with_capacity((RINGS * SEGMENTS * 6) as usize);
    for j in 0..RINGS {
        for i in 0..SEGMENTS {
            let a = (j * (SEGMENTS + 1) + i) as u16;
            let b = a + SEGMENTS as u16 + 1;
            triangles.extend_from_slice(&[a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    for k in 0..4 {
        vertices.push(Vertex { at: [if k & 1 != 0 { 1.0 } else { -1.0 }, if k & 2 != 0 { 1.0 } else { -1.0 }, 0.0], uv: [0.0, 0.0] });
    }
    (vertices, triangles)
}

/// The levels under a picture of RGBA texels, each the mean of four of the one above.
fn levels(texels: &[u8], width: u32, height: u32) -> Vec<(Vec<u8>, u32, u32)> {
    let mut out = vec![(texels.to_vec(), width, height)];
    loop {
        let (from, w, h) = out.last().unwrap();
        if *w == 1 && *h == 1 {
            return out;
        }
        let (nw, nh) = ((*w / 2).max(1), (*h / 2).max(1));
        let mut next = vec![0u8; (nw * nh * 4) as usize];
        for y in 0..nh {
            for x in 0..nw {
                for c in 0..4 {
                    let at = |dx: u32, dy: u32| from[((((y * 2 + dy).min(h - 1)) * w + (x * 2 + dx).min(w - 1)) * 4 + c) as usize] as u32;
                    next[((y * nw + x) * 4 + c) as usize] = ((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1) + 2) / 4) as u8;
                }
            }
        }
        out.push((next, nw, nh));
    }
}

pub struct Globe {
    layout: wgpu::BindGroupLayout,
    shader: wgpu::ShaderModule,
    sampler: wgpu::Sampler,
    uniforms: wgpu::Buffer,
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    dots: wgpu::Buffer,
    /// The three programs, for a screen's format and samples.
    programs: Option<(TextureFormat, u32, [wgpu::RenderPipeline; 3])>,
    /// The surface once it has been read: its bind group, and its width in texels.
    surface: Option<(wgpu::BindGroup, u32)>,
}

impl Globe {
    pub fn new(gpu: &Gpu) -> Globe {
        let device = &gpu.device;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("globe"), source: wgpu::ShaderSource::Wgsl(include_str!("shaders/globe.wgsl").into()) });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("globe"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        // Around the equator the surface repeats; at the poles it ends.
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("globe"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let (mesh, triangles) = mesh();
        let buffer = |label, contents: &[u8], usage| device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents, usage });
        Globe {
            uniforms: device.create_buffer(&wgpu::BufferDescriptor { label: Some("globe"), size: core::mem::size_of::<Uniforms>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }),
            vertices: buffer("globe mesh", bytemuck::cast_slice(&mesh), wgpu::BufferUsages::VERTEX),
            indices: buffer("globe triangles", bytemuck::cast_slice(&triangles), wgpu::BufferUsages::INDEX),
            dots: device.create_buffer(&wgpu::BufferDescriptor { label: Some("globe pins"), size: (MAX_PINS * core::mem::size_of::<Dot>()) as u64, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }),
            layout,
            shader,
            sampler,
            programs: None,
            surface: None,
        }
    }

    /// The surface `tools/atlas-globe.ts` writes: rows of RGBA, `width` by `width / 2`, the north pole first;
    /// the daylight albedo, with the city lights in alpha.
    pub fn surface(&mut self, gpu: &Gpu, texels: &[u8]) -> Result<(), String> {
        let width = ((texels.len() / 2) as f64).sqrt() as u32;
        if width < 2 || !width.is_power_of_two() || (width * width * 2) as usize != texels.len() {
            return Err(format!("a globe surface of {} bytes is not rows of RGBA twice as wide as tall", texels.len()));
        }
        let levels = levels(texels, width, width / 2);
        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("globe surface"),
            size: wgpu::Extent3d { width, height: width / 2, depth_or_array_layers: 1 },
            mip_level_count: levels.len() as u32,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            // The colours are written as the surface holds them, as the handheld's program does.
            format: TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        for (level, (bytes, w, h)) in levels.iter().enumerate() {
            gpu.queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: level as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                bytes,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(*h) },
                wgpu::Extent3d { width: *w, height: *h, depth_or_array_layers: 1 },
            );
        }
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("globe"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.uniforms.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&texture.create_view(&wgpu::TextureViewDescriptor::default())) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        self.surface = Some((group, width));
        Ok(())
    }

    /// The surface's width in texels, once it has been read.
    pub fn surface_width(&self) -> Option<u32> {
        self.surface.as_ref().map(|s| s.1)
    }

    fn programs(&mut self, gpu: &Gpu, format: TextureFormat, samples: u32) {
        if self.programs.as_ref().is_some_and(|(f, s, _)| (*f, *s) == (format, samples)) {
            return;
        }
        let device = &gpu.device;
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("globe"), bind_group_layouts: &[&self.layout], push_constant_ranges: &[] });
        let mesh = wgpu::VertexBufferLayout { array_stride: core::mem::size_of::<Vertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x2] };
        let pins = wgpu::VertexBufferLayout { array_stride: core::mem::size_of::<Dot>() as u64, step_mode: wgpu::VertexStepMode::Instance, attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x4] };
        let additive = wgpu::BlendState { color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add }, alpha: wgpu::BlendComponent::REPLACE };
        let program = |label, vertex: &str, fragment: &str, buffer: wgpu::VertexBufferLayout, topology, blend: Option<wgpu::BlendState>, tested: bool| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&layout),
                vertex: wgpu::VertexState { module: &self.shader, entry_point: Some(vertex), compilation_options: Default::default(), buffers: &[buffer] },
                fragment: Some(wgpu::FragmentState { module: &self.shader, entry_point: Some(fragment), compilation_options: Default::default(), targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::COLOR })] }),
                // Both sides of the sphere are drawn; its depth puts the near half in front.
                primitive: wgpu::PrimitiveState { topology, cull_mode: None, ..Default::default() },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: pocket_web_wgpu::gpu::DEPTH,
                    depth_write_enabled: tested,
                    depth_compare: if tested { wgpu::CompareFunction::LessEqual } else { wgpu::CompareFunction::Always },
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
                multiview: None,
                cache: None,
            })
        };
        let list = wgpu::PrimitiveTopology::TriangleList;
        let strip = wgpu::PrimitiveTopology::TriangleStrip;
        self.programs = Some((
            format,
            samples,
            [
                program("globe sphere", "sphere_vertex", "sphere_fragment", mesh.clone(), list, None, true),
                program("globe halo", "halo_vertex", "halo_fragment", mesh, strip, Some(additive), true),
                program("globe pins", "dot_vertex", "dot_fragment", pins, strip, None, false),
            ],
        ));
    }

    /// Draws the globe into the scene's pass of a screen of `format` with `samples` samples a pixel, whose
    /// primary surface is `logical` logical pixels. Without its surface it draws nothing: the pass's clear
    /// is the frame. Returns the triangles drawn.
    pub fn draw(&mut self, gpu: &Gpu, pass: &mut wgpu::RenderPass<'_>, turn: &Turn, format: TextureFormat, samples: u32, logical: [f32; 2]) -> u32 {
        if self.surface.is_none() {
            return 0;
        }
        self.programs(gpu, format, samples);
        let (Some((group, _)), Some((_, _, programs))) = (&self.surface, &self.programs) else { return 0 };
        let t = turn.columns();
        let [x, y, r] = turn.place;
        let (half_w, half_h) = (logical[0] / 2.0, logical[1] / 2.0);
        let uniforms = Uniforms {
            turn: [[t[0][0], t[0][1], t[0][2], 0.0], [t[1][0], t[1][1], t[1][2], 0.0], [t[2][0], t[2][1], t[2][2], 0.0]],
            place: [x / half_w - 1.0, 1.0 - y / half_h, r / half_w, r / half_h],
            pixel: [1.0 / half_w, 1.0 / half_h, 0.0, 0.0],
        };
        gpu.queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&uniforms));
        let dots = turn.dots();
        gpu.queue.write_buffer(&self.dots, 0, bytemuck::cast_slice(&dots));

        let sphere = (RINGS + 1) * (SEGMENTS + 1);
        pass.set_bind_group(0, group, &[]);
        pass.set_vertex_buffer(0, self.vertices.slice(..));
        pass.set_index_buffer(self.indices.slice(..), wgpu::IndexFormat::Uint16);
        pass.set_pipeline(&programs[0]);
        pass.draw_indexed(0..RINGS * SEGMENTS * 6, 0, 0..1);
        pass.set_pipeline(&programs[1]);
        pass.draw(sphere..sphere + 4, 0..1);
        if !dots.is_empty() {
            pass.set_pipeline(&programs[2]);
            pass.set_vertex_buffer(0, self.dots.slice(..));
            pass.draw(0..4, 0..dots.len() as u32);
        }
        RINGS * SEGMENTS * 2 + 2 + dots.len() as u32 * 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn the_place_it_faces_comes_to_the_middle() {
        let mut turn = Turn::default();
        turn.face(240.0, 136.0, 100.0, 35.68, 139.72, Some(1));
        // (eased: after ten seconds it is there)
        for _ in 0..600 {
            assert_eq!(turn.update(1.0 / 60.0), None);
        }
        assert!(near(turn.facing[0], 35.68) && near(turn.facing[1], 139.72));
        let t = turn.columns();
        let p = point(35.68, 139.72);
        let turned: Vec<f32> = (0..3).map(|row| t[0][row] * p[0] + t[1][row] * p[1] + t[2][row] * p[2]).collect();
        assert!(near(turned[0], 0.0) && near(turned[1], 0.0) && near(turned[2], 1.0), "{turned:?}");
        // The other way round the world is the short way: from 170 east to 170 west is 20 degrees.
        let mut turn = Turn { facing: [0.0, 170.0], ..Default::default() };
        turn.face(0.0, 0.0, 100.0, 0.0, -170.0, None);
        turn.update(0.05);
        assert!(turn.facing[1] > 170.0);
    }

    #[test]
    fn pins_on_the_far_side_are_not_drawn_and_the_lit_one_comes_last() {
        let mut turn = Turn { facing: [0.0, 0.0], ..Default::default() };
        turn.face(0.0, 0.0, 100.0, 0.0, 0.0, Some(0));
        turn.pins(&[(0.0, 0.0, 0xff8000), (0.0, 180.0, 0x00ff00), (45.0, 30.0, 0x0000ff), (0.0, 86.0, 0xffffff)]);
        let dots = turn.dots();
        // (the antipode and the one on the limb are left out)
        assert_eq!(dots.len(), 2);
        assert_eq!(dots[0].colour, [0.0, 0.0, 1.0, 0.0]);
        assert_eq!(dots[0].at[2], 5.0);
        assert!(near(dots[1].at[0], 0.0) && near(dots[1].at[1], 0.0));
        assert_eq!((dots[1].at[2], dots[1].colour), (11.0, [1.0, 128.0 / 255.0, 0.0, 1.0]));
        // North is up and east is to the right.
        assert!(dots[0].at[0] > 0.0 && dots[0].at[1] > 0.0);
    }

    #[test]
    fn a_spin_settles_and_says_where() {
        let mut turn = Turn { facing: [10.0, 350.0], ..Default::default() };
        // A finger that moves a radius to the right turns the surface with it: a radian to the west.
        turn.drag(100.0, 0.0);
        assert!(near(turn.facing[1], 350.0 - 1.0 / RADIANS));
        turn.spin(120.0, 200.0);
        assert_eq!(turn.facing[0], 80.0);
        assert_eq!(turn.update(0.3), None);
        let settled = turn.update(0.2).unwrap();
        assert!(settled[1] > -180.0 && settled[1] <= 180.0, "{settled:?}");
        assert_eq!(turn.update(0.2), None);
    }

    #[test]
    fn a_surface_has_every_level_down_to_one_texel() {
        let texels: Vec<u8> = (0..8 * 4 * 4).map(|i| if i % 4 == 0 { 200 } else { 100 }).collect();
        let all = levels(&texels, 8, 4);
        assert_eq!(all.iter().map(|(_, w, h)| (*w, *h)).collect::<Vec<_>>(), [(8, 4), (4, 2), (2, 1), (1, 1)]);
        assert_eq!(all[3].0, [200, 100, 100, 100]);
        let (mesh, triangles) = mesh();
        assert_eq!((mesh.len(), triangles.len()), (((RINGS + 1) * (SEGMENTS + 1) + 4) as usize, (RINGS * SEGMENTS * 6) as usize));
    }
}
