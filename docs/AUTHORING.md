# Authoring an Atlas place

Atlas's creator API belongs to Atlas. PocketJS supplies device kernels and host
tools; OpenStrike continues to own its BSP/FPS domain. A new place using an
existing scene family should add a layout and authored intent, then use the
existing exporter, recipes and runtimes. A new effect still needs explicit
lowering and device validation.

## Definition and runtime

`web/src/places/<id>/index.ts` exports a `definition` and a compatible
`createStage(ctx, place, progress)` adapter. The definition is inspectable before
opening a browser: identity, kind, seed, sample interval, resource locks and,
where available, camera data. Builders and audio factories stay lazy.

`defineDayPlace` uses Atlas's shared `DayStage` lifecycle, lighting, probe,
batching, export and disposal. Sangubashi is a complete example. Tokyo uses
`definePlace` with its existing specialized runtime. Tokyo and Suga expose their
camera tables as data; older specialized coast/vista stages still compute their
cameras inside the runtime (Griffith needs its DEM). Inspection does not fetch
that terrain or instantiate those stages. The exported IR always contains the
resolved camera table.

Start with [the typechecked daytime template](../web/examples/day-place.ts).
It is a synthetic teaching scene, deliberately absent from the real-place
gallery. Copy it into a real place directory, adjust imports, research and build
the real layout, and add the registry entry. Registry release targets are an
explicit publication decision, separate from compiler capability.

```ts
export const definition = defineDayPlace({
  id: "a-researched-street", kind: "daytime-street", seed: 42,
  sampling: { startSeconds: 0, durationSeconds: 64, fps: 15 },
  // shots, lighting, bounds, local resource locks, metadata ...
  build: async (world, progress) => {
    await buildStreet(world, progress);
    buildTrain(world); // register motion with world.updaters
  },
  createAudio: ctx => new StreetAudio(ctx.audio),
});
export const createStage = (ctx, place, progress) =>
  createDefinedStage(definition, ctx, place, progress);
```

`defineDayPlace` does not translate arbitrary JavaScript. It establishes one
checked construction/sampling contract and reuses an existing family runtime.
The older `createStage` ABI still works in the web app; a reproducible export
requires a definition. No universal Pocket3D scene API is introduced.

## Build and inspect

From the repository root after `cd web && bun install --frozen-lockfile`:

```sh
bun tools/place.ts inspect --place sangubashi-crossing
bun tools/place.ts recipe --profile old3ds30
bun tools/place.ts export --place sangubashi-crossing
bun tools/place.ts import --place sangubashi-crossing
bun tools/place.ts check --place sangubashi-crossing --profile vita30
bun tools/place.ts cook --place sangubashi-crossing --profile vita30
bun tools/place.ts report --in .pocket-build/places/sangubashi-crossing/sangubashi-crossing.vita30.compile.json
```

`export` starts and stops its own loopback Vite server on port 5197. For an
existing server pass `--base http://127.0.0.1:PORT`; its source fingerprint must
match this checkout. Chrome must be installed. `build` combines export, import
and cook for one profile. `--in`, `--out`, `--report`, `--tex` and `--cell` select
compiler paths/settings; `--geometry full|handheld`, `--seed`, `--start`,
`--seconds` and `--fps` are explicit export overrides. Sampling defaults come
from the definition, including Sangubashi's complete 64-second train cycle.
Use a fresh browser export for every override; an export hook can be consumed
only once. `report --asset PATH` and `explain --asset PATH` also verify the pack's
hash. `explain --top 12` shows the largest source contributor sets at the
`reduce-geometry` pass, selected representations and final section sizes.
Those source counts are not per-object packed bytes or estimated GPU time.

The files form this chain:

```text
definition + layout + locked local resources
  -> fresh Three construction / fixed-step sampling / GPU material bake
  -> canonical scene.glb + environment + referenced images + export.json
  -> PlaceIR v2 directory: manifest.json, scene.gltf, scene.bin, resource hashes
  -> selected recipe + target profile
  -> Vita PLCE / 3DS PICA / PSP PLPS pack + deterministic compile.json
  -> native runtime deployment -> device.json + captures + human visual review
```

Profile-named outputs keep experiments separate. To feed the existing device
commands, select their established staging path explicitly, for example:

