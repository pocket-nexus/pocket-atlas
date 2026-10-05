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
79,536 triangles instead of 365,224. Foliage card density and railway hardware
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
publishes this place for web, Vita and 3DS (`n3ds/README.md`, where a daytime
street keeps its posts, masts, beams and rails at the middle level); PSP
support is not implied.

Vita PLCE and ATLS envelopes use version 7, and Vita Place META uses version 7.
Older readers must reject the new vertex-PBR encoding. PICA keeps its separate
PLCE v5 envelope and v3 table; PSP keeps PLPS v1. Re-cook the Vita places and
atlas when updating the runtime.

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
The existing native renderer has no audio path; procedural railway sound remains
a web feature. Transport stays in PocketJS; this place adds no transport fork.
