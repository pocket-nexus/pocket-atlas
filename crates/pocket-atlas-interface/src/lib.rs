//! The renderer's side of `ui/app/protocol.ts`, for the renderers written in
//! Rust (the Vita and the PSP; `n3ds/src/interface.c` is the same thing for
//! the ones in C). The interface is a PocketJS guest drawn over the scene.
//! The renderer keeps a [`State`] and the guest is sent it, as one JSON line,
//! whenever it changed; what the guest asks for comes back as [`Command`]s.
//! The lines travel over the guest's service channel, PocketJS's
//! `pocket.overlay`, answered in the process (`guest`) instead of on a wire.
#![no_std]
extern crate alloc;

use alloc::collections::VecDeque;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write;

#[cfg(feature = "guest")]
pub mod guest;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Scene {
    #[default]
    Atlas,
    Loading,
    Place,
    Error,
}

/// Something the visitor can set in a place: a switch (0 or 1), or with
/// `choices` one of several named values.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Setting {
    pub key: &'static str,
    pub value: u32,
    pub choices: Vec<String>,
}

impl Setting {
    pub fn switch(key: &'static str, on: bool) -> Self {
        Self { key, value: on as u32, choices: Vec::new() }
    }

    pub fn choice(key: &'static str, value: usize, choices: &[&str]) -> Self {
        Self { key, value: value as u32, choices: choices.iter().map(|c| String::from(*c)).collect() }
    }
}

/// What the interface is shown of the renderer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub scene: Scene,
    /// The place being loaded or visited.
    pub place: String,
    /// Why `scene` is `Error`.
    pub message: String,
    /// Ids of the places whose pack is on the device.
    pub installed: Vec<String>,
    /// The visited place's authored shots, and the one the camera is on.
    pub shots: Vec<String>,
    pub shot: u32,
    /// The camera follows the authored tour.
    pub tour: bool,
    pub paused: bool,
    pub options: Vec<Setting>,
    /// One line of statistics while the `stats` setting is on.
    pub stats: String,
    /// Where the globe faces, degrees, when a spin has settled.
    pub lat: f32,
    pub lon: f32,
    /// What the interface last asked to have stored.
    pub prefs: String,
}

fn escape(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c < ' ' => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn list(out: &mut String, items: &[String]) {
    out.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        escape(out, item);
    }
    out.push(']');
}

impl State {
    /// The line the guest receives: every field, or with `since` (what it
    /// was last sent) only those that changed. The guest keeps the rest, so
    /// a statistics line twice a second is a few dozen bytes to parse.
    pub fn line(&self, since: Option<&State>) -> String {
        let mut s = String::with_capacity(512);
        s.push_str("{\"type\":\"state\",\"value\":{");
        let empty = s.len();
        macro_rules! field {
            ($name:ident, $write:expr) => {
                if since.map_or(true, |sent| sent.$name != self.$name) {
                    s.push_str(concat!("\"", stringify!($name), "\":"));
                    $write;
                    s.push(',');
                }
            };
        }
        field!(scene, {
            s.push_str(match self.scene {
                Scene::Atlas => "\"atlas\"",
                Scene::Loading => "\"loading\"",
                Scene::Place => "\"place\"",
                Scene::Error => "\"error\"",
            })
        });
        field!(place, escape(&mut s, &self.place));
        field!(message, escape(&mut s, &self.message));
        field!(installed, list(&mut s, &self.installed));
        field!(shots, list(&mut s, &self.shots));
        field!(shot, { let _ = write!(s, "{}", self.shot); });
        field!(tour, { let _ = write!(s, "{}", self.tour); });
        field!(paused, { let _ = write!(s, "{}", self.paused); });
        field!(options, {
            s.push('[');
            for (i, o) in self.options.iter().enumerate() {
                let _ = write!(s, "{}{{\"key\":\"{}\",\"value\":{}", if i > 0 { "," } else { "" }, o.key, o.value);
                if !o.choices.is_empty() {
                    s.push_str(",\"choices\":");
                    list(&mut s, &o.choices);
                }
                s.push('}');
            }
            s.push(']');
        });
        field!(stats, escape(&mut s, &self.stats));
        field!(lat, { let _ = write!(s, "{:.3}", self.lat); });
        field!(lon, { let _ = write!(s, "{:.3}", self.lon); });
        field!(prefs, escape(&mut s, &self.prefs));
        if s.len() > empty {
            s.pop();
        }
        s.push_str("}}\n");
        s
    }
}

