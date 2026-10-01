//! The settings sheet over a running place (SELECT): frame rate profile,
//! quality step, resolution, anti-aliasing, the effects the place has,
//! exposure, the camera shot and the performance overlay. Choices carry to
//! the next place and are kept in `ux0:data/pocket-atlas/settings.json`;
//! what is not chosen follows the profile.

use pocket3d_gxm::target::Msaa;
use serde_json::{json, Value};

use crate::camera::{Mode, Rig};
use crate::frame::{Renderer, SCALES};
use crate::gpu::Gpu;
use crate::profile::{self, Profile};
use crate::ui::{accent, rgb, Button, Style, Ui};

const PATH: &str = "ux0:data/pocket-atlas/settings.json";

/// The player's choices; `None` follows the profile (and its governor).
pub struct Prefs {
    pub profile: &'static Profile,
    pub step: Option<usize>,
    pub scale: Option<usize>,
    pub msaa: Option<bool>,
    pub bloom: Option<bool>,
    pub haze: Option<bool>,
    pub reflection: Option<bool>,
    pub rain: Option<bool>,
    pub exposure_ev: f32,
    pub hud: bool,
}

impl Prefs {
    pub fn load(hud: bool) -> Self {
        let v: Value = std::fs::read(PATH).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
        let b = |k: &str| v[k].as_bool();
        Self {
            profile: v["profile"].as_str().and_then(profile::by_name).unwrap_or(&profile::VITA30),
            step: v["step"].as_u64().map(|n| n as usize),
            scale: v["scale"].as_u64().map(|n| (n as usize).min(SCALES.len() - 1)),
            msaa: b("msaa"),
            bloom: b("bloom"),
            haze: b("haze"),
            reflection: b("reflection"),
            rain: b("rain"),
            exposure_ev: v["exposureEv"].as_f64().unwrap_or(0.0) as f32,
            hud: b("hud").unwrap_or(hud),
        }
    }

    pub fn save(&self) {
        let v = json!({
            "profile": self.profile.name, "step": self.step, "scale": self.scale, "msaa": self.msaa, "bloom": self.bloom,
            "haze": self.haze, "reflection": self.reflection, "rain": self.rain, "exposureEv": self.exposure_ev, "hud": self.hud,
        });
        let _ = std::fs::create_dir_all("ux0:data/pocket-atlas");
        let _ = std::fs::write(PATH, v.to_string());
    }

    /// Sets the renderer to the profile, then the choices over it.
    pub fn apply(&self, r: &mut Renderer) {
        r.set_profile(self.profile);
        self.overrides(r);
    }

