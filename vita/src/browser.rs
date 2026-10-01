//! The place browser beside the globe: lists of places as postcards with
//! their baked previews. Four lists switch with L and R: Featured, Explore
//! (nearest the point the globe faces, re-sorted while the stick spins it),
//! Saved (△ on a card; kept in `saved.json` in the data folder) and
//! Search (□ opens the system keyboard; words match name, native name,
//! locality, country, tags, kind and author). The focused card opens into a
//! postcard and the globe turns to it; the others stay one-line rows.

use pocket3d_place::atlas::AtlasPlace;
use serde_json::json;

use crate::atlas::Atlas;
use crate::gpu::Gpu;
use crate::ui::{accent, drawable, rgb, Button, Style, Ui, T};

const SAVED: &str = "saved.json";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tab {
    Featured,
    Explore,
    Saved,
    Search,
}

pub const TABS: [Tab; 4] = [Tab::Featured, Tab::Explore, Tab::Saved, Tab::Search];

impl Tab {
    pub fn label(self) -> &'static str {
        match self {
            Tab::Featured => "FEATURED",
            Tab::Explore => "EXPLORE",
            Tab::Saved => "SAVED",
            Tab::Search => "SEARCH",
        }
    }

    pub fn by_name(s: &str) -> Option<Tab> {
        TABS.into_iter().find(|t| t.label().eq_ignore_ascii_case(s))
    }
}

pub enum Action {
    Enter(String),
}

// Panel geometry (display pixels).
const PX: f32 = 564.0;
const PW: f32 = 380.0;
const PY: f32 = 14.0;
const PH: f32 = 482.0;
const LIST_Y: f32 = PY + 92.0;
const LIST_H: f32 = PH - 92.0 - 8.0;
/// Card image (2:1) and the compact row's thumbnail.
const IMG_W: f32 = PW - 24.0;
const THUMB_W: f32 = 100.0;
const ROW_H: f32 = 64.0;
const CARD_H: f32 = IMG_W * 0.5 + 96.0;
const GAP: f32 = 6.0;
/// Preview cards are cooked at the card's 2:1.
const CROP: [f32; 4] = [0.0, 0.0, 1.0, 1.0];

/// The system keyboard (SceImeDialog) for the search query.
struct Ime {
    param: Box<vitasdk_sys::SceImeDialogParam>,
    title: Vec<u16>,
    initial: Vec<u16>,
    input: Box<[u16; 65]>,
    running: bool,
}

impl Ime {
    fn new() -> Self {
        Self { param: Box::new(unsafe { core::mem::zeroed() }), title: Vec::new(), initial: Vec::new(), input: Box::new([0; 65]), running: false }
    }

    unsafe fn open(&mut self, title: &str, initial: &str) -> bool {
        use vitasdk_sys::*;
        if self.running {
            return true;
        }
        self.title = title.encode_utf16().chain([0]).collect();
        self.initial = initial.encode_utf16().take(64).chain([0]).collect();
        self.input.fill(0);
        let p = &mut *self.param;
        *p = core::mem::zeroed();
        // sceImeDialogParamInit (an inline function in the SDK headers).
        p.sdkVersion = 0x0357_0011;
        p.commonParam.magic = SCE_COMMON_DIALOG_MAGIC_NUMBER.wrapping_add(&p.commonParam as *const _ as u32);
        p.type_ = SCE_IME_TYPE_DEFAULT;
        p.option = 0;
        p.dialogMode = 0;
        p.textBoxMode = SCE_IME_DIALOG_TEXTBOX_MODE_DEFAULT;
        p.title = self.title.as_ptr();
        p.maxTextLength = 64;
        p.initialText = self.initial.as_mut_ptr();
        p.inputTextBuffer = self.input.as_mut_ptr();
        let r = sceImeDialogInit(p);
        self.running = r >= 0;
        if r < 0 {
            pocketjs_vita::vita_log(format_args!("atlas: sceImeDialogInit 0x{:08x}", r as u32));
        }
        self.running
    }

