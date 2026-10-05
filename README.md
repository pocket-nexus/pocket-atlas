# Pocket Atlas

A world map of places people remember. A place is a small, self-contained 3D scene of one real spot — a street corner, a stairway, a café — pinned to its location on a shared globe. People will publish their own places (publicly or privately) and download other people's places to visit them.

This repository holds the first-party places, the pipeline that turns a place into a pack for a handheld GPU, native PS Vita, Nintendo 3DS, PSP, iPod touch 4 and Android (Redmi 1S) renderers, and the one interface they all draw. Publishing and downloading are not built yet. Vita and 3DS target 30 fps; PSP supports night streets and daytime slopes/streets through its fixed-function GE pipeline; the iPod touch draws five places from the 3DS's kind of pack; the Redmi 1S draws all seven from it at up to 1280 × 720.

The packages for each device are on [Pocket Studio](https://studio.pocket.nexus) for its members.

Places share their assets across the reference and handheld renderers:

- **`web/`** is the reference renderer: a standalone three.js + Vite app with no PocketJS dependency, with a night-side globe to pick a place. Every asset is generated at load time.
- **`vita/`** renders the same place on a PS Vita with its own GXM pipeline: Cg programs compiled on the device by SceShaccCg, 4× MSAA HDR targets and the effect set the place needs.
- **`n3ds/`** renders the globe and all seven live places on an Old 3DS, using a PICA200 cook of the same assets, native 400 × 240 output and a 30fps quality budget. See [the 3DS build and debug workflow](n3ds/README.md).
- **`psp/`** renders the globe and the places its GE pipeline supports on a PSP.
- **`ipod/`** renders the globe and five places on an iPod touch 4 (iOS 6, SGX535, OpenGL ES 2) at 480 × 320, from the 3DS lowering with GLES texels and Griffith's lights and haze cooked for it. See [how it draws, builds and is measured](ipod/README.md).
- **`android/`** renders the globe and all seven places on a Redmi 1S (Android 4.3, Adreno 305, OpenGL ES 3.0) at up to 1280 × 720 and 30 fps, from the 3DS lowering with ETC2 texels at 1024, relief cooked into the textures and the sun's shadows read per pixel from a depth map. See [how it draws, builds and is measured](android/README.md).
- **`wgpu/`** draws the atlas screen in a browser tab with wgpu over WebGPU: the iPod touch's globe in WGSL, with the interface over it and the page as any of the four handhelds. It opens no place yet. See [Browser tab](#browser-tab).
- **`ui/`** is what all of them put on the screen in two dimensions: one PocketJS app with a presentation for each form of device. See [The interface](#the-interface).

The web app exports glTF 2.0 with `extras.pocketAtlas`. The cooker seals a lossless PlaceIR, then independently lowers it into Vita, PICA, GE or GLES assets. See [the compiler boundaries, commands and migration plan](docs/COMPILER.md).

## Places

| Place | Id | Where | Rendering it drives |
| --- | --- | --- | --- |
| Rainy Night Konbini | `tokyo-konbini` | Tokyo backstreet | wet ground with a planar reflection, rain, lit haze, interior-mapped windows, baked vertex lighting, moving lights |
| Suga Shrine Stairs | `suga-shrine-stairs` | Yotsuya, Tokyo (the 男坂 stairs) | sun with a shadow map, sky occlusion baked into the vertices, alpha-tested foliage, daytime sky with a cloud panorama, ACES grade |
| Radio Kaikan at Blue Hour | `akihabara-radio-kaikan` | Akihabara, Tokyo (秋葉原ラジオ会館, the 2014 building) | twilight sky (sun below the horizon), animated LED signage (flipbooks and scrolling strips), backlit window artwork, panel lights and lamps baked with sky occlusion, pedestrians and a passing train |
| Kamakura-Kōkōmae Crossing | `kamakura-koko-mae-crossing` | Shichirigahama, Kamakura (鎌倉高校前1号踏切 on the Enoden) | open water (wave layers, Fresnel sky reflection, glitter path) to a 16 km horizon in FogExp2 haze, scrolling surf strips, flashing crossing lamps and gates driven by material and node tracks, a train, Route 134 traffic |
| Sangubashi in Bloom | `sangubashi-crossing` | Yoyogi, Tokyo (参宮橋３号踏切) | spring foliage, animated petals, an eight-car commuter train, synchronised barriers and moving sunlight shadows; Vita picture quality accepted; recorded frame-rate limits documented |
| Griffith Observatory at Blue Hour | `griffith-observatory` | Mount Hollywood, Los Angeles, over the basin (September 2015) | light fields of GXM point sprites (52k city lights, 5k moving), height haze with an inversion layer to a 71 km horizon, floodlit masonry baked into vertices, parallax windows, a resolution boost to 640×362 |
| Lombard Street in Bloom | `sf-lombard-street` | Hyde to Leavenworth, Russian Hill, San Francisco | eight surveyed switchbacks, stepped footways, red brick paving, hydrangeas and bougainvillea, bay-window houses, a clear daytime sky, a Waymo I-PACE, a Tesla Cybercab and three visitors in a 120 s loop; shared daylight adaptation for PSP |

Real places fall into a finite set of kinds; the registry names them (`PlaceKind` in `web/src/core/types.ts`): `night-street`, `daytime-slope`, `dusk-street`, `daytime-coast`, `daytime-street`, `dusk-vista` for the places built so far, and `night-slope`, `dusk-coast`, `night-coast`, `interior` and `rooftop` for the places still to come. Each first-party place brings its kind's rendering to the best quality the handheld holds, and the work goes into the shared renderer and cooker so later places of the same kind reuse it. Glass (`places/shared/glass.ts`) blends premultiplied on the web as on the device. The workflow and quality bar for making a place are in the `pocket-atlas-place` skill (`.claude/skills/pocket-atlas-place/`).

## Layout

| Path | Contents |
| --- | --- |
| `web/` | three.js reference places (`src/places/<id>`, shared code in `src/places/shared`), globe, scripts: `export-place.ts`, `export-atlas.ts`, `preview-place.ts` |
| `crates/pocket3d-place` | pack formats: `.place` (META JSON + texture, geometry and animation blobs) and the Vita's `atlas.pack` (the globe and where its pins go); sRGB helpers |
| `crates/pocket3d-place-cook` | glTF → pack: BC1/BC3/BC5 textures with mips, quantized vertices, baked vertex lighting and sky occlusion, low-poly shelf stock, octahedral environment, effect textures; the atlas pack (`atlas.rs`); annotation readers (`extras.rs`) |
| `ui/`, `tools/atlas-ui.ts` | the interface: one PocketJS app (`ui/app`), its presentations (`ui/app/presentations`), the protocol it speaks with a renderer (`ui/app/protocol.ts`), host tests (`ui/test`); the tool compiles it for a device |
| `crates/pocket-atlas-interface` | the renderer's side of that protocol for the Rust renderers (the C ones use `n3ds/src/interface.c`) |
| `vendor/pocketjs/devices/vita/pocket-vita-gxm` | Shared GXM memory/program/target/texture mechanisms, optional runtime SceShaccCg; no scene or material policy |
| `vita/` | Vita app: place loader (`scene.rs`), frame renderer (`frame.rs`), atlas globe (`atlas.rs`), the interface's guest (`interface.rs`), what a visitor can set (`settings.rs`), file locations (`paths.rs`), Cg programs (`vita/shaders`), LiveArea art |
| `psp/` | PSP app: GE rendering of the places and the globe (`globe.rs`), animated nodes and skinning, the interface's guest (`interface.rs`), procedural rain audio, PSPLINK telemetry |
| `crates/pocket3d-place-psp` | Validated `PLPS` payload: shared GE vertex buffers, spatial index chunks, swizzled RGBA4444/RGBA8888 mip chains, animation and camera data; no JSON on the device |
| `n3ds/`, `tools/atlas-3ds.ts` | PICA renderer, native cooker, paired wireless deployment, capture and performance measurement |
| `tools/atlas.ts` | cook (places and the atlas pack), build, deploy over USB, status/capture/profile/sweep/shots, shader lint, standalone VPK |
| `tools/atlas-psp.ts` | PSP cook/build, PSPLINK serve/run/control/capture/shot measurements, standalone EBOOT package |
| `ipod/`, `tools/atlas-ipod.ts` | iPod touch 4 app (the GLES 2 renderer, the globe and the shell that hosts the interface) and its cook/build/install/control/capture/measure tool |
| `android/`, `tools/atlas-android.ts` | Android app for the Redmi 1S (a NativeActivity: the GLES 3 renderer, the globe, the title card and the shell that hosts the interface) and its cook/build/package/install/control/capture/measure tool |
| `wgpu/`, `tools/wgpu.ts` | browser tab: the atlas screen's globe (`globe.rs`), the shell and the interface channel (`app.rs`), the seam of a renderer of places (`place.rs`), the page; the tool builds, serves, writes the deployable directory and checks the page in Chrome |
| `vendor/pocketjs/devices/web/pocket-web-wgpu` | Shared browser mechanisms: the WebGPU device and its screens, the interface's overlay pass, ranges of a pack over HTTP, the title card and the frame loop, the interface's guest in a realm, a handheld's controls and screens on the page; no scene |
| `vendor/pocketjs` | PocketJS: the interface's framework, UI core and per-device guest runtimes; Vita dev host and wired debug transport; 3DS paired transport and native installer; pinned PSP toolchain resolver; iPod touch 4 sysroot, startup objects and installer; the QuickJS and Rust pins the Android guest builds with |

## The interface

Everything flat on a handheld's screen (the atlas screen's lists, cards and search, a place's shots, settings and hints, the loading and error screens) is one PocketJS app, `ui/`. A renderer draws the globe or the place and hosts the app as a guest: PocketJS's UI core and QuickJS on the device, the guest's picture laid over the frame. The two talk in JSON lines over PocketJS's overlay service, answered in the process (`ui/app/protocol.ts`): the renderer says where things stand (scene, the places on the device, shots, what can be set), the interface says what the visitor asked for (turn the globe, enter, leave, cut to a shot, set an option, drive the camera).

`ui/pocket.json` declares a presentation per form of device, and PocketJS picks the one a device's modality asks for. They share every part (`ui/app/parts.tsx`) and all behaviour (`browse.ts`, `visit.ts`); a presentation decides where things go and which control means what:

| Presentation | Devices | Atlas | In a place |
| --- | --- | --- | --- |
| `single.tsx`, 480 × 272, a pad | PSP, Vita (whose panel also takes taps) | globe at the left, a card and four rows at the right; d-pad moves, ○ visits, □ saves, △ searches, L/R change list, the stick spins the globe | the scene has the screen; title and shot name fade after a few seconds; × atlas, △ menu, L/R shot, START pause |
| `dual.tsx`, 400 × 240 over 320 × 240 | 3DS | globe and card on the top screen; lists with pictures on the touch screen, scrolled by stylus or d-pad; A visits, Y saves, X searches | top: the scene; bottom: the shots as rows to tap, a pad to drag the view with, Pause, Menu and Atlas buttons |
| `touch.tsx`, 480 × 320 or 640 × 360, touch only | iPod touch, Redmi 1S | a finger spins the globe and scrolls the list; Save and Visit are buttons | two sticks at fixed places in the lower corners (left walks, right looks); a tap calls up a bar (atlas, shots, tour, menu); on the phone the back key closes a sheet or leaves and the menu key opens the menu |

Featured, Explore (nearest where the globe faces), Saved and Search are the lists everywhere. Search types into PocketJS's own keyboard, which is a grid for a d-pad and keys for a finger. A place's menu lists what its renderer offers there (frame rate, quality, effects the place has, exposure, statistics).

A renderer need not give the guest every turn: while no button or touch is down and neither the state nor the guest's picture has just changed, it looks in about once a second (`Rest` in `crates/pocket-atlas-interface`, `n3ds/src/guest.c`). The interface's own timers follow the wall clock for that reason (`ui/app/clock.ts`). A renderer sends only the fields of its state that changed.

```sh
bun tools/atlas-ui.ts <psp|vita|3ds|ipod|android>   # → .pocket-build/ui/<device>/atlas.js, atlas.pak (each device's build runs this)
(cd vendor/pocketjs && bun install && bun tools/wasm.ts)   # once, for the host tests and previews
bun test ui/test                            # each presentation on PocketJS's wasm core: presses and touches in, commands out
bun ui/test/preview.ts <psp|3ds|ipod|android>   # pictures of the screens → .pocket-build/ui/preview/
```

Place cards come from each place's preview (`web/scripts/preview-place.ts`); a place without one shows a wash of its accent.

## Title card

Every launch starts with the Pocket3D title card: the mark and the name "Pocket3D" in white on the plum ground for **144 vertical blanks at 60 Hz (2.4 s)**, then the atlas. PocketJS's `pocket3d-title` (`vendor/pocketjs/engine/pocket3d/crates/pocket3d-title`) draws it into the frame buffer before the renderer starts and before [the interface](#the-interface) boots, so it holds no texture, program or draw afterwards:

| Target | Call | Where |
| --- | --- | --- |
| PS Vita | `pocket3d_title::vita::play()` | `vita/src/main.rs`, first in `main`, before `graphics::init_with_pool` |
| PSP | `title()` → `pocket3d_title::play` | `psp/src/main.rs`, in `run()` before `renderer::init` (`sceGuInit`); `play` leaves the frame buffer as zero bytes |
| Nintendo 3DS | `pocket3d_title_play()` | `n3ds/src/main.c`, after `gfxInitDefault` (both screens BGR8) and before `C3D_Init` |
| Redmi 1S | `title()` → `atlas_title_draw` (`android/title`, `pocket3d_title::draw` in its RGBA layout) | `android/src/main.c`, first in `run()`, before `graphics()` and before the interface's bundle is read; a tick that differs from the one shown is uploaded to one texture and covers the window, and the texture is deleted when the card ends |
| Web reference | `playTitle()` | `web/src/main.ts`; `App` builds the first stage under the card and shows it when the card ends |
| Browser tab | `titleCard(playTitle)` | `wgpu/page/main.js`, first in `start`; the shell, the interface and the globe's surface are read under the card, and the canvas is shown when it ends |

A Vita development build skips the card when the USB share holds `atlas/boot.json` with `{"title": false}`; packaged builds do not read that file, and the PSP and 3DS builds have no switch. An Android development build skips it while `/data/local/tmp/<package>/no-title` exists (`bun tools/atlas-android.ts native --no-title`); a release build does not look. The web reference skips it under `?shot` and `?export`, which `export-place.ts`, `export-atlas.ts` and `preview-place.ts` pass. The iPod touch app has no card: `pocket3d-title` has no drawer for it. The Pocket3D License (`vendor/pocketjs/pocket3d/LICENSE`) makes showing the card first a condition of distributing a product built on Pocket3D.

## App icon

On the PSP, the PS Vita, the Nintendo 3DS, the iPod touch and Android the icon in the launcher is the Pocket3D icon, the same picture for every game built on Pocket3D. PocketJS holds one file per console under `vendor/pocketjs/engine/pocket3d/icon/` and each build reads it from there: **this repository holds no icon file**, and a new drawing arrives with the submodule pin.

| Target | File under `vendor/pocketjs/engine/pocket3d/icon/` | Read by |
| --- | --- | --- |
| PSP | `psp/ICON0.PNG` (144×80) | `xmb_icon_png` in `psp/Psp.toml` (cargo-psp), and `POCKET3D_ICON.psp` as the third argument of `pack-pbp` in `tools/atlas-psp.ts`, which writes the EBOOT that ships |
| PS Vita | `vita/icon0.png` (128×128, 8-bit indexed) | `packageVitaVpk({ …, icon: POCKET3D_ICON.vita })` in `tools/atlas.ts`: it replaces `sce_sys/icon0.png` in the development build and in the standalone VPK |
| Nintendo 3DS | `3ds/icon.png` (48×48) and `3ds/icon-small.png` (24×24) | `ICON` and `SMALL_ICON` in `n3ds/Makefile`, both given to `smdhtool --create` |
| iPod touch 4 | `ios/Icon.png` (57×57) and `ios/Icon@2x.png` (114×114) | `tools/atlas-ipod.ts` copies both into the bundle; `Info.plist` lists them in `CFBundleIconFiles` and sets `UIPrerenderedIcon` |

| Android | `android/mdpi.png` (48×48), `hdpi.png` (72×72), `xhdpi.png` (96×96), `xxhdpi.png` (144×144) | `tools/atlas-android.ts` copies each to `res/drawable-<density>/icon.png` in the staged resources (`POCKET3D_ICON_ANDROID`); `android/AndroidManifest.xml` names `@drawable/icon`, and `aapt --no-crunch` packs the files as they are |

The name beside the icon stays "Pocket Atlas": `TITLE` in `PARAM.SFO`, the SMDH title, `CFBundleDisplayName`, `android:label`. A capture of the game goes where a console shows a picture behind or beside the icon: `psp/assets/pic1.png` (the XMB background) and the LiveArea pictures under `vita/assets/sce_sys/livearea/contents/`. `tools/app-icon.test.ts` fails when an icon file is tracked outside `vendor/` or when a build stops reading PocketJS's. The procedure, with the checks from a built EBOOT, VPK and SMDH, is PocketJS's `pocket3d-brand` skill (`vendor/pocketjs/skills/pocket3d-brand/SKILL.md`).

## Web

```sh
cd web
bun install
bun run dev          # http://127.0.0.1:5173
```

Controls and URL switches are listed in `web/README.md`.

## Browser tab

`web/` above is the three.js reference. `wgpu/` is the game in a tab: [`wgpu/README.md`](wgpu/README.md) has the loop, the seam, the deployable directory and the measurements in full.

```sh
bun tools/wgpu.ts build     # → .pocket-build/wgpu/site
bun tools/wgpu.ts serve     # http://127.0.0.1:8788/   ?device=vita|psp|3ds|ipod
bun tools/wgpu.ts check     # Chrome over WebGPU, every device
```

- **The atlas screen, and no place yet.** The globe is `ipod/src/globe.c`'s mesh and three programs in WGSL, on wgpu 25; one renderer runs over WebGPU in a tab and over Metal on the build machine, where the two frames differ by 0 of 255.
- **The interface is the bundle a device loads**, compiled by `tools/atlas-ui.ts` for each of the four, as a guest in a realm of the page on PocketJS's UI core built for wasm. It is turned 30 times a second and told so, and rests at one turn a second. Its lines pass through `crates/pocket-atlas-interface`, unchanged.
- **The page shows one handheld and changes it while it runs**: PS Vita, PSP, Nintendo 3DS with its lower screen under the pointer, iPod touch with the pointer as a finger. A browser whose pointer is a finger gets the device's buttons on the page, and the iPod touch first.
- **No place's pack is here**, so the interface lists every place as closed, and a visit says so and stays on the atlas. `wgpu/src/place.rs` is where a renderer of places plugs in: it is handed the pack as ranges over HTTP, the GPU and the screen, and gives back the shots, the settings and the frame's passes.
- **The Pocket3D title card plays first**, over the page. A browser without WebGPU is told so in one sentence.
- **Measured** (Chrome 154, M3 Max): 30 frames a second on the PS Vita's, the PSP's and the 3DS's screens and 60 on the iPod touch's, **0.1 ms of the processor and the GPU a frame**; a redraw of the interface takes 3.8 ms at the PS Vita's 960 × 544 and 0.9 to 1.5 ms on the others. The deployable directory is 32 files and 11.7 MB; on a line of 16 Mbit/s the globe and the interface are both there after 8.3 MB, at 4.1 s.

## PSP

The app opens on the atlas: a night globe drawn by the GE (a lit sphere with city lights, a halo and a pin per place) under [the interface](#the-interface), which lists the places and enters the ones whose pack is beside the executable. In a place the analog stick moves and the d-pad looks; L/R change shots, START pauses or resumes the tour, △ opens the place's menu (tour, rain, sound and reflections where the place has them, statistics) and × returns to the atlas. HOME exits.

Lombard Street has a graded sky panorama, baked directional light and static shadows; rain and wet-road reflections are disabled by the pack's features. Export its full 120-second loop, then `cook --place sf-lombard-street`; see [the PSP daylight details and limitations](psp/README.md). Runtime and frame budgets for Lombard still require physical hardware measurement.

Rainy Night Konbini runs at **480×272**, with baked lighting, alpha-tested shelf facings, planar reflections of lit surfaces and moving objects, rain, lamp halos, the six authored camera shots, the taxi and skinned pedestrians. Walking near the entrance opens the doors and plays the door chime; the rain bed quiets indoors.

The package asks for the large memory of a PSP-2000 or later (`MEMSIZE` in `PARAM.SFO`): there the 18 MiB pack buffer fits beside the interface (about 5 MiB with its runtime). On a PSP-1000 a place whose pack does not fit is listed as not on the device.

Requirements: `usbhostfs_pc` and `pspsh`, PSPLINK running on the console, and PocketJS's pinned PSP toolchain. Run `bun tools/bootstrap.ts` in `vendor/pocketjs` to provision it. An existing SDK may be selected with `PSP_SDK=/absolute/path/to/mipsel-sony-psp`; the toolchain resolver checks that override. PocketJS's submodule stays unchanged.

```sh
# Export and cook the current checkout, with the web dev server running.
(cd web && bun scripts/export-place.ts --place tokyo-konbini --seconds 20)
bun tools/atlas-psp.ts cook                      # one place (--place ID); cook each place the PSP should carry
bun tools/atlas-psp.ts build                     # the app, the interface, the globe and every cooked place → the USB share

# Keep exactly one PSP USB host running in a terminal.
bun tools/atlas-psp.ts serve
# If a host already owns the cable, use --share /its/existing/host0 on later commands.
# In another terminal:
bun tools/atlas-psp.ts run --no-build
bun tools/atlas-psp.ts status
bun tools/atlas-psp.ts ctl '{"place":"tokyo-konbini"}'   # enter a place; {"press":["down","circle"]} presses the interface's buttons
bun tools/atlas-psp.ts ctl '{"shot":0,"time":10}'  # fixed halfway view
bun tools/atlas-psp.ts capture --out .pocket-build/validation/psp/view.bmp
bun tools/atlas-psp.ts shots                     # every authored shot, captures + measurements
bun tools/atlas-psp.ts ctl '{}'                  # live clock

# Standalone files beside each other; no USB host needed after installation.
bun tools/atlas-psp.ts package                  # dist/PSP/GAME/PocketAtlas/{EBOOT.PBP,atlas.js,atlas.pak,globe.psp,<id>.place}
```

The PSP cook starts from the same PlaceIR as Vita and 3DS, and writes `<id>.psp.place` with separate `PLPS` magic/version. It rejects unsupported place kinds and packs above 18 MiB. It preserves rigid and skeletal tracks, uses the shared cooker's coarse geometry, bakes the Products material onto world-space shelf cards, shares static vertex buffers across spatial chunks, and combines only visible chunks at draw time. GPU pointers, indices, texture layouts and animation ranges are validated before upload. The current 20-second export follows the existing Vita workflow; it does not contain the web traffic simulation's full, longer schedule.

This is a fixed-function adaptation: it does not reproduce Vita's HDR/PBR shaders, normal maps, volumetric haze, per-pixel wet ripples, dynamic per-pixel lights or bloom. The PSP's 16-bit depth and reduced texture sizes also limit fine facade detail and lettering. Reflection geometry is limited to lit surfaces and moving objects. PSP `workMs` includes CPU submission and waiting for the GE; `gpuWaitMs` is only the wait after submission, **not** serialized GPU pass timing. Captures and USB transfers must be kept outside measurement windows. Host build, physical runtime, installed-file readback, manual control feel and listening to the sound are separate evidence.

On the connected PSP (333 MHz CPU, 166 MHz bus, PSPLINK, 2026-10-01), five 30-frame windows per fixed halfway camera at t=10 with rain and reflections enabled measured: Konbini 19.9 fps, Puddles 15.0, Vending 15.0, Crossing 20.0, Inside 20.0, Wires 30.0. These are fixed-view measurements, not a claim that the live sequence or every free-camera position sustains 30 fps. The pack is 15.38 MiB with 68,206 triangles across the whole place, 38 textures, 111 animated nodes and 16 skinned chunks. PSP support remains a first port with performance and visual quality below the Vita renderer.

PSPLINK control and status live in an optional mailbox module. Standalone startup probes the control file once; without a host it performs no per-frame host0 I/O. Control writes are atomic and commands are acknowledged by nonce before measurement. The runtime validates camera bases, finite transforms, skin weights, texture grids and GE draw counts before submitting geometry.

The EBOOT carries two pictures for the XMB. `ICON0.PNG` is the 144×80 Pocket3D icon from PocketJS (see [App icon](#app-icon)). `PIC1.PNG`, the background, is `psp/assets/pic1.png`, a 480×272 capture from the PSP renderer; `psp/assets/README.md` records where it was taken.

## Vita

Requirements: VitaSDK at `~/vitasdk`, `cargo-vita`, Rust `nightly-2026-05-28` with `rust-src`, a Vita with HENkaku/Ensō and **Pocket Devkit** installed (build it with `bun tools/vita.ts devkit --release` in `vendor/pocketjs`; see its `docs/VITA-USB.md`), and `ur0:data/libshacccg.suprx` (extracted from Sony's PSM Runtime, for example with ShaRKBR33D) on the development console. Packaged builds carry compiled programs and do not need the compiler.

```sh
git submodule update --init
# 1. Export a place (dev server running) and cook it
(cd web && bun run dev) &
(cd web && bun scripts/export-place.ts --place tokyo-konbini --seconds 20)  # → .pocket-build/places/tokyo-konbini/scene.glb (the device loops the 20 s of traffic)
bun tools/atlas.ts cook --place tokyo-konbini  # → .pocket-build/places/tokyo-konbini/tokyo-konbini.place

# The atlas: the globe, and each place's preview card for the interface
(cd web && bun scripts/export-atlas.ts)       # → .pocket-build/atlas/globe/ (maps, view-ray bakes, places.json)
(cd web && bun scripts/preview-place.ts)      # → .pocket-build/places/<id>/preview.png (the registry's `preview` shot)
bun tools/atlas.ts cook-atlas                 # → .pocket-build/atlas/atlas.pack

# 2. Development loop on a console running Pocket Devkit (PocketJS apps/devkit)
bun tools/atlas.ts serve &                    # USB host
bun tools/atlas.ts native                     # sync pack + shaders, build, run in Devkit's native slot
bun tools/atlas.ts status                     # renderer telemetry under `engine`
bun tools/atlas.ts profile --shot Konbini     # GPU time per scene
bun tools/atlas.ts sweep                      # frame time per shot × quality step
bun tools/atlas.ts capture                    # → .pocket-build/validation/captures/

# 3. Standalone package (title PKAT00001): the atlas and every cooked place
bun tools/atlas.ts vpk                        # → dist/vita/pocket-atlas-PKAT00001.vpk
```

### Atlas screen

The app opens on the atlas: the web globe (sky, halo and atmosphere baked for the device's fixed camera; surface, clouds and city lights shaded per pixel at 720×408 with 4× MSAA) under [the interface](#the-interface), which says which place it faces and which pin is lit. Saved places are kept in `interface.json` in the data folder (`ux0:data/pocket-atlas`). Leaving a place frees its video memory before the next one loads.

### Settings

△ in a place opens its menu: frame rate profile (`vita30`, `vita60`, `cinematic`), quality step (the governor's, or one held), resolution, 4× MSAA, bloom, the place's lit haze, reflections and rain when it has them, exposure, and the statistics line. A resolution whose targets do not fit in video memory is refused. While the menu is on screen the governor holds its step. Choices carry to the next place and are kept in `settings.json` in the data folder; the ones not made follow the renderer's profile.

### Control messages

`ctl` messages naming a `place` enter it and `{"atlas": true}` returns; `{"press": ["down", "circle"]}` presses buttons on the interface one after another, as a thumb would.

Commands that cook, sync or measure take `--place ID` (default `tokyo-konbini`). Shader sources in `vita/shaders` hot-reload: `bun tools/atlas.ts sync` copies them to the USB share and the device recompiles the programs whose expanded source changed. Compiled programs are cached on the share by content hash; `vpk` packages the ones listed in the device's `gxp/manifest.txt`.

If a USB host is already running from another checkout, `--share /absolute/path/to/its/share` directs sync, native replacement, control, capture and measurements through that live session. Use it only when the device is available for this task; the command does not restart the existing host. Back up shared shader/atlas files before replacing them from another branch.

`bun tools/atlas.ts ctl '{"renderProfile":"vita30","view":…,"time":…,"settings":{…}}'` steers the camera and the renderer: `shot` cuts to a camera shot by index; `time` freezes the loop at that second and `view` pins a camera until a message without them. Naming a profile resets its switches and governor; `settings` then overrides them: `reflection`, `haze`, `bloom`, `rain`, `msaa`, `maxLights`, `fx`, `skip` (bits of material classes; 0x80 the sky, 0x100 the light fields), `flat`, `hud`, `profile` (serialized GPU timing), `step` and `hold` (pin a quality step), the step or profile values `detailM`, `lodPixels`, `cullSize`, `hazeSize`, `hazeLights`, `bloomFull`, `reflSize`, `streaks`, `steam`, `detailMaps`, `vertexLights`, and for light fields `fieldMin` and `fieldMax` (every field's sprite range, pixels of a 272-pixel-high frame).

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

Above step 0, `vita30` climbs to 544×308 and then 640×362 while the GPU has room. The renderer measures each frame's GPU time without serializing it: it polls the frame's last scene's notification in 0.5 ms steps while the CPU waits for the refresh. It climbs one level when the time predicted there (the measured time × (1 + 0.35 × (pixel ratio − 1))) stays under 80 % of the period for two seconds, and drops one after 3 late frames or a smoothed GPU time over 92 %, doubling the wait before the next climb. A resolution fixed in the settings sheet, or a pinned step, turns it off. Griffith Observatory holds 30.0 fps at 640×362 in every shot under the camera rig (measured GPU 14.5–24.5 ms per frame).

Static draws carry LOD1 (≤ 6 cm) and LOD2 (≤ 25 cm) index lists (chunks beyond 1 km three coarser ones, see Dusk vistas): meshoptimizer with only the vertices on chunk-cell cuts locked, and parts of plain lit surfaces narrower than a level's error (window bars, rails, curb pieces) removed at that level. A draw takes the coarsest level whose error projects under the step's pixel threshold; the mirror pass uses twice the threshold. Shelf stock switches to one card per item.

Rigid moving draws also receive LODs, with additional 1 cm and 2.5 cm candidates for small mechanical details. Their non-emissive standard surfaces can drop subpixel parts; skinned meshes keep all their joint and weight seams and do not use this simplifier. Identical complete packed vertex records and identical geometry/animation byte ranges share storage. Unused standard-material UVs and tangents are canonicalized before welding. Rain lookup textures are generated only when the place uses them; dry glass gets a small neutral bead texture.

Opaque solid standard materials without maps or special surface effects can share a `vertex_pbr` palette: sRGB vertex colour carries the albedo and UV carries each surface's roughness/metalness. Static geometry keeps its spatial chunks; fixed siblings in an animated hierarchy can share their parent's frame, keeping independent wheel or gate tracks intact. Sidedness, environment strength, depth state and other retained material fields remain batch boundaries. Static palettes separate rough non-metal surfaces from those requiring a sun highlight; moving assemblies keep one palette. The renderer reads these PBR constants in full, distant and reflection variants.

This Vita encoding requires PLCE/ATLS container version 7 (version 6 introduced light fields and vista haze). Readers reject other container versions before interpreting the payload; re-cook every Vita place and the atlas when updating the renderer. Vita Place META uses version 7, while AtlasMeta remains version 1. PICA independently keeps its PLCE v5 envelope and v3 table; PSP keeps PLPS v1. Native lowerings consume source data from PlaceIR, not the Vita palette or pack.

`bun web/scripts/place-budget.ts --in PACK.place --out REPORT.json` validates a cooked pack and estimates `vita30` step-0 main-pass geometry over the full animation loop at each shot's start, middle and end camera positions. Its draw and triangle counts are CPU planning evidence, not a GPU measurement or frame-rate claim.

Variants that drop a material's ORM map (distant, LITE and mirror programs) scale roughness, metalness and occlusion by the map's per-channel means, stored in the pack.

## Daytime places

A place exported with a directional light gets the sun per pixel: the static scene is drawn once from the sun into a 2048² shadow map (normalized distance in a single-channel R32F colour target). An RG16 cache pairs adjacent depths; lit materials compare four depths from two point reads and blend them by the sub-texel position. Only smooth or metallic materials (roughness under 0.6 or metalness over 0.3) evaluate the sun's highlight; draws beyond the detail distance skip the shadow lookup. The sun is not baked.

Places with rigid moving opaque casters use a separate 512² shadow map, refreshed each frame with sun-frustum culling and shadow-texel LOD selection. Standard materials combine it with the cached static map; distant materials keep the moving lookup so a train's shadow remains visible across the crossing. Glass and skinned particles do not cast into this layer. Shadow coordinates and depth comparisons stay float; bounded filter weights and sunlight use half precision. Sangubashi completed device compilation and six-camera capture review, including the corrected train shadows. Its picture quality was accepted with a place-specific waiver of the step-0 30 fps requirement; [the place notes](web/src/places/sangubashi-crossing/README.md) retain measured limits and distinguish pre-integration device evidence from final host builds.

Receiver bounds are projected into the light’s UV/depth space, including the normal offset and PCF footprint. Draws outside every moving caster use a shader without moving-shadow sampling. Both variants are prewarmed; camera and shadow bounds also rely on skin weights quantized to an exact sum of 255.

`shared/rigid-particles.ts` batches independent small rigid pieces into ordinary skins of at most 24 joints. The exporter records their position/rotation tracks; the runtime bounds the full joint set and uploads the shader's complete 24-joint uniform array. This keeps windborne petals animated without a place-specific particle renderer. Mesh sizes are baked into vertices, because the pack's node animation tracks carry translation and rotation, not scale.

`extras.bake.skyOcclusion` in a place's export makes the cooker cast cosine-weighted rays (48 within 1.5 m for Suga Shrine Stairs, the web's N8AO radius) from every baked vertex against a BVH of the static triangles; the unblocked share scales the hemisphere and environment terms. Edges split for it only down to 1 m near where the camera goes, coarser with distance.

A `gradient-sun-cloudpanorama` sky annotation draws the web's daytime sky (`sky_day_f.cg`; `places/shared/sky.ts` holds the day dome, the twilight dome and the cloud-panorama bake), and `extras.post` carries the tone curve (ACES or AgX), grade, vignette, grain and bloom the device bakes into its colour table.

## Signage

A material annotated `kind: "sign"` cooks as an unlit HDR surface (`color` multiplies its texture). `frames`, `cols`, `rows` and `fps` play the texture as a flipbook: frame f = ⌊(t + `phase`) · fps⌋ mod frames sits in column f mod cols, row ⌊f / cols⌋ from the top left, and the mesh's coordinates span frame 0's cell (glTF UV space, v down). `scroll: [u, v]` then moves the coordinates in texture widths per second, wrapped to 0..1. Both store as `UvAnim` in the pack; the device offsets the draw's coordinate transform each frame, so an animated sign costs what a still one does. The cooker stops a flipbook texture's mip chain while a cell is still 4 texels across, so filtering does not mix frames (the Radio Kaikan band's 32 px cells keep 4 levels), and cooks the same image separately per flipbook grid.

Every cell of a shared atlas texture (`places/shared/atlas.ts`) gets a border filled with its own edge pixels (16 px on a 4096² atlas; 8 px on Radio Kaikan's 2048² ones; 2 px on the konbini's and Suga's full 4096² atlases): a distant sign samples low mip levels, where a black border would bleed in and BC1 blocks would turn it into dark squares.

## Dusk places

A `dusk-street` place is lit by its signs after sunset:

- **Animated signs** (`places/shared/signs.ts`): see Signage.
- **Twilight sky** (`places/shared/sky.ts`): the `gradient-sun-cloudpanorama` sky with the sun below the horizon, no disc, no cloud panorama, and a `twilight` object: an afterglow `band` along the horizon weighted toward the sun's azimuth, the pink anti-twilight `belt` opposite the sun, and the Earth's `shadow` under it. The formulas are in the file header; `sky_day_f.cg` evaluates them under `TWILIGHT` (`DaySky::twilight` in the pack).

Radio Kaikan at Blue Hour bakes 25 panel lights (signs, the LED band and screen, shopfronts) and 22 point and spot lights (lantern lamps, soffit downlights, under the Sobu Line bridge) into the vertices, with `bake.skyOcclusion` (48 rays within 6 m) so the street canyon darkens toward the ground; lamp pools split edges down to 0.45 m.

## Coast places

A `daytime-coast` place adds open water to the daytime pipeline (sun with a shadow map, sky occlusion, the cloud-panorama sky):

- **Water** (`places/shared/water.ts`): a material annotated `kind: "water"` cooks as `Kind::Water` (`water_f.cg`, `surface_v.cg` under `WAVES`) and stays one draw however far it reaches (the cooker does not chunk it). Its normal map (BC5) is laid twice on the world's x/z plane, `waves: [[repeatsPerMetre, scrollX, scrollZ], …]` in m/s; `normalScale.x` scales the slopes, `roughness` is the GGX α near the camera and `distanceRoughness` adds α² per metre while the slopes flatten as 1 / (1 + 40 · d · distanceRoughness); `mask` tilts the wave faces toward the eye (the backs of the waves hide at grazing views, so far water reflects less sky). The environment probe is reflected by Schlick Fresnel (f0 = 0.02, the reflection folded above the horizon); `body` × the hemisphere sky fills the rest, mixed toward `shallow` by the mesh's vertex colour (red) over a sandy bottom; the sun adds a GGX highlight; FogExp2 on top, no shadows. The web material patches three.js' standard program to evaluate the same expressions, so the probe, sun and hemisphere it reads are the ones the exporter writes.
- **Surf** (`foamMaterial` in the same file): alpha-blended lit strips whose vertex alpha fades the foam across the surf zone and whose texture scrolls shoreward (`scroll`, the cooker's `UvAnim`); each strip is one moving node, one draw.
- **Draw budget**: within 140 m of the origin the cooker chunks static geometry into 32 m cells per material, beyond that into 256 m cells (and beyond 1 km into the growing cells of Dusk vistas), so a view along a coast pays one draw per material per cell. Kamakura-Kōkōmae Crossing paints its small props (posts, wires, fences, housings, cabinets) from one equipment atlas, merges each vehicle and each train body into one mesh and keeps far land to a few large triangles.

Kamakura-Kōkōmae Crossing loops 120 s: one Fujisawa-bound train, the crossing's 35 s warning, lamps alternating every 0.6 s, four gate arms, six vehicles on 60 s cycles and a cyclist on a 120 s one.

## Dusk vistas

A `dusk-vista` place is a lookout over a lit city at blue hour, its scene reaching tens of kilometres. What follows is the Vita's; the 3DS and the iPod touch cook the haze into vertex colours and the lights into sprites ([n3ds/README.md](n3ds/README.md#vistas), [ipod/README.md](ipod/README.md)):

- **Light fields** (`places/shared/lights.ts`): a `THREE.Points` whose material is annotated `kind: "lights"` exports as glTF POINTS with COLOR_0 and the custom attributes `_LIGHT`, `_PATH` and `_BLINK` (annotations: `lights`). The cooker sorts the lights into the cells of far terrain below, no smaller than 512 m (a wide shot over a uniform ±40 km field draws 24–32 cells and processes about 30 % of the lights where 16–19 % are in view; cells twice that size drew a third fewer field draws at Griffith Observatory's Lawn but cost 0.64 ms more GPU, the clipper's work on the extra lights outside the view), at most 16 384 per draw, and stores each light as one 40-byte vertex (`VertexLayout::Lights`): quantized position and phase, sRGB colour and twinkle, intensity, radius, path and cycles, blink cycles and duty. The Vita draws a field draw as a GXM point list (`SCE_GXM_PRIMITIVE_POINTS`, polygon mode `POINT_01UV`): `lights_v.cg` moves the light along its path (`position + path · fract(phase + cycles · t / loop)`), blinks it (on while `fract(phase + blink cycles · t / loop) < duty`), sizes the sprite (`D = radius · H / (d · tan(fovY/2))` render pixels, `S = clamp(D, minPixels, maxPixels)` with the range in pixels of a 272-pixel-high frame, at least 2 render pixels on the Vita: below that the pixel centres under a sprite no longer sum to its area), moves its depth toward the eye by `clamp(depthPull · d / 1 km, 0.002, 0.5)` of the distance d (screen position unchanged, as on the web; at grazing angles the ground under the pixels below a far light is nearer than the light), keeps its energy (`(D / S)²` while D < S), twinkles it (`1 + twinkle · min(1, d / 8 km) · 0.35 · sin(2π(13.7 · phase + 4t))`) and dims it by the vista haze's T; it writes the size to `PSIZE`, and `lights_f.cg` spreads the value over a `(1 − r²)²` profile across the sprite, whose coordinate it reads as `POINTCOORD` (the device's SceShaccCg rejects `SPRITECOORD`; the coordinate is generated only under the `POINT_01UV` and `POINT_10UV` polygon modes). Additive, depth-tested against the scene, no depth write, after the sky and before blended surfaces. Measured on the Vita (`vita30`, 480×272, 4× MSAA, serialized main pass with and without the light pass): 1.3–1.5 ms per 10 000 lights in view (2-pixel sprites; rasterization dominates: 4× MSAA adds about 35 %), 0.35–0.4 ms per 10 000 lights the clipper drops, the same for moving and static lights (one program).
- **Vista haze** (`places/shared/haze.ts`, scene annotation `haze` with an `inversion`): extinction ρ0 up to the inversion top H and ρ0 · e^(−(y − H)/s) above, optical depth `d · (G(y_p) − G(y_e)) / (y_p − y_e)` with G its antiderivative, `T = e^(−τ)`. Every material with fog takes `c · T + inscatter · (1 − T)` (premultiplied glass: the inscatter × its coverage) under `VISTA` instead of FogExp2; the light fields take T. `surface_v.cg` evaluates it per vertex (`vista.cgh`): T, and the inscatter `gain · (base + w · sun) + glow · ρ(y_p)/ρ0`: base and sun are the two parts of the sky on the horizon toward the point (the gradient's horizon and the belt; the glow lobes and the afterglow band; both under the Earth's shadow), and `w = band + (1 − band) · (1 − T)` lets the afterglow's share grow with optical depth, so far terrain meets the sky in every azimuth. The horizon depends only on the azimuth to the sun; the CPU tabulates both parts at 17 knots of `sqrt((1 − a)/2)` (`VistaHaze::sky_tables`, a the azimuth cosine; within 2 % of the dome). The fragment programs read one extra varying.
- **Cells and LOD for far terrain**: static geometry beyond 1 km of the origin chunks into cells as wide as the octave of distance they sit in (1 km cells from 1 to 2 km, 2 km cells from 2 to 4 km, up to 64 km), and those chunks carry three LOD levels at 3·10⁻⁴, 1.2·10⁻³ and 4.8·10⁻³ of their distance (a pixel of a 5° telephoto at 480×272 at the first, of a 40° view at the last). The renderer's choice by projected error holds a telephoto: its pixel is smaller, so it keeps the finer levels.
- **Window grids**: GXM has no anisotropic filtering, and its mip choice follows the denser of a texture's two directions. A window grid laying 5.3 texels per metre across and 2 up (16 windows of 3 m, 32 floors of 4 m in 256²) loses its floors from a few kilometres at 480×272. A material annotated `lodBias: "auto"` makes the cooker measure that ratio over the area the texture covers and store a negative LOD bias of its log2 (−1.42 for Griffith Observatory's towers), so the mip follows the sparser direction.
- **Depth**: reversed infinite depth into a 32-bit float buffer (`DF32M`) resolves about 3 mm at 45 km; positions quantize per chunk (16-bit over the chunk's box: 25 cm in a 16 km cell).
- **No sun**: a sun below the horizon draws no shadow map and lights nothing; the floodlights and lamps are point and spot lights baked into the vertices, and bloom carries the lit windows and the city.

The day sky's tight glow lobe takes its weight (`glow.tight[0]`) on the Vita as on the web; the places before Griffith Observatory all used 1.

## Status on hardware

Rainy Night Konbini, measured on a PS Vita 2000 (CPU 444 MHz, GPU 222 MHz) in Pocket Devkit, `vita30`, 4× MSAA, 480×272 composited and scaled to 960×544. `bun tools/atlas.ts sweep --time T` pins each step for each shot's halfway view:

| Shot | t = 100 s: step 0 | t = 72 s (taxi passing): first step at 33.3 ms |
| --- | --- | --- |
| Konbini | 33.3 ms | step 2 (step 0: 38.0 ms) |
| Puddles | 33.4 ms | step 1 (34.4 ms) |
| Vending | 33.4 ms | step 1 (36.7 ms) |
| Crossing | 33.3 ms | step 3 (37.4 ms) |
| Inside | 33.4 ms | step 0 |
| Wires | 33.4 ms | step 0 |

With the camera rig and governor running (`bun tools/atlas.ts shots --seconds 130`), every shot averages 29.5–30.0 fps; the longest smoothed frames are 41–44 ms, in Konbini and Puddles, where the governor steps down while the taxi passes. Serialized GPU time at step 0 (t = 100 s) runs from 31.2 ms (Wires) to 40.7 ms (Puddles): main pass 16–23 ms, haze 5.6 ms, bloom 3.8 ms, composite 2.2 ms, reflection 3.1 ms, display scale 1.2 ms.

Suga Shrine Stairs holds 33.3–33.4 ms at step 0 in every shot (`sweep --time 5`): Stairs, Rails, Below, Lane and Canopy draw 180–720 draws and 81k–137k triangles.

Kamakura-Kōkōmae Crossing holds 30.0 fps at step 0 in every shot with the camera rig and governor running (`shots --seconds 160`): Crossing, Postcard, Platform, Route134, Seawall and Park draw 81–263 draws and 81k–141k triangles, Platform the most. Serialized GPU time is 21.3 ms in Crossing, 20.9 ms in Platform and 23.7 ms in Seawall (main pass 13.4–16.2 ms), with the sun's shadow map drawn once at load.

Radio Kaikan at Blue Hour holds 30.0 fps at step 0 in every shot with the camera rig and governor running (`shots --seconds 130`): Arrival, Facade, Band, Vista, Corner and Clock draw 148–399 draws and 34k–61k triangles. Serialized GPU time (`profile --time 5`) is 17.9–19.5 ms: main pass 10.2–11.7 ms, bloom 4.2 ms, composite 2.1 ms, display scale 1.4 ms.

### Redmi 1S

All seven places on a Redmi 1S (Android 4.3, Adreno 305), the release build as installed, at the app's 30 frames a second with the window's height left to the guard (`bun tools/atlas-android.ts shots --rate 30`): each authored shot at its midpoint, the loop frozen at 25 s, 240 frames. "Shown" is the compositor's record of each shot's last 125 frames (`dumpsys SurfaceFlinger --latency`); "GPU" is the time from the swap's call to the frame's last tile, by a fence, at whatever clock the GPU's governor chose. The phone had rested to 41 °C and read 49 – 58 °C during the run, with one or two of its four cores online.

| Place | Shots | Window lines | fps | Shown for two refreshes | GPU ms | CPU ms | Triangles | Draws |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Rainy Night Konbini | 6 | 720 | 29.9 – 30.0 | 748 of 752 frames (99.5 %) | 17.0 – 24.7 | 4.3 – 7.1 | 73 – 172k | 31 – 132 |
| Suga Shrine Stairs | 5 | 648 → 576 | 30.0 | 623 of 627 frames (99.4 %) | 20.3 – 27.5 | 2.0 – 2.7 | 115 – 157k | 36 – 43 |
| Radio Kaikan at Blue Hour | 6 | 720 | 29.9 – 30.0 | 748 of 755 frames (99.1 %) | 16.8 – 24.8 | 1.6 – 3.7 | 51 – 113k | 43 – 112 |
| Kamakura-Kōkōmae Crossing | 6 | 720 | 29.9 – 30.0 | 752 of 755 frames (99.6 %) | 19.6 – 22.7 | 1.6 – 2.8 | 117 – 188k | 52 – 71 |
| Sangubashi in Bloom | 6 | 576 | 30.0 | 753 of 753 frames (100.0 %) | 21.9 – 26.6 | 3.2 – 7.8 | 142 – 196k | 61 – 274 |
| Griffith Observatory at Blue Hour | 6 | 720 | 30.0 | 740 of 752 frames (98.4 %) | 18.6 – 24.6 | 1.9 – 4.0 | 62 – 159k | 29 – 92 |
| Lombard Street in Bloom | 6 | 720 | 30.0 – 30.1 | 754 of 754 frames (100.0 %) | 19.6 – 28.1 | 1.6 – 3.3 | 84 – 199k | 18 – 37 |

At 60 frames a second (`shots --rate 60`, the phone at 58 – 68 °C) the guard takes the window to 540 – 648 lines: the konbini, Radio Kaikan, Kamakura and Griffith show 99.9 % of their frames for one refresh and Lombard Street 97.5 %; Suga Shrine Stairs (42.7 – 59.7 fps) and Sangubashi (41.9 – 50.4 fps) do not hold it. These are fixed views; tours and walks were not measured. See [android/README.md](android/README.md#measuring).

## Releases

`bun tools/release.ts` builds every device's package from the checked-out commit and writes them to `dist/release/`, which Git ignores:

```sh
bun tools/release.ts [--export] [--targets vita,psp,3ds,ipod-touch,android] [--out dist/release] [--vita-gxp DIR] [--no-build] [--upload]
```

| Target | File | Holds |
| --- | --- | --- |
| `vita` | `pocket-atlas-<version>.vpk` | the program, `atlas.pack`, every Vita place, the interface and the programs a console compiled |
| `psp` | `pocket-atlas-<version>-psp.zip` | `PSP/GAME/PocketAtlas/` for the root of a Memory Stick: `EBOOT.PBP`, the interface, `globe.psp` and each PSP place |
| `3ds` | `pocket-atlas-<version>-3ds.zip` | the root of the SD card: `3ds/pocket-atlas.3dsx`, and `pocket-atlas/manifest.json` with each place as `pocket-atlas/<sha256>.place`. The `.3dsx` is the only form: no CIA is built |
| `ipod-touch` | `pocket-atlas-<version>-ipod.ipa` | `Payload/PocketAtlas.app`, with the globe and each iPod place |
| `android` | `pocket-atlas-<version>.apk` | the release build for Android 4.3 and later on ARMv7 with OpenGL ES 3.0: the two libraries, the interface, the globe and each Android place, signed |

**The exports come from a browser.** `--export` writes them first, from this commit: `tools/place.ts export --place <id>` for each live place of `web/src/places/registry.ts` (→ `.pocket-build/places/<id>/`: `scene.glb`, its environment, `export.json`; **Sangubashi with `--geometry handheld`**, because its full geometry cooks to 51.7 MB for the 3DS, whose reader takes 24 MiB), then `web/scripts/export-atlas.ts` (→ `.pocket-build/atlas/globe/`) and `web/scripts/preview-place.ts` (→ each place's `preview.png`) against the reference served on a port of its own. It needs `bun install` in `web/`, Google Chrome and the GPU. Without `--export` the tool uses the exports on disk and **refuses a place whose `export.json` names other web sources than the checkout holds** (`sourceSnapshot` in `web/scripts/export-source.ts`, the identity `tools/place.ts export` seals), has another geometry than the release takes, or lists a file whose hash differs. The globe's export has no receipt; `release.json` records its hash.

**It needs the toolchains of the four device tools**: VitaSDK at `~/vitasdk` with `cargo-vita` and Rust `nightly-2026-05-28` ([Vita](#vita)); PocketJS's pinned PSP toolchain (`bun tools/bootstrap.ts` in `vendor/pocketjs`) with `pack-pbp`; Docker, for the devkitARM container, and the Rust nightly `vendor/pocketjs/hosts/3ds/core/rust-toolchain.toml` pins; the Xcode command line tools, `ldid` and PocketJS's iPod touch 4 toolchain (`bun ipodtouch4 doctor` in `vendor/pocketjs`); ImageMagick's `magick`, which cuts the interface's cards from the previews; the Android SDK's NDK 21.4.7075529 and build-tools 34.0.0 with a JDK, which `bun tools/atlas-android.ts doctor` checks.

For each target the tool cooks every live place the registry gives that target with this commit's compiler and runs the build a developer runs: `tools/atlas.ts cook`, `cook-atlas` and `vpk`; `tools/atlas-psp.ts cook` and `package`; `tools/atlas-3ds.ts cook` and `package`; `tools/atlas-ipod.ts cook` and `package`; `tools/atlas-android.ts cook` and `apk --release`. The PSP build holds PocketJS's `psp:usb` lease while it runs, as `tools/atlas-psp.ts build` does. The version is the one in `ui/pocket.json`. A target that fails is listed with its error, the other targets build, and the exit status is 1. Each step's output is in `.pocket-build/release/logs/`.

`release.json`, beside the packages, records **the commit, the version, each package's size and SHA-256, the SHA-256 of the web sources, of the globe export, of each place's `scene.glb` and `preview.png` and of each cooked pack, and the toolchains**: the pinned PocketJS revision, the `rustc` of each target, VitaSDK's compiler and `version_info.txt`, the PSP SDK's hash, the devkitARM image's digest, the NDK, the build-tools and the JDK, the SHA-256 of the certificate the Android package is signed under, and the Chrome version and GPU the exports were made with.

**The Vita's programs are an input.** SceShaccCg runs on a console, so the package carries the `.gxp` files a development run left in its share's `atlas/gxp`, the ones `manifest.txt` there lists. `--vita-gxp DIR` names that directory; the default is `.pocket-build/vita-usb/share/atlas/gxp`. Each manifest row is a program's name and its label (`standard_f.cg[BAKED,FOG,LIGHTS=0]`). Before the Vita build the tool computes every name again from `vita/shaders`, as `vita/src/shaders.rs` does: FNV-1a over the source with its includes expanded, the label's definitions and the stage. The build stops, with the reason, when the manifest is missing, when a `.gxp` is missing, and when a name differs, which is a program compiled from a source that has changed since or has left the repository. **The check does not cover completeness**: a place asks for its programs when it loads (`warm` in `vita/src/frame.rs`) and the console lists the ones it has compiled, so the set holds the programs of the places that were entered on that console, under the settings they ran with. On a console without `ur0:data/libshacccg.suprx`, a draw whose program the package does not hold is skipped.

**All five packages are byte-identical across two builds of a commit on one computer**, from the same exports. The tool writes the `.zip` files, the `.ipa` and the `.vpk` itself: entries in the order of their names (in the `.vpk`, `sce_sys/param.sfo` and `eboot.bin` first, as `vita-pack-vpk` has them), every date 1980-01-01, modes 0644 and 0755, deflate at level 6. A development build of the Vita or PSP program carries a random build id. For a release the tool names it (`POCKET_RELEASE_BUILD`, which `tools/atlas.ts` and `tools/atlas-psp.ts` read): 32 hex digits from the commit, the hashes of the exports and of the target's packs and, for the Vita, the hash of the programs' manifest; `release.json` records both. In the `.apk`, aapt dates its entries 1980-01-01, `tools/atlas-android.ts` gives the two libraries that date before `zip -X` adds them, and apksigner dates its own entries by an entry it is given; the signatures are RSA with PKCS #1 v1.5 padding, which gives the same bytes for the same input. Two exports of a commit on one computer give the same seven `scene.glb` files and the same globe; a place's `preview.png` is a capture of the running scene and differs between exports, and the card the interface compiles from it, so every package differs after `--export`.

**The Android package is signed by a key outside Git.** `tools/atlas-android.ts` signs with PocketJS's Android debug key in `~/.cache/pocket-nexus/android/signing/` (`blackberry-classic.jks` on the computer the first packages came from, alias `androiddebugkey`) and makes a key of its own when that directory holds none. A phone installs a package over an installed one only under the same certificate, so the release tool reads the certificate from the package and refuses one that is not `ANDROID_SIGNER` in `tools/release.ts` (SHA-256 `47423880…f7bfbe`). `apk --release` leaves out the door for pushed code and packs and sets `android:debuggable` to false.

**Packages go to Pocket Studio and to no page on GitHub.** `--upload` runs `pocket-studio package <file> --target <id> --version <version>` for each package from the repository's root, where `pocket-studio register --title "Pocket Atlas"` wrote `.pocket-studio.json` (ignored by Git). It refuses a checkout with uncommitted changes. It does not register the game, publish it or change its address; when the link file is missing it prints the commands that write it. `--no-build --upload` sends the packages `release.json` lists, after checking their hashes.

## License

MIT

## Creator toolchain

See [Authoring a place](docs/AUTHORING.md) for `defineDayPlace`, the compatible
`createStage` adapter, unified export/IR/recipe commands, reproducibility limits
and identity-bound device evidence. Start from the typechecked
[daytime template](web/examples/day-place.ts); keep scene-family changes in Atlas.
