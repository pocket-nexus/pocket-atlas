//! Where the app's files live: the USB share in development builds, the
//! package, and the memory card's data folder.

use serde_json::Value;

/// The app's folder on the memory card (saved places, settings, packs
/// installed or fetched there).
pub const DATA: &str = "ux0:data/pocket-atlas";

/// Paths a shipped file (`rel`: `atlas.pack`, `places/<id>.place`) is looked
/// for at, in order: the USB share (development builds), the package, the
/// data folder.
pub fn candidates(rel: &str) -> Vec<String> {
    let mut v = Vec::new();
    if cfg!(feature = "usb-debug") {
        v.push(format!("host0:atlas/{rel}"));
    }
    v.push(format!("app0:{rel}"));
    v.push(format!("{DATA}/{rel}"));
    v
}

/// A JSON file in the data folder.
pub fn read_json(name: &str) -> Option<Value> {
    std::fs::read(format!("{DATA}/{name}")).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

/// Writes a JSON file in the data folder.
pub fn write_json(name: &str, v: &Value) {
    write_text(name, &v.to_string());
}

/// Writes a file in the data folder through a temporary file, so a
/// power-off mid-write leaves the previous version.
pub fn write_text(name: &str, text: &str) {
    let _ = std::fs::create_dir_all(DATA);
    let (tmp, path) = (format!("{DATA}/{name}.tmp"), format!("{DATA}/{name}"));
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::rename(&tmp, &path);
    }
}
