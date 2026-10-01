# Nintendo 3DS renderer

Pocket Atlas opens on an interactive globe and runs all four shared places on
an Old 3DS: Rainy Night Konbini, Suga Shrine Stairs, Radio Kaikan at Blue Hour,
and Kamakura-Kōkōmae Crossing. The registry, globe maps, postcard previews,
font, material annotations, camera shots, geometry and motion come from the
same web exports and canonical packs as the Vita. Rendering contains no
scene-name branches. PocketJS owns the unchanged paired debug transport and
native installer; Atlas owns the application and its content-addressed packs.

Default output is monoscopic 400 × 240 with a 30 fps target. The optional 4×
antialias setting renders 800 × 480 and downsamples on display. Settings also
expose 20/60 fps targets; these are budgets, not performance guarantees.
Emulator timing does not establish performance on an Old 3DS.

## Build and deploy

Initialize `vendor/pocketjs`, install `web` dependencies, start Docker and run
one web development server. Export the shared assets (adjust `--base` when the
server is not on port 5173):

```sh
cd web
bun scripts/export-place.ts --place tokyo-konbini --seconds 20
bun scripts/export-place.ts --place suga-shrine-stairs --seconds 1
bun scripts/export-place.ts --place akihabara-radio-kaikan --seconds 20
bun scripts/export-place.ts --place kamakura-koko-mae-crossing --seconds 120
bun scripts/preview-place.ts
bun scripts/export-atlas.ts
cd ..
for place in tokyo-konbini suga-shrine-stairs akihabara-radio-kaikan kamakura-koko-mae-crossing; do
  bun tools/atlas.ts cook --place "$place"
done
bun tools/atlas.ts cook-atlas
bun tools/atlas-3ds.ts cook
bun tools/atlas-3ds-assets.ts
bun tools/atlas-3ds.ts build
bun tools/atlas-3ds.ts install --host 192.168.8.159
```

`cook --place ID` rebuilds one native pack. `build` produces
`dist/3ds/pocket-atlas.3dsx`, with the small globe/browser pack in ROMFS and a
compiled catalog of exact scene hashes. Scene packs live in
`sdmc:/pocket-atlas/<sha256>.place`; four scenes exceed the native installer's
32 MiB limit, so they are delivered separately.

`install` replaces and restarts the application over the paired PocketJS
connection, then `sync`s the packs. Atlas serves only the named files through
a temporary token-protected HTTP endpoint on the host interface routed to the
console (`--asset-host` overrides it). The application streams to SD, verifies
size and CRC, and renames a temporary file only after verification. Matching
cached packs are checked and skipped. The host verifies SHA-256 before serving.
`install --thin` updates only the program/browser and requires matching packs
already on SD. `sync` can be run independently.

For an initial installation or crash recovery while ftpd is open:

```sh
bun vendor/pocketjs/tools/3ds-dev.ts install --ftp --host 192.168.8.159 \
  --file dist/3ds/pocket-atlas.3dsx --name pocket-atlas.3dsx
# Open Pocket Atlas from Homebrew Launcher, then:
bun tools/atlas-3ds.ts sync --host 192.168.8.159
```

For an entirely offline installation, run `bun tools/atlas-3ds.ts package` and
extract `dist/3ds/pocket-atlas-sd.zip` at the SD root. It contains the 3dsx,
manifest and every required scene pack. Missing packs give a visible message
and return to the browser. Files from another revision are never selected.

## Browse and control

The upper screen shows a real rotating globe, location markers and a postcard.
The lower screen contains the touchable place lists and details:

- Circle pad rotates the globe. D-pad up/down selects a place; left/right zooms.
- L/R changes Featured, Explore, Saved and Search. Explore sorts all 18 places
  by distance from the globe's facing point.
- A enters an available place. Planned places remain browseable but cannot be entered.
- X opens the system keyboard. Every search word must match a name, locality,
  country, tag, kind, author or summary; native names are searchable.
