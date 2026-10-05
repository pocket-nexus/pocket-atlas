# Nintendo 3DS renderer

Pocket Atlas opens on an interactive globe and shows every live place on an
Old 3DS: Rainy Night Konbini, Suga Shrine Stairs, Radio Kaikan at Blue Hour,
Kamakura-Kōkōmae Crossing, Sangubashi in Bloom, Griffith Observatory at Blue
Hour and daytime San Francisco Lombard Street.
Material annotations, camera shots, geometry and motion come from the same web
exports and lossless PlaceIR as the Vita. PICA cooks independently from source
geometry and textures; it does not read a Vita device pack. Rendering contains
no scene-name branches. PocketJS owns the unchanged paired debug transport and
native installer; Atlas owns the application and its content-addressed packs.

Everything flat on either screen is [the interface](../README.md#the-interface)
(`ui/`, shared with the other handhelds): a PocketJS guest that `guest.c` runs
on PocketJS's 3DS UI core, QuickJS driver and PICA DrawList backend, drawn over
the top screen's scene and on the whole touch screen. The renderer draws the
globe (`globe.c`) and the places (`scene.c`) and answers the interface through
`interface.c`. Nothing is printed on a screen: diagnostics go to
`sdmc:/pocket-atlas/boot.log` and the debug wire.

The native catalog uses explicit per-place `targets` eligibility in the web
registry; PlaceIR validates the authored feature set before device lowering.
The interface lists every place of the registry; one without a pack on the SD
card (unsupported here, or not yet built) keeps its marker and details, is
marked **Not on this device** or **Coming soon**, and says so instead of
loading.

Cook, build, package, install and sync use the same supported subset. Their
manifests/receipts list unsupported live entries separately. `cook --place`
rejects an unsupported place explicitly; the cooker lowers what a place needs
or refuses it, and does not omit an effect and publish an incomplete place.

Default output is monoscopic 400 × 240 with a 30 fps target. The optional 4×
antialias setting renders 800 × 480 and downsamples on display. Settings also
expose 20/60 fps targets; these are budgets, not performance guarantees.
Emulator timing does not establish performance on an Old 3DS.

## Build and deploy

Initialize `vendor/pocketjs` and run `bun install` in it, install `web`
dependencies, start Docker and run one web development server. The interface's
UI core is built on the host with the Rust nightly its crate pins
(`vendor/pocketjs/hosts/3ds/core/rust-toolchain.toml`, with `rust-src`). Export
the shared assets (adjust `--base` when the server is not on port 5173):

```sh
cd web
bun scripts/export-place.ts --place tokyo-konbini --seconds 20
bun scripts/export-place.ts --place suga-shrine-stairs --seconds 1
bun scripts/export-place.ts --place akihabara-radio-kaikan --seconds 20
bun scripts/export-place.ts --place kamakura-koko-mae-crossing --seconds 120
bun scripts/export-place.ts --place sf-lombard-street --seconds 120
bun scripts/preview-place.ts
bun scripts/export-atlas.ts
cd ..
bun tools/atlas-3ds.ts cook
bun tools/atlas-3ds.ts build
bun tools/atlas-3ds.ts install --host 192.168.8.159
```

`cook --place ID` rebuilds one native pack. `build` compiles the interface
for the 3DS (`tools/atlas-ui.ts`), cooks the globe (`tools/atlas-3ds-assets.ts`),
builds PocketJS's UI core and QuickJS, and produces
`dist/3ds/pocket-atlas.3dsx` with the interface (`atlas.js`, `atlas.pak`) and
the globe (`globe.3ds`) in RomFS and a compiled catalog of exact scene hashes.
Scene packs live in
`sdmc:/pocket-atlas/<sha256>.place`; the scenes exceed the native installer's
32 MiB limit, so they are delivered separately.

`install` replaces and restarts the application over the paired PocketJS
connection, then `sync`s the packs. Atlas serves only the named files through
a temporary token-protected HTTP endpoint on the host interface routed to the
console (`--asset-host` overrides it). The application streams to SD, verifies
size and CRC, and renames a temporary file only after verification. Matching
cached packs are checked and skipped. The host verifies SHA-256 before serving.
`install --thin` updates only the program and its interface and requires
matching packs already on SD. `sync` can be run independently.

For an initial installation or crash recovery while ftpd is open:

```sh
bun vendor/pocketjs/tools/3ds-dev.ts install --ftp --host 192.168.8.159 \
  --file dist/3ds/pocket-atlas.3dsx --name pocket-atlas.3dsx
# Open Pocket Atlas from Homebrew Launcher, then:
bun tools/atlas-3ds.ts sync --host 192.168.8.159
```

For an entirely offline installation, run `bun tools/atlas-3ds.ts package` and
extract `dist/3ds/pocket-atlas-sd.zip` at the SD root. It contains the 3dsx,
manifest and every required scene pack. A place whose pack is missing is
listed as not on the device. Files from another revision are never selected.

## Browse and control

The upper screen shows the rotating globe, a pin per place and the focused
place's card. The lower screen is the interface's touch surface:

- Circle Pad rotates the globe; Explore re-sorts around where it faces.
- The list scrolls under the stylus or the D-pad; a tap focuses a row, a
  second tap (or A) enters it. L/R, or a tap on a tab, changes between
  Featured, Explore, Saved and Search.
- X opens the keyboard on the lower screen. Every search word must occur in a
  place's name, native name, locality, country, kind, tags, weather or summary.
- Y saves or unsaves a place. Saved places are kept in
  `sdmc:/pocket-atlas/interface.json`.

Inside a place the top screen is the scene, with its name for a few seconds
and the shot's name when it changes. The lower screen lists the authored shots
(tap one to cut to it), has a pad to drag the view with, and Pause, Menu and
Atlas buttons. The Circle Pad walks; the D-pad, the C-stick (New 3DS) and the
look pad turn the view, which leaves the tour. L/R step through the shots,
START pauses or resumes, X opens the menu and B returns to the globe.
L + R + START exits. The Circle Pad has a radial deadzone and gentle response,
movement diagonals are normalized, and entering free camera preserves the
current direction.

The menu lists the tour switch, frame target (30, 60 or 20 fps), automatic or
fixed quality, antialiasing, the effects the current scene has, exposure and
the statistics line. Choices persist in `sdmc:/pocket-atlas/settings.json` and
apply to the next place. An open menu has the pad: the camera does not move.
The application frees a scene's GPU resources before loading the globe or
another scene.

Entering a place verifies its pack's SHA-256 before loading it (5 s for a
17 MiB pack, 11 s for Tokyo's 36 MiB, read in 256 KiB requests); the interface
shows the place's card meanwhile and does not animate.

## Inspect and measure

```sh
bun tools/atlas-3ds.ts status
bun tools/atlas-3ds.ts ctl '{"press":"down,a"}'            # the interface's buttons, one after another
bun tools/atlas-3ds.ts ctl '{"touch":[160,103]}'           # hold the stylus on the lower screen; {"touch":false} lifts it
bun tools/atlas-3ds.ts ctl '{"place":"kamakura-koko-mae-crossing"}'
bun tools/atlas-3ds.ts ctl '{"atlas":true}'
bun tools/atlas-3ds.ts ctl '{"shot":"Crossing","time":25,"step":0,"hold":true}'
bun tools/atlas-3ds.ts ctl '{"shot":"Crossing","shotPhase":0.4,"time":10}'
bun tools/atlas-3ds.ts ctl '{"settings":true,"exposure":0.25}'
bun tools/atlas-3ds.ts capture                             # both screens, the lower under the upper
bun tools/atlas-3ds.ts capture --surface reflection
bun tools/atlas-3ds.ts profile --place suga-shrine-stairs --no-interface   # the same cameras without the interface
bun tools/atlas-3ds.ts profile --place suga-shrine-stairs --step 0 --samples 60 --live
bun tools/atlas-3ds.ts profile --place tokyo-konbini --step 3 --samples 60 --live
bun tools/atlas-3ds.ts sweep --place akihabara-radio-kaikan --samples 60 --live
bun tools/atlas-3ds.ts tour --place kamakura-koko-mae-crossing --seconds 135
bun tools/atlas-3ds.ts ctl '{"hold":false,"play":true}'
```

`POCKET_3DS_HOST`/`--host` selects the device; `--keys` selects an existing
PocketJS pairing-key directory. Only one paired TCP client may be active.
Control replies can precede a queued scene change: poll until the expected
`place` and `phase: running` appear. Status reports the interface's `scene`,
any `interfaceError`, what a guest turn costs (`interfaceMs`: script, layout,
draw lists, vertices), the turns taken (`interfaceTurns`), the malloc heap
(`heapUsed`, `heapSize`) and the free linear and video memory. `"interface":
false` leaves the interface out of the frame, for comparisons.

Captures, timing traces, cooked packs and build receipts stay in ignored
`.pocket-build/`. Profiling pins each camera midpoint, settles, then samples
CPU work, retired GPU time and actual frame interval. CPU preparation overlaps
GPU work: do not add the two times. `--live` retains motion; otherwise animation
is frozen at `--time`. The device counts every measured frame and reports mean,
maximum and a 0.5 ms histogram P95. `tour` uses moving cameras and automatic
quality. Benchmarks temporarily lock physical input and restore it afterward;
the lock expires after three seconds without control traffic. `hold` pins
quality, while `time` freezes animation/camera until `play: true`.
`shotPhase` selects a normalized position within the named camera path for
repeatable angle comparisons; selecting only `shot` uses its midpoint.

`tour` checkpoints incomplete results and may reconnect after a Wi-Fi drop.
It accepts only the same build and place with advancing frame and measurement
counters, so all frames remain included in the device's statistics. A finished
record has `complete: true`; interruptions and reconnects remain in the receipt.

## Native rendering

The PLCE5 container's PICA3 section holds native materials, draws, tiled
RGB565/RGBA4 mip chains, RGBA8 clouds, 24-byte vertices and interpolated
animation palettes.
The cooker applies the authored AgX/ACES grade, baked irradiance and static
sun occlusion. It keeps only referenced animation matrices; long loops retain
their duration even if matrix sampling must be reduced to fit memory.

Day/twilight skies use a cooked panorama and a separate drifting cloud layer.
Cloud colors are premultiplied before bilinear filtering to avoid dark halos
at transparent edges; their HDR values retain the shared tone mapping.
Signs retain their flipbook/scroll transforms and animated emission; surf uses
scrolling alpha artwork. Open water uses two wave layers and a Fresnel/TEV
approximation. Night scenes retain rain, local light glow and wet planar
reflections in a 128 × 256 target. PICA uses baked lighting and fixed texture
combiners, rather than the Vita's complete per-pixel normal/ORM and HDR bloom
pipeline; exposure is an LDR adjustment and sun shadows are static.
The reflection target uses 24-bit depth to separate layered shop fronts when
the view moves. Long, clamped emissive lettering retains up to 1024 texels on
its long axis, with mipmaps for stable distant sampling.

Native materials with identical GPU state are merged after lighting is baked.
Static vertices form u16-addressable batches; visible LOD indices are gathered
per frame. CPU preparation overlaps the previous GPU frame through two skin
and index buffers. Frustum/size/back-face culling, material caches and a coarse
reflection proxy reduce cost. `lodFloor: 3` selects an automatic minimum mesh
LOD from material features: open water uses 0, day/twilight skies use 1, and
other scenes use 2. Values 0–2 override this for comparisons; status reports
the actual `lodFloor` and configured `lodSetting`. Automatic quality adapts
detail tolerance, rain and reflection range to the selected frame budget.
Compact static tubes and rings that lose their shape in the coarse mesh get
local detail cells and an 8 mm error middle LOD. That level remains visible
within 24 m while the cell projects to more than an 8-pixel radius; distant
geometry and reflection proxies retain their original coarse triangles.
A daytime street keeps its runs the same way: a post, a mast, a beam or a rail
of one section up to 24 cm, of any length. Its middle level, which a day scene
draws at any distance, is 25 cm off and leaves nothing of a crossing signal's
post or a utility pole. The other kinds keep the compact rule their budgets
were measured with (the wider one adds 4 to 6 thousand triangles and up to 570
draws to each of their packs).

A figure's coarse level (the reflection's) is the whole figure within a known
error. Where that error is under the detail tolerance on screen, the figure is
skinned and drawn as the coarse one, about a seventh of its vertices; at load
those vertices are put first, so the skinning and the cache flush stop there.
Twenty-eight thousand skinned vertices cost an Old 3DS 37 ms a frame.

