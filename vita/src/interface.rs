//! The interface: one PocketJS guest (`ui/`, shared with the other devices)
//! drawn over the globe and the places through PocketJS's Vita host library.
//! It owns every 2D pixel and what the buttons and the panel mean; this side
//! owns the scene, shows it the renderer's state and does what it asks
//! (`crates/pocket-atlas-interface`).

use pocket_atlas_interface::{guest, Command, State};
use pocketjs_vita::{input, Runtime};

/// The guest turns this often, and is told so before it mounts.
const TURN: f32 = 1.0 / 30.0;
const RATE: &[u8] = b"globalThis.__simHz=30;";

pub struct Ui {
    runtime: Option<Runtime>,
    /// Seconds the guest is owed.
    owed: f32,
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
            Ok(runtime) => Self { runtime: Some(runtime), owed: TURN, error: String::new(), presses: Default::default() },
            Err(error) => {
                pocketjs_vita::vita_log(format_args!("atlas: interface: {error}"));
                Self { runtime: None, owed: 0.0, error, presses: Default::default() }
            }
        }
    }

    /// What the interface is shown.
    pub fn state(&mut self) -> &mut State {
        unsafe { &mut guest::interface().state }
    }

    /// Presses `buttons` on the interface as a thumb would.
    pub fn press(&mut self, buttons: u32) {
        self.presses.push_back((buttons, 3));
    }

    /// The guest's turns for `dt` seconds: the pad and the panel go in, and
    /// what it asked for comes out.
    ///
    /// # Safety
    /// Render thread, outside any scene.
    pub unsafe fn turn(&mut self, dt: f32, buttons: u32, pad: &input::Pad) -> Vec<Command> {
        let mut asked = Vec::new();
        self.owed = (self.owed + dt).min(2.0 * TURN);
        let Some(runtime) = &mut self.runtime else { return asked };
        if self.owed < TURN {
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
        if let Err(error) = runtime.frame_with_input(buttons as i32, pad.left_analog() as i32, &input::read_touches()) {
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
        asked
    }

    /// Draws the interface into the open vita2d scene, over what is there.
    ///
    /// # Safety
    /// Render thread, inside the display scene.
    pub unsafe fn draw(&mut self) {
        if let Some(runtime) = &mut self.runtime {
            runtime.render_over();
        }
    }
}
