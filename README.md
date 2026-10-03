# Pocket Atlas

A world map of places people remember. A place is a small, self-contained 3D scene of one real spot — a street corner, a stairway, a café — pinned to its location on a shared globe. People will publish their own places (publicly or privately) and download other people's places to visit them.

This repository holds the first-party places, the pipeline that turns a place into a pack for a handheld GPU, and native PS Vita, Nintendo 3DS and PSP renderers. Publishing and downloading are not built yet. Vita and 3DS target 30 fps; PSP supports Rainy Night Konbini and Sangubashi through its fixed-function GE pipeline.

Places share their assets across the reference and handheld renderers:

- **`web/`** is the reference renderer: a standalone three.js + Vite app with no PocketJS dependency, with a night-side globe to pick a place. Every asset is generated at load time.
- **`vita/`** renders the same place on a PS Vita with its own GXM pipeline: Cg programs compiled on the device by SceShaccCg, 4× MSAA HDR targets and the effect set the place needs.
- **`n3ds/`** renders the shared globe, place browser and five scenes on an Old 3DS, using a PICA200 cook of the same assets, native 400 × 240 output and a 30fps quality budget. See [the 3DS build and debug workflow](n3ds/README.md).

The web app exports glTF 2.0 with `extras.pocketAtlas`. The cooker seals a lossless PlaceIR, then independently lowers it into Vita, PICA or GE assets. See [the compiler boundaries, commands and migration plan](docs/COMPILER.md).

## Places

| Place | Id | Where | Rendering it drives |
| --- | --- | --- | --- |
| Rainy Night Konbini | `tokyo-konbini` | Tokyo backstreet | wet ground with a planar reflection, rain, lit haze, interior-mapped windows, baked vertex lighting, moving lights |
| Suga Shrine Stairs | `suga-shrine-stairs` | Yotsuya, Tokyo (the 男坂 stairs) | sun with a shadow map, sky occlusion baked into the vertices, alpha-tested foliage, daytime sky with a cloud panorama, ACES grade |
| Radio Kaikan at Blue Hour | `akihabara-radio-kaikan` | Akihabara, Tokyo (秋葉原ラジオ会館, the 2014 building) | twilight sky (sun below the horizon), animated LED signage (flipbooks and scrolling strips), backlit window artwork, panel lights and lamps baked with sky occlusion, pedestrians and a passing train |
| Kamakura-Kōkōmae Crossing | `kamakura-koko-mae-crossing` | Shichirigahama, Kamakura (鎌倉高校前1号踏切 on the Enoden) | open water (wave layers, Fresnel sky reflection, glitter path) to a 16 km horizon in FogExp2 haze, scrolling surf strips, flashing crossing lamps and gates driven by material and node tracks, a train, Route 134 traffic |
| Sangubashi in Bloom | `sangubashi-crossing` | Yoyogi, Tokyo (参宮橋３号踏切) | spring foliage, animated petals, an eight-car commuter train, synchronised barriers and moving sunlight shadows; Vita picture quality accepted; recorded frame-rate limits documented |
| Griffith Observatory at Blue Hour | `griffith-observatory` | Mount Hollywood, Los Angeles, over the basin (September 2015) | light fields of GXM point sprites (52k city lights, 5k moving), height haze with an inversion layer to a 71 km horizon, floodlit masonry baked into vertices, parallax windows, a resolution boost to 640×362 |

Real places fall into a finite set of kinds; the registry names them (`PlaceKind` in `web/src/core/types.ts`): `night-street`, `daytime-slope`, `dusk-street`, `daytime-coast`, `daytime-street`, `dusk-vista` for the places built so far, and `night-slope`, `dusk-coast`, `night-coast`, `interior` and `rooftop` for the places still to come. Each first-party place brings its kind's rendering to the best quality the handheld holds, and the work goes into the shared renderer and cooker so later places of the same kind reuse it. Glass (`places/shared/glass.ts`) blends premultiplied on the web as on the device. The workflow and quality bar for making a place are in the `pocket-atlas-place` skill (`.claude/skills/pocket-atlas-place/`).

