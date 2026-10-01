//! Registered programs and patched pipelines (vertex program + fragment
//! program for one blend mode, output format and sample count), with the
//! uniform and sampler slots each program exposes.

use std::collections::HashMap;
use std::sync::Arc;

use pocket3d_gxm::patcher::Patcher;
use pocket3d_gxm::program::{self, Attr, Blend, Gxp, Output, Registered};
use vita2d_sys as g;

use crate::shaders::{Event, Key, Service};

/// Every uniform any shader in the library declares. Programs expose a
/// subset; missing ones resolve to null and are skipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub enum U {
    Model,
    Dequant,
    ViewProj,
    Uv,
    Bones,
    Base,
    Emissive,
    Pbr,
    EnvK,
    Wet,
    Wet2,
    Eye,
    Fog,
    HemiSky,
    HemiGround,
    Ripple,
    ReflOn,
    LightPos,
    LightCol,
    LightDir,
    LightRight,
    LightUp,
    Haze,
    RayZ,
    RayX,
    RayY,
    Zenith,
    Horizon,
    Glow,
    Cam,
    Time,
    Box,
    Wind,
    Center,
    Ambient,
    Dry,
    FogPos,
    FogCol,
    FogDir,
    Opacity,
    BoxMin,
    BoxMax,
    Texel,
    Threshold,
    BloomK,
    Grade,
    Curtain,
    GrainK,
    EarthRot,
    Sun,
    GlobeK,
    GlobeK2,
    CloudOff,
    Marker,
    MarkerCol,
    MarkerK,
    SunDir,
    SunRad,
    SunMat,
    ShadowK,
    SkyDay,
    SkySun,
    SkyGlow,
    SkyDisc,
    CloudSun,
    CloudAmb,
    SunCurve,
    Rect,
    Local,
    TexRect,
    Shape,
    Fill,
    Fill2,
    Stroke,
    StrokeW,
    TwBand,
    TwBelt,
    TwShape,
    TwShadow,
    Wave,
    WaterK,
    WaterShallow,
    MovingShadowK,
    Count,
}