/// What the interface asks of the renderer.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// Where the globe sits on the primary screen (logical pixels), where it
    /// turns to face (degrees) and which pin is lit.
    Globe { x: f32, y: f32, r: f32, lat: f32, lon: f32, pin: Option<usize> },
    /// Every place on the globe: latitude, longitude, colour (0xrrggbb).
    Pins(Vec<(f32, f32, u32)>),
    /// A finger dragging the globe, logical pixels.
    Spin { dx: f32, dy: f32 },
    Enter(String),
    Leave,
    Shot(usize),
    Tour(bool),
    Pause(bool),
    Option { key: String, value: u32 },
    /// Virtual sticks, -1…1: move to the right and forward, look to the right and up.
    Drive { mx: f32, my: f32, lx: f32, ly: f32 },
    /// A finger turning the view, logical pixels.
    Look { dx: f32, dy: f32 },
    /// The interface has the pad: the d-pad and sticks are not the camera's.
    Hold(bool),
    /// To store, and to hand back in [`State::prefs`].
    Prefs(String),
    /// The interface shows nothing just now.
    Quiet(bool),
}

/// The value after `"key":` in a flat JSON object. Quoted text is skipped
/// when looking for the key, so a value cannot pose as one.
fn field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let bytes = json.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        let begin = i + 1;
        let mut end = begin;
        while end < bytes.len() && bytes[end] != b'"' {
            end += if bytes[end] == b'\\' { 2 } else { 1 };
        }
        if end >= bytes.len() {
            return None;
        }
        let rest = json[end + 1..].trim_start();
        if rest.starts_with(':') && &json[begin..end] == key {
            return Some(rest[1..].trim_start());
        }
        i = end + 1;
    }
    None
}

fn number(json: &str, key: &str) -> f32 {
    let Some(value) = field(json, key) else { return 0.0 };
    let end = value.find(|c: char| !(c.is_ascii_digit() || matches!(c, '-' | '+' | '.' | 'e' | 'E'))).unwrap_or(value.len());
    value[..end].parse().unwrap_or(0.0)
}

fn text(json: &str, key: &str) -> Option<String> {
    let value = field(json, key)?.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = value.chars();
    loop {
        match chars.next()? {
            '"' => return Some(out),
            '\\' => out.push(chars.next()?),
            c => out.push(c),
        }
    }
}

fn flag(json: &str, key: &str) -> bool {
    field(json, key).is_some_and(|v| v.starts_with("true"))
}

impl Command {
    pub fn parse(line: &str) -> Option<Command> {
        let n = |key| number(line, key);
        Some(match text(line, "type")?.as_str() {
            "globe" => {
                let pin = n("pin");
                Command::Globe { x: n("x"), y: n("y"), r: n("r"), lat: n("lat"), lon: n("lon"), pin: (pin >= 0.0).then_some(pin as usize) }
            }
            "pins" => Command::Pins(
                text(line, "list")?
                    .split(';')
                    .filter_map(|pin| {
                        let mut parts = pin.split(',');
                        Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, u32::from_str_radix(parts.next()?, 16).ok()?))
                    })
                    .collect(),
            ),
            "spin" => Command::Spin { dx: n("dx"), dy: n("dy") },
            "enter" => Command::Enter(text(line, "place")?),
            "leave" => Command::Leave,
            "shot" => Command::Shot(n("index").max(0.0) as usize),
            "tour" => Command::Tour(flag(line, "on")),
            "pause" => Command::Pause(flag(line, "on")),
            "option" => Command::Option { key: text(line, "key")?, value: n("value").max(0.0) as u32 },
            "drive" => Command::Drive { mx: n("mx") / 100.0, my: n("my") / 100.0, lx: n("lx") / 100.0, ly: n("ly") / 100.0 },
            "look" => Command::Look { dx: n("dx"), dy: n("dy") },
            "hold" => Command::Hold(flag(line, "on")),
            "prefs" => Command::Prefs(text(line, "value")?),
            "quiet" => Command::Quiet(flag(line, "on")),
            _ => return None,
        })
    }
}

/// The channel's two ends: the state last sent, and what the guest said.
#[derive(Default)]
pub struct Interface {
    pub state: State,
    sent: Option<State>,
    open: bool,
    inbox: VecDeque<String>,
}

impl Interface {
    /// The guest opened its service: only the overlay is here.
    pub fn open(&mut self, service: &str) -> bool {
        self.open = service == "pocket.overlay";
        self.sent = None; // a fresh guest gets the state again
        self.open
    }

    /// The state line, when the guest has not seen this state: all of it
    /// the first time, then what changed.
    pub fn poll(&mut self) -> Option<String> {
        if !self.pending() {
            return None;
        }
        let line = self.state.line(self.sent.as_ref());
        self.sent = Some(self.state.clone());
        Some(line)
    }

