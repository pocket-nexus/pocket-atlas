# Nintendo 3DS renderer

Pocket Atlas cooks the canonical `.place` into a native PICA variant. The
renderer uses the same material annotations, baked irradiance, camera shots,
mesh LODs and skeletal animation as the Vita renderer. No scene-name checks
are used in rendering. PocketJS supplies the unmodified paired debug transport
and native install/launch implementation through the pinned submodule.

The top screen is monoscopic 400 × 240. The bottom screen contains the camera
selector, controls and measured CPU/GPU times. Quality aims at a 33.3 ms frame
budget; only measurements on an Old 3DS establish whether a preset meets it.

## Build and install

Initialize `vendor/pocketjs` and start Docker. Export the scene with the web
exporter, then cook the canonical pack with `bun tools/atlas.ts cook`. With
`.pocket-build/places/tokyo-konbini/tokyo-konbini.place` available:

```sh
bun tools/atlas-3ds.ts cook --place tokyo-konbini
bun tools/atlas-3ds.ts build
bun tools/atlas-3ds.ts install --host 192.168.8.159
```

`build` uses PocketJS's pinned devkitARM container and produces the standalone
`dist/3ds/pocket-atlas.3dsx`. Install requires an already paired Pocket Runtime.
For the initial ftpd bootstrap, use PocketJS directly:

```sh
bun vendor/pocketjs/tools/3ds-dev.ts install --ftp --host 192.168.8.159 \
  --file dist/3ds/pocket-atlas.3dsx --name pocket-atlas.3dsx
```

Full builds seed a hash-addressed asset cache in `sdmc:/pocket-atlas/`. Once a
full build has launched, `build --thin` or `install --thin` embeds only a
manifest and reuses that exact cache revision. A missing cache gives a visible
load error; it never silently uses assets from another build. Standalone builds
can still read their embedded assets if writing the optional cache fails.

## Inspect and measure

```sh
bun tools/atlas-3ds.ts status --host 192.168.8.159
bun tools/atlas-3ds.ts ctl '{"shot":"Puddles","step":0,"hold":true,"time":10}'
bun tools/atlas-3ds.ts capture
bun tools/atlas-3ds.ts capture --surface reflection
bun tools/atlas-3ds.ts profile --step 4 --samples 60 --live
bun tools/atlas-3ds.ts sweep --samples 60 --live
bun tools/atlas-3ds.ts tour --seconds 90
bun tools/atlas-3ds.ts ctl '{"hold":false,"play":true}'
```

`POCKET_3DS_HOST` or `--host` selects the device. `--keys` selects an existing
PocketJS pairing-key directory. Captures, timings and build receipts go in
`.pocket-build/validation/3ds/`; they are not source assets. Profiling pins the
camera midpoint, settles, then samples CPU work, retired GPU time and actual
frame interval. `--live` keeps people and traffic animated; omit it for a
repeatable animation time. The device also counts every measured frame and
reports its mean, maximum and a 0.5ms histogram P95. `tour` measures moving
cameras with automatic quality. Input is temporarily locked during benchmarks
and restored afterward; the device expires that lock after three seconds
without control traffic. Emulator timing is not hardware
performance evidence. `hold` pins the quality level; `time` freezes animation
and camera motion until `play` is true.

On-device controls: circle pad looks, D-pad moves relative to the camera,
lower-screen drag looks, and L/R
changes height, A selects the next shot, B switches camera mode, X toggles
quality hold, Y selects a quality level, SELECT toggles reflections. Touch the
shot list to select a camera. The circle pad uses a radial deadzone and a gentle
response curve; diagonal movement is normalized. Entering free camera retains
the current viewing direction. L + R + START returns to Homebrew Launcher.

## Pipeline and diagnostics

- The PICA section contains binary draw/material/texture tables, tiled
  RGB565/RGBA4 mip chains, interleaved vertices and pre-sampled joint matrices.
  Material lighting is cooked to display-referred vertex colors with the same
  authored AgX/ACES grade used by the Vita color LUT.
- The 3DS approximation uses albedo/emission color and baked lighting. It does
  not implement the Vita's complete per-pixel normal/ORM lighting or HDR bloom.
  Room windows, skyline windows and the tower lattice are cooked by material
  kind; rain and local light glow remain dynamic.
- Wet surfaces sample a separate 128 × 256 reflected scene through projective
  TEV texture coordinates. Objects entirely below the reflection plane are
  excluded. Wet coverage and grazing angle control the blend. Opaque surfaces
  keep depth writes; alpha materials are sorted back to front.
- Frustum and projected-size culling, authored mesh LODs, back-face culling and
  cached material/model state reduce submission and fill cost. Detail-only
  street chunks are divided into 8m cells. Reflections use a separate coarse
  proxy. The default main LOD floor is 2; `ctl '{"lodFloor":0}'` exposes the
  original detail for comparison. Quality changes LOD tolerance, reflection
  range and rain density; the governor preserves reflections at every level.
- Materials with identical native GPU state are merged after their authored
  shading is baked. Adjacent static vertices form u16-addressable batches;
  only the visible chunks' selected indices are gathered each frame. CPU
  preparation overlaps the previous GPU frame using two skin/index buffers.
- Submission is paced from the top LCD's 30Hz counter. Light scenes delay their
  submission to keep GPU completion in the same display phase. Console
  instructions stay resident; only changing telemetry rows are redrawn.
- Every mapped vertex-shader output component must be written exactly once.
  Every byte of the 24-byte vertex stride must be consumed by attribute loaders:
  float3 position, float2 UV and RGBA8 color. Normals are consumed by the bake. Emulator success does not prove these hardware
  constraints are satisfied.
- `sdmc:/pocket-atlas/boot.log` records the build and startup stages. A load
  failure or a four-second GPU retirement timeout preserves the debug pump and
  CPU console. Status reports the phase, build ID and memory remaining.

The cooker tests cover native texture channel packing, Morton addressing and
batch repacking that preserves vertices and shared LOD index ranges.
Run `cargo test --locked --workspace` and build both the standalone and thin
variants before deployment. Device captures, input checks and a complete
camera sweep are separate acceptance steps. Check the camera mapping on the
host with:

```sh
cc -std=c11 -Wall -Wextra -Werror n3ds/tests/navigation.c -lm \
  -o .pocket-build/navigation-test
.pocket-build/navigation-test
```
