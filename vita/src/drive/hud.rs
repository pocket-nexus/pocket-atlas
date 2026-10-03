//! The driving display (web `routes/shared/hud.ts`): speed and the limit,
//! the next stop and the distance to it, the trip's progress along the
//! route, the local time of the drive, notices, and the cards at departure,
//! on pause and on arrival. Display pixels, 960 × 544.

use pocket3d_drive::{Stop, Trip, TripPhase};

use crate::gpu::Gpu;
use crate::ui::{accent, alpha, rgb, Button, Style, Ui, T};

pub struct State<'a> {
    pub kmh: f32,
    /// Speed limit (km/h), 0 when unknown.
    pub limit: f32,
    pub s: f32,
    pub length: f32,
    pub stops: &'a [Stop],
    pub next: usize,
    pub metres: f32,
    /// Local hour and minute of the drive.
    pub clock: (u32, u32),
    /// A stop just reached: name, native name, seconds left on screen.
    pub notice: Option<(&'a str, &'a str, f32)>,
    pub trip: &'a Trip,
    pub paused: bool,
    pub phase_time: f32,
    pub reverse: bool,
    pub accent: [f32; 3],
    /// Cells still to arrive around the car.
    pub loading: usize,
}

const W: f32 = 960.0;
const H: f32 = 544.0;
const MARGIN: f32 = 36.0;

fn distance(m: f32) -> String {
    if m >= 1000.0 {
        format!("{:.1} km", m / 1000.0)
    } else {
        format!("{} m", ((m / 10.0).round() * 10.0) as u32)
    }
}

