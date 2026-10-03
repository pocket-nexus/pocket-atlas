//! Renderer-independent driving domain. f64 and fixed steps match the three.js reference.
//! This crate owns vehicle/mission state, not device/GPU abstractions or assets.
use serde::{Deserialize, Serialize};

pub const DRIVE_STEP: f64 = 1.0 / 60.0;
pub const FUEL_CAPACITY: f64 = 40.0;
const WHEELBASE: f64 = 2.43;
const BANK_EDGE: f64 = 5.8;
const LANE_OFFSET: f64 = -1.6;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RoutePoint {
    pub s: f64,
    pub real_m: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StopKind {
    Delivery,
    Service,
    Finish,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RouteStop {
    pub id: String,
    pub name: String,
    pub s: f64,
    pub kind: StopKind,
    pub radius: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Route {
    pub version: u32,
    pub id: String,
    pub title: String,
    pub origin: [f64; 2],
    pub distance_scale: f64,
    pub points: Vec<RoutePoint>,
    pub stops: Vec<RouteStop>,
    pub attribution: String,
}
pub type DriveRoute = Route;

impl Route {
    /// Run at asset/save boundaries; step_drive assumes this has succeeded.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || self.id.is_empty()
            || self.id.len() > 80
            || self.id.starts_with('-')
            || self.id.ends_with('-')
            || self.id.contains("--")
            || !self
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || !self.distance_scale.is_finite()
            || self.distance_scale <= 0.0
            || !self.origin.iter().all(|n| n.is_finite())
            || self.points.len() < 2
            || self.stops.is_empty()
        {
            return Err("invalid route header or missing points/stops".into());
        }
        let (mut previous_s, mut previous_real) = (-1.0, -1.0);
        for (i, p) in self.points.iter().enumerate() {
            if ![p.s, p.real_m, p.x, p.y, p.z].iter().all(|n| n.is_finite())
                || p.s <= previous_s
                || p.real_m <= previous_real
                || (i == 0 && (p.s != 0.0 || p.real_m != 0.0))
                || (i > 0 && (p.x - self.points[i - 1].x).hypot(p.z - self.points[i - 1].z) < 0.001)
            {
                return Err(format!("invalid route point {i}"));
            }
            previous_s = p.s;
            previous_real = p.real_m;
        }
        let mut ids = std::collections::HashSet::new();
        let mut stop_s = -1.0;
        for (i, stop) in self.stops.iter().enumerate() {
            if stop.id.is_empty()
                || !ids.insert(&stop.id)
                || !stop.s.is_finite()
                || stop.s < 0.0
                || stop.s <= stop_s
                || stop.s > previous_s
                || !stop.radius.is_finite()
                || stop.radius < 2.0
                || stop.radius > 100.0
                || (stop.kind == StopKind::Finish) != (i == self.stops.len() - 1)
            {
                return Err(format!("invalid route stop {i}"));
            }
            stop_s = stop.s;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct RouteSample {
    pub s: f64,
    pub real_m: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Unit forward tangent. yaw is a Three.js Y rotation, front is local -Z.
    pub dx: f64,
    pub dz: f64,
    pub yaw: f64,
}
#[derive(Clone, Copy, Debug, Serialize)]
pub struct RouteProjection {
    #[serde(flatten)]
    pub sample: RouteSample,
    pub distance: f64,
    /// Positive to road right.
    pub lateral: f64,
    pub segment: usize,
}
impl std::ops::Deref for RouteProjection {
    type Target = RouteSample;
    fn deref(&self) -> &Self::Target {
        &self.sample
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct DriveInput {
    pub throttle: f64,
    pub brake: f64,
    /// Positive turns right.
    pub steer: f64,
    pub reverse: bool,
    pub interact: bool,
    pub recover: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveState {
    pub version: u32,
    pub route_id: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
    pub speed: f64,
    pub vx: f64,
    pub vz: f64,
    pub steer: f64,
    pub s: f64,
    pub odometer: f64,
    pub elapsed: f64,
    pub fuel: f64,
    pub damage: f64,
    pub next_stop: usize,
    pub completed: bool,
    pub penalty_seconds: f64,
    pub recoveries: u32,
    pub checkpoint_s: f64,
    pub accumulator: f64,
    pub interact_held: bool,
    pub recover_held: bool,
}

fn clamp(n: f64, a: f64, b: f64) -> f64 {
    n.max(a).min(b)
}
fn finite_input(n: f64, a: f64, b: f64) -> f64 {
    if n.is_finite() {
        clamp(n, a, b)
    } else {
        0.0
    }
}
fn wrap(a: f64) -> f64 {
    a.sin().atan2(a.cos())
}
fn approach(a: f64, b: f64, d: f64) -> f64 {
    if a < b {
        (a + d).min(b)
    } else {
        (a - d).max(b)
    }
}

/// Metres from the route centre, positive right. Shared with the scene apron taper.
#[derive(Clone, Copy, Debug)]
pub struct RoadBounds {
    pub left: f64,
    pub right: f64,
    pub cleared_left: f64,
    pub cleared_right: f64,
    pub layby: f64,
}

pub fn road_bounds(route: &Route, s: f64) -> RoadBounds {
    let mut layby: f64 = 0.0;
    for stop in &route.stops {
        layby = layby.max(clamp((44.0 - (s - stop.s).abs()) / 20.0, 0.0, 1.0));
    }
    RoadBounds {
        left: -BANK_EDGE - 7.0 * layby,
        right: BANK_EDGE,
        cleared_left: -(3.3 + 9.5 * layby),
        cleared_right: 3.3,
        layby,
    }
}

fn segment_sample(route: &Route, i: usize, t: f64) -> RouteSample {
    let (a, b) = (&route.points[i], &route.points[i + 1]);
    let len = (b.x - a.x).hypot(b.z - a.z);
    let (dx, dz) = ((b.x - a.x) / len, (b.z - a.z) / len);
    RouteSample {
        s: a.s + (b.s - a.s) * t,
        real_m: a.real_m + (b.real_m - a.real_m) * t,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        dx,
        dz,
        yaw: (-dx).atan2(-dz),
    }
}

pub fn sample_route(route: &Route, s: f64) -> RouteSample {
    let target = clamp(
        if s.is_finite() { s } else { 0.0 },
        0.0,
        route.points.last().unwrap().s,
    );
    let (mut lo, mut hi) = (0, route.points.len() - 1);
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if route.points[mid].s <= target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (a, b) = (&route.points[lo], &route.points[lo + 1]);
    segment_sample(route, lo, (target - a.s) / (b.s - a.s))
}

/// Positive raises a vehicle's local -Z nose; visual pose follows the surveyed road grade.
pub fn route_pitch(route: &Route, s: f64) -> f64 {
    let a = sample_route(route, s - 2.0);
    let b = sample_route(route, s + 2.0);
    (b.y - a.y).atan2((b.x - a.x).hypot(b.z - a.z).max(0.001))
}

pub fn project_route(route: &Route, x: f64, z: f64, hint_s: Option<f64>) -> RouteProjection {
    let search = |hint: Option<f64>| {
        let mut best: Option<RouteProjection> = None;
        for i in 0..route.points.len() - 1 {
            let (a, b) = (&route.points[i], &route.points[i + 1]);
            if let Some(h) = hint {
                if b.s < h - 150.0 || a.s > h + 150.0 {
                    continue;
                }
            }
            let (dx, dz) = (b.x - a.x, b.z - a.z);
            let t = clamp(
                ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz),
                0.0,
                1.0,
            );
            let p = segment_sample(route, i, t);
            let distance = (x - p.x).hypot(z - p.z);
            if best.as_ref().is_none_or(|b| distance < b.distance) {
                best = Some(RouteProjection {
                    sample: p,
                    distance,
                    lateral: (x - p.x) * -p.dz + (z - p.z) * p.dx,
                    segment: i,
                });
            }
        }
        best
    };
    let best = search(hint_s);
    if best.as_ref().is_none_or(|b| b.distance > 50.0) {
        search(None).unwrap()
    } else {
        best.unwrap()
    }
}

pub fn initial_state(route: &Route) -> DriveState {
    route.validate().expect("invalid driving route");
    let p = sample_route(route, 0.0);
    DriveState {
        version: 1,
        route_id: route.id.clone(),
        x: p.x - p.dz * LANE_OFFSET,
        y: p.y,
        z: p.z + p.dx * LANE_OFFSET,
        yaw: p.yaw,
        speed: 0.0,
        vx: 0.0,
        vz: 0.0,
        steer: 0.0,
        s: 0.0,
        odometer: 0.0,
        elapsed: 0.0,
        fuel: 12.0,
        damage: 0.0,
        next_stop: 0,
        completed: false,
        penalty_seconds: 0.0,
        recoveries: 0,
        checkpoint_s: 0.0,
        accumulator: 0.0,
        interact_held: false,
        recover_held: false,
    }
}

fn recover(route: &Route, state: &mut DriveState) {
    let s = state.checkpoint_s.min(
        route
            .stops
            .get(state.next_stop)
            .map_or(state.checkpoint_s, |p| (p.s - 8.0).max(0.0)),
    );
    let p = sample_route(route, s);
    state.x = p.x - p.dz * LANE_OFFSET;
    state.y = p.y;
    state.z = p.z + p.dx * LANE_OFFSET;
    state.yaw = p.yaw;
    state.s = s;
    state.speed = 0.0;
    state.vx = 0.0;
    state.vz = 0.0;
    state.steer = 0.0;
    state.fuel = state.fuel.max(5.0);
    state.damage = state.damage.min(35.0);
    state.penalty_seconds += 180.0;
    state.recoveries += 1;
}

fn fixed_step(route: &Route, state: &mut DriveState, input: &DriveInput) {
    let interact = input.interact && !state.interact_held;
    let recovery = input.recover && !state.recover_held;
    state.interact_held = input.interact;
    state.recover_held = input.recover;
    if state.completed {
        return;
    }
    state.elapsed += DRIVE_STEP;
    if recovery {
        recover(route, state);
        return;
    }
    let before = project_route(route, state.x, state.z, Some(state.s));
    let cleared = road_bounds(route, before.s);
    let offroad = clamp(
        (cleared.cleared_left - before.lateral).max(before.lateral - cleared.cleared_right) / 1.8,
        0.0,
        1.0,
    );
    let throttle = finite_input(input.throttle, 0.0, 1.0);
    let brake = finite_input(input.brake, 0.0, 1.0);
    let steering = finite_input(input.steer, -1.0, 1.0);
    state.steer = approach(state.steer, steering, DRIVE_STEP * 2.2);
    let (forward_x, forward_z) = (-state.yaw.sin(), -state.yaw.cos());
    let (right_x, right_z) = (state.yaw.cos(), -state.yaw.sin());
    let mut longitudinal = state.vx * forward_x + state.vz * forward_z;
    let mut lateral = state.vx * right_x + state.vz * right_z;
    let gear = if input.reverse { -1.0 } else { 1.0 };
    let gear_brake = if longitudinal * gear < -0.25 {
        throttle
    } else {
        0.0
    };
    let engine = if state.fuel > 0.0 && state.damage < 100.0 && gear_brake == 0.0 {
        throttle
            * gear
            * (2.6 - (longitudinal.abs() * 0.06).min(1.8))
            * (1.0 - state.damage * 0.006)
    } else {
        0.0
    };
    let rolling =
        0.17 + 0.0045 * longitudinal * longitudinal + offroad * (1.1 + longitudinal.abs() * 0.28);
    longitudinal += engine * DRIVE_STEP;
    longitudinal = approach(
        longitudinal,
        0.0,
        (rolling + brake.max(gear_brake) * 4.2) * DRIVE_STEP,
    );
    longitudinal = clamp(longitudinal, -7.0, 27.0);
    if longitudinal.abs() < 0.025 && throttle == 0.0 {
        longitudinal = 0.0;
    }
    let wheel_angle = state.steer * 0.48 / (1.0 + longitudinal.abs() * 0.035);
    let requested_yaw_rate = -longitudinal * wheel_angle.tan() / WHEELBASE;
    let grip_acceleration = 3.5 - offroad * 1.9;
    let yaw_rate = clamp(
        requested_yaw_rate,
        -grip_acceleration / longitudinal.abs().max(1.0),
        grip_acceleration / longitudinal.abs().max(1.0),
    );
    lateral = approach(lateral, 0.0, grip_acceleration * DRIVE_STEP);
    state.vx = forward_x * longitudinal + right_x * lateral;
    state.vz = forward_z * longitudinal + right_z * lateral;
    state.yaw = wrap(state.yaw + yaw_rate * DRIVE_STEP);
    let (old_x, old_z) = (state.x, state.z);
    state.x += state.vx * DRIVE_STEP;
    state.z += state.vz * DRIVE_STEP;
    let mut p = project_route(route, state.x, state.z, Some(state.s));
    let bounds = road_bounds(route, p.s);
    let excess = p.lateral - clamp(p.lateral, bounds.left, bounds.right);
    if excess != 0.0 {
        let side = excess.signum();
        let (nx, nz) = (-p.dz * side, p.dx * side);
        let impact = (state.vx * nx + state.vz * nz).max(0.0);
        state.x -= nx * excess.abs();
        state.z -= nz * excess.abs();
        state.vx -= nx * impact * 1.15;
        state.vz -= nz * impact * 1.15;
        state.vx *= 0.72;
        state.vz *= 0.72;
        state.damage = (state.damage + (impact - 0.6).max(0.0) * 3.5).min(100.0);
        p = project_route(route, state.x, state.z, Some(state.s));
    }
    let end_bounds = road_bounds(route, p.s);
    let edge = if p.lateral < 0.0 {
        -end_bounds.left
    } else {
        end_bounds.right
    };
    if p.distance > edge + 1.0 {
        let distance = (state.x - p.x).hypot(state.z - p.z);
        let scale = edge / distance;
        state.x = p.x + (state.x - p.x) * scale;
        state.z = p.z + (state.z - p.z) * scale;
        state.vx *= -0.1;
        state.vz *= -0.1;
    }
    state.speed = state.vx * -state.yaw.sin() + state.vz * -state.yaw.cos();
    state.s = p.s;
    state.y = p.y;
    let travelled = (state.x - old_x).hypot(state.z - old_z);
    state.odometer += travelled;
    state.fuel =
        (state.fuel - (travelled * 0.00012 + DRIVE_STEP * 0.00008) * (1.0 + offroad)).max(0.0);
    if let Some(pending) = route.stops.get(state.next_stop) {
        if state.speed.abs() < 0.75 && state.vx.hypot(state.vz) < 0.9 && interact {
            let target = sample_route(route, pending.s);
            if (state.x - target.x).hypot(state.z - target.z) <= pending.radius {
                if pending.kind == StopKind::Service {
                    state.fuel = FUEL_CAPACITY;
                    state.damage = 0.0;
                }
                state.next_stop += 1;
                state.checkpoint_s = pending.s;
                if pending.kind == StopKind::Finish {
                    state.completed = true;
                    state.speed = 0.0;
                    state.vx = 0.0;
                    state.vz = 0.0;
                }
            }
        }
    }
    let next = route.stops.get(state.next_stop);
    let checkpoint = (state.s / 250.0).floor() * 250.0;
    if p.lateral.abs() < 3.0
        && checkpoint > state.checkpoint_s
        && next.is_none_or(|n| checkpoint < n.s - 8.0)
    {
        state.checkpoint_s = checkpoint;
    }
}

/// Bounded variable-dt wrapper. Wall-clock stalls advance at most 250 ms.
pub fn step_drive(route: &Route, state: &mut DriveState, input: &DriveInput, dt: f64) {
    if !dt.is_finite() || dt <= 0.0 {
        return;
    }
    state.accumulator += dt.min(0.25);
    while state.accumulator + 1e-12 >= DRIVE_STEP {
        fixed_step(route, state, input);
        state.accumulator = (state.accumulator - DRIVE_STEP).max(0.0);
    }
}

impl DriveState {
    pub fn validate(&self, route: &Route) -> bool {
        if route.validate().is_err() {
            return false;
        }
        let s = self;
        let fields = [
            s.x,
            s.y,
            s.z,
            s.yaw,
            s.speed,
            s.vx,
            s.vz,
            s.steer,
            s.s,
            s.odometer,
            s.elapsed,
            s.fuel,
            s.damage,
            s.penalty_seconds,
            s.checkpoint_s,
            s.accumulator,
        ];
        if s.version != 1 || s.route_id != route.id || !fields.iter().all(|n| n.is_finite()) {
            return false;
        }
        let end = route.points.last().unwrap().s;
        if s.s < 0.0
            || s.s > end
            || s.checkpoint_s < 0.0
            || s.checkpoint_s > end
            || s.odometer < 0.0
            || s.elapsed < 0.0
            || s.fuel < 0.0
            || s.fuel > FUEL_CAPACITY
            || s.damage < 0.0
            || s.damage > 100.0
            || s.steer.abs() > 1.0
            || s.yaw.abs() > std::f64::consts::PI + 1e-9
            || s.speed.abs() > 28.0
            || s.vx.hypot(s.vz) > 29.0
            || s.accumulator < 0.0
            || s.accumulator >= DRIVE_STEP
            || s.penalty_seconds < 0.0
            || s.next_stop > route.stops.len()
            || s.completed != (s.next_stop == route.stops.len())
            || s.penalty_seconds != s.recoveries as f64 * 180.0
        {
            return false;
        }
        let p = project_route(route, s.x, s.z, Some(s.s));
        let bounds = road_bounds(route, p.s);
        let edge = if p.lateral < 0.0 {
            -bounds.left
        } else {
            bounds.right
        };
        !(p.lateral < bounds.left - 0.15
            || p.lateral > bounds.right + 0.15
            || p.distance > edge + 1.1
            || (p.s - s.s).abs() > 1.0
            || (p.y - s.y).abs() > 1.0
            || (s.speed - (s.vx * -s.yaw.sin() + s.vz * -s.yaw.cos())).abs() > 0.01
            || (s.next_stop < route.stops.len() && s.checkpoint_s > route.stops[s.next_stop].s)
            || (s.next_stop > 0 && s.checkpoint_s < route.stops[s.next_stop - 1].s)
            || (s.completed
                && (s.s - route.stops.last().unwrap().s).abs()
                    > route.stops.last().unwrap().radius + 1.0))
    }
}

pub fn restore_state(route: &Route, value: serde_json::Value) -> Option<DriveState> {
    let state: DriveState = serde_json::from_value(value).ok()?;
    state.validate(route).then_some(state)
}

#[cfg(test)]
mod tests;
