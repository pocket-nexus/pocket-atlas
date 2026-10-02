//! Small, versioned user state. GPU resources and diagnostic commands never
//! enter this file; a cold launch rebuilds resources from the bundled catalog.
use alloc::{ffi::CString, format, string::String, vec};
use core::ffi::{c_char, c_void};
use serde::{Deserialize, Serialize};

const VERSION: u32 = 1;
const MAX_BYTES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserState {
    pub version: u32,
    pub place: Option<String>,
    pub time: f32,
    pub shot: u32,
    pub shot_time: f32,
    pub paused: bool,
    pub cinematic: bool,
    pub eye: [f32; 3],
    pub target: [f32; 3],
    pub fov: f32,
    pub door: f32,
    pub globe_rotation: [f32; 2],
    pub sound: bool,
    pub rain: bool,
    pub reflection: bool,
    pub bloom: bool,
    pub quality: i32,
}

impl UserState {
    pub const VERSION: u32 = VERSION;

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != VERSION {
            return Err("unsupported user state version");
        }
        if self.place.as_ref().is_some_and(|id| {
            id.is_empty()
                || id.len() > 96
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        }) {
            return Err("invalid saved place ID");
        }
        let bounded = |n: f32, min: f32, max: f32| n.is_finite() && n >= min && n <= max;
        if !bounded(self.time, 0.0, 1_000_000_000.0)
            || self.shot > 4095
            || !bounded(self.shot_time, 0.0, 86400.0)
            || !bounded(self.fov, 1.0, 179.0)
            || !bounded(self.door, 0.0, 1.0)
            || !bounded(self.globe_rotation[0], -80.0, 80.0)
            || !bounded(self.globe_rotation[1], -360.0, 360.0)
            || !(0..=2).contains(&self.quality)
            || !self
                .eye
                .iter()
                .chain(self.target.iter())
                .all(|&n| bounded(n, -100_000.0, 100_000.0))
        {
            return Err("invalid saved state range");
        }
        // Walking projects the view direction onto the ground plane. Reject a
        // degenerate or vertical camera before either normalization can run.
        let dx = self.target[0] - self.eye[0];
        let dz = self.target[2] - self.eye[2];
        if dx * dx + dz * dz < 0.000001 {
            return Err("invalid saved camera direction");
        }
        Ok(())
    }

    pub fn selected<'a>(
        &self,
        ids: impl Iterator<Item = &'a str>,
    ) -> Result<Option<usize>, &'static str> {
        match &self.place {
            Some(place) => ids
                .enumerate()
                .find(|(_, id)| *id == place)
                .map(|(index, _)| Some(index))
                .ok_or("saved place is no longer available"),
            None => Ok(None),
        }
    }
}

pub struct Store {
    path: CString,
    temporary: CString,
}

extern "C" {
    fn fopen(path: *const c_char, mode: *const c_char) -> *mut c_void;
    fn fread(data: *mut c_void, size: usize, count: usize, file: *mut c_void) -> usize;
    fn fwrite(data: *const c_void, size: usize, count: usize, file: *mut c_void) -> usize;
    fn ferror(file: *mut c_void) -> i32;
    fn fflush(file: *mut c_void) -> i32;
    fn fileno(file: *mut c_void) -> i32;
    fn fsync(fd: i32) -> i32;
    fn fclose(file: *mut c_void) -> i32;
    fn rename(from: *const c_char, to: *const c_char) -> i32;
    fn unlink(path: *const c_char) -> i32;
}

impl Store {
    /// The platform supplies the application's Documents directory and creates
    /// it before initialization. Never fall back to bundle storage or /tmp.
    pub fn new(documents: &str) -> Result<Self, &'static str> {
        if !documents.starts_with('/') {
            return Err("Documents directory is unavailable");
        }
        Ok(Self {
            path: CString::new(format!("{documents}/pocket-atlas-state.json"))
                .map_err(|_| "invalid Documents directory")?,
            temporary: CString::new(format!("{documents}/pocket-atlas-state.json.new"))
                .map_err(|_| "invalid Documents directory")?,
        })
    }

    pub fn load(&self) -> Result<Option<UserState>, &'static str> {
        let mut bytes = vec![0u8; MAX_BYTES + 1];
        let length = unsafe {
            let file = fopen(self.path.as_ptr(), b"rb\0".as_ptr().cast());
            if file.is_null() {
                return Ok(None);
            }
            let length = fread(bytes.as_mut_ptr().cast(), 1, bytes.len(), file);
            let failed = ferror(file) != 0;
            let closed = fclose(file);
            if failed || closed != 0 {
                return Err("cannot read user state");
            }
            length
        };
        if length > MAX_BYTES {
            return Err("user state is too large");
        }
        let state: UserState =
            serde_json::from_slice(&bytes[..length]).map_err(|_| "invalid user state JSON")?;
        state.validate()?;
        Ok(Some(state))
    }

    pub fn save(&self, state: &UserState) -> Result<(), &'static str> {
        state.validate()?;
        let bytes = serde_json::to_vec(state).map_err(|_| "cannot encode user state")?;
        if bytes.len() > MAX_BYTES {
            return Err("user state is too large");
        }
        unsafe {
            let file = fopen(self.temporary.as_ptr(), b"wb\0".as_ptr().cast());
            if file.is_null() {
                return Err("cannot create user state");
            }
            let written = fwrite(bytes.as_ptr().cast(), 1, bytes.len(), file) == bytes.len();
            let flushed = fflush(file) == 0;
            let synced = written && flushed && fsync(fileno(file)) == 0;
            let closed = fclose(file) == 0;
            // A failed or interrupted replacement leaves the previous complete
            // document readable. A leftover .new is never used for recovery.
            if !synced || !closed || rename(self.temporary.as_ptr(), self.path.as_ptr()) != 0 {
                unlink(self.temporary.as_ptr());
                return Err("cannot commit user state");
            }
        }
        Ok(())
    }
}
