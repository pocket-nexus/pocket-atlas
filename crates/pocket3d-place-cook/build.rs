use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Command,
};
fn collect(path: &Path, files: &mut Vec<PathBuf>) {
    if path.is_dir() {
        for e in std::fs::read_dir(path).unwrap() {
            collect(&e.unwrap().path(), files);
        }
    } else {
        files.push(path.to_owned());
    }
}
fn main() {
    let root = Path::new("../..");
    let mut files = Vec::new();
    for path in [
        "Cargo.lock",
        "Cargo.toml",
        "profiles",
        "n3ds/src/memory.h",
        "vendor/pocketjs/devices/psp/pocket-psp-ge/Cargo.toml",
        "vendor/pocketjs/devices/psp/pocket-psp-ge/src",
        "crates/pocket-atlas-model/src",
        "crates/pocket-atlas-model/Cargo.toml",
        "crates/pocket3d-place/src",
        "crates/pocket3d-place/Cargo.toml",
        "crates/pocket3d-place-psp/src",
        "crates/pocket3d-place-psp/Cargo.toml",
        "crates/pocket3d-place-cook/src",
        "crates/pocket3d-place-cook/Cargo.toml",
        "crates/pocket3d-place-cook/build.rs",
    ] {
        let p = root.join(path);
        println!("cargo:rerun-if-changed={}", p.display());
        collect(&p, &mut files);
    }
    files.sort();
    // Native arena sizes are compiler inputs, rather than separately copied
    // constants that can silently drift from the runtime allocation plan.
    let memory = std::fs::read_to_string(root.join("n3ds/src/memory.h")).unwrap();
    for line in memory.lines().filter(|l| l.starts_with("#define ATLAS_")) {
        let words: Vec<_> = line.split_whitespace().collect();
        if words.len() == 3 {
            let _: usize = words[2].parse().expect("literal Atlas memory constant");
            println!("cargo:rustc-env={}={}", words[1], words[2]);
        }
    }
    let mut digest = Sha256::new();
    for f in files {
        let name = f.strip_prefix(root).unwrap().to_str().unwrap();
        let data = std::fs::read(&f).unwrap();
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name.as_bytes());
        digest.update((data.len() as u64).to_le_bytes());
        digest.update(data);
    }
    println!(
        "cargo:rustc-env=ATLAS_COMPILER_HASH={:x}",
        digest.finalize()
    );
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let version = Command::new(rustc).arg("--version").output().unwrap();
    assert!(version.status.success());
    println!(
        "cargo:rustc-env=ATLAS_RUSTC={}",
        String::from_utf8(version.stdout).unwrap().trim()
    );
}
