# PSP place viewer

The PSP cooker accepts `night-street`, `daytime-slope` and `daytime-street`.
Place selection stays in the shared pipeline; the renderer has no place-ID
branches. Export and cook the ordinary Vita-format pack first, then run:

```sh
bun tools/atlas-psp.ts cook --place sf-lombard-street
bun tools/atlas-psp.ts build --place sf-lombard-street
bun tools/atlas-psp.ts package --place sf-lombard-street
```

The standalone package contains `EBOOT.PBP` and `scene.place`. The latter is
**PLPS version 2**, separate from the Vita and PICA formats. Version 1 packs
must be re-cooked with this checkout. The 144-byte header and camera-table
offset are retained; the old 12 reserved bytes now contain the sky vertex
span and texture index. All sky pointers, texture references, GE counts,
finite coordinates, unit directions and UV bounds are validated before use.

## Daylight adaptation

- The authored sky, sun disc/glow, cloud panorama, exposure and colour grade
  become one 512 × 256 swizzled RGBA4444 panorama. A unit dome follows camera
  position, retaining its world orientation. An ordered dither reduces sky
  banding. Sky is drawn once, before scene depth, and is included in telemetry.
- Directional sunlight is added to the existing ambient/sky-occlusion vertex
  bake. A BVH over static, shadow-casting opaque geometry tests the sun rays;
  alpha-tested foliage uses partial occlusion. Shadow detail is limited by
  the retained vertices, rather than a per-pixel shadow map.
- Moving objects retain their authored node/skin tracks and use first-frame
  directional illumination. They do not keep a frozen world-shadow mask as
  they move. Animated cast shadows and changes in sun-facing normals are not
  reproduced by the fixed-function bake.
- Daylight scene textures are capped at 256 px (luminous signage at 512 px),
  with the existing mip chains and alpha-tested foliage. The 18 MiB PLPS
  limit remains enforced. The full authored grade is baked into daylight
  colours; GE still multiplies texture and vertex colours in display space.
- Daytime kinds disable rain, rain audio, lamp halos and planar wet-road
  reflections. Controls and telemetry reflect the effects actually present.
  The night-street effect set and legacy grade remain available.

Clouds are fixed at their authored phase; cloud drift, HDR/PBR, normal maps,
dynamic per-pixel lighting and bloom remain outside this GE adaptation.
Sky costs 2,304 triangles, one draw and roughly 418 KiB of pack storage.

## Validation

```sh
cargo test --locked -p pocket3d-place-cook -p pocket3d-place-psp
bun test tools/psp-session.test.ts
```

The host tests convert synthetic day/night packs, verify sky and effect
selection, reject corrupt sky payloads, and check sunlight orientation and
shadow blockers. Test receipts stay in
`.pocket-build/validation/psp-daylight-tests/`.

Use exactly one `usbhostfs_pc` owner for physical checks. Measure and capture
every authored camera through `bun tools/atlas-psp.ts shots --place <id>`;
keep capture/transfer windows outside timing samples. `gpuWaitMs` is the GE
wait remaining after CPU submission, not serialized GPU timing. Host tests
and cross-compilation do not establish on-device fidelity or frame budgets.