    /// The entered text once the dialog closes (`Some(None)`: cancelled).
    unsafe fn poll(&mut self) -> Option<Option<String>> {
        use vitasdk_sys::*;
        if !self.running || sceImeDialogGetStatus() != SCE_COMMON_DIALOG_STATUS_FINISHED {
            return None;
        }
        let mut result: SceImeDialogResult = core::mem::zeroed();
        sceImeDialogGetResult(&mut result);
        sceImeDialogTerm();
        self.running = false;
        if result.button != SCE_IME_DIALOG_BUTTON_ENTER as i32 {
            return Some(None);
        }
        let n = self.input.iter().position(|&c| c == 0).unwrap_or(self.input.len());
        Some(Some(String::from_utf16_lossy(&self.input[..n])))
    }
}

pub struct Browser {
    pub tab: Tab,
    /// Place indices of the current list, and the focused row.
    pub list: Vec<usize>,
    pub focus: usize,
    focus_id: Option<String>,
    /// Saved place ids, most recent first.
    pub saved: Vec<String>,
    pub query: String,
    /// Animated state: list scroll (px), per-place card opening (0..1),
    /// tab underline (x, width) easing toward the current tab's label (set
    /// where the labels are measured, in `draw`), list fade-in after a change.
    scroll: f32,
    open: Vec<f32>,
    underline: (f32, f32),
    underline_goal: (f32, f32),
    fade: f32,
    toast: Option<(String, f32)>,
    explore_from: (f32, f32),
    ime: Ime,
}

fn unit(lat: f32, lon: f32) -> [f32; 3] {
    let (la, lo) = (lat.to_radians(), lon.to_radians());
    [la.cos() * lo.sin(), la.sin(), la.cos() * lo.cos()]
}

fn kind_label(kind: &str) -> String {
    kind.replace('-', " ").to_uppercase()
}

/// Search score of a place for the query words (`None`: a word matches
/// nothing).
fn score(p: &AtlasPlace, words: &[String]) -> Option<u32> {
    let tags = p.tags.join(" ");
    let kind = p.kind.replace('-', " ");
    let fields: [(&str, u32); 9] = [
        (&p.name, 8),
        (&p.native, 8),
        (&p.locality, 6),
        (&p.locality_native, 6),
        (&p.country, 4),
        (&tags, 4),
        (&kind, 3),
        (&p.author, 2),
        (&p.summary, 1),
    ];
    let mut total = 0;
    for w in words {
        let best = fields.iter().filter(|(f, _)| f.to_lowercase().contains(w.as_str())).map(|(_, k)| *k).max()?;
        total += best;
    }
    if words.first().is_some_and(|w| p.name.to_lowercase().starts_with(w.as_str())) {
        total += 4;
    }
    Some(total)
}

impl Browser {
    pub fn new() -> Self {
        let saved = crate::paths::read_json(SAVED)
            .and_then(|v| v["saved"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()))
            .unwrap_or_default();
        Self {
            tab: Tab::Featured,
            list: Vec::new(),
            focus: 0,
            focus_id: None,
            saved,
            query: String::new(),
            scroll: 0.0,
            open: Vec::new(),
            underline: (0.0, 0.0),
            underline_goal: (0.0, 0.0),
            fade: 0.0,
            toast: None,
            explore_from: (0.0, 0.0),
            ime: Ime::new(),
        }
    }

    /// Rebuilds the list for a freshly loaded atlas, keeping the tab and the
    /// focused place.
    pub fn attach(&mut self, atlas: &mut Atlas) {
        self.open = vec![0.0; atlas.meta.places.len()];
        self.explore_from = (atlas.lat, atlas.lon);
        self.rebuild(atlas);
        if let Some(&i) = self.list.get(self.focus) {
            self.open[i] = 1.0;
        }
        self.scroll = self.scroll_goal();
        self.underline = (0.0, 0.0);
        self.fade = 1.0;
        self.focus_changed(atlas, true);
    }

