//! Pocket Atlas drawn with wgpu: the atlas screen in a browser tab over
//! WebGPU, and on the build machine, where a frame can be written to a file.
//!
//! [`globe`] is the atlas screen's globe, the iPod touch's (`ipod/src/globe.c`)
//! in WGSL. [`app`] is the shell: the game's side of the interface channel
//! (`crates/pocket-atlas-interface`, the protocol of `ui/`) and the flow around
//! a place. [`place`] is where a renderer of places plugs in; this build has
//! none, and the interface is told that no place's pack is here. What is not
//! this game's is PocketJS's browser kernel, `pocket_web_wgpu`
//! (`vendor/pocketjs/devices/web/pocket-web-wgpu`).

pub mod app;
pub mod globe;
pub mod place;
pub mod places;
#[cfg(target_arch = "wasm32")]
mod web;
