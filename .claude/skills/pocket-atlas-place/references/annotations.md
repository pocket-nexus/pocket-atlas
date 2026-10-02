# Export annotations (`extras.pocketAtlas`)

The web exporter (`web/src/places/shared/export.ts`) writes glTF 2.0 with these annotations; the cooker reads them (`crates/pocket3d-place-cook/src/main.rs`, `extras.rs`) into the pack (`crates/pocket3d-place/src/meta.rs`). The README sections named in brackets document each in full.

## Materials

| `kind` | Cooks as | Fields |
| --- | --- | --- |
| (none) | `Standard`: lit, baked vertex lighting when static | glTF PBR; `wet`, `damp`, `polygonOffset: [factor, units]`, `fog`, `lodBias` (any kind with a texture: mip levels, or `"auto"`: the cooker measures how many more texels per metre the mapping lays one way than the other and biases by the ratio, from 1.5:1 up to −2; for window grids whose floors blur on the Vita's isotropic mips) |
| `unlit` | `Unlit`: HDR colour × texture, no lighting | `color: [r, g, b]` (HDR, linear), `fog` |
| `sign` | `Unlit` with `UvAnim` [Signage] | `color`; flipbook `frames`, `cols`, `rows`, `fps`; `scroll: [u, v]` (widths/s); `phase` (s). Flipbook first, then scroll; mesh UVs span frame 0's cell (v down) |
| `glass` | `Glass`, premultiplied blend | Use the shared glass material so the web blends the same way |
| `interiorWindow` | parallax room behind a pane | `intensity`; UV integer part = room seed |
| `products` | shop stock from a packaging atlas | `lit`, `packMix`, `pack` |
| `tower` | distant lattice, additive | — |
| `water` | `Water`, one draw, not chunked [Coast places] | normal map = wave texture; `waves: [[repeatsPerMetre, scrollX, scrollZ] ×2]` (required), `body: [r, g, b]` (required), `shallow` (vertex colour red blends toward it), `mask` (wave-face tilt toward the eye), `distanceRoughness`; `roughness` = GGX α near the camera; `normalScale.x` = slope scale |
| `lights` | `Lights`: a light field, one vertex per light, additive point sprites [Dusk vistas] | on a `THREE.Points` material: `minPixels`, `maxPixels` (pixels of a 272-pixel-high frame), `gain`, `depthPull` (per km of distance, default 0.012), `loop` (s, default: the exported loop). Point attributes: `position`, `color` (COLOR_0, linear, largest channel 1), `light` → `_LIGHT` (intensity, radius m, phase 0–1, twinkle 0–1), optional `path` → `_PATH` (dx, dy, dz m, whole cycles per loop) and `blink` → `_BLINK` (whole cycles per loop, duty) |

`Standard` materials can carry `emissionShade` ([Shaded emission] in README): normal coefficients and height range/gains for authored emission, also modulated by vertex colour.

Any material may carry `frames`/`scroll` (e.g. surf strips): `UvAnim` applies to every kind.

## Nodes

- `dynamic: true` — the node moves (tracks recorded for the loop); not baked, not in the sun's shadow map, one draw per node. Do not use it to keep a static mesh out of the web's batching: batching keeps vertex colours.
- Lights: point, spot and the panel lights the exporter writes are baked into static vertices; `castShadow` on the directional light makes it the per-pixel sun.

## Scene (`extras.pocketAtlas` on the scene)

- `kind` — from the registry's `PlaceDef.kind`.
- `sky` — `model: "gradient-sun-cloudpanorama"` with zenith, horizon, ground, `gradientPower`, `groundBlend`, `sunDirection`, `sunColor`, `glow {intensity, wide, tight}`, `disc {intensity, cosInner, cosOuter}`, `clouds {file, sunColor, sunScale, ambientColor, fadeElevation, driftTurnsPerSecond}`, and after sunset `twilight {band {color, height, sunBias, sunPower}, belt {color, elevation, width, power}, shadow {strength, height, power}}` [Daytime places, Dusk places].
- `sun` — azimuth, elevation, direction (informational; the directional light drives the device).
- `bake.skyOcclusion` — `rays`, `reach` (m), `foliage` (opacity of cut-out leaves), refinement `minEdge`, `abs`, `rel`, `rounds`, `grow` [Daytime places].
- `post` — `tone` (`agx` or `aces`), `exposure`, `contrast`, `saturation`, `lift`, `gain`, `vignette`, `grain`, `bloom {threshold, smoothing, intensity}`.
- `camera.shots` — named `from`/`to` keyframes (`pos`, `target`, `fov`) and durations; the device's cinematic rig plays them, `tools/atlas.ts` measures them by name.
- Haze: night streets with `fogLights`; other kinds leave it out (no haze pass).
- `haze` with an `inversion` — the vista haze [Dusk vistas]: `density` (ρ0, 1/m), `inversion` (H, place y), `scale` (s, m), `gain`, `glow: [r, g, b]`, `band` (the weight of the sky's sun side, the glow lobes and the afterglow band, in the inscatter of clear air: `w = band + (1 − band)·(1 − T)`, so it reaches 1 at full optical depth; default 1, the dome at any depth); replaces the uniform fog on every material that has fog. Without `inversion`, `haze` is the night streets' lit haze.
