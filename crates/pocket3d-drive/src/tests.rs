use super::*;

fn fixture(angle: f64, ox: f64, oz: f64) -> Route {
    let mut points: Vec<RoutePoint> = Vec::new();
    let mut s = 0.0;
    for i in 0..=160 {
        let (x, z) = ((i as f64 / 23.0).sin() * 45.0, -(i as f64) * 10.0);
        let (px, pz) = (
            ox + x * angle.cos() + z * angle.sin(),
            oz - x * angle.sin() + z * angle.cos(),
        );
        if let Some(p) = points.last() {
            s += (px - p.x).hypot(pz - p.z);
        }
        points.push(RoutePoint {
            s,
            real_m: s / 0.7,
            x: px,
            y: (i as f64 / 50.0).sin() * 2.0,
            z: pz,
        });
    }
    Route {
        version: 1,
        id: "test-rural-road".into(),
        title: "Curved rural road".into(),
        origin: [142.0, 43.0],
        distance_scale: 0.7,
        points,
        stops: vec![
            RouteStop {
                id: "parcel".into(),
                name: "Parcel".into(),
                s: 90.0,
                kind: StopKind::Delivery,
                radius: 7.0,
            },
            RouteStop {
                id: "service".into(),
                name: "Service".into(),
                s: 470.0,
                kind: StopKind::Service,
                radius: 7.0,
            },
            RouteStop {
                id: "village".into(),
                name: "Village".into(),
                s: 1050.0,
                kind: StopKind::Delivery,
                radius: 7.0,
            },
            RouteStop {
                id: "end".into(),
                name: "Finish".into(),
                s,
                kind: StopKind::Finish,
                radius: 8.0,
            },
        ],
        attribution: "Test geometry".into(),
    }
}

// Test controller uses public telemetry/input only; it never teleports or changes mission state.
fn controller(route: &Route, state: &DriveState) -> DriveInput {
    let Some(pending) = route.stops.get(state.next_stop) else {
        return DriveInput::default();
    };
    let look = sample_route(route, state.s + 4.0 + state.speed.max(0.0) * 0.55);
    let (tx, tz) = (look.x + look.dz * 1.6, look.z - look.dx * 1.6);
    let desired_yaw = (-(tx - state.x)).atan2(-(tz - state.z));
    let error = wrap(desired_yaw - state.yaw);
    let remaining = pending.s - state.s;
    let target_speed = 12.0f64.min(((remaining - 2.0).max(0.0) * 4.8).sqrt());
    let target = sample_route(route, pending.s);
    let in_range = (state.x - target.x).hypot(state.z - target.z) < pending.radius;
    let stop = in_range && remaining < 4.0;
    DriveInput {
        throttle: if !stop && state.speed < target_speed - 0.1 {
            1.0
        } else {
            0.0
        },
        brake: if stop || state.speed > target_speed + 0.15 {
            0.85
        } else {
            0.0
        },
        steer: clamp(-error * 2.8, -1.0, 1.0),
        interact: in_range && state.speed.abs() < 0.4,
        ..Default::default()
    }
}

#[test]
fn input_controller_completes_curves_jobs_and_service_in_two_coordinate_frames() {
    for route in [fixture(0.0, 0.0, 0.0), fixture(1.7, 4300.0, -8100.0)] {
        let mut state = initial_state(&route);
        let mut saved = false;
        for _ in 0..60 * 250 {
            let input = controller(&route, &state);
            step_drive(&route, &mut state, &input, DRIVE_STEP);
            if !saved && state.next_stop == 2 {
                let value = serde_json::to_value(&state).unwrap();
                state = restore_state(&route, value).expect("checkpoint save should restore");
                saved = true;
            }
            if state.completed {
                break;
            }
        }
        assert!(state.completed, "controller did not finish: {state:?}");
        assert_eq!(state.next_stop, 4);
        assert!(state.s > route.points.last().unwrap().s - 8.0);
        assert!(state.damage < 1.0);
        assert_eq!(state.recoveries, 0);
        assert!(state.odometer > 1500.0 && state.fuel > 35.0 && saved);
        assert!(state.validate(&route));
    }
}