## Layout

| Path | Contents |
| --- | --- |
| `web/` | three.js reference places (`src/places/<id>`, shared code in `src/places/shared`), globe, scripts: `export-place.ts`, `export-atlas.ts`, `preview-place.ts` |
| `crates/pocket3d-place` | pack formats: `.place` (META JSON + texture, geometry and animation blobs) and `atlas.pack` (globe, place list, preview cards, interface font); sRGB helpers |
| `crates/pocket3d-place-cook` | glTF → pack: BC1/BC3/BC5 textures with mips, quantized vertices, baked vertex lighting and sky occlusion, low-poly shelf stock, octahedral environment, effect textures; the atlas pack and its baked font (`atlas.rs`, `uifont.rs`); annotation readers (`extras.rs`) |
| `vendor/pocketjs/devices/vita/pocket-vita-gxm` | Shared GXM memory/program/target/texture mechanisms, optional runtime SceShaccCg; no scene or material policy |
| `vita/` | Vita app: place loader (`scene.rs`), frame renderer (`frame.rs`), atlas globe (`atlas.rs`), place browser (`browser.rs`), settings sheet (`settings.rs`), interface drawing and text (`ui.rs`), file locations (`paths.rs`), Cg programs (`vita/shaders`), LiveArea art |
| `psp/` | Native PSP place viewer: GE rendering, animated nodes and skinning, camera controls, procedural environmental audio, PSPLINK telemetry |
| `crates/pocket3d-place-psp` | Validated `PLPS` payload: shared GE vertex buffers, spatial index chunks, swizzled RGB565/RGBA4444 mip chains, animation and camera data; no JSON on the device |
| `n3ds/`, `tools/atlas-3ds.ts` | PICA renderer, native cooker, paired wireless deployment, capture and performance measurement |
| `tools/atlas.ts` | cook (places and the atlas with its font), build, deploy over USB, status/capture/profile/sweep/shots, shader lint, standalone VPK |
| `tools/atlas-psp.ts` | PSP cook/build, PSPLINK serve/run/control/capture/shot measurements, standalone EBOOT package |
| `vendor/pocketjs` | PocketJS: Vita dev host and wired debug transport; 3DS paired transport and native installer; pinned PSP toolchain resolver |

## Web

```sh
cd web
bun install
bun run dev          # http://127.0.0.1:5173
```

Controls and URL switches are listed in `web/README.md`.

## PSP

Sangubashi adds a cooked daytime sky and drifting clouds, baked sunlight,
the eight-car train and gates, independently animated petals, and procedural
wind, birds, railway warning and wheel noise. Its complete loop is 64 seconds;
use `--place sangubashi-crossing` for cook/build/package and `shots --time 19.73`
for a fixed train-pass comparison. See [the scene
notes](web/src/places/sangubashi-crossing/README.md) for native results.

Rainy Night Konbini runs locally at **480×272**, with baked lighting, alpha-tested shelf facings, planar reflections of lit surfaces and moving objects, rain, lamp halos, the six authored camera shots, the taxi and skinned pedestrians. The analog stick moves; the D-pad looks. L/R change shots, START resumes the camera sequence, × pauses, □ toggles rain, △ toggles reflections, ○ mutes sound, and SELECT toggles the diagnostic readout. Walking near the entrance opens the doors and plays the door chime; the rain bed quiets indoors. HOME exits.

Requirements: `usbhostfs_pc` and `pspsh`, PSPLINK running on the console, and PocketJS's pinned PSP toolchain. Run `bun tools/bootstrap.ts` in `vendor/pocketjs` to provision it. An existing SDK may be selected with `PSP_SDK=/absolute/path/to/mipsel-sony-psp`; the toolchain resolver checks that override. PocketJS's submodule stays unchanged.