const UNIFORM_NAMES: [&str; U::Count as usize] = [
    "uModel", "uDequant", "uViewProj", "uUv", "uBones", "uBase", "uEmissive", "uPbr", "uEnvK", "uWet", "uWet2", "uEye", "uFog", "uHemiSky",
    "uHemiGround", "uRipple", "uReflOn", "uLightPos", "uLightCol", "uLightDir", "uLightRight", "uLightUp", "uHaze", "uRayZ", "uRayX", "uRayY",
    "uZenith", "uHorizon", "uGlow", "uCam", "uTime", "uBox", "uWind", "uCenter", "uAmbient", "uDry", "uFogPos", "uFogCol", "uFogDir",
    "uOpacity", "uBoxMin", "uBoxMax", "uTexel", "uThreshold", "uBloomK", "uGrade",
    "uCurtain", "uGrainK", "uEarthRot", "uSun", "uGlobeK", "uGlobeK2", "uCloudOff", "uMarker", "uMarkerCol", "uMarkerK",
    "uSunDir", "uSunRad", "uSunMat", "uShadowK", "uSkyDay", "uSkySun", "uSkyGlow", "uSkyDisc", "uCloudSun", "uCloudAmb", "uSunCurve",
    "uRect", "uLocal", "uTexRect", "uShape", "uFill", "uFill2", "uStroke", "uStrokeW",
    "uTwBand", "uTwBelt", "uTwShape", "uTwShadow",
    "uWave", "uWaterK", "uWaterShallow",
    "uMovingShadowK",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub enum S {
    Albedo,
    NormalMap,
    Orm,
    Emission,
    Env,
    Puddles,
    Ripples,
    ReflSharp,
    ReflBlur,
    Beads,
    Clouds,
    Scene,
    HazeTex,
    Bloom,
    Source,
    Support,
    Lut,
    Mask,
    Grain,
    Lights,
    Inscatter,
    Transmit,
    Shadow,
    MovingShadow,
    Count,
}

const SAMPLER_NAMES: [&str; S::Count as usize] = [
    "uAlbedo", "uNormalMap", "uOrm", "uEmission", "uEnv", "uPuddles", "uRipples", "uReflSharp", "uReflBlur", "uBeads", "uClouds",
    "uScene", "uHazeTex", "uBloom", "uSource", "uSupport", "uLut", "uMask", "uGrain", "uLights", "uInscatter", "uTransmit", "uShadow",
    "uMovingShadow",
];

pub type Param = *const g::SceGxmProgramParameter;

pub struct Program {
    pub reg: Registered,
    pub hash: u64,
    pub uniforms: [Param; U::Count as usize],
    pub samplers: [u32; S::Count as usize],
    patcher: *mut g::SceGxmShaderPatcher,
}

impl Drop for Program {
    /// Runs after every pipeline patched from this program was released.
    fn drop(&mut self) {
        unsafe { g::sceGxmShaderPatcherUnregisterProgram(self.patcher, self.reg.id) };
    }
}

impl Program {
    unsafe fn new(patcher: *mut g::SceGxmShaderPatcher, bytes: &[u8], hash: u64) -> Result<Self, String> {
        let reg = Registered::new(patcher, Gxp::new(bytes)?)?;
        let mut uniforms = [core::ptr::null(); U::Count as usize];
        for (i, n) in UNIFORM_NAMES.iter().enumerate() {
            uniforms[i] = reg.param(n);
        }
        let mut samplers = [u32::MAX; S::Count as usize];
        for (i, n) in SAMPLER_NAMES.iter().enumerate() {
            samplers[i] = reg.sampler_index(n).unwrap_or(u32::MAX);
        }
        Ok(Self { reg, hash, uniforms, samplers, patcher })
    }
}

/// Vertex stream layouts the library's vertex shaders consume.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Layout {
    /// Pack `Static`: 24-byte quantised vertices.
    Static,
    /// Pack `Skinned`: 32 bytes.
    Skinned,
    /// Pack `Baked`: Static + square-root RGBM irradiance (28 bytes).
    Baked,
    /// Particles: seed u16n×4, corner f32×2, A f32×3, B f32×3 (40 bytes).
    Fx,
    /// f32×2 (full-screen triangles).
    Pos2,
    /// Atlas globe: position f32×3, uv f32×2 (20 bytes).
    Globe,
    /// Interface text: position f32×2 (display pixels), uv f32×2 (16 bytes).
    Text,
}

