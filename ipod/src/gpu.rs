use crate::{gl::*, read};
use alloc::{
    collections::BTreeMap,
    ffi::CString,
    format,
    string::{String, ToString},
    vec,
    vec::Vec,
};
use core::{
    cell::{Cell, RefCell},
    ptr,
};
struct Uniform {
    location: i32,
    size: usize,
    data: RefCell<Vec<f32>>,
    sampler: Cell<i32>,
}
use glam::Mat4;
pub struct Program {
    pub id: u32,
    uniforms: BTreeMap<String, Uniform>,
    pub attrs: [bool; 8],
}
const ATTR: [&str; 8] = [
    "aPosition",
    "aNormal",
    "aTangent",
    "aUv",
    "aColor",
    "aLight",
    "aJoints",
    "aWeights",
];
impl Program {
    pub unsafe fn new(root: &str, names: &[String; 2]) -> Result<Self, String> {
        let sources = [
            CString::new(read(&format!("{root}/shaders/{}.glsl", names[0]))?)
                .map_err(|_| String::from("shader contains NUL"))?,
            CString::new(read(&format!("{root}/shaders/{}.glsl", names[1]))?)
                .map_err(|_| String::from("shader contains NUL"))?,
        ];
        let mut shaders = [0; 2];
        for k in 0..2 {
            let source = &sources[k];
            let s = glCreateShader(if k == 0 {
                GL_VERTEX_SHADER
            } else {
                GL_FRAGMENT_SHADER
            });
            let p = source.as_ptr();
            glShaderSource(s, 1, &p, ptr::null());
            glCompileShader(s);
            let mut ok = 0;
            glGetShaderiv(s, GL_COMPILE_STATUS, &mut ok);
            if ok == 0 {
                for old in shaders {
                    if old != 0 {
                        glDeleteShader(old);
                    }
                }
                let mut log = vec![0u8; 16384];
                glGetShaderInfoLog(s, log.len() as _, ptr::null_mut(), log.as_mut_ptr() as _);
                glDeleteShader(s);
                return Err(format!(
                    "{}: {}",
                    names[k],
                    String::from_utf8_lossy(
                        &log[..log.iter().position(|&b| b == 0).unwrap_or(log.len())]
                    )
                ));
            }
            shaders[k] = s;
        }
        let id = glCreateProgram();
        for &s in &shaders {
            glAttachShader(id, s);
        }
        for (i, n) in ATTR.iter().enumerate() {
            glBindAttribLocation(id, i as _, CString::new(*n).unwrap().as_ptr());
        }
        glLinkProgram(id);
        for s in shaders {
            glDeleteShader(s);
        }
        let mut ok = 0;
        glGetProgramiv(id, GL_LINK_STATUS, &mut ok);
        if ok == 0 {
            let mut log = vec![0u8; 8192];
            glGetProgramInfoLog(id, log.len() as _, ptr::null_mut(), log.as_mut_ptr() as _);
            glDeleteProgram(id);
            return Err(format!(
                "link {}: {}",
                names[1],
                String::from_utf8_lossy(
                    &log[..log.iter().position(|&b| b == 0).unwrap_or(log.len())]
                )
            ));
        }
        let mut count = 0;
        glGetProgramiv(id, 0x8b86, &mut count);
        let mut uniforms = BTreeMap::new();
        for i in 0..count {
            let mut name = [0i8; 128];
            let (mut len, mut size, mut kind) = (0, 0, 0);
            glGetActiveUniform(
                id,
                i as _,
                128,
                &mut len,
                &mut size,
                &mut kind,
                name.as_mut_ptr(),
            );
            let key = core::ffi::CStr::from_ptr(name.as_ptr())
                .to_string_lossy()
                .trim_end_matches("[0]")
                .to_string();
            uniforms.insert(
                key,
                Uniform {
                    location: glGetUniformLocation(id, name.as_ptr()),
                    size: size as usize,
                    data: RefCell::new(Vec::new()),
                    sampler: Cell::new(-1),
                },
            );
        }
        let attrs = core::array::from_fn(|i| {
            glGetAttribLocation(id, CString::new(ATTR[i]).unwrap().as_ptr()) >= 0
        });
        Ok(Self {
            id,
            uniforms,
            attrs,
        })
    }
    pub unsafe fn bind(&self) {
        glUseProgram(self.id);
    }
    pub unsafe fn v(&self, name: &str, data: &[f32]) {
        if let Some(u) = self.uniforms.get(name) {
            let data = &data[..data.len().min(u.size * 4)];
            let mut previous = u.data.borrow_mut();
            if previous.as_slice() != data {
                glUniform4fv(u.location, (data.len() / 4) as _, data.as_ptr());
                previous.clear();
                previous.extend_from_slice(data);
            }
        }
    }
    pub unsafe fn mat(&self, name: &str, m: Mat4) {
        if let Some(u) = self.uniforms.get(name) {
            let data = m.to_cols_array();
            let mut previous = u.data.borrow_mut();
            if previous.as_slice() != data {
                glUniformMatrix4fv(u.location, 1, 0, data.as_ptr());
                previous.clear();
                previous.extend_from_slice(&data);
            }
        }
    }
    pub unsafe fn tex(&self, name: &str, id: u32, unit: u32) -> u32 {
        if let Some(u) = self.uniforms.get(name) {
            glActiveTexture(GL_TEXTURE0 + unit);
            glBindTexture(GL_TEXTURE_2D, id);
            if u.sampler.get() != unit as i32 {
                glUniform1i(u.location, unit as i32);
                u.sampler.set(unit as i32);
            }
            unit + 1
        } else {
            unit
        }
    }
}
impl Drop for Program {
    fn drop(&mut self) {
        unsafe { glDeleteProgram(self.id) }
    }
}
pub struct Target {
    pub fbo: u32,
    pub texture: u32,
    depth: u32,
    pub w: i32,
    pub h: i32,
}
impl Target {
    pub unsafe fn new(w: i32, h: i32, with_depth: bool) -> Result<Self, String> {
        let (mut fbo, mut texture, mut depth) = (0, 0, 0);
        glGenTextures(1, &mut texture);
        glBindTexture(GL_TEXTURE_2D, texture);
        glTexImage2D(
            GL_TEXTURE_2D,
            0,
            GL_RGBA as _,
            w,
            h,
            0,
            GL_RGBA,
            GL_UNSIGNED_BYTE,
            ptr::null(),
        );
        for p in [GL_TEXTURE_MIN_FILTER, GL_TEXTURE_MAG_FILTER] {
            glTexParameteri(GL_TEXTURE_2D, p, GL_LINEAR);
        }
        for p in [GL_TEXTURE_WRAP_S, GL_TEXTURE_WRAP_T] {
            glTexParameteri(GL_TEXTURE_2D, p, GL_CLAMP_TO_EDGE);
        }
        glGenFramebuffers(1, &mut fbo);
        glBindFramebuffer(0x8d40, fbo);
        glFramebufferTexture2D(0x8d40, 0x8ce0, GL_TEXTURE_2D, texture, 0);
        if with_depth {
            glGenRenderbuffers(1, &mut depth);
            glBindRenderbuffer(0x8d41, depth);
            glRenderbufferStorage(0x8d41, 0x81a6, w, h);
            glFramebufferRenderbuffer(0x8d40, 0x8d00, 0x8d41, depth);
        }
        let target = Self {
            fbo,
            texture,
            depth,
            w,
            h,
        };
        let status = glCheckFramebufferStatus(0x8d40);
        if status != 0x8cd5 {
            return Err(format!("render target {w}x{h}: {status:x}"));
        }
        Ok(target)
    }
    pub unsafe fn bind(&self) {
        glBindFramebuffer(0x8d40, self.fbo);
        glViewport(0, 0, self.w, self.h);
    }
}
impl Drop for Target {
    fn drop(&mut self) {
        unsafe {
            glDeleteFramebuffers(1, &self.fbo);
            glDeleteTextures(1, &self.texture);
            glDeleteRenderbuffers(1, &self.depth);
        }
    }
}
pub unsafe fn rgba(w: i32, h: i32, pixels: &[u8]) -> u32 {
    let mut id = 0;
    glGenTextures(1, &mut id);
    glBindTexture(GL_TEXTURE_2D, id);
    glTexImage2D(
        GL_TEXTURE_2D,
        0,
        GL_RGBA as _,
        w,
        h,
        0,
        GL_RGBA,
        GL_UNSIGNED_BYTE,
        pixels.as_ptr() as _,
    );
    for p in [GL_TEXTURE_MIN_FILTER, GL_TEXTURE_MAG_FILTER] {
        glTexParameteri(GL_TEXTURE_2D, p, GL_LINEAR);
    }
    for p in [GL_TEXTURE_WRAP_S, GL_TEXTURE_WRAP_T] {
        glTexParameteri(GL_TEXTURE_2D, p, GL_CLAMP_TO_EDGE);
    }
    id
}

