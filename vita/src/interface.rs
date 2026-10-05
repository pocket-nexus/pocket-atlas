//! The interface: one PocketJS guest (`ui/`, shared with the other devices)
//! drawn over the globe and the places through PocketJS's Vita host library.
//! It owns every 2D pixel and what the buttons and the panel mean; this side
//! owns the scene, shows it the renderer's state and does what it asks
//! (`crates/pocket-atlas-interface`).

use pocket_atlas_interface::{guest, Command, Rest, State};
use pocketjs_vita::{graphics, input, Runtime};

/// The guest turns this often, and is told so before it mounts.
const TURN: f32 = 1.0 / 30.0;
const RATE: &[u8] = b"globalThis.__simHz=30;";

pub struct Ui {
    runtime: Option<Runtime>,
    /// Seconds the guest is owed.
    owed: f32,
    /// Which of its turns it takes.
    rest: Rest,
    /// What it last drew, for the frames between its turns.
    words: (*const u32, usize),
    /// A measurement left it out of the frame.
    hidden: bool,
    /// Why there is no interface, for the status report.
    pub error: String,
    /// Buttons a control message presses, each held two turns and let go for one.
    presses: std::collections::VecDeque<(u32, u8)>,
}

impl Ui {
    /// Boots the guest from `atlas.js` and `atlas.pak` (the USB share in a
    /// development build, else the package).
    ///
    /// # Safety
    /// Render thread, after vita2d is up and outside any scene.
    pub unsafe fn boot() -> Self {
        let read = |name: &str| crate::paths::candidates(name).iter().find_map(|p| crate::hostfs::read(p, 16 << 20)).ok_or(format!("{name} is missing"));
        let boot = || -> Result<Runtime, String> {
            // The guest borrows the pak for as long as it lives.
            let pak: &'static [u8] = Box::leak(read("atlas.pak")?.into_boxed_slice());
            let mut script = RATE.to_vec();
            script.extend(read("atlas.js")?);
            script.push(0);
            let script = String::from_utf8(script).map_err(|e| e.to_string())?;
            let mut runtime = Runtime::new(pak)?;
            guest::mount(runtime.context(), runtime.global());
            runtime.eval(&script)?;
            Ok(runtime)
        };
        match boot() {
            Ok(runtime) => Self { runtime: Some(runtime), owed: TURN, rest: Rest::default(), words: (core::ptr::null(), 0), hidden: false, error: String::new(), presses: Default::default() },
            Err(error) => {
                pocketjs_vita::vita_log(format_args!("atlas: interface: {error}"));
                Self { runtime: None, owed: 0.0, rest: Rest::default(), words: (core::ptr::null(), 0), hidden: false, error, presses: Default::default() }
            }
        }
    }

    /// What the interface is shown.
    pub fn state(&mut self) -> &mut State {
        unsafe { &mut guest::interface().state }
    }

    /// A measurement can leave the interface out of the frame: hidden, it
    /// takes no turn and draws nothing.
    pub fn show(&mut self, shown: bool) {
        self.hidden = !shown;
    }

    pub fn shown(&self) -> bool {
        self.runtime.is_some() && !self.hidden
    }

    /// Presses `buttons` on the interface as a thumb would.
    pub fn press(&mut self, buttons: u32) {
        self.presses.push_back((buttons, 3));
    }

    /// The guest's turn when `dt` more seconds make one due and it is not
    /// resting: the pad and the panel go in, what it asked for comes out,
    /// and what it shows is laid out.
    ///
    /// # Safety
    /// Render thread, outside any scene.
    pub unsafe fn turn(&mut self, dt: f32, buttons: u32, pad: &input::Pad) -> Vec<Command> {
        let mut asked = Vec::new();
        self.owed = (self.owed + dt).min(2.0 * TURN);
        let Some(runtime) = &mut self.runtime else { return asked };
        if self.owed < TURN || self.hidden {
            return asked;
        }
        self.owed -= TURN;
        let mut buttons = buttons;
        if let Some((pressed, turns)) = self.presses.front_mut() {
            *turns -= 1;
            if *turns > 0 {
                buttons |= *pressed;
            } else {
                self.presses.pop_front();
            }
        }
        let touches = input::read_touches();
        if !self.rest.due(buttons != 0 || !touches.packed().is_empty(), guest::interface().pending()) {
            return asked;
        }
        if let Err(error) = runtime.frame_with_input(buttons as i32, pad.left_analog() as i32, &touches) {
            pocketjs_vita::vita_log(format_args!("atlas: interface: {error}"));
            self.error = error;
            self.runtime = None;
            return asked;
        }
        // Two core ticks to a turn: the core counts sixtieths.
        runtime.tick();
        runtime.tick();
        while let Some(command) = guest::interface().next() {
            asked.push(command);
        }
        let list = runtime.ui().draw();
        self.rest.drew(&list.words);
        self.words = (list.words.as_ptr(), list.words.len());
        asked
    }

    /// Draws the interface into the open vita2d scene, over what is there.
    ///
    /// # Safety
    /// Render thread, inside the display scene.
    pub unsafe fn draw(&mut self) {
        if self.hidden || self.words.1 == 0 {
            return;
        }
        if let Some(runtime) = &mut self.runtime {
            graphics::render_over(runtime.ui(), core::slice::from_raw_parts(self.words.0, self.words.1));
        }
    }
}
