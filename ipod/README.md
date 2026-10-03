# Pocket Atlas on iPod touch 4

Native ARMv7 / OpenGL ES 2.0 renderer with a UIKit directory, rotatable globe and place markers, scene navigation, settings, About, cinematic playback and two-contact walking. The catalog comes from the web registry; all five current live places ship in the same app.

Adaptive is the default and targets 30 fps, adjusting the internal width through 160, 192, 256, 320, 400, 480 and 640 pixels. Resolution increases are single-step trials accepted only after a fresh 120-frame window; failed trials roll back and cool down before retrying. Performance fixes the internal render size at 480×320; both use a 480×320 drawable. Retina uses the full material profile and a 960×640 drawable. It is a detail comparison mode: heavy views can trigger the system-memory fallback to Adaptive, and it does not meet the real-time frame budget on iPod touch 4. UIKit uses an independent Retina container and its own main-thread display link at every quality setting. Device capture receipts record actual layer scales and PNG dimensions. That UI callback rate does not establish the 3D frame rate; use completed render-worker presentation timings below.

## Ownership

Atlas owns the GLES renderer, UIKit shell and conversion of its `.place` packs. Shared geometry, animation, lighting metadata, color grade and material algorithms remain in `pocket3d-place`, the cooker and `vita/shaders`. The pinned PocketJS dependency supplies the ARMv7 target, legacy SDK resolver, startup objects and the MobileInstallation transaction. No PocketJS files are modified.

`platform.c` owns UIKit. `render_worker.c` transfers the EAGL context and Rust `App` to one render thread. UI reads copied snapshots and queues input; it never calls Rust concurrently. Background entry drains GL, releases scene/globe render resources and the audio player, discards stale touches and parks the owner. Before releasing resources, the app atomically saves a versioned user checkpoint in its Documents directory. Resume or a cold launch restores the selected scene, camera, playback position and settings; shutdown joins before destroying GL resources. Scene transitions wait for pending GPU work and release the hidden globe before loading a scene, keeping the atlas and scene GPU working sets separate.

Profile replacement drains and releases the old renderer, then reloads profile-specific Scene resources while preserving the camera, clock and door state. Retina does not load display colors/pages, graded environments, static index caches, product parameters or light phase/density data. The performance profile uploads only textures demanded by its generated sampler inventory, including shadow and rain dependencies. Every original texture is still read, validated and hashed; skipped uploads do not weaken the sidecar identity contract. Linked driver-active samplers are checked before renderer target allocation, so an incomplete inventory fails loading instead of silently sampling a missing texture. Adaptive and Performance share those resources. Failed selected-scene loads remain visible and wait for an explicit retry; they do not allocate the globe. UIKit low-memory notifications are coalesced without allocation and consumed by the render owner. They clear diagnostic resolution overrides and select Adaptive at its minimum resolution; background notifications wait until resume without allocating GL resources. `memoryWarningBatches` reports processed notification batches, so normal quality validation can detect fallback rather than mistake it for a successful Retina run.

Pipeline tables validate every mesh/light-field slot before either profile creates GPU programs, and failed particle uploads do not commit cached ranges or reuse stale buffer contents. The full HDR profile keeps completion boundaries between main geometry, framebuffer-fetch effects and final post stages, following SGX535 resets observed when those stages were queued together. The display profile uses hardware blending and completes at presentation; synchronized diagnostic profiling adds separate pass waits.

Command nonces are acknowledged only after presentation. Capture files are atomically renamed after writing. Raw drawable/HDR capture uses one synchronous readback and an atomic file replacement, preserving full pixel dimensions and bottom-to-top row order. Its temporary RGBA buffer is 600 KiB at 480×320 or 2.34 MiB at 960×640; capture work is excluded from normal timing. Saved state excludes diagnostic overrides and command nonces; malformed, oversized, incompatible or unavailable-place checkpoints fall back to the atlas.

