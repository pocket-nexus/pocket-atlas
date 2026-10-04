# Pocket Atlas on the iPod touch 4

A native ARMv7 app for the iPod touch 4 (iPod4,1, iOS 6.1.6): a list of the places that opt in (`targets: "ipod"` in the web registry), each drawn at 480×320 with OpenGL ES 2 on the SGX535, as a tour of its authored shots or under the fingers. It is two C files and one tool:

| Path | Contents |
| --- | --- |
| `ipod/src/scene.c`, `shaders.h` | one place: pack loader, culling and levels of detail, the mirror, sky, light sprites, rain and glows; six small GLSL programs |
| `ipod/src/main.c` | the UIKit shell (place list, a bar of controls, touch), the render thread, commands, status and captures |
| `tools/atlas-ipod.ts` | cook, build, install, launch, control, capture, measure |
| `crates/pocket3d-place-cook/src/pica.rs`, `profiles/ipod30.json` | the pack: the 3DS lowering with GLES texels and a dusk vista's lights and haze |

## How it draws

The iPod reads the table the 3DS reads (`n3ds/src/format.h`): light, grade and static sky occlusion are cooked into display-referred vertex colours, so a surface is one texture fetch times one colour, with fog. What the SGX535 adds over the PICA200's fixed combiners is small: the wet ground mixes a half-resolution planar mirror through a puddle mask, open water multiplies two scrolling wave layers into a Fresnel blend of body and sky colour, and a dusk vista's lights are point sprites. The pack differs from the 3DS one in three ways (`gles` in `pica.rs`): texels are plain rows (RGB565, RGBA8 behind an alpha channel and for the sky), surfaces go up to 512 texels, and the `FELD` section carries the light fields. Their container version differs, so neither device loads the other's pack.

What is cooked for this target only:

- **Vista haze and light fields** (Griffith Observatory): its cameras stay within tens of metres of each other while haze and lights work over kilometres, so both are cooked as seen from the middle of the shots. The haze goes into the vertex colours; each light's energy goes through the haze and the tone curve into a sprite colour. Sprites blend after the tone curve here, so still lights beyond 1 km within a pixel and a half of each other are summed into one first (Griffith's 58 500 lights become 37 700 sprites).
- **Sunlight without cast shadows**: one shadow ray per vertex cuts wedges across whole walls; the unshadowed sun over the baked sky occlusion reads cleaner at this size.
- **People**: a skinned mesh gets two reduced levels by collapsing only triangles bound to a single joint, and is lit by the mean light along its path.
- **Decals** (road paint) keep full detail: paint collapses within its plane at no measured error.
- **Emission maps and windows**: a surface with an emission map of its own (the floodlight cones on the observatory's walls, a distant tower's lit windows, a train's headlights) has that map added to its lit texture, which costs it a second fetch; a window pane takes the light of its room (dark, a warm or a cool lamp, the material's tint) as the Vita's shader picks it, over one neutral room texture.

The frame time on this device follows the triangles submitted, about 0.2 ms per thousand, not the pixels: a quarter-size viewport changes nothing. So the renderer spends its effort there. Static chunks are 16 m cells; each picks the coarsest level whose error stays under one pixel; adjacent chunks of a material share one index buffer that is rewritten only when the choice of chunks and levels changes, which makes a material one draw call with no per-frame index traffic. People are skinned on the CPU, only the vertices of the level drawn.

The EAGL layer is the portrait screen, opaque and untransformed, and nothing lies over it while a place plays (the scene is drawn a quarter turn round instead): Core Animation then shows the frame as it is rather than compositing it with the same GPU. A tap calls up the bar of controls for four seconds.

Not here: the globe, a settings sheet, sound, saved state. Leaving the app ends it (PocketJS's link stubs carry no UIKit version, and UIKit ends an app that old when it is suspended). Against the Vita it also lacks per-pixel lighting, normal maps, rooms traced behind windows (a flat room texture stands in), glass reflections, steam and bloom.

## Build and run

Requirements: Bun, Rust, Xcode's command line tools with `ld-classic`, `ldid`, ImageMagick, the PocketJS iPod touch 4 toolchain (`bun ipodtouch4 doctor` in `vendor/pocketjs`), and for the device a jailbroken iPod4,1 on iOS 6.1.6 with AppSync, `idevice_id`, `ideviceinfo`, `iproxy`, SSH and SCP.

Export each place and its preview as for the Vita (`web/scripts/export-place.ts`, `preview-place.ts`), then:

```sh
bun tools/atlas-ipod.ts cook                 # → .pocket-build/ipod/assets/<id>.place and its list card
bun tools/atlas-ipod.ts deploy               # build, package, install, read every installed file back
bun tools/atlas-ipod.ts launch
bun tools/atlas-ipod.ts ctl '{"place":"tokyo-konbini","shot":0,"time":25}'
bun tools/atlas-ipod.ts status
bun tools/atlas-ipod.ts capture --out .pocket-build/validation/ipod/view.png   # the place, 480×320
bun tools/atlas-ipod.ts capture --screen                                       # the display with UIKit
bun tools/atlas-ipod.ts shots                # every authored shot: frame times, then a capture
bun tools/atlas-ipod.ts native --place ID    # replace the executable (and one pack) in place
```

`ATLAS_IPOD_BUNDLE_ID` installs a build beside another under its own identity (`dev.pocket-nexus.atlas` otherwise).

Commands are JSON: `place` (an id) enters a place and `atlas: true` leaves it; `shot` (index or name) cuts to a shot's midpoint; `time` freezes the loop at that second and a negative one releases it; `view: [x, y, z, tx, ty, tz, fov]` pins a camera; `cinematic`, `pause`, `reflection`, `rain`, `glow` are switches; `lod` is the error tolerance in pixels (1); `bar: true` calls up the controls; `profile: true` waits for the GPU inside every frame (`gpuMs`, not a frame rate).

On the device: one finger on the left half walks, one on the right half looks, either leaves the tour; a tap shows the bar (the list, previous and next shot, pause).

## Measuring

`shots` holds each authored shot at its midpoint with the loop frozen at 25 s, waits two seconds, lets 120 frames go by with no traffic to the device, then reads the status and captures. `fps` is presented frames over that window; `renderMs` runs from the start of the frame to the last GL call, `presentMs` is `presentRenderbuffer`, `prepareMs` the CPU part before any drawing. Presentation follows the display's 60 Hz, so rates settle on 60, 40 (alternating one and two refreshes) and 30. These are fixed views: a tour or a walk changes the chunks and levels every few frames, and the first frame of a new view rewrites its index buffers.

Status reads over SSH preempt the single core; read after the window, not during it. The receipt and captures stay in `.pocket-build/validation/ipod/`; device results belong in the pull request.

Not verified by the tool: touch handling under real fingers, the sharpness of UIKit text on the screen (the legacy screen capture returns 480×320), and thermal behaviour over a long session.
