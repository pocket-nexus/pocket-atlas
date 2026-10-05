//! The interface: one PocketJS guest (`ui/`, shared with the other devices)
//! drawn over the globe and the places through PocketJS's PSP host library.
//! It owns every 2D pixel and what the buttons mean; this side owns the
//! scene, shows it the renderer's state and does what it asks
//! (`crates/pocket-atlas-interface`).
use alloc::{collections::VecDeque, vec::Vec};
use core::ffi::c_void;
use libquickjs_sys::*;
use pocket_atlas_interface::{guest, Command, Rest, State};
use pocketjs_psp::{arena, ffi, ge, host, pak, qjs_alloc};

// libquickjs-sys omits these; the linked QuickJS provides them.
extern "C" {
    fn JS_NewArrayBuffer(
        ctx: *mut JSContext,
        buf: *mut u8,
        len: usize,
        free: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void, *mut c_void)>,
        opaque: *mut c_void,
        shared: i32,
    ) -> JSValue;
    fn JS_RunGC(rt: *mut JSRuntime);
}

/// The guest turns this often, and is told so before it mounts.
const TURN: f32 = 1.0 / 30.0;
/// The arena may grow this much before a guest at rest is collected.
const GROWTH: usize = 128 << 10;

pub struct Ui {
    guest: Option<(*mut JSRuntime, *mut JSContext, JSValue, JSValue)>,
    /// Seconds the guest is owed.
    owed: f32,
    /// Which of its turns it takes.
    rest: Rest,
    /// What it last drew, for the frames between its turns.
    words: (*const u32, usize),
    /// Buttons a control message presses, each held two turns and let go for one.
    presses: VecDeque<(u32, u8)>,
    /// How far the arena had been carved when the guest was last collected.
    collected: usize,
    pub error: &'static str,
}

impl Ui {
    /// Boots the guest: `script` is the bundle (NUL-terminated; not needed
    /// once this returns), `pak` its styles, fonts and pictures, which the
    /// guest borrows for good.
    pub unsafe fn boot(script: Option<&[u8]>, pak: Option<&'static [u8]>) -> Self {
        let mut ui = Self { guest: None, owed: TURN, rest: Rest::default(), words: (core::ptr::null(), 0), presses: VecDeque::new(), collected: 0, error: "" };
        let (Some(script), Some(pak)) = (script, pak) else {
            ui.error = "atlas.js or atlas.pak is missing";
            return ui;
        };
        let core = ffi::init_ui();
        let (textures, sprites) = pak::feed(core, pak);
        pak::install(pak);
        let rt = qjs_alloc::new_runtime();
        let ctx = if rt.is_null() { core::ptr::null_mut() } else { JS_NewContext(rt) };
        if ctx.is_null() {
            ui.error = "no memory for the interface";
            return ui;
        }
        let global = JS_GetGlobalObject(ctx);
        ffi::register(ctx, global, &textures, &sprites);
        // The channel to this renderer takes the place of the host's wire.
        guest::mount(ctx, global);
        JS_SetPropertyStr(ctx, global, c"__simHz".as_ptr(), JS_NewInt32(ctx, 30));
        JS_SetPropertyStr(ctx, global, c"__pak".as_ptr(), JS_NewArrayBuffer(ctx, pak.as_ptr() as *mut u8, pak.len(), None, core::ptr::null_mut(), 0));
        let result = JS_Eval(ctx, script.as_ptr() as *const _, script.len() - 1, c"atlas.js".as_ptr(), JS_EVAL_TYPE_GLOBAL as i32);
        let failed = JS_ValueGetTag(result) == JS_TAG_EXCEPTION;
        if failed {
            host::log_exception_with(ctx, |_| {});
        }
        JS_FreeValue(ctx, result);
        let frame = JS_GetPropertyStr(ctx, global, c"frame".as_ptr());
        if failed || JS_IsUndefined(frame) {
            ui.error = "the interface did not start";
            return ui;
        }
        host::drain_jobs(rt);
        ui.guest = Some((rt, ctx, global, frame));
        ui
    }

    /// What the interface is shown.
    pub fn state(&mut self) -> &mut State {
        unsafe { &mut guest::interface().state }
    }

    /// Presses `buttons` on the interface as a thumb would.
    pub fn press(&mut self, buttons: u32) {
        self.presses.push_back((buttons, 3));
    }

    /// The guest's turn when `dt` more seconds make one due and it is not
    /// resting: the pad goes in, what it asked for comes out, and what it
    /// shows is laid out.
    pub unsafe fn turn(&mut self, dt: f32, mut buttons: u32, analog: u32) -> Vec<Command> {
        let mut asked = Vec::new();
        self.owed = (self.owed + dt).min(2.0 * TURN);
        let Some((rt, ctx, global, frame)) = self.guest else { return asked };
        if self.owed < TURN {
            return asked;
        }
        self.owed -= TURN;
        if let Some((pressed, turns)) = self.presses.front_mut() {
            *turns -= 1;
            if *turns > 0 {
                buttons |= *pressed;
            } else {
                self.presses.pop_front();
            }
        }
        if !self.rest.due(buttons != 0, guest::interface().pending()) {
            // A collection stops the frame for tens of milliseconds, so it
            // waits until the arena has had to grow: until then what the
            // guest dropped has been handed out again.
            if self.rest.settled() && arena::stats().bump_bytes > self.collected + GROWTH {
                self.collect();
            }
            return asked;
        }
        let mut arguments = [JS_NewInt32(ctx, buttons as i32), JS_NewInt32(ctx, analog as i32)];
        let result = JS_Call(ctx, frame, global, 2, arguments.as_mut_ptr());
        if JS_ValueGetTag(result) == JS_TAG_EXCEPTION {
            host::log_exception_with(ctx, |_| {});
            self.error = "the interface threw";
        }
        JS_FreeValue(ctx, result);
        host::drain_jobs(rt);
        while let Some(command) = guest::interface().next() {
            asked.push(command);
        }
        // Two core ticks to a turn: the core counts sixtieths.
        let core = ffi::ui();
        core.tick();
        core.tick();
        let list = core.draw();
        self.rest.drew(&list.words);
        self.words = (list.words.as_ptr(), list.words.len());
        asked
    }

    /// Frees what the guest no longer reaches. A view that was left (a
    /// place, the keyboard) stays allocated until a collection, because its
    /// objects refer to each other, and QuickJS alone collects only once its
    /// heap has grown by half: the arena, which hands a block back only to a
    /// request of the same size, would grow with every view. So collect
    /// between scenes, and when the interface comes to rest with the arena
    /// grown.
    pub unsafe fn collect(&mut self) {
        if let Some((rt, ..)) = self.guest {
            JS_RunGC(rt);
            self.collected = arena::stats().bump_bytes;
        }
    }

    /// Draws the interface into the open display list, over what is there.
    pub unsafe fn draw(&self) {
        if self.guest.is_some() && self.words.1 > 0 {
            ge::render_over(ffi::ui(), core::slice::from_raw_parts(self.words.0, self.words.1));
        }
    }
}
