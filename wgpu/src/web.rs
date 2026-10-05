//! The tab's side: what the page calls (`page/main.js`).
//!
//! The page plays the Pocket3D title card and opens the shell on a canvas
//! ([`Atlas::open`]); the globe's surface is read beside the frames
//! ([`surface`]) and handed in when it is there ([`Atlas::globe`]). A frame is
//! `step`, the turn of the interface's guest when `guest_due` says one is due
//! (the page runs the guest in a realm of its own; its lines pass through
//! `heard` and `say`, and `turned` ends the turn), then `draw`. When what the
//! guest shows has changed, the page hands its picture to `overlay`.
//! Everything a frame does is in `app`.

use pocket_web_wgpu::gpu::{Gpu, Screen};
use pocket_web_wgpu::source::Source;
use wasm_bindgen::prelude::*;

use crate::app::{packs_of, App, Held, Shape, SHAPES, TURNS};
use crate::place::RENDERER;

fn describe(s: &Shape) -> String {
    format!("{{\"name\":\"{}\",\"width\":{},\"height\":{},\"samples\":{},\"hz\":{},\"logical\":[{},{}]}}", s.name, s.width, s.height, s.samples, s.hz, s.logical[0], s.logical[1])
}

/// The screens the page can ask for, as a JSON array.
#[wasm_bindgen]
pub fn shapes() -> String {
    format!("[{}]", SHAPES.iter().map(describe).collect::<Vec<_>>().join(","))
}

/// Turns a second the interface's guest is given, for the realm that starts it (`simHz`).
#[wasm_bindgen]
pub fn turns() -> u32 {
    TURNS
}

/// The globe's surface once it has been read.
#[wasm_bindgen]
pub struct Surface {
    texels: Vec<u8>,
    requests: u32,
    bytes: u64,
}

#[wasm_bindgen]
impl Surface {
    /// Requests made and bytes received to read it.
    pub fn requests(&self) -> u32 {
        self.requests
    }

    pub fn bytes(&self) -> f64 {
        self.bytes as f64
    }
}

/// Reads the globe's surface at `url` (`tools/atlas-globe.ts`): its file, on a server that answers byte
/// ranges, or the manifest (`.json`) of one cut into pieces (`pocket_web_wgpu::source`).
#[wasm_bindgen]
pub async fn surface(url: String) -> Result<Surface, JsError> {
    let source = Source::open(&url).await.map_err(|e| JsError::new(&e))?;
    let texels = source.all().await.map_err(|e| JsError::new(&e))?;
    let read = source.read_so_far();
    Ok(Surface { texels, requests: read.requests, bytes: read.bytes })
}

#[wasm_bindgen]
pub struct Atlas {
    app: App,
}

#[wasm_bindgen]
impl Atlas {
    /// The shell on `canvas`, which has the shape's size in pixels: the atlas screen, with no globe until
    /// its surface is handed in. `prefs`: what the page kept for the interface from the last visit. One to
    /// a page.
    pub async fn open(canvas: web_sys::HtmlCanvasElement, shape: String, prefs: String) -> Result<Atlas, JsError> {
        std::panic::set_hook(Box::new(|info| web_sys::console::error_1(&info.to_string().into())));
        let shape = Shape::named(&shape).ok_or_else(|| JsError::new("no such shape"))?;
        // (a renderer of places names the texture formats it can read; the device has those the adapter has)
        let wanted = RENDERER.map_or(pocket_web_wgpu::wgpu::Features::empty(), |r| r.wants);
        let (gpu, surface) = Gpu::for_canvas_wanting(canvas, wanted).await.map_err(|e| JsError::new(&e))?;
        let screen = Screen::canvas(&gpu, surface, shape.width, shape.height, shape.samples);
        let mut app = App::open(gpu, screen, shape, RENDERER);
        if !prefs.is_empty() {
            app.prefs_stored(&prefs);
        }
        Ok(Atlas { app })
    }

    /// The globe's surface has been read.
    pub fn globe(&mut self, surface: &Surface) -> Result<(), JsError> {
        self.app.globe_surface(&surface.texels).map_err(|e| JsError::new(&e))
    }

