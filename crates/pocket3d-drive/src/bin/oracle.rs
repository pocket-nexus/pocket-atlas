//! JSON replay protocol: {route,state?,steps:[{input,dt,frames?}],trace?} on stdin.
use pocket3d_drive::{initial_state, restore_state, step_drive, DriveInput, Route};
use serde::Deserialize;
use std::io::{self, Read};

#[derive(Deserialize)]
struct Replay {
    route: Route,
    state: Option<serde_json::Value>,
    steps: Vec<ReplayStep>,
    #[serde(default)]
    trace: bool,
}
#[derive(Deserialize)]
struct ReplayStep {
    input: DriveInput,
    dt: f64,
    #[serde(default = "one")]
    frames: u32,
}
fn one() -> u32 {
    1
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut json = String::new();
    io::stdin()
        .take(64 * 1024 * 1024)
        .read_to_string(&mut json)?;
    let replay: Replay = serde_json::from_str(&json)?;
    replay.route.validate()?;
    let mut state = match replay.state {
        Some(value) => restore_state(&replay.route, value).ok_or("invalid replay save")?,
        None => initial_state(&replay.route),
    };
    let mut trace = Vec::new();
    let frames: u64 = replay.steps.iter().map(|s| s.frames as u64).sum();
    if frames > 10_000_000 {
        return Err("replay frame budget exceeded".into());
    }
    for step in replay.steps {
        for _ in 0..step.frames {
            step_drive(&replay.route, &mut state, &step.input, step.dt);
        }
        if replay.trace {
            trace.push(state.clone());
        }
    }
    if replay.trace {
        println!("{}", serde_json::json!({"state":state,"trace":trace}));
    } else {
        println!("{}", serde_json::json!({"state":state}));
    }
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("drive-oracle: {e}");
        std::process::exit(1);
    }
}
