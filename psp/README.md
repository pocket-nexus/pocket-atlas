# PSP place viewer

The PSP cooker accepts `night-street`, `daytime-slope` and `daytime-street`.
Place selection stays in the shared pipeline; the renderer has no place-ID
branches. Export the shared web scene; the wrapper imports PlaceIR and lowers
it directly for PSP, without a Vita device pack as input:

```sh
bun tools/atlas-psp.ts cook --place sf-lombard-street
bun tools/atlas-psp.ts build --place sf-lombard-street
bun tools/atlas-psp.ts package --place sf-lombard-street
```

The standalone package contains `EBOOT.PBP` and `scene.place`. The latter is
**PLPS version 4**, separate from the Vita and PICA formats. Older packs
must be re-cooked with this checkout. The header is 164 bytes; its camera-table
span remains at byte 48. It combines the bounded `sky_vertices` span with
separate sky/cloud textures, cloud drift, LOD tolerance and an optional audio
record. Each texture record declares RGBA4444 or RGBA8888; validation checks
every mip span using its actual bytes per pixel. All sky pointers, texture references, GE counts,
finite coordinates, unit directions and UV bounds are validated before use.

## Daylight adaptation

- The authored sky, sun disc/glow, exposure and colour grade become a
  512 × 256 swizzled RGBA8888 panorama. An optional second panorama stores
  premultiplied clouds and drifts with the authored scene clock. A cooked
  32 × 16 unit dome follows camera position at a 100 m radius, retaining its
  world orientation. Eight-bit colour avoids the magnified checkerboard caused
  by ordered four-bit dither. Both layers draw before scene depth and are
  included in telemetry.
- Directional sunlight joins the ambient/sky-occlusion bake **before** adaptive
  refinement and LOD selection, so the simplifier sees its lighting boundaries.
  A BVH tests static opaque casters; cutout foliage uses partial occlusion.
  The GE policy uses a 1 m minimum refinement edge, four rounds and a 0.5 m
  receiving-normal contact guard. This suppresses unresolved trim/window
  self-shadow streaks; the full-detail sky-occlusion bake still provides their
  contact shading. Large building shadows remain. This is a coarse vertex
  approximation, not a per-pixel shadow map; sub-metre sun contacts are omitted.
- Explicit source `window` annotations lower to GE surface overlays with an
  intact pane outline and depth bias. Coarse open-boundary simplification can
  otherwise erase window cards after the lighting tessellation changes.
  The same silhouette rule applies to authored polygon-offset decals.
- Opaque static daytime solids use twice the shared geometric LOD error
  (12/50 cm in the near field), with baked lighting still part of the error
  metric. Foliage, animated geometry and overlays retain their existing
  bounds. This is a GE-only tradeoff: small solid trim may disappear sooner;
  it compensates for the extra sunlight-boundary vertices.
- Moving objects retain their authored node/skin tracks and use first-frame
  directional illumination. They do not keep a frozen world-shadow mask as
  they move. Animated cast shadows and changes in sun-facing normals are not
  reproduced by the fixed-function bake.
- Daylight glossy colour maps (glass or standard materials with roughness ≤ 0.25)
  retain RGBA8888 gradients; other material maps retain compact RGBA4444.
  Shared texture usage is aggregated before choosing the encoding. Night
  textures keep the compact policy so luminous atlases fit the 18 MiB budget.
- Daylight scene textures are capped at 256 px (luminous signage at 512 px),
  with the existing mip chains and alpha-tested foliage. The 18 MiB PLPS
  limit remains enforced. The full authored grade is baked into daylight
  colours; GE still multiplies texture and vertex colours in display space.
- Daytime kinds disable rain, rain audio, lamp halos and planar wet-road
  reflections. A scene's optional procedural audio recipe remains active.
  Controls and telemetry reflect the effects actually present. The night-street
  effect set and legacy grade remain available.

HDR/PBR, normal maps, dynamic per-pixel lighting and bloom remain outside this
GE adaptation. Sky costs 1,024 triangles per layer, one draw per layer and
72 KiB of shared mesh storage; each sky/cloud panorama adds 512 KiB, excluding
record/alignment overhead.
Vehicle glazing uses shared open-frame geometry; no closed painted cabin face
sits behind a pane. This removes depth competition at the source for every
backend rather than depending on a PSP-only depth bias.

## Motion, depth and audio

Native tracks retain every sample in the authored interval, including
Sangubashi's 960 samples over 64 seconds. Compact translation/quaternion tracks
share constant and identical data; normalized shortest-arc quaternion
interpolation preserves rigid shape. Source node scales and skeletal joint
tracks remain intact. Skinned vertices retain float positions; rigid batches
use packed 16-bit positions only when they meet the recipe's error bound.
Camera-distance LOD and shared vertex/index buffers retain nearby equipment
while limiting distant submission. Unused UVs in untextured batches are
canonicalized before welding; sampled texture coordinates are preserved.

GE drops a whole triangle when a projected corner is outside its 0–4096
viewport range, even after near-plane clipping. The renderer clips risky
triangles before submission in their original 3D frame, interpolating colour
and UVs while preserving winding and draw order. Safe triangles keep resident
indices. Local 16-triangle block bounds skip safe ranges; the cache is bounded
at 256 KiB and falls back to scanning when full. Scratch vertices remain alive
until GE completion. This handles long roofs and other near-camera surfaces
without a scene-specific branch, two-sided material workaround or near-plane
change.

Shared house/vehicle geometry cuts actual window openings so panes have no
hidden opaque backing. Intentional signs and labels use explicit polygon-offset
decals; the runtime does not apply a global depth bias to conceal intersections.

The optional 128-byte audio record describes procedural wind, birds and railway
warning/train sounds. Synthesis follows the scene clock and camera position,
handles seek, pause and Circle mute, and stops when leaving the scene. It uses
no sampled film soundtrack. `audioReady` reports mixer initialization, not a
listening check. Night-street rain and door sounds retain their own behavior.

## Validation

```sh
cargo test --locked -p pocket3d-place-cook -p pocket3d-place-psp
bun test tools/psp-session.test.ts
```

The host tests lower synthetic day/night shared analysis, verify sky and effect
selection, reject corrupt sky payloads, and check sunlight orientation and
shadow blockers. Test receipts stay in
`.pocket-build/validation/psp-daylight-tests/`.

Use exactly one `usbhostfs_pc` owner for physical checks. Measure and capture
every authored camera through `bun tools/atlas-psp.ts shots --place <id>`;
keep capture/transfer windows outside timing samples. `gpuWaitMs` is the GE
wait remaining after CPU submission, not serialized GPU timing. Host tests
and cross-compilation do not establish on-device fidelity or frame budgets.

Existing hardware captures and timings, including Sangubashi's documented
roof/window fixes, belong to their recorded pre-integration build and pack.
They do not establish fidelity or frame budgets for the merged PLPS v4
application; fresh export/cook and physical checks are required for that claim.

Use `package --no-build` after validating a running release to package the exact
staged PRX/EBOOT identity. Without it, packaging creates a fresh runtime build.
The tool verifies the selected place, pack and EBOOT against the build receipt.