```sh
# Export and cook the current checkout, with the web dev server running.
(cd web && bun scripts/export-place.ts --place tokyo-konbini --seconds 20)
bun tools/atlas-psp.ts cook
bun tools/atlas-psp.ts build

# Keep exactly one PSP USB host running in a terminal.
bun tools/atlas-psp.ts serve
# If a host already owns the cable, use --share /its/existing/host0 on later commands.
# In another terminal:
bun tools/atlas-psp.ts run --no-build
bun tools/atlas-psp.ts status
bun tools/atlas-psp.ts ctl '{"shot":0,"time":10}'  # fixed halfway view
bun tools/atlas-psp.ts capture --out .pocket-build/validation/psp/view.bmp
bun tools/atlas-psp.ts shots                     # every authored shot, captures + measurements
bun tools/atlas-psp.ts ctl '{}'                  # live clock

# Standalone files beside each other; no USB host needed after installation.
bun tools/atlas-psp.ts package                  # dist/PSP/GAME/PocketAtlas/{EBOOT.PBP,scene.place}
```

The PSP cook starts from the same PlaceIR as Vita and 3DS, and writes `<id>.psp.place` with separate `PLPS` magic/version. It rejects unsupported place kinds and packs above 18 MiB. It preserves rigid and skeletal tracks, selects geometric detail by camera distance, bakes the Products material onto world-space shelf cards, shares static vertex buffers across spatial chunks, and combines only visible chunks at draw time. GPU pointers, indices, texture layouts and animation ranges are validated before upload. The current 20-second export follows the existing Vita workflow; it does not contain the web traffic simulation's full, longer schedule.

This is a fixed-function adaptation: it does not reproduce Vita's HDR/PBR shaders, normal maps, volumetric haze, per-pixel wet ripples, dynamic per-pixel lights or bloom. The PSP's 16-bit depth and reduced texture sizes also limit fine facade detail and lettering. Reflection geometry is limited to lit surfaces and moving objects. The atlas globe and multi-place browser are not part of the PSP viewer. PSP `workMs` includes CPU submission and waiting for the GE; `gpuWaitMs` is only the wait after submission, **not** serialized GPU pass timing. Captures and USB transfers must be kept outside measurement windows. Host build, physical runtime, installed-file readback, manual control feel and listening to the sound are separate evidence.

On the connected PSP (333 MHz CPU, 166 MHz bus, PSPLINK, 2026-10-01), five 30-frame windows per fixed halfway camera at t=10 with rain and reflections enabled measured: Konbini 19.9 fps, Puddles 15.0, Vending 15.0, Crossing 20.0, Inside 20.0, Wires 30.0. These are fixed-view measurements, not a claim that the live sequence or every free-camera position sustains 30 fps. The pack is 15.38 MiB with 68,206 triangles across the whole place, 38 textures, 111 animated nodes and 16 skinned chunks. PSP support remains a first port with performance and visual quality below the Vita renderer.

PSPLINK control and status live in an optional mailbox module. Standalone startup probes the control file once; without a host it performs no per-frame host0 I/O. Control writes are atomic and commands are acknowledged by nonce before measurement. The runtime validates camera bases, finite transforms, skin weights, texture grids and GE draw counts before submitting geometry.

`psp/Psp.toml` embeds the 144×80 Pocket Atlas icon and a 480×272 PSP scene capture as the XMB background. Artwork sources and regeneration instructions live in `psp/assets/`.

## Vita

