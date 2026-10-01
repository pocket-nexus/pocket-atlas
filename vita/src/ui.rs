//! Interface drawing over the presented frame, in display pixels (960×544,
//! top-left origin): rounded rectangles with a vertical gradient, a border
//! and a soft edge, images in them (`ui_v.cg` / `ui_f.cg`), and text. Text
//! comes from the baked atlas `ui.font` (Inter and Noto Sans CJK at the
//! interface's sizes, drawn 1:1 on whole pixels, one draw per string;
//! `text_v.cg` / `text_f.cg`); a string with a character the atlas lacks
//! (typed into the search) falls back to the system's vector fonts (PVF).
//! Colours are display-encoded and premultiplied.

use std::cell::RefCell;
use std::collections::HashMap;

use pocket3d_gxm::mem::{Arena, Kind, Ring};
use pocket3d_gxm::target::Msaa;
use vita2d_sys as g;

use crate::gpu::{bind, tiled_at, tiled_u8, BlendMode, Gpu, Layout, Out, PipeKey, Pipeline, Uniforms, S, U};
use crate::scene::{find, Seq};
use pocket3d_place as pc;
use crate::shaders::Key;

/// Text styles, in the order of the shared table `pc::atlas::STYLES` (the
/// baked font's style index; checked by name when the font loads).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum T {
    /// Regular 15 px: secondary lines.
    Caption,
    /// Bold 13 px: uppercase labels, chips, tabs.
    Label,
    /// Regular 17 px.
    Body,
    /// Bold 17 px.
    Strong,
    /// Bold 21 px.
    Title,
    /// Bold 27 px.
    Heading,
    /// Bold 34 px.
    Brand,
    /// Bold 15 px.
    Small,
}

impl T {
    const ALL: [T; 8] = [T::Caption, T::Label, T::Body, T::Strong, T::Title, T::Heading, T::Brand, T::Small];

    fn name(self) -> &'static str {
        pc::atlas::STYLES[self as usize].0
    }

    /// Em size in pixels.
    pub fn px(self) -> f32 {
        pc::atlas::STYLES[self as usize].1
    }
}

/// The baked interface font (`FONT` and `META.font` in the atlas pack):
/// coverage atlas (U8, tiled) and glyph table.
struct Baked {
    tex: g::SceGxmTexture,
    size: (f32, f32),
    glyphs: HashMap<u64, pc::atlas::Glyph>,
    _vram: Arena,
}

impl Baked {
    fn key(t: T, c: char) -> u64 {
        (t as u64) << 32 | c as u64
    }

    /// From the first atlas pack found, read through `Seq` (no stat on the
    /// USB share).
    unsafe fn load() -> Result<Self, String> {
        let mut err = String::from("no atlas pack");
        for path in crate::paths::candidates("atlas.pack") {
            match Self::load_from(&path) {
                Ok(b) => return Ok(b),
                Err(e) if !e.contains("No such file") => err = e,
                Err(_) => {}
            }
        }
        Err(err)
    }

    unsafe fn load_from(path: &str) -> Result<Self, String> {
        let mut f = Seq::open(path)?;
        let sections = f.sections(pc::atlas::MAGIC)?;
        let meta: pc::atlas::AtlasMeta = serde_json::from_slice(&f.section(&find(&sections, pc::TAG_META)?)?).map_err(|e| format!("{path}: {e}"))?;
        let font = meta.font.ok_or(format!("{path}: no interface font"))?;
        for t in T::ALL {
            if font.styles.get(t as usize).map(|s| s.name.as_str()) != Some(t.name()) {
                return Err(format!("{path}: font style {} is not `{}`", t as usize, t.name()));
            }
        }
        let (w, h) = (font.width as usize, font.height as usize);
        let px = f.section(&find(&sections, pc::atlas::TAG_FONT)?)?;
        if px.len() < w * h || w % 32 != 0 || h % 32 != 0 {
            return Err(format!("{path}: font atlas {w}×{h}"));
        }
        let mut vram = Arena::new(Kind::Cdram, w * h + 4096);
        let mem = vram.alloc(w * h, 4096)?;
        for y in 0..h {
            for x in 0..w {
                *mem.add(tiled_at(x, y, w)) = px[y * w + x];
            }
        }
        let tex = tiled_u8(mem, w, h, true, false)?;
        let glyphs = font.glyphs.into_iter().map(|gl| ((gl.style as u64) << 32 | gl.cp as u64, gl)).collect();
        Ok(Self { tex, size: (w as f32, h as f32), glyphs, _vram: vram })
    }

