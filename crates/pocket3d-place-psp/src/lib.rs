//! PSP-specific, little-endian place payload. No JSON, decompression or
//! texture conversion on the handheld. All offsets are absolute, 16 aligned.
#![no_std]
use bytemuck::{Pod, Zeroable};

pub const MAGIC: u32 = u32::from_le_bytes(*b"PLPS");
pub const VERSION: u32 = 1;
pub const MAX_BYTES: usize = 18 * 1024 * 1024;
pub const NONE: u32 = u32::MAX;
pub const ALPHA: u32 = 1;
pub const DOUBLE_SIDED: u32 = 2;
pub const WET: u32 = 4;
pub const NO_REFLECT: u32 = 8;
pub const NO_DEPTH_WRITE: u32 = 16;

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
    pub reserved: [u32; 3],
}
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub struct Texture {
    pub pixels: Span,
    pub width: u32,
    pub height: u32,
    pub wrap: u32,
    pub mips: u32,
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
        let size: u32 = (0..t.mips)
            .map(|m| (t.width >> m) * (t.height >> m) * 2)
            .sum();
        if t.pixels.offset % 16 != 0 || t.pixels.count != size {
            return Err("texture layout");
        }
        slice::<u8>(bytes, t.pixels)?;
    }
    let ms = slice::<Material>(bytes, h.materials)?;
    for m in ms {
        if m.texture != NONE && m.texture as usize >= ts.len() {
            return Err("material texture");
        }
        if m.grid.iter().any(|&v| v == 0)
            || !m.fps.is_finite()
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
            || is.iter().any(|&i| i as usize >= vs.len())
        {
            return Err("GE geometry");
        }
        let ws = slice::<Weights>(bytes, d.weights)?;
        let js = slice::<Joint>(bytes, d.joints)?;
        if !ws.is_empty() && (ws.len() != vs.len() || js.is_empty()) {
            return Err("skin layout");
        }
        if js.len() > 64
            || js.iter().any(|j| j.node as usize >= ns.len())
            || ws
                .iter()
                .any(|w| (0..4).any(|i| w.weights[i] != 0 && w.joints[i] as usize >= js.len()))
        {
            return Err("skin joint");
        }
    }
    let shots = slice::<Shot>(bytes, h.shots)?;
    if shots.is_empty()
        || shots
            .iter()
            .any(|s| !s.duration.is_finite() || s.duration <= 0.0)
    {
        return Err("camera shots");
    }
    slice::<[f32; 6]>(bytes, h.dry_boxes)?;
    slice::<[f32; 6]>(bytes, h.walkable)?;
    for l in slice::<Light>(bytes, h.lights)? {
        if l.track.count != 0 && Some(l.track.count) != h.frames.checked_mul(4) {
            return Err("light track");
        }
        slice::<f32>(bytes, l.track)?;
    }
    for d in h.doors {
        if d != NONE && d as usize >= ns.len() {
            return Err("door node");
        }
    }
    Ok(h)
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
        h.doors = [NONE; 2];
        h.shots = Span {
            offset: core::mem::size_of::<Header>() as u32,
            count: 1,
        };
        bytes[..core::mem::size_of::<Header>()].copy_from_slice(bytemuck::bytes_of(&h));
        let mut shot = Shot::zeroed();
        shot.duration = 12.0;
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
}