    /// The places whose pack the page has: a JSON object of a place's id to where its pack is. The interface
    /// is told of them only when this build has a renderer of places (`place::RENDERER`).
    pub fn packs(&mut self, json: &str) -> Result<(), JsError> {
        let list = packs_of(json).ok_or_else(|| JsError::new("the packs are not a JSON object of a place's id to its pack's place"))?;
        self.app.packs(list);
        Ok(())
    }

    /// Something of the start failed: the status says what.
    pub fn fail(&mut self, why: &str) {
        self.app.fail(why);
    }

    /// The first half of a frame at `now` (the frame loop's clock, milliseconds): the globe turns, or the
    /// place advances. `buttons`: PocketJS's bits of the buttons held on the page's handheld; the sticks in
    /// -1…1, right and up positive.
    pub fn step(&mut self, now: f64, buttons: u32, lx: f32, ly: f32, rx: f32, ry: f32) {
        self.app.step(now, &Held { buttons, left: [lx, ly], right: [rx, ry] });
    }

    /// The second half: the scene, with the interface's picture over it.
    pub fn draw(&mut self) -> Result<(), JsError> {
        self.app.draw().map_err(|e| {
            self.app.trouble = e.clone();
            JsError::new(&e)
        })
    }

    /// A guest has opened the interface's channel; one that replaces another opens it again.
    pub fn interface_opened(&mut self) {
        self.app.interface_opened();
    }

    /// The sixtieths of a second the guest's turn advances by, when one is due now; 0 when it is not.
    /// `buttons`: PocketJS's bits, as the guest would be handed them; `touching`: a contact is on a surface
    /// it draws, or has just left one.
    pub fn guest_due(&mut self, buttons: u32, touching: bool) -> u32 {
        self.app.guest_due(buttons, touching)
    }

    /// The line of state the guest has not seen, for its turn.
    pub fn heard(&mut self) -> Option<String> {
        self.app.heard()
    }

    /// A line the guest sent.
    pub fn say(&mut self, line: &str) {
        self.app.say(line);
    }

    /// The guest's turn has ended. `moved`: what it draws differs from the turn before.
    pub fn turned(&mut self, moved: bool) {
        self.app.turned(moved);
    }

    /// The interface's picture as PocketJS's UI core rasterizes it with its alpha (`width` by `height` rows
    /// of premultiplied RGBA): it is laid over every frame from the next on.
    pub fn overlay(&mut self, pixels: &[u8], width: u32, height: u32) -> Result<(), JsError> {
        self.app.overlay.write(&self.app.gpu, pixels, width, height).map_err(|e| JsError::new(&e))
    }

    /// Nothing is laid over the frames until a picture is handed in again: the guest is being replaced.
    pub fn overlay_hide(&mut self) {
        self.app.overlay.hide();
    }

    /// What the interface asked to have kept since the last call (its saved places, as JSON text).
    pub fn prefs_take(&mut self) -> Option<String> {
        self.app.prefs_take()
    }

    /// Another device's screen from the next frame on. The canvas has the new size already. `name` is one of
    /// `shapes()`; the sizes are the ones the device's plan gives (`plan.json`), and a number that is zero
    /// leaves that shape's.
    pub fn reshape(&mut self, name: &str, width: u32, height: u32, samples: u32, hz: u32, logical_width: u32, logical_height: u32) -> Result<String, JsError> {
        let shape = Shape::named(name).ok_or_else(|| JsError::new("no such shape"))?;
        let or = |value: u32, fallback: u32| if value != 0 { value } else { fallback };
        self.app.reshape(Shape { name: shape.name, width: or(width, shape.width), height: or(height, shape.height), samples: or(samples, shape.samples), hz: or(hz, shape.hz), logical: [or(logical_width, shape.logical[0]), or(logical_height, shape.logical[1])] });
        Ok(describe(&self.app.shape))
    }

    /// Words a development host sends: `enter=<place>` and `leave`, as the interface would ask.
    pub fn control(&mut self, words: &str) {
        self.app.control(words);
    }

    /// The run as a JSON object.
    pub fn status(&self) -> String {
        self.app.status()
    }
}