/// # Safety
/// Inside the display scene.
pub unsafe fn draw(ui: &Ui, gpu: &mut Gpu, st: &State) {
    let white = |a: f32| rgb(0xf2f5f9, a);
    let grey = |a: f32| rgb(0xb4bdc9, a);
    let acc = |a: f32| accent(st.accent, a);

    // ---- speed, bottom right
    let base = H - 78.0;
    let right = W - MARGIN;
    let unit = ui.width(T::Label, "KM/H");
    ui.text_shadow(gpu, right - unit, base, grey(0.9), T::Label, "KM/H");
    let speed = format!("{}", st.kmh.round() as u32);
    let sw = ui.width(T::Brand, &speed);
    ui.text_shadow(gpu, right - unit - 10.0 - sw, base, white(1.0), T::Brand, &speed);
    if st.reverse {
        ui.text_shadow(gpu, right - unit - 10.0 - sw - 26.0, base, acc(1.0), T::Strong, "R");
    }
    if st.limit > 0.0 {
        // The limit as its road sign: a red ring on white.
        let (cx, cy, r) = (right - 19.0, base - 58.0, 19.0);
        ui.rect(gpu, cx - r, cy - r, r * 2.0, r * 2.0, &Style::fill(r, rgb(0xf4f4f1, 0.96)).stroke(4.0, rgb(0xd6312b, 1.0)));
        let l = format!("{}", st.limit as u32);
        let lw = ui.width(T::Small, &l);
        ui.text(gpu, cx - lw * 0.5, cy + 5.5, rgb(0x1c2a55, 1.0), T::Small, &l);
    }

    // ---- next stop, bottom left
    let stop = &st.stops[st.next.min(st.stops.len() - 1)];
    ui.rect(gpu, MARGIN, base - 62.0, 1.5, 66.0, &Style::fill(0.0, acc(0.8)));
    ui.text_shadow(gpu, MARGIN + 14.0, base - 48.0, grey(0.9), T::Label, "NEXT");
    ui.text_shadow(gpu, MARGIN + 14.0, base - 22.0, white(1.0), T::Title, &ui.fit(T::Title, &stop.name, 360.0));
    let nw = ui.text_shadow(gpu, MARGIN + 14.0, base, grey(0.95), T::Caption, &ui.fit(T::Caption, &stop.native, 220.0));
    ui.text_shadow(gpu, MARGIN + 14.0 + nw + 12.0, base, acc(1.0), T::Small, &distance(st.metres));

    // ---- progress along the route
    let (bx, bw, by) = (MARGIN, W - MARGIN * 2.0, H - 44.0);
    ui.rect(gpu, bx, by, bw, 2.0, &Style::fill(1.0, white(0.28)));
    for s in st.stops {
        let x = bx + bw * (s.s as f32 / st.length).clamp(0.0, 1.0);
        ui.rect(gpu, x - 1.0, by - 3.0, 2.0, 8.0, &Style::fill(0.0, white(0.75)));
    }
    let x = bx + bw * (st.s / st.length).clamp(0.0, 1.0);
    ui.rect(gpu, x - 9.0, by - 8.0, 18.0, 18.0, &Style::fill(9.0, acc(0.25)));
    ui.rect(gpu, x - 5.0, by - 4.0, 10.0, 10.0, &Style::fill(5.0, acc(1.0)));

    // ---- clock, top right
    ui.text_right(gpu, right, 46.0, grey(0.9), T::Small, &format!("{:02}:{:02}", st.clock.0, st.clock.1));

    // ---- a stop reached
    if let Some((name, native, left)) = st.notice {
        let o = (left / 0.6).min(1.0).min(1.0);
        let line = if native.is_empty() { name.to_string() } else { format!("{name}  ·  {native}") };
        let w = ui.width(T::Strong, &line) + 44.0;
        ui.rect(gpu, (W - w) * 0.5, 84.0, w, 40.0, &Style::fill(20.0, rgb(0x080c12, 0.6 * o)).stroke(1.0, white(0.12 * o)));
        ui.text(gpu, (W - w) * 0.5 + 22.0, 110.0, white(o), T::Strong, &line);
    }

    // ---- cards
    let card = |gpu: &mut Gpu, h: f32, o: f32| -> (f32, f32) {
        let (w, x, y) = (460.0, (W - 460.0) * 0.5, (H - h) * 0.5 - 14.0);
        ui.shadow(gpu, x, y, w, h, 18.0, 30.0, 0.5 * o);
        ui.rect(gpu, x, y, w, h, &Style::gradient(18.0, rgb(0x161a24, 0.86 * o), rgb(0x0c0e14, 0.9 * o)).stroke(1.0, white(0.12 * o)));
        (x, y)
    };
    let first = &st.stops[0];
    let last = &st.stops[st.stops.len() - 1];
    if st.paused {
        let (x, y) = card(gpu, 190.0, 1.0);
        ui.text(gpu, x + 28.0, y + 44.0, grey(0.9), T::Label, "PAUSED");
        ui.text(gpu, x + 28.0, y + 78.0, white(1.0), T::Title, &ui.fit(T::Title, &format!("{} → {}", first.name, last.name), 404.0));
        ui.text(gpu, x + 28.0, y + 104.0, grey(0.95), T::Caption, &format!("{} of {:.1} km", distance(st.s), st.length / 1000.0));
        let mut hx = x + 28.0;
        hx += ui.hint(gpu, hx, y + 150.0, &[Button::Cross], "Drive on", 1.0) + 18.0;
        hx += ui.hint(gpu, hx, y + 150.0, &[Button::Square], "Back to the last stop", 1.0) + 18.0;
        ui.hint(gpu, hx, y + 150.0, &[Button::Circle], "Atlas", 1.0);
    } else if st.trip.phase == TripPhase::Ready {
        let o = (st.phase_time / 0.8).min(1.0);
        let (x, y) = card(gpu, 196.0, o);
        ui.text(gpu, x + 28.0, y + 44.0, alpha(acc(1.0), o), T::Label, "ROUTE");
        ui.text(gpu, x + 28.0, y + 78.0, white(o), T::Title, &ui.fit(T::Title, &format!("{} → {}", first.name, last.name), 404.0));
        ui.text(gpu, x + 28.0, y + 104.0, grey(0.95 * o), T::Caption, &ui.fit(T::Caption, &format!("{} → {}  ·  {:.1} km", first.native, last.native, st.length / 1000.0), 404.0));
        if st.loading > 0 {
            ui.text(gpu, x + 28.0, y + 160.0, grey(0.8 * o), T::Caption, &format!("Clearing the road… {}", st.loading));
        } else {
            let mut hx = x + 28.0;
            hx += ui.hint(gpu, hx, y + 154.0, &[Button::R, Button::Cross], "Drive", o) + 18.0;
            hx += ui.hint(gpu, hx, y + 154.0, &[Button::L, Button::Square], "Brake", o) + 18.0;
            ui.hint(gpu, hx, y + 154.0, &[Button::Triangle], "View", o);
        }
    } else if st.trip.phase == TripPhase::Arrived {
        let o = ((st.phase_time - 1.0) / 1.0).clamp(0.0, 1.0);
        let (x, y) = card(gpu, 270.0, o);
        ui.text(gpu, x + 28.0, y + 44.0, alpha(acc(1.0), o), T::Label, "ARRIVED");
        ui.text(gpu, x + 28.0, y + 78.0, white(o), T::Title, &ui.fit(T::Title, &last.name, 404.0));
        ui.text(gpu, x + 28.0, y + 102.0, grey(0.95 * o), T::Caption, &last.native);
        let t = st.trip;
        let rows = [
            ("Distance", format!("{:.1} km", t.metres / 1000.0)),
            ("Time", format!("{}:{:02}", (t.seconds / 60.0) as u32, (t.seconds % 60.0) as u32)),
            ("Average", format!("{:.0} km/h", t.metres / t.seconds.max(1.0) * 3.6)),
            ("Top speed", format!("{:.0} km/h", t.top * 3.6)),
            ("Snowbank touches", format!("{}", t.scrapes)),
        ];
        for (k, (label, value)) in rows.iter().enumerate() {
            let ry = y + 136.0 + k as f32 * 22.0;
            ui.text(gpu, x + 28.0, ry, grey(0.9 * o), T::Caption, label);
            ui.text_right(gpu, x + 432.0, ry, white(o), T::Small, value);
        }
        ui.hint(gpu, x + 28.0, y + 248.0, &[Button::Circle], "Back to the atlas", o);
    }
}
