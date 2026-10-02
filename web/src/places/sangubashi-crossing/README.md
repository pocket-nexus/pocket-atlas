# Sangubashi in Bloom

`sangubashi-crossing` recreates the location of the final railway crossing in
*5 Centimeters per Second*: Sangubashi No. 3 crossing, Yoyogi, Tokyo. No film
characters, soundtrack, stills or downloaded photographs are shipped. All
geometry, textures and audio are generated at load time.

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

## Vita adaptation

The default web geometry remains the full reference. `geometry=handheld`
selects the shared daytime geometry profile: the train retains all eight
cars, 32 rotating wheelsets, cab, interior and equipment, with fewer radial
segments and without hidden edges on thin plates. Its train geometry is
102,376 triangles instead of 365,224. Foliage card density and railway hardware
tessellation also scale down. Lighting and texture authoring quality remain
independent of this geometry choice.

Windborne petals use ordinary glTF skins with at most 24 joints per batch;
260 petals take 11 draws. Their size is baked into the vertices and their
translation/rotation tracks loop continuously over the same 64 seconds as
the railway. This exports their motion through the existing animation path.

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

The handheld export with a 512 px texture cap cooks to 38.97 MiB: 674 total
draws, 416,849 LOD0 triangles, 299 animated nodes and 11 skins. The offline
`vita30` step-0 scan samples 960 times at three camera positions for each of
the six shots. It peaks at 349 main-pass draws, 215,419 triangles and 48,864
moving triangles. These remain above the planning guides (250 / 130k / 30k);
the counts are conservative, omit extra render passes and do not replace GPU
profiling. Long faces are isolated from local static chunks so rails and
wires cannot keep distant buildings at near-camera LOD and shader detail.
Budget and frame-rate acceptance are still open.

`build` produces a Devkit runtime VPK/SELF; the place and atlas packs remain
separate. On 2026-10-02 the USB deployment entered this place, completed
SceShaccCg compilation with no shader errors or missing draws, and returned
960×544 GXM captures including the passing train. This is device evidence;
physical button and screen acceptance is still separate.

At the Train shot's halfway camera, time 19.73 s, `vita30` step 0, 4× MSAA,
480×272 HDR, the initial serialized GPU total was 60.21 ms (main 50.97 ms).
The last fully compiled trial, using directly sampled stored depth and
conservative moving-shadow receiver culling, measured 54.23 ms (main 45.00
ms, moving map 1.70 ms). This still fails the 30 fps target. The wider moving
shadow bias was checked in device captures and removed the train's stripes.

The current build stores the same normalized depth in a single-channel R32F
colour target, recovering the stored-depth trial's additional 17 MiB of
CDRAM. It retains receiver culling and separates rough non-metal static
palettes from sun-GGX palettes. A depth-prepass experiment was measured and
removed because it increased GPU cost. No scene geometry was removed for
these renderer optimizations.

Native build `3b1aa4a3a7430b3902db398b15e9eba6` was successfully replaced in
Pocket Devkit and entered shader compilation. The last status had 26 new
programs compiled, 270 pending, no reported shader errors, and 39 MiB free
CDRAM. USB disconnected and the Vita disappeared from the host's USB device
list before this build completed compilation. The host has been restarted
and is waiting for reconnection. Final R32F captures, the six-shot continuous
run, re-entry/resource checks and standalone packaging are still pending.
Previous device captures and timings must not be presented as this build's
acceptance. Host build and shader lint do not establish SceShaccCg completion
or runtime image correctness.

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
The existing native renderer has no audio path; the procedural railway sound
remains a web feature. The PocketJS pin and transport implementation are unchanged.