    fn has(&self, t: T, s: &str) -> bool {
        s.chars().all(|c| self.glyphs.contains_key(&Self::key(t, c)))
    }

    fn width(&self, t: T, s: &str) -> f32 {
        s.chars().map(|c| self.glyphs.get(&Self::key(t, c)).map_or(0.0, |g| g.advance)).sum()
    }
}

/// Glyph quads per frame (four 16-byte vertices each).
const MAX_QUADS: usize = 4096;

/// Premultiplied colour from `0xRRGGBB` and an opacity.
pub fn rgb(hex: u32, a: f32) -> [f32; 4] {
    let c = |s: u32| ((hex >> s) & 0xff) as f32 / 255.0 * a;
    [c(16), c(8), c(0), a]
}

/// A colour at another opacity.
pub fn alpha(c: [f32; 4], k: f32) -> [f32; 4] {
    c.map(|v| v * k)
}

/// A vita2d text colour (0xAABBGGRR) from a premultiplied colour.
pub fn abgr(c: [f32; 4]) -> u32 {
    let a = c[3].clamp(0.0, 1.0);
    let s = |v: f32| if a > 0.0 { ((v / a).clamp(0.0, 1.0) * 255.0).round() as u32 } else { 0 };
    ((a * 255.0).round() as u32) << 24 | s(c[2]) << 16 | s(c[1]) << 8 | s(c[0])
}

/// Linear place accent (atlas pack) to a display colour.
pub fn accent(c: [f32; 3], a: f32) -> [f32; 4] {
    let s = |v: f32| {
        let v = v.clamp(0.0, 1.0);
        if v < 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
    };
    [s(c[0]) * a, s(c[1]) * a, s(c[2]) * a, a]
}

/// Whether the system fonts draw every character of `s`: Latin, Greek,
/// Cyrillic, Japanese, Chinese, Korean and common symbols; other scripts
/// (Devanagari, Thai, …) come out as blanks.
pub fn drawable(s: &str) -> bool {
    s.chars().all(|c| {
        matches!(c as u32,
            0x0000..=0x024f | 0x0370..=0x04ff | 0x1100..=0x11ff | 0x2000..=0x22ff | 0x2460..=0x27bf | 0x3000..=0x30ff | 0x3130..=0x318f
            | 0x3200..=0x33ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7af | 0xff00..=0xffef)
    })
}

unsafe extern "C" fn latin_group(c: u32) -> i32 {
    (c < 0x0250 || (0x2000..=0x206f).contains(&c)) as i32
}

unsafe extern "C" fn hangul_group(c: u32) -> i32 {
    matches!(c, 0x1100..=0x11ff | 0x3130..=0x318f | 0xac00..=0xd7af) as i32
}

/// Latin and Korean faces in front of a Japanese or Chinese one, which takes
/// every other character (kanji/hanzi forms differ between the two).
unsafe fn system_pvf(cjk: g::ScePvfLanguageCode) -> *mut g::vita2d_pvf {
    let configs = [
        g::vita2d_system_pvf_config { code: g::ScePvfLanguageCode_SCE_PVF_LANGUAGE_LATIN, in_font_group: Some(latin_group) },
        g::vita2d_system_pvf_config { code: g::ScePvfLanguageCode_SCE_PVF_LANGUAGE_K, in_font_group: Some(hangul_group) },
        g::vita2d_system_pvf_config { code: cjk, in_font_group: None },
    ];
    g::vita2d_load_system_pvf(configs.len() as i32, configs.as_ptr())
}