Requirements: VitaSDK at `~/vitasdk`, `cargo-vita`, Rust `nightly-2026-05-28` with `rust-src`, a Vita with HENkaku/Ensō and **Pocket Devkit** installed (build it with `bun tools/vita.ts devkit --release` in `vendor/pocketjs`; see its `docs/VITA-USB.md`), and `ur0:data/libshacccg.suprx` (extracted from Sony's PSM Runtime, for example with ShaRKBR33D) on the development console. Packaged builds carry compiled programs and do not need the compiler.

```sh
git submodule update --init
# 1. Export a place (dev server running) and cook it
(cd web && bun run dev) &
(cd web && bun scripts/export-place.ts --place tokyo-konbini --seconds 20)  # → .pocket-build/places/tokyo-konbini/scene.glb (the device loops the 20 s of traffic)
bun tools/atlas.ts cook --place tokyo-konbini  # → .pocket-build/places/tokyo-konbini/tokyo-konbini.place

# The atlas: the globe, the place list, each place's preview card and the interface font
# (cook-atlas fetches Noto Sans CJK JP Medium/Bold into .pocket-build/fonts once and checks their SHA-256)
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

The app opens on the atlas: the web globe (sky, halo and atmosphere baked for the device's fixed camera; surface, clouds and city lights shaded per pixel at 720×408 with 4× MSAA) and the place browser beside it. L and R switch its lists:

- **Featured**: the registry's `featured` places.
- **Explore**: every place, nearest the point the globe faces first; the list re-sorts while the left stick spins the globe.
- **Saved**: △ on a place; kept in `saved.json` in the data folder (`ux0:data/pocket-atlas`).
- **Search**: □ opens the system keyboard; each word must match the name, native name, locality, country, tags, kind or author.

Up/down moves through the list and turns the globe to the place; the focused row opens into a postcard with the place's preview (`scripts/preview-place.ts` captures it; the cooker crops it to 2:1 and stores 512×256 BC1 in `atlas.pack`), kind, tags and author. × or ○ enters an open place, START returns to the atlas. Leaving a place frees its video memory before the next one loads.

### Interface text

The interface's text is baked into `atlas.pack`: the cooker rasterizes Inter (from PocketJS) and Noto Sans CJK JP Medium/Bold at the styles of `pocket3d_place::atlas::STYLES` (13–34 px) 1:1 for the 960×544 display into one 8-bit coverage atlas (the `FONT` section; glyph table in `META.font`). The Vita draws each string as one draw on whole pixels. The charset is ASCII, Latin-1, Latin Extended-A, `UI_EXTRA` and every character in the places' strings; a cooker test fails when the Vita code writes a character outside it. A string with a character the atlas lacks (a search typed with the keyboard, scripts such as Devanagari) falls back to the system's vector fonts (PVF).

### Settings sheet

SELECT in a place opens the settings sheet: frame rate profile (`vita30`, `vita60`, `cinematic`), quality step (the governor's, or one held), resolution, 4× MSAA, bloom, the place's lit haze, reflections and rain when it has them, exposure (±2 EV), the camera shot and the performance overlay; △ resets the choices. A resolution whose targets do not fit in video memory is refused. While the sheet is on screen the governor holds its step: the sheet's own cost (about 1 ms at step 0 on Rainy Night Konbini) is in those frame times. Choices carry to the next place and are kept in `settings.json` in the data folder; the ones not made follow the renderer's profile.

### Control messages

`ctl` messages naming a `place` enter it; `{"atlas": true}` returns, and takes `tab` (`featured`, `explore`, `saved`, `search`), `search` (a query), `select` and `save` (place ids) and `keyboard: true` (opens the search keyboard). In a place, `sheet` (true or false) opens or closes the settings sheet, `sheetRow` focuses a row by its label (`"Resolution"`), and `sheetReset: true` drops the saved choices as △ does.

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

This Vita encoding requires PLCE/ATLS container version 7 (version 6 introduced light fields and vista haze). Readers reject other container versions before interpreting the payload; re-cook every Vita place and the atlas when updating the renderer. Vita Place META uses version 7, while AtlasMeta remains version 1. PICA independently keeps its PLCE v5 envelope with a v4 table; PSP uses PLPS v2. Native lowerings consume source data from PlaceIR, not the Vita palette or pack.

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

A `dusk-vista` place is a lookout over a lit city at blue hour, its scene reaching tens of kilometres:

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

## License

MIT
