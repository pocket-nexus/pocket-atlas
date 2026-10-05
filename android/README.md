# Pocket Atlas on the Redmi 1S

A native ARMv7 app for the Redmi 1S (HM 1S: Android 4.3, API 18, MSM8226, Adreno 305, OpenGL ES 3.0, a 1280 × 720 panel): the atlas and all seven places (`targets: "android"` in the web registry), each drawn into the window at up to 1280 × 720, as a tour of its authored shots or under the fingers. It is a `NativeActivity` with no Java and no Gradle project; the APK holds the code, the interface and every pack. [The interface](../README.md#the-interface) (`ui/`, in its touch presentation at 640 × 360 logical pixels, two samples each way) is everything flat on the screen:

| Path | Contents |
| --- | --- |
| `android/src/scene.c`, `shaders.h` | one place: pack loader, the sun's shadow map, culling and levels of detail, the mirror, sky, light sprites, rain and glows; one GLSL ES 3.00 source compiled per program with a `#define` |
| `android/src/main.c` | the shell: the window and its EGL surface, touches and the back and menu keys, the title card, the interface's guest (PocketJS's C runtime and UI core) and the pass that lays it over the frame, the guard of the frame rate, commands, status and captures |
| `android/src/loader.c` | `libmain.so`, the library the activity names: it opens `libatlas.so`, and in a development build a pushed copy of it first |
| `android/src/globe.c` | the atlas screen's globe (the iPod touch's, in landscape) |
| `android/title/` | the Pocket3D title card as three C calls over PocketJS's `pocket3d-title` |
| `n3ds/src/interface.c` | the renderer's side of the interface's protocol, shared with the 3DS and the iPod touch |
| `tools/atlas-android.ts` | cook, build, package, install, push, launch, control, capture, measure |
| `crates/pocket3d-place-cook/src/adreno.rs`, `pica.rs`, `profiles/redmi1s30.json` | the pack: the 3DS lowering with ETC2 texels, relief cooked into the textures and the sun's shadow camera |

## How it draws

The phone reads the table the 3DS and the iPod touch read (`n3ds/src/format.h`): light, grade and sky occlusion are cooked into display-referred vertex colours, so a surface is one texture fetch times one colour, with fog. The Adreno 305 was measured before the frame was designed (probe results are in the pull request): **a fetch is cheap and arithmetic is dear** (one bilinear fetch over the whole window costs 1.25 ms, three fetches with a lit program 9.3 ms), **a small triangle costs 0.045 ms per thousand**, and **a draw call costs 17 – 20 µs**. So the lowering keeps the fragment stage at fetches and one `mix`, works every light, haze and Fresnel term out per vertex, and spends the GPU on resolution, texels and triangles. What the pack carries for this target only (`adreno` in `pica.rs`, `adreno.rs`):

- **ETC2 texels.** An opaque surface is `COMPRESSED_RGB8_ETC2` with its mips, encoded by the cooker (individual, differential and planar blocks), at up to **1024 texels** a side where the 3DS has 256 and the iPod touch 512; signs and other detail textures go to 2048 as RGB565, a texture with an alpha channel as RGBA8. The seven packs are 25 – 72 MiB (340 MiB together).
- **Relief in the texture.** A material's normal map is lit once by the cooker, from above and to one side in tangent space, and multiplied into its texture (masonry joints, cladding, paving). The fragment stage reads no normal map.
- **The sun's shadows per pixel.** For a place with an authored sun, a sunlit vertex carries its colour in full sun and, in its alpha, the share of that colour left in shadow; section `SUNL` carries the shadow camera, its bias and the shade's tint. The renderer draws the place's fixed surfaces into a **2048 × 2048 16-bit depth map once at load** (four levels, each drawn from the geometry) and a sunlit surface picks between its two colours with one comparison fetch (`sampler2DShadow`, four texels compared and blended by the sampler). Both colours are worked out per vertex. What moves casts nothing and is lit by where it stands. The 3DS and the iPod touch keep the per-vertex shadow ray or none; their packs do not change.
- **Container version 0x201**, so that no other reader takes this pack.

The frame:

- **Every triangle of the scene is drawn in the window's own pass.** Adreno 3xx is a tiler, and a pass whose binning it gives up costs 25 – 40 × (0.8 ms per thousand triangles); that was seen on textures and on multisampled textures and never on the window. The mirror is the one pass into a texture: 640 × 360, single-sampled, the coarsest level of each chunk, its depth invalidated.
- **A material is one draw.** Chunks are 16 m cells, each at the coarsest level whose error stays under a pixel; the chunks of a material share one index buffer, rewritten when a level changes or the eye has moved 1.5 – 3.25 m, with the nearest chunk first. Drawing each chunk by itself (732 draws) took 15 – 20 ms of CPU.
- **Opaque surfaces, then cutouts in two stages, then the sky, then what blends.** A program that may `discard` is never rejected early by depth on this GPU, whatever stands in front of it. A cutout is drawn first into depth alone by a program of one fetch and the `discard`, then in colour where the depth is equal by the program of an opaque surface. Sangubashi's first shot went from **53.9 to 36.0 ms**, the Suga stairs from 44.7 to 36.8 ms (GPU time at 1280 × 720).
- **People are skinned by the GPU**: a rig's joints go up as one uniform array per rig (up to 72 joints) and four weights per vertex are summed in the vertex stage. It took 3.7 ms off the CPU's part of the konbini's frame.
- **Smoothing comes from the window's EGL config** (2 or 4 samples), never from a multisampled texture. A context draws only into surfaces of its own config, so a change of samples makes the context and everything on the GPU again. It is off at launch: on the konbini's crossing 2 samples cost **+8.4 ms** and 4 samples +24 ms at 1280 × 720.
- **The guard of the frame rate is the window buffer's height.** The display processor scales a smaller buffer to the panel as an overlay, at no cost to the GPU, and changing the size keeps the context: a place starts at 720 lines and goes one step down (648, 576, 540) each time 30 frames took 4 % longer than the rate allows or 4 of them were late. It does not climb again during a visit. The atlas screen is at 720 lines.

The interface is drawn at the panel's 1280 × 720 into a texture, redrawn only when its draw list changes, and blended over the frame as one quad; the guest gets a turn 30 times a second, and while it shows nothing the quad is skipped. The back key is the pad's ×: it closes a sheet, leaves a place, and at the atlas ends the activity. The menu key opens a place's menu, which offers the frame rate (30 or 60), smoothing (off, 2×, 4×) and the place's effects.

