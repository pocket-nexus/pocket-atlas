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

## Reference renderer

From `web/`:

```sh
bun run dev --host 127.0.0.1 --port 5198 --strictPort
# http://127.0.0.1:5198/?q=high&cam=Crossing#/place/sangubashi-crossing
bun run build
bun scripts/shot.ts '/?shot&q=high&cam=Crossing&t=12#/place/sangubashi-crossing' \
  ../.pocket-build/validation/sangubashi/crossing.png \
  --base http://127.0.0.1:5198 --wait 15000 --size 1600x900
```

Five shots: Crossing (reference composition), Blossom (tree and signal),
Tracks (railway corridor), Lane (reverse view), Spring (street approach).
Sunlight, 4096² shadows at high/ultra, alpha-tested foliage shadows, a baked
cloud sky, PMREM, N8AO, restrained bloom and ACES use the shared daytime path.
Windborne petals do not cast shadows; the architecture and canopy shadow map
is static. Petal geometry is seeded; the animation uses the simulation clock.

The shared `?export` hook produces glTF, the HDR environment and cloud
panorama with the existing `scripts/export-place.ts` command. The current
exporter captures instanced petals as a static snapshot; their per-instance
motion is web-only. No `.place` cook, Vita shader compilation, device GPU
profiling, deployment or physical screen acceptance was performed for this
Three.js review. The PocketJS submodule and Vita transport are unchanged.
