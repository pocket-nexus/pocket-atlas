# Sangubashi in Bloom

`sangubashi-crossing` recreates the location of the final railway crossing in
*5 Centimeters per Second*: Sangubashi No. 3 crossing, Yoyogi, Tokyo. No film
characters, soundtrack, stills or downloaded photographs are shipped. All
geometry, textures and audio are procedural. Native geometry and textures are
compiled ahead of time; sound is synthesized on the device.

## Site references

- [想景の地 — 参宮橋3号踏切](https://fujisyuu01.hatenablog.jp/entry/14371167),
  photographic comparisons, including the descending lane, signal ladders,
  convex mirror, villa and outside stair. The photographs also document
  changes to the site over time.
- [新海誠監督作品ファンの集い](https://shinkaifan.com/past/5-centimeters-per-second/),
  location records and photographs of the third-chapter crossing.
- [Location pin recorded by にこたろう読書室](https://nikotaronichijo.hatenablog.com/entry/2022/11/15/061835),
  approximately 35.67528° N, 139.69175° E.

The supplied still guides the spring palette and framing. The road, hardware
and principal buildings are modelled from photographs. Dimensions, bearing,
secondary neighbourhood buildings and garden planting are approximations;
the flowering canopy is an artistic spring treatment, not a claim about
today's planting or a measured reconstruction of one historical date.

## Rolling stock

The passing eight-car local uses the original stainless-and-blue Odakyu 1000
appearance and the 1081 formation's car numbers. Side and equipment placement
are guided by [RailFile's photographic formation record](https://railfile.jp/odakyu/formation/2020/01/1081f.html),
particularly [1031](https://railfile.jp/odakyu/car/1993/02/1031.html)
and [1131](https://railfile.jp/odakyu/car/1993/02/1131.html).
[AGUI's dated exterior, cab and interior photographs](https://www.agui.net/oer/oer1000.html)
guide the emergency cab door, lamps, wipers, rose-coloured benches and hanging
straps. No reference photograph is used as a texture. This is a photo-based
historical impression with approximate equipment geometry, not a claim about
the fleet currently serving the line or the exact train in a film frame.

`shared/daylight/commuter.ts` builds the 20 m four-door cars from a supplied
formation and livery. It includes layered window seals, transparent glazing
with actual interior geometry, door pockets and warning stickers, luggage
racks, underfloor service cabinets, tanks and conduits, sprung bogies, wheel
flanges, gangway bellows, couplers and hoses, cooling fans, louvres and
pantographs. Geometry is batched within each car; the moving root and wheelsets
remain ordinary scene nodes so the existing exporter records their transforms.

`rail.ts` supplies a 64 s pass to the shared railway timing and audio helpers.
Warning begins at 3 s, barriers lower from 6–10 s, the nose reaches the crossing
at 18 s and the last car clears before the barriers rise at 34–39 s. The train
is out of sight at the loop boundary. The clock is seekable, so capture times,
warning lamps, wheels and sound stay aligned. This compressed presentation
cycle is not an operational signalling model. The rail corridor extends beyond
the street for the visible approach and departure.

## Reference renderer

From `web/`:

```sh
bun run dev --host 127.0.0.1 --port 5198 --strictPort
# http://127.0.0.1:5198/?q=high&cam=Crossing#/place/sangubashi-crossing
bun run build
bun test scripts/railway-motion.test.ts
bun scripts/shot.ts '/?shot&q=high&cam=Crossing&t=12#/place/sangubashi-crossing' \
  ../.pocket-build/validation/sangubashi/crossing.png \
  --base http://127.0.0.1:5198 --wait 15000 --size 1600x900
```

Six shots: Crossing (reference composition), Blossom (tree and signal),
Tracks (railway corridor), Train (approaching cab), Lane (reverse view), Spring (street approach).
Sunlight, 4096² shadows at high/ultra, alpha-tested foliage shadows, a baked
cloud sky, PMREM, N8AO, restrained bloom and ACES use the shared daytime path.
Windborne petals do not cast shadows; the architecture and canopy shadow map
is cached when the railway is still. Moving trains and barriers invalidate it.
Petal geometry is seeded; all railway motion uses the simulation clock.

For the train arrival, open
`/?q=high&cam=Train&t=16#/place/sangubashi-crossing`. For a repeatable cab capture:

```sh
bun scripts/shot.ts '/?shot&q=high&cam=Train#/place/sangubashi-crossing' \
  ../.pocket-build/validation/sangubashi/train-cab.png \
  --base http://127.0.0.1:5198 --wait 15000 --size 1600x900 \
  --eval 'const a=window.pocketAtlas; a.renderer.setAnimationLoop(null); a.stage.frame(0,17.8)' --after 0
bun scripts/export-place.ts --place sangubashi-crossing --seconds 64 \
  --base http://127.0.0.1:5198 --out ../.pocket-build/validation/sangubashi/export
```

## Handheld source

The default web geometry remains the full reference. `geometry=handheld`
selects the shared daytime geometry profile: the train retains all eight
cars, 32 rotating wheelsets, cab, interior and equipment, with fewer radial
segments and without hidden edges on thin plates. Foliage card density and
railway hardware tessellation also scale down. Lighting and texture authoring
quality remain independent of this geometry choice.

Window and door openings are cut through the shared house facades and train
shells. Glass therefore has no nearly coplanar opaque backing, and adjacent
train panels do not duplicate the same surface. Printed railway signs and
train notices use the shared decal material's explicit depth offset. These
authoring rules keep the details stable on native depth buffers without
removing windows, equipment or lettering.

Windborne petals use ordinary glTF skins with at most 24 joints per batch;
260 petals take 11 draws. Their size is baked into the vertices and their
translation/rotation tracks loop continuously over the same 64 seconds as
the railway. This exports their motion through the existing animation path.

## Vita adaptation

With the web server above running, from the repository root:

```sh
(cd web && bun scripts/export-place.ts --place sangubashi-crossing \
  --seconds 64 --geometry handheld --base http://127.0.0.1:5198)
bun tools/atlas.ts cook --place sangubashi-crossing --tex 512
bun web/scripts/place-budget.ts \
  --in .pocket-build/places/sangubashi-crossing/sangubashi-crossing.place \
  --out .pocket-build/validation/sangubashi/budget.json
(cd web && bun scripts/export-atlas.ts --base http://127.0.0.1:5198)
(cd web && bun scripts/preview-place.ts --place sangubashi-crossing \
  --base http://127.0.0.1:5198)
bun tools/atlas.ts cook-atlas
bun tools/atlas.ts lint
bun tools/atlas.ts build
cargo test --workspace
bun test web/scripts
```

The shared cooker adds rigid-motion LODs, merges solid PBR surfaces while
retaining their vertex colour, roughness and metalness, and reuses identical
geometry and animation storage. The native renderer gives moving rigid
casters a separate shadow map while retaining the cached street shadows.
Skinned particle bounds cover every joint, including the short final batch.

The handheld export uses a 512 px texture cap. The reviewed geometry contains
674 draws, 358,103 LOD0 triangles, 299 animated nodes and 11 skins, in a roughly
36.6 MiB Vita pack. The offline `vita30` step-0 scan samples 960 times at three
camera positions for each of the six shots. It peaks at 349 main-pass draws,
181,370 triangles and 39,896 moving triangles. These are planning counts, not
GPU timing. Long faces are isolated from local static chunks so rails and wires
cannot keep distant buildings at near-camera LOD and shader detail.

### Compiler and renderer ownership

The export is sealed as PlaceIR before device lowering, following
[the compiler architecture](../../../../docs/COMPILER.md). Palette packing of
solid PBR factors into UVs belongs to the Vita lowering. Native targets use
source geometry and pixels rather than decoding a Vita pack. The registry
publishes this place for web, Vita, 3DS and PSP.

Vita PLCE and ATLS envelopes use version 7, and Vita Place META uses version 7.
Older readers must reject the new vertex-PBR encoding. PICA keeps its separate
PLCE v5 envelope and v4 table; PSP uses PLPS v4. Re-cook the corresponding
target's places when updating its runtime. Old native readers reject these
new animation and geometry encodings.

Atlas owns shaders, shared daytime materials, rigid moving shadows and quality
policy. The pinned PocketJS `pocket-vita-gxm` owns target allocation and GXM
program/output formats. The static 2048² and moving 512² raw depth targets are
R32F; an RG16 cache pairs adjacent depths, allowing four PCF comparisons from
two point reads. It retains the soft-edge weights. Light-space coordinates and
depth comparisons stay float; bounded weights and sunlight use half precision.
The target format does not imply that the shader compiler retains FP32 output
precision. No copied GXM crate or place-ID branch is needed.

### Acceptance and recorded measurements

On 2026-10-03 the project owner accepted the scene's picture quality and waived
the step-0 30 fps requirement for this place. Performance measurements below
remain disclosed; this is not a claim that every shot holds 30 fps. Further
Vita work was stopped to release the device for other tasks.

Before the architecture integration, the paired-depth path completed device
compilation and same-camera GXM captures. Six views and crossing phases at
0, 8, 25, 37 and 63.93 seconds cover the train, gates and loop boundary. The
capture baseline used native build `3fa13ff1af055acf89266266b0eb181a`.

At the Train halfway camera, t=19.73 s, `vita30` step 0, 480×272 HDR and 4× MSAA,
serialized GPU time was 46.8–46.9 ms, including approximately 36.2 ms for the
main pass, 1.7 ms for moving casters and 1.4 ms for their depth pairing. A
separate fixed-camera sweep recorded these paced frame times:

| Crossing | Blossom | Tracks | Train | Lane | Spring |
| --- | --- | --- | --- | --- | --- |
| 40.5 ms | 39.7 ms | 41.3 ms | 40.9 ms | 37.7 ms | 37.3 ms |

An earlier 146-second camera/governor run of the R32F path completed without
reported errors at 25.1–29.8 fps, using quality steps 2–4. That run is historical
evidence for its recorded build, not a measurement of the final architecture
integration. The shared-kernel migration and final recooks have host/build
validation only; no new Vita deployment was performed after the stop request.

The older standalone package was copied to the device, but installation and
standalone launch were not established. It is not the final integrated artifact.
Captures, timings and package receipts remain in ignored validation storage.

To repeat a measurement on an existing USB host (replace the share path):

```sh
bun tools/atlas.ts native --place sangubashi-crossing --share /path/to/share
bun tools/atlas.ts ctl '{"place":"sangubashi-crossing"}' --share /path/to/share
# Wait for this place to be running with pending=0 and missing=0.
bun tools/atlas.ts profile '{"step":0,"hold":true}' \
  --place sangubashi-crossing --shot Train --time 19.73 --share /path/to/share
bun tools/atlas.ts shots --place sangubashi-crossing --seconds 146 \
  --share /path/to/share
```

The measurement tools reject stale status, another native build, shader
errors and a changed place rather than reporting another task's results.
The Vita renderer has no audio path. Web, 3DS and PSP consume the shared
procedural railway audio recipe. Transport stays in PocketJS; this place adds
no transport fork.

## 3DS and PSP adaptation

Both native targets lower the sealed source independently. They preserve all
eight cars, the six camera paths, 260 skinned petals, warning signals and the
full 64-second railway cycle at the source's 15 Hz animation sampling. Compact
TRS tracks interpolate rotation with shortest-arc quaternions; constant and
identical tracks share storage. This avoids skipping fast wheel or petal
rotations to fit the animation budget.

The shared fixed-function lowering bakes the authored sky and clouds into
panoramas and static sunlight into vertex colour. Moving trains receive
directional sunlight and hemisphere fill. They do not inherit occlusion from
their hidden export pose. Native targets approximate the reference's lighting:
there is no HDR bloom, screen-space AO or moving train shadow map.

PICA v4 retains float geometry and uses per-joint bounds for skinned particles.
PSP v4 uses native 16-bit GE vertices where a batch meets the recipe's error
limit, retaining float vertices for skins and oversized batches. Camera-distance
LOD selection preserves nearby train equipment and simplifies distant geometry.
These encodings are produced from source floats, independently of Vita packing.
The PSP daytime recipe defaults to 8 m static cells so long rails and distant
planting do not keep unrelated geometry visible. The merged scene uses explicit
`--tex 128 --cell 12` overrides to retain its texture detail within the 18 MiB
pack limit. Constant encoded texture chains collapse losslessly to 8 × 8;
nonconstant mipmaps and glossy RGBA8888 precision remain intact. Batch welding shares byte-identical
GE vertices without changing geometry or reducing the train's detail.
Untextured PSP batches canonicalize unused UVs before welding; textured
batches retain their original UVs. The renderer keeps each batch's index
buffer while its ordered visible spans are unchanged, with separate storage
for the main, reflection and wet-mask passes. Animation uses elapsed time
even below 10 fps, so a slow frame does not stretch the railway cycle.

The PSP GE rejects a whole triangle when its projected vertices leave the
hardware's 0–4096 coordinate range. A long roof face crossing the near plane
can hit that limit even while part of it is visible. The renderer clips those
triangles before submission, interpolating UVs and colour in the original
3D coordinate frame and preserving triangle order. Unchanged triangles keep
their resident index buffers. Cached local bounds for 16-triangle blocks skip
safe geometry; cache admission is bounded at 256 KiB and falls back to complete
scanning when full. Generated vertices use stable scratch blocks that are only
reused after GE completion. This also covers other long near-camera surfaces,
without a train-specific renderer branch or a pack-format change.

The PICA middle LOD retains nearby thin structural poles and opaque textured
sign faces in bounded local cells. This keeps signal supports and warning
signs present without forcing the whole scene to its finest LOD.

The optional audio record describes wind, birds, railway timing, position and
gain. Both native renderers synthesize it from the scene clock, including seek,
pause and mute; no recordings or film soundtrack are included. 3DS offers
Sound in settings; Circle toggles PSP sound. A failed audio initialization is
reported as `audioReady: false` while rendering remains available. The 3DS
status also records the initialization stage, libctru result and file errno
to distinguish DSP setup failures from scene or synthesis failures.

After exporting the handheld source above:

```sh
bun tools/atlas-3ds.ts cook --place sangubashi-crossing
bun tools/atlas-3ds-assets.ts
bun tools/atlas-3ds.ts install --host 192.168.8.159
bun tools/atlas-3ds.ts profile --place sangubashi-crossing --shots Train \
  --time 19.73 --samples 60 --host 192.168.8.159
bun tools/atlas-3ds.ts tour --place sangubashi-crossing --seconds 146 \
  --host 192.168.8.159

bun tools/atlas-psp.ts cook --place sangubashi-crossing --tex 128 --cell 12
# Reuse the exact share owned by the existing usbhostfs_pc process.
bun tools/atlas-psp.ts run --place sangubashi-crossing --share /path/to/host0
bun tools/atlas-psp.ts shots --place sangubashi-crossing --time 19.73 --share /path/to/host0
bun tools/atlas-psp.ts shots --place sangubashi-crossing --live --share /path/to/host0
bun tools/atlas-psp.ts package --place sangubashi-crossing --no-build --share /path/to/host0
```

PSP measurements require the device's build ID, pack version and pack fingerprint
to match the staged SHA-256 receipt. Captures are taken after timing samples;
`gpuWaitMs` measures the remaining GE wait, not serialized whole-frame GPU time.

### Native validation before main integration (2026-10-04)

Host builds and format/runtime regression tests pass. Both formats retain
960 samples over 64 seconds. PICA's scene pack is 34,278,160 bytes; the PSP
pack is 18,686,040 bytes, below its 18 MiB reader limit. The 3DS SD archive includes
all five eligible scenes and its packaged files were verified against their
SHA-256 manifest.

PSP release `af6b69c77fad228d`, pack SHA-256
`1bd48a45a655ac13173c042fcd75a95ae2a6f75cf194cec021943cdb42029d06`,
was launched through the existing PSPLINK host. Six fixed captures confirm
the warning sign, facade window openings and recovered roof in both diagonal
railway views. Five 30-frame measurement windows per camera at t=19.73 give:

| Camera | PSP fps | PSP work ms |
| --- | ---: | ---: |
| Crossing | 8.57 | 102.71 |
| Blossom | 9.79 | 99.95 |
| Tracks | 8.57 | 108.71 |
| Train | 7.50 | 117.22 |
| Lane | 8.57 | 105.94 |
| Spring | 8.57 | 113.96 |

PSP does not meet the 30 fps target. Compared with committed build
`ee094d76a825d1cd` at the same cameras and time, total work is 3–7% lower while
the missing and overlapping surfaces are corrected. The guard fallback adds
17.6–30.7 ms of CPU processing/submission in these views; this overlaps GE
execution and must not be added to `workMs`. Its scratch allocation is
49,152 bytes. The fixed-view block-cache accounting reaches 171,784 bytes.
Offline replay over six cameras and all 960 animation samples preserves the
unoptimized clipping results and stays within the hardware guard bounds.
The final Train capture is pixel-identical to the initial correct clipping
implementation. A 146-second live tour visits all six cameras and advances
145.31 scene seconds during 145.32 seconds between the first and last status
samples. Its sampled rates range from 8.53 to 12 fps; these moving views are
distinct from the fixed passing-train measurements above. Pause, mute and
resume controls pass. Block-cache accounting peaks at 188,952 bytes.

The standalone Memory Stick files were copied back and matched byte-for-byte:
`EBOOT.PBP` is 475,645 bytes, SHA-256
`714b55ecbc1925f276d854f2f4163dd39d7e0e631020b54d4251dfd41ea59fd9`;
`scene.place` matches the pack hash above. This is installation/readback proof,
separate from the PSPLINK release-runtime tests. An XMB launch and listening
check have not been performed. PSP reports `audioReady: true`.

The pre-integration 3DS runtime `a447441aebd0` and all five asset hashes were verified
on `192.168.8.159:8131`. One transfer heartbeat timed out; the retry completed.
Six fixed step-0 cameras at t=19.73 averaged 33.34–33.57 ms per frame, with
20.63–25.51 ms PICA time. A 146-second automatic tour covered all six camera
paths without reconnection: 4,380 measured frames, 33.43 ms mean, a 35 ms
histogram p95 bound and 40.65 ms maximum. The quality governor started at
step 4 and returned to step 0; 218 of 242 status samples were at step 0.
Remaining linear memory stayed at 3,198,976 bytes.

Eleven native captures cover all cameras and t=0, 8, 25, 37 and 63.93 crossing
phases. They confirm the middle-LOD poles and signs remain present. The 3DS
audio stage still reports `ndsp-init`, result `0xD880A7FA`; DSP initialization
has not succeeded, and no 3DS listening acceptance is claimed. Remote mute
controls were checked independently of audio readiness. Physical button feel
and listening remain human checks. Vita was not used.


### Main integration validation (2026-10-04)

The branch includes Atlas main `1a935a5` (authoring/receipts and Lombard), with
PocketJS pinned to `b21bd28d`. PLPS v4 combines the full-motion native format
with main's explicit RGBA4444/RGBA8888 texture layouts and cooked sky geometry.
Older v1/v2/v3 readers are not compatible. The exported handheld source retains
64 seconds at 15 Hz; its canonical GLB SHA-256 is
`ea1531a0ff5b0a772506af454d2be3901a7409f900b72c302a1710a5b8d43df0`.

Rust workspace: 115 tests pass. The compiler/tool/geometry Bun suite passes
74 tests, the Web contract suite passes 12, and Web build/tools typecheck,
native audio checks, sun bounds and both native cross-builds pass.

PSP source build `98aee1ebb40cf7bd`, runtime instance
`14402205cce24324ae09f9593410e20f`, PLPS v4, pack SHA-256
`c13ab533e47c7e907caadf6579e39c09bd81954f59abd06e8a362eee2bea0904` was tested through PSPLINK.
The `--tex 128 --cell 12` pack is 18,853,608 bytes, below 18 MiB.
Six fixed cameras at t=19.73, five 30-frame windows each:

| Camera | PSP fps | Work ms |
| --- | ---: | ---: |
| Crossing | 8.57 | 106.07 |
| Blossom | 8.57 | 104.53 |
| Tracks | 7.50 | 120.01 |
| Train | 6.66 | 135.23 |
| Lane | 8.53 | 115.12 |
| Spring | 7.50 | 122.14 |

The diagonal Tracks/Train captures retain the roof over the crossing. A quiet
Crossing capture confirms the warning lettering and facade openings. A
146-second live tour covers all six cameras with sampled rates
7.46–10.00 fps; pause/mute/resume pass.
Generated scratch is 49,152 bytes; the live block-cache accounting peaks at
205,856 bytes. These are still below 30 fps.
The 12 m cook lowers work by 1–6% against the merged 16 m candidate, but remains
3–16% slower than the pre-integration build above; the newer daylight lowering
and larger budget-constrained cells are retained. This is not a performance
acceptance or a claim that merging main preserved the previous frame cost.

The exact tested EBOOT and scene were packaged without rebuilding, installed
to Memory Stick and read back byte-for-byte. EBOOT is 495,785 bytes, SHA-256
`1d6d69c122b2a68f9866d45ea076649795bf5afcc41ac7b109318710cb42c8ff`. XMB launch and listening
remain untested. The release is left playing with `audioReady: true`.

3DS runtime `d5f330665846` and all six catalog packs were installed. Device
byte counts/CRCs matched the host SHA-addressed catalog, including the 34,278,384-byte Sangubashi pack. Entering the scene
then lost heartbeat/control and subsequent discovery could not reconnect.
No current integrated 3DS frame or visual acceptance is claimed. The follow-up
runtime `1f6f59df9a7a` services debugger heartbeats during SHA verification,
and the host allows a longer scene-load control window. Its cross-build and
six-place SD package/hash checks pass, but it has not been installed or retested
because the console remains unreachable. The prior pole/performance captures
above remain evidence only for `a447441aebd0`. DSP initialization also remains
unresolved from that earlier run. Vita was not used.
