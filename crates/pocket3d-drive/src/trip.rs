//! The trip (web `routes/shared/drive/trip.ts`): one drive from the route's
//! first stop to its last. Reaching a stop is remembered, so a trip can
//! resume from it.

use crate::vehicle::Car;

#[derive(Clone, Debug)]
pub struct Stop {
    pub name: String,
    pub native: String,
    /// Arc length on the driven line (m).
    pub s: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TripPhase {
    Ready,
    Driving,
    Arrived,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TripEvent {
    Stop(usize),
    Arrived,
}

#[derive(Clone, Copy, Debug)]
pub struct Trip {
    pub phase: TripPhase,
    /// The last stop reached (0: the start).
    pub reached: usize,
    /// Seconds at the wheel and metres driven.
    pub seconds: f64,
    pub metres: f64,
    /// Times the body met a bank.
    pub scrapes: u32,
    /// Fastest speed (m/s).
    pub top: f64,
}

/// How close to a stop counts as reaching it (m).
const NEAR: f64 = 30.0;

impl Trip {
    pub fn new(reached: usize) -> Self {
        Self { phase: TripPhase::Ready, reached, seconds: 0.0, metres: 0.0, scrapes: 0, top: 0.0 }
    }

    /// Advances the trip with the car's state; at most one event per stop passed.
    pub fn step(&mut self, c: &Car, stops: &[Stop], dt: f64, moved: f64, scraped: bool, events: &mut Vec<TripEvent>) {
        if self.phase == TripPhase::Arrived {
            return;
        }
        if self.phase == TripPhase::Ready && c.vx.abs() > 0.3 {
            self.phase = TripPhase::Driving;
        }
        if self.phase != TripPhase::Driving {
            return;
        }
        self.seconds += dt;
        self.metres += moved;
        self.top = self.top.max(c.vx.abs());
        if scraped {
            self.scrapes += 1;
        }
        let last = stops.len() - 1;
        while self.reached < last && c.s >= stops[self.reached + 1].s - NEAR {
            self.reached += 1;
            if self.reached == last {
                self.phase = TripPhase::Arrived;
                events.push(TripEvent::Arrived);
            } else {
                events.push(TripEvent::Stop(self.reached));
            }
        }
    }
}

/// The stop ahead of an arc length and the metres to it.
pub fn next_stop(stops: &[Stop], s: f64) -> (usize, f64) {
    for (i, st) in stops.iter().enumerate() {
        if st.s > s + 1.0 {
            return (i, st.s - s);
        }
    }
    (stops.len() - 1, 0.0)
}