```sh
bun tools/place.ts cook --place tokyo-konbini --profile vita30 --out .pocket-build/places/tokyo-konbini/tokyo-konbini.place
bun tools/place.ts cook --place tokyo-konbini --profile old3ds30 --out .pocket-build/3ds/places/tokyo-konbini.place
bun tools/place.ts cook --place tokyo-konbini --profile psp30 --out .pocket-build/places/tokyo-konbini/tokyo-konbini.psp.place
```

Then use the repository's `atlas.ts`, `atlas-3ds.ts` or `atlas-psp.ts` build and
deployment flow. Those commands retain transport ownership and runtime-specific
packaging. Their measurement commands accept `--compile PATH` for a nonstandard
compile receipt. Existing default receipt paths follow the staged pack name.
Building the 3DS catalog requires all its registered packs, not just this example.

`export.json` seals the actual exported bytes, effective parameters, conservative
web source closure, lockfile and browser/GPU identity. Import rejects missing
or changed resources and sampling/identity disagreements before replacing an
existing IR. Publication writes the receipt last; an interrupted export cannot
be imported as a complete new source. Paths in the raw export are local file
names. Explicit resource locks refer to `web/public` and use SHA-256; all local
source/assets are fingerprinted, external requests and source symlinks fail.

## Reproducible construction

Use the world's seeded RNG and stable source names. Do not use wall time,
`Math.random`, network results or Three UUIDs in asset construction. The root
seed initializes the supported world RNG; existing builders with their own
fixed artistic seeds retain them. It is not a global interception of randomness.

Export mode prevents preview/loading frames from advancing the simulation.
Sampling initializes at `(dt=0, t=0)`, advances any warm-up interval with fixed
`1/fps` steps, then records the requested interval and restores its first pose.
Prefer motion as a function of `t % period`. Stateful fixed-step actors work,
but their entire warm-up must fit the checked 108000-step limit. Animated scale
and morph targets fail explicitly. Rigid position/rotation tracks, supported
skinning, annotated material/UV animation and existing scene effects are the
portable vocabulary; native interaction behavior still belongs to the runtime.

GLB buffer views are content-normalized after Three finishes its asynchronous
image jobs. Export uses CPU Canvas2D rasterization to avoid GPU-dependent glyph
edge variation in procedural textures; WebGL baking still uses the recorded GPU.
Source IDs and animation/material names do not use global object
counters. The same fixed source, dependencies and browser/GPU environment can
therefore be checked by repeated fresh exports. This is not a cross-GPU or
cross-browser floating-point guarantee: GPU procedural baking remains part of
the frontend, and Canvas text still depends on the host's installed fonts.
Use the same browser/OS/font environment for frontend repeat checks; the receipt
records browser/GPU identity, not a complete font installation snapshot.
Repeat verification, rather than the function name alone, is the
evidence. The sealed IR decouples target cooking from that browser environment.

## Intents, recipes and diagnostics

`source("street/shop-sign", mesh)` creates a semantic report anchor. Automatic
IDs use names and tree order; preserve explicit IDs when reorganizing a layout.
Batching retains contributor sets. Texture-purpose annotations choose
`surface`, `text-atlas`, `flipbook` or `emissive-strip`; a backend decides size,
encoding and layout. Compile reports map output textures back to source texture
IDs and material/object contributors. These sets describe contributors to a
material, not per-triangle ownership or TypeScript line locations.

The compiler preserves object, prototype and instance boundaries during export;
Web-only static batching still serves interactive browser rendering. Target
recipes choose representations before expanding instances, resolving materials
and baking. Use stable `source()` IDs for report anchors.

```ts
import { geometryIntent, geometryAlternatives } from "../shared/geometry-intent";

geometryIntent(shopSign, { role: "protected", maxErrorMeters: 0 });
geometryIntent(building, { role: "structure", maxErrorMeters: 0.01 });
const railing = geometryAlternatives("railing", {
  role: "detail", maxErrorMeters: 0.01,
}, [
  { id: "reference", errorMeters: 0, object: detailedRail },
  { id: "surface", errorMeters: 0.004, object: compactRail },
]);
world.root.add(railing);
```

`maxErrorMeters` limits permanent/base geometry changes in world metres. The
profile caps each role; an author cannot raise that cap. A parent's intent is
inherited unless a child supplies its own. `protected` prevents geometry
simplification, component removal and coarse reflection proxies. It does not
promise identical lighting, texture resolution or target vertex quantization.
Ordinary distance LODs retain their separate projected-error policy. Text atlases
and emissive strips also protect their geometry during reduction/LOD.