    /// The choices over the renderer's current profile (the governor keeps
    /// its step unless one is chosen).
    pub fn overrides(&self, r: &mut Renderer) {
        let d = crate::frame::Settings::for_profile(self.profile);
        let s = &mut r.settings;
        s.msaa = match self.msaa {
            Some(v) => if v { Msaa::X4 } else { Msaa::None },
            None => d.msaa,
        };
        s.bloom = self.bloom.unwrap_or(d.bloom);
        s.haze = self.haze.unwrap_or(d.haze);
        s.reflection = self.reflection.unwrap_or(d.reflection);
        s.rain = self.rain.unwrap_or(d.rain);
        s.exposure = self.exposure_ev.exp2();
        s.scale = self.scale.map_or(SCALES.len() as u32, |k| k as u32);
        match self.step {
            Some(k) => {
                r.governor.step = k.min(r.profile.steps.len() - 1);
                r.governor.hold = true;
            }
            None => r.governor.hold = false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Row {
    Profile,
    Quality,
    Resolution,
    Msaa,
    Bloom,
    Haze,
    Reflection,
    Rain,
    Exposure,
    Shot,
    Hud,
    Reset,
    Leave,
}

pub enum Outcome {
    None,
    Leave,
}

pub struct Sheet {
    pub open: bool,
    row: usize,
    /// Slide-in (0..1) and the focus bar's animated row.
    anim: f32,
    bar: f32,
    note: Option<(String, f32)>,
}

const ROW_H: f32 = 30.0;
const SW: f32 = 352.0;

fn on_off(v: bool) -> String {
    if v { "On".into() } else { "Off".into() }
}

fn profile_label(p: &Profile) -> &'static str {
    match p.name {
        "vita30" => "30 fps",
        "vita60" => "60 fps",
        "cinematic" => "Cinematic · 20 fps",
        _ => "Custom",
    }
}

impl Sheet {
    pub fn new() -> Self {
        Self { open: false, row: 0, anim: 0.0, bar: 0.0, note: None }
    }

    fn rows(r: &Renderer) -> Vec<Row> {
        let mut v = vec![Row::Profile, Row::Quality, Row::Resolution, Row::Msaa, Row::Bloom];
        if r.has_haze() {
            v.push(Row::Haze);
        }
        if r.has_reflection() {
            v.push(Row::Reflection);
        }
        if r.has_rain() {
            v.push(Row::Rain);
        }
        v.extend([Row::Exposure, Row::Shot, Row::Hud, Row::Reset, Row::Leave]);
        v
    }

    fn label(row: Row) -> &'static str {
        match row {
            Row::Profile => "Frame rate",
            Row::Quality => "Quality",
            Row::Resolution => "Resolution",
            Row::Msaa => "Anti-aliasing",
            Row::Bloom => "Bloom",
            Row::Haze => "Lit haze",
            Row::Reflection => "Reflections",
            Row::Rain => "Rain",
            Row::Exposure => "Exposure",
            Row::Shot => "Camera",
            Row::Hud => "Performance overlay",
            Row::Reset => "Reset to the profile",
            Row::Leave => "Back to the atlas",
        }
    }

    fn value(row: Row, p: &Prefs, r: &Renderer, rig: &Rig) -> String {
        let n = r.profile.steps.len();
        match row {
            Row::Profile => profile_label(p.profile).into(),
            Row::Quality => match p.step {
                Some(k) => format!("Step {} of {n}", k + 1),
                None => format!("Auto · step {} of {n}", r.governor.step + 1),
            },
            Row::Resolution => {
                let (w, h) = SCALES[r.level()];
                if p.scale.is_some() { format!("{w}×{h}") } else { format!("Auto · {w}×{h}") }
            }
            Row::Msaa => if r.settings.msaa == Msaa::X4 { "4× MSAA".into() } else { "Off".into() },
            Row::Bloom => on_off(r.settings.bloom),
            Row::Haze => on_off(r.settings.haze),
            Row::Reflection => on_off(r.settings.reflection),
            Row::Rain => on_off(r.settings.rain),
            Row::Exposure => format!("{:+.2} EV", p.exposure_ev),
            Row::Shot => match rig.mode {
                Mode::Free => "Free camera".into(),
                Mode::Cinematic => format!("{} · {} of {}", rig.shot_name(), rig.shot_index() + 1, rig.shot_count()),
            },
            Row::Hud => on_off(p.hud),
            Row::Reset | Row::Leave => String::new(),
        }
    }

    /// Input while the sheet is open. `pressed`: buttons down this frame.
    ///
    /// # Safety
    /// Render thread, outside any scene (a resolution change makes targets).
    pub unsafe fn update(&mut self, dt: f32, pressed: u32, p: &mut Prefs, r: &mut Renderer, rig: &mut Rig) -> Outcome {
        use vitasdk_sys::*;
        self.anim = (self.anim + dt * if self.open { 7.0 } else { -9.0 }).clamp(0.0, 1.0);
        if let Some((_, t)) = &mut self.note {
            *t -= dt;
        }
        if self.note.as_ref().is_some_and(|n| n.1 <= 0.0) {
            self.note = None;
        }
        if pressed & SCE_CTRL_SELECT != 0 {
            self.open = !self.open;
            return Outcome::None;
        }
        if !self.open {
            return Outcome::None;
        }
        let rows = Self::rows(r);
        self.row = self.row.min(rows.len() - 1);
        self.bar += (self.row as f32 - self.bar) * (1.0 - (-dt * 18.0).exp());
        if pressed & SCE_CTRL_CIRCLE != 0 {
            self.open = false;
            return Outcome::None;
        }
        if pressed & SCE_CTRL_DOWN != 0 {
            self.row = (self.row + 1) % rows.len();
        }
        if pressed & SCE_CTRL_UP != 0 {
            self.row = (self.row + rows.len() - 1) % rows.len();
        }
        let dir: i32 = if pressed & (SCE_CTRL_RIGHT | SCE_CTRL_CROSS) != 0 {
            1
        } else if pressed & SCE_CTRL_LEFT != 0 {
            -1
        } else {
            return Outcome::None;
        };
        let cross = pressed & SCE_CTRL_CROSS != 0;
        let cycle = |k: usize, n: usize| ((k as i32 + dir).rem_euclid(n as i32)) as usize;
        let row = rows[self.row];
        match row {
            Row::Profile => {
                let all = profile::ALL;
                let k = all.iter().position(|q| q.name == p.profile.name).unwrap_or(0);
                p.profile = all[cycle(k, all.len())];
                // Steps differ between profiles.
                p.step = None;
                p.apply(r);
            }
            Row::Quality => {
                // Auto, then each step best first.
                let n = r.profile.steps.len();
                let k = p.step.map_or(0, |s| s + 1);
                let k = cycle(k, n + 1);
                p.step = if k == 0 { None } else { Some(k - 1) };
                p.overrides(r);
            }
            Row::Resolution => {
                let n = SCALES.len();
                let before = p.scale;
                let k = p.scale.map_or(0, |s| s + 1);
                let k = cycle(k, n + 1);
                p.scale = if k == 0 { None } else { Some(k - 1) };
                if let Some(level) = p.scale {
                    if let Err(e) = r.prepare_level(level) {
                        let (w, h) = SCALES[level];
                        pocketjs_vita::vita_log(format_args!("atlas: {w}×{h}: {e}"));
                        self.note = Some((format!("{w}×{h} does not fit in video memory here"), 2.5));
                        p.scale = before;
                    }
                }
                p.overrides(r);
            }
            Row::Msaa => {
                p.msaa = Some(r.settings.msaa != Msaa::X4);
                p.overrides(r);
            }
            Row::Bloom => {
                p.bloom = Some(!r.settings.bloom);
                p.overrides(r);
            }
            Row::Haze => {
                p.haze = Some(!r.settings.haze);
                p.overrides(r);
            }
            Row::Reflection => {
                p.reflection = Some(!r.settings.reflection);
                p.overrides(r);
            }
            Row::Rain => {
                p.rain = Some(!r.settings.rain);
                p.overrides(r);
            }
            Row::Exposure => {
                if !cross {
                    p.exposure_ev = (p.exposure_ev + dir as f32 * 0.25).clamp(-2.0, 2.0);
                    r.settings.exposure = p.exposure_ev.exp2();
                }
            }
            Row::Shot => {
                let n = rig.shot_count().max(1);
                let k = if rig.mode == Mode::Free { if dir > 0 { 0 } else { n - 1 } } else { cycle(rig.shot_index(), n) };
                rig.set_shot(k);
            }
            Row::Hud => p.hud = !p.hud,
            Row::Reset => {
                if cross {
                    let hud = p.hud;
                    *p = Prefs { profile: p.profile, step: None, scale: None, msaa: None, bloom: None, haze: None, reflection: None, rain: None, exposure_ev: 0.0, hud };
                    p.apply(r);
                    self.note = Some((format!("Settings follow {}", profile_label(p.profile)), 2.0));
                }
            }
            Row::Leave => {
                if cross {
                    self.open = false;
                    p.save();
                    return Outcome::Leave;
                }
            }
        }
        p.save();
        Outcome::None
    }

    /// # Safety
    /// Inside the vita2d display scene.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn draw(&self, ui: &Ui, gpu: &mut Gpu, p: &Prefs, r: &Renderer, rig: &Rig, title: &str, accent_c: [f32; 3], stats: &str) {
        if self.anim <= 0.0 {
            return;
        }
        let e = 1.0 - (1.0 - self.anim).powi(3);
        let o = self.anim;
        let rows = Self::rows(r);
        let h = 74.0 + rows.len() as f32 * ROW_H + 64.0;
        let x = 960.0 - 16.0 - SW + (1.0 - e) * (SW + 24.0);
        let y = ((544.0 - h) * 0.5).max(8.0);
        let white = |a: f32| rgb(0xffffff, a * o);
        let grey = |a: f32| rgb(0xb4b8c4, a * o);
        let acc = |a: f32| accent(accent_c, a * o);

        ui.shadow(gpu, x, y, SW, h, 16.0, 24.0, 0.5 * o);
        ui.rect(gpu, x, y, SW, h, &Style::gradient(16.0, rgb(0x161a24, 0.88 * o), rgb(0x0c0e14, 0.92 * o)).stroke(1.0, white(0.1)));
        ui.text(x + 20.0, y + 30.0, grey(0.8), 0.52, "S E T T I N G S");
        ui.text(x + 20.0, y + 56.0, white(1.0), 0.8, &ui.fit(0.8, title, SW - 40.0));

        let ry = y + 74.0;
        ui.rect(gpu, x + 10.0, ry + self.bar * ROW_H, SW - 20.0, ROW_H - 2.0, &Style::fill(8.0, acc(0.22)).stroke(1.0, acc(0.6)));
        for (k, row) in rows.iter().enumerate() {
            let cy = ry + k as f32 * ROW_H + ROW_H * 0.5;
            let focused = k == self.row;
            let action = matches!(row, Row::Reset | Row::Leave);
            if action && k > 0 && !matches!(rows[k - 1], Row::Reset | Row::Leave) {
                ui.rect(gpu, x + 20.0, cy - ROW_H * 0.5 - 1.0, SW - 40.0, 1.0, &Style::fill(0.0, white(0.08)));
            }
            ui.text(x + 22.0, cy + 6.0, if focused { white(1.0) } else { white(0.82) }, 0.66, Self::label(*row));
            let v = Self::value(*row, p, r, rig);
            if !v.is_empty() {
                let vx = x + SW - 22.0;
                if focused {
                    ui.text_right(vx, cy + 6.0, acc(1.0), 0.62, "›");
                    let vw = ui.width(0.62, &v);
                    ui.text_right(vx - 14.0, cy + 6.0, white(1.0), 0.62, &v);
                    ui.text_right(vx - 22.0 - vw, cy + 6.0, acc(1.0), 0.62, "‹");
                } else {
                    ui.text_right(vx, cy + 6.0, grey(0.85), 0.62, &v);
                }
            } else if focused {
                ui.button(gpu, x + SW - 32.0, cy, Button::Cross, o);
            }
        }

        let fy = ry + rows.len() as f32 * ROW_H + 12.0;
        ui.rect(gpu, x + 20.0, fy - 4.0, SW - 40.0, 1.0, &Style::fill(0.0, white(0.08)));
        let line = match &self.note {
            Some((n, _)) => n.clone(),
            None => stats.to_string(),
        };
        ui.text(x + 22.0, fy + 16.0, if self.note.is_some() { acc(1.0) } else { grey(0.8) }, 0.54, &ui.fit(0.54, &line, SW - 44.0));
        let hy = fy + 38.0;
        let mut hx = x + 20.0;
        hx += ui.hint(gpu, hx, hy, &[Button::Pad], "Choose", o) + 14.0;
        hx += ui.hint(gpu, hx, hy, &[Button::Cross], "Change", o) + 14.0;
        ui.hint(gpu, hx, hy, &[Button::Circle], "Close", o);
    }
}
