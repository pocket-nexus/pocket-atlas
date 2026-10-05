//! The atlas screen's globe on the GE: the night side of the Earth with its
//! city lights and a lit limb, turned to face a place, a pin on every place.
//! The interface says where on the screen it sits and what it faces; the
//! stick spins it. Its surface (tools/atlas-globe.ts) lies in the pack
//! buffer, which is free while no place is loaded.
use alloc::{vec, vec::Vec};
use core::ffi::c_void;
use glam::{Mat3, Mat4, Vec3};
use psp::{sys::*, Align16};

const WIDTH: usize = 512;
/// Swizzled RGBA8888 for the daylight side, then swizzled RGBA4444 for the lights.
pub const BYTES: usize = WIDTH * WIDTH / 2 * 6;
const RINGS: usize = 24;
const SEGMENTS: usize = 48;
const RIM: usize = SEGMENTS + 1;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Vertex {
    uv: [f32; 2],
    color: u32,
    pos: [f32; 3],
}
/// A screen-space vertex: the limb's glow and the pins.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Flat {
    color: u32,
    pos: [f32; 3],
}

pub struct Globe {
    surface: *const u8,
    points: Vec<Vec3>,
    day: Vec<Align16<[Vertex; 2]>>,
    night: Vec<Align16<[Vertex; 2]>>,
    indices: Vec<Align16<[u16; 8]>>,
    glow: Vec<Align16<[Flat; 4]>>,
    dots: Vec<Align16<[Flat; 4]>>,
    dot_count: usize,
    pins: Vec<(Vec3, u32)>,
    lit: Option<usize>,
    /// Centre and radius on the screen, where it faces (degrees) and where it is turning to.
    place: [f32; 3],
    pub facing: [f32; 2],
    goal: [f32; 2],
    following: bool,
    settle: f32,
}

fn point(lat: f32, lon: f32) -> Vec3 {
    let (lat, lon) = (lat.to_radians(), lon.to_radians());
    Vec3::new(libm::cosf(lat) * libm::sinf(lon), libm::sinf(lat), libm::cosf(lat) * libm::cosf(lon))
}
fn rgb(r: f32, g: f32, b: f32) -> u32 {
    let c = |v: f32| (v.clamp(0.0, 1.0) * 255.0) as u32;
    0xff00_0000 | c(b) << 16 | c(g) << 8 | c(r)
}