/// Text written in Chinese: Han characters and no kana.
fn chinese(s: &str) -> bool {
    let mut han = false;
    for c in s.chars() {
        match c as u32 {
            0x3040..=0x30ff => return false,
            0x3400..=0x4dbf | 0x4e00..=0x9fff => han = true,
            _ => {}
        }
    }
    han
}

#[derive(Clone, Copy)]
pub struct Style {
    pub radius: f32,
    pub fill: [f32; 4],
    /// Bottom colour of the gradient (`fill` for a flat one).
    pub fill2: [f32; 4],
    pub stroke: [f32; 4],
    pub stroke_w: f32,
    /// Edge ramp in pixels: 1 for an anti-aliased edge, more for a shadow.
    pub soft: f32,
}

impl Style {
    pub const fn fill(radius: f32, c: [f32; 4]) -> Self {
        Self { radius, fill: c, fill2: c, stroke: [0.0; 4], stroke_w: 0.0, soft: 1.0 }
    }

    pub const fn gradient(radius: f32, top: [f32; 4], bottom: [f32; 4]) -> Self {
        Self { radius, fill: top, fill2: bottom, stroke: [0.0; 4], stroke_w: 0.0, soft: 1.0 }
    }

    pub const fn stroke(mut self, width: f32, c: [f32; 4]) -> Self {
        self.stroke = c;
        self.stroke_w = width;
        self
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Cross,
    Circle,
    Triangle,
    Square,
    L,
    R,
    Stick,
    Pad,
}

pub struct Ui {
    font: *mut g::vita2d_pgf,
    /// Vector fonts (null when the system has none): Japanese-first and
    /// Chinese-first, and the size that matches the PGF font at a scale.
    ja: *mut g::vita2d_pvf,
    zh: *mut g::vita2d_pvf,
    pvf_scale: f32,
    baked: Option<Baked>,
    /// Glyph vertices, written per frame (three frames in flight at most).
    ring: RefCell<Ring>,
    text_ib: *const u16,
    /// The three interface pipelines (flat, image, text) and the shader
    /// generation they were looked up at.
    pipes: RefCell<(u32, [*const Pipeline; 3])>,
    quad_vb: *const f32,
    quad_ib: *const u16,
    /// Holds the quad for the life of the process.
    _mem: Arena,
}

const W: f32 = 960.0;
const H: f32 = 544.0;

impl Ui {
    /// # Safety
    /// GXM initialised.
    pub unsafe fn new(font: *mut g::vita2d_pgf) -> Result<Self, String> {
        let mut mem = Arena::new(Kind::Main, 4096);
        let vb = mem.alloc(8 * 4, 16)?.cast::<f32>();
        for (i, v) in [0.0f32, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0].iter().enumerate() {
            *vb.add(i) = *v;
        }
        let ib = mem.alloc(6 * 2, 16)?.cast::<u16>();
        for (i, v) in [0u16, 1, 2, 2, 1, 3].iter().enumerate() {
            *ib.add(i) = *v;
        }
        let ja = system_pvf(g::ScePvfLanguageCode_SCE_PVF_LANGUAGE_J);
        let zh = system_pvf(g::ScePvfLanguageCode_SCE_PVF_LANGUAGE_C);
        let zh = if zh.is_null() { ja } else { zh };
        // The width the layout was drawn with in the PGF font.
        let pvf_scale = if ja.is_null() {
            1.0
        } else {
            let m = c"Places people remember, Pocket Atlas".as_ptr();
            let (a, b) = (g::vita2d_pgf_text_width(font, 1.0, m) as f32, g::vita2d_pvf_text_width(ja, 1.0, m) as f32);
            if a > 0.0 && b > 0.0 { a / b } else { 1.0 }
        };
        let baked = match Baked::load() {
            Ok(b) => Some(b),
            Err(e) => {
                pocketjs_vita::vita_log(format_args!("atlas: {e}; system fonts only"));
                None
            }
        };
        let text_ib = mem.alloc(MAX_QUADS * 6 * 2, 16)?.cast::<u16>();
        for q in 0..MAX_QUADS {
            let v = (q * 4) as u16;
            for (k, i) in [0u16, 1, 2, 2, 1, 3].iter().enumerate() {
                *text_ib.add(q * 6 + k) = v + i;
            }
        }
        let ring = RefCell::new(Ring::new(MAX_QUADS * 64, 3)?);
        pocketjs_vita::vita_log(format_args!("atlas: ui fonts baked={} pvf ja={} zh={}", baked.as_ref().map_or(0, |b| b.glyphs.len()), !ja.is_null(), zh != ja));
        Ok(Self { font, ja, zh, pvf_scale, baked, ring, text_ib, pipes: RefCell::new((u32::MAX, [core::ptr::null(); 3])), quad_vb: vb, quad_ib: ib, _mem: mem })
    }