- Y saves or unsaves a place. Favorites persist on SD.
- B opens details; up/down scrolls long text. Selection, globe orientation,
  query and favorites survive a scene visit.

The compact font is derived from the shared Inter/Noto atlas. Names whose
native script is absent from that atlas use the corresponding Latin label;
the original text remains searchable.

Inside a place, the circle pad looks and the D-pad moves relative to the
camera. Lower-screen drag also looks; L/R changes height. A chooses the next
shot, B switches camera mode, X toggles quality hold and Y steps quality.
SELECT opens settings; START returns to the globe. L + R + START exits.
The circle pad has a radial deadzone and gentle response, movement diagonals
are normalized, and entering free camera preserves the current direction.

Settings include frame target, automatic/fixed quality, the effects supported
by the current scene, exposure, shot, performance overlay and antialiasing.
Choices persist and apply to the next place. The menu blocks camera input and
holds automatic quality while open. X resets choices; B/SELECT closes it.
The application frees a scene's GPU resources before loading the globe or
another scene.

## Inspect and measure

```sh
bun tools/atlas-3ds.ts status
bun tools/atlas-3ds.ts ctl '{"atlas":true,"tab":"search","search":"summer"}'
bun tools/atlas-3ds.ts ctl '{"place":"kamakura-koko-mae-crossing"}'
bun tools/atlas-3ds.ts ctl '{"shot":"Crossing","time":25,"step":0,"hold":true}'
bun tools/atlas-3ds.ts ctl '{"sheet":true,"settings":{"exposure":0.25}}'
bun tools/atlas-3ds.ts capture
bun tools/atlas-3ds.ts capture --surface reflection
bun tools/atlas-3ds.ts profile --place suga-shrine-stairs --step 0 --samples 60 --live
bun tools/atlas-3ds.ts profile --place tokyo-konbini --step 3 --samples 60 --live
bun tools/atlas-3ds.ts sweep --place akihabara-radio-kaikan --samples 60 --live
bun tools/atlas-3ds.ts tour --place kamakura-koko-mae-crossing --seconds 135
bun tools/atlas-3ds.ts ctl '{"hold":false,"play":true}'
```

`POCKET_3DS_HOST`/`--host` selects the device; `--keys` selects an existing
PocketJS pairing-key directory. Only one paired TCP client may be active.
Control replies can precede a queued scene change: poll until the expected
`place` and `phase: running` appear. Browser status exposes the selected place,
list, tab, search, saved ids, orientation and zoom.

Captures, timing traces, cooked packs and build receipts stay in ignored
`.pocket-build/`. Profiling pins each camera midpoint, settles, then samples
CPU work, retired GPU time and actual frame interval. CPU preparation overlaps
GPU work: do not add the two times. `--live` retains motion; otherwise animation
is frozen at `--time`. The device counts every measured frame and reports mean,
maximum and a 0.5 ms histogram P95. `tour` uses moving cameras and automatic
quality. Benchmarks temporarily lock physical input and restore it afterward;
the lock expires after three seconds without control traffic. `hold` pins
quality, while `time` freezes animation/camera until `play: true`.

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

Native materials with identical GPU state are merged after lighting is baked.
Static vertices form u16-addressable batches; visible LOD indices are gathered
per frame. CPU preparation overlaps the previous GPU frame through two skin
and index buffers. Frustum/size/back-face culling, material caches and a coarse
reflection proxy reduce cost. `lodFloor: 3` selects an automatic minimum mesh
LOD from material features: open water uses 0, day/twilight skies use 1, and
other scenes use 2. Values 0–2 override this for comparisons; status reports
the actual `lodFloor` and configured `lodSetting`. Automatic quality adapts
detail tolerance, rain and reflection range to the selected frame budget.
It starts conservatively on each scene entry, so a costly scene does not
inherit a lighter scene's highest quality before its first measurements.

## Lifecycle and validation

Every shader output is written in full exactly once. Attribute loaders consume
the entire vertex stride: float3 position, float2 UV, RGBA8 color. Device
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