impl Globe {
    /// `surface`: `BYTES` of the pack buffer holding the cooked surface, or
    /// null when there is none (a globe of pins alone).
    pub fn new(surface: *const u8) -> Self {
        let count = (RINGS + 1) * (SEGMENTS + 1);
        let mut points = Vec::with_capacity(count);
        let mut day = vec![Align16([Vertex::default(); 2]); count.div_ceil(2)];
        for j in 0..=RINGS {
            for i in 0..=SEGMENTS {
                let at = points.len();
                points.push(point(90.0 - 180.0 * j as f32 / RINGS as f32, 360.0 * i as f32 / SEGMENTS as f32 - 180.0));
                day[at / 2].0[at % 2].uv = [i as f32 / SEGMENTS as f32, j as f32 / RINGS as f32];
            }
        }
        let mut indices = vec![Align16([0u16; 8]); (RINGS * SEGMENTS * 6).div_ceil(8)];
        for j in 0..RINGS {
            for i in 0..SEGMENTS {
                let a = (j * (SEGMENTS + 1) + i) as u16;
                let b = a + SEGMENTS as u16 + 1;
                for (k, v) in [a, b, a + 1, a + 1, b, b + 1].into_iter().enumerate() {
                    let at = (j * SEGMENTS + i) * 6 + k;
                    indices[at / 8].0[at % 8] = v;
                }
            }
        }
        Self {
            surface,
            points,
            night: day.clone(),
            day,
            indices,
            glow: vec![Align16([Flat::default(); 4]); (RIM * 4).div_ceil(4)],
            dots: vec![Align16([Flat::default(); 4]); 64],
            dot_count: 0,
            pins: Vec::new(),
            lit: None,
            place: [150.0, 136.0, 100.0],
            facing: [31.0, 131.0],
            goal: [31.0, 131.0],
            following: true,
            settle: 0.0,
        }
    }
    pub fn place(&mut self, x: f32, y: f32, r: f32) {
        self.place = [x, y, r];
    }
    pub fn turn(&mut self, lat: f32, lon: f32, pin: Option<usize>) {
        self.goal = [lat, lon];
        self.lit = pin;
        self.following = true;
    }
    pub fn pins(&mut self, list: &[(f32, f32, u32)]) {
        self.pins = list.iter().map(|&(lat, lon, c)| (point(lat, lon), rgb((c >> 16 & 255) as f32 / 255.0, (c >> 8 & 255) as f32 / 255.0, (c & 255) as f32 / 255.0))).collect();
    }
    /// The stick (or a finger): degrees east and north.
    pub fn spin(&mut self, east: f32, north: f32) {
        self.following = false;
        self.facing[1] += east;
        self.facing[0] = (self.facing[0] + north).clamp(-80.0, 80.0);
        self.settle = 0.4;
    }
    /// Advances the turn and lays the frame's vertices out. True once after
    /// a spin has settled: `facing` is then where the interface sorts from.
    pub fn update(&mut self, dt: f32) -> bool {
        let mut settled = false;
        if self.following {
            let ease = 1.0 - libm::expf(-dt * 5.0);
            self.facing[0] += (self.goal[0] - self.facing[0]) * ease;
            self.facing[1] += libm::remainderf(self.goal[1] - self.facing[1], 360.0) * ease;
        } else if self.settle > 0.0 {
            self.settle -= dt;
            if self.settle <= 0.0 {
                self.facing[1] = libm::remainderf(self.facing[1], 360.0);
                settled = true;
            }
        }
        // Facing (lat, lon) comes to +Z. The sun stands behind the left
        // shoulder: a lit limb, night across the face.
        let turn = self.rotation();
        let sun = Vec3::new(-0.82, 0.30, -0.49);
        for (i, p) in self.points.iter().enumerate() {
            let n = turn * *p;
            let day = ((n.dot(sun) + 0.05) / 0.45).clamp(0.0, 1.0);
            let day = day * day * (3.0 - 2.0 * day);
            let (a, b) = (&mut self.day[i / 2].0[i % 2], &mut self.night[i / 2].0[i % 2]);
            a.pos = p.to_array();
            a.color = rgb(0.07 + day * 1.15, 0.10 + day * 1.15, 0.16 + day * 1.15);
            *b = Vertex { uv: a.uv, color: rgb(1.0 - day, 1.0 - day, 1.0 - day), pos: a.pos };
        }
        let [x, y, r] = self.place;
        // The air at the limb: nothing inside the disc, brightest on its
        // edge and toward the sun, gone a quarter radius out.
        for i in 0..RIM {
            let angle = i as f32 / SEGMENTS as f32 * core::f32::consts::TAU;
            let (s, c) = (libm::sinf(angle), libm::cosf(angle));
            let k = 0.5 - 0.3 * c;
            for (ring, (radius, light)) in [(0.9, 0.0), (1.0, k), (1.0, k), (1.25, 0.0)].into_iter().enumerate() {
                let at = ring / 2 * RIM * 2 + i * 2 + ring % 2;
                self.glow[at / 4].0[at % 4] = Flat { color: rgb(0.22 * light, 0.46 * light, light), pos: [x + c * r * radius, y - s * r * radius, 0.0] };
            }
        }
        // Pins on the near side as squares, the lit one last, larger and ringed.
        let mut dots = 0;
        let mut dot = |half: f32, color: u32, at: Vec3| {
            if dots + 2 <= 256 {
                for (k, sign) in [-1.0, 1.0].into_iter().enumerate() {
                    self.dots[(dots + k) / 4].0[(dots + k) % 4] = Flat { color, pos: [x + at.x * r + sign * half, y - at.y * r + sign * half, 0.0] };
                }
                dots += 2;
            }
        };
        for (i, (p, color)) in self.pins.iter().enumerate() {
            let at = turn * *p;
            if at.z > 0.08 && Some(i) != self.lit {
                dot(2.0, *color, at);
            }
        }
        if let Some((p, color)) = self.lit.and_then(|i| self.pins.get(i)) {
            let at = turn * *p;
            if at.z > 0.08 {
                dot(5.0, 0xffff_ffff, at);
                dot(3.0, *color, at);
            }
        }
        self.dot_count = dots;
        settled
    }
    fn rotation(&self) -> Mat3 {
        Mat3::from_rotation_x(self.facing[0].to_radians()) * Mat3::from_rotation_y(-self.facing[1].to_radians())
    }
    /// Draws into the open display list.
    pub unsafe fn draw(&self) {
        let [x, y, r] = self.place;
        // Orthographic: the unit sphere becomes `r` pixels about (x, y).
        let projection = Mat4::from_cols_array(&[r / 240.0, 0.0, 0.0, 0.0, 0.0, r / 136.0, 0.0, 0.0, 0.0, 0.0, -0.5, 0.0, (x - 240.0) / 240.0, (136.0 - y) / 136.0, 0.0, 1.0]);
        let set = |kind, m: Mat4| {
            let data = Align16(m.to_cols_array());
            sceGuSetMatrix(kind, &*(data.0.as_ptr() as *const ScePspFMatrix4));
        };
        set(MatrixMode::Projection, projection);
        set(MatrixMode::View, Mat4::IDENTITY);
        set(MatrixMode::Model, Mat4::from_mat3(self.rotation()));
        sceGuDisable(GuState::DepthTest);
        sceGuDisable(GuState::AlphaTest);
        sceGuDisable(GuState::Fog);
        sceGuEnable(GuState::CullFace);
        sceGuFrontFace(FrontFaceDirection::CounterClockwise);
        let kind = VertexType::TEXTURE_32BITF | VertexType::COLOR_8888 | VertexType::VERTEX_32BITF | VertexType::INDEX_16BIT | VertexType::TRANSFORM_3D;
        let count = (RINGS * SEGMENTS * 6) as i32;
        if !self.surface.is_null() {
            sceGuEnable(GuState::Texture2D);
            sceGuTexFilter(TextureFilter::Linear, TextureFilter::Linear);
            sceGuTexWrap(GuTexWrapMode::Repeat, GuTexWrapMode::Clamp);
            sceGuTexScale(1.0, 1.0);
            sceGuTexOffset(0.0, 0.0);
            // The daylight side, then the lights added where it is night.
            sceGuDisable(GuState::Blend);
            sceGuTexMode(TexturePixelFormat::Psm8888, 0, 0, 1);
            sceGuTexImage(MipmapLevel::None, WIDTH as i32, WIDTH as i32 / 2, WIDTH as i32, self.surface as *const c_void);
            sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgb);
            sceGuDrawArray(GuPrimitive::Triangles, kind, count, self.indices.as_ptr() as *const c_void, self.day.as_ptr() as *const c_void);
            sceGuEnable(GuState::Blend);
            sceGuBlendFunc(BlendOp::Add, BlendFactor::SrcAlpha, BlendFactor::Fix, 0, 0xffffff);
            sceGuTexMode(TexturePixelFormat::Psm4444, 0, 0, 1);
            sceGuTexImage(MipmapLevel::None, WIDTH as i32, WIDTH as i32 / 2, WIDTH as i32, self.surface.add(WIDTH * WIDTH / 2 * 4) as *const c_void);
            sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
            sceGuDrawArray(GuPrimitive::Triangles, kind, count, self.indices.as_ptr() as *const c_void, self.night.as_ptr() as *const c_void);
        }
        sceGuDisable(GuState::Texture2D);
        sceGuDisable(GuState::CullFace);
        sceGuEnable(GuState::Blend);
        sceGuBlendFunc(BlendOp::Add, BlendFactor::Fix, BlendFactor::Fix, 0xffffff, 0xffffff);
        let flat = VertexType::COLOR_8888 | VertexType::VERTEX_32BITF | VertexType::TRANSFORM_2D;
        for ring in 0..2 {
            sceGuDrawArray(GuPrimitive::TriangleStrip, flat, (RIM * 2) as i32, core::ptr::null(), (self.glow.as_ptr() as *const Flat).add(ring * RIM * 2) as *const c_void);
        }
        sceGuDisable(GuState::Blend);
        if self.dot_count > 0 {
            sceGuDrawArray(GuPrimitive::Sprites, flat, self.dot_count as i32, core::ptr::null(), self.dots.as_ptr() as *const c_void);
        }
    }
}