The full profile uses RGBA8 HDR storage because SGX535 cannot render into the half-float target used by Vita: `sqrt(c/(1+c))` RGB, logarithmic eye distance in alpha, decoded-radiance transparency through framebuffer fetch, and the shared grade through a 32³ LUT. Radiance is capped at 126. Glass with specular lights uses full precision to prevent half overflow.

The adaptive and performance profiles use display-space forward rendering. An optional, hash-checked display sidecar supplies prelit, graded vertex colors for eligible materials. Static opaque draws share 24-byte pages containing float positions, float UVs and RGBA8 colors; this avoids requantizing texture coordinates and allows material batching across the original geometry pages. Animated and transparent meshes retain their original vertex layout with a separate color attribute. Batches use a validated display-state key rather than the original material identity, so irrelevant full-profile properties do not split identical display draws. The original geometry and full-profile vertex arrays remain available. Texture detail modulates these colors in sRGB, independent emission maps use a second sample, wet ground keeps its puddle field, ripple animation and reflected scene, and glass retains beads and view-dependent Fresnel reflection. Remaining procedural interior materials use reduced shared shading with a 16³ display transform. This is an explicit approximation: lighting is Gouraud/prelit, bright textured surfaces can differ from the full tone curve, and transparency, reflections, bloom and fog combine in display space. The water profile retains both moving wave layers, Fresnel reflection and a cheaper sun highlight, using a separately graded environment texture. Sun shadow maps are only created when the selected programs consume them.

Bone palettes are filled once per scene update and shared by all passes; the performance vertex shader skips exactly zero-weight influences. Static shelf products keep their original meshes, LODs and packaging texture, with package seed/band parameters prepared once into a small vertex stream. CPU/GPU sine precision can select different atlas designs; this path does not claim identical package choices.

Both profiles retain authored scenes, animation and texture roles. Textures are capped at 512 pixels and resampled according to their role. The throughput geometry adapter groups compatible static draws into shared vertex pages under bounded position and texture-coordinate error, and canonicalizes equivalent constant-tint materials. Visible draws stream only their selected original LOD indices. Optional spatial index groups select the original LOD independently for complete connected parts, then cull screen-exterior clusters without changing retained geometry or the original LOD errors. A bounded hierarchy prunes those queries, and an exact view cache reuses their results for fixed views while animation continues. Separate mirror/main index buffers cache exact ordered streamed selections; unrelated moving draws do not invalidate static indices, and a camera can move within one selection region without recopying or uploading them. Failed uploads invalidate the cache and surface a GL error. Color sidecars bind metadata, geometry, animation and the complete ordered texture payload; cluster sidecars bind their source metadata and geometry. Both are validated against their source pack; absent sidecars retain the original paths, while stale or malformed sidecars fail loading.

Performance point lights cache sine/cosine of their immutable packed phases; moving paths, blink timing and authored amplitudes remain animated. Dense static twinkle fields additionally use a screen-space density estimate to reduce subpixel points with stable ranks and smooth weights. Moving, periodically blinking, larger and isolated lights retain their points. Weights apply after grading and coverage, approximating statistical display energy rather than preserving individual lights or pixel identity. Density is projected before depth testing, so occluded points can influence it. The bounded selection cache excludes time but invalidates on view or target changes; Full retains the original complete fields. `lightPoints`, `lightLodGpuBytes` and `lightLodCpuBytes` report submitted points and separate cache/source storage. `gpuBytes` is the immutable Scene allocation total, not total process GPU memory.

Performance effects use a stable one-third rain subset with compensated energy, per-particle display colors computed through the shared grade table, small bloom/haze targets, reduced reflections and a low-resolution sky; the full profile retains the HDR effects chain. When both display haze and bloom are enabled, one low-resolution pass produces their combined contribution. Static opaque vista-haze batches without emission or wet reflection may share a canonical RGBA8 haze uniform, checked at both surface-color endpoints. Within the unit display range the decoded-uniform blend differs by at most one display byte; this bound excludes GPU arithmetic rounding and later post processing. The performance globe grades at its internal resolution before the final blit and selects sphere indices under a quarter-internal-pixel silhouette error bound. These are platform adaptations, not pixel-identical Vita output.

