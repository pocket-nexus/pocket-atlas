//! Interface drawing over the presented frame, in display pixels (960×544,
//! top-left origin): rounded rectangles with a vertical gradient, a border
//! and a soft edge, images in them (`ui_v.cg` / `ui_f.cg`), and text in the
//! system font (vita2d PGF). Colours are display-encoded and premultiplied.

use pocket3d_gxm::mem::{Arena, Kind};
use pocket3d_gxm::target::Msaa;
use vita2d_sys as g;

use crate::gpu::{bind, BlendMode, Gpu, Layout, Out, PipeKey, Pipeline, Uniforms, S, U};
use crate::shaders::Key;

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

/// Whether the system font draws every character of `s`: it holds Latin,
/// Greek, Cyrillic, Japanese (JIS X 0208) and common symbols; other scripts
/// (Hangul, Devanagari, …) come out as blanks.
pub fn drawable(s: &str) -> bool {
    s.chars().all(|c| {
        matches!(c as u32,
            0x0000..=0x024f | 0x0370..=0x04ff | 0x2000..=0x22ff | 0x2460..=0x27bf | 0x3000..=0x30ff | 0x3200..=0x33ff | 0x4e00..=0x9fff | 0xff00..=0xffef)
    })
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
    Start,
    Select,
    Stick,
    Pad,
}

pub struct Ui {
    pub font: *mut g::vita2d_pgf,
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
        Ok(Self { font, quad_vb: vb, quad_ib: ib, _mem: mem })
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

    /// Programs the interface uses, so they compile before it is first drawn.
    pub fn warm(gpu: &mut Gpu) {
        for k in [Self::key(false), Self::key(true)] {
            gpu.want(&k.vs);
            gpu.want(&k.fs);
        }
    }

    unsafe fn draw(&self, gpu: &mut Gpu, tex: Option<*const g::SceGxmTexture>, x: f32, y: f32, w: f32, h: f32, uv: [f32; 4], s: &Style) {
        if w <= 0.0 || h <= 0.0 || x >= W || y >= H || x + w <= 0.0 || y + h <= 0.0 {
            return;
        }
        let Some(p) = gpu.pipeline(&Self::key(tex.is_some())) else { return };
        let p = &*(p as *const Pipeline);
        let ctx = g::vita2d_get_context();
        g::sceGxmSetVertexProgram(ctx, p.vp);
        g::sceGxmSetFragmentProgram(ctx, p.fp);
        g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS);
        g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
        g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
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

    /// Text with its baseline at `y`.
    ///
    /// # Safety
    /// Inside the display scene.
    pub unsafe fn text(&self, x: f32, y: f32, color: [f32; 4], scale: f32, s: &str) {
        if s.is_empty() || color[3] <= 0.004 {
            return;
        }
        let c = std::ffi::CString::new(s.replace('\0', " ")).unwrap();
        g::vita2d_pgf_draw_text(self.font, x.round() as i32, y.round() as i32, abgr(color), scale, c.as_ptr());
    }

    pub unsafe fn width(&self, scale: f32, s: &str) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        let c = std::ffi::CString::new(s.replace('\0', " ")).unwrap();
        g::vita2d_pgf_text_width(self.font, scale, c.as_ptr()) as f32
    }

    /// `s`, cut with an ellipsis to fit `max` pixels.
    pub unsafe fn fit(&self, scale: f32, s: &str, max: f32) -> String {
        if self.width(scale, s) <= max {
            return s.to_string();
        }
        let chars: Vec<char> = s.chars().collect();
        let (mut lo, mut hi) = (0usize, chars.len());
        while lo < hi {
            let mid = (lo + hi + 1) / 2;
            let t: String = chars[..mid].iter().collect::<String>() + "…";
            if self.width(scale, &t) <= max { lo = mid } else { hi = mid - 1 }
        }
        chars[..lo].iter().collect::<String>().trim_end().to_string() + "…"
    }

    /// Right-aligned text ending at `x`.
    pub unsafe fn text_right(&self, x: f32, y: f32, color: [f32; 4], scale: f32, s: &str) {
        self.text(x - self.width(scale, s), y, color, scale, s);
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
        let r = 9.0;
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
                    Button::Cross => self.text(cx - self.width(0.62, "×") * 0.5, cy + 5.0, c, 0.62, "×"),
                    _ => self.text(cx - self.width(0.5, "△") * 0.5, cy + 4.5, c, 0.5, "△"),
                }
                r * 2.0
            }
            Button::L | Button::R | Button::Start | Button::Select => {
                let label = match b {
                    Button::L => "L",
                    Button::R => "R",
                    Button::Start => "START",
                    _ => "SELECT",
                };
                let tw = self.width(0.5, label);
                let w = (tw + 14.0).max(22.0);
                self.rect(gpu, cx - w * 0.5, cy - 8.0, w, 16.0, &Style::fill(5.0, rgb(0x0b0d12, 0.62 * opacity)).stroke(1.0, rgb(0xc8ccd6, 0.7 * opacity)));
                self.text(cx - tw * 0.5, cy + 4.5, rgb(0xe6e8ee, opacity), 0.5, label);
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

    /// Button glyph then a label; returns the advance.
    ///
    /// # Safety
    /// Inside the display scene.
    pub unsafe fn hint(&self, gpu: &mut Gpu, x: f32, cy: f32, buttons: &[Button], label: &str, opacity: f32) -> f32 {
        let mut cx = x;
        for b in buttons {
            let w = match b {
                Button::L | Button::R | Button::Start | Button::Select => self.width(0.5, if *b == Button::Start { "START" } else if *b == Button::Select { "SELECT" } else { "L" }).max(8.0) + 14.0,
                Button::Pad => 16.0,
                _ => 18.0,
            };
            self.button(gpu, cx + w * 0.5, cy, *b, opacity);
            cx += w + 3.0;
        }
        cx += 4.0;
        self.text(cx, cy + 5.0, rgb(0xd8dbe2, 0.85 * opacity), 0.62, label);
        cx + self.width(0.62, label) - x
    }
}
