//! Streaming PLCE loader. Only one place is resident; texture staging is
//! released after each upload, and static geometry lives in GL buffers.
use crate::{gl::*, validation};
use alloc::{ffi::CString, format, string::String, vec, vec::Vec};
use core::ffi::c_void;
use glam::{Mat4, Quat, Vec3};
use pocket3d_place as pc;
#[derive(Clone, Copy, Default)]
pub struct Light {
    pub pos: Vec3,
    pub color: Vec3,
    pub dir: Vec3,
    pub reach: f32,
    pub spot: [f32; 2],
    pub dynamic: bool,
    pub right: Vec3,
    pub up: Vec3,
    pub size: [f32; 2],
}
pub struct Scene {
    pub meta: pc::Meta,
    pub textures: Vec<u32>,
    pub geometry: u32,
    pub vaos: Vec<u32>,
    pub anim: Vec<f32>,
    pub world: Vec<Mat4>,
    pub lights: Vec<Light>,
    pub emissive: Vec<f32>,
    pub door: f32,
    pub gpu_bytes: usize,
}
/// An open file remains the same inode throughout the stream. Every exit,
/// including a failed seek/short read, closes it through Drop.
struct PlaceFile {
    handle: *mut c_void,
    len: usize,
}
impl PlaceFile {
    fn open(path: &str) -> Result<Self, String> {
        let name = CString::new(path).map_err(|_| String::from("invalid place path"))?;
        let handle = unsafe { crate::fopen(name.as_ptr(), b"rb\0".as_ptr() as _) };
        if handle.is_null() {
            return Err(format!("Cannot open {path}"));
        }
        let mut file = Self { handle, len: 0 };
        unsafe {
            if crate::fseek(handle, 0, 2) != 0 {
                return Err("place file seek failed".into());
            }
            let size = crate::ftell(handle);
            if size < 16 {
                return Err("place file is truncated or too large to seek".into());
            }
            file.len = size as usize;
        }
        Ok(file)
    }
    fn read(&mut self, offset: usize, size: usize) -> Result<Vec<u8>, String> {
        let end = offset
            .checked_add(size)
            .ok_or("place read range overflow")?;
        if end > self.len || offset > i32::MAX as usize || size > 128 * 1024 * 1024 {
            return Err("place read exceeds file or staging budget".into());
        }
        unsafe {
            if crate::fseek(self.handle, offset as i32, 0) != 0 {
                return Err("place seek failed".into());
            }
            let mut bytes = Vec::new();
            bytes
                .try_reserve_exact(size)
                .map_err(|_| String::from("place staging allocation failed"))?;
            bytes.resize(size, 0);
            if size != 0 && crate::fread(bytes.as_mut_ptr() as _, 1, size, self.handle) != size {
                return Err("place payload truncated during read".into());
            }
            Ok(bytes)
        }
    }
    fn section(&mut self, section: &pc::Section) -> Result<Vec<u8>, String> {
        self.payload(
            section,
            &pc::Range {
                offset: 0,
                size: section.size,
            },
        )
    }
    fn payload(&mut self, section: &pc::Section, range: &pc::Range) -> Result<Vec<u8>, String> {
        let absolute = validation::section_span(section, range, self.len)?;
        self.read(absolute.start, absolute.len())
    }
}
impl Drop for PlaceFile {
    fn drop(&mut self) {
        unsafe {
            crate::fclose(self.handle);
        }
    }
}

unsafe fn check_gl(operation: &str) -> Result<(), String> {
    let error = glGetError();
    if error == GL_NO_ERROR {
        Ok(())
    } else {
        Err(format!("{operation}: GLES error 0x{error:04x}"))
    }
}