Audio is baked from each place's original Web Audio graph to CAF, follows the scene clock and pauses with it. It has a fixed stereo listening position; free walking does not re-spatialize it or trigger the proximity door chime. Sound starts muted.

## Build assets

Requirements: Bun, Rust and the pinned PocketJS nightly, Xcode command tools with `ld-classic`, `ldid`, ImageMagick, `glslangValidator`, `spirv-cross`, Chromium for the existing web exporters, and the provisioned PocketJS iPod touch 4 toolchain. Inspect it with `(cd vendor/pocketjs && bun ipodtouch4 doctor)`; use its documented setup workflow if absent.

Run the web server once (`cd web && bun dev --host 127.0.0.1`). Export and cook each live place, using the authored loop (Tokyo/Kamakura/Griffith 120 seconds, Akihabara 20; Suga is static):

```sh
cd web
bun scripts/export-place.ts --place tokyo-konbini --seconds 120
bun scripts/preview-place.ts --place tokyo-konbini
cd ..
cargo run --release -p pocket3d-place-cook -- --in .pocket-build/places/tokyo-konbini
cargo run --release -p pocket3d-place-cook -- gles --in .pocket-build/places/tokyo-konbini/tokyo-konbini.place --out .pocket-build/ipod/assets/tokyo-konbini.place --tex 512 --geometry throughput
magick .pocket-build/places/tokyo-konbini/preview.png -resize 320x180! .pocket-build/ipod/assets/tokyo-konbini.preview.png
```

Then export the atlas with the existing `web/scripts/export-atlas.ts` workflow, and generate the shared native assets:

```sh
bun tools/atlas-ipod-globe-assets.ts
bun tools/atlas-ipod-pipelines.ts
bun tools/atlas-ipod-check.ts
bun tools/atlas-ipod-audio.ts
bun tools/atlas-ipod.ts package
```

The signed bundle, receipt and IPA are under `.pocket-build/ipod/`. Packaging starts from a clean bundle and requires the pack, pipelines, shadow table, sound and preview for every live place. App icons are resized from the existing Pocket Atlas artwork.

## Device loop

The supported transport is the already provisioned, jailbroken iPod4,1 on iOS 6.1.6 (10B500) with AppSync. `idevice_id`, `ideviceinfo`, `iproxy`, SSH and SCP must be available. The tool selects the single connected device, verifies its model/build and uses its pinned SSH key/known_hosts from PocketJS's cache. With multiple devices, set `POCKETJS_IPODTOUCH4_UDID`. Optional key overrides are `POCKETJS_IPODTOUCH4_KEY` and `POCKETJS_IPODTOUCH4_KNOWN_HOSTS`.

```sh
bun tools/atlas-ipod.ts deploy       # package, install, byte-exact bundle readback
bun tools/atlas-ipod.ts launch
bun tools/atlas-ipod.ts status
bun tools/atlas-ipod.ts status --ui  # independent UIKit cadence
bun tools/atlas-ipod.ts ctl '{"place":"tokyo-konbini","shot":0,"time":3,"quality":1}'
bun tools/atlas-ipod.ts capture --out .pocket-build/validation/ipod/scene.png
bun tools/atlas-ipod.ts capture-ui --out .pocket-build/validation/ipod/ui.png
bun tools/atlas-ipod.ts capture-hdr --out .pocket-build/validation/ipod/main-hdr
```