impl Layout {
    fn attrs(self) -> (&'static [(&'static str, u16, u32, u8)], u16) {
        use program::*;
        match self {
            Layout::Static => (&[("aPosition", 0, S16N, 4), ("aNormal", 8, S8N, 4), ("aTangent", 12, S8N, 4), ("aUv", 16, S16N, 2), ("aColor", 20, U8N, 4)], 24),
            Layout::Skinned => (
                &[
                    ("aPosition", 0, S16N, 4),
                    ("aNormal", 8, S8N, 4),
                    ("aTangent", 12, S8N, 4),
                    ("aUv", 16, S16N, 2),
                    ("aColor", 20, U8N, 4),
                    ("aJoints", 24, U8, 4),
                    ("aWeights", 28, U8N, 4),
                ],
                32,
            ),
            Layout::Baked => (
                &[("aPosition", 0, S16N, 4), ("aNormal", 8, S8N, 4), ("aTangent", 12, S8N, 4), ("aUv", 16, S16N, 2), ("aColor", 20, U8N, 4), ("aLight", 24, U8N, 4)],
                28,
            ),
            Layout::Fx => (&[("aSeed", 0, U16N, 4), ("aCorner", 8, F32, 2), ("aA", 16, F32, 3), ("aB", 28, F32, 3)], 40),
            Layout::Pos2 => (&[("aPosition", 0, F32, 2)], 8),
            Layout::Globe => (&[("aPosition", 0, F32, 3), ("aUv", 12, F32, 2)], 20),
            Layout::Text => (&[("aPosition", 0, F32, 2), ("aUv", 8, F32, 2)], 16),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PipeKey {
    pub vs: Key,
    pub fs: Key,
    pub layout: Layout,
    pub blend: BlendMode,
    pub output: Out,
    pub msaa: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BlendMode {
    Opaque,
    Alpha,
    Premultiplied,
    Additive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Out {
    Uchar4,
    Half4,
}

pub struct Pipeline {
    pub vp: *mut g::SceGxmVertexProgram,
    pub fp: *mut g::SceGxmFragmentProgram,
    pub vs: Arc<Program>,
    pub fs: Arc<Program>,
    patcher: *mut g::SceGxmShaderPatcher,
}

impl Drop for Pipeline {
    /// Callers drop pipelines only after the GPU finished the draws using them.
    fn drop(&mut self) {
        unsafe {
            g::sceGxmShaderPatcherReleaseFragmentProgram(self.patcher, self.fp);
            g::sceGxmShaderPatcherReleaseVertexProgram(self.patcher, self.vp);
        }
    }
}

pub enum Slot {
    Pending,
    Ready(Arc<Program>),
    /// Compiling or patching failed (the message is in `Gpu::errors`).
    Failed,
}

pub struct Gpu {
    pub patcher: *mut g::SceGxmShaderPatcher,
    /// Owns `patcher`'s memory; lives as long as the process.
    pub own: Patcher,
    pub service: Service,
    pub programs: HashMap<Key, Slot>,
    pipelines: HashMap<PipeKey, Option<Box<Pipeline>>>,
    /// Bumped when pipelines are dropped or programs finish compiling;
    /// callers caching `*const Pipeline` revalidate on change.
    pub epoch: u32,
    pub compiler: Option<Result<String, String>>,
    pub compiled: u32,
    pub compile_ms: u32,
    pub errors: Vec<String>,
    pub generation: u32,
    retired: Vec<Arc<Program>>,
}

impl Gpu {
    /// # Safety
    /// GXM initialised.
    pub unsafe fn new(live: bool) -> Result<Self, String> {
        // Pools sized for the ~115 material programs times their patched
        // variants (blend × sample count) plus replaced copies during hot reload.
        let own = Patcher::new(2 << 20, 512 << 10, 2 << 20)?;
        Ok(Self {
            patcher: own.raw,
            own,
            service: Service::start(live),
            programs: HashMap::new(),
            pipelines: HashMap::new(),
            epoch: 0,
            compiler: None,
            compiled: 0,
            compile_ms: 0,
            errors: Vec::new(),
            generation: 0,
            retired: Vec::new(),
        })
    }

    pub fn want(&mut self, key: &Key) {
        if !self.programs.contains_key(key) {
            self.programs.insert(key.clone(), Slot::Pending);
            self.service.request(key.clone());
        }
    }

    /// `hash label` per compiled program, sorted.
    pub fn manifest(&self) -> String {
        let mut lines: Vec<String> = self
            .programs
            .iter()
            .filter_map(|(k, s)| match s {
                Slot::Ready(p) => Some(format!("{:016x} {}", p.hash, k.label())),
                _ => None,
            })
            .collect();
        lines.sort();
        lines.join("\n") + "\n"
    }

    /// Programs waiting for their first build, plus those being rebuilt
    /// after a source change.
    pub fn pending(&self) -> usize {
        self.programs.values().filter(|s| matches!(s, Slot::Pending)).count() + self.service.rebuilding.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Applies finished compiles. A replaced program drops every pipeline
    /// built on it; the GPU is drained first because in-flight draws may
    /// still reference the old patched programs.
    pub fn poll(&mut self) {
        while let Ok(ev) = self.service.events.try_recv() {
            match ev {
                Event::Compiler(state) => self.compiler = Some(state),
                Event::Ready { key, gxp, hash, compiled_ms } => {
                    if let Some(ms) = compiled_ms {
                        self.compiled += 1;
                        self.compile_ms += ms;
                    }
                    let replacing = matches!(self.programs.get(&key), Some(Slot::Ready(p)) if p.hash != hash);
                    if replacing {
                        unsafe { g::vita2d_wait_rendering_done() };
                        self.pipelines.retain(|k, _| k.vs != key && k.fs != key);
                        self.epoch += 1;
                        if let Some(Slot::Ready(old)) = self.programs.remove(&key) {
                            self.retired.push(old);
                        }
                        self.generation += 1;
                    }
                    self.errors.retain(|e| !e.starts_with(&key.label()));
                    let slot = match unsafe { Program::new(self.patcher, &gxp, hash) } {
                        Ok(p) => Slot::Ready(Arc::new(p)),
                        Err(e) => {
                            self.errors.push(format!("{}: {e}", key.label()));
                            Slot::Failed
                        }
                    };
                    self.programs.insert(key, slot);
                    self.epoch += 1;
                }
                Event::Failed { key, error } => {
                    self.errors.retain(|e| !e.starts_with(&key.label()));
                    self.errors.push(error);
                    // Keep a working older program if there is one.
                    if !matches!(self.programs.get(&key), Some(Slot::Ready(_))) {
                        self.programs.insert(key, Slot::Failed);
                    }
                }
            }
        }
        // Retired programs stay registered until no pipeline holds them.
        self.retired.retain(|p| Arc::strong_count(p) > 1);
    }

    fn program(&self, key: &Key) -> Option<Arc<Program>> {
        match self.programs.get(key) {
            Some(Slot::Ready(p)) => Some(p.clone()),
            _ => None,
        }
    }

    /// Patched pipeline for `key`, created on first use. `None` while its
    /// programs compile or when patching failed (reported in `errors`).
    pub fn pipeline(&mut self, key: &PipeKey) -> Option<&Pipeline> {
        if !self.pipelines.contains_key(key) {
            self.want(&key.vs);
            self.want(&key.fs);
            let (Some(vs), Some(fs)) = (self.program(&key.vs), self.program(&key.fs)) else {
                return None;
            };
            let made = unsafe { self.make(key, vs, fs) };
            match made {
                Ok(p) => {
                    self.pipelines.insert(key.clone(), Some(Box::new(p)));
                }
                Err(e) => {
                    self.errors.push(format!("{}+{}: {e}", key.vs.label(), key.fs.label()));
                    self.pipelines.insert(key.clone(), None);
                }
            }
        }
        self.pipelines.get(key).and_then(|p| p.as_deref())
    }

    unsafe fn make(&self, key: &PipeKey, vs: Arc<Program>, fs: Arc<Program>) -> Result<Pipeline, String> {
        let (list, stride) = key.layout.attrs();
        let mut attrs = Vec::new();
        for &(name, offset, format, count) in list {
            if let Some(reg) = vs.reg.attribute_index(name) {
                attrs.push(Attr { reg, offset, format, count, stream: 0 });
            }
        }
        let vp = program::vertex_program(self.patcher, &vs.reg, &attrs, &[stride])?;
        let blend = match key.blend {
            BlendMode::Opaque => Blend::Opaque,
            BlendMode::Alpha => Blend::Alpha,
            BlendMode::Premultiplied => Blend::Premultiplied,
            BlendMode::Additive => Blend::Additive,
        };
        let output = match key.output {
            Out::Uchar4 => Output::Uchar4,
            Out::Half4 => Output::Half4,
        };
        let fp = match program::fragment_program(self.patcher, &fs.reg, output, key.msaa, blend, vs.reg.program()) {
            Ok(fp) => fp,
            Err(e) => {
                g::sceGxmShaderPatcherReleaseVertexProgram(self.patcher, vp);
                return Err(e);
            }
        };
        Ok(Pipeline { vp, fp, vs, fs, patcher: self.patcher })
    }
}

/// Per-draw uniform writer over the default uniform buffers.
pub struct Uniforms {
    pub vbuf: *mut core::ffi::c_void,
    pub fbuf: *mut core::ffi::c_void,
}

impl Uniforms {
    /// # Safety
    /// Pipeline programs bound on `ctx`; call once per draw before sceGxmDraw.
    pub unsafe fn reserve(ctx: *mut g::SceGxmContext, p: &Pipeline) -> Self {
        let mut vbuf = core::ptr::null_mut();
        let mut fbuf = core::ptr::null_mut();
        if g::sceGxmProgramGetDefaultUniformBufferSize(p.vs.reg.program()) > 0 {
            g::sceGxmReserveVertexDefaultUniformBuffer(ctx, &mut vbuf);
        }
        if g::sceGxmProgramGetDefaultUniformBufferSize(p.fs.reg.program()) > 0 {
            g::sceGxmReserveFragmentDefaultUniformBuffer(ctx, &mut fbuf);
        }
        Self { vbuf, fbuf }
    }

    #[inline]
    pub unsafe fn set(&self, p: &Pipeline, u: U, values: &[f32]) {
        let vp = p.vs.uniforms[u as usize];
        if !vp.is_null() && !self.vbuf.is_null() {
            g::sceGxmSetUniformDataF(self.vbuf, vp, 0, values.len() as u32, values.as_ptr());
        }
        let fp = p.fs.uniforms[u as usize];
        if !fp.is_null() && !self.fbuf.is_null() {
            g::sceGxmSetUniformDataF(self.fbuf, fp, 0, values.len() as u32, values.as_ptr());
        }
    }
}

/// Binds `tex` to the fragment sampler `s` if the program has it.
///
/// # Safety
/// Valid context and texture.
#[inline]
pub unsafe fn bind(ctx: *mut g::SceGxmContext, p: &Pipeline, s: S, tex: *const g::SceGxmTexture) {
    let unit = p.fs.samplers[s as usize];
    if unit != u32::MAX && !tex.is_null() {
        g::sceGxmSetFragmentTexture(ctx, unit, tex);
    }
}

/// An 8-bit single-channel tiled texture (32×32 tiles) over `px`.
pub(crate) unsafe fn tiled_u8(px: *mut u8, w: usize, h: usize, linear: bool, repeat: bool) -> Result<g::SceGxmTexture, String> {
    let mut t: g::SceGxmTexture = core::mem::zeroed();
    // GXM spells swizzles in ABGR order: U8_R111 puts the texel in alpha and
    // reads 1 in red. RRRR puts it in every channel, as the shaders read `.r`.
    let r = g::sceGxmTextureInitTiled(&mut t, px.cast(), g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8_RRRR, w as u32, h as u32, 0);
    if r < 0 {
        return Err(format!("tiled texture {w}x{h} 0x{:08x}", r as u32));
    }
    let f = if linear { g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR } else { g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT };
    g::sceGxmTextureSetMinFilter(&mut t, f);
    g::sceGxmTextureSetMagFilter(&mut t, f);
    let a = if repeat { g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_REPEAT } else { g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP };
    g::sceGxmTextureSetUAddrMode(&mut t, a);
    g::sceGxmTextureSetVAddrMode(&mut t, a);
    Ok(t)
}

/// Byte offset of texel (x, y) in a tiled 8-bit texture `w` texels wide.
pub(crate) fn tiled_at(x: usize, y: usize, w: usize) -> usize {
    ((y / 32) * (w / 32) + x / 32) * 1024 + (y % 32) * 32 + x % 32
}
