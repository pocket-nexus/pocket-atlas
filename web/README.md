# Pocket Atlas — web reference

A standalone three.js app: a night-side globe where you pick a place, a
rain-soaked Tokyo backstreet with a 24-hour konbini, the stairs of Suga
Shrine in Yotsuya on a summer afternoon, the street in front of
Akihabara Radio Kaikan at blue hour, and the Enoden crossing at
Kamakura-Kōkōmae above Sagami Bay, and Sangubashi No. 3 crossing beneath spring blossoms. It does not use any PocketJS runtime, build tooling or packages — it is
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
| Globe | click a beacon or a card | fly in (open places) or preview (others) |
| Place | drag, wheel, WASD / arrows, Q/E | orbit, dolly, move the focus, raise/lower |
| Place | `C` | cinematic camera on/off (also starts after 40 s idle) |
| Tokyo | walk up to the door | the automatic door opens with its chime |
| Anywhere | `H` | hide the UI |

## URL switches

| Switch | Effect |
| --- | --- |
| `#/place/<id>` | open a place directly (`#/place/tokyo-konbini`, `#/place/suga-shrine-stairs`) |
| `?q=low\|medium\|high\|ultra` | force a quality preset (otherwise picked from the GPU, persisted when changed in the UI) |
| `?geometry=full\|handheld` | daytime authoring density for train, railway and foliage; defaults to full, independent of lighting quality |
| `?shot` | capture mode: no UI, no intro, muted |
| `?cam=Konbini\|Puddles\|Vending\|Crossing\|Inside\|Wires` | start at a named shot (konbini) |
| `?cam=Crossing\|Blossom\|Tracks\|Train\|Lane\|Spring` | start at a named shot (Sangubashi in Bloom) |
| `?cam=Stairs\|Rails\|Below\|Lane\|Canopy` | start at a named shot (Suga Shrine Stairs) |
| `?cam=Arrival\|Facade\|Band\|Vista\|Corner\|Clock` | start at a named shot (Radio Kaikan at Blue Hour) |
| `?cam=Crossing\|Postcard\|Platform\|Route134\|Seawall\|Park` | start at a named shot (Kamakura-Kōkōmae Crossing) |
| `?view=px,py,pz,tx,ty,tz[,fov]` | explicit camera (with `?shot`) |
| `?t=12.5` | simulation clock when the stage appears (with `?shot`, captures are reproducible) |
| `?stats` | frame time and draw-call readout |

`scripts/shot.ts` captures a running dev server with headless Chrome, for
example:

```sh
bun scripts/shot.ts "/?shot&stats&q=high&cam=Puddles#/place/tokyo-konbini" out.png --wait 20000
```

## How Rainy Night Konbini is put together

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
  TV (`places/shared/interior.ts`).
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
  under umbrellas) on the shared skinned procedural rig (`world/props`,
  `world/traffic.ts`, `world/people.ts`, `places/shared/people/`).
- **Sound.** Rain layers, drops on hard surfaces, gutter drips, traffic rumble,
  the shop's 100 Hz hum near the entrance and the door chime are all
  synthesised (`audio.ts`). Rain intensity and wind gusts vary over
  time and drive both the streaks and the audio.

## How Suga Shrine Stairs is put together

- **Site.** The top nosing of the flight is the origin and the stairs descend
  along −Z. Looking down the flight faces a bearing of 33°; the export records
  the bearing, the coordinates and the elevations as metadata and the world is
  not rotated to north (`world/layout.ts`). 48 risers of 156 mm and 47 treads
  of 330 mm drop 7.5 m over 15.5 m; the lane runs 48 m to a five-way junction,
  and 東福院坂 climbs to the apartment ridge about 300 m ahead.
- **Stairs.** Each step is three or four granite slabs with a chamfered
  nosing, a darker anti-slip band and a mortar joint at the riser; a few slabs
  are warmer or darker stone (`world/stairs.ts`). Three Ø48.6 mm handrails on
  Ø42.7 mm posts run 0.85 m above the nosings and turn down into the paving at
  both ends. A steel frame for festival lanterns spans the stair head.
