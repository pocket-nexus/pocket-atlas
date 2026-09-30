# Pocket City

A rain-soaked Tokyo backstreet with a 24-hour konbini, picked from a night-side globe. The scene exists twice:

- **`web/`** is the reference renderer: a standalone three.js + Vite app with no PocketJS dependency. Every asset is generated at load time.
- **`vita/`** renders the same scene on a PS Vita with its own GXM pipeline: custom Cg programs compiled on the device by SceShaccCg, 4× MSAA HDR targets, a planar street reflection, lit rain haze, bloom and AgX tone mapping.

The two are connected by a pack: the web app exports the scene as glTF 2.0 with `extras.pocketCity`, and the cooker (`crates/pocket3d-city-cook`) turns it into a `.pcity` pack for the handheld GPU.

## Layout

| Path | Contents |
| --- | --- |
| `web/` | three.js reference scene, globe, export script (`scripts/export-city.ts`) |
| `crates/pocket3d-city` | `.pcity` pack format: META JSON + texture, geometry and animation blobs |
| `crates/pocket3d-city-cook` | glTF → pack: BC1/BC3/BC5 textures with mips, quantized vertices, baked vertex lighting, low-poly shelf stock, octahedral environment, effect textures |
| `crates/pocket3d-gxm` | GXM layer: GXP registration and patching, own shader patcher, render targets, texture upload, runtime SceShaccCg |
| `vita/` | Vita app: pack loader, frame renderer, Cg programs (`vita/shaders`), LiveArea art |
| `tools/city.ts` | cook, build, deploy over USB, status/capture/profile, standalone VPK |
| `vendor/pocketjs` | PocketJS: Vita dev host and wired debug transport |

## Web

```sh
cd web
bun install
bun run dev          # http://127.0.0.1:5173
```

Controls and URL switches are listed in `web/README.md`.

## Vita

Requirements: VitaSDK at `~/vitasdk`, `cargo-vita`, Rust `nightly-2026-05-28` with `rust-src`, a Vita with HENkaku/Ensō and **Pocket Devkit** installed (build it with `bun tools/vita.ts devkit --release` in `vendor/pocketjs`; see its `docs/VITA-USB.md`), and `ur0:data/libshacccg.suprx` (extracted from Sony's PSM Runtime, for example with ShaRKBR33D) on the development console. Packaged builds carry compiled programs and do not need the compiler.

```sh
git submodule update --init
# 1. Export the scene (dev server running) and cook it
(cd web && bun run dev) &
(cd web && bun scripts/export-city.ts --seconds 20)  # → .pocket-build/city/tokyo/scene.glb (the device loops the 20 s of traffic)
bun tools/city.ts cook                        # → .pocket-build/city/tokyo/tokyo.pcity

# 2. Development loop on a console running Pocket Devkit (PocketJS apps/devkit)
bun tools/city.ts serve &                     # USB host
bun tools/city.ts native                      # sync pack + shaders, build, run in Devkit's native slot
bun tools/city.ts status                      # renderer telemetry under `engine`
bun tools/city.ts profile --shot Konbini      # GPU time per scene
bun tools/city.ts sweep                       # frame time per shot × quality step
bun tools/city.ts capture                     # → .pocket-build/validation/captures/

# 3. Standalone package (title PKCT00001)
bun tools/city.ts vpk                         # → dist/vita/pocket-city-PKCT00001.vpk
```

Shader sources in `vita/shaders` hot-reload: `bun tools/city.ts sync` copies them to the USB share and the device recompiles the programs whose expanded source changed. Compiled programs are cached on the share by content hash; `vpk` packages the ones listed in the device's `gxp/manifest.txt`.

`bun tools/city.ts ctl '{"renderProfile":"vita30","view":…,"time":…,"settings":{…}}'` steers the camera and the renderer. Naming a profile resets its switches and governor; `settings` then overrides them: `reflection`, `haze`, `bloom`, `rain`, `msaa`, `maxLights`, `fx`, `skip`, `flat`, `hud`, `profile` (serialized GPU timing), `step` and `hold` (pin a quality step), and the step or profile values `detailM`, `lodPixels`, `cullSize`, `hazeSize`, `hazeLights`, `bloomFull`, `reflSize`, `streaks`, `steam`, `detailMaps`, `vertexLights`.

## Render profiles

`vita/src/profile.rs` fixes a frame period and what the renderer may spend to meet it. Frames are shown at that period (every second refresh for 30 fps). A governor walks the profile's quality steps from the measured frame time: it steps down after 10 frames over the period and probes one step up after holding it, doubling the wait after each failed probe.

| | `vita30` (default) | `vita60` | `cinematic` |
| --- | --- | --- | --- |
| Period | 33.3 ms | 16.7 ms | 50 ms |
| Scene | 480×272 | 720×408 → 480×272 | 960×544 → 640×362 |
| Materials | normal, ORM and streak maps within 8 m (4 m at the last step) | baked diffuse and environment specular, no detail maps | detail maps within 12–18 m |
| Haze | 160×90 with 6 lights → 4 lights → 120×68 → off | 120×68, 2 lights, off below step 3 | 160×90, 6 lights |
| Bloom | two levels → one level | one level, off at the last steps | two levels |
| Reflection | 240×136, every frame | 240×136, alternate frames | 480×272, alternate frames |
| Rain | 7000 streaks, steam | 1500 streaks | 7000 streaks, steam |
| Moving lights | one per pixel on baked surfaces (only the wet ground beyond the detail distance), per vertex on people and the taxi | same | one per pixel on baked surfaces, four per pixel on people and the taxi |

Static draws carry LOD1 (≤ 6 cm) and LOD2 (≤ 25 cm) index lists: meshoptimizer with only the vertices on chunk-cell cuts locked, and parts of plain lit surfaces narrower than a level's error (window bars, rails, curb pieces) removed at that level. A draw takes the coarsest level whose error projects under the step's pixel threshold; the mirror pass uses twice the threshold. Shelf stock switches to one card per item.

Variants that drop a material's ORM map (distant, LITE and mirror programs) scale roughness, metalness and occlusion by the map's per-channel means, stored in the pack.

## Status on hardware

Measured on a PS Vita 2000 (CPU 444 MHz, GPU 222 MHz) in Pocket Devkit, `vita30`, 4× MSAA, 480×272 composited and scaled to 960×544. `bun tools/city.ts sweep --time T` pins each step for each shot's halfway view:

| Shot | t = 100 s: step 0 | t = 72 s (taxi passing): first step at 33.3 ms |
| --- | --- | --- |
| Konbini | 33.3 ms | step 2 (step 0: 38.0 ms) |
| Puddles | 33.4 ms | step 1 (34.4 ms) |
| Vending | 33.4 ms | step 1 (36.7 ms) |
| Crossing | 33.3 ms | step 3 (37.4 ms) |
| Inside | 33.4 ms | step 0 |
| Wires | 33.4 ms | step 0 |

With the camera rig and governor running (`bun tools/city.ts shots --seconds 130`), every shot averages 29.5–30.0 fps; the longest smoothed frame is 36.8 ms, while the taxi passes Konbini. Serialized GPU time at step 0 (t = 100 s) runs from 31.2 ms (Wires) to 40.7 ms (Puddles): main pass 16–23 ms, haze 5.6 ms, bloom 3.8 ms, composite 2.2 ms, reflection 3.1 ms, display scale 1.2 ms.

## License

MIT
