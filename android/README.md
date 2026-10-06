# Pocket Atlas on Android

A native app for Android 4.3 and later with OpenGL ES 3.0, designed for and measured on the Redmi 1S (HM 1S: Android 4.3, API 18, MSM8226, Adreno 305, a 1280 × 720 panel): the atlas and all seven places (`targets: "android"` in the web registry), each drawn at up to 1280 × 720, as a tour of its authored shots or under the fingers. It is a `NativeActivity` with no Java and no Gradle project; the APK holds the code, the interface and every pack. **One APK holds two libraries**, `lib/armeabi-v7a` for the Redmi 1S and `lib/arm64-v8a` for a phone with no 32-bit support, and declares `minSdkVersion` 18 and `targetSdkVersion` 34: [what it does on a current phone](#on-a-current-phone) is below. [The interface](../README.md#the-interface) (`ui/`, in its touch presentation at 640 × 360 logical pixels, two samples each way) is everything flat on the screen:

| Path | Contents |
| --- | --- |
| `android/src/scene.c`, `shaders.h` | one place: pack loader, the sun's shadow map, culling and levels of detail, the mirror, sky, light sprites, rain and glows; one GLSL ES 3.00 source compiled per program with a `#define` |
| `android/src/main.c` | the shell: the window and its EGL surface, where the 16:9 picture goes in a window of another shape, touches and the back and menu keys, the title card, the interface's guest (PocketJS's C runtime and UI core) and the pass that lays it over the frame, the guard of the frame rate, commands, status and captures |
| `android/src/loader.c` | `libmain.so`, the library the activity names: it opens `libatlas.so`, and in a development build a pushed copy of it first |
| `android/AndroidManifest.xml` | the SDK levels, the activity and the changes of configuration it stays alive through |
| `android/src/globe.c` | the atlas screen's globe (the iPod touch's, in landscape) |
| `android/title/` | the Pocket3D title card as three C calls over PocketJS's `pocket3d-title` |
| `n3ds/src/interface.c` | the renderer's side of the interface's protocol, shared with the 3DS and the iPod touch |
| `tools/atlas-android.ts` | cook, build both libraries, package, install, push, launch, control, capture, measure |
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
- **The guard of the frame rate is the window buffer's height.** The display processor scales a smaller buffer to the panel as an overlay, at no cost to the GPU, and changing the size keeps the context: a place starts at 720 lines and goes one step down (648, 576, 540) each time half of 30 frames were slow, which is 4 % over the rate from one swap to the next or, at 30, a GPU time within 3.5 ms of two refreshes. It does not climb again during a visit. The atlas screen is at 720 lines.
- **At 30 frames a second the app times its own frames.** `eglSwapBuffers` returns when the frame is queued and waits for the compositor only while the queue is full, which a place at 30 never makes it; the swap interval is 1 whatever is asked (Android clamps it). Frames queued 26 ms apart are shown for one refresh and two by turns. Where the refreshes fall comes from the display driver, which publishes the time of its last vertical sync on the app's own clock (`/sys/class/graphics/fb0/vsync_event`, world-readable on this phone; **16.6668 ms** apart); without that file the atlas screen stands in, where the GPU has little to do, the queue is full and every return of the swap follows a latch. The swap returns 2 ms after it is called and the GPU draws the frame for 20 – 30 ms after that; the display takes a frame at the first refresh after its last tile, so a frame whose last tile falls beside a refresh is shown for one refresh and three by turns. A fence (`glFenceSync`) set ahead of each swap tells how long the GPU took (`drawnMs`), and the shell calls the next swap that long before the middle of every second slot between two refreshes. The compositor's own record then shows every frame for two refreshes.

The interface is drawn at the panel's 1280 × 720 into a texture, redrawn only when its draw list changes, and blended over the frame as one quad; the guest gets a turn 30 times a second, and while it shows nothing the quad is skipped. The back key is the pad's ×: it closes a sheet, leaves a place, and at the atlas ends the activity. The menu key opens a place's menu, which offers the frame rate (30 or 60), smoothing (off, 2×, 4×) and the place's effects.

