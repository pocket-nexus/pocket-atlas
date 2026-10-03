//! PSP-specific, little-endian place payload. No JSON, decompression or
//! texture conversion on the handheld. All offsets are absolute, 16 aligned.
#![no_std]
use bytemuck::{Pod, Zeroable};

pub const MAGIC: u32 = u32::from_le_bytes(*b"PLPS");
pub const VERSION: u32 = 3;
pub const MAX_BYTES: usize = 18 * 1024 * 1024;
pub const NONE: u32 = u32::MAX;
pub const ALPHA: u32 = 1;
pub const DOUBLE_SIDED: u32 = 2;
pub const WET: u32 = 4;
pub const NO_REFLECT: u32 = 8;
pub const NO_DEPTH_WRITE: u32 = 16;
/// GE PRIM has a 16-bit vertex/index count. Keep complete triangles.
pub const MAX_INDICES: usize = 65532;

#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Span {
    pub offset: u32,
    pub count: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Header {
    pub magic: u32,
    pub version: u32,
    pub bytes: u32,
    pub rain: u32,
    pub textures: Span,
    pub materials: Span,
    pub draws: Span,
    pub nodes: Span,
    pub shots: Span,
    pub dry_boxes: Span,
    pub lights: Span,
    pub walkable: Span,
    pub fps: f32,
    pub frames: u32,
    pub fog_color: u32,
    pub sky_color: u32,
    pub fog_near: f32,
    pub fog_far: f32,
    pub doors: [u32; 2],
    pub door_trigger: [f32; 3],
    pub door_radius: f32,
    pub door_travel: f32,
    /// Camera-centered, unindexed sky dome; empty for the night clear colour.
    pub sky_vertices: Span,
    pub sky_texture: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Texture {
    pub pixels: Span,
    pub width: u32,
    pub height: u32,
    pub wrap: u32,
    pub mips: u32,
    /// Explicit target encoding; sky gradients need more precision than cutouts.
    pub format: u32,
}
pub const RGBA4444: u32 = 0;
pub const RGBA8888: u32 = 1;
impl Texture {
    pub fn bytes_per_pixel(&self) -> Option<u32> {
        match self.format {
            RGBA4444 => Some(2),
            RGBA8888 => Some(4),
            _ => None,
        }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Material {
    pub texture: u32,
    pub flags: u32,
    pub alpha_test: u32,
    /// Positive reversed-depth bias for signage and surface decals.
    pub depth_bias: u32,
    pub uv_speed: [f32; 2],
    pub grid: [u32; 2],
    pub frames: u32,
    pub fps: f32,
}
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Vertex {
    pub uv: [f32; 2],
    pub color: u32,
    pub pos: [f32; 3],
}
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Weights {
    pub joints: [u8; 4],
    pub weights: [u8; 4],
}
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Joint {
    pub node: u32,
    pub inverse: [f32; 16],
}
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Draw {
    pub vertices: Span,
    pub indices: Span,
    pub weights: Span,
    pub joints: Span,
    pub material: u32,
    pub node: u32,
    pub flags: u32,
    pub reserved: u32,
    pub min: [f32; 3],
    pub max: [f32; 3],
}
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Node {
    pub parent: u32,
    pub track: Span,
    pub translation: [f32; 3],
    pub rotation: [f32; 4],
    pub scale: [f32; 3],
}
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Shot {
    pub name: [u8; 16],
    pub from: [f32; 7],
    pub to: [f32; 7],
    pub duration: f32,
}
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Light {
    pub pos: [f32; 3],
    pub color: u32,
    pub radius: f32,
    pub track: Span,
    pub reserved: u32,
}

pub fn slice<T: Pod>(bytes: &[u8], span: Span) -> Result<&[T], &'static str> {
    let len = (span.count as usize)
        .checked_mul(core::mem::size_of::<T>())
        .ok_or("span overflow")?;
    let start = span.offset as usize;
    let end = start.checked_add(len).ok_or("span overflow")?;
    bytemuck::try_cast_slice(bytes.get(start..end).ok_or("truncated span")?)
        .map_err(|_| "unaligned span")
}

/// Validate every offset and index before any pointer is submitted to the GE.
pub fn validate(bytes: &[u8]) -> Result<&Header, &'static str> {
    let h = bytemuck::try_from_bytes::<Header>(
        bytes
            .get(..core::mem::size_of::<Header>())
            .ok_or("header")?,
    )
    .map_err(|_| "alignment")?;
    if h.magic != MAGIC || h.version != VERSION {
        return Err("PSP pack version");
    }
    if h.bytes as usize != bytes.len() || bytes.len() > MAX_BYTES {
        return Err("PSP memory budget");
    }
    if h.frames == 0 || !h.fps.is_finite() || h.fps <= 0.0 {
        return Err("animation clock");
    }
    if !h.fog_near.is_finite()
        || !h.fog_far.is_finite()
        || h.fog_far <= h.fog_near
        || !h.door_radius.is_finite()
        || h.door_radius < 0.0
        || !h.door_travel.is_finite()
        || h.door_trigger.iter().any(|v| !v.is_finite())
    {
        return Err("environment values");
    }
    let ts = slice::<Texture>(bytes, h.textures)?;
    for t in ts {
        if !t.width.is_power_of_two()
            || !t.height.is_power_of_two()
            || t.width > 512
            || t.height > 512
            || t.width < 8
            || t.height < 8
        {
            return Err("texture size");
        }
        if t.mips == 0
            || t.mips > 7
            || (t.width >> (t.mips - 1)) < 8
            || (t.height >> (t.mips - 1)) < 8
        {
            return Err("texture mips");
        }
        let bpp = t.bytes_per_pixel().ok_or("texture format")?;
        let size: u32 = (0..t.mips)
            .map(|m| (t.width >> m) * (t.height >> m) * bpp)
            .sum();
        if t.pixels.offset % 16 != 0 || t.pixels.count != size {
            return Err("texture layout");
        }
        slice::<u8>(bytes, t.pixels)?;
    }
    if h.rain > 1 {
        return Err("rain flag");
    }
    if h.sky_vertices.count == 0 {
        if h.sky_texture != NONE {
            return Err("sky texture without geometry");
        }
    } else {
        if h.sky_texture as usize >= ts.len()
            || h.sky_vertices.offset % 16 != 0
            || h.sky_vertices.count % 3 != 0
            || h.sky_vertices.count as usize > MAX_INDICES
        {
            return Err("sky geometry");
        }
        for v in slice::<Vertex>(bytes, h.sky_vertices)? {
            let length2: f32 = v.pos.iter().map(|x| x * x).sum();
            if v.pos.iter().chain(v.uv.iter()).any(|x| !x.is_finite())
                || !(0.99..=1.01).contains(&length2)
                || v.uv.iter().any(|x| !(0.0..=1.0).contains(x))
            {
                return Err("sky vertex");
            }
        }
    }
    let ms = slice::<Material>(bytes, h.materials)?;
    for m in ms {
        if m.texture != NONE && m.texture as usize >= ts.len() {
            return Err("material texture");
        }
        if m.grid.iter().any(|&v| v == 0)
            || !m.fps.is_finite()
            || m.fps < 0.0
            || m.grid[0]
                .checked_mul(m.grid[1])
                .is_none_or(|cells| m.frames > cells)
            || m.alpha_test > 255
            || m.depth_bias > i32::MAX as u32
            || m.uv_speed.iter().any(|v| !v.is_finite())
        {
            return Err("material animation");
        }
    }
    let ns = slice::<Node>(bytes, h.nodes)?;
    for (i, n) in ns.iter().enumerate() {
        if n.parent != NONE && n.parent as usize >= i {
            return Err("node hierarchy");
        }
        if n.track.count != 0 && Some(n.track.count) != h.frames.checked_mul(7) {
            return Err("node track");
        }
        if slice::<f32>(bytes, n.track)?
            .iter()
            .chain(n.translation.iter())
            .chain(n.rotation.iter())
            .chain(n.scale.iter())
            .any(|v| !v.is_finite())
        {
            return Err("node values");
        }
        if !valid_rotation(&n.rotation)
            || slice::<f32>(bytes, n.track)?
                .chunks_exact(7)
                .any(|key| !valid_rotation(&key[3..7]))
        {
            return Err("node rotation");
        }
    }
    for d in slice::<Draw>(bytes, h.draws)? {
        if d.material as usize >= ms.len() || (d.node != NONE && d.node as usize >= ns.len()) {
            return Err("draw reference");
        }
        let vs = slice::<Vertex>(bytes, d.vertices)?;
        if vs
            .iter()
            .any(|v| v.pos.iter().chain(v.uv.iter()).any(|v| !v.is_finite()))
        {
            return Err("vertex values");
        }
        let is = slice::<u16>(bytes, d.indices)?;
        if d.vertices.offset % 16 != 0
            || d.indices.offset % 16 != 0
            || is.len() % 3 != 0
            || is.len() > MAX_INDICES
            || vs.len() > 65535
            || is.iter().any(|&i| i as usize >= vs.len())
        {
            return Err("GE geometry");
        }
        if !valid_bounds(&d.min, &d.max) {
            return Err("draw bounds");
        }
        let ws = slice::<Weights>(bytes, d.weights)?;
        let js = slice::<Joint>(bytes, d.joints)?;
        if !ws.is_empty() && (ws.len() != vs.len() || js.is_empty()) {
            return Err("skin layout");
        }
        if js.len() > 64
            || js
                .iter()
                .any(|j| j.node as usize >= ns.len() || j.inverse.iter().any(|v| !v.is_finite()))
            || ws
                .iter()
                .any(|w| (0..4).any(|i| w.weights[i] != 0 && w.joints[i] as usize >= js.len()))
        {
            return Err("skin joint");
        }
        if ws
            .iter()
            .any(|w| w.weights.iter().map(|&v| v as u32).sum::<u32>() != 255)
        {
            return Err("skin weights");
        }
    }
    let shots = slice::<Shot>(bytes, h.shots)?;
    if shots.is_empty()
        || shots.iter().any(|s| {
            !s.duration.is_finite()
                || s.duration <= 0.0
                || !valid_camera(&s.from)
                || !valid_camera(&s.to)
        })
    {
        return Err("camera shots");
    }
    for b in slice::<[f32; 6]>(bytes, h.dry_boxes)?
        .iter()
        .chain(slice::<[f32; 6]>(bytes, h.walkable)?)
    {
        if !valid_bounds(&b[..3], &b[3..]) {
            return Err("volume bounds");
        }
    }
    for l in slice::<Light>(bytes, h.lights)? {
        if l.track.count != 0 && Some(l.track.count) != h.frames.checked_mul(4) {
            return Err("light track");
        }
        if !l.radius.is_finite()
            || l.radius < 0.0
            || l.pos
                .iter()
                .chain(slice::<f32>(bytes, l.track)?)
                .any(|v| !v.is_finite())
        {
            return Err("light values");
        }
    }
    for d in h.doors {
        if d != NONE && d as usize >= ns.len() {
            return Err("door node");
        }
    }
    Ok(h)
}

fn valid_rotation(q: &[f32]) -> bool {
    let norm: f32 = q.iter().map(|v| v * v).sum();
    norm.is_finite() && (0.99..=1.01).contains(&norm)
}
fn valid_bounds(lo: &[f32], hi: &[f32]) -> bool {
    lo.iter()
        .zip(hi)
        .all(|(a, b)| a.is_finite() && b.is_finite() && a <= b)
}
fn valid_camera(key: &[f32; 7]) -> bool {
    key.iter().all(|v| v.is_finite()) && (1.0..179.0).contains(&key[6])
        // The rig uses Y as up; a coincident or vertical target has no basis.
        && (key[0] - key[3]) * (key[0] - key[3]) + (key[2] - key[5]) * (key[2] - key[5]) > 1e-8
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::vec;
    fn fixture() -> std::vec::Vec<u32> {
        let n = core::mem::size_of::<Header>() + core::mem::size_of::<Shot>();
        let mut data = vec![0u32; n / 4];
        let bytes = bytemuck::cast_slice_mut(&mut data);
        let mut h = Header::zeroed();
        h.magic = MAGIC;
        h.version = VERSION;
        h.bytes = n as u32;
        h.frames = 1;
        h.fps = 30.0;
        h.fog_far = 100.0;
        h.doors = [NONE; 2];
        h.sky_texture = NONE;
        h.shots = Span {
            offset: core::mem::size_of::<Header>() as u32,
            count: 1,
        };
        bytes[..core::mem::size_of::<Header>()].copy_from_slice(bytemuck::bytes_of(&h));
        let mut shot = Shot::zeroed();
        shot.duration = 12.0;
        shot.from = [0.0, 1.0, 2.0, 0.0, 1.0, 0.0, 45.0];
        shot.to = shot.from;
        bytes[core::mem::size_of::<Header>()..].copy_from_slice(bytemuck::bytes_of(&shot));
        data
    }
    #[test]
    fn accepts_minimal_pack_and_rejects_truncation_version_and_bad_camera() {
        let mut data = fixture();
        assert!(validate(bytemuck::cast_slice(&data)).is_ok());
        assert!(validate(&bytemuck::cast_slice::<_, u8>(&data)[..20]).is_err());
        data[1] = 99;
        assert!(validate(bytemuck::cast_slice(&data)).is_err());
        data[1] = VERSION;
        *data.last_mut().unwrap() = f32::NAN.to_bits();
        assert!(validate(bytemuck::cast_slice(&data)).is_err());
    }
    #[test]
    fn rejects_out_of_bounds_and_unaligned_gpu_ranges() {
        let mut data = fixture();
        let h = bytemuck::from_bytes_mut::<Header>(
            &mut bytemuck::cast_slice_mut::<_, u8>(&mut data)[..core::mem::size_of::<Header>()],
        );
        h.textures = Span {
            offset: u32::MAX,
            count: u32::MAX,
        };
        assert!(validate(bytemuck::cast_slice(&data)).is_err());
        assert!(slice::<u32>(
            &[0u8; 8],
            Span {
                offset: 1,
                count: 1
            }
        )
        .is_err());
    }

    #[test]
    fn rejects_camera_and_environment_values_before_gpu_submission() {
        for component in 0..7 {
            let mut data = fixture();
            let offset = core::mem::size_of::<Header>() / 4 + 4 + component;
            data[offset] = f32::NAN.to_bits();
            assert!(validate(bytemuck::cast_slice(&data)).is_err());
        }
        let mut data = fixture();
        let offset = core::mem::size_of::<Header>() / 4 + 4;
        data[offset + 2] = 0.0f32.to_bits(); // coincident eye and target
        assert!(validate(bytemuck::cast_slice(&data)).is_err());
        let mut data = fixture();
        let h = bytemuck::from_bytes_mut::<Header>(
            &mut bytemuck::cast_slice_mut::<_, u8>(&mut data)[..core::mem::size_of::<Header>()],
        );
        h.fog_far = h.fog_near;
        assert!(validate(bytemuck::cast_slice(&data)).is_err());
    }

    #[test]
    fn rejects_corrupt_skin_and_ge_draw_limits() {
        fn with<T: Pod>(data: &mut std::vec::Vec<u32>, items: &[T]) -> Span {
            data.resize(data.len().next_multiple_of(4), 0);
            let offset = data.len() * 4;
            let payload = bytemuck::cast_slice::<_, u8>(items);
            data.resize(data.len() + payload.len().div_ceil(4), 0);
            bytemuck::cast_slice_mut::<_, u8>(data)[offset..offset + payload.len()]
                .copy_from_slice(payload);
            Span {
                offset: offset as u32,
                count: items.len() as u32,
            }
        }
        let mut data = fixture();
        let material = with(
            &mut data,
            &[Material {
                texture: NONE,
                grid: [1, 1],
                ..Default::default()
            }],
        );
        let node = with(
            &mut data,
            &[Node {
                parent: NONE,
                rotation: [0.0, 0.0, 0.0, 1.0],
                scale: [1.0; 3],
                ..Default::default()
            }],
        );
        let draw = Draw {
            vertices: with(&mut data, &[Vertex::default(); 3]),
            indices: with(&mut data, &[0u16, 1, 2]),
            weights: with(
                &mut data,
                &[Weights {
                    joints: [0; 4],
                    weights: [255, 0, 0, 0],
                }; 3],
            ),
            joints: with(
                &mut data,
                &[Joint {
                    node: 0,
                    inverse: [0.0; 16],
                }],
            ),
            node: NONE,
            ..Default::default()
        };
        let draws = with(&mut data, &[draw]);
        let size = data.len() as u32 * 4;
        let h = bytemuck::from_bytes_mut::<Header>(
            &mut bytemuck::cast_slice_mut::<_, u8>(&mut data)[..core::mem::size_of::<Header>()],
        );
        h.bytes = size;
        h.materials = material;
        h.nodes = node;
        h.draws = draws;
        assert!(validate(bytemuck::cast_slice(&data)).is_ok());
        let mut bad = data.clone();
        bad[draw.joints.offset as usize / 4 + 1] = f32::NAN.to_bits();
        assert_eq!(
            validate(bytemuck::cast_slice(&bad)).err(),
            Some("skin joint")
        );
        let mut bad = data.clone();
        bad[draw.weights.offset as usize / 4 + 1] = 0;
        assert_eq!(
            validate(bytemuck::cast_slice(&bad)).err(),
            Some("skin weights")
        );
        let mut bad = data;
        bad[draws.offset as usize / 4 + 3] = 65535; // GE rejects counts above 65532, even if a span fits.
        assert!(validate(bytemuck::cast_slice(&bad)).is_err());
    }
}
