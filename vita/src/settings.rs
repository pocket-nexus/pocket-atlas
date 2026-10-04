//! What the visitor can set in a place, as the interface's menu lists it:
//! frame rate profile, quality step, resolution, anti-aliasing, the effects
//! the place has, exposure and the statistics line. Choices carry to the next
//! place and are kept in `settings.json` in the data folder; what is not
//! chosen follows the profile. The renderer's profile is the one in force
//! (control messages switch it for measurements); the list shows and steps
//! from it.

use pocket_atlas_interface::Setting;
use pocket_vita_gxm::target::Msaa;
use serde_json::json;

use crate::frame::{Renderer, SCALES};
use crate::profile::{self, Profile};

const FILE: &str = "settings.json";

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
        let v = crate::paths::read_json(FILE).unwrap_or_default();
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
        crate::paths::write_json(FILE, &v);
    }

    /// Sets the renderer to the profile, then the choices over it.
    pub fn apply(&self, r: &mut Renderer) {
        r.set_profile(self.profile);
        self.overrides(r);
    }

    /// The choices over the renderer's current profile (the governor keeps
    /// its step unless one is chosen).
    pub fn overrides(&self, r: &mut Renderer) {
        let d = crate::frame::Settings::for_profile(r.profile);
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
                r.governor.boost = 0;
                r.governor.hold = true;
            }
            None => r.governor.hold = false,
        }
    }
}

/// Exposure steps, in stops.
const EXPOSURE: [f32; 5] = [-1.0, -0.5, 0.0, 0.5, 1.0];

fn profile_label(p: &Profile) -> &'static str {
    match p.name {
        "vita30" => "30 fps",
        "vita60" => "60 fps",
        "cinematic" => "Cinematic · 20 fps",
        _ => "Custom",
    }
}

/// The settings as the interface's menu shows them.
pub fn list(p: &Prefs, r: &Renderer) -> Vec<Setting> {
    let steps = r.profile.steps.len();
    let (w, h) = SCALES[r.level()];
    let mut quality = vec![format!("Auto · {} of {steps}", r.governor.step + 1)];
    quality.extend((1..=steps).map(|k| format!("{k} of {steps}")));
    let mut resolution = vec![format!("Auto · {w}×{h}")];
    resolution.extend(SCALES.iter().map(|(w, h)| format!("{w}×{h}")));
    let choice = |key, value: usize, names: &[String]| Setting { key, value: value as u32, choices: names.to_vec() };
    let mut v = vec![
        Setting::choice("rate", profile::ALL.iter().position(|q| q.name == r.profile.name).unwrap_or(0), &profile::ALL.map(profile_label)),
        choice("quality", p.step.map_or(0, |s| s + 1), &quality),
        choice("resolution", p.scale.map_or(0, |s| s + 1), &resolution),
        Setting::switch("smoothing", r.settings.msaa == Msaa::X4),
        Setting::switch("bloom", r.settings.bloom),
    ];
    if r.has_haze() {
        v.push(Setting::switch("haze", r.settings.haze));
    }
    if r.has_reflection() {
        v.push(Setting::switch("reflection", r.settings.reflection));
    }
    if r.has_rain() {
        v.push(Setting::switch("rain", r.settings.rain));
    }
    let stop = EXPOSURE.iter().position(|e| (e - p.exposure_ev).abs() < 0.13).unwrap_or(2);
    v.push(Setting::choice("exposure", stop, &["−1 EV", "−½ EV", "0 EV", "+½ EV", "+1 EV"]));
    v.push(Setting::switch("stats", p.hud));
    v
}

/// The visitor set `key` to `value` (a switch's 0 or 1, or a choice).
///
/// # Safety
/// Render thread, outside any scene (a resolution change makes targets).
pub unsafe fn set(p: &mut Prefs, r: &mut Renderer, key: &str, value: usize) {
    let on = value != 0;
    match key {
        "rate" => {
            p.profile = profile::ALL[value.min(profile::ALL.len() - 1)];
            // Steps differ between profiles.
            p.step = None;
            p.apply(r);
        }
        "quality" => p.step = value.checked_sub(1).map(|k| k.min(r.profile.steps.len() - 1)),
        "resolution" => {
            let before = p.scale;
            p.scale = value.checked_sub(1).map(|k| k.min(SCALES.len() - 1));
            if let Some(level) = p.scale {
                if let Err(e) = r.prepare_level(level) {
                    let (w, h) = SCALES[level];
                    pocketjs_vita::vita_log(format_args!("atlas: {w}×{h}: {e}"));
                    p.scale = before;
                }
            }
        }
        "smoothing" => p.msaa = Some(on),
        "bloom" => p.bloom = Some(on),
        "haze" => p.haze = Some(on),
        "reflection" => p.reflection = Some(on),
        "rain" => p.rain = Some(on),
        "exposure" => p.exposure_ev = EXPOSURE[value.min(EXPOSURE.len() - 1)],
        "stats" => p.hud = on,
        _ => return,
    }
    p.overrides(r);
    p.save();
}