[The title card](../README.md#title-card) plays first at every launch: `pocket3d-title` draws each of its 144 ticks into a 1280 × 720 RGBA buffer, the shell uploads a tick that differs from the last and covers the window with it, and the tick shown follows the clock. Nothing of the scene or the interface is made before it ends.

Three things this driver (`V@53.0 AU@04.03.00.129.098`) does that the language does not say:

- A `sampler2DShadow` fetch comes back as a vector with the comparison in red alone: broadcast to a colour it lights only red. The programs take it through a dot product with (1, 0, 0, 0).
- It refuses a loop over an attribute's components ("indexing into an attribute using a non-constant expression"): the four joints are written out.
- A vertex attribute left as a constant (its array disabled) puts every draw on a slow path (42 – 64 ms a frame). The overdraw count below is exact in its counts and useless as a timing.

Not here: sound. Against the Vita it lacks lighting per pixel from normal maps (the relief is cooked instead), moving lights on surfaces, lit haze volumes, bloom, rooms traced behind windows (a flat room texture stands in), glass reflections and steam.

## Build and run

Requirements: Bun, Rust (`rustup`, with the toolchain PocketJS pins and the `armv7-linux-androideabi` target), the Android SDK command line tools with **NDK 21.4.7075529** (the last that builds for API 18), build-tools 34.0.0 and platform 34, a JDK for `apksigner`, ImageMagick, and `adb`. `bun tools/atlas-android.ts doctor` checks each and the phone.

Export each place and its preview as for the Vita (`web/scripts/export-place.ts`, `preview-place.ts`), then:

```sh
bun tools/atlas-android.ts cook                 # → .pocket-build/android/assets/<id>.place (--place ID for one)
bun tools/atlas-android.ts install --release    # build, package (APK with every pack), install, launch
bun tools/atlas-android.ts launch
bun tools/atlas-android.ts ctl '{"place":"tokyo-konbini","shot":0,"time":25}'
bun tools/atlas-android.ts status
bun tools/atlas-android.ts capture --out .pocket-build/validation/android/view.png   # the place, at the window's size
bun tools/atlas-android.ts capture --screen                                          # the frame with the interface over it
bun tools/atlas-android.ts shots                # every authored shot: frame intervals, then a capture
bun tools/atlas-android.ts stop
```

MIUI asks on the screen before every `adb install` (two screens); `install` answers them through `uiautomator` and `input tap`. A development build (no `--release`) therefore has a door that keeps installs out of the edit loop: `libmain.so` opens `/data/local/tmp/dev.pocketnexus.atlas/libatlas.so` when it is there, and the shell reads the interface and packs from that directory first.

```sh
bun tools/atlas-android.ts install              # once: the development build
bun tools/atlas-android.ts native --place ID    # build, push the library and the interface (and one pack), relaunch
bun tools/atlas-android.ts native --no-title    # the same, without the title card
bun tools/atlas-android.ts unpush               # back to what the APK holds
```

A release build has no door, reads nothing pushed and always plays the card. `ATLAS_ANDROID_PACKAGE` installs a build beside another under its own identity (`dev.pocketnexus.atlas` otherwise). The APK is signed with PocketJS's Android debug key in `~/.cache/pocket-nexus/android/signing/`; an installed app upgrades only under the key it was signed with.

Commands are JSON, pushed as one file and acknowledged in the status: `place` (an id) enters a place and `atlas: true` leaves it; `shot` (index or name) cuts to a shot's midpoint; `time` freezes the loop at that second and a negative one releases it; `view: [x, y, z, tx, ty, tz, fov]` pins a camera; `cinematic`, `pause`, `reflection`, `rain`, `glow` are switches; `lod` is the error tolerance in pixels (1); `rate` is 30 or 60; `samples` is 0, 2 or 4; `lines` pins the window buffer's height (540 – 720) and 0 gives it back to the guard; `touch: [[x, y], …]` holds fingers on the interface (640 × 360) until a message with other contacts or none; `key: "back"` or `"menu"` presses that key; `mark: true` starts the count of frames and late frames again; `profile: true` times the GPU with a timer query on every third frame (`gpuMs`; the frames around a query lose their place in the refresh, so it is a time and not a frame rate, and the guard stands still under it).

`skip` leaves parts of the frame out to find where its time goes, as a sum of bits: 1 people, 4 what blends, 8 cutouts, 16 opaque surfaces, 32 the sky, 64 the mirror's draws, 256 one white texel for every texture, 512 the table's order instead of nearest first, 2048 no tint in the shade, 4096 and 8192 everything lit or shaded, 16384 no shadow fetch, 32768 cutouts in one stage. 128 counts overdraw: each fragment that is shaded adds a sixteenth of white.

On the phone: the atlas has the globe at the left (a finger spins it) and the lists at the right, with Save and Visit buttons and a Search list that opens a keyboard. In a place two sticks stand in the lower corners, the left to walk and the right to look, and using either leaves the tour; a tap elsewhere calls up the bar (atlas, previous and next shot, pause or tour, menu).

## Measuring

`shots` holds each authored shot at its midpoint with the loop frozen at 25 s, waits for the guard to stop changing the window, lets 240 frames go by with no traffic to the phone, then reads the status and captures. `fps` is frames shown over that window and `intervalMs` the time between two returns of `eglSwapBuffers`; `late` counts frames shown a refresh or more after their turn (over 41.7 ms at 30, over 25 ms at 60); `workMs` runs from the start of the frame to the last GL call and `swapMs` is `eglSwapBuffers`, which waits for the GPU and the refresh. **A frame the GPU cannot finish in time is shown when it is done**: a shot at 36 ms a frame reads 27.8 fps with no late frame, so the mean interval is the measure. These are fixed views: a tour or a walk changes chunks and levels every few frames.

Status files are written into the app's directory world-readable and read with `adb pull`, which costs the app nothing. The receipt and captures stay in `.pocket-build/validation/android/`; device results belong in the pull request.

Not verified by the tool: touch handling under real fingers, and thermal behaviour over a long session (the SoC read 57 – 60 °C with two or three of its four cores online during the measurements).