`quality` is 0 Adaptive, 1 Retina, 2 Performance; `renderWidth` is a diagnostic override (160–960, or 0 to clear it). `time:-1` resumes animation. `pause`, `rain`, `reflection`, `bloom`, `sound` and `profile` are booleans. `profile:true` includes GL completion waits in all pass measurements; normal `passesMs` excludes explicit completion waits and measures CPU submission. Do not report it as GPU timing. `passTiming` reports a 120-frame mean/p95/max window for each scene/globe stage, using the same exclusions and resetting on profile changes. `profileDrawClass` is a profiling-only mesh filter; normal acceptance explicitly resets it to 0. `renderRequestHz:30|60` is a diagnostic producer-rate override (default 60), using absolute display-link deadlines without catch-up bursts; UIKit stays at 60 Hz, and input events still wake the worker immediately. It is not a global FPS cap and is not saved. After changing it, collect at least 120 fresh frames before comparing timings. `uiAction` follows the same button handler as UIKit; `touches` supplies deterministic input events for regression. These controls do not establish real finger ergonomics or what a person heard. `capture-hdr` writes raw `.rgba` and `.json` encoding/dimension metadata, without an sRGB conversion.

For iteration, `native` replaces and reads back the executable; `sync --shaders` updates non-pack assets, and `sync --packs` updates packs. Both stop this app before changing its files. `--place <id>` restricts scene assets. Always finish with `deploy` and a fresh launch to verify the complete packaged build, rather than treating a development sync as an installation receipt.

## Checks

```sh
cargo test -p pocket3d-place -p pocket3d-place-cook --locked
cargo check -p pocket3d-place --no-default-features --locked
bun test tools/atlas-ipod-*.test.ts
bun tools/atlas-ipod-effects.ts --check --check-cpu
bun tools/atlas-ipod-check.ts
sh ipod/tests/render_worker.sh
sh ipod/tests/render_pacing.sh
sh ipod/tests/scene/run.sh
bun run --cwd web build
```

Host shader checks substitute the unavailable framebuffer-fetch builtin only in ignored validation copies. They establish stage linkage, not Apple driver behavior. The scene-loader harness exercises malformed containers, invalid data and allocation-failure cleanup with mocked GL. Real-driver compilation, every authored camera shot, UI interaction, sound listening and installed-file identity remain separate acceptance evidence; keep receipts and captures in `.pocket-build/validation/ipod/`.

After deployment, sweep every authored camera with the normal adaptive profile:

```sh
bun tools/atlas-ipod-acceptance.ts --quality 0 --width 0 --warmup 2 --seconds 90
# Optional full-profile comparison, allowing longer for 120 presentations:
bun tools/atlas-ipod-acceptance.ts --quality 1 --width 0 --seconds 180
```

`--quality` accepts 0, 1 or 2 and defaults to 0. `--width 0` leaves adaptive resolution unlocked. `--seconds` is the measurement deadline per shot, after warmup; it is not a short FPS sampling interval. Each view requires at least 120 fresh, non-excluded presentations after warmup and full 120-sample work/interval windows. Adaptive resize, loading and capture exclusions cannot satisfy this count. The script marks insufficient evidence `incomplete` and invalid state `failed`, returning a nonzero exit status in either case.

The sweep performs USB identity and installer queries before each quiet sampling interval, then reads the completed window. `status --quiet 12` provides the same ordering for manual measurements; it reduces transport setup interference without subtracting any observed frame time.

Receipts report `frameTiming` render, present, work and presentation-interval mean/p95/max and budget misses, plus worker-derived FPS. `result: complete` means the evidence window is complete; the separate `meets30FpsBudget` field requires actual FPS ≥30 and both work and interval p95 within 33.333 ms, without rounding or a hidden tolerance. A complete sweep below that budget is still recorded honestly. Captures happen after measurement and include separate drawable and native UI PNG dimensions, current internal render size, independent UIKit cadence and memory. The whole sweep is complete only after every requested shot finishes.

Use `--profile` only for a separate diagnostic sweep: its additional synchronization is explicitly recorded and disqualifies the run as normal performance evidence. The script verifies build identity, camera, quality, command nonce, `profileDrawClass: 0` and GL errors throughout. Fixed time 25 captures do not establish frame budgets at every animation time or free-camera position. Keep the final device numbers and visual conclusions with the actual PR receipts.

Monitor device syslog during GPU acceptance (`idevicesyslog -u <udid>`). A frame can complete with `glError: 0` after a driver reset; an application status check alone does not establish GPU stability. Also verify a real transition to another app and back, including resource release and camera/clock preservation.