    /// The guest has not been sent the state as it stands.
    pub fn pending(&self) -> bool {
        self.open && self.sent.as_ref() != Some(&self.state)
    }

    /// A line from the guest.
    pub fn receive(&mut self, line: &str) {
        if self.inbox.len() < 32 {
            self.inbox.push_back(String::from(line));
        }
    }

    /// The next command the guest sent, oldest first.
    pub fn next(&mut self) -> Option<Command> {
        while let Some(line) = self.inbox.pop_front() {
            if let Some(command) = Command::parse(&line) {
                return Some(command);
            }
        }
        None
    }
}

/// Which of its turns the guest takes. A renderer need not give the
/// interface every one (`ui/app/protocol.ts`): the guest rests when no button
/// or touch has been down for [`Rest::STILL`] turns and neither the state it
/// is shown nor what it draws changed in the last one, and is then looked in
/// on every [`Rest::LOOK_IN`] turns (about once a second). Its timers follow
/// the wall, not its turns (`ui/app/clock.ts`).
#[derive(Default)]
pub struct Rest {
    still: u32,
    skipped: u32,
    drawn: u32,
    /// Something has happened since the guest was last tidied up after.
    stirred: bool,
}

impl Rest {
    pub const STILL: u32 = 20;
    pub const LOOK_IN: u32 = 30;

    /// Whether the guest takes the turn now due. `input`: a button or a
    /// touch is down; `pending`: the state has changed since it last looked.
    pub fn due(&mut self, input: bool, pending: bool) -> bool {
        if input {
            self.still = 0;
        } else if pending {
            self.still = self.still.min(Self::STILL - 1);
        }
        self.stirred |= input || pending;
        if self.still >= Self::STILL {
            self.skipped += 1;
            if self.skipped < Self::LOOK_IN {
                return false;
            }
        }
        self.skipped = 0;
        true
    }

    /// True on the first turn the guest sits out after something happened
    /// (an input, new state, a new picture): the moment to tidy up after it
    /// (a garbage collection), while nothing on the screen moves. A look-in
    /// that found nothing to do leaves nothing to tidy.
    pub fn settled(&mut self) -> bool {
        let settled = self.stirred && self.still >= Self::STILL && self.skipped == 1;
        self.stirred &= !settled;
        settled
    }

    /// After a turn, the draw list it left. True when the picture differs
    /// from the turn before: something moves, and the next turn is taken.
    pub fn drew(&mut self, words: &[u32]) -> bool {
        let digest = words.iter().fold(0x811c_9dc5 ^ words.len() as u32, |hash, word| (hash ^ word).wrapping_mul(0x0100_0193));
        self.still = (self.still + 1).min(Self::STILL);
        let moved = digest != self.drawn;
        if moved {
            self.drawn = digest;
            self.still = self.still.min(Self::STILL - 1);
            self.stirred = true;
        }
        moved
    }
}

