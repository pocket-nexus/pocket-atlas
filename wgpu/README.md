# Pocket Atlas in a browser tab

The game drawn with [wgpu](https://wgpu.rs) over WebGPU: the atlas screen's globe and the seven places, with the game's own interface over them, shown as any of the four handhelds. **A place is the PS Vita's renderer and the PS Vita's pack** ([The places](#the-places)); it needs a GPU that reads BC textures.

| Path | Contents |
| --- | --- |
| `wgpu/src/globe.rs`, `shaders/globe.wgsl` | the atlas screen's globe: `ipod/src/globe.c`'s mesh, easing and three programs (sphere, halo, pins) |
| `wgpu/src/app.rs` | the shell: the game's side of the interface channel, the guest's turns, the flow around a place |
| `wgpu/src/place.rs` | the seam: what a renderer of places is given and what it gives back |
| `wgpu/src/places/`, `shaders/place/` | the renderer of places: the pack on the GPU (`scene.rs`), the passes (`frame.rs`), the camera (`camera.rs`), the variants and pipelines (`programs.rs`), the PS Vita's programs in WGSL |
| `wgpu/src/web.rs` | what the page calls (wasm-bindgen) |
| `wgpu/src/bin/shot.rs` | the globe or a place on the build machine's GPU, written to a PNG with each frame's time; two PNGs compared |
| `wgpu/page/` | the page: the title card first, the devices, the frame loop |
| `tools/wgpu.ts` | build, serve, the deployable directory, the capture, the check in Chrome |

What is not this game's is PocketJS's browser kernel, `vendor/pocketjs/devices/web/pocket-web-wgpu`: the WebGPU device and its screens, the pass that lays the interface over a frame, ranges of a file over HTTP, the Pocket3D title card and the frame loop, the interface's guest in PocketJS's realm, the player (the bar, a device's shell with the screens in it and its keys as the controls, the Simulated mark, the dock) with its shells, its font and its stylesheets. `tools/wgpu.ts` stages its page modules beside the page; this repository holds no copy of them.

## How it runs

```sh
bun install --cwd web && (cd vendor/pocketjs && bun install)
bun tools/wgpu.ts build     # → .pocket-build/wgpu/site
bun tools/wgpu.ts serve     # http://127.0.0.1:8788/   ?device=vita|psp|3ds|ipod
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

The keys are the buttons of the device the page shows: W A S D the stick, the arrows the d-pad, Z X C V the face buttons at the right, the bottom, the left and the top (I K J L by their place on a device with one stick), Q and E the shoulders, Shift SELECT, Space START. The pointer is the finger on a touch screen and the stylus on the 3DS's lower one. The shell's own keys, d-pad and sticks take a pointer or a finger and go down while they are held. A browser whose pointer is a finger gets the iPod touch first.

## The player

The page is the kernel's player (`createPlayer`, `pocket3d-player.js`): the bar with the game's name and the devices as text, each layout in its device's shell with the shell's keys as the controls, the Simulated mark, Controls, About, and the dock that leads to Pocket Studio. `wgpu/page/index.html` has an empty body and links the kernel's two stylesheets. What Atlas hands the player is what it says of itself (`wgpu/page/main.js`):

| | |
| --- | --- |
| `title`, `tagline` | "Pocket Atlas", "The world in your pocket." |
| `runsOn` | `psp`, `vita`, `3ds`, `ipod-touch`, `android`: the devices Atlas is built for |
| `devices` | the four layouts, each with the `note` the Simulated mark shows after the kernel's own sentence |

**The page speaks English and Japanese**, as PocketJS's player does (its README, "Languages"): `main.js` gives the game's sentence, each device's `note` and its own lines to the player as `{ en, ja }`; the player picks the language and shows the game's English for a word with no Japanese.

**Every layout draws the PS Vita build's places and the iPod touch build's globe**, so a device's note says that, then what the device itself shows:

| Device | Note |
| --- | --- |
| PS Vita | This page draws the PS Vita build's places from the same packs, at about twice the sharpness. On a PS Vita, surfaces more than 18 metres away are not shadowed by the buildings and trees around them and, unless they are wet, do not shine. The shadows of wires and railings break into dots, and the people inside the Konbini are pale. The globe here is the iPod touch build's. The PS Vita draws its own. |
| PSP | This page draws the PS Vita build's places and the iPod touch build's globe. A PSP has two of the seven places, Rainy Night Konbini and Lombard Street, with lower detail and light that is worked out when the place is built. |
| Nintendo 3DS | This page draws the PS Vita build's places and the iPod touch build's globe. A 3DS has all seven places at 400 by 240, with lower detail and light that is worked out when the place is built. |
| iPod touch | The globe is the iPod touch build's own. The places are the PS Vita build's. An iPod touch 4 has five of the seven, without Sangubashi Crossing and Lombard Street, at 480 by 320 with lower detail and light that is worked out when the place is built. |

A note changes when a device gains or loses a place (`targets` in `web/src/places/registry.ts`) or when [what differs from the PS Vita](#what-differs-from-the-ps-vita) changes.

**The dock's words come from the page's host.** The player reads `/app.json` there: the game's name and the packages Pocket Studio holds, with their sizes. Where the host answers none, the page's `pocket-app` and `pocket-studio` stand, which `dist` writes from `.pocket-studio.json` (the project this checkout is registered as; Git ignores it). `serve` answers an `/app.json` with two example packages; `serve --dist` answers none.

## Where a place's renderer plugs in

`wgpu/src/place.rs` is the whole seam. A renderer of places is one `Renderer` value named in `RENDERER`: `places::RENDERER`, which wants `TEXTURE_COMPRESSION_BC`.

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
- **Without a renderer** (`RENDERER` at `None`) `installed` is empty whatever packs the page names, and an `enter` that arrives all the same is answered at once with `error` and "Places cannot be opened in the browser yet."; the interface's way back is its own.
- **A development host's words** (`atlas.control`, or `?words=` on the page) other than `enter=<place>` and `leave` go to the open place: `shot=K part=0.5 time=25` holds the camera on a shot with the loop at a moment, `shot=off` gives it back to the tour. `atlas.status()` has the place's run under `visit`.

The page names the packs in `<meta name="pocket-places">`, a JSON object of a place's id to where its pack is; `tools/wgpu.ts build` writes one entry for each pack under `.pocket-build/places`. `app.rs`'s tests run the flow against a stub renderer: `enter` through `loading` to `place` with its shots and settings, a place's commands, another device's screen, `leave`, a pack that does not open, a place with no pack.

## The places

`wgpu/src/places/` is the PS Vita's renderer (`vita/src/frame.rs`, `scene.rs`, `camera.rs`, `vita/shaders`) on wgpu, reading **the PS Vita's packs** (`.pocket-build/places/<id>/<id>.place`, `PLCE` version 7). The page's four devices all draw it, at their own screen size.

- **Passes**: the static sun map once, from four samples a texel, and the moving casters' map every frame (Depth32Float, 2 048 and 1 024 texels a side), the mirror at half size with its blurred copy, the scene in RGBA16F with 4 samples a pixel and reversed depth, the sky, the light fields, rain and steam, the lit haze from the scene's alpha (the eye distance), bloom over five targets, and the composite through the 32-step colour table with grain, the fade and the bars.
- **Light fields** are instances of a four-vertex strip, one a light, sized in pixels in the vertex stage: WebGPU has no point size.
- **Textures** are the pack's BC1, BC3, BC5, RGBA8 and RGBA16F levels as stored, through `texture-compression-bc`. An adapter without it gets "Places need a desktop browser for now." after the pack's table and `META` (0.6 MB at most) are read; no level is transcoded.
- **Positions and texture coordinates** are bound as `sint16` and divided by 32 767 in the vertex stage. wgpu 25's Metal backend reads vertex buffers in the shader, and naga 25.0.1 unpacks `snorm16x2` and `snorm16x4` with each pair of components in the other's place.

### Variants

The 864 Cg variants are WGSL sources with a preprocessor (`programs.rs`: `#ifdef`, `#ifndef`, `#if defined()`, `#else`, `#endif`, `#define`, `#undef`).

- **A variant** is a program (`Standard`, `Unlit`, `Glass`, `Window`, `Products`, `Skyline`, `Tower`, `Water`, `Shadow`, `ShadowCut`, `Sky`, `Lights`, `Fx`, `Post`) and its sorted definitions: one shader module.
- **A pipeline** is a variant with the vertex layout, blend, cull, depth mode, depth bias, target format and samples. Both are made at the first draw that needs them and kept in a map.
- **A material's definitions** come from its record: its maps, `VERTEX_COLOR`, `VERTEX_PBR`, `ALPHA_TEST`, `BLEND`, `WET`, `PLANAR`, `DAMP`, `CLEARCOAT`, `INTERIOR`, `FOG` or `VISTA`, and for a place with a sun `SUN`, `SUN_SPEC`, `MOVING_SHADOW`. The draw adds `SKINNED` or `BAKED` (its vertex layout) and the mirror pass `REFLECTION`.
- **Three dimensions of the PS Vita's keys are gone**: the light count is a loop bound in the draw's constants (the PS Vita compiles a variant a count), and there is no `LITE` or `FAR` tier and no `VERTEX_LIGHTS`.

A place builds **18 to 31 variants and 18 to 32 pipelines**; the Konbini builds 52 and 57 on its first shot and 56 and 61 over its tour.

### What differs from the PS Vita

- **No far tier.** Past 18 m (`detail_m`) the PS Vita draws a lit surface with its `FAR` variant: no normal or ORM map, no specular term, no lookup of the static sun map. Here every distance draws the full variant. It is a choice, not a missing port, and it shows in two places: **Lombard Street's far walls are shadowed** by the buildings across the street where the console leaves them lit, and **Kamakura's traffic mirror reflects the environment** where the console's is black (a metal surface without its specular term). Restoring the tier would bring back the console's look at those two spots and remove the shadows of every caster past 18 m.
- **The sun map's casters have a depth bias** of twice their depth slope a texel, for the walls the sun grazes that the PS Vita does not look up. Without it those walls show the map's texels as a hatch.
- **The static sun map takes the nearest of four samples a texel** (`sun_resolve.wgsl`). A wire or a railing's bar is narrower than a texel (3.6 cm at Suga Shrine Stairs): with one sample a texel, as on the console, its shadow is a row of dots.
- **People inside a shop take their vertex colours in their emission.** An interior material's emission is its lighting, and the Konbini's four people materials carry their colours a vertex. The PS Vita's program adds the emission as it is, so the console draws those figures pale and flat; here the emission is multiplied by the vertex colour and by the factor the 3DS's bake uses (`pica.rs`: 0.6 + 0.4 n.y + 0.12 |n.x|, times 0.62 to 1 over the figure's height), which is the reference's indoor wardrobe.
- **960 × 544 with 4 samples** on the PS Vita's screen, where the console draws 480 × 272 to 640 × 362 and doubles it; anisotropic filtering at 8 in place of the level bias of −0.375.
- **The moving casters' map** is 1 024 texels a side (512 on the console), and the haze integrates six lights at every size.

### Loading

`Opening::needs` is the bytes a first frame needs: the table, `META`, the geometry and the animation, **9 to 24 MB of a pack of 25 to 50 MiB**. While they are read the interface's loading screen shows the place's card and "Reading the place: 12 of 18 MB". The first frame then draws every surface with its texture's mean colour (`Texture::mean`, a 1 × 1 stand-in), and the textures arrive four at a time, the environment and the effect maps first, then the smallest first; two a frame go to the GPU.

## The deployable directory

`bun tools/wgpu.ts dist` writes `.pocket-build/wgpu/dist` for a host that limits a file to 32 MiB and a deployment to 4 000 files and 1 GiB, keeps `play/` and `runtime/` at the top for itself, asks for the page again at every visit and keeps every other file for ten minutes: **185 files, 271.3 MiB** with the seven packs, the largest the PS Vita's interface pak at 4.8 MB.

| Part | Files | Contents |
| --- | --- | --- |
| `index.html`, `icon.png` | 2 | the page names its build, the surface's and the packs' manifests, and the game in Pocket Studio (`pocket-app`, `pocket-studio`) |
| `app/<build>/` | 41 | 10.0 MiB: the module, the page's script, the kernel's modules and stylesheets with `shells/` and `fonts/`, the UI core, the four interface bundles; named by a hash of its contents |
| `globe/` | 2 | the surface as one piece of 2 MiB and its manifest, each named by a hash |
| `places/<id>/` | 140 | each pack in pieces of 2 MiB and its manifest, each named by a hash: 259.3 MiB |

A read of a pack in pieces fetches the whole pieces it lies in, so a first frame takes 11 to 26 MB there against 9 to 24 MB over byte ranges.

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
- **On a line of 16 Mbit/s**, PS Vita first: **9.3 MB before the globe and the interface are both there**, the PS Vita's shell and the player's font among them. The first frame is at 2.4 s, when the title card ends; the surface is there at 2.6 s and the interface at 4.6 s.

### Places

`check` enters the Konbini from the PS Vita's list with ○, cuts a shot with R, pauses with START, opens the menu with △, walks with the stick and leaves with ✕; enters a place on the PSP's, the 3DS's and the iPod touch's pages; then holds shot 0 of every place at 25 s in the tab beside `atlas-shot` on Metal. **The two frames differ by a mean of 0.5 to 2.7 of 255 a colour** (the Konbini's rain is the 2.7).

| Place | Draws (mirror, sun map) | Triangles | Variants, pipelines | Textures, geometry | Targets at 960 × 544, 480 × 272 | A frame on Metal at 960 × 544, 480 × 272 |
| --- | --- | --- | --- | --- | --- | --- |
| Rainy Night Konbini | 287 (155, 0) | 188 000 | 52, 57 | 31.9, 16.1 MiB | 30.4, 7.6 MiB | 3.3, 2.0 ms |
| Suga Shrine Stairs | 547 (0, static) | 169 000 | 19, 19 | 25.2, 8.5 MiB | 44.5, 23.1 MiB | 3.0, 1.7 ms |
| Radio Kaikan at Blue Hour | 365 | 168 000 | 18, 18 | 18.2, 6.5 MiB | 28.5, 7.1 MiB | 1.6, 1.6 ms |
| Kamakura Koko Mae Crossing | 74 (0, 4) | 91 000 | 28, 29 | 31.2, 9.9 MiB | 48.5, 27.1 MiB | 1.5, 1.5 ms |
| Sangubashi Crossing | 246 (0, 28) | 147 000 | 23, 23 | 24.4, 15.2 MiB | 48.5, 27.1 MiB | 2.9, 1.6 ms |
| Lombard Street | 335 (0, 13) | 150 000 | 22, 22 | 12.9, 9.4 MiB | 48.5, 27.1 MiB | 2.9, 2.9 ms |
| Griffith Observatory | 261, 32 000 lights | 142 000 | 19, 19 | 16.8, 11.4 MiB | 28.5, 7.1 MiB | 2.9, 1.7 ms |

- **A frame on Metal** is `atlas-shot --tour 8`: the median of 232 frames, recorded and finished by the GPU one at a time (`device.poll(Wait)`), M3 Max. The worst is under 4.7 ms; the first frame, which makes the pipelines, is 30 to 80 ms. A second run of a place differs from the first by up to 1.2 ms.
- **In the tab** a place holds 30 frames a second on the PS Vita's and the PSP's screens (the shell's rate there), and recording a frame takes 0.3 to 0.6 ms of the page's thread (1.7 ms on the Konbini's first shot).
- **Targets** are computed from the attachments' sizes (8 bytes an HDR texel, 4 a depth texel); a place with a sun holds 16 MiB of sun map and 4 MiB of moving casters' map at any screen size, and 64 MiB more for the pass that draws the static map's samples. WebGPU reports no memory in use.

**On a line of 16 Mbit/s**, the deployable directory in a browser that has none of it, from `enter` to the first frame and to the last texture:

| Place | First frame | Every texture | First frame over byte ranges |
| --- | --- | --- | --- |
| Rainy Night Konbini | 10.5 s, 20.6 MB | 26.5 s, 54.3 MB | 9.4 s, 18.5 MB |
| Suga Shrine Stairs | 6.6 s, 13.0 MB | 18.4 s, 36.2 MB | 4.9 s, 9.5 MB |
| Radio Kaikan at Blue Hour | 5.7 s, 11.0 MB | 14.1 s, 27.9 MB | 4.5 s, 8.6 MB |
| Kamakura Koko Mae Crossing | 8.4 s, 16.5 MB | 23.3 s, 46.0 MB | 6.7 s, 12.9 MB |
| Sangubashi Crossing | 13.4 s, 26.5 MB | 25.1 s, 51.7 MB | 12.1 s, 23.8 MB |
| Lombard Street | 7.9 s, 15.6 MB | 13.5 s, 26.1 MB | 6.4 s, 12.4 MB |
| Griffith Observatory | 10.4 s, 20.5 MB | 17.8 s, 35.3 MB | 8.8 s, 17.3 MB |

The last column is the site (`check` without `--dist`), where a read fetches the bytes it asks for and not whole pieces.

## What it does not do

- **No place on a GPU without BC textures**: the packs are not transcoded, so a phone's browser gets the one sentence.
- **One look for four devices**: the PSP's, the 3DS's and the iPod touch's pages draw the PS Vita's renderer at their screen size, not those consoles' own.
- **Not compared on the console in this change**: the PS Vita captures used are earlier ones of the same shots (`.pocket-build/validation` of other checkouts).
- **No fallback renderer**: a browser without WebGPU gets the page's sentence.
- **The globe is the iPod touch's** on every device's screen. The PS Vita's own (clouds, an atmosphere baked for its camera, the surface shaded per pixel from `atlas.pack`), the 3DS's and the PSP's are not ported.
- **The search keyboard** is the interface's own, under keys and pointer; a browser's keyboard does not type into it.
- A canvas that loses its device is not restored; the page is loaded again.
- No sound.
