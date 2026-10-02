# Pocket Atlas

A world map of places people remember. A place is a small, self-contained 3D scene of one real spot — a street corner, a stairway, a café — pinned to its location on a shared globe. People will publish their own places (publicly or privately) and download other people's places to visit them.

This repository holds the first-party places, the pipeline that turns a place into a pack for a handheld GPU, and the PS Vita renderer. Publishing and downloading are not built yet; the current work is distributing places at the highest image quality the PS Vita can hold at 30 fps.

Every place exists twice:

- **`web/`** is the reference renderer: a standalone three.js + Vite app with no PocketJS dependency, with a night-side globe to pick a place. Every asset is generated at load time.
- **`vita/`** renders the same place on a PS Vita with its own GXM pipeline: Cg programs compiled on the device by SceShaccCg, 4× MSAA HDR targets and the effect set the place needs.

A pack connects the two: the web app exports a place as glTF 2.0 with `extras.pocketAtlas`, and the cooker (`crates/pocket3d-place-cook`) turns it into a `.place` pack for the handheld GPU.

## Places

| Place | Id | Where | Rendering it drives |
| --- | --- | --- | --- |
| Rainy Night Konbini | `tokyo-konbini` | Tokyo backstreet | wet ground with a planar reflection, rain, lit haze, interior-mapped windows, baked vertex lighting, moving lights |
| Suga Shrine Stairs | `suga-shrine-stairs` | Yotsuya, Tokyo (the 男坂 stairs) | sun with a shadow map, sky occlusion baked into the vertices, alpha-tested foliage, daytime sky with a cloud panorama, ACES grade |
| Radio Kaikan at Blue Hour | `akihabara-radio-kaikan` | Akihabara, Tokyo (秋葉原ラジオ会館, the 2014 building) | twilight sky (sun below the horizon), animated LED signage (flipbooks and scrolling strips), backlit window artwork, panel lights and lamps baked with sky occlusion, pedestrians and a passing train |
| Kamakura-Kōkōmae Crossing | `kamakura-koko-mae-crossing` | Shichirigahama, Kamakura (鎌倉高校前1号踏切 on the Enoden) | open water (wave layers, Fresnel sky reflection, glitter path) to a 16 km horizon in FogExp2 haze, scrolling surf strips, flashing crossing lamps and gates driven by material and node tracks, a train, Route 134 traffic |
| Sangubashi in Bloom | `sangubashi-crossing` | Yoyogi, Tokyo (参宮橋３号踏切) | spring foliage, animated petals, an eight-car commuter train, synchronised barriers and moving sunlight shadows; Vita compile/captures verified, performance acceptance pending |

Real places fall into a finite set of kinds; the registry names them (`PlaceKind` in `web/src/core/types.ts`): `night-street`, `daytime-slope`, `dusk-street`, `daytime-coast` and the Three.js `daytime-street` reference for the places built so far, and `night-slope`, `dusk-coast`, `night-coast`, `interior` and `rooftop` for the places still to come. Each first-party place brings its kind's rendering to the best quality the handheld holds, and the work goes into the shared renderer and cooker so later places of the same kind reuse it. Glass (`places/shared/glass.ts`) blends premultiplied on the web as on the device. The workflow and quality bar for making a place are in the `pocket-atlas-place` skill (`.claude/skills/pocket-atlas-place/`).

## Layout

| Path | Contents |
| --- | --- |
| `web/` | three.js reference places (`src/places/<id>`, shared code in `src/places/shared`), globe, scripts: `export-place.ts`, `export-atlas.ts`, `preview-place.ts` |
| `crates/pocket3d-place` | pack formats: `.place` (META JSON + texture, geometry and animation blobs) and `atlas.pack` (globe, place list, preview cards, interface font); sRGB helpers |
| `crates/pocket3d-place-cook` | glTF → pack: BC1/BC3/BC5 textures with mips, quantized vertices, baked vertex lighting and sky occlusion, low-poly shelf stock, octahedral environment, effect textures; the atlas pack and its baked font (`atlas.rs`, `uifont.rs`); annotation readers (`extras.rs`) |
| `crates/pocket3d-gxm` | GXM layer: GXP registration and patching, own shader patcher, render targets, texture upload, runtime SceShaccCg |
| `vita/` | Vita app: place loader (`scene.rs`), frame renderer (`frame.rs`), atlas globe (`atlas.rs`), place browser (`browser.rs`), settings sheet (`settings.rs`), interface drawing and text (`ui.rs`), file locations (`paths.rs`), Cg programs (`vita/shaders`), LiveArea art |
| `tools/atlas.ts` | cook (places and the atlas with its font), build, deploy over USB, status/capture/profile/sweep/shots, shader lint, standalone VPK |
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