An alternative's `errorMeters` is an **author-declared** representation bound in
the group's local space, scaled conservatively into world space. It is not a
compiler-certified mesh distance. The first alternative is the zero-error Web
reference; the compiler selects the largest admissible error, falling back when
a descendant's stricter intent forbids it. Review alternate silhouettes, labels,
parts and articulation against the reference. Alternatives v1 accept static and
rigid hierarchies; skin/joint subtrees are rejected. Put shared protected details
outside a lossy alternative group, or provide them unchanged in each reviewed
representation. Atlas's shared commuter builder exports both full and surface
representations with identical formation, label geometry and wheel articulation;
PICA selects the surface recipe and preserves the complete 64-second motion.

Typed passes execute source reading, representation selection, material/texture
policy, Vita palette batching, bounded geometry reduction, motion, lighting,
chunk/LOD, effects, native lowering and structural budgets. Each pass declares
its dependencies, inputs, outputs and version. These are internal compiler
contracts; an arbitrary plugin ABI has not been introduced.

Lighting refinement is cached by sealed source, complete profile, compiler and
host ABI. Default storage is `.pocket-build/cache/compiler`; use `--cache off`
to verify uncached output, or `--cache PATH` to isolate a run. Corrupt entries are
recomputed. `--telemetry PATH` records wall time and hit/miss counts separately
from deterministic `compile.json`. The conservative key invalidates the bake
when any sealed source input changes; it is not object-local incremental editing.

Unsupported material classes, shader patches, displacement/light maps and
physical extensions still fail explicitly. Known shared patches use Atlas
annotations; this does not certify arbitrary `onBeforeCompile` code. PSP supports
night streets and dry daytime streets/slopes, while PICA/GE do not implement the
vista light-field/haze combination. Passing structural budgets does not establish
frame rate, combined memory headroom or visual acceptance on a device.

Budget failure emits a structured report with executed passes and the failing
budget; it leaves the previous good pack/receipt intact. The compiler does not
automatically redesign a scene that exceeds a budget. Review intent, lowering
or family runtime, change the source/recipe, then rebuild. Do not hand-edit a
generated pack.

## Device acceptance

Atlas commands use PocketJS's cross-worktree cooperative leases. Raw/older tools
do not participate; establish the existing transport owner before using a
device. PSP keeps exactly one `usbhostfs_pc`; the long-lived transport lease is
separate from the short control/validation lease.

PSP `shots`, 3DS `profile`/`sweep`, and Vita `bench`/`profile`/`shots`/`sweep`
write identity-bound evidence under ignored validation output. Every recorded
sample must retain the expected runtime build and the asset SHA-256 confirmed
by the device. PSP hashes the loaded pack; 3DS verifies the opened asset against
its compiled catalog; Vita hashes streamed pack bytes and loaded shader sources.
Vita also records shader generation and waits for shader work to settle. A
missing new identity is a failure, not a fallback to a local file hash.

3DS uses its paired device ID. PSP/Vita currently identify the host's USB
transport, not a hardware serial number. Timing rows retain cameras, quality,
sample windows and missed budgets. PSP `gpuWaitMs` remains the GE wait after CPU
submission, not serialized GPU time. Vita `profile` is serialized GPU timing;
ordinary frame timing is separate. Captures occur after timing windows in
PSP shots, 3DS profiles and Vita sweeps. Their receipts say visual review is
not recorded; a screenshot hash does not establish fidelity. Incomplete camera
coverage and partial runs remain explicit. A cook/build does not certify a new
place on hardware.

## Regression and extension

`bun test` covers descriptor validation, deterministic sampling, unsupported
features, provenance and canonical GLB ordering. `cargo test --locked --workspace`
includes two distinct layouts for each day/night test family, each supported
target, rejected capabilities, resource tampering, repeatable recipes and failed
publication preservation. Synthetic fixtures complement real-place export,
sealed-pack and device regressions; they cannot replace the latter.

Add scene kinds in Atlas and BSP/game features in OpenStrike. Extract a shared
PocketJS mechanism only after application use demonstrates its boundary. Steam
Deck and AYN Thor remain deferred.