#[test]
fn fixed_step_frame_rate_invariance_and_bounded_resume() {
    let route = fixture(0.0, 0.0, 0.0);
    let (mut a, mut b) = (initial_state(&route), initial_state(&route));
    let input = DriveInput {
        throttle: 1.0,
        ..Default::default()
    };
    for _ in 0..300 {
        step_drive(&route, &mut a, &input, 1.0 / 30.0);
    }
    for _ in 0..600 {
        step_drive(&route, &mut b, &input, 1.0 / 60.0);
    }
    assert_eq!(a, b);
    let before = a.elapsed;
    step_drive(&route, &mut a, &input, 3600.0);
    assert!((a.elapsed - before - 0.25).abs() < 1e-10);
    let copy = a.clone();
    step_drive(&route, &mut a, &input, f64::NAN);
    assert_eq!(a, copy);
}

#[test]
fn empty_fuel_and_total_damage_remain_recoverable_without_skipping_jobs() {
    let route = fixture(0.0, 0.0, 0.0);
    let mut state = initial_state(&route);
    state.fuel = 0.0;
    state.damage = 100.0;
    for _ in 0..120 {
        step_drive(
            &route,
            &mut state,
            &DriveInput {
                throttle: 1.0,
                ..Default::default()
            },
            DRIVE_STEP,
        );
    }
    assert_eq!(state.s, 0.0);
    for _ in 0..90 {
        step_drive(
            &route,
            &mut state,
            &DriveInput {
                recover: true,
                ..Default::default()
            },
            DRIVE_STEP,
        );
    }
    assert_eq!(state.recoveries, 1);
    assert_eq!(state.penalty_seconds, 180.0);
    assert!(state.fuel > 4.9);
    assert_eq!(state.damage, 35.0);
    assert_eq!(state.next_stop, 0);
    assert!(!state.completed);
    assert!(state.validate(&route));
}

#[test]
fn save_roundtrip_and_corrupt_save_rejection() {
    let route = fixture(0.0, 0.0, 0.0);
    let mut state = initial_state(&route);
    for _ in 0..150 {
        step_drive(
            &route,
            &mut state,
            &DriveInput {
                throttle: 1.0,
                ..Default::default()
            },
            DRIVE_STEP,
        );
    }
    let value = serde_json::to_value(&state).unwrap();
    assert_eq!(restore_state(&route, value.clone()).unwrap(), state);
    let edits = [
        ("routeId", serde_json::json!("foreign")),
        ("fuel", serde_json::json!(-1)),
        ("x", serde_json::json!(3000)),
        ("nextStop", serde_json::json!(20)),
        ("completed", serde_json::json!(true)),
        ("checkpointS", serde_json::json!(1000)),
        ("penaltySeconds", serde_json::json!(10)),
        ("speed", serde_json::json!(24)),
    ];
    for (key, edit) in edits {
        let mut invalid = value.clone();
        invalid[key] = edit;
        assert!(
            restore_state(&route, invalid).is_none(),
            "accepted invalid {key}"
        );
    }
    assert!(restore_state(&route, serde_json::json!({})).is_none());
    for id in ["../other", "Route", "a--b", "a/b", "-route", "route-", ""] {
        let mut bad_id = route.clone();
        bad_id.id = id.into();
        assert!(bad_id.validate().is_err(), "accepted unsafe route ID {id}");
    }
    let mut bad_route = route.clone();
    bad_route.points[1] = bad_route.points[0].clone();
    assert!(bad_route.validate().is_err());
    bad_route = route;
    bad_route.stops.reverse();
    assert!(bad_route.validate().is_err());
}
