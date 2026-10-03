//! `pocket-atlas-cook` — web export → PlaceIR → device-specific `.place`.
//!
//! ```text
//! pocket-atlas-cook --in .pocket-build/places/tokyo-konbini --out .pocket-build/places/tokyo-konbini/tokyo-konbini.place
//! ```
//!
//! Static geometry is baked to world space and split into spatial chunks;
//! animated subtrees (and door leaves) keep their node hierarchy; skinned
//! meshes keep joints and inverse binds. Textures are fitted to powers of two,
//! mipmapped and block-compressed; animation is resampled uniformly.

#[macro_export]
macro_rules! progress {
    ($($arg:tt)*) => { if !std::env::args().any(|a|a=="--json") { eprintln!($($arg)*); } };
}

mod atlas;
mod bake;
mod env;
mod extras;
mod geometry;
mod ir;
mod occlusion;
mod native_sky;
mod pica;
mod procedural;
mod psp;
mod psp_products;
mod source;
mod textures;
mod uifont;

mod analysis;
mod artifact;
mod profile;
mod vita;

use std::path::PathBuf;

struct Args {
    input: PathBuf,
    output: PathBuf,
    cell: f32,
    profile: profile::Profile,
    target: ir::Target,
}

fn fail(message: impl std::fmt::Display) -> ! {
    if std::env::args().any(|a| a == "--json") {
        eprintln!(
            "{}",
            serde_json::json!({"schemaVersion":1,"diagnostics":[{"severity":"error","code":"ATLAS_COMPILE_ERROR","message":message.to_string()}]})
        );
    } else {
        eprintln!("error: {message}");
    }
    std::process::exit(2)
}

fn args() -> Args {
    let a: Vec<String> = std::env::args().collect();
    let get = |k: &str| {
        a.iter()
            .position(|x| x == k)
            .and_then(|i| a.get(i + 1))
            .cloned()
    };
    let input =
        PathBuf::from(get("--in").unwrap_or_else(|| ".pocket-build/places/tokyo-konbini".into()));
    if a.iter().any(|v| v == "--pica-from") || a.get(1).is_some_and(|v| v == "psp") {
        fail("device packs are no longer compiler inputs; use --in <PlaceIR or web export directory> --target <vita|3ds|psp>");
    }
    let output = get("--out").map(PathBuf::from).unwrap_or_else(|| {
        if a.get(1).is_some_and(|v| v == "import") {
            input.join("place.ir")
        } else {
            input.join("scene.place")
        }
    });
    let explicit_target =
        get("--target").map(|v| ir::Target::parse(&v).unwrap_or_else(|e| fail(e)));
    let mut profile = get("--profile")
        .map(|v| profile::Profile::load(&v).unwrap_or_else(|e| fail(e)))
        .unwrap_or_else(|| profile::Profile::builtin(explicit_target.unwrap_or(ir::Target::Vita)));
    if explicit_target.is_some_and(|target| target != profile.target) {
        fail("--target conflicts with --profile");
    }
    if let Some(cap) = get("--tex") {
        profile.recipe.texture_cap = cap
            .parse()
            .unwrap_or_else(|_| fail("--tex must be an integer"));
        profile.recipe.detail_texture_cap = profile
            .recipe
            .detail_texture_cap
            .max(profile.recipe.texture_cap);
        profile.recipe.emissive_texture_cap = profile
            .recipe
            .emissive_texture_cap
            .max(profile.recipe.texture_cap);
    }
    profile.validate().unwrap_or_else(|e| fail(e));
    let cell: f32 = get("--cell")
        .map(|v| v.parse().unwrap_or_else(|_| fail("invalid --cell")))
        .unwrap_or(32.0);
    if !cell.is_finite() || cell <= 0.0 {
        fail("--cell must be finite and positive");
    }
    Args {
        target: profile.target,
        profile,
        input,
        output,
        cell,
    }
}