impl Scene {
    /// The scene's GLES context must remain current on the calling thread
    /// through loading, use and Drop (including the error cleanup path).
    pub unsafe fn load(path: &str) -> Result<Self, String> {
        let mut file = PlaceFile::open(path)?;
        let header = file.read(0, 16)?;
        let table_size = validation::place_header_size(&header, file.len)?;
        let table = file.read(0, table_size)?;
        let sections = validation::validate_container(&table, file.len)?;
        let section = |tag| {
            sections
                .iter()
                .find(|s| s.tag == tag)
                .ok_or_else(|| format!("missing section {tag:?}"))
        };
        let meta: pc::Meta = serde_json::from_slice(&file.section(section(pc::TAG_META)?)?)
            .map_err(|e| format!("place metadata: {e}"))?;
        let tex = section(pc::TAG_TEXTURES)?;
        let geom = section(pc::TAG_GEOMETRY)?;
        let animation = section(pc::TAG_ANIMATION)?;
        if animation.size % 4 != 0 {
            return Err("animation alignment".into());
        }
        let anim: Vec<f32> = file
            .section(animation)?
            .chunks_exact(4)
            .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        validation::validate(&meta, geom.size as usize, tex.size as usize, &anim)?;
        check_gl("before scene upload")?;
        let mut limit = 0;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &mut limit);
        check_gl("query texture limit")?;
        if limit <= 0
            || meta
                .textures
                .iter()
                .any(|t| t.width > limit as u32 || t.height > limit as u32)
        {
            return Err(format!("texture exceeds GPU limit {limit}"));
        }