- **Light.** The sun is a `DirectionalLight` at azimuth 255° and elevation 35°
  (15:30 in late July) with one orthographic shadow map (4096² on the high and
  ultra presets) fitted to the
  flight, the lane and the junction. It exports as a glTF directional light;
  `extras.pocketAtlas.directionalLights` adds the direction toward the sun and
  the shadow frustum, size and bias. A hemisphere light and a cube capture of
  the finished place (PMREM, `env.rgba16f` in the pack) fill the shade. No
  caster moves, so the shadow map renders on the first frames only.
- **Sky.** The dome is the one custom shader on a scene surface: a
  zenith-to-horizon gradient, a sun glow and disc, and a panorama of fair-weather
  cumulus (`places/shared/sky.ts`, with Suga's colours and cloud numbers in
  `world/sky.ts`). The panorama is baked once on the GPU by
  ray-marching domed cloud cells through a 1.4–4.6 km layer over a curved
  Earth, with six light steps toward the sun per sample. It stores opacity,
  sun-lit and sky-lit radiance in a 1024² texture (two halves of 180° azimuth,
  rows by the square root of elevation); the dome's `pocketAtlas` annotation
  lists the mapping, the colours and the compositing, and the exporter writes
  the texture as `sky-clouds.png`.
- **Materials.** Granite, rubble and cut stone, fair-faced concrete with
  form-tie holes, lap siding, stucco, concrete block, asphalt, sheet-metal and
  glazed-tile roofs, bark and painted steel are baked on the GPU into albedo /
  normal / ORM maps of at most 1024² (`gfx/surfaces.ts`, `gfx/materials.ts`).
  Every surface is a `MeshStandardMaterial`; leaves, the wire-mesh fence,
  balcony bars and the 止まれ marking are alpha-tested cut-outs.
- **Cherry tree.** Tapered limbs carry about 1 600 cards from one canvas leaf
  atlas. Card normals lean toward the crown's outward direction, so the canopy
  shades as a volume, and its alpha-tested shadow dapples the stairs and the
  house walls (`world/tree.ts`). The same atlas feeds the hedge, the smaller
  terrace trees, ground cover and potted plants.
- **Neighbourhood.** One house builder makes foundations, walls, windows with
  aluminium frames and shutter boxes, balconies with laundry, gutters and
  downpipes, and gable, hip, shed or flat roofs. Hand-placed houses line the
  flight and the lane; a grid of simpler houses fills the valley and the far
  slope (`world/houses.ts`). The ridge blocks carry printed balcony facades,
  and the Ministry of Defense tower at Ichigaya stands 1 km away on the view
  line (`world/far.ts`).
- **Street.** Concrete poles with crossarms, transformers, low-voltage racks,
  telecom cables and service drops; the bracket lamp, blue evacuation plate and
  no-through sign on the pole at the foot; the stair-head street lamp, the red
  vending machine, the curve mirror, the 須賀神社 pillar and the notice board
  (`world/props.ts`).
- **Draw calls.** `batchStatic` merges about 3 600 meshes into 96 draws and
  about 140 000 triangles (the export report lists both).
- **Sound.** The abura-zemi chorus in the cherry, bouts of min-min-zemi,
  leaves in the breeze and the city hum are synthesised and pan with the
  camera (`audio.ts`).
- **Finish.** N8AO, a bloom above luminance 1.6, ACES tone mapping and the
  shared grade (`places/shared/post.ts`, `places/shared/grade.ts`).

## How Radio Kaikan at Blue Hour is put together

- **Site.** The origin is Radio Kaikan's NE corner at sidewalk level, +X
  east and −Z north; the 24 m north facade lies on z = 0 and the 48.6 m
  footprint runs to z = 48.6 (OpenStreetMap way 47127856). The one-way
  street runs along X: sidewalks of interlocking pavers on both sides,
  6.8 m of asphalt 12 cm lower, building lines 18.9 m apart, zebra
  crossings east of the corner and at the station exit, and Chuo-dori across
  the west end (`world/layout.ts`). Neighbours take their OSM footprints:
  the finance building, Sofmap AKIBA 駅前館 and namco to the east, the
  pachinko hall and the Chuo-dori corner to the west, Gamers and atre 1
  opposite, LAOX and Onoden closing the vista.
