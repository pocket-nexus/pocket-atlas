//! Optional PSPLINK file mailbox. Standalone startup probes once; without a
//! host control file, frames never perform host0 I/O. No scene rules live here.
use alloc::{format, string::String};
use psp::sys::*;

pub struct Command {
    pub shot: i32,
    pub time: f32,
    pub pause: bool,
    pub rain: bool,
    pub reflection: bool,
    nonce: u32,
}
impl Command {
    fn parse(text: &str) -> Option<Self> {
        let mut fields = text.split_whitespace();
        let flag = |text: &str| match text {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        };
        let command = Self {
            shot: fields.next()?.parse().ok()?,
            time: fields.next()?.parse().ok()?,
            pause: flag(fields.next()?)?,
            rain: flag(fields.next()?)?,
            reflection: flag(fields.next()?)?,
            nonce: fields.next()?.parse().ok()?,
        };
        (fields.next().is_none()
            && command.shot >= -1
            && command.time.is_finite()
            && (command.time == -1.0 || (0.0..=86400.0).contains(&command.time)))
        .then_some(command)
    }
}

pub struct Status<'a> {
    pub frame: u32,
    pub shot: &'a str,
    pub shot_index: usize,
    pub time: f32,
    pub frame_ms: f32,
    pub work_ms: f32,
    pub gpu_wait_ms: f32,
    pub max_work_ms: f32,
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
}
impl Session {
    pub unsafe fn connect() -> Self {
        let fd = sceIoOpen(b"host0:/control.txt\0".as_ptr(), IoOpenFlags::RD_ONLY, 0);
        let enabled = fd.0 >= 0;
        if enabled {
            sceIoClose(fd);
        }
        Self {
            enabled,
            nonce: None,
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
        let mut buffer = [0u8; 128];
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
                "{{\"target\":\"psp\",\"frame\":{},\"shot\":\"{}\",\"shotIndex\":{},",
                "\"time\":{:.2},\"fps\":{:.2},\"frameMs\":{:.2},\"workMs\":{:.2},",
                "\"gpuWaitMs\":{:.2},\"maxWorkMs\":{:.2},\"draws\":{},\"triangles\":{},",
                "\"packBytes\":{},\"rain\":{},\"reflection\":{},\"paused\":{},",
                "\"freeCamera\":{},\"controlNonce\":{}}}\n"
            ),
            s.frame,
            shot,
            s.shot_index,
            s.time,
            1000.0 / s.frame_ms,
            s.frame_ms,
            s.work_ms,
            s.gpu_wait_ms,
            s.max_work_ms,
            s.draws,
            s.triangles,
            s.pack_bytes,
            s.rain,
            s.reflection,
            s.paused,
            s.free_camera,
            self.nonce.unwrap_or(0)
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