        // The final owner exists before the first GL allocation. All names
        // start at zero, so every later `?` releases exactly what was created.
        let mut scene = Self {
            textures: vec![0; meta.textures.len()],
            geometry: 0,
            vaos: vec![0; meta.draws.len()],
            world: vec![Mat4::IDENTITY; meta.nodes.len()],
            lights: vec![Light::default(); meta.lights.len()],
            emissive: vec![1.0; meta.materials.len()],
            meta,
            anim,
            door: 0.0,
            gpu_bytes: 0,
        };
        if !scene.textures.is_empty() {
            glGenTextures(scene.textures.len() as _, scene.textures.as_mut_ptr());
            check_gl("create scene textures")?;
            if scene.textures.contains(&0) {
                return Err("GLES did not allocate scene textures".into());
            }
        }
        for (t, &id) in scene.meta.textures.iter().zip(&scene.textures) {
            let data = file.payload(tex, &t.data)?;
            validation::validate_texture(t, &data)?;
            glBindTexture(GL_TEXTURE_2D, id);
            glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
            let half = t.format == pc::TexFormat::Rgba16f;
            let (mut w, mut h, mut at) = (t.width, t.height, 0usize);
            for mip in 0..t.mips {
                let n = (w as usize)
                    .checked_mul(h as usize)
                    .and_then(|n| n.checked_mul(if half { 8 } else { 4 }))
                    .ok_or("texture mip overflow")?;
                let end = at.checked_add(n).ok_or("texture mip offset overflow")?;
                let level = data.get(at..end).ok_or("texture mip range")?;
                let encoded: Vec<u8> = if half {
                    level
                        .chunks_exact(8)
                        .flat_map(|px| {
                            let mut out = [255u8; 4];
                            for c in 0..3 {
                                let h = u16::from_le_bytes([px[c * 2], px[c * 2 + 1]]);
                                let value = half_float(h).max(0.0);
                                out[c] = (libm::sqrtf(value / (1.0 + value)) * 255.0 + 0.5) as u8;
                            }
                            out
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                let pixels = if half {
                    encoded.as_ptr()
                } else {
                    level.as_ptr()
                };
                glTexImage2D(
                    GL_TEXTURE_2D,
                    mip as _,
                    GL_RGBA as _,
                    w as _,
                    h as _,
                    0,
                    GL_RGBA,
                    GL_UNSIGNED_BYTE,
                    pixels as _,
                );
                at = end;
                w = (w / 2).max(1);
                h = (h / 2).max(1);
            }
            glTexParameteri(GL_TEXTURE_2D, 0x813d, t.mips as i32 - 1); // GL_APPLE_texture_max_level, checked at startup.
            glTexParameteri(
                GL_TEXTURE_2D,
                GL_TEXTURE_MIN_FILTER,
                if t.mips > 1 { 0x2703 } else { GL_LINEAR },
            );
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            let wrap = |v| match v {
                pc::Wrap::Repeat => GL_REPEAT,
                pc::Wrap::Clamp => GL_CLAMP_TO_EDGE,
                pc::Wrap::Mirror => 0x8370,
            };
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wrap(t.wrap_s));
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wrap(t.wrap_t));
            check_gl(&format!("upload texture {}", t.name))?;
            scene.gpu_bytes += if half { data.len() / 2 } else { data.len() };
        }
        let data = file.section(geom)?;
        validation::validate_geometry(&scene.meta, &data)?;
        glGenBuffers(1, &mut scene.geometry);
        check_gl("create scene geometry")?;
        if scene.geometry == 0 {
            return Err("GLES did not allocate scene geometry".into());
        }
        glBindBuffer(GL_ARRAY_BUFFER, scene.geometry);
        glBufferData(
            GL_ARRAY_BUFFER,
            data.len() as _,
            data.as_ptr() as _,
            GL_STATIC_DRAW,
        );
        check_gl("upload scene geometry")?;
        scene.gpu_bytes += data.len();
        drop(data);
        if !scene.vaos.is_empty() {
            glGenVertexArraysOES(scene.vaos.len() as _, scene.vaos.as_mut_ptr());
            check_gl("create scene vertex arrays")?;
            if scene.vaos.contains(&0) {
                return Err("GLES did not allocate scene vertex arrays".into());
            }
        }
        for (i, d) in scene.meta.draws.iter().enumerate() {
            if d.layout == pc::VertexLayout::Lights {
                continue;
            }
            glBindVertexArrayOES(scene.vaos[i]);
            glBindBuffer(GL_ARRAY_BUFFER, scene.geometry);
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, scene.geometry);
            let attrs = [
                (0, 3, 0x1402, 1, 0),
                (1, 3, 0x1400, 1, 8),
                (2, 4, 0x1400, 1, 12),
                (3, 2, 0x1402, 1, 16),
                (4, 4, GL_UNSIGNED_BYTE, 1, 20),
            ];
            for (k, n, t, normalize, offset) in attrs {
                glEnableVertexAttribArray(k);
                glVertexAttribPointer(
                    k,
                    n,
                    t,
                    normalize,
                    d.layout.stride() as _,
                    (d.vertices.offset as usize + offset) as _,
                );
            }
            if d.layout == pc::VertexLayout::Baked {
                glEnableVertexAttribArray(5);
                glVertexAttribPointer(
                    5,
                    4,
                    GL_UNSIGNED_BYTE,
                    1,
                    28,
                    (d.vertices.offset as usize + 24) as _,
                );
            }
            if d.layout == pc::VertexLayout::Skinned {
                for (k, normalize, offset) in [(6, 0, 24), (7, 1, 28)] {
                    glEnableVertexAttribArray(k);
                    glVertexAttribPointer(
                        k,
                        4,
                        GL_UNSIGNED_BYTE,
                        normalize,
                        32,
                        (d.vertices.offset as usize + offset) as _,
                    );
                }
            }
        }
        glBindVertexArrayOES(0);
        check_gl("configure scene vertex arrays")?;
        scene.update(0.0, Vec3::ZERO, 0.0);
        Ok(scene)
    }
    pub fn keys(&self, r: &pc::Range, stride: usize, time: f32) -> (&[f32], &[f32], f32) {
        let count = r.size as usize / 4 / stride;
        let f = (time * self.meta.fps) % count as f32;
        let a = f as usize;
        let b = (a + 1) % count;
        let at = r.offset as usize / 4;
        (
            &self.anim[at + a * stride..at + (a + 1) * stride],
            &self.anim[at + b * stride..at + (b + 1) * stride],
            f - a as f32,
        )
    }
    pub fn track<const N: usize>(&self, r: &pc::Range, time: f32) -> [f32; N] {
        let (a, b, t) = self.keys(r, N, time);
        core::array::from_fn(|i| a[i] + (b[i] - a[i]) * t)
    }
    pub fn update(&mut self, time: f32, eye: Vec3, dt: f32) {
        if let Some(d) = &self.meta.doors {
            let target = if eye.distance(Vec3::from(d.trigger)) < d.radius {
                1.0
            } else {
                0.0
            };
            self.door += (target - self.door) * (1.0 - libm::expf(-8.0 * dt));
        }
        for (i, n) in self.meta.nodes.iter().enumerate() {
            let (mut t, mut q) = (Vec3::from(n.translation), Quat::from_array(n.rotation));
            if let Some(r) = &n.track {
                let (a, b, f) = self.keys(r, 7, time);
                t = Vec3::from_slice(a).lerp(Vec3::from_slice(b), f);
                q = Quat::from_slice(&a[3..]).lerp(Quat::from_slice(&b[3..]), f);
            }
            if let Some(d) = &self.meta.doors {
                if i as u32 == d.left {
                    t.x -= self.door * d.travel;
                }
                if i as u32 == d.right {
                    t.x += self.door * d.travel;
                }
            }
            let m = Mat4::from_scale_rotation_translation(Vec3::from(n.scale), q, t);
            self.world[i] = n.parent.map(|p| self.world[p as usize] * m).unwrap_or(m);
        }
        for (i, l) in self.meta.lights.iter().enumerate() {
            let (pos, dir) = l
                .node
                .map(|n| {
                    let m = self.world[n as usize];
                    (
                        m.transform_point3(Vec3::ZERO),
                        m.transform_vector3(Vec3::NEG_Z).normalize_or_zero(),
                    )
                })
                .unwrap_or((Vec3::from(l.position), Vec3::from(l.direction)));
            let spot = if l.kind == pc::LightKind::Spot {
                let scale = 1.0 / (l.cos_inner - l.cos_outer).max(1e-4);
                [-l.cos_outer * scale, scale]
            } else {
                [1.0, 0.0]
            };
            let mut light = Light {
                pos,
                dir,
                color: Vec3::from(l.color),
                reach: l.range,
                spot,
                dynamic: l.node.is_some(),
                ..Default::default()
            };
            if l.kind == pc::LightKind::Rect {
                light.right =
                    Vec3::from(l.right).normalize_or(Vec3::Y.cross(dir).normalize_or(Vec3::X));
                light.up = dir.cross(light.right).normalize_or(Vec3::Y);
                light.size = [l.size[0] * 0.5, l.size[1] * 0.5];
                light.color *= l.size[0] * l.size[1];
                light.spot = [0.0, 1.0];
            }
            self.lights[i] = light;
        }
        for (i, m) in self.meta.materials.iter().enumerate() {
            if let Some(t) = m.emissive_track {
                self.emissive[i] =
                    self.track::<1>(&self.meta.material_tracks[t as usize].data, time)[0];
            }
        }
    }
    pub fn model(&self, d: &pc::Draw) -> Mat4 {
        d.node
            .map(|n| self.world[n as usize])
            .unwrap_or(Mat4::IDENTITY)
    }
    pub fn bones(&self, skin: u32) -> Vec<f32> {
        let s = &self.meta.skins[skin as usize];
        let at = s.inverse_bind.offset as usize / 4;
        let mut out = Vec::new();
        for (i, &node) in s.joints.iter().enumerate() {
            let m = self.world[node as usize]
                * Mat4::from_cols_slice(&self.anim[at + i * 16..at + i * 16 + 16]);
            out.extend(rows(m));
        }
        out
    }
    pub fn bounds(&self, d: &pc::Draw) -> (Vec3, Vec3) {
        if let Some(s) = d.skin {
            let root = self.world[self.meta.skins[s as usize].joints[0] as usize]
                .transform_point3(Vec3::ZERO);
            return (root - Vec3::splat(2.0), root + Vec3::splat(2.0));
        }
        let m = self.model(d);
        let c = (Vec3::from(d.min) + Vec3::from(d.max)) * 0.5;
        let e = (Vec3::from(d.max) - Vec3::from(d.min)) * 0.5;
        let wc = m.transform_point3(c);
        let we = m.x_axis.truncate().abs() * e.x
            + m.y_axis.truncate().abs() * e.y
            + m.z_axis.truncate().abs() * e.z;
        (wc - we, wc + we)
    }
}
impl Drop for Scene {
    fn drop(&mut self) {
        unsafe {
            if self.geometry == 0 && self.textures.iter().chain(&self.vaos).all(|&id| id == 0) {
                return;
            }
            glFinish();
            glBindVertexArrayOES(0);
            glDeleteVertexArraysOES(self.vaos.len() as _, self.vaos.as_ptr());
            // The same buffer holds vertices and indices; delete it once.
            glDeleteBuffers(1, &self.geometry);
            glDeleteTextures(self.textures.len() as _, self.textures.as_ptr());
        }
    }
}
pub fn rows(m: Mat4) -> [f32; 12] {
    let t = m.transpose();
    let a = t.to_cols_array();
    a[..12].try_into().unwrap()
}

