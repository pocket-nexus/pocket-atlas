# Pocket Atlas in a browser tab

The atlas screen drawn with [wgpu](https://wgpu.rs) over WebGPU: the globe, with the game's own interface over it, shown as any of the four handhelds. **This build opens no place.** It has no renderer of places yet, so the interface is told that no place's pack is here and lists every place as it does one a device has no pack for. [Where a place's renderer plugs in](#where-a-places-renderer-plugs-in) is defined and tested.

| Path | Contents |
| --- | --- |
| `wgpu/src/globe.rs`, `shaders/globe.wgsl` | the atlas screen's globe: `ipod/src/globe.c`'s mesh, easing and three programs (sphere, halo, pins) |
| `wgpu/src/app.rs` | the shell: the game's side of the interface channel, the guest's turns, the flow around a place |
| `wgpu/src/place.rs` | the seam: what a renderer of places is given and what it gives back |
| `wgpu/src/web.rs` | what the page calls (wasm-bindgen) |
| `wgpu/src/bin/shot.rs` | the globe on the build machine's GPU, written to a PNG; two PNGs compared |
| `wgpu/page/` | the page: the title card first, the devices, the frame loop |
| `tools/wgpu.ts` | build, serve, the deployable directory, the capture, the check in Chrome |

What is not this game's is PocketJS's browser kernel, `vendor/pocketjs/devices/web/pocket-web-wgpu`: the WebGPU device and its screens, the pass that lays the interface over a frame, ranges of a file over HTTP, the Pocket3D title card and the frame loop, the interface's guest in PocketJS's realm, a handheld's controls and screens on the page with their stylesheet. `tools/wgpu.ts` stages its page modules beside the page; this repository holds no copy of them.

## How it runs

```sh
bun install --cwd web && (cd vendor/pocketjs && bun install)
bun tools/wgpu.ts build     # → .pocket-build/wgpu/site
bun tools/wgpu.ts serve     # http://127.0.0.1:8788/   ?device=vita|psp|3ds|ipod, ?buttons
bun tools/wgpu.ts check     # Chrome over WebGPU, every device, → .pocket-build/validation/web/
```

`build` needs the wasm32 target, `wasm-bindgen` at the version in `wgpu/Cargo.lock`, ImageMagick, the globe's export (`.pocket-build/atlas/globe`, `web/scripts/export-atlas.ts`) and, for the cards' pictures, each place's preview (`.pocket-build/places/<id>/preview.png`). A place without a preview is listed with a wash of its accent colour.

- **The interface is the bundle a device loads.** `tools/atlas-ui.ts` compiles `ui/` for the PSP, the PS Vita, the 3DS and the iPod touch; the page runs the chosen device's bundle as a guest in a realm of its own on PocketJS's UI core built for wasm, with the `plan.json` PocketJS resolved for it. The screens, the raster density and the surface that takes touch are read from the plan.
- **The guest is turned 30 times a second and told so**, as each handheld's host does (`__simHz`), with 2 sixtieths of a second a turn. It rests when no button or touch is down and neither the state nor its picture changed (`pocket_atlas_interface::Rest`): **one turn a second at rest**, with the sixtieths that passed.
- **A frame** is `step` (the globe eases to the place it faces; the left stick spins it unless a sheet of the interface holds the pad), the guest's turn when one is due (`heard`, the turn, `say` for each line, `turned`), then `draw`: the globe in the scene's pass, the interface's picture over it in a pass of its own.
- **The interface's picture is drawn again when its draw hash changes**: one drawing by the UI core with its alpha, then an upload. The 3DS's lower screen goes to a second canvas when its own hash changes.
- **The globe's surface** is `tools/atlas-globe.ts`'s at 1 024 by 512 texels (2 MiB of RGBA: the daylight albedo, the city lights in alpha), read through the kernel's `Source::all`: one `Range` request after a request for its length, or the one piece of the deployable directory. The levels under it are made on the processor. The iPod touch and the PSP read 512 by 256.
- **The Pocket3D title card plays first**, over the page, while the interface and the surface are read. A browser without WebGPU is told so in one sentence.
- **Saved places are kept by the page** (`localStorage`, key `pocket-atlas.interface`) and handed back to the interface at the next visit, as a device's file is.

The keys are the buttons of the device the page shows: W A S D the stick, the arrows the d-pad, Z X C V the face buttons at the right, the bottom, the left and the top (I K J L by their place on a device with one stick), Q and E the shoulders, Shift SELECT, Space START. The pointer is the finger on a touch screen and the stylus on the 3DS's lower one. A browser whose pointer is a finger gets the device's buttons on the page, and the iPod touch first.

## Where a place's renderer plugs in

`wgpu/src/place.rs` is the whole seam. `RENDERER` is `None` in this build; a renderer of places is one `Renderer` value named there.

| The shell hands the renderer | |
| --- | --- |
| `Opening::pack` | the place's pack as the kernel's `Source`: `range(offset, size)`, `length()`, `all()`. A file on a server that answers byte ranges, or the manifest of a pack cut into pieces |
| `Opening::gpu` | the device, opened with those of `Renderer::wants` the adapter has (`gpu.features`): the compressed texture formats the renderer can read |
| `Opening::format`, `Opening::shape` | the screen: its format, its size in pixels, its samples, its logical size |
| `Opening::place` | the place's id |

| The renderer gives back a `Place` | |
| --- | --- |
| `shots()` | the authored shots' names: the interface's `shots` |
| `shown()` | after every step: `shot`, `tour`, `paused`, `options`, `stats` |
| `obey(command)` | the commands that are a place's: `Shot`, `Tour`, `Pause`, `Option`, `Drive`, `Look` |
| `step(dt, held, free)` | the page's pad; `free` is false while the interface holds it |
| `reshape(gpu, format, shape)` | another device's screen while the place is open |
| `draw(gpu, encoder, frame)` | every pass of the place, the last into `frame`; the shell lays the interface over it, submits and presents |

The flow is the shell's and holds without a renderer:

- `enter`: `scene` is `loading` while `Renderer::open`'s future runs beside the frames, then `place`, or `error` with the renderer's message. The globe is drawn until the place is.
- `leave`: the `Place` is dropped, and what it holds on the GPU with it.
- **Without a renderer** `installed` is empty whatever packs the page names, and an `enter` that arrives all the same is answered at once with `error` and "Places cannot be opened in the browser yet."; the interface's way back is its own.

The page names the packs in `<meta name="pocket-places">`, a JSON object of a place's id to where its pack is; `tools/wgpu.ts` writes none. `app.rs`'s tests run the flow against a stub renderer: `enter` through `loading` to `place` with its shots and settings, a place's commands, another device's screen, `leave`, a pack that does not open, a place with no pack.

## The deployable directory

`bun tools/wgpu.ts dist` writes `.pocket-build/wgpu/dist` for a host that limits a file to 32 MiB and a deployment to 4 000 files and 1 GiB, keeps `play/` and `runtime/` at the top for itself, asks for the page again at every visit and keeps every other file for ten minutes: **32 files, 11.7 MB**, the largest the PS Vita's interface pak at 4.8 MB.

| Part | Files | Contents |
| --- | --- | --- |
| `index.html`, `icon.png` | 2 | the page names its build and the surface's manifest |
| `app/<build>/` | 28 | the module, the page's scripts, the kernel's modules and stylesheet, the UI core, the four interface bundles; named by a hash of its contents |
| `globe/` | 2 | the surface as one piece of 2 MiB and its manifest, each named by a hash |

`bun tools/wgpu.ts serve --dist` serves it as such a host does, with no byte ranges. Nothing here uploads it.

## Measured

Chrome 154 headless, WebGPU on the Apple GPU (Metal 3, not the fallback adapter), M3 Max, served from loopback, 2026-10-06. `bun tools/wgpu.ts check` and `check --dist` both pass.

| | PS Vita | PSP | Nintendo 3DS | iPod touch |
| --- | --- | --- | --- | --- |
| Scene, with 4 samples a pixel | 960 × 544 | 480 × 272 | 400 × 240 | 480 × 320 |
| Frames a second | 30.0 | 30.0 | 30.0 | 59.9 |
| A frame without waiting for the display (300 frames) | 0.10 ms | 0.10 ms | 0.09 ms | 0.10 ms |
| A turn of the guest | 0.06 ms | 0.06 ms | 0.09 ms | 0.06 ms |
| A redraw of the interface | 3.8 ms | 1.3 ms | 0.9 ms | 1.5 ms |
| of which the UI core's drawing | 2.9 ms | 1.1 ms | 0.7 ms | 1.2 ms |
| A redraw of the lower screen | | | 0.6 ms | |

- **The tab's frame is the build machine's**: the globe alone on the iPod touch's screen, the tab's canvas beside `atlas-shot` on Metal, differs by 0 of 255 in every pixel.
- **Beside the PSP build in PPSSPP** (the release package's atlas screen, the same place focused): the interface's legend bar differs by a mean of 0.8 of 255 a colour; the globe's disc by 7.5, because the PSP draws its globe with the GE's fixed pipeline (two layers and square pins) and this is the iPod touch's program.
- **Sizes**: the module is 404 KB (133 KB gzip), its JavaScript 68 KB, the UI core 365 KB, the surface 2 097 KB (639 KB gzip). The interface: 318 KB of script for each device, and a pak of 4 778 KB (PS Vita, the cards at two samples a pixel), 415 KB (PSP), 1 202 KB (3DS), 940 KB (iPod touch).
- **On a line of 16 Mbit/s**, PS Vita first: **8.3 MB before the globe and the interface are both there**. The first frame is at 2.4 s, when the title card ends; the surface is there at 2.3 s and the interface at 4.1 s.

## What it does not do

- **No place opens**: there is no renderer of places.
- **No fallback renderer**: a browser without WebGPU gets the page's sentence.
- **The globe is the iPod touch's** on every device's screen. The PS Vita's own (clouds, an atmosphere baked for its camera, the surface shaded per pixel from `atlas.pack`), the 3DS's and the PSP's are not ported.
- **The search keyboard** is the interface's own, under keys and pointer; a browser's keyboard does not type into it.
- A canvas that loses its device is not restored; the page is loaded again.
- No sound.
