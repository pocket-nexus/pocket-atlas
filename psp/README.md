# Pocket Atlas on the PSP

The app opens on the atlas and visits the places packed into its EBOOT.PBP
(or beside it, during development).
[The interface](../README.md#the-interface) (`ui/`, shared with the other
handhelds) draws the lists, cards, search, menus and hints: `interface.rs`
runs it as a guest on PocketJS's PSP host library and lays its picture over
the GE frame. The renderer draws the globe (`globe.rs`: a lit sphere with the
city lights added, a halo and a sprite per place, all GE) and the places.

The PSP cooker accepts `night-street`, `daytime-slope`, `daytime-street`,
`daytime-coast`, `dusk-street` and `dusk-vista`: every live place. A night
street keeps its rain, wet reflections and lamp halos; every other kind is
lit by its authored sky (panorama, sun bake and grade). Place selection stays
in the shared pipeline; the renderer has no place-ID branches. Export the
shared web scene; the wrapper imports PlaceIR and lowers it directly for PSP,
without a Vita device pack as input:

```sh
bun tools/atlas-psp.ts cook --place sf-lombard-street   # each place the PSP should carry
bun tools/atlas-psp.ts build
bun tools/atlas-psp.ts package
```

`build` compiles the interface (`tools/atlas-ui.ts psp`) and writes the
executable, `atlas.js`, `atlas.pak`, `globe.psp` and every cooked
`<id>.place` to the USB share; `package` writes **one file**,
`dist/PSP/GAME/PocketAtlas/EBOOT.PBP`, which carries all of them (One file,
below). A pack is **PLPS version 4**, separate from the Vita and PICA
formats. Older packs must be re-cooked with this checkout. The header is 176
bytes: version 4 added the near range's far plane, the vista range and the
light sprites. Each texture record declares RGBA4444 or RGBA8888; validation
checks every mip span using its actual bytes per pixel. All sky pointers,
texture references, GE counts, sprite weights, finite coordinates, unit
directions and UV bounds are validated before use.

## One file