fn half_float(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = (h >> 10) & 31;
    let m = h & 1023;
    if e == 0 {
        sign * (m as f32) * libm::exp2f(-24.0)
    } else if e == 31 {
        sign * 65504.0
    } else {
        sign * (1.0 + m as f32 / 1024.0) * libm::exp2f(e as f32 - 15.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;
    use std::{
        collections::BTreeSet,
        path::PathBuf,
        sync::{LazyLock, Mutex},
    };

    // These symbols satisfy the loader's GLES imports in the standalone host
    // harness. They record ownership and inject real GL error return paths;
    // they do not claim to emulate rendering or the physical GPU.
    #[derive(Default)]
    struct GlState {
        next: u32,
        live: BTreeSet<(u8, u32)>,
        deleted: Vec<(u8, u32)>,
        invalid_deletes: Vec<(u8, u32)>,
        error: u32,
        fail: Option<&'static str>,
        vao: u32,
        uploads: Vec<[u8; 4]>,
    }
    static SERIAL: Mutex<()> = Mutex::new(());
    static GL: LazyLock<Mutex<GlState>> = LazyLock::new(|| Mutex::new(GlState::default()));
    fn stage(state: &mut GlState, name: &'static str) {
        if state.fail == Some(name) {
            state.error = 0x0505;
            state.fail = None;
        }
    }
    unsafe fn generate(kind: u8, count: i32, names: *mut u32, name: &'static str) {
        let mut state = GL.lock().unwrap();
        for i in 0..count as usize {
            state.next += 1;
            let id = state.next;
            names.add(i).write(id);
            state.live.insert((kind, id));
        }
        stage(&mut state, name);
    }
    unsafe fn delete(kind: u8, count: i32, names: *const u32) {
        let mut state = GL.lock().unwrap();
        for &id in core::slice::from_raw_parts(names, count as usize) {
            if id == 0 {
                continue;
            }
            if !state.live.remove(&(kind, id)) {
                state.invalid_deletes.push((kind, id));
            }
            state.deleted.push((kind, id));
        }
    }
    #[no_mangle]
    unsafe extern "C" fn glGenTextures(n: i32, p: *mut u32) {
        generate(b'T', n, p, "textures");
    }
    #[no_mangle]
    unsafe extern "C" fn glGenBuffers(n: i32, p: *mut u32) {
        generate(b'B', n, p, "buffer");
    }
    #[no_mangle]
    unsafe extern "C" fn glGenVertexArraysOES(n: i32, p: *mut u32) {
        generate(b'V', n, p, "vaos");
    }
    #[no_mangle]
    unsafe extern "C" fn glDeleteTextures(n: i32, p: *const u32) {
        delete(b'T', n, p);
    }
    #[no_mangle]
    unsafe extern "C" fn glDeleteBuffers(n: i32, p: *const u32) {
        delete(b'B', n, p);
    }
    #[no_mangle]
    unsafe extern "C" fn glDeleteVertexArraysOES(n: i32, p: *const u32) {
        delete(b'V', n, p);
    }
    #[no_mangle]
    unsafe extern "C" fn glGetError() -> u32 {
        core::mem::take(&mut GL.lock().unwrap().error)
    }
    #[no_mangle]
    unsafe extern "C" fn glGetIntegerv(_: u32, p: *mut i32) {
        p.write(4096);
        stage(&mut GL.lock().unwrap(), "limit");
    }
    #[no_mangle]
    unsafe extern "C" fn glBindVertexArrayOES(id: u32) {
        GL.lock().unwrap().vao = id;
    }
    #[no_mangle]
    unsafe extern "C" fn glBindBuffer(_: u32, _: u32) {}
    #[no_mangle]
    unsafe extern "C" fn glBindTexture(_: u32, _: u32) {}
    #[no_mangle]
    unsafe extern "C" fn glPixelStorei(_: u32, _: i32) {}
    #[no_mangle]
    unsafe extern "C" fn glTexParameteri(_: u32, _: u32, _: i32) {}
    #[no_mangle]
    unsafe extern "C" fn glEnableVertexAttribArray(_: u32) {}
    #[no_mangle]
    unsafe extern "C" fn glFinish() {}
    #[no_mangle]
    unsafe extern "C" fn glBufferData(_: u32, _: isize, _: *const c_void, _: u32) {
        stage(&mut GL.lock().unwrap(), "geometry upload");
    }
    #[no_mangle]
    unsafe extern "C" fn glVertexAttribPointer(
        _: u32,
        _: i32,
        _: u32,
        _: u8,
        _: i32,
        _: *const c_void,
    ) {
        stage(&mut GL.lock().unwrap(), "attributes");
    }
    #[no_mangle]
    unsafe extern "C" fn glTexImage2D(
        _: u32,
        _: i32,
        _: i32,
        _: i32,
        _: i32,
        _: i32,
        _: u32,
        _: u32,
        p: *const c_void,
    ) {
        let mut state = GL.lock().unwrap();
        let bytes = core::slice::from_raw_parts(p as *const u8, 4);
        state.uploads.push(bytes.try_into().unwrap());
        stage(&mut state, "texture upload");
    }

    struct PackFile(PathBuf);
    impl PackFile {
        fn write(bytes: &[u8]) -> Self {
            let folder = crate::test_artifact_dir();
            std::fs::create_dir_all(&folder).unwrap();
            let path = folder.join(format!("loader-{}.place", std::process::id()));
            std::fs::write(&path, bytes).unwrap();
            Self(path)
        }
        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for PackFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn pack(m: &pc::Meta, geom: &[u8], anim: &[f32], textures: &[u8]) -> Vec<u8> {
        let meta = serde_json::to_vec(m).unwrap();
        let anim: Vec<u8> = anim.iter().flat_map(|v| v.to_le_bytes()).collect();
        pc::write(&[
            (pc::TAG_META, &meta, 16),
            (pc::TAG_TEXTURES, textures, 16),
            (pc::TAG_GEOMETRY, geom, 16),
            (pc::TAG_ANIMATION, &anim, 16),
        ])
    }
    fn reset(fail: Option<&'static str>) {
        *GL.lock().unwrap() = GlState {
            fail,
            ..Default::default()
        };
    }
    fn released() {
        let state = GL.lock().unwrap();
        assert!(state.live.is_empty(), "leaked {:?}", state.live);
        assert!(
            state.invalid_deletes.is_empty(),
            "duplicate deletion {:?}",
            state.invalid_deletes
        );
        assert_eq!(state.vao, 0);
    }

    #[test]
    fn loader_rejects_malformed_container_before_allocating_gpu_names() {
        let _lock = SERIAL.lock().unwrap();
        let (m, g, a) = crate::validation::tests::fixture();
        let source = pack(&m, &g, &a, &[255; 64]);
        for mode in 0..3 {
            reset(None);
            let mut bytes = source.clone();
            match mode {
                0 => bytes[32..36].copy_from_slice(&pc::TAG_META),
                1 => {
                    bytes.pop();
                }
                _ => bytes[20..24].copy_from_slice(&0xfffffff0u32.to_le_bytes()),
            }
            let file = PackFile::write(&bytes);
            assert!(unsafe { Scene::load(file.path()) }.is_err());
            released();
            assert_eq!(GL.lock().unwrap().next, 0);
        }
    }
    #[test]
    fn every_gpu_failure_path_releases_textures_buffer_and_vaos_once() {
        let _lock = SERIAL.lock().unwrap();
        let (m, g, a) = crate::validation::tests::fixture();
        let file = PackFile::write(&pack(&m, &g, &a, &[255; 64]));
        for operation in [
            "limit",
            "textures",
            "texture upload",
            "buffer",
            "geometry upload",
            "vaos",
            "attributes",
        ] {
            reset(Some(operation));
            let error = unsafe { Scene::load(file.path()) }.err().expect(operation);
            assert!(error.contains("GLES error"), "{operation}: {error}");
            released();
        }
    }
    #[test]
    fn late_payload_errors_also_release_previously_uploaded_textures() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, mut g, a) = crate::validation::tests::fixture();
        reset(None);
        g[76] = 3;
        let file = PackFile::write(&pack(&m, &g, &a, &[255; 64]));
        assert!(unsafe { Scene::load(file.path()) }
            .err()
            .unwrap()
            .contains("index exceeds"));
        released();
        assert_eq!(GL.lock().unwrap().next, 1);
        g[76] = 2;
        let mut hdr = m.textures[0].clone();
        hdr.role = pc::TexRole::Environment;
        hdr.format = pc::TexFormat::Rgba16f;
        hdr.data = pc::Range {
            offset: 64,
            size: 128,
        };
        m.textures.push(hdr);
        let mut pixels = vec![255; 64];
        pixels.extend([0, 0x7e].repeat(64));
        reset(None);
        let file = PackFile::write(&pack(&m, &g, &a, &pixels));
        assert!(unsafe { Scene::load(file.path()) }
            .err()
            .unwrap()
            .contains("non-finite half-float"));
        released();
        assert_eq!(GL.lock().unwrap().next, 2);
    }
    #[test]
    #[ignore = "set POCKET_ATLAS_VALIDATION_PACKS to existing GLES packs; GL is mocked"]
    fn streaming_load_and_drop_real_packs_keeps_no_gpu_names() {
        let _lock = SERIAL.lock().unwrap();
        let dir = std::env::var("POCKET_ATLAS_VALIDATION_PACKS").expect("pack directory");
        let mut count = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|s| s.to_str()) != Some("place") {
                continue;
            }
            reset(None);
            let scene = unsafe { Scene::load(path.to_str().unwrap()) }
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            assert_eq!(scene.vaos.len(), scene.meta.draws.len());
            assert_eq!(scene.textures.len(), scene.meta.textures.len());
            drop(scene);
            released();
            std::println!("streamed and released {}", path.display());
            count += 1;
        }
        assert!(count > 0);
    }

    #[test]
    fn successful_scene_keeps_vao_animation_and_hdr_encoding_until_drop() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, g, a) = crate::validation::tests::fixture();
        let mut hdr = m.textures[0].clone();
        hdr.role = pc::TexRole::Environment;
        hdr.format = pc::TexFormat::Rgba16f;
        hdr.data = pc::Range {
            offset: 64,
            size: 128,
        };
        m.textures.push(hdr);
        let mut pixels = vec![255; 64];
        pixels.extend([0, 0x3c].repeat(64));
        let file = PackFile::write(&pack(&m, &g, &a, &pixels));
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert_eq!(scene.textures.len(), 2);
        assert_eq!(scene.vaos.len(), 1);
        assert_eq!(scene.anim, a);
        assert_eq!(scene.world[0], Mat4::IDENTITY);
        assert_eq!(scene.gpu_bytes, 64 + 64 + g.len());
        {
            let state = GL.lock().unwrap();
            assert_eq!(state.live.len(), 4);
            assert!(state.deleted.is_empty());
            assert!(state.uploads.contains(&[180, 180, 180, 255]));
            assert_eq!(state.vao, 0);
        }
        drop(scene);
        released();
        assert_eq!(
            GL.lock()
                .unwrap()
                .deleted
                .iter()
                .filter(|(kind, _)| *kind == b'B')
                .count(),
            1
        );
    }
}