- **Radio Kaikan.** Ten floors to GL+44.2 m and the penthouse to 46.5 m:
  the recessed ground floor under a soffit with downlights (The AKiBa gift
  shop, the entrance with the MIZUHO ATM and AKIHABARA RADIOKAIKAN signs,
  C-labo, the B1 beer hall stairs), the yellow LED band at 2F with channel
  letters (世界の / ラジオ会館 with the two green dakuten balls / 秋葉原) and
  the LED screen, eight ribbon floors with backlit window artwork over
  white spandrels, the floodlit billboard over 3F–4F, and the west strip of
  horizontal louvres lit from behind (`world/kaikan.ts`).
- **Signs.** Lightboxes and posters are drawn into one skyline-packed canvas
  atlas, the window artwork, billboards and shop interiors into a second, and
  channel letters into an alpha-tested third (`places/shared/atlas.ts`; every
  cell has a 16 px border of its own edge pixels). The LED band (32 frames of bar patterns), the screen
  (16 frames of a generic advert loop), the pachinko hall's red ticker and
  the green message board are animated signs (`places/shared/signs.ts`).
  Lettering uses the real shop names in their colours; no logo artwork is
  traced and no characters appear.
- **Light.** The sun is 5° below the horizon at azimuth 262°, down the
  street; the sky dome is the twilight model (`places/shared/sky.ts`), a
  hemisphere light takes its averaged colour, and a cube capture of the
  street lights the reflections. Lantern lamp posts, panel lights in front of
  every lit sign and shopfront, and the soffit's spot lights do the rest.
- **Life.** Eleven pedestrians on the shared people rig walk the street
  (closed to vehicles 16:00–19:00) and wait by the entrance and the pole
  clock; a ten-car Sobu Line local crosses the bridge north of the street in
  the first 20 s of every 40 s, and its rumble plays on the same clock.
- **Finish.** N8AO, a bloom above luminance 1.0, AgX tone mapping and the
  shared grade with cool shadows and warm highlights (`places/shared/post.ts`).

## How Kamakura-Kōkōmae Crossing is put together

- **Site.** The origin is the crossing on the rail (OSM node 3937261506), +X
  east, −Z north; heights are above the rail, 10.2 m T.P., so the sea lies
  at y = −10.2. The track, Route 134, the sea wall and the beach follow the
  Enoden centreline at the offsets of the junction cross-section (sidewalk
  2.8–7.6 m, lanes 7.6–17.1 m, sea-wall top to 18.8 m, sand 8 m below); the
  slope road follows the GSI 1 m profile (10 % grade) and PLATEAU's road
  edges (`world/layout.ts`). East of x ≈ 410 m the track bends inland toward
  Shichirigahama station behind the houses.
- **Hillside.** Ground heights interpolate the GSI survey and the PLATEAU
  building bases on two grids that follow the slope road's edges and the
  track exactly, with rock-faced and block retaining walls on those lines
  (`world/terrain.ts`); 195 PLATEAU buildings (footprints, ground levels,
  heights) and rows of houses beyond ±250 m share one facade atlas tinted per
  house through vertex colours (`world/buildings.ts`).
- **Crossing.** Masts north-east and south-west of the road (striped and
  plain crossbucks, two red lamps per face, the ふみきり LED box, the bell and
  the direction indicator), four striped gate arms, the ochre deck with the
  green pedestrian strip, spike mats, the rules board, cabinets
  (`world/crossing.ts`); `world/timeline.ts` drives the sequence.
- **Sea.** `places/shared/water.ts` on a few large triangles to 25 km, three
  surf strips (outer bar, inner bar, shore break; one moving mesh each), sailboats, and the coast in the haze (Inamuragasaki, Miura,
  Enoshima) as low-poly curtains placed by their angles above the horizon
  (`world/sea.ts`, `world/far.ts`).
- **Life.** One Enoden 500 type (two articulated units, 50.8 m) per 120 s
  loop, eight vehicles on Route 134, two visitors on the shared people rig
  (`world/train.ts`, `world/traffic.ts`, `world/people.ts`).
- **Sound.** Surf in sets, the road, cicadas, the electronic bell while the
  crossing rings, the train's motor (`audio.ts`).

