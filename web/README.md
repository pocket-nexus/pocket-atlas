# Pocket City

A standalone three.js demo: a night-side globe where you pick a city, and a
rain-soaked Tokyo backstreet with a 24-hour konbini as the first enterable
scene. It does not use any PocketJS runtime, build tooling or packages — it is
a plain Vite + TypeScript project with its own lockfile.

Every asset is generated at load time: Earth textures are rasterised from
Natural Earth coastlines (`world-atlas`), surfaces are baked on the GPU,
signage and packaging are drawn to canvases, audio is synthesised with
WebAudio. There are no image, model or sound files in the repository.

## Run

```sh
cd web
bun install
bun run dev          # http://127.0.0.1:5173
bun run build        # typecheck + production bundle in dist/
```

Requires WebGL 2. Tested in Chrome on Apple silicon (ANGLE / Metal).

## Controls

| Where | Input | Action |
| --- | --- | --- |
| Globe | drag / wheel / pinch | spin, zoom |
| Globe | click a beacon or a card | fly in (Tokyo) or preview (others) |
| Tokyo | drag, wheel, WASD / arrows, Q/E | orbit, dolly, move the focus, raise/lower |
| Tokyo | `C` | cinematic camera on/off (also starts after 40 s idle) |
| Tokyo | walk up to the door | the automatic door opens with its chime |
| Anywhere | `H` | hide the UI |

## URL switches

| Switch | Effect |
| --- | --- |
| `#/city/tokyo` | open Tokyo directly |
| `?q=low\|medium\|high\|ultra` | force a quality preset (otherwise picked from the GPU, persisted when changed in the UI) |
| `?shot` | capture mode: no UI, no intro, muted |
| `?cam=Konbini\|Puddles\|Vending\|Crossing\|Inside\|Wires` | start at a named shot |
| `?view=px,py,pz,tx,ty,tz[,fov]` | explicit camera (with `?shot`) |
| `?t=12.5` | simulation clock when the stage appears (with `?shot`, captures are reproducible) |
| `?stats` | frame time and draw-call readout |

`scripts/shot.ts` captures a running dev server with headless Chrome, for
example:

```sh
bun scripts/shot.ts "/?shot&stats&q=high&cam=Puddles#/city/tokyo" out.png --wait 20000
```

## How the Tokyo scene is put together

- **Wet ground.** One planar reflection (mirrored camera with an oblique near
  plane, half resolution, plus a vertically stretched blur chain) feeds every
  surface on `y = 0`. The reflection replaces the IBL radiance inside three.js'
  physical BRDF, so Fresnel and roughness come from the standard shading
  model. Puddles, ripples from drops and wet darkening are procedural per
  pixel (`gfx/wet.ts`).
- **Rain.** GPU-instanced streaks anchored to the camera, lit by the nearest
  light sources, plus ground splashes, drip curtains running off edges, a far
  rain curtain and steam (`fx/rain.ts`). Glass carries procedural beads and
  running drops (`gfx/glass.ts`).
- **Haze.** A post effect integrates single scattering from up to 24 point and
  spot lights analytically along each view ray to the depth buffer, skipping
  the dry shop interior (`fx/post.ts`). Bloom, AgX tone mapping, a grade pass
  and optional depth of field and N8AO finish the frame.
- **Windows.** Apartment and office windows are interior-mapped: each pane
  traces a room behind the glass with its own lamp, curtains or a flickering
  TV (`gfx/interior.ts`).
- **Materials.** Asphalt, pavers, facade tile, concrete, metals, shutters and
  wood are baked on the GPU into albedo / normal / ORM maps
  (`gfx/bake.ts`, `gfx/surfaces.ts`). Signs, posters and packaging are drawn
  into a shared canvas atlas.
- **Draw calls.** Builders author objects one by one; `batchStatic` merges all
  static meshes per material afterwards (about 14 000 meshes become ~170).
  The shop's ~4 000 products are instanced per shape.
- **Street life.** Utility poles with sagging cable spans and LED street
  lamps, vending machines, mamachari bicycles, a coin-parking lot, a taxi that
  passes every half minute with working head and tail lights, and six people
  (clerk, magazine reader, shopper, a customer on their phone, two walkers
  under umbrellas) on skinned procedural rigs (`world/props`, `world/traffic.ts`,
  `world/people`).
- **Sound.** Rain layers, drops on hard surfaces, gutter drips, traffic rumble,
  the shop's 100 Hz hum near the entrance and the door chime are all
  synthesised (`tokyo/audio.ts`). Rain intensity and wind gusts vary over
  time and drive both the streaks and the audio.

## Layout

```
src/
  core/        app shell, stage lifecycle, quality presets, audio, params
  ui/          DOM overlay: city list, tooltip, loading screen, HUD
  cities/      city registry (only Tokyo is enterable)
  globe/       the globe stage
  tokyo/       the Tokyo stage
    gfx/       baking, materials, wet/glass/interior shaders, reflection
    fx/        rain, post-processing
    world/     street plan, ground, konbini, neighbours, props, traffic, people, sky
```
