# Northbound: Hokkaido Winter Drive

A complete winter parcel journey from Furano to Biei via Route 237. The same authored route, procedural Three.js geometry and material library feed a reference game and a Vita-specific compiled world. The driving domain has no GPU API; neither Atlas nor OpenStrike migrates into a common engine.

## Play

```sh
cd web
bun install --frozen-lockfile
bun run dev -- --port 5197 --strictPort
# http://127.0.0.1:5197/#/place/hokkaido-winter-drive
```

Start or continue the journey, deliver at Nakafurano, refuel/repair at Kamifurano, deliver at Miyama Pass, and complete the final delivery in Biei. The four markers are game-authored stops. Stop within the marker's radius and interact. Missing a delivery requires turning back; subsequent deliveries cannot skip it. Fuel exhaustion or damage remains recoverable. Recovery returns to a safe checkpoint, charges three minutes, and retains completed deliveries.

| Action | Web keyboard | Vita |
| --- | --- | --- |
| Accelerate / brake | W or up / S or down, Space | R / L |
| Steer | A/D or left/right | Left stick |
| Toggle reverse, while stopped | R | Square |
| Deliver / refuel / repair | E | Cross |
| Recover vehicle | Backspace | Circle |
| Cabin / chase camera | C | Triangle |
| Pause | Escape | START |
| Settings / return to Atlas | Atlas button | SELECT |

A standard web gamepad also maps left stick to steering, triggers to accelerate/brake, south face button to start/delivery, west to reverse, north to view, east to recovery, and Start to pause. An idle controller leaves keyboard steering available. Progress saves every ten seconds and at deliveries, pause and exit. The web uses route/version-specific localStorage. Vita uses `ux0:data/pocket-atlas/drive-<route-id>.json` with a validated backup. Both reject incompatible, non-finite or impossible saved states. Completion offers a new journey.

## Geography and fidelity

The road is a consumed OpenStreetMap/OSRM driving route with 469 points, in an east/up/south local frame. The origin is the snapped Furano station approach, 142.390653°E, 43.347256°N. The full projected route is 33,388.198 m; OSRM's geodesic distance is 33,373.2 m. Horizontal distances and road elevations are scaled by 0.7, producing 23,371.739 playable metres. Road/car widths stay life size. HUD destination distances use real kilometres. This yields about 37 minutes in the regression controller's normal-input journey; a player's driving time varies.

Road heights come from 21 GSI DEM10B tiles: 168.90–293.48 m above sea level before scaling and origin subtraction. Nearby terrain relief, individual farm buildings, vegetation, snow depth, service pads and weather are procedural estimates. This is a reconstruction of the route corridor; the first release does not survey every building or connect every side road. No source characters or copied logos are used.

Data provenance and refresh:

```sh
python3 tools/import-drive-route.py
```

The script uses standard Python libraries, caches raw network receipts and DEM tiles in ignored `.pocket-build/research/hokkaido-winter-drive`, and writes the consumed route input under `web/src/places/hokkaido-winter-drive/data/`. Missing elevations fail instead of silently substituting invented values. Existing cached inputs make refresh deterministic; remove only the relevant cache files to request a new source snapshot.