/// A switch's row in a settings list, by key.
pub fn setting<'a>(options: &'a [Setting], key: &str) -> Option<&'a Setting> {
    options.iter().find(|o| o.key == key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn commands_from_the_interface() {
        // Lines as ui/test/harness.ts logs them.
        let parse = |line| Command::parse(line).unwrap();
        assert_eq!(
            parse(r#"{"type":"globe","x":129,"y":128,"r":100,"lat":35.68502,"lon":139.7233,"pin":1}"#),
            Command::Globe { x: 129.0, y: 128.0, r: 100.0, lat: 35.68502, lon: 139.7233, pin: Some(1) }
        );
        assert_eq!(parse(r#"{"type":"globe","x":1,"y":2,"r":3,"lat":0,"lon":-118.3,"pin":-1}"#), Command::Globe { x: 1.0, y: 2.0, r: 3.0, lat: 0.0, lon: -118.3, pin: None });
        assert_eq!(parse(r#"{"type":"pins","list":"35.710,139.811,4fe3c1;34.118,-118.300,7f8cff"}"#), Command::Pins(vec![(35.71, 139.811, 0x4fe3c1), (34.118, -118.3, 0x7f8cff)]));
        assert_eq!(parse(r#"{"type":"enter","place":"tokyo-konbini"}"#), Command::Enter("tokyo-konbini".into()));
        assert_eq!(parse(r#"{"type":"shot","index":4}"#), Command::Shot(4));
        assert_eq!(parse(r#"{"type":"tour","on":true}"#), Command::Tour(true));
        assert_eq!(parse(r#"{"type":"option","key":"rain","value":0}"#), Command::Option { key: "rain".into(), value: 0 });
        assert_eq!(parse(r#"{"type":"drive","mx":0,"my":72,"lx":-100,"ly":0}"#), Command::Drive { mx: 0.0, my: 0.72, lx: -1.0, ly: 0.0 });
        assert_eq!(parse(r#"{"type":"prefs","value":"{\"saved\":[\"akihabara-radio-kaikan\"]}"}"#), Command::Prefs(r#"{"saved":["akihabara-radio-kaikan"]}"#.into()));
        assert_eq!(parse(r#"{"type":"quiet","on":false}"#), Command::Quiet(false));
        assert_eq!(Command::parse(r#"{"type":"pocket.overlay.control","name":"x","node":3}"#), None);
        // A value that looks like a key is not one.
        assert_eq!(parse(r#"{"type":"enter","place":"\"type\":\"leave\""}"#), Command::Enter(r#""type":"leave""#.into()));
    }

    #[test]
    fn state_goes_out_once_per_change() {
        let mut interface = Interface::default();
        assert_eq!(interface.poll(), None);
        assert!(!interface.open("youtube"));
        assert!(interface.open("pocket.overlay"));
        interface.state.installed = vec!["tokyo-konbini".into()];
        interface.state.prefs = r#"{"saved":[]}"#.into();
        let line = interface.poll().unwrap();
        assert_eq!(
            line,
            "{\"type\":\"state\",\"value\":{\"scene\":\"atlas\",\"place\":\"\",\"message\":\"\",\"installed\":[\"tokyo-konbini\"],\"shots\":[],\"shot\":0,\"tour\":false,\"paused\":false,\"options\":[],\"stats\":\"\",\"lat\":0.000,\"lon\":0.000,\"prefs\":\"{\\\"saved\\\":[]}\"}}\n"
        );
        assert_eq!(interface.poll(), None);
        interface.state.scene = Scene::Place;
        interface.state.options = vec![Setting::switch("rain", true), Setting::choice("rate", 1, &["30 fps", "60 fps"])];
        // Then only what changed.
        assert_eq!(
            interface.poll().unwrap(),
            "{\"type\":\"state\",\"value\":{\"scene\":\"place\",\"options\":[{\"key\":\"rain\",\"value\":1},{\"key\":\"rate\",\"value\":1,\"choices\":[\"30 fps\",\"60 fps\"]}]}}\n"
        );
        interface.state.stats = "30 fps".into();
        assert_eq!(interface.poll().unwrap(), "{\"type\":\"state\",\"value\":{\"stats\":\"30 fps\"}}\n");
        // A guest that starts over is told everything again.
        assert!(interface.open("pocket.overlay"));
        assert!(interface.poll().unwrap().contains("\"installed\":[\"tokyo-konbini\"]"));
        interface.receive(r#"{"type":"leave"}"#);
        interface.receive("not a command");
        interface.receive(r#"{"type":"pause","on":true}"#);
        assert_eq!(interface.next(), Some(Command::Leave));
        assert_eq!(interface.next(), Some(Command::Pause(true)));
        assert_eq!(interface.next(), None);
        assert!(!interface.pending());
        interface.state.shot = 2;
        assert!(interface.pending());
    }

    #[test]
    fn the_guest_rests_while_nothing_changes() {
        let mut rest = Rest::default();
        let picture = [1u32, 2, 3];
        // Nothing moves after its first picture: STILL turns, then rest.
        for _ in 0..Rest::STILL {
            assert!(rest.due(false, false));
            rest.drew(&picture);
        }
        assert!(!rest.settled());
        assert!(!rest.due(false, false));
        assert!(rest.settled());
        assert!(!rest.due(false, false));
        assert!(!rest.settled());
        let mut rest = Rest::default();
        for _ in 0..Rest::STILL {
            rest.due(false, false);
            rest.drew(&picture);
        }
        // At rest: one turn in LOOK_IN.
        assert!(!rest.due(false, false) && rest.settled());
        // Looked in on once a second, and not tidied up after for that.
        let mut tidied = 0;
        let turns = (1..90)
            .filter(|_| {
                let due = rest.due(false, false);
                tidied += rest.settled() as u32;
                due && !rest.drew(&picture)
            })
            .count();
        assert_eq!((turns, tidied), (90 / Rest::LOOK_IN as usize, 0));
        // A new state is shown at once, and looked at once more.
        assert!(rest.due(false, true));
        assert!(rest.drew(&[1, 2, 4]));
        assert!(rest.due(false, false));
        assert!(!rest.drew(&[1, 2, 4]));
        assert!(!rest.due(false, false));
        // A button keeps every turn until it has been up for STILL turns.
        assert!(rest.due(true, false));
        rest.drew(&[1, 2, 4]);
        for _ in 1..Rest::STILL {
            assert!(rest.due(false, false));
            rest.drew(&[1, 2, 4]);
        }
        assert!(!rest.due(false, false));
    }
}
