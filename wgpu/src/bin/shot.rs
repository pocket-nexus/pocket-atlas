//! A frame of the atlas screen written to a file, on the build machine: the
//! globe of the browser tab on this machine's GPU, with no interface over it.
//!
//!   atlas-shot --globe globe.rgba --out frame.png [--shape ipod] [--size 480x320] [--logical 480x320]
//!              [--samples 4] [--at 130,160,100] [--face 35.68,139.72] [--pin 1]
//!              [--pins "35.710,139.811,4fe3c1;34.118,-118.300,7f8cff"] [--status status.json]
//!   atlas-shot --place PACK --out frame.png [--shape vita] [--size 960x544] [--samples 4] [--shot 0]
//!              [--part 0.5] [--time 25] [--frames 4] [--tour SECONDS] [--status status.json]
//!   atlas-shot --compare a.png b.png [--inside x,y,w,h]
//!
//! `--globe` names the surface `tools/atlas-globe.ts` writes, or the manifest
//! (`.json`) of one cut into pieces. `--at`, `--face`, `--pin` and `--pins` are
//! the interface's `globe` and `pins` commands (`ui/app/protocol.ts`): where
//! the disc sits on the primary screen in logical pixels, the place it faces,
//! the lit pin, every pin. The globe is drawn where it has come to rest.
//!
//! `--place` names a place's pack (the PS Vita's `.place`), or the manifest of one
//! cut into pieces: the frame is the place from its authored shot `--shot`, held
//! at `--part` of its length with the place's loop at `--time` seconds, after
//! every texture has arrived. `--tour` runs the tour for that many seconds
//! instead and draws its last frame.
//!
//! `--compare` says how far two pictures of one size are apart: the mean
//! difference of a colour in 255ths and the share of pixels where a colour
//! differs by more than 16; `--inside` keeps to a rectangle of them.

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    if let Err(e) = native::run() {
        eprintln!("atlas-shot: {e}");
        std::process::exit(1);
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use atlas_wgpu::app::{App, Held, Shape};
    use atlas_wgpu::place::{Opening, Place};
    use atlas_wgpu::places;
    use pocket_atlas_interface::Command;
    use pocket_web_wgpu::gpu::{Gpu, Screen};
    use pocket_web_wgpu::source::Source;
    use pocket_web_wgpu::task;

    fn option(name: &str) -> Option<String> {
        let args: Vec<String> = std::env::args().collect();
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
    }

    /// Numbers separated by `by`: "480x320", "130,160,100".
    fn numbers<const N: usize>(name: &str, by: char) -> Result<Option<[f32; N]>, String> {
        let Some(text) = option(name) else { return Ok(None) };
        let parts: Vec<f32> = text.split(by).filter_map(|part| part.trim().parse().ok()).collect();
        parts.try_into().map(Some).map_err(|_| format!("{name} takes {N} numbers separated by '{by}'"))
    }

    /// A PNG file as rows of RGBA, with its width.
    fn picture(path: &str) -> Result<(Vec<u8>, u32), String> {
        let mut decoder = png::Decoder::new(std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?);
        decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut reader = decoder.read_info().map_err(|e| format!("{path}: {e}"))?;
        let mut bytes = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut bytes).map_err(|e| format!("{path}: {e}"))?;
        bytes.truncate(info.buffer_size());
        let rgba = match info.color_type {
            png::ColorType::Rgba => bytes,
            png::ColorType::Rgb => bytes.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
            png::ColorType::Grayscale => bytes.iter().flat_map(|&g| [g, g, g, 255]).collect(),
            png::ColorType::GrayscaleAlpha => bytes.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
            png::ColorType::Indexed => return Err(format!("{path}: a palette the decoder did not expand")),
        };
        Ok((rgba, info.width))
    }

    /// How far two pictures of one size are apart inside a rectangle of them.
    fn apart(a: &[u8], b: &[u8], width: u32, inside: [u32; 4]) -> (f64, f64) {
        let (mut sum, mut far, mut count) = (0u64, 0u32, 0u32);
        for y in inside[1]..inside[1] + inside[3] {
            for x in inside[0]..inside[0] + inside[2] {
                let at = ((y * width + x) * 4) as usize;
                let d = [0, 1, 2].map(|c| a[at + c].abs_diff(b[at + c]));
                sum += d.iter().map(|&d| d as u64).sum::<u64>();
                far += d.iter().any(|&d| d > 16) as u32;
                count += 1;
            }
        }
        (sum as f64 / (count.max(1) as f64 * 3.0), far as f64 / count.max(1) as f64)
    }

    fn write_png(out: &str, pixels: &[u8], width: u32, height: u32) -> Result<(), String> {
        let file = std::fs::File::create(out).map_err(|e| format!("{out}: {e}"))?;
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().and_then(|mut w| w.write_image_data(pixels)).map_err(|e| format!("{out}: {e}"))
    }

    /// One frame of a place.
    fn place(pack: &str, out: &str) -> Result<(), String> {
        let mut shape = Shape::named(&option("--shape").unwrap_or("vita".into())).ok_or("--shape psp | vita | 3ds | ipod")?;
        if let Some([w, h]) = numbers::<2>("--size", 'x')? {
            (shape.width, shape.height) = (w as u32, h as u32);
        }
        if let Some([samples]) = numbers::<1>("--samples", ',')? {
            shape.samples = samples as u32;
        }
        let number = |name: &str, fallback: f32| numbers::<1>(name, ',').map(|v| v.map_or(fallback, |[v]| v));
        let (shot, part, time, frames) = (number("--shot", 0.0)? as usize, number("--part", 0.5)?, number("--time", 25.0)?, number("--frames", 4.0)? as u32);
        let tour = numbers::<1>("--tour", ',')?.map(|[seconds]| seconds);
        let gpu = task::wait(Gpu::headless_wanting(places::RENDERER.wants))?;
        let screen = Screen::texture(&gpu, shape.width, shape.height, 1);
        let source = task::wait(Source::open(pack))?;
        let mut visit = task::wait(places::visit(Opening { place: pack.to_string(), pack: source.clone(), gpu: gpu.clone(), format: screen.format, shape, needs: Default::default() }))?;
        task::wait(places::settle(&mut visit, &source))?;
        if tour.is_none() && !visit.hold(shot, part, time) {
            return Err(format!("the place has no shot {shot}"));
        }
        let held = Held::default();
        let steps = tour.map_or(frames.max(1), |seconds| (seconds * 30.0) as u32);
        // A frame's cost is the time to record it and for the GPU to finish it. The first frames make the
        // place's pipelines: they are timed apart from the rest.
        let mut times = Vec::with_capacity(steps as usize);
        for _ in 0..steps {
            let began = std::time::Instant::now();
            // (a frame: the place advances a thirtieth of a second, unless its view is held, and is drawn)
            visit.step(if tour.is_some() { 1.0 / 30.0 } else { 0.0 }, &held, true);
            let frame = screen.frame(&gpu)?;
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            visit.draw(&gpu, &mut encoder, &frame)?;
            gpu.queue.submit([encoder.finish()]);
            gpu.device.poll(pocket_web_wgpu::wgpu::PollType::Wait).map_err(|e| e.to_string())?;
            times.push(began.elapsed().as_secs_f32() * 1000.0);
        }
        let pixels = task::wait(screen.read(&gpu))?;
        write_png(out, &pixels, shape.width, shape.height)?;
        let later = &times[times.len().min(8).min(times.len() - 1)..];
        let mut sorted = later.to_vec();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let status = format!("{{{},\"firstFrameMs\":{:.1},\"frameMs\":{:.2},\"frameMsWorst\":{:.2},\"frames\":{},\"adapter\":\"{}\"}}", visit.status(), times[0], sorted[sorted.len() / 2], sorted[sorted.len() - 1], times.len(), gpu.adapter);
        if let Some(path) = option("--status") {
            std::fs::write(&path, &status).map_err(|e| format!("{path}: {e}"))?;
        }
        println!("{status}");
        Ok(())
    }

    pub fn run() -> Result<(), String> {
        if let Some(first) = option("--compare") {
            let second = std::env::args().skip_while(|a| a != "--compare").nth(2).ok_or("--compare A.png B.png")?;
            let ((a, width), (b, other)) = (picture(&first)?, picture(&second)?);
            if a.len() != b.len() || width != other {
                return Err("the two pictures are not of one size".into());
            }
            let height = a.len() as u32 / 4 / width;
            let inside = numbers::<4>("--inside", ',')?.map_or([0, 0, width, height], |r| r.map(|v| v as u32));
            if inside[0] + inside[2] > width || inside[1] + inside[3] > height {
                return Err(format!("--inside reaches outside a picture of {width} by {height}"));
            }
            let (mean, over) = apart(&a, &b, width, inside);
            println!("{{\"mean\":{mean:.3},\"over16\":{over:.4}}}");
            return Ok(());
        }
        let out = option("--out").ok_or("--out PNG")?;
        if let Some(pack) = option("--place") {
            return place(&pack, &out);
        }
        let globe = option("--globe").ok_or("--globe PATH")?;
        let mut shape = Shape::named(&option("--shape").unwrap_or("ipod".into())).ok_or("--shape psp | vita | 3ds | ipod")?;
        if let Some([w, h]) = numbers::<2>("--size", 'x')? {
            (shape.width, shape.height) = (w as u32, h as u32);
        }
        if let Some([w, h]) = numbers::<2>("--logical", 'x')? {
            shape.logical = [w as u32, h as u32];
        }
        if let Some([samples]) = numbers::<1>("--samples", ',')? {
            shape.samples = samples as u32;
        }

        let gpu = task::wait(Gpu::headless())?;
        let screen = Screen::texture(&gpu, shape.width, shape.height, shape.samples);
        let mut app = App::open(gpu, screen, shape, None);
        let source = task::wait(Source::open(&globe))?;
        app.globe_surface(&task::wait(source.all())?)?;
        // The interface's commands, as a guest would send them.
        let at = numbers::<3>("--at", ',')?.unwrap_or(app.turn.place);
        let face = numbers::<2>("--face", ',')?.unwrap_or(app.turn.facing);
        let pin = numbers::<1>("--pin", ',')?.map(|[pin]| pin as usize);
        app.turn.face(at[0], at[1], at[2], face[0], face[1], pin);
        if let Some(list) = option("--pins") {
            match Command::parse(&format!("{{\"type\":\"pins\",\"list\":\"{list}\"}}")) {
                Some(Command::Pins(pins)) => app.turn.pins(&pins),
                _ => return Err("--pins takes \"lat,lon,rrggbb;…\"".into()),
            }
        }
        // (eased: after twenty seconds the globe is where it turns to)
        let held = Held::default();
        for frame in 0..1200 {
            app.step(frame as f64 * 1000.0 / 60.0, &held);
        }
        app.draw()?;
        let pixels = task::wait(app.screen.read(&app.gpu))?;
        let file = std::fs::File::create(&out).map_err(|e| format!("{out}: {e}"))?;
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), shape.width, shape.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().and_then(|mut w| w.write_image_data(&pixels)).map_err(|e| format!("{out}: {e}"))?;
        let status = app.status();
        if let Some(path) = option("--status") {
            std::fs::write(&path, &status).map_err(|e| format!("{path}: {e}"))?;
        }
        println!("{status}");
        Ok(())
    }
}