    /// Starts a frame's text: glyph vertices of the frame three back are free.
    pub fn begin_frame(&self) {
        self.ring.borrow_mut().next_frame();
    }

    fn key(tex: bool) -> PipeKey {
        PipeKey {
            vs: Key::new("ui_v.cg", &[]),
            fs: Key::new("ui_f.cg", if tex { &["TEX"] } else { &[] }),
            layout: Layout::Pos2,
            blend: BlendMode::Premultiplied,
            output: Out::Uchar4,
            msaa: Msaa::None.gxm(),
        }
    }

    fn text_key() -> PipeKey {
        PipeKey { vs: Key::new("text_v.cg", &[]), fs: Key::new("text_f.cg", &[]), layout: Layout::Text, blend: BlendMode::Premultiplied, output: Out::Uchar4, msaa: Msaa::None.gxm() }
    }

    /// A pipeline (0 flat, 1 image, 2 text), looked up again when shaders
    /// reload; bound with the interface's fixed state.
    unsafe fn pipeline(&self, gpu: &mut Gpu, which: usize) -> Option<&'static Pipeline> {
        let mut c = self.pipes.borrow_mut();
        if c.0 != gpu.epoch {
            *c = (gpu.epoch, [core::ptr::null(); 3]);
        }
        if c.1[which].is_null() {
            let key = match which {
                0 => Self::key(false),
                1 => Self::key(true),
                _ => Self::text_key(),
            };
            c.1[which] = gpu.pipeline(&key).map_or(core::ptr::null(), |p| p as *const Pipeline);
        }
        let p = c.1[which].as_ref()?;
        let ctx = g::vita2d_get_context();
        g::sceGxmSetVertexProgram(ctx, p.vp);
        g::sceGxmSetFragmentProgram(ctx, p.fp);
        g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS);
        g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
        g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
        Some(p)
    }

    /// Programs the interface uses, so they compile before it is first drawn.
    pub fn warm(gpu: &mut Gpu) {
        for k in [Self::key(false), Self::key(true), Self::text_key()] {
            gpu.want(&k.vs);
            gpu.want(&k.fs);
        }
    }

    unsafe fn draw(&self, gpu: &mut Gpu, tex: Option<*const g::SceGxmTexture>, x: f32, y: f32, w: f32, h: f32, uv: [f32; 4], s: &Style) {
        if w <= 0.0 || h <= 0.0 || x >= W || y >= H || x + w <= 0.0 || y + h <= 0.0 {
            return;
        }
        let Some(p) = self.pipeline(gpu, tex.is_some() as usize) else { return };
        let ctx = g::vita2d_get_context();
        // A soft edge spreads outside the rectangle.
        let pad = (s.soft - 1.0).max(0.0) + 1.0;
        let (hw, hh) = (w * 0.5, h * 0.5);
        let u = Uniforms::reserve(ctx, p);
        u.set(p, U::Rect, &[x - pad, y - pad, x + w + pad, y + h + pad]);
        u.set(p, U::Local, &[-hw - pad, -hh - pad, hw + pad, hh + pad]);
        let (du, dv) = ((uv[2] - uv[0]) / w * pad, (uv[3] - uv[1]) / h * pad);
        u.set(p, U::TexRect, &[uv[0] - du, uv[1] - dv, uv[2] + du, uv[3] + dv]);
        u.set(p, U::Shape, &[hw, hh, s.radius.min(hw).min(hh), s.soft.max(0.5)]);
        u.set(p, U::Fill, &s.fill);
        u.set(p, U::Fill2, &s.fill2);
        u.set(p, U::Stroke, &s.stroke);
        u.set(p, U::StrokeW, &[s.stroke_w, 0.0, 0.0, 0.0]);
        if let Some(t) = tex {
            bind(ctx, p, S::Source, t);
        }
        g::sceGxmSetVertexStream(ctx, 0, self.quad_vb.cast());
        g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.quad_ib.cast(), 6);
    }

    /// # Safety
    /// Inside the display scene.
    pub unsafe fn rect(&self, gpu: &mut Gpu, x: f32, y: f32, w: f32, h: f32, s: &Style) {
        self.draw(gpu, None, x, y, w, h, [0.0, 0.0, 1.0, 1.0], s);
    }

    /// `tex` over the rectangle (cropped to `uv`), multiplied by the style's
    /// gradient.
    ///
    /// # Safety
    /// Inside the display scene; `tex` valid until the GPU has drawn it.
    pub unsafe fn image(&self, gpu: &mut Gpu, tex: *const g::SceGxmTexture, x: f32, y: f32, w: f32, h: f32, uv: [f32; 4], s: &Style) {
        self.draw(gpu, Some(tex), x, y, w, h, uv, s);
    }

    /// A soft shadow under a rounded rectangle.
    ///
    /// # Safety
    /// Inside the display scene.
    pub unsafe fn shadow(&self, gpu: &mut Gpu, x: f32, y: f32, w: f32, h: f32, radius: f32, blur: f32, opacity: f32) {
        let s = Style { soft: blur, ..Style::fill(radius + blur * 0.5, rgb(0x000000, opacity)) };
        self.draw(gpu, None, x, y + blur * 0.25, w, h, [0.0, 0.0, 1.0, 1.0], &s);
    }

    /// Text with its baseline at `y`; returns its advance.
    ///
    /// # Safety
    /// Inside the display scene.
    pub unsafe fn text(&self, gpu: &mut Gpu, x: f32, y: f32, color: [f32; 4], t: T, s: &str) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        match &self.baked {
            Some(b) if b.has(t, s) => {
                if color[3] > 0.004 {
                    self.baked_text(gpu, b, x, y, color, t, s);
                }
                b.width(t, s)
            }
            _ => {
                let scale = self.pgf_scale(t);
                if color[3] > 0.004 {
                    let c = std::ffi::CString::new(s.replace('\0', " ")).unwrap();
                    match self.pvf(s) {
                        Some(f) => {
                            g::vita2d_pvf_draw_text(f, x.round() as i32, y.round() as i32, abgr(color), scale * self.pvf_scale, c.as_ptr());
                        }
                        None => {
                            g::vita2d_pgf_draw_text(self.font, x.round() as i32, y.round() as i32, abgr(color), scale, c.as_ptr());
                        }
                    }
                }
                self.system_width(scale, s)
            }
        }
    }

    unsafe fn baked_text(&self, gpu: &mut Gpu, b: &Baked, x: f32, y: f32, color: [f32; 4], t: T, s: &str) {
        let n = s.chars().filter(|&c| b.glyphs.get(&Baked::key(t, c)).is_some_and(|g| g.w > 0)).count();
        if n == 0 || n > MAX_QUADS {
            return;
        }
        let Some(vb) = self.ring.borrow_mut().alloc(n * 64, 16) else { return };
        let v = vb.cast::<f32>();
        let (iw, ih) = (1.0 / b.size.0, 1.0 / b.size.1);
        let (mut pen, by) = (x, y.round());
        let mut q = 0;
        for c in s.chars() {
            let Some(gl) = b.glyphs.get(&Baked::key(t, c)) else { continue };
            if gl.w > 0 {
                let (x0, y0) = (pen.round() + gl.left as f32, by + gl.top as f32);
                let (x1, y1) = (x0 + gl.w as f32, y0 + gl.h as f32);
                let (u0, v0) = (gl.x as f32 * iw, gl.y as f32 * ih);
                let (u1, v1) = ((gl.x + gl.w) as f32 * iw, (gl.y + gl.h) as f32 * ih);
                let quad = [x0, y0, u0, v0, x1, y0, u1, v0, x0, y1, u0, v1, x1, y1, u1, v1];
                core::ptr::copy_nonoverlapping(quad.as_ptr(), v.add(q * 16), 16);
                q += 1;
            }
            pen += gl.advance;
        }
        let Some(p) = self.pipeline(gpu, 2) else { return };
        let ctx = g::vita2d_get_context();
        let u = Uniforms::reserve(ctx, p);
        u.set(p, U::Fill, &color);
        bind(ctx, p, S::Source, &b.tex);
        g::sceGxmSetVertexStream(ctx, 0, vb.cast());
        g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.text_ib.cast(), (q * 6) as u32);
    }

    /// The system font scale for a style's size (PGF units; PVF via `pvf_scale`).
    fn pgf_scale(&self, t: T) -> f32 {
        t.px() / 19.0
    }

    fn pvf(&self, s: &str) -> Option<*mut g::vita2d_pvf> {
        if self.ja.is_null() {
            return None;
        }
        Some(if chinese(s) { self.zh } else { self.ja })
    }

    unsafe fn system_width(&self, scale: f32, s: &str) -> f32 {
        let c = std::ffi::CString::new(s.replace('\0', " ")).unwrap();
        match self.pvf(s) {
            Some(f) => g::vita2d_pvf_text_width(f, scale * self.pvf_scale, c.as_ptr()) as f32,
            None => g::vita2d_pgf_text_width(self.font, scale, c.as_ptr()) as f32,
        }
    }

    pub unsafe fn width(&self, t: T, s: &str) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        match &self.baked {
            Some(b) if b.has(t, s) => b.width(t, s),
            _ => self.system_width(self.pgf_scale(t), s),
        }
    }

    /// `s`, cut with an ellipsis to fit `max` pixels.
    pub unsafe fn fit(&self, t: T, s: &str, max: f32) -> String {
        if self.width(t, s) <= max {
            return s.to_string();
        }
        let chars: Vec<char> = s.chars().collect();
        let (mut lo, mut hi) = (0usize, chars.len());
        while lo < hi {
            let mid = (lo + hi + 1) / 2;
            let cut: String = chars[..mid].iter().collect::<String>() + "…";
            if self.width(t, &cut) <= max { lo = mid } else { hi = mid - 1 }
        }
        chars[..lo].iter().collect::<String>().trim_end().to_string() + "…"
    }

    /// Text with a soft dark shadow, for lines over the scene.
    ///
    /// # Safety
    /// Inside the display scene.
    pub unsafe fn text_shadow(&self, gpu: &mut Gpu, x: f32, y: f32, color: [f32; 4], t: T, s: &str) -> f32 {
        let k = color[3];
        self.text(gpu, x + 1.0, y + 1.5, rgb(0x000000, 0.7 * k), t, s);
        self.text(gpu, x, y, color, t, s)
    }

    /// Right-aligned text ending at `x`.
    pub unsafe fn text_right(&self, gpu: &mut Gpu, x: f32, y: f32, color: [f32; 4], t: T, s: &str) -> f32 {
        let w = self.width(t, s);
        self.text(gpu, x - w, y, color, t, s);
        w
    }

    /// Restricts every following draw (text included) to a rectangle, through
    /// the display scene's stencil; `None` lifts it.
    ///
    /// # Safety
    /// Inside the display scene.
    pub unsafe fn clip(&self, r: Option<(f32, f32, f32, f32)>) {
        match r {
            Some((x, y, w, h)) => {
                g::vita2d_enable_clipping();
                g::vita2d_set_clip_rectangle(x as i32, y as i32, (x + w) as i32, (y + h) as i32);
            }
            None => g::vita2d_disable_clipping(),
        }
    }

    /// A controller button glyph centred on (`cx`, `cy`); returns its width.
    ///
    /// # Safety
    /// Inside the display scene.
    pub unsafe fn button(&self, gpu: &mut Gpu, cx: f32, cy: f32, b: Button, opacity: f32) -> f32 {
        let face = |c: u32| rgb(c, opacity);
        let r = 10.0;
        let disc = |c: [f32; 4]| Style::fill(r, rgb(0x0b0d12, 0.62 * opacity)).stroke(1.5, alpha(c, 0.9));
        match b {
            Button::Cross | Button::Circle | Button::Triangle | Button::Square => {
                let c = match b {
                    Button::Cross => face(0x8fb4ff),
                    Button::Circle => face(0xff7a7a),
                    Button::Triangle => face(0x5fe0b0),
                    _ => face(0xf59ad8),
                };
                self.rect(gpu, cx - r, cy - r, r * 2.0, r * 2.0, &disc(c));
                match b {
                    Button::Circle => self.rect(gpu, cx - 4.5, cy - 4.5, 9.0, 9.0, &Style::fill(4.5, [0.0; 4]).stroke(1.6, c)),
                    Button::Square => self.rect(gpu, cx - 4.0, cy - 4.0, 8.0, 8.0, &Style::fill(0.5, [0.0; 4]).stroke(1.5, c)),
                    Button::Cross => {
                        self.rect(gpu, cx - 5.0, cy - 1.0, 10.0, 2.0, &Style::fill(1.0, c));
                        self.rect(gpu, cx - 1.0, cy - 5.0, 2.0, 10.0, &Style::fill(1.0, c));
                    }
                    _ => {
                        self.text(gpu, cx - self.width(T::Small, "△") * 0.5, cy + 5.0, c, T::Small, "△");
                    }
                }
                r * 2.0
            }
            Button::L | Button::R => {
                let label = if b == Button::L { "L" } else { "R" };
                let tw = self.width(T::Label, label);
                let w = self.button_width(b);
                self.rect(gpu, cx - w * 0.5, cy - 9.0, w, 18.0, &Style::fill(5.0, rgb(0x0b0d12, 0.62 * opacity)).stroke(1.0, rgb(0xc8ccd6, 0.7 * opacity)));
                self.text(gpu, (cx - tw * 0.5).round(), cy + 5.0, rgb(0xe6e8ee, opacity), T::Label, label);
                w
            }
            Button::Stick => {
                self.rect(gpu, cx - r, cy - r, r * 2.0, r * 2.0, &Style::fill(r, rgb(0x0b0d12, 0.62 * opacity)).stroke(1.5, rgb(0xc8ccd6, 0.7 * opacity)));
                self.rect(gpu, cx - 3.5, cy - 3.5, 7.0, 7.0, &Style::fill(3.5, rgb(0xe6e8ee, opacity)));
                r * 2.0
            }
            Button::Pad => {
                let c = rgb(0xe6e8ee, 0.85 * opacity);
                self.rect(gpu, cx - 2.5, cy - 8.0, 5.0, 16.0, &Style::fill(1.5, c));
                self.rect(gpu, cx - 8.0, cy - 2.5, 16.0, 5.0, &Style::fill(1.5, c));
                16.0
            }
        }
    }

    /// The width a button glyph takes.
    pub fn button_width(&self, b: Button) -> f32 {
        match b {
            Button::L | Button::R => 24.0,
            Button::Pad => 16.0,
            _ => 20.0,
        }
    }

    /// Button glyph then a label; returns the advance.
    ///
    /// # Safety
    /// Inside the display scene.
    pub unsafe fn hint(&self, gpu: &mut Gpu, x: f32, cy: f32, buttons: &[Button], label: &str, opacity: f32) -> f32 {
        let mut cx = x;
        for b in buttons {
            let w = self.button_width(*b);
            self.button(gpu, cx + w * 0.5, cy, *b, opacity);
            cx += w + 3.0;
        }
        cx += 5.0;
        let w = self.text(gpu, cx, cy + 5.0, rgb(0xe2e5ec, 0.92 * opacity), T::Small, label);
        cx + w - x
    }
}