pub unsafe fn tone_lut(post: &pocket3d_place::Post) -> u32 {
    let mut table = vec![0u8; 1024 * 32 * 4];
    let mut cfg = post.clone();
    cfg.exposure = 1.0;
    for b in 0..32 {
        for g in 0..32 {
            for r in 0..32 {
                let a = |i| {
                    let e = i as f32 / 31.0;
                    let q = e * e;
                    (q / (1.0 - q).max(1.0 / 255.0)).min(126.0)
                };
                let c = pocket3d_place::color::tone([a(r), a(g), a(b)], &cfg);
                let at = (g * 1024 + b * 32 + r) * 4;
                table[at..at + 4].copy_from_slice(&[
                    (c[0] * 255.0) as u8,
                    (c[1] * 255.0) as u8,
                    (c[2] * 255.0) as u8,
                    255,
                ]);
            }
        }
    }
    rgba(1024, 32, &table)
}

/// Own partially uploaded resources as well as successful renderer lifetimes.
#[derive(Default)]
pub struct Objects {
    pub textures: Vec<u32>,
    pub buffers: Vec<u32>,
}
impl Objects {
    pub unsafe fn image(&mut self, w: i32, h: i32, pixels: &[u8]) -> u32 {
        let id = rgba(w, h, pixels);
        self.textures.push(id);
        id
    }
    pub unsafe fn buffer(&mut self) -> u32 {
        let mut id = 0;
        glGenBuffers(1, &mut id);
        self.buffers.push(id);
        id
    }
}
impl Drop for Objects {
    fn drop(&mut self) {
        unsafe {
            glDeleteTextures(self.textures.len() as _, self.textures.as_ptr());
            glDeleteBuffers(self.buffers.len() as _, self.buffers.as_ptr());
        }
    }
}
/// Same smooth radial mask and deterministic grain used by the shared grade.
pub unsafe fn grade_textures(objects: &mut Objects, vignette: f32) -> (u32, u32) {
    let mut mask = vec![255u8; 128 * 128 * 4];
    for y in 0..128 {
        for x in 0..128 {
            let u = (x as f32 + 0.5) / 128.0 - 0.5;
            let v = (y as f32 + 0.5) / 128.0 - 0.5;
            let r = libm::sqrtf(u * u * 2.25 + v * v);
            let t = ((r - 1.05) / (0.25 - 1.05)).clamp(0.0, 1.0);
            let m = ((1.0 - vignette + vignette * t * t * (3.0 - 2.0 * t)) * 255.0) as u8;
            mask[(y * 128 + x) * 4..(y * 128 + x) * 4 + 4].copy_from_slice(&[m, m, m, 255]);
        }
    }
    let mask = objects.image(128, 128, &mask);
    let mut noise = vec![255u8; 64 * 64 * 4];
    let mut seed = 0x9e3779b9u32;
    for px in noise.chunks_exact_mut(4) {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        px[0] = seed as u8;
        px[1] = px[0];
        px[2] = px[0];
    }
    let grain = objects.image(64, 64, &noise);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
    (mask, grain)
}