fn main() {
    let cli: Vec<String> = std::env::args().collect();
    if cli.get(1).is_some_and(|s| s == "profiles") {
        let profiles: Vec<_> = [ir::Target::Vita, ir::Target::Pica, ir::Target::Psp]
            .map(profile::Profile::builtin)
            .into();
        println!("{}", serde_json::to_string_pretty(&profiles).unwrap());
        return;
    }
    if cli.get(1).is_some_and(|s| s == "import" || s == "check") {
        let a = args();
        if cli[1] == "import" {
            let m = ir::import(&a.input, &a.output).unwrap_or_else(|e| fail(e));
            println!("{}", serde_json::to_string_pretty(&m).unwrap());
        } else {
            let (_, m) = ir::prepare(&a.input).unwrap_or_else(|e| fail(e));
            a.profile.check(&m).unwrap_or_else(|e| fail(e));
            if cli.iter().any(|s| s == "--json") {
                println!(
                    "{}",
                    serde_json::json!({"schemaVersion":1,"name":m.name,"profile":a.profile,"validation":{"capabilities":"supported","compiled":false,"device":{"status":"not-recorded"}}})
                );
            } else {
                println!(
                    "{}: {} capabilities supported; device validation not recorded",
                    m.name, a.profile.id
                );
            }
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("atlas") {
        let argv: Vec<String> = std::env::args().collect();
        let get = |k: &str| {
            argv.iter()
                .position(|x| x == k)
                .and_then(|i| argv.get(i + 1))
                .cloned()
        };
        let need = |k: &str| {
            PathBuf::from(
                get(k).unwrap_or_else(|| panic!("atlas: missing {k} (the interface font's faces)")),
            )
        };
        let input =
            PathBuf::from(get("--in").unwrap_or_else(|| ".pocket-build/atlas/globe".into()));
        let output = get("--out")
            .map(PathBuf::from)
            .unwrap_or_else(|| input.parent().unwrap_or(&input).join("atlas.pack"));
        let faces = uifont::Faces {
            latin: [need("--latin"), need("--latin-bold")],
            cjk: [need("--cjk"), need("--cjk-bold")],
        };
        atlas::cook(&input, &output, &faces);
        return;
    }
    let mut a = args();
    let (root, manifest) = ir::prepare(&a.input).unwrap_or_else(|e| fail(e));
    a.profile.check(&manifest).unwrap_or_else(|e| fail(e));
    if manifest.kind == "daytime-street" && !std::env::args().any(|v| v == "--cell") {
        if let Some(geometry) = &a.profile.recipe.psp_geometry {
            a.cell = geometry.daytime_cell_meters;
        }
    }
    if !std::env::args().any(|v| v == "--out") {
        let suffix = match a.target {
            ir::Target::Vita => "",
            ir::Target::Pica => ".3ds",
            ir::Target::Psp => ".psp",
        };
        a.output = a.input.join(format!("{}{suffix}.place", manifest.name));
    }
    std::fs::create_dir_all(a.output.parent().unwrap_or(std::path::Path::new(".")))
        .expect("output directory");
    a.input = root;
    let (scene, log) = analysis::analyze(&a, &manifest.name);
    let artifact = match a.target {
        ir::Target::Vita => vita::cook(&scene, &a.profile),
        ir::Target::Pica => pica::cook(&scene, &a.profile),
        ir::Target::Psp => psp::cook(&scene, &a.profile),
    }
    .unwrap_or_else(|e| fail(e));
    a.profile
        .check_artifact(&artifact)
        .unwrap_or_else(|e| fail(e));
    let diagnostics:Vec<_> = scene.textures.iter().enumerate().filter(|(_,t)|matches!(t.pixels,source::Pixels::Image{..}) && t.usage.is_none()).map(|(id,t)|serde_json::json!({
        "code":"ATLAS_LEGACY_TEXTURE_USAGE","severity":"warning","resource":id,"name":t.name,
        "message":"Texture purpose inferred by the versioned compatibility recipe; annotate material textureUsage for explicit sizing."
    })).collect();
    let mut report = artifact.report(&manifest, &a.profile, a.cell, &diagnostics);
    report["sourceTextures"]=scene.textures.iter().enumerate().map(|(id,t)|serde_json::json!({"id":id,"name":t.name,"width":t.width,"height":t.height,"role":t.role,"usage":t.usage})).collect();
    // All backend and profile checks precede publication. A rejected cook leaves an old pack intact.
    let temporary = a
        .output
        .with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temporary, &artifact.bytes).unwrap_or_else(|e| fail(e));
    std::fs::rename(&temporary, &a.output).unwrap_or_else(|e| fail(e));
    let report_path = cli
        .iter()
        .position(|s| s == "--report")
        .and_then(|i| cli.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| a.output.with_extension("compile.json"));
    if let Some(parent) = report_path.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|e| fail(e));
    }
    std::fs::write(&report_path, serde_json::to_vec_pretty(&report).unwrap())
        .unwrap_or_else(|e| fail(e));
    if a.target == ir::Target::Psp {
        std::fs::write(
            a.output.with_extension("json"),
            serde_json::to_vec_pretty(&artifact.summary).unwrap(),
        )
        .unwrap();
    }
    std::fs::write(a.output.with_extension("log"), log.join("\n") + "\n").unwrap();
    if cli.iter().any(|s| s == "--json") {
        println!("{}", serde_json::to_string(&report).unwrap());
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&artifact.summary).unwrap()
        );
        println!(
            "wrote {} ({} bytes); report {}",
            a.output.display(),
            artifact.bytes.len(),
            report_path.display()
        );
    }
}