## Vistas

A `dusk-vista` place (Griffith Observatory) reaches a horizon 70 km away. Its
haze is in the vertex colours, cooked as seen from the middle of the camera
shots (`vista` in `pica.rs`), and the pack's header carries the far plane
(120 km; 0 stands for the 1.2 km of a street). The depth buffer stays 24-bit
with the near plane at 8 cm: surfaces 0.75 m apart separate at 1 km, 75 m at
10 km.

Its lights are the pack's sixth section, `FELD`: fields of sprites, each field
with a bounding sphere, each sprite a light's place, radius, path, blink and
display colour, the brightest of a field first. At load a sprite becomes four
vertices in linear memory (36 bytes each, 64 for one that travels or blinks);
`field.v.pica` and `traffic.v.pica` turn them to the camera, size them in
pixels between the field's limits, dim them by as much as they are wider than
the light, twinkle them and pull them towards the eye, clear of the surface
they sit on. They are added over the finished scene through a 32 × 32 falloff
texture, depth-tested and not written. Fields outside the view are skipped;
whole fields that follow one another are one draw; a quality step above 0
keeps three quarters, a half, three eighths or a quarter of each field. About
20,000 sprites are in view from the terrace, in a frame whose GPU time is
19 ms.

A surface with an emission map of its own (`MAT_GLOW`: floodlit masonry, a
tower's windows) goes through `glow.v.pica`, the scene's program with a second
set of texture coordinates, and a second combiner stage that adds the map
times the vertex alpha. Both programs are one binary, so changing between them
uploads no code.

A long lens (the Overlook, 3.2°) enlarges what the size cull calls subpixel:
past four times a normal lens the cull follows the focal length.
It starts conservatively on each scene entry, so a costly scene does not
inherit a lighter scene's highest quality before its first measurements.

## The interface's cost

The guest is given a turn (script, layout, two draw lists: about 6 ms on an
Old 3DS, 10 ms when a list changes) only when a button or the stylus is down
or was within two thirds of a second, when the renderer's state changed, or
when its last turn drew something new; otherwise once a second. Its vertices
are rebuilt only when a draw list changed, and the touch screen is presented
only when its picture changed, so a resting interface costs the top screen's
few quads and no GPU time below.

libctru would halve the application's memory between `malloc` and the linear
heap. The interface's textures are linear, and so is everything large a place
owns, the animation included (in the malloc heap the guest's allocations come
to rest around it and the next place's block no longer fits the hole). The
malloc heap is therefore fixed at 14 MiB (the interface uses 6 to 8) and the
linear heap takes the rest: Tokyo, the largest place, leaves 3.4 MiB of it,
Griffith with its 130,000 sprite vertices 11.5 MiB.

## Lifecycle and validation

Every shader output is written in full exactly once. Attribute loaders consume
the entire vertex stride: float3 position, float2 UV, RGBA8 color (a light
sprite: float3, float4, RGBA8, four signed bytes, then float4 and float3 for
one that moves). A uniform is the first source of an instruction. Device
screenshots exposed a second UV flip that emulation alone did not catch.

GPU retirement occurs at successful `C3D_FrameBegin`; `FrameSync` only waits
for LCD vblank. Render targets must be freed outside a frame. A resident
parking shader and white texture keep citro3d's cached pointers valid while
scene resources are released: neither `C3D_BindProgram` nor `C3D_TexBind`
accepts NULL. Capture buffers also remain alive until the GPU has retired.
The four-second GPU watchdog retains the debugger after a stall.
`sdmc:/pocket-atlas/boot.log` records startup stages.

Run the shared cooker tests, asset-delivery tests, and navigation check:

```sh
cargo test --locked --workspace
bun test tools/atlas-3ds-delivery.test.ts
cc -std=c11 -Wall -Wextra -Werror n3ds/tests/navigation.c -lm \
  -o .pocket-build/navigation-test
.pocket-build/navigation-test
```

The reproducible C streaming/cache/HTTP failure test command is in
`n3ds/tests/assets.c`. Host build, emulator behavior, physical device rendering,
physical frame timing and a person's control/visual check are distinct evidence.
