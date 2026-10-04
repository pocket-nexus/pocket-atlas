//! Reject output aliases before any compiler output is written.
use crate::{ir, Args};
use std::path::{Component, Path, PathBuf};

fn resolved(path: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(path).map_err(|e| e.to_string())?;
    let mut result = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => (),
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(component.as_os_str()),
        }
        // Resolve each existing ancestor, including directory symlinks, before
        // processing `..` or a not-yet-created leaf.
        if result.exists() {
            result = result.canonicalize().map_err(|e| e.to_string())?;
        }
    }
    Ok(result)
}
fn aliases(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(a), Ok(b)) = (a.metadata(), b.metadata()) {
            return a.dev() == b.dev() && a.ino() == b.ino();
        }
    }
    false
}
pub fn check(
    a: &Args,
    sealed: &Path,
    manifest: &ir::Manifest,
    report: &Path,
) -> Result<(), String> {
    let mut sources = vec![
        sealed.join("manifest.json"),
        a.input.join("scene.glb"),
        a.input.join("export.json"),
    ];
    sources.extend(manifest.files.iter().map(|f| sealed.join(&f.path)));
    let sources = sources
        .iter()
        .map(|p| resolved(p))
        .collect::<Result<Vec<_>, _>>()?;
    let mut outputs = vec![
        a.output.clone(),
        report.into(),
        a.output.with_extension("log"),
    ];
    if a.target == ir::Target::Psp {
        outputs.push(a.output.with_extension("json"));
    }
    if let Some(path) = &a.telemetry {
        outputs.push(path.clone());
    }
    let outputs = outputs
        .iter()
        .map(|p| resolved(p))
        .collect::<Result<Vec<_>, _>>()?;
    for (i, output) in outputs.iter().enumerate() {
        if sources
            .iter()
            .chain(&outputs[..i])
            .any(|p| aliases(output, p))
        {
            return Err(format!(
                "compiler output path aliases a source or another output: {}",
                output.display()
            ));
        }
    }
    Ok(())
}
