# Pocket3D driving domain

This crate is the portable gameplay part of Pocket Atlas's driving compiler/runtime. It contains no GPU, scene graph, file transport or platform API. Route assets and the TypeScript reference use the same versioned JSON contract; the cooker validates routes before packaging, and each frontend supplies input and renders `DriveState`.

- World frame: metres, +X east, −Z north. Vehicle forward is local −Z; `yaw` is a Three.js Y rotation. `sample_route` returns a unit tangent; projected `lateral` is positive on the road's right.
- `step_drive` consumes a bounded variable delta and runs 1/60 s steps. A frame stall advances at most 250 ms. Inputs are throttle/brake 0–1, steering −1–1 (positive right), reverse gear, interact and recover. Reverse first brakes the existing forward motion.
- The planar bicycle model has finite snow tyre lateral acceleration, speed-sensitive steering, lateral velocity, drag in the shoulder and colliding snowbank boundaries. Height follows the surveyed route. This is an approachable driving model, not a tyre/engine certification model; scenery objects outside the road corridor do not become individual physics objects.
- Missions use ordered delivery/service/finish stops. Interact requires low speed and physical proximity. Service refills fuel and repairs damage. Finish freezes the completed run. Safe progress creates checkpoints every 250 m, bounded by the pending stop. Recovery returns to the last checkpoint, supplies reserve fuel/repair and adds a 180 s penalty, preventing a softlock.
- `DriveState` serializes using camelCase to match TypeScript. `restore_state` checks route identity, finite values, bounds, mission/penalty consistency, road proximity and velocity. Frontends own atomic save IO and restart UI; rejected saves restart via `initial_state`. Route IDs are lowercase slugs suitable for save filenames.

The replay oracle accepts `{ "route": ..., "state": optionalSave, "steps": [{ "input": ..., "dt": 0.016666666666666666, "frames": 1 }], "trace": false }` on stdin and emits `{ "state": ... }`. With `trace:true`, it also returns a state after each step block. Input is capped at 64 MiB and ten million frames.

```sh
cargo test -p pocket3d-drive
bun test web/src/places/shared/drive/simulation.test.ts
cargo run --quiet -p pocket3d-drive --bin drive-oracle < replay.json
```

The Bun suite drives the full surveyed Furano–Biei mission through ordinary controller inputs, save/restores all mission checkpoints, then replays the identical inputs in Rust and compares every state field. Additional tests cover transformed routes, steering/collision/reverse, empty-fuel recovery, malformed saves and 30/60 Hz invariance. These are host simulation checks; they do not measure device graphics timing or physical control feel.
