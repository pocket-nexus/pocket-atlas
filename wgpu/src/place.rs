//! Where a place's renderer plugs in.
//!
//! This build draws the atlas screen and no place: [`RENDERER`] is `None`, so
//! the interface is told that no place's pack is here (`installed` is empty)
//! and lists every place as it does one a device has no pack for. A renderer
//! of places is one value of [`Renderer`], named in `RENDERER`; nothing else
//! in the shell changes.
//!
//! What a renderer is given when the visitor enters a place is an
//! [`Opening`]: the place's pack as PocketJS's browser kernel reads it
//! (ranges, its length, all of it), the GPU with the optional features the
//! renderer asked for, and the screen its frames go to. What it gives back is
//! a [`Place`]: the shell steps it, hands it the interface's commands, asks
//! it what the interface is shown, and has it draw its passes into a frame the
//! shell then lays the interface over.
//!
//! The flow around it is the shell's (`app.rs`): `scene` is `Loading` from the
//! `enter` command until [`Renderer::open`]'s future ends, then `Place` or,
//! with its message, `Error`; `leave` drops the `Place`, which frees what it
//! holds on the GPU.

use core::future::Future;
use core::pin::Pin;

use pocket_atlas_interface::{Command, Setting};
use pocket_web_wgpu::gpu::{Frame, Gpu};
use pocket_web_wgpu::source::Source;
use pocket_web_wgpu::wgpu;

use crate::app::{Held, Shape};

/// What a renderer is handed to open a place.
pub struct Opening {
    /// The place's id (`web/src/places/registry.ts`).
    pub place: String,
    /// The place's pack: `range`, `length` and `all` (`pocket_web_wgpu::source`). In a tab it is a file on a
    /// server that answers byte ranges, or the manifest of a pack cut into pieces.
    pub pack: Source,
    /// The device. `gpu.features` holds those of [`Renderer::wants`] the adapter has: a pack whose textures
    /// the device cannot sample is refused here, with a message the interface shows.
    pub gpu: Gpu,
    /// The screen the frames go to: its format, and its size in pixels, samples and logical size.
    pub format: wgpu::TextureFormat,
    pub shape: Shape,
}

/// What the interface is shown of a place (`ui/app/protocol.ts`, `HostState`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shown {
    /// The shot the camera is on, an index into [`Place::shots`].
    pub shot: u32,
    /// The camera follows the authored tour; false once the visitor moves it.
    pub tour: bool,
    pub paused: bool,
    /// What the visitor may set here, in menu order.
    pub options: Vec<Setting>,
    /// One line of statistics while the `stats` setting is on; empty otherwise.
    pub stats: String,
}

/// A place that has been opened.
pub trait Place {
    /// The authored shots' names, in order.
    fn shots(&self) -> Vec<String>;

    /// A command of the interface that is a place's: `Shot`, `Tour`, `Pause`, `Option`, `Drive`, `Look`.
    fn obey(&mut self, command: &Command);

    /// Advances the place `dt` seconds. `held` is the page's pad; `free` is false while the interface holds
    /// the pad (a sheet is open): the d-pad and the sticks are then not the camera's.
    fn step(&mut self, dt: f32, held: &Held, free: bool);

    /// What the interface is shown, read after every step.
    fn shown(&self) -> Shown;

    /// Another screen from the next frame on (another device's): its format, size, samples.
    fn reshape(&mut self, gpu: &Gpu, format: wgpu::TextureFormat, shape: &Shape);

    /// One frame: every pass of the place, the last of them into `frame` (its colour, the resolve target
    /// when the screen has several samples, its depth). The shell lays the interface over `frame`, submits
    /// `encoder` and presents. Returns the triangles drawn.
    fn draw(&mut self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, frame: &Frame) -> Result<u32, String>;

    /// Words a development host sends a place (a view held for a picture, a moment of its loop). A renderer
    /// reads the ones it knows.
    fn control(&mut self, _words: &str) {}

    /// The run of the place as JSON members (`"draws":12,"triangles":3400`), for the shell's status.
    fn status(&self) -> String {
        String::new()
    }
}

/// A place being opened: reads of its pack, then textures and buffers on the GPU.
pub type Opened = Pin<Box<dyn Future<Output = Result<Box<dyn Place>, String>>>>;

/// A renderer of places.
#[derive(Clone, Copy)]
pub struct Renderer {
    /// The optional GPU features it can use, asked of the adapter when the shell opens the device:
    /// compressed texture formats (`TEXTURE_COMPRESSION_BC` on a desktop GPU, `_ETC2` and `_ASTC` on a
    /// phone's), for a pack that stores them.
    pub wants: wgpu::Features,
    /// Opens a place. The future is run beside the frames (`pocket_web_wgpu::task::spawn`): while it reads,
    /// the atlas screen's globe is still drawn and the interface shows its loading screen.
    pub open: fn(Opening) -> Opened,
}

/// The renderer of places in this build: the PS Vita's, on wgpu (`places/`).
pub const RENDERER: Option<Renderer> = Some(crate::places::RENDERER);