A release is one EBOOT.PBP. Its DATA.PSAR section (from the eighth offset of
the PBP's table to the end of the file) holds a `PKAR` index (magic, version
1, count, then 64-byte entries: a name of up to 47 bytes, the offset from the
section's start and the size) and then `atlas.js`, `atlas.pak`, `globe.psp`
and every place, each at a multiple of 64 bytes. PARAM.SFO, ICON0, PIC1 and
DATA.PSP keep their offsets, so the XMB lists and starts it as before.

`files.rs` opens the EBOOT on the thread `psp_main` starts on (the only
thread with the EBOOT's folder as its directory), reads the index and keeps
the one handle; every packed file is read from it by offset and size. Files
beside the EBOOT and on `host0:` are the fallback, so `DATA.PSP` started from
the PSPLINK share reads the share's loose files as before. `status.json`
names where a place's pack was read (`packSource`: `EBOOT.PBP`, `folder` or
`host0`). Loose places beside the EBOOT are opened one at a time, on request,
by the starting thread: the Memory Stick refuses to hold more than about ten
files open at once.

## Daylight adaptation

- The authored sky, sun disc/glow, cloud panorama, exposure and colour grade
  become one 512 × 256 swizzled RGBA8888 panorama. A unit dome follows camera
  position, retaining its world orientation. Eight-bit colour avoids the
  magnified checkerboard caused by ordered four-bit dither. Sky is drawn once, before scene depth, and is included in telemetry.
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
  textures keep the compact policy so luminous atlases fit the pack budget.
- Daylight scene textures are capped at 256 px (luminous signage at 512 px),
  with the existing mip chains and alpha-tested foliage. The 24 MiB PLPS
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

## Vistas, lights, water and thin parts

- **Two depth ranges.** A sky-lit place draws every static draw that lies at
  least 400 m from every camera position (each shot's ends and middle, the
  free camera's walkable volumes) in a vista range of its own, with the
  near plane at 0.9 × its nearest distance; then the 16-bit depth buffer is
  cleared and the near range is drawn from 0.5 m. Griffith Observatory's
  vista range runs from 361 m to 139 km; its near range ends at 2.6 km.
  Neither range has place-specific planes: both come from the draws' bounds.
- **Vista haze** is in the vertex colours, as seen from the middle of the
  camera shots, through the same height-haze model as the 3DS (`vista` in
  `pica.rs`). A vista place has no GE fog. Other sky-lit places fit linear GE
  fog to where the authored exp² fog goes from 5% to 95%
  (0.226 / density to 1.73 / density); a night street keeps 12 m to
  1.8 / density, at most 250 m.
- **Light fields** (`psp_lights.rs`) are GE sprites, two corners per light,
  from PICA's merged and graded sprite colours. The GE places them from three
  bone matrices set each frame: the light, the camera's right + up scaled to
  pixels at the light's depth, and the step toward the camera. Each corner's
  weights fix its pixel size and its depth pull, so no CPU work is done per
  light. Griffith Observatory carries 34,925 sprites in 268 culled groups.
  They are added with depth test and no depth write. Lights do not travel,
  blink or twinkle here: a travelling light stands where its path starts, a
  blinking one shines at its duty cycle's share.
- **Open water** (`psp_water.rs`) is laid again as a polar grid about the
  middle of the shots (rings 12% apart, 64 segments): the Fresnel mix of body
  colour and reflected sky is in its vertex colours, and one wave layer
  scrolls as a luminance texture. The far rings are cut into 22.5° sectors
  that fall in the vista range. There is no sun glitter path and no second
  wave layer.
- **Glow.** A sky-lit surface with an emission map beside its albedo
  (floodlit stone, a train's windows), and in a vista one with an emission
  map alone (a far tower's windows), is lit without it and drawn a second
  time with the map added (`GLOW`), its strength through the haze in the
  vertex colours.
- **Thin parts** (`psp_thin.rs`). The shared coarse level drops parts
  narrower than its error and breaks others: posts, poles, wires, rails and
  signal arms. On a sky-lit place a part under 30 cm across and at least
  1.5 m long, within 150 m of the middle of the shots, is drawn from the
  finest level that has it; one narrower than 1.5 px from there is widened
  along its normals to that, at most to 50 cm across.

## Memory

The 24 MiB pack buffer is reserved first, then the interface: QuickJS, the
UI core, its fonts and the place cards (kept as 16-bit texels) take about
5 MiB. On a PSP-3000 started from the Memory Stick under PSPLINK, with the
24 MiB buffer and the interface up, 19.6 MB of the arena is still free at the
atlas and 13.0 MB with Kamakura up; the XMB leaves about 4 MB less. The
largest pack is Sangubashi's, 21.4 MB. `PARAM.SFO` asks for the large memory of a PSP-2000 or later
(`MEMSIZE`), where both fit with room to spare. On a PSP-1000 the buffer is
what is left, and a place whose pack does not fit it is listed as not on the
device rather than failing to load.

The guest is given a turn only when a button is down or was a moment ago,
when the renderer's state changed or when its last turn drew something new;
otherwise about once a second (`Rest` in `crates/pocket-atlas-interface`).
The status reports its turns as `interfaceMs` (a frame's share of them) and
`maxInterfaceMs` (the longest since the last report). On a PSP at 333 MHz a
resting interface takes 0.1 ms of a frame and its look-in 2 to 4 ms; a step
in a list is one turn of about 37 ms, a change of list 70 ms, a keystroke 70
to 250 ms, and mounting a view is the long one: 0.5 s for the atlas after a
place, 0.8 s for the keyboard.

A view that was left stays allocated until a collection (its objects refer to
each other), and the arena never hands a block to a request of another size,
so the guest is collected between scenes and, once it has come to rest after
something happened, when the arena has had to grow by 128 KiB since the last
collection. A collection stops the frame for 35 to 80 ms; until the arena
grows, what the guest dropped has been handed out again and there is nothing
to gain from one.

## Validation

```sh
cargo test --locked -p pocket3d-place-cook -p pocket3d-place-psp -p pocket-atlas-interface
bun test tools/psp-session.test.ts ui/test
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
