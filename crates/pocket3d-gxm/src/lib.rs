//! `pocket3d-gxm` — the programmable GXM layer of Pocket3D on PS Vita.
//!
//! `pocket3d-vita` draws with vita2d's five stock shader binaries. This crate
//! owns the parts that need programs of our own: GXP registration and
//! patching, the runtime Cg compiler used during development, render targets
//! and GPU memory for multi-pass frames.

#[cfg(target_os = "vita")]
pub mod mem;
#[cfg(target_os = "vita")]
pub mod patcher;
#[cfg(target_os = "vita")]
pub mod program;
#[cfg(target_os = "vita")]
pub mod shacccg;
#[cfg(target_os = "vita")]
pub mod target;
#[cfg(target_os = "vita")]
pub mod texture;
