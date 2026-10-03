//! The simulation of a route, as every device runs it: the driven line, the
//! car on it, the trip from stop to stop and the driving cameras. It is the
//! handheld port of the web reference (`web/src/routes/shared/line.ts` and
//! `drive/*.ts`), statement for statement and in f64 like JavaScript's
//! numbers; `tests/vehicle-trace.json` (written by the web's
//! `scripts/vehicle-trace.ts`) is a drive both must reproduce.
//!
//! No rendering, no I/O and no dependencies: a runtime feeds it the pad and
//! reads back where the car and the camera are.

pub mod autopilot;
pub mod chase;
pub mod line;
pub mod sound;
pub mod traffic;
pub mod trip;
pub mod vehicle;

pub use autopilot::autopilot;
pub use chase::{Chase, DriveView, Eye};
pub use line::{Line, LinePoint, Projection};
pub use sound::{drive_sound, DriveSound};
pub use traffic::{Traffic, TrafficCar, TRAFFIC_BODIES, TRAFFIC_CARS};
pub use trip::{next_stop, Stop, Trip, TripEvent, TripPhase};
pub use vehicle::{Car, Controls, Spec};
