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
**PLPS version 3**, separate from the Vita and PICA formats. Older packs
must be re-cooked with this checkout. The 144-byte header and camera-table
offset are retained. Each texture record now declares RGBA4444 or RGBA8888;
validation checks every mip span using its actual bytes per pixel. All sky pointers, texture references, GE counts,
finite coordinates, unit directions and UV bounds are validated before use.

## Daylight adaptation

- The authored sky, sun disc/glow, cloud panorama, exposure and colour grade
  become one 512 × 256 swizzled RGBA8888 panorama. A unit dome follows camera
  position, retaining its world orientation. Eight-bit colour avoids the
  magnified checkerboard caused by ordered four-bit dither. Sky is drawn once, before scene depth, and is included in telemetry.
- Directional sunlight is added to the existing ambient/sky-occlusion vertex
  bake. A BVH over static, shadow-casting opaque geometry tests the sun rays;
  alpha-tested foliage uses partial occlusion. Shadow detail is limited by
  the retained vertices, rather than a per-pixel shadow map.
- Moving objects retain their authored node/skin tracks and use first-frame
  directional illumination. They do not keep a frozen world-shadow mask as
  they move. Animated cast shadows and changes in sun-facing normals are not
  reproduced by the fixed-function bake.
- Glossy colour maps (glass or standard materials with roughness ≤ 0.25)
  retain RGBA8888 gradients; other material maps retain compact RGBA4444.
  Shared texture usage is aggregated before choosing the encoding.
- Daylight scene textures are capped at 256 px (luminous signage at 512 px),
  with the existing mip chains and alpha-tested foliage. The 18 MiB PLPS
  limit remains enforced. The full authored grade is baked into daylight
  colours; GE still multiplies texture and vertex colours in display space.
- Daytime kinds disable rain, rain audio, lamp halos and planar wet-road
  reflections. Controls and telemetry reflect the effects actually present.
  The night-street effect set and legacy grade remain available.

Clouds are fixed at their authored phase; cloud drift, HDR/PBR, normal maps,
dynamic per-pixel lighting and bloom remain outside this GE adaptation.
Sky costs 1,024 triangles, one draw and roughly 584 KiB of pack storage.
Vehicle glazing uses shared open-frame geometry; no closed painted cabin face
sits behind a pane. This removes depth competition at the source for every
backend rather than depending on a PSP-only depth bias.

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