    /// Opens the system keyboard for a search (□, or a control message).
    pub unsafe fn open_search(&mut self) {
        let q = self.query.clone();
        self.ime.open("Search places", &q);
    }

    pub fn dialog_running(&self) -> bool {
        self.ime.running
    }

    pub fn focused<'a>(&self, atlas: &'a Atlas) -> Option<&'a AtlasPlace> {
        self.list.get(self.focus).map(|&i| &atlas.meta.places[i])
    }

    fn is_saved(&self, id: &str) -> bool {
        self.saved.iter().any(|s| s == id)
    }

    fn write_saved(&self) {
        crate::paths::write_json(SAVED, &json!({ "saved": self.saved }));
    }

    pub fn toggle_saved(&mut self, atlas: &mut Atlas, id: &str) {
        let name = atlas.meta.places.iter().find(|p| p.id == id).map_or(id.to_string(), |p| p.name.clone());
        if let Some(k) = self.saved.iter().position(|s| s == id) {
            self.saved.remove(k);
            self.toast(format!("Removed {name} from Saved"));
        } else {
            self.saved.insert(0, id.to_string());
            self.toast(format!("Saved {name}"));
        }
        self.write_saved();
        if self.tab == Tab::Saved {
            self.rebuild(atlas);
            self.focus = self.focus.min(self.list.len().saturating_sub(1));
            self.focus_changed(atlas, false);
        }
    }

    fn toast(&mut self, msg: String) {
        self.toast = Some((msg, 2.4));
    }

    /// The list for the current tab.
    fn rebuild(&mut self, atlas: &Atlas) {
        let places = &atlas.meta.places;
        let all = 0..places.len();
        let mut list: Vec<usize> = match self.tab {
            Tab::Featured => {
                let mut l: Vec<usize> = all.clone().filter(|&i| places[i].featured).collect();
                if l.is_empty() {
                    l = all.collect();
                }
                l.sort_by_key(|&i| !places[i].enterable);
                l
            }
            Tab::Explore => {
                let c = unit(self.explore_from.0, self.explore_from.1);
                let mut l: Vec<(usize, f32)> = all
                    .map(|i| {
                        let u = unit(places[i].lat, places[i].lon);
                        (i, -(u[0] * c[0] + u[1] * c[1] + u[2] * c[2]))
                    })
                    .collect();
                l.sort_by(|a, b| a.1.total_cmp(&b.1));
                l.into_iter().map(|x| x.0).collect()
            }
            Tab::Saved => self.saved.iter().filter_map(|id| places.iter().position(|p| &p.id == id)).collect(),
            Tab::Search => {
                let words: Vec<String> = self.query.to_lowercase().split_whitespace().map(String::from).collect();
                if words.is_empty() {
                    Vec::new()
                } else {
                    let mut l: Vec<(usize, u32)> = all.filter_map(|i| score(&places[i], &words).map(|s| (i, s))).collect();
                    l.sort_by(|a, b| b.1.cmp(&a.1).then(places[b.0].enterable.cmp(&places[a.0].enterable)));
                    l.into_iter().map(|x| x.0).collect()
                }
            }
        };
        list.dedup();
        self.list = list;
        self.focus = self.focus_id.as_ref().and_then(|id| self.list.iter().position(|&i| &places[i].id == id)).unwrap_or(0);
    }

    fn focus_changed(&mut self, atlas: &mut Atlas, turn: bool) {
        let f = self.list.get(self.focus).copied();
        self.focus_id = f.map(|i| atlas.meta.places[i].id.clone()).or(self.focus_id.take());
        atlas.mark(f, &self.list);
        if turn {
            if let Some(i) = f {
                atlas.turn_to(i);
            }
        }
    }

    pub fn set_tab(&mut self, atlas: &mut Atlas, tab: Tab) {
        if tab == Tab::Explore {
            self.explore_from = (atlas.lat, atlas.lon);
        }
        self.tab = tab;
        self.rebuild(atlas);
        self.fade = 0.0;
        self.focus_changed(atlas, true);
    }

    pub fn search(&mut self, atlas: &mut Atlas, query: &str) {
        self.query = query.trim().to_string();
        self.set_tab(atlas, Tab::Search);
    }

    /// Focuses place `id` (control or deep link), in the current list or
    /// else in Explore.
    pub fn select(&mut self, atlas: &mut Atlas, id: &str) -> bool {
        let Some(i) = atlas.meta.places.iter().position(|p| p.id == id) else { return false };
        self.focus_id = Some(id.to_string());
        if !self.list.contains(&i) {
            self.tab = Tab::Explore;
            self.explore_from = (atlas.meta.places[i].lat, atlas.meta.places[i].lon);
        }
        self.rebuild(atlas);
        self.focus_changed(atlas, true);
        true
    }

    /// Input and animation for one frame. `spun`: the stick turned the globe.
    pub unsafe fn update(&mut self, atlas: &mut Atlas, dt: f32, pressed: u32, spun: bool) -> Option<Action> {
        use vitasdk_sys::*;
        let e = 1.0 - (-dt * 12.0).exp();
        self.underline.0 += (self.underline_goal.0 - self.underline.0) * e;
        self.underline.1 += (self.underline_goal.1 - self.underline.1) * e;
        if let Some((_, t)) = &mut self.toast {
            *t -= dt;
        }
        if self.toast.as_ref().is_some_and(|t| t.1 <= 0.0) {
            self.toast = None;
        }
        // Animation.
        let k = 1.0 - (-dt * 14.0).exp();
        for (i, o) in self.open.iter_mut().enumerate() {
            let goal = if self.list.get(self.focus) == Some(&i) { 1.0 } else { 0.0 };
            *o += (goal - *o) * k;
        }
        self.scroll += (self.scroll_goal() - self.scroll) * (1.0 - (-dt * 12.0).exp());
        self.fade = (self.fade + dt * 6.0).min(1.0);

        if let Some(r) = self.ime.poll() {
            if let Some(q) = r {
                self.search(atlas, &q);
            }
            return None;
        }
        if self.ime.running {
            return None;
        }
        if spun && self.tab == Tab::Explore {
            // The list follows the globe; the globe does not follow the list.
            self.explore_from = (atlas.lat, atlas.lon);
            self.focus_id = None;
            self.rebuild(atlas);
            self.focus_changed(atlas, false);
        }
        let n = self.list.len();
        if n > 0 && pressed & (SCE_CTRL_DOWN | SCE_CTRL_UP) != 0 {
            let down = pressed & SCE_CTRL_DOWN != 0;
            self.focus = if down { (self.focus + 1).min(n - 1) } else { self.focus.saturating_sub(1) };
            self.focus_changed(atlas, true);
        }
        let ti = TABS.iter().position(|&t| t == self.tab).unwrap_or(0);
        if pressed & SCE_CTRL_RTRIGGER != 0 {
            self.set_tab(atlas, TABS[(ti + 1) % TABS.len()]);
        }
        if pressed & SCE_CTRL_LTRIGGER != 0 {
            self.set_tab(atlas, TABS[(ti + TABS.len() - 1) % TABS.len()]);
        }
        if pressed & SCE_CTRL_SQUARE != 0 {
            self.open_search();
        }
        let Some(&i) = self.list.get(self.focus) else { return None };
        if pressed & SCE_CTRL_TRIANGLE != 0 {
            let id = atlas.meta.places[i].id.clone();
            self.toggle_saved(atlas, &id);
        }
        if pressed & (SCE_CTRL_CROSS | SCE_CTRL_CIRCLE) != 0 {
            let p = &atlas.meta.places[i];
            if p.enterable {
                return Some(Action::Enter(p.id.clone()));
            }
            self.toast(format!("{} is coming soon", p.name));
        }
        None
    }

    fn row_h(&self, i: usize) -> f32 {
        let a = self.open.get(i).copied().unwrap_or(0.0);
        ROW_H + (CARD_H - ROW_H) * a + GAP
    }

    /// Keeps the focused card in view with one row above it.
    fn scroll_goal(&self) -> f32 {
        let mut top = 0.0;
        let mut total = 0.0;
        for r in 0..self.list.len() {
            let h = if r == self.focus { CARD_H + GAP } else { ROW_H + GAP };
            if r < self.focus {
                top += h;
            }
            total += h;
        }
        let above = if self.focus > 0 { ROW_H + GAP + 4.0 } else { 0.0 };
        (top - above).clamp(0.0, (total - LIST_H).max(0.0))
    }

    /// Status for the device report.
    pub fn status(&self, atlas: &Atlas) -> serde_json::Value {
        json!({
            "tab": self.tab.label(),
            "list": self.list.iter().map(|&i| atlas.meta.places[i].id.clone()).collect::<Vec<_>>(),
            "focus": self.focused(atlas).map(|p| p.id.clone()),
            "saved": self.saved,
            "query": self.query,
            "ime": self.ime.running,
        })
    }

    /// Image of a place: its preview, or a placeholder in its colours.
    #[allow(clippy::too_many_arguments)]
    unsafe fn picture(&self, ui: &Ui, gpu: &mut Gpu, atlas: &Atlas, p: &AtlasPlace, x: f32, y: f32, w: f32, radius: f32, opacity: f32) {
        let h = w * 0.5;
        match p.preview.and_then(|t| atlas.texture(t)) {
            Some(tex) => ui.image(gpu, tex, x, y, w, h, CROP, &Style::fill(radius, rgb(0xffffff, opacity)).stroke(1.0, rgb(0xffffff, 0.12 * opacity))),
            None => {
                let top = accent(p.accent.map(|c| c * 0.55), opacity);
                let bottom = rgb(0x0c0e14, opacity);
                ui.rect(gpu, x, y, w, h, &Style::gradient(radius, top, bottom).stroke(1.0, rgb(0xffffff, 0.12 * opacity)));
                // The place's own name for the city, faint, as on a postmark.
                let label = if p.locality_native.trim().is_empty() || !drawable(&p.locality_native) { &p.locality } else { &p.locality_native };
                let t = if w > 200.0 { T::Brand } else { T::Strong };
                let tw = ui.width(t, label);
                if tw < w - 8.0 {
                    ui.text(gpu, (x + (w - tw) * 0.5).round(), (y + h * 0.5 + t.px() * 0.35).round(), rgb(0xffffff, 0.34 * opacity), t, label);
                }
            }
        }
    }

    /// The panel, the brand and the hints.
    ///
    /// # Safety
    /// Inside the vita2d display scene.
    pub unsafe fn draw(&mut self, ui: &Ui, gpu: &mut Gpu, atlas: &Atlas) {
        let places = &atlas.meta.places;
        let white = |a: f32| rgb(0xffffff, a);
        let grey = |a: f32| rgb(0xbcc0cc, a);

        // Brand.
        ui.text_shadow(gpu, 36.0, 56.0, white(1.0), T::Brand, "Pocket Atlas");
        let open = places.iter().filter(|p| p.enterable).count();
        ui.text_shadow(gpu, 37.0, 84.0, rgb(0xdde1ea, 0.95), T::Body, &format!("Places people remember  ·  {} places, {open} open", places.len()));

        // Panel.
        ui.shadow(gpu, PX, PY, PW, PH, 16.0, 24.0, 0.45);
        ui.rect(gpu, PX, PY, PW, PH, &Style::gradient(16.0, rgb(0x161a24, 0.82), rgb(0x0c0e14, 0.88)).stroke(1.0, white(0.09)));

        // Tabs, L / R at the ends, an underline sliding to the current one.
        let ty = PY + 34.0;
        ui.button(gpu, PX + 26.0, ty - 5.0, Button::L, 0.95);
        ui.button(gpu, PX + PW - 26.0, ty - 5.0, Button::R, 0.95);
        // Labels spread with equal gaps between them across the span.
        let span = (PX + 50.0, PX + PW - 50.0);
        let widths: Vec<f32> = TABS.iter().map(|t| ui.width(T::Label, t.label())).collect();
        let gap = ((span.1 - span.0) - widths.iter().sum::<f32>()) / (TABS.len() - 1) as f32;
        let focus_accent = self.focused(atlas).map_or(rgb(0x8fb4ff, 1.0), |p| accent(p.accent, 1.0));
        let mut lx = span.0;
        for (k, t) in TABS.iter().enumerate() {
            let label = t.label();
            let tw = widths[k];
            let cx = lx + tw * 0.5;
            lx += tw + gap;
            let on = *t == self.tab;
            ui.text(gpu, (cx - tw * 0.5).round(), ty, if on { white(1.0) } else { grey(0.62) }, T::Label, label);
            if on {
                self.underline_goal = (cx - tw * 0.5, tw);
                if self.underline.1 == 0.0 {
                    self.underline = self.underline_goal;
                }
            }
        }
        ui.rect(gpu, self.underline.0, ty + 8.0, self.underline.1, 3.0, &Style::fill(1.5, focus_accent));
        ui.rect(gpu, PX + 16.0, ty + 22.0, PW - 32.0, 1.0, &Style::fill(0.0, white(0.07)));

        // What the list is.
        let sub = match self.tab {
            Tab::Featured => format!("Picked for you  ·  {}", self.list.len()),
            Tab::Explore => "Nearest the middle of the globe".to_string(),
            Tab::Saved if self.list.is_empty() => "Nothing saved yet".to_string(),
            Tab::Saved => format!("{} saved", self.list.len()),
            Tab::Search if self.query.is_empty() => "Search by name, city, country or tag".to_string(),
            Tab::Search => format!("“{}”  ·  {} result{}", self.query, self.list.len(), if self.list.len() == 1 { "" } else { "s" }),
        };
        ui.text(gpu, PX + 18.0, PY + 78.0, grey(0.9), T::Caption, &ui.fit(T::Caption, &sub, PW - 36.0));

        // The list.
        let a = self.fade;
        ui.clip(Some((PX + 1.0, LIST_Y - 6.0, PW - 2.0, LIST_H + 6.0)));
        let mut y = LIST_Y - self.scroll;
        for (r, &i) in self.list.iter().enumerate() {
            let h = self.row_h(i);
            if y + h >= LIST_Y - 8.0 && y <= LIST_Y + LIST_H {
                self.item(ui, gpu, atlas, &places[i], i, r == self.focus, PX + 12.0, y, a);
            }
            y += h;
        }
        if self.list.is_empty() {
            let (title, body) = match self.tab {
                Tab::Saved => ("No saved places", "Press △ on a place to keep it here."),
                Tab::Search if self.query.is_empty() => ("Find a place", "Press □ and type a name, a city or a tag."),
                Tab::Search => ("No places found", "Press □ to try other words."),
                _ => ("No places", ""),
            };
            ui.text(gpu, PX + 24.0, LIST_Y + 40.0, white(0.92 * a), T::Title, title);
            ui.text(gpu, PX + 24.0, LIST_Y + 68.0, grey(0.9 * a), T::Caption, body);
        }
        ui.clip(None);
        // Edge fade over the scrolled list.
        if self.scroll > 1.0 {
            ui.rect(gpu, PX + 1.0, LIST_Y - 6.0, PW - 2.0, 18.0, &Style::gradient(0.0, rgb(0x141822, 0.9), rgb(0x141822, 0.0)));
        }

        // Hints along the bottom.
        let hy = 520.0;
        let mut x = 36.0;
        let focused = self.focused(atlas);
        if focused.is_some_and(|p| p.enterable) {
            x += ui.hint(gpu, x, hy, &[Button::Cross], "Visit", 1.0) + 20.0;
        }
        if let Some(p) = focused {
            x += ui.hint(gpu, x, hy, &[Button::Triangle], if self.is_saved(&p.id) { "Unsave" } else { "Save" }, 1.0) + 20.0;
        }
        x += ui.hint(gpu, x, hy, &[Button::Square], "Search", 1.0) + 20.0;
        x += ui.hint(gpu, x, hy, &[Button::L, Button::R], "Lists", 1.0) + 20.0;
        ui.hint(gpu, x, hy, &[Button::Stick], "Spin the globe", 1.0);

        if let Some((msg, t)) = &self.toast {
            let o = (t.min(0.4) / 0.4).clamp(0.0, 1.0);
            let tw = ui.width(T::Strong, msg);
            let (cx, cy) = (atlas.meta.globe.center_x, 458.0);
            ui.rect(gpu, cx - tw * 0.5 - 18.0, cy - 19.0, tw + 36.0, 36.0, &Style::fill(18.0, rgb(0x0c0e14, 0.85 * o)).stroke(1.0, white(0.14 * o)));
            ui.text(gpu, (cx - tw * 0.5).round(), cy + 6.0, white(o), T::Strong, msg);
        }
    }

    /// One place: a row (thumbnail, name, locality) that opens into a
    /// postcard (preview, kind, name, locality, tags, author, status) as it
    /// takes focus.
    #[allow(clippy::too_many_arguments)]
    unsafe fn item(&self, ui: &Ui, gpu: &mut Gpu, atlas: &Atlas, p: &AtlasPlace, i: usize, focused: bool, x: f32, y: f32, fade: f32) {
        let a = self.open.get(i).copied().unwrap_or(0.0);
        let s = a * a * (3.0 - 2.0 * a);
        let white = |o: f32| rgb(0xffffff, o * fade);
        let grey = |o: f32| rgb(0xbcc0cc, o * fade);
        let acc = |o: f32| accent(p.accent, o * fade);
        let saved = self.is_saved(&p.id);
        let w = PW - 24.0;

        // Card behind the opened postcard.
        if s > 0.02 {
            let ch = ROW_H + (CARD_H - ROW_H) * s;
            ui.rect(gpu, x - 4.0, y - 4.0, w + 8.0, ch + 2.0, &Style::fill(14.0, rgb(0x1c212c, 0.92 * s * fade)).stroke(1.5, acc(0.75 * s)));
        }
        // Picture: thumbnail → card image.
        let iw = THUMB_W + (IMG_W - THUMB_W) * s;
        let ix = x + 2.0 * (1.0 - s);
        let iy = y + 7.0 * (1.0 - s);
        self.picture(ui, gpu, atlas, p, ix, iy, iw, 7.0 + 3.0 * s, fade);

        // Row text, fading as the card opens.
        let ro = (1.0 - s * 2.0).max(0.0);
        if ro > 0.0 {
            let tx = x + THUMB_W + 16.0;
            let tw = w - THUMB_W - 16.0 - 46.0;
            ui.text(gpu, tx, y + 28.0, white(0.96 * ro), T::Strong, &ui.fit(T::Strong, &p.name, tw));
            let loc = if p.country.is_empty() { p.locality.clone() } else { format!("{}  ·  {}", p.locality, p.country) };
            ui.text(gpu, tx, y + 50.0, grey(0.9 * ro), T::Caption, &ui.fit(T::Caption, &loc, tw + 40.0));
            if p.enterable {
                ui.text_right(gpu, x + w - 6.0, y + 27.0, acc(ro), T::Label, "OPEN");
            } else {
                ui.text_right(gpu, x + w - 6.0, y + 27.0, grey(0.6 * ro), T::Label, "SOON");
            }
            if saved {
                ui.text_right(gpu, x + w - 6.0, y + 50.0, acc(ro), T::Small, "★");
            }
        }

        // Postcard text, appearing once the picture has nearly opened.
        let co = ((s - 0.7) / 0.3).max(0.0);
        if co > 0.0 {
            let ih = IMG_W * 0.5;
            // Scrim and name over the bottom of the picture (its current size).
            let sh = 72.0 * iw / IMG_W;
            ui.rect(gpu, ix, iy + iw * 0.5 - sh, iw, sh, &Style::gradient(10.0, rgb(0x000000, 0.0), rgb(0x000000, 0.75 * co * fade)));
            let nt = if ui.width(T::Heading, &p.name) <= IMG_W - 28.0 { T::Heading } else { T::Title };
            let name = ui.fit(nt, &p.name, IMG_W - 28.0);
            let nw = ui.text(gpu, x + 14.0, y + ih - 14.0, white(co), nt, &name);
            if !p.native.is_empty() && drawable(&p.native) && nw + ui.width(T::Body, &p.native) + 40.0 < IMG_W {
                ui.text(gpu, x + 24.0 + nw, y + ih - 15.0, white(0.78 * co), T::Body, &p.native);
            }
            // Kind chip and the saved badge.
            if !p.kind.is_empty() {
                let k = kind_label(&p.kind);
                let kw = ui.width(T::Label, &k);
                ui.rect(gpu, x + 10.0, y + 10.0, kw + 18.0, 22.0, &Style::fill(11.0, rgb(0x000000, 0.55 * co * fade)));
                ui.text(gpu, x + 19.0, y + 26.0, white(0.95 * co), T::Label, &k);
            }
            if saved {
                let b = "★ SAVED";
                let bw = ui.width(T::Label, b);
                ui.rect(gpu, x + IMG_W - bw - 28.0, y + 10.0, bw + 18.0, 22.0, &Style::fill(11.0, rgb(0x000000, 0.55 * co * fade)));
                ui.text(gpu, x + IMG_W - bw - 19.0, y + 26.0, acc(co), T::Label, b);
            }
            // Caption.
            let cy = y + ih;
            let loc = if p.locality_native.is_empty() || !drawable(&p.locality_native) {
                format!("{}  ·  {}", p.locality, p.country)
            } else {
                format!("{} {}  ·  {}", p.locality, p.locality_native, p.country)
            };
            let weather = p.weather.to_uppercase();
            let ww = ui.width(T::Label, &weather);
            ui.text(gpu, x + 4.0, cy + 26.0, white(0.94 * co), T::Body, &ui.fit(T::Body, &loc, w - ww - 20.0));
            ui.text_right(gpu, x + w - 4.0, cy + 25.0, grey(0.85 * co), T::Label, &weather);
            // Tags.
            let mut tx = x + 4.0;
            for t in &p.tags {
                let tw = ui.width(T::Caption, t);
                if tx + tw + 18.0 > x + w {
                    break;
                }
                ui.rect(gpu, tx, cy + 37.0, tw + 18.0, 24.0, &Style::fill(12.0, [0.0; 4]).stroke(1.0, white(0.26 * co)));
                ui.text(gpu, tx + 9.0, cy + 54.0, white(0.9 * co), T::Caption, t);
                tx += tw + 24.0;
            }
            // Author and what × does.
            if !p.author.is_empty() {
                ui.text(gpu, x + 4.0, cy + 84.0, grey(0.9 * co), T::Caption, &format!("by {}", p.author));
            }
            if p.enterable {
                let l = "VISIT";
                let lw = ui.text_right(gpu, x + w - 4.0, cy + 83.0, acc(co), T::Label, l);
                if focused {
                    ui.button(gpu, x + w - 20.0 - lw, cy + 78.0, Button::Cross, co * fade);
                }
            } else {
                ui.text_right(gpu, x + w - 4.0, cy + 83.0, grey(0.8 * co), T::Label, "COMING SOON");
            }
        }
    }
}