`bun tools/atlas.ts ctl '{"renderProfile":"vita30","view":…,"time":…,"settings":{…}}'` steers the camera and the renderer: `shot` cuts to a camera shot by index; `time` freezes the loop at that second and `view` pins a camera until a message without them. Naming a profile resets its switches and governor; `settings` then overrides them: `reflection`, `haze`, `bloom`, `rain`, `msaa`, `maxLights`, `fx`, `skip`, `flat`, `hud`, `profile` (serialized GPU timing), `step` and `hold` (pin a quality step), and the step or profile values `detailM`, `lodPixels`, `cullSize`, `hazeSize`, `hazeLights`, `bloomFull`, `reflSize`, `streaks`, `steam`, `detailMaps`, `vertexLights`.

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

Rigid moving draws also receive LODs, with additional 1 cm and 2.5 cm candidates for small mechanical details. Their non-emissive standard surfaces can drop subpixel parts; skinned meshes keep all their joint and weight seams and do not use this simplifier. Identical complete packed vertex records and identical geometry/animation byte ranges share storage. Unused standard-material UVs and tangents are canonicalized before welding. Rain lookup textures are generated only when the place uses them; dry glass gets a small neutral bead texture.

Opaque solid standard materials without maps or special surface effects can share a `vertex_pbr` palette: sRGB vertex colour carries the albedo and UV carries each surface's roughness/metalness. Static geometry keeps its spatial chunks; fixed siblings in an animated hierarchy can share their parent's frame, keeping independent wheel or gate tracks intact. Sidedness, environment strength, depth state and other retained material fields remain batch boundaries. Static palettes separate rough non-metal surfaces from those requiring a sun highlight; moving assemblies keep one palette. The renderer reads these PBR constants in full, distant and reflection variants.

`bun web/scripts/place-budget.ts --in PACK.place --out REPORT.json` validates a cooked pack and estimates `vita30` step-0 main-pass geometry over the full animation loop at each shot's start, middle and end camera positions. Its draw and triangle counts are CPU planning evidence, not a GPU measurement or frame-rate claim.

Variants that drop a material's ORM map (distant, LITE and mirror programs) scale roughness, metalness and occlusion by the map's per-channel means, stored in the pack.

## Daytime places

A place exported with a directional light gets the sun per pixel: the static scene is drawn once from the sun into a 2048² shadow map (normalized distance in a single-channel R32F colour target), and lit materials compare four texels around each point and blend them by the sub-texel position. Only smooth or metallic materials (roughness under 0.6 or metalness over 0.3) evaluate the sun's highlight; draws beyond the detail distance skip the shadow lookup. The sun is not baked.

Places with rigid moving opaque casters use a separate 512² shadow map, refreshed each frame with sun-frustum culling and shadow-texel LOD selection. Standard materials combine it with the cached static map; distant materials keep the moving lookup so a train's shadow remains visible across the crossing. Glass and skinned particles do not cast into this layer. Sangubashi captures verified the moving shadows and corrected train stripes in the previous depth-storage trial. The current R32F build reached device compilation before USB disconnected; final image and performance acceptance remain open (see the place README).

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
- **Draw budget**: within 140 m of the origin the cooker chunks static geometry into 32 m cells per material, beyond that into 256 m cells, so a view along a coast pays one draw per material per cell. Kamakura-Kōkōmae Crossing paints its small props (posts, wires, fences, housings, cabinets) from one equipment atlas, merges each vehicle and each train body into one mesh and keeps far land to a few large triangles.

Kamakura-Kōkōmae Crossing loops 120 s: one Fujisawa-bound train, the crossing's 35 s warning, lamps alternating every 0.6 s, four gate arms, six vehicles on 60 s cycles and a cyclist on a 120 s one.

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