## How Sangubashi in Bloom is put together

Open `/?q=high&cam=Crossing#/place/sangubashi-crossing`. The six camera buttons,
free orbit, keyboard movement, cinematic mode and globe entry use the normal
place shell. `?cam` also skips the intro when the HUD is visible.

The photo-based site has two 1,067 mm tracks, sleepers and rail fasteners,
crossing infill and check rails, two diagonal signal assemblies with hooded
lamps and animated gates, overhead contact wires and gantries, and a short lane
descending to the shuttered house and its outside stair. Housing, garden
walls, utility poles, service drops, a convex mirror, gutters and vegetation
surround the crossing, including the reverse view.

`shared/daylight/` provides the daylight recipe, material baker, house kit
and foliage helpers. It uses the common `PlaceStage` lifecycle, sky baker
and post chain; Suga also reuses its materials, geometry and foliage. Its reusable tree builder grows tapered limbs
and alpha-tested branch sprays; a seeded canvas atlas draws each cherry
flower with five notched petals and stamens. Instanced curved petals settle
in gutters; ordinary 24-joint skin batches carry the windborne petals through
the glTF animation path. Spring audio is synthesised wind, city
hum and occasional birds, with a timed crossing bell and wheel rumble.

An eight-car, photo-based Odakyu 1000-series local passes every 64 seconds.
The reusable commuter builder supplies open window apertures and glazed
interiors, sliding-door leaves, brushed panels, cabs and wipers, 32 rotating
wheelsets, sprung bogies, underfloor services, gangways, roof coolers and
pantographs. The same clock drives the train, warning lamps, barrier arms and
sound; gates stay closed until the last car clears. Moving casters invalidate
the shared daylight shadow map near the crossing. Start at
`/?q=high&cam=Train&t=16#/place/sangubashi-crossing` to review the arrival.

See [the place notes](src/places/sangubashi-crossing/README.md) for real-location
references, reconstruction limits and the offline Vita export/build workflow.
The handheld geometry profile and cooked packs have host validation; device
shader compilation, GPU timing and physical screen acceptance remain pending.

## Layout

```
src/
  core/        app shell, stage lifecycle, quality presets, audio, params
  ui/          DOM overlay: place list, tooltip, loading screen, HUD
  globe/       the globe stage
  places/
    registry.ts          every place on the globe, its kind (`PlaceKind`) and which ones are enterable
    shared/              what places of a kind share:
                         stage.ts (camera rig, sun shadow fit, light probe, export hook),
                         bake.ts, geo.ts (bearing, batching), shapes.ts, canvas.ts,
                         atlas.ts (canvas atlas, shelf or skyline packing, edge borders),
                         pbr-atlas.ts (albedo / height / ORM painting, normal maps),
                         sky.ts (day and twilight dome, cloud panorama bake),
                         post.ts + grade.ts (post chain from a place's look),
                         glass.ts, interior.ts, water.ts, signs.ts, camera.ts,
                         people/ (skinned rig, motion, wardrobe, carried objects, paths),
                         export.ts (glTF + extras.pocketAtlas for the cooker,
                         driven by scripts/export-place.ts)
    tokyo-konbini/       Rainy Night Konbini
      gfx/       materials, wet/glass/interior shaders, reflection, canvas art
      fx/        rain, post-processing
      world/     street plan, ground, konbini, neighbours, props, traffic, people, sky
    suga-shrine-stairs/  Suga Shrine Stairs
      gfx/       daylight surfaces and materials, quad builder
      world/     site plan, terrain, stairs, houses, props, tree, far field, sky
    akihabara-radio-kaikan/  Radio Kaikan at Blue Hour
      gfx/       street surfaces, palette-snapped materials, sign and poster art
      world/     site plan, ground, Radio Kaikan, facade toolkit, neighbours,
                 props, people, viaduct and towers
    kamakura-koko-mae-crossing/  Kamakura-Kōkōmae Crossing
      gfx/       seaside surfaces, material set, equipment atlas, road signs,
                 train livery, facades, leaf atlas
      world/     site plan and survey data, coast strip, terrain, slope road,
                 buildings, crossing, props, train, traffic, people, sea, far coast
```
