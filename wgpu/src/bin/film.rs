//! A place filmed on the build machine: the renderer of the browser tab on
//! this machine's GPU, one frame for each line of a list, written to standard
//! output as raw RGBA. `tools/listing.ts` writes the list and hands the frames
//! to ffmpeg.
//!
//!   atlas-film --place PACK --frames LIST [--shape vita] [--size 960x544] [--samples 4] [--rate 30]
//!              [--option exposure=2] > frames.rgba
//!
//! `--place` names a place's pack (the PS Vita's `.place`), or the manifest of
//! one cut into pieces. Every texture has arrived before the first frame.
//!
//! A line of `LIST` is one frame, as words:
//!
//!   time=12.5 shot=0 part=0.25           the authored shot 0 at a quarter of its length,
//!                                        with the tour's sway at that moment
//!   time=12.5 view=x,y,z,tx,ty,tz,fov    any eye, the point it looks at, the vertical field in degrees
//!   dip=0.6                              the picture dipped to black by that much (a cut)
//!
//! `time` is the second of the place's loop the frame shows: its rain, its
//! train, its people. A frame is a function of its line alone, but for what
//! follows the eye over time (a shop's doors), which eases by `1 / --rate`
//! seconds a frame, and for the grain, which follows the count of frames; so
//! the same list gives the same film. The first line is drawn eight times
//! before the film starts: a place's first frames differ from run to run.
//!
//! `--option` sets one of the place's settings by its key in the interface
//! (`bloom`, `haze`, `reflection`, `rain`, `exposure`), and may be repeated.

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    if let Err(e) = native::run() {
        eprintln!("atlas-film: {e}");
        std::process::exit(1);
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use std::io::Write;

    use atlas_wgpu::app::{Held, Shape};
    use atlas_wgpu::place::{Opening, Place};
    use atlas_wgpu::places;
    use atlas_wgpu::places::camera::View;
    use glam::Vec3;
    use pocket_atlas_interface::Command;
    use pocket_web_wgpu::gpu::{Gpu, Screen};
    use pocket_web_wgpu::source::Source;
    use pocket_web_wgpu::task;

    fn options(name: &str) -> Vec<String> {
        let args: Vec<String> = std::env::args().collect();
        args.iter().enumerate().filter(|(_, a)| *a == name).filter_map(|(i, _)| args.get(i + 1).cloned()).collect()
    }

    fn option(name: &str) -> Option<String> {
        options(name).into_iter().next()
    }

    /// Frames drawn and not kept before the first frame of a film.
    const WARM: usize = 8;

    pub fn run() -> Result<(), String> {
        let pack = option("--place").ok_or("--place PACK")?;
        let list = option("--frames").ok_or("--frames LIST")?;
        let list = std::fs::read_to_string(&list).map_err(|e| format!("{list}: {e}"))?;
        let mut shape = Shape::named(&option("--shape").unwrap_or("vita".into())).ok_or("--shape psp | vita | 3ds | ipod")?;
        if let Some(size) = option("--size") {
            let (w, h) = size.split_once('x').ok_or("--size WIDTHxHEIGHT")?;
            (shape.width, shape.height) = (w.parse().map_err(|_| "--size WIDTHxHEIGHT")?, h.parse().map_err(|_| "--size WIDTHxHEIGHT")?);
        }
        if let Some(samples) = option("--samples") {
            shape.samples = samples.parse().map_err(|_| "--samples takes a number")?;
        }
        let rate: f32 = option("--rate").map_or(Ok(30.0), |v| v.parse().map_err(|_| "--rate takes a number"))?;

        let gpu = task::wait(Gpu::headless_wanting(places::RENDERER.wants))?;
        let screen = Screen::texture(&gpu, shape.width, shape.height, 1);
        let source = task::wait(Source::open(&pack))?;
        let mut visit = task::wait(places::visit(Opening { place: pack.clone(), pack: source.clone(), gpu: gpu.clone(), format: screen.format, shape, needs: Default::default() }))?;
        task::wait(places::settle(&mut visit, &source))?;
        for setting in options("--option") {
            let (key, value) = setting.split_once('=').ok_or("--option KEY=NUMBER")?;
            visit.obey(&Command::Option { key: key.to_string(), value: value.parse().map_err(|_| "--option KEY=NUMBER")? });
        }

        let held = Held::default();
        let mut out = std::io::BufWriter::with_capacity(1 << 22, std::io::stdout().lock());
        let mut count = 0u32;
        let lines: Vec<(usize, &str)> = list.lines().map(str::trim).enumerate().filter(|(_, line)| !line.is_empty() && !line.starts_with('#')).collect();
        // The first frames of a place make its pipelines and its targets, and what they show differs from
        // one run to the next: the first line is drawn eight times before the film, and those are not kept.
        let warm = lines.first().map_or(0, |_| WARM);
        for (turn, &(at, line)) in std::iter::repeat_n(lines.first(), warm).flatten().chain(&lines).enumerate() {
            let (mut time, mut dip, mut shot, mut part, mut view) = (0.0f32, 0.0f32, None, 0.0f32, None);
            for word in line.split_whitespace() {
                let (key, value) = word.split_once('=').ok_or(format!("line {}: {word}", at + 1))?;
                let number = |v: &str| v.parse::<f32>().map_err(|_| format!("line {}: {word}", at + 1));
                match key {
                    "time" => time = number(value)?,
                    "dip" => dip = number(value)?,
                    "shot" => shot = Some(number(value)? as usize),
                    "part" => part = number(value)?,
                    "view" => {
                        let n: Vec<f32> = value.split(',').map(number).collect::<Result<_, _>>()?;
                        let [x, y, z, tx, ty, tz, fov] = n[..] else { return Err(format!("line {}: view takes seven numbers", at + 1)) };
                        view = Some(View { pos: Vec3::new(x, y, z), target: Vec3::new(tx, ty, tz), fov_y: fov });
                    }
                    _ => return Err(format!("line {}: {word}", at + 1)),
                }
            }
            let view = match (view, shot) {
                (Some(view), _) => view,
                (None, Some(k)) => {
                    // (the tour's own sway, `Rig::update`)
                    let mut v = visit.shot_view(k, part).ok_or(format!("line {}: the place has no shot {k}", at + 1))?;
                    v.pos.x += (time * 0.53).sin() * 0.025;
                    v.pos.y += (time * 0.71 + 1.3).sin() * 0.018;
                    v
                }
                (None, None) => return Err(format!("line {}: a frame needs shot= or view=", at + 1)),
            };
            visit.film(view, time, dip);
            visit.step(1.0 / rate, &held, true);
            let frame = screen.frame(&gpu)?;
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            visit.draw(&gpu, &mut encoder, &frame)?;
            gpu.queue.submit([encoder.finish()]);
            if turn < warm {
                gpu.device.poll(pocket_web_wgpu::wgpu::PollType::Wait).map_err(|e| e.to_string())?;
                continue;
            }
            let pixels = task::wait(screen.read(&gpu))?;
            out.write_all(&pixels).map_err(|e| e.to_string())?;
            count += 1;
        }
        out.flush().map_err(|e| e.to_string())?;
        eprintln!("{{{},\"filmed\":{count},\"adapter\":\"{}\"}}", visit.status(), gpu.adapter);
        Ok(())
    }
}