- Route: [OpenStreetMap contributors, ODbL 1.0](https://www.openstreetmap.org/copyright), routed through [OSRM](https://project-osrm.org/docs/v5.22.0/api/).
- Heights: [Geospatial Information Authority of Japan elevation tiles](https://maps.gsi.go.jp/development/ichiran.html), used to generate derived route heights. [GSI content use](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html).
- Landscape context: [Furano landscape plan](https://www.city.furano.hokkaido.jp/fs/6/0/6/9/3/_/keikankeikaku.pdf).
- Winter route context: [Biei Tourism Association, unploughed roads](https://www.biei-hokkaido.jp/en/23634). The selected route follows the main Route 237 corridor.

The consumed OSM-derived route geometry is available under ODbL 1.0; software remains under the repository licence. Source photographs are reference-only and are not shipped textures. Their dated author/licence manifest and contact sheet are research receipts in `.pocket-build/`.

## Compiler and runtime boundaries

`web/src/places/shared/drive/` owns the reference simulation, snowy road/material builders, vehicle and driving stage. `crates/pocket3d-drive` owns the portable native simulation and save contract; its JSON replay oracle tests TypeScript/Rust behavior. Fixed 60 Hz steps, finite lateral grip and bounded accumulated time avoid frame-rate-dependent handling. Vehicles move freely in the road corridor; progress is a road projection, not a rail that moves the car.

The Three.js exporter emits ordinary glTF geometry plus `extras.pocketAtlas.driving = {route, vehicle}`. `vehicle` uses the exporter's final node name. An explicitly `dynamic` node is retained even without recorded animation: a player-controlled vehicle cannot be reduced to an animation loop.

The Vita cooker validates the route, fixes 128 m static cells everywhere along a driving world (instead of growing cells relative to one origin), preserves local LOD precision, and lowers static geometry into independently addressable 512 m spatial pages. Textures and material identity stay global. Root GEOM contains persistent actors. Static draw ranges address their assigned page. Each page contains quantized geometry, its LOD indices, bounds, exact byte length and a checksum. Validation checks exclusive draw ownership and all referenced ranges before pointer arithmetic.

The Vita runtime opens sidecars in a worker, verifies each page, and publishes GPU pointers only after a complete read. A single in-flight page bounds staging memory. Geometry within 700 m is required; 1,000 m is prefetched; eviction has hysteresis and a GXM finish before freeing referenced memory. Driving pauses if required geometry is unavailable or corrupt, with a visible loading/error message. The compiler rejects pages above 8 MiB and prefetch plans above 64 MiB. `engine.streaming` reports resident bytes/pages, wait frames, evictions and I/O time. These are residency facts, not frame-time claims.

`winter-road` uses an overcast cloud panorama, sky-only HDR probe, baked sky occlusion, textured slush/ice, irregular snowbanks and snow-loaded foliage. Native moving lights normally stop outside the detail-map range on dry baked surfaces; the generic material annotation `dynamicLights: true` explicitly retains headlights on roads and cleared shoulders without adding wet-surface shading.

Two shared GXM particle batches contain 2,400 flakes (1,200 near / 800 middle / 400 far) and 240 local puffs (160 tyre powder / 48 cold exhaust / 32 headlight mist). Wind gusts and apparent velocity stretch flakes; warm cone scattering follows the car. Cabin volume rejects indoor flakes. Their bounded cost is 5,280 triangles and 454,080 bytes, with no added texture or fullscreen transparency layer. `settings.fx` bits 16 and 32 isolate snowfall and vehicle plumes for profiling. These are counts, not GPU timing.

Car body and cabin follow the sampled road grade; wheels roll/steer in both runtimes, and one small alpha contact patch anchors the tyres. Tapered left-side stop aprons use the same `roadBounds` as collision, offroad drag and save validation. Native engine/tyre/wind synthesis uses one 48 kHz stereo audio port with atomic controls and a joined worker. Common GXM, Vita transport, host and packaging remain thin and unchanged in the PocketJS submodule.

Pack version is **7**. Re-cook existing `.place` and `atlas.pack` files before using this renderer. A route's `.place.pages/` directory is part of the asset, never optional; sync and VPK staging validate and include it. PSP/3DS have explicit unsupported-domain guards, and their catalog/build tools exclude this web/Vita work until those targets have their own driving compiler/runtime.

## Build and verify

```sh
# Shared web server running on 5197
(cd web && bun scripts/export-place.ts --place hokkaido-winter-drive --seconds 0.1 --base http://127.0.0.1:5197)
bun tools/atlas.ts cook --place hokkaido-winter-drive
bun tools/atlas.ts build --place hokkaido-winter-drive
cargo test --workspace
bun test tools/drive-assets.test.ts web/src/places/shared/drive/simulation.test.ts
(cd web && bun run build)
(cd web && bun scripts/check-drive.ts http://127.0.0.1:5197)
bun tools/atlas.ts lint

# When this task owns the connected Vita and its USB host:
bun tools/atlas.ts serve
bun tools/atlas.ts native --place hokkaido-winter-drive
bun tools/atlas.ts ctl '{"place":"hokkaido-winter-drive","drive":{"paused":false}}'
bun tools/atlas.ts status
```

A debug control's `drive.input` uses `{throttle,brake,steer,reverse,interact,recover}`; absent inputs return control to the physical pad. `drive.paused`, `drive.cockpit` and `drive.restart` support reproducible acceptance. A pinned `view` pauses driving and requests pages around the inspection camera. Stream errors remain visible and stop simulation.

Only one USB host owns the console. `--share /absolute/path/to/share` selects an already-running host's share; switching its runtime still interrupts its current work. Measurement refuses stale status and waits for both shader compilation and required geometry pages.

GPU measurements must include the car and its effects at the measured location. In USB debug builds, `drive.inspect: {s, speed}` applies a temporary render pose while preserving the player's state and save bytes; the next control without `inspect` restores live play. Exported route shots carry `driveS`, so `profile` and `sweep` set that pose automatically (default speed 12 m/s). `--drive-at` overrides station and `--drive-speed 0` tests idle exhaust. Static remote cameras alone would omit the car and understate cost. `shots` rejects driving works because their gameplay camera does not run the cinematic rig.

```sh
bun tools/atlas.ts sweep --place hokkaido-winter-drive --steps 1 --drive-speed 12
bun tools/atlas.ts profile --place hokkaido-winter-drive --shot Miyama --time 25 --drive-speed 12
bun tools/atlas.ts profile '{"fx":0}' --place hokkaido-winter-drive --shot Miyama --time 25 --drive-speed 12
# Repeat all five stations, stationary/moving, and a live cabin camera.
```

For release packaging, follow the existing Atlas workflow: generate the preview and atlas, cook the font/catalog, visit the atlas and every packaged place on Vita until shader compilation reaches zero pending, then `bun tools/atlas.ts vpk --place hokkaido-winter-drive`. A successful native build alone is not an offline-ready release: the package requires the compiled GXP manifest.

## Acceptance evidence

The full-route host replay performs 134,286 normal 1/60 s simulation steps, stops and interacts at all four locations, validates checkpoint reloads, and finishes in 2,238.1 simulation seconds with zero damage and zero recoveries. Native Rust consumes the same replay; maximum compared numeric drift is below 2.4e-8. Smaller regression routes cover two coordinate frames, braking/reverse, bank collisions, unrecoverable-looking fuel/damage states, save rejection, and 30/60 Hz equivalence.

The enriched host cook produces 225 spatial pages with a 20.61 MiB peak preload (32 m samples, layby margin and GPU allocation alignment included), 0.36 MiB persistent geometry and a 19.0 MiB root pack. Sky-occlusion refinement gives 3.72 million whole-world triangles before runtime LOD/culling. These whole-world totals are not visible-frame totals. Geometry checks sampled 15,988 road/apron positions without snow-bank obstruction. The browser input check covers acceleration, neutral-gamepad keyboard steering, brakes, a moving cabin view and exact save/reload, with bounded chunk residency and no console errors.

Evidence levels remain separate: host simulation/build and shader lint; actual Vita SceShaccCg compilation; GPU timing; physical control/visual/audio acceptance. The 30 fps and Atlas-quality handheld targets require the last three. Temporary exports, raw data, captures, replay traces, binaries and receipts stay in `.pocket-build/` or `dist/` and are not source assets.
