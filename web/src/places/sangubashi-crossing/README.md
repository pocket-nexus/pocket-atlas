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
the street so the full formation remains on tracks.

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

The shared `?export` hook produces glTF, the HDR environment and cloud
panorama with the existing `scripts/export-place.ts` command. The current
exporter captures instanced petals as a static snapshot; their per-instance
motion is web-only. No `.place` cook, Vita shader compilation, device GPU
profiling, deployment or physical screen acceptance was performed for this
Three.js review. The PocketJS submodule and Vita transport are unchanged.
