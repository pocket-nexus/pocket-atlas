//! Optional PSPLINK file mailbox. Standalone startup probes once; without a
//! host control file, frames never perform host0 I/O. No scene rules live here.
use alloc::{format, string::String, vec::Vec};
use psp::sys::*;
use sha2::{Digest, Sha256};

pub struct Command {
    pub shot: i32,
    pub time: f32,
    pub pause: bool,
    pub rain: bool,
    pub reflection: bool,
    nonce: u32,
    /// The place to be in (empty: whichever is on screen), buttons to press
    /// on the interface, and whether to write the next frame out.
    pub place: String,
    pub press: Vec<u32>,
    pub capture: bool,
}
fn button(name: &str) -> u32 {
    match name {
        "select" => 0x1,
        "start" => 0x8,
        "up" => 0x10,
        "right" => 0x20,
        "down" => 0x40,
        "left" => 0x80,
        "l" => 0x100,
        "r" => 0x200,
        "triangle" => 0x1000,
        "circle" => 0x2000,
        "cross" => 0x4000,
        "square" => 0x8000,
        _ => 0,
    }
}
impl Command {
    fn parse(text: &str) -> Option<Self> {
        let mut fields = text.split_whitespace();
        let flag = |text: &str| match text {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        };
        let mut command = Self {
            shot: fields.next()?.parse().ok()?,
            time: fields.next()?.parse().ok()?,
            pause: flag(fields.next()?)?,
            rain: flag(fields.next()?)?,
            reflection: flag(fields.next()?)?,
            nonce: fields.next()?.parse().ok()?,
            place: String::new(),
            press: Vec::new(),
            capture: false,
        };
        // Then any of place=<id>, press=<button,…> and capture=1.
        for field in fields {
            let (key, value) = field.split_once('=')?;
            match key {
                "place" => command.place = value.into(),
                "press" => command.press = value.split(',').map(button).collect(),
                "capture" => command.capture = value == "1",
                _ => return None,
            }
        }
        (command.shot >= -1
            && command.time.is_finite()
            && (command.time == -1.0 || (0.0..=86400.0).contains(&command.time)))
        .then_some(command)
    }
}

pub struct Status<'a> {
    /// atlas, loading, place or error; the place; why the interface is missing.
    pub scene: &'a str,
    pub place: &'a str,
    pub interface: &'a str,
    /// The arena: what it holds, what has not been carved, and the pack buffer.
    pub memory: [usize; 3],
    pub frame: u32,
    pub shot: &'a str,
    pub shot_index: usize,
    pub time: f32,
    pub frame_ms: f32,
    pub work_ms: f32,
    pub gpu_wait_ms: f32,
    pub max_work_ms: f32,
    /// The interface's turns: a frame's share of them, and the longest.
    pub interface_ms: f32,
    pub max_interface_ms: f32,
    pub draws: u32,
    pub triangles: u32,
    pub pack_bytes: usize,
    pub rain: bool,
    pub reflection: bool,
    pub paused: bool,
    pub free_camera: bool,
}
pub struct Session {
    enabled: bool,
    nonce: Option<u32>,
    pub pack_sha256: String,
    /// Where the place's pack was read: EBOOT.PBP, folder or host0.
    pub source: &'static str,
}
impl Session {
    /// The digest of the pack now in memory, for the status.
    pub fn loaded(&mut self, bytes: &[u8]) {
        self.pack_sha256 = if self.enabled { format!("{:x}", Sha256::digest(bytes)) } else { String::new() };
    }
    pub unsafe fn connect() -> Self {
        let fd = sceIoOpen(b"host0:/control.txt\0".as_ptr(), IoOpenFlags::RD_ONLY, 0);
        let enabled = fd.0 >= 0;
        if enabled {
            sceIoClose(fd);
        }
        Self {
            enabled,
            nonce: None,
            pack_sha256: String::new(),
            source: "",
        }
    }
    pub unsafe fn poll(&mut self) -> Option<Command> {
        if !self.enabled {
            return None;
        }
        let fd = sceIoOpen(b"host0:/control.txt\0".as_ptr(), IoOpenFlags::RD_ONLY, 0);
        if fd.0 < 0 {
            return None;
        }
        let mut buffer = [0u8; 256];
        let n = sceIoRead(fd, buffer.as_mut_ptr() as _, buffer.len() as u32);
        sceIoClose(fd);
        if n <= 0 || n as usize == buffer.len() {
            return None;
        }
        let command = Command::parse(core::str::from_utf8(&buffer[..n as usize]).ok()?)?;
        if self.nonce == Some(command.nonce) {
            return None;
        }
        self.nonce = Some(command.nonce);
        Some(command)
    }
    /// Writes the frame on the screen to the share: 480 by 272 RGBA rows.
    pub unsafe fn capture(&self, shown: *const u8) {
        let fd = sceIoOpen(b"host0:/capture.raw\0".as_ptr(), IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC, 0o666);
        if fd.0 >= 0 {
            for row in 0..272 {
                sceIoWrite(fd, shown.add(row * 512 * 4) as _, 480 * 4);
            }
            sceIoClose(fd);
        }
    }
    pub unsafe fn report(&self, s: Status<'_>) {
        if !self.enabled {
            return;
        }
        // Shot names are authored strings, not JSON tokens.
        let mut shot = String::new();
        for c in s.shot.chars() {
            match c {
                '"' => shot.push_str("\\\""),
                '\\' => shot.push_str("\\\\"),
                c if c < ' ' => shot.push_str(&format!("\\u{:04x}", c as u32)),
                c => shot.push(c),
            }
        }
        let text = format!(
            concat!(
                "{{\"target\":\"psp\",\"scene\":\"{}\",\"place\":\"{}\",\"interfaceError\":\"{}\",",
                "\"arenaBytes\":{},\"arenaFreeBytes\":{},\"packBufferBytes\":{},",
                "\"frame\":{},\"shot\":\"{}\",\"shotIndex\":{},",
                "\"time\":{:.2},\"fps\":{:.2},\"frameMs\":{:.2},\"workMs\":{:.2},",
                "\"gpuWaitMs\":{:.2},\"maxWorkMs\":{:.2},\"interfaceMs\":{:.2},\"maxInterfaceMs\":{:.2},",
                "\"draws\":{},\"triangles\":{},",
                "\"packBytes\":{},\"rain\":{},\"reflection\":{},\"paused\":{},",
                "\"freeCamera\":{},\"controlNonce\":{},\"packSha256\":\"{}\",\"packSource\":\"{}\",\"runtimeBuild\":\"{}\"}}\n"
            ),
            s.scene,
            s.place,
            s.interface,
            s.memory[0],
            s.memory[1],
            s.memory[2],
            s.frame,
            shot,
            s.shot_index,
            s.time,
            1000.0 / s.frame_ms,
            s.frame_ms,
            s.work_ms,
            s.gpu_wait_ms,
            s.max_work_ms,
            s.interface_ms,
            s.max_interface_ms,
            s.draws,
            s.triangles,
            s.pack_bytes,
            s.rain,
            s.reflection,
            s.paused,
            s.free_camera,
            self.nonce.unwrap_or(0),
            self.pack_sha256,
            self.source,
            option_env!("ATLAS_BUILD_ID").unwrap_or("unidentified")
        );
        let fd = sceIoOpen(
            b"host0:/status.json\0".as_ptr(),
            IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC,
            0o666,
        );
        if fd.0 >= 0 {
            sceIoWrite(fd, text.as_ptr() as _, text.len());
            sceIoClose(fd);
        }
    }
}
