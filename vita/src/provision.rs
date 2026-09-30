//! Development provisioning of the runtime Cg compiler. When the PSM Runtime
//! is installed but `libshacccg.suprx` was never extracted, the encrypted
//! module is read through the runtime's PFS mount and exported to the USB
//! share; the computer decrypts it into a loadable module, which is then
//! installed to `ur0:data/`.

use std::ffi::{c_char, CStr};

const TARGET: &str = "ur0:data/libshacccg.suprx";
const EXPORT: &str = "host0:city/psm/libshacccg.suprx.ext";
const IMPORT: &str = "host0:city/psm/libshacccg.suprx";

extern "C" {
    fn sceAppMgrGameDataMount(app: *const c_char, patch: *const c_char, rif: *const c_char, mount_point: *mut c_char) -> i32;
    fn sceAppMgrUmount(mount_point: *const c_char) -> i32;
}

fn local_exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

/// One provisioning step; returns a status line for the device receipt.
pub fn step() -> String {
    if local_exists(TARGET) {
        return format!("{TARGET} present");
    }
    if let Some(module) = crate::hostfs::read(IMPORT, 8 << 20) {
        if module.get(..4) != Some(b"SCE\0") {
            return format!("{IMPORT}: not a SELF");
        }
        let _ = std::fs::create_dir_all("ur0:data");
        return match std::fs::write(TARGET, &module) {
            Ok(()) => format!("installed {} bytes to {TARGET}", module.len()),
            Err(e) => format!("{TARGET}: {e}"),
        };
    }
    if crate::hostfs::read(EXPORT, 16).is_some() {
        return format!("waiting for the computer to decrypt {EXPORT}");
    }
    let mut log = Vec::new();
    let sources = ["ux0:patch/PCSI00011/module/libshacccg.suprx", "ux0:app/PCSI00011/module/libshacccg.suprx"];
    if !sources.iter().any(|s| local_exists(s)) {
        return "PSM Runtime (PCSI00011) not installed".into();
    }
    for (app, patch) in [(c"ux0:app/PCSI00011", Some(c"ux0:patch/PCSI00011")), (c"ux0:app/PCSI00011", None)] {
        let mut mp = [0 as c_char; 64];
        let r = unsafe { sceAppMgrGameDataMount(app.as_ptr(), patch.map_or(core::ptr::null(), |p| p.as_ptr()), core::ptr::null(), mp.as_mut_ptr()) };
        let mount = unsafe { CStr::from_ptr(mp.as_ptr()) }.to_string_lossy().into_owned();
        log.push(format!("mount patch={} -> 0x{:08x} {mount}", patch.is_some(), r as u32));
        if r < 0 {
            continue;
        }
        let mut candidates: Vec<String> = sources.iter().map(|s| s.to_string()).collect();
        if !mount.is_empty() {
            candidates.push(format!("{mount}module/libshacccg.suprx"));
            candidates.push(format!("{mount}/module/libshacccg.suprx"));
        }
        let mut found = None;
        for c in &candidates {
            match std::fs::read(c) {
                Ok(bytes) if bytes.get(..4) == Some(b"SCE\0") => {
                    log.push(format!("{c}: {} bytes, SCE", bytes.len()));
                    found = Some(bytes);
                    break;
                }
                Ok(bytes) => log.push(format!("{c}: {} bytes, still encrypted", bytes.len())),
                Err(e) => log.push(format!("{c}: {e}")),
            }
        }
        unsafe { sceAppMgrUmount(mp.as_ptr()) };
        if let Some(bytes) = found {
            let r = crate::hostfs::write(EXPORT, &bytes);
            log.push(format!("export: {r:?}"));
            let _ = crate::hostfs::write("host0:city/psm/extract.log", log.join("\n").as_bytes());
            return format!("exported {} bytes to {EXPORT}", bytes.len());
        }
    }
    let _ = crate::hostfs::write("host0:city/psm/extract.log", log.join("\n").as_bytes());
    format!("extract failed: {}", log.join(" | "))
}
