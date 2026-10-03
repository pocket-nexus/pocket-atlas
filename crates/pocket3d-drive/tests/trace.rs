//! Replays the web reference's drive (`web/scripts/vehicle-trace.ts`): the
//! same controls, frame by frame, must put the car, the trip and the camera
//! where the web put them.

use pocket3d_drive::{Car, Chase, Controls, DriveView, Line, Spec, Stop, Trip};
use serde_json::Value;

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

#[test]
fn reproduces_the_web_drive() {
    let t: Value = serde_json::from_str(include_str!("vehicle-trace.json")).unwrap();
    let l = &t["line"];
    let col = |k: &str| l[k].as_array().unwrap().iter().map(f).collect::<Vec<f64>>();
    let n = l["x"].as_array().unwrap().len();
    let line = Line::new(col("x"), col("y"), col("z"), vec![f(&l["half"]) as f32; n]).unwrap();
    let s = &t["spec"];
    let k = Spec {
        mass: f(&s["mass"]),
        inertia: f(&s["inertia"]),
        wheelbase: f(&s["wheelbase"]),
        front: f(&s["front"]),
        rear: f(&s["rear"]),
        half_width: f(&s["halfWidth"]),
        wheel_radius: f(&s["wheelRadius"]),
        power: f(&s["power"]),
        force: f(&s["force"]),
        brake: f(&s["brake"]),
        engine_brake: f(&s["engineBrake"]),
        rolling: f(&s["rolling"]),
        drag: f(&s["drag"]),
        stiffness_front: f(&s["stiffnessFront"]),
        stiffness_rear: f(&s["stiffnessRear"]),
        lock: f(&s["lock"]),
        steer_rate: f(&s["steerRate"]),
        steer_speed: f(&s["steerSpeed"]),
        top: f(&s["top"]),
        reverse: f(&s["reverse"]),
    };
    let stops: Vec<Stop> = t["stops"].as_array().unwrap().iter().map(|s| Stop { name: String::new(), native: String::new(), s: f(s) }).collect();
    let dt = f(&t["dt"]);
    let mut car = Car::start(&line, 12.0, -1.7);
    let mut trip = Trip::new(0);
    let mut chase = Chase::default();
    let mut events = Vec::new();
    let mut frames = t["frames"].as_array().unwrap().iter();
    let mut want = frames.next();
    let mut worst = 0.0f64;
    for (i, input) in t["inputs"].as_array().unwrap().iter().enumerate() {
        let c = Controls { steer: f(&input[0]), throttle: f(&input[1]), brake: f(&input[2]) };
        let before = car.odometer;
        car.step(&c, &line, dt, &k);
        trip.step(&car, &stops, dt, car.odometer - before, car.scrape == 0.0 && car.impact > 1.5, &mut events);
        let eye = chase.step(&car, DriveView::Chase, dt);
        let Some(w) = want else { break };
        if f(&w[0]) as usize != i {
            continue;
        }
        let got = [car.x, car.z, car.y, car.heading, car.vx, car.vy, car.yaw_rate, car.steer, car.s, car.d, car.odometer, trip.reached as f64, trip.scrapes as f64, trip.metres, eye.pos[0], eye.pos[1], eye.pos[2], eye.fov, if car.reverse { 1.0 } else { 0.0 }];
        for (k, g) in got.iter().enumerate() {
            let e = (g - f(&w[k + 1])).abs();
            worst = worst.max(e);
            // The same arithmetic in the same order: only the maths libraries differ.
            assert!(e < 1e-6, "frame {i}, column {k}: {g} against the web's {}", f(&w[k + 1]));
        }
        want = frames.next();
    }
    assert!(want.is_none(), "the trace has frames the replay never reached");
    println!("largest difference from the web reference: {worst:.6}");
}
