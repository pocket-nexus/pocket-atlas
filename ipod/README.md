# Pocket Atlas on iPod touch 4

Native ARMv7 / OpenGL ES 2.0 renderer with a UIKit directory, rotatable globe and place markers, scene navigation, settings, About, cinematic playback and two-contact walking. The catalog comes from the web registry; all five current live places ship in the same app.

Retina renders at 960×640. Balanced renders at 480×320; Adaptive adjusts the internal resolution from 320 to 960 pixels wide. UIKit remains at native scale on a separate 30 Hz main-thread display link. Full scene rendering on SGX535 is substantially slower than 30 fps; the quality selector does not promise that frame rate. Retina is the default to prioritize detail.

## Ownership

Atlas owns the GLES renderer, UIKit shell and conversion of its `.place` packs. Shared geometry, animation, lighting metadata, color grade and material algorithms remain in `pocket3d-place`, the cooker and `vita/shaders`. The pinned PocketJS dependency supplies the ARMv7 target, legacy SDK resolver, startup objects and the MobileInstallation transaction. No PocketJS files are modified.

`platform.c` owns UIKit. `render_worker.c` transfers the EAGL context and Rust `App` to one render thread. UI reads copied snapshots and queues input; it never calls Rust concurrently. Background entry drains GL, releases scene/globe render resources and the audio player, discards stale touches and parks the owner. Before releasing resources, the app atomically saves a versioned user checkpoint in its Documents directory. Resume or a cold launch restores the selected scene, camera, playback position and settings; shutdown joins before destroying GL resources. Scene transitions wait for pending GPU work and release the hidden globe before loading a scene, keeping the atlas and scene GPU working sets separate. The main geometry, framebuffer-fetch effects and final post stages each complete before the next stage; this avoids SGX535 resets observed when these stages were queued together. Command nonces are acknowledged only after presentation. Capture files are atomically renamed after writing. Saved state excludes diagnostic overrides and command nonces; malformed, oversized, incompatible or unavailable-place checkpoints fall back to the atlas.

SGX535 cannot render into the half-float target used by Vita. The GLES adapter stores HDR in RGBA8 as `sqrt(c/(1+c))`, with logarithmic eye distance in alpha. Transparent materials blend decoded radiance through framebuffer fetch; opaque shaders avoid fetch. Radiance is limited to 126 before encoding. Glass arithmetic stays full precision to prevent half overflow in smooth specular highlights. The final shared grade is sampled through a 32³ LUT over this storage domain.

Scene textures are capped at 512 pixels, decoded/resampled with role-aware filtering; geometry and animation bytes are retained. Sun shadows, sharp and blurred wet reflections, rain, steam, fog, water, animated signs and point-light fields use the shared algorithms. Static sun casters are cached. Rain culling retains the original visible particle seeds; low-resolution bloom uses a shorter chain with an approximately matched halo radius. These are platform adaptations, not pixel-identical Vita output.

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
cargo run --release -p pocket3d-place-cook -- gles --in .pocket-build/places/tokyo-konbini/tokyo-konbini.place --out .pocket-build/ipod/assets/tokyo-konbini.place --tex 512
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
```

`quality` is 0 Adaptive, 1 Retina, 2 Balanced; `renderWidth` is a diagnostic override (0 clears it). `time:-1` resumes animation. `pause`, `rain`, `reflection`, `bloom`, `sound` and `profile` are booleans. `profile:true` includes GL completion waits in all pass measurements; normal `passesMs` excludes explicit completion waits and measures CPU submission. Do not report it as GPU timing. `uiAction` follows the same button handler as UIKit; `touches` supplies deterministic input events for regression. These controls do not establish real finger ergonomics or what a person heard.

For iteration, `native` replaces and reads back the executable; `sync --shaders` updates non-pack assets, and `sync --packs` updates packs. Both stop this app before changing its files. `--place <id>` restricts scene assets. Always finish with `deploy` and a fresh launch to verify the complete packaged build, rather than treating a development sync as an installation receipt.

## Checks

```sh
cargo test -p pocket3d-place -p pocket3d-place-cook --locked
cargo check -p pocket3d-place --no-default-features --locked
bun test tools/atlas-ipod-globe-assets.test.ts
bun tools/atlas-ipod-effects.ts --check --check-cpu
bun tools/atlas-ipod-check.ts
sh ipod/tests/render_worker.sh
sh ipod/tests/scene/run.sh
bun run --cwd web build
```

Host shader checks substitute the unavailable framebuffer-fetch builtin only in ignored validation copies. They establish stage linkage, not Apple driver behavior. The scene-loader harness exercises malformed containers, invalid data and allocation-failure cleanup with mocked GL. Real-driver compilation, every authored camera shot, UI interaction, sound listening and installed-file identity remain separate acceptance evidence; keep receipts and captures in `.pocket-build/validation/ipod/`.

After deployment, sweep every authored camera at native resolution:

```sh
bun tools/atlas-ipod-acceptance.ts --width 960 --seconds 5
```

Use `--profile` to include synchronized pass timings alongside the wall-clock frame rate. The sweep checks the running build ID, acknowledged camera, advancing frame count and GL errors. It records independent UIKit cadence and resident memory with each captured view. The installed acceptance run is documented in the PR; full Retina scenes remain below 30 fps. Its FPS is a wall-clock frame-count estimate over a short fixed-view window, not isolated GPU time or a guarantee for free-camera positions.

Monitor device syslog during GPU acceptance (`idevicesyslog -u <udid>`). A frame can complete with `glError: 0` after a driver reset; an application status check alone does not establish GPU stability. Also verify a real transition to another app and back, including resource release and camera/clock preservation.