[The title card](../README.md#title-card) plays first at every launch: `pocket3d-title` draws each of its 144 ticks into a 1280 × 720 RGBA buffer, the shell uploads a tick that differs from the last and covers the window with it, and the tick shown follows the clock. Nothing of the scene or the interface is made before it ends.

Three things this driver (`V@53.0 AU@04.03.00.129.098`) does that the language does not say:

- A `sampler2DShadow` fetch comes back as a vector with the comparison in red alone: broadcast to a colour it lights only red. The programs take it through a dot product with (1, 0, 0, 0).
- It refuses a loop over an attribute's components ("indexing into an attribute using a non-constant expression"): the four joints are written out.
- A vertex attribute left as a constant (its array disabled) puts every draw on a slow path (42 – 64 ms a frame). The overdraw count below is exact in its counts and useless as a timing.

Not here: sound. Against the Vita it lacks lighting per pixel from normal maps (the relief is cooked instead), moving lights on surfaces, lit haze volumes, bloom, rooms traced behind windows (a flat room texture stands in), glass reflections and steam.

## On a current phone

**The package installs on Android 4.3 and on Android 16, and a phone loads the library of its own ABI.** The Redmi 1S draws the frames it drew when the package held one library: a 1280 × 720 window is all picture, and captures of a frozen shot from the build before and from this one are the same bytes. What a phone of another kind meets:

- **The manifest declares `minSdkVersion` 18 and `targetSdkVersion` 34.** Android 14 installs no package that targets less than 23 (`INSTALL_FAILED_DEPRECATED_SDK_VERSION`), Android 15 none that targets less than 24. Targeting 34 takes `android:exported="true"` on the launcher's activity. **`configChanges` names every change of configuration**: the shell ends its process when its activity is destroyed, and the system destroys an activity for a change its manifest does not name (the dark theme at dusk, a font size, a display size). `resizeableActivity` is false, so the system does not put the game beside another app, and `extractNativeLibs` is true, because `loader.c` opens `libatlas.so` as a file beside `libmain.so`.
- **Two libraries from one set of sources**, both compiled with `-Wall -Wextra -Werror`:

  | | `lib/armeabi-v7a` | `lib/arm64-v8a` |
  | --- | --- | --- |
  | Compiler | `armv7a-linux-androideabi18-clang`, `-mcpu=cortex-a7 -mfpu=neon-vfpv4 -mthumb` | `aarch64-linux-android21-clang` |
  | Rust target | `armv7-linux-androideabi` | `aarch64-linux-android` |
  | Links against | API 18 | API 21, the first with 64-bit libraries |
  | Loadable segments | 4 KiB apart | **16 KiB apart** (`-Wl,-z,max-page-size=16384`), for a kernel with 16 KiB pages |

  The tool reads each library's program headers and refuses a segment aligned otherwise. A pack is mapped from the APK from the start of the page it begins in, and the page's size is the kernel's (`sysconf(_SC_PAGESIZE)`). A pack's records are fields of fixed width with no pointer in them (`n3ds/src/format.h`): both libraries read the same bytes.
- **The picture is 16:9 in a window of any shape.** `place_picture` in `main.c` takes the largest 16:9 rectangle of the window, centred. The system stretches a window's buffer over the window in each direction by itself, so the buffer is the window at the picture's scale: **on a 2400 × 1080 window the buffer is 1600 × 720, the picture is 1280 × 720 from column 160, and the phone shows it at 1920 × 1080 with 240 black pixels on each side.** The scene, the globe, the title card and the interface are drawn through that rectangle (`glViewport`); the strips beside it are cleared to black once a frame is complete; a capture reads the rectangle; a touch is measured from its corner, and a finger that comes down in a strip is not a contact. The guard's steps (720, 648, 576, 540 lines) are the picture's height, and the interface's drawable is the picture at its most lines. **On a 16:9 window the rectangle is the whole buffer**: no offset and no strips.
- **The window's size is read again** when the system reports a new configuration or a resized window. `native_app_glue` does not pass on `onNativeWindowResized`: `atlas_activity` in `main.c` is the entry `loader.c` calls, it calls the glue's and then takes that callback.
- **The bars.** `FLAG_FULLSCREEN` hides the status bar on every version. From Android 4.4 on the shell sets sticky immersive mode (`View.setSystemUiVisibility` through JNI, when the activity is made and each time its window takes the focus): the navigation bar stays hidden until a swipe from an edge. The window keeps the default display cutout mode: in landscape the system lays the window out beside a cutout, and the picture is centred in that window.
- **Frames at 30 a second without the driver's file.** A phone with no readable `/sys/class/graphics/fb0/vsync_event` reports `"refreshes":"swap"` in its status: where the refreshes fall is taken from the returns of `eglSwapBuffers` on the atlas screen, the period is 1/60 s until 120 refreshes in a row give another, and a place's frames are queued two periods apart on the app's own clock. No wait is open-ended: the fence is asked for 60 ms at most and a sleep is three periods at most.
- **What it reads and writes.** The packs, the interface and the globe come from the APK's assets; `status.json`, `interface.json` (what a visitor saved) and captures go into the app's own files directory. It asks for no permission. Outside those it reads `/proc/self/statm`, the driver's `vsync_event`, and `/data/local/tmp/<package>/`: the tool's `control.json` in every build, and pushed code, interface and packs in a development build.
- **The tool there.** An app on Android 16 reads a file `adb` pushed to `/data/local/tmp`, so a command file is obeyed as on the Redmi 1S, by a release build too. A current Android keeps the shell out of an app's directory: the tool reads a development build's `status.json` and captures as the app (`run-as`; `launch` and `status` were run that way), and a release build's files are out of reach, so `launch` and `ctl` do their work there and then fail waiting for a status. Judge a release by `adb exec-out screencap` and `adb logcat -s PocketAtlas`, which names the library and the picture's place each time a surface is made. `native` (a pushed `libatlas.so`) is for the Redmi 1S.

Checked on the Android emulator (Android 16, API 36, `arm64-v8a` alone, a 1080 × 2400 display with a cutout, the host's GPU): the release package installs and loads `lib/arm64/libatlas.so`; the title card, the atlas, the konbini, the Suga stairs and Sangubashi are drawn 1920 × 1080 in the middle of a 2264 × 1080 window (the display less its cutout), from a 1510 × 720 buffer; taps 8 to 16 pixels inside the edge of Save, of Visit and of a list row land on them and a tap in a black strip does nothing; the guard's step to 540 lines keeps the picture's place (960 × 540 in a 1132 × 540 buffer); the back key leaves a place and then the app; the process outlives a change of the dark theme, of the font scale and of the display's size. **Not checked: a 64-bit phone's own GPU and driver** (the programs have been compiled by the Adreno 305's driver and the emulator's translator), a panel faster than 60 Hz (at the menu's 60 the app swaps once a refresh, whatever the refresh is), a kernel with 16 KiB pages, and frame times anywhere but on the Redmi 1S.

## Build and run

Requirements: Bun, Rust (`rustup`, with the toolchain PocketJS pins and its `armv7-linux-androideabi` and `aarch64-linux-android` targets: `rustup target add --toolchain <pinned> <target>`), the Android SDK command line tools with **NDK 21.4.7075529** (the last that builds for API 18; it builds both libraries), build-tools 34.0.0 and platform 34, a JDK for `apksigner`, ImageMagick, and `adb`. `bun tools/atlas-android.ts doctor` checks each and the phone. With more than one device on `adb`, `ANDROID_SERIAL` names the one the tool talks to.

Export each place and its preview as for the Vita (`web/scripts/export-place.ts`, `preview-place.ts`), then:

```sh
bun tools/atlas-android.ts cook                 # → .pocket-build/android/assets/<id>.place (--place ID for one)
bun tools/atlas-android.ts install --release    # build, package (APK with every pack), install, launch
bun tools/atlas-android.ts launch
bun tools/atlas-android.ts ctl '{"place":"tokyo-konbini","shot":0,"time":25}'
bun tools/atlas-android.ts status
bun tools/atlas-android.ts capture --out .pocket-build/validation/android/view.png   # the place, at the window's size
bun tools/atlas-android.ts capture --screen                                          # the frame with the interface over it
bun tools/atlas-android.ts shots                # every authored shot: frame intervals, the panel's cadence, then a capture
bun tools/atlas-android.ts cadence              # for how many refreshes the compositor showed each of the last frames
bun tools/atlas-android.ts stop
```

MIUI asks on the screen before every `adb install` (two screens); `install` answers them through `uiautomator` and `input tap`. A development build (no `--release`) therefore has a door that keeps installs out of the edit loop: `libmain.so` opens `/data/local/tmp/dev.pocketnexus.atlas/libatlas.so` when it is there, and the shell reads the interface and packs from that directory first.

```sh
bun tools/atlas-android.ts install              # once: the development build
bun tools/atlas-android.ts native --place ID    # build, push the library and the interface (and one pack), relaunch
bun tools/atlas-android.ts native --no-title    # the same, without the title card
bun tools/atlas-android.ts unpush               # back to what the APK holds
```

A release build loads no pushed code, interface or pack and always plays the card. It takes commands and writes its status as a development build does, so `shots` measures what is installed on the Redmi 1S. `ATLAS_ANDROID_PACKAGE` installs a build beside another under its own identity (`dev.pocketnexus.atlas` otherwise). The APK is signed with PocketJS's Android debug key in `~/.cache/pocket-nexus/android/signing/`; an installed app upgrades only under the key it was signed with.

Commands are JSON, pushed as one file and acknowledged in the status: `place` (an id) enters a place and `atlas: true` leaves it; `shot` (index or name) cuts to a shot's midpoint; `time` freezes the loop at that second and a negative one releases it; `view: [x, y, z, tx, ty, tz, fov]` pins a camera; `cinematic`, `pause`, `reflection`, `rain`, `glow` are switches; `lod` is the error tolerance in pixels (1); `rate` is 30 or 60; `samples` is 0, 2 or 4; `lines` pins the window buffer's height (540 – 720) and 0 gives it back to the guard; `touch: [[x, y], …]` holds fingers on the interface (640 × 360) until a message with other contacts or none; `key: "back"` or `"menu"` presses that key; `mark: true` starts the count of frames and late frames again; `profile: true` times the GPU with a timer query on every third frame (`gpuMs`; the frames around a query lose their place in the refresh, so it is a time and not a frame rate, and the guard stands still under it).

`skip` leaves parts of the frame out to find where its time goes, as a sum of bits: 1 people, 4 what blends, 8 cutouts, 16 opaque surfaces, 32 the sky, 64 the mirror's draws, 256 one white texel for every texture, 512 the table's order instead of nearest first, 2048 no tint in the shade, 4096 and 8192 everything lit or shaded, 16384 no shadow fetch, 32768 cutouts in one stage. 128 counts overdraw: each fragment that is shaded adds a sixteenth of white.

On the phone: the atlas has the globe at the left (a finger spins it) and the lists at the right, with Save and Visit buttons and a Search list that opens a keyboard. In a place two sticks stand in the lower corners, the left to walk and the right to look, and using either leaves the tour; a tap elsewhere calls up the bar (atlas, previous and next shot, pause or tour, menu).

## Measuring

`shots` holds each authored shot at its midpoint with the loop frozen at 25 s, waits for the guard to stop changing the window, lets 240 frames go by with no traffic to the phone, then reads the status and captures. `fps` is frames queued over that window and `intervalMs` the time between two returns of `eglSwapBuffers`; `shown` is the compositor's record of the last 127 frames (`dumpsys SurfaceFlinger --latency`, also `bun tools/atlas-android.ts cadence`): for how many refreshes each stayed on the panel, so `{"2": 126}` is a steady 30 frames a second and a mix of 1 and 2 is judder that no interval read in the app shows; `late` counts frames shown a refresh or more after their turn (over 41.7 ms at 30, over 25 ms at 60); `workMs` runs from the start of the frame to the last GL call, `swapMs` is `eglSwapBuffers` and `drawnMs`, at 30 frames a second, the GPU's time from the swap to the frame's last tile. **`eglSwapBuffers` returns when a frame is queued, not when it is shown**: a place queued every 26 ms read 38 fps here with no late frame while the panel showed its frames for one refresh and two by turns, so the compositor's record is the measure. These are fixed views: a tour or a walk changes chunks and levels every few frames.

Status files are written into the app's directory world-readable and read with `adb pull`, which costs the app nothing. The receipt and captures stay in `.pocket-build/validation/android/`; device results belong in the pull request.

`shots` records the SoC's hottest sensor and the cores online with each shot (`thermal`): above about 60 °C this phone runs on two cores at 1.0 GHz, so let it rest before a run that is to be kept. The GPU's governor lowers its clock when a frame leaves slack: `drawnMs` is how long a frame took, not what it costs at full clock (`profile: true` with the rate at 60 gives that). The results of the last run are in [the main README](../README.md#redmi-1s).

Not verified by the tool: touch handling under real fingers, tours and walks (the guard does not climb back within a visit), thermal behaviour over a long session (the SoC reached 77 °C after 25 minutes of sweeps), and any phone but the Redmi 1S ([On a current phone](#on-a-current-phone) lists what the emulator showed).
