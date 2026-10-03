# Device loop, agents and traps

## The Vita

- Debug only in **Pocket Devkit** (title P3B1D7273). `bun tools/atlas.ts serve` (run it detached, not as a session task) is the USB host; `native` syncs packs and shaders, builds and replaces Devkit's native slot; `sync` alone pushes new packs and shader sources (shaders hot-reload).
- **USB link recovery**: when Devkit writes one status and goes silent, restarting the host does not revive it, and restarting it while Devkit is connected kills the link. Start a fresh host, then unplug and replug the cable with Devkit open. The app can keep rendering on screen while the link is dead.
- `sync` copies `vita/shaders` from the checkout you run it in: build and sync from the branch whose renderer the pack needs.
- Enter a place with `bun tools/atlas.ts ctl '{"place":"<id>"}'` and wait for status `running <id>` with `pending 0` (first entries compile programs on the device).
- **Captures**: `bun tools/atlas.ts capture --out <absolute path>` (relative paths land inside `vendor/pocketjs`); space captures ≥ 5 s apart — a burst dropped the USB link. A capture stalls the frame, so frame times read during a capture loop are not measurements.
- Pin a view for comparisons: `ctl {"renderProfile":"vita30","time":25,"view":{pos,target,fov},"settings":{"step":0,"hold":true,"hud":false}}` with each shot's halfway view (mid of `from`/`to` in `scene.glb`'s camera shots). To read one shot as the rig frames it, send `{"shot":k,"time":T}` (the shot by index, the loop frozen) and read `main.draws`/`main.tris` from `status`; each message without `time` or `view` releases them.
- **Measure**: `shots --place <id> --seconds <≥ 6 × shot length>` (rig + governor: the verdict), `profile --place <id> --shot <Name> --time <t>` (serialized GPU per pass: the headroom), `sweep` (frame time per step). The place must be running before `profile`.
- `vpk` packs only the programs in this session's `gxp/manifest.txt`: visit the atlas and every place in one session first, wait for `pending 0`.
- Compare device and web numerically at the same view (sea, sky, lit and shaded road) before blaming the renderer; they matched within 1–3/255 for Kamakura.

## Agents

- One agent per area with **file ownership**; shared files only through small targeted edits, never rewritten wholesale; nobody commits but the lead.
- One shared dev server (e.g. `bunx vite --port 5175 --strictPort` in the worktree); agents never start or stop servers.
- Long, image-heavy steps stalled agents (watchdog): give them the 960 px photo copies, 960×540 captures, at most one or two images per step, long work in background commands that they poll. A stalled agent resumes with its context; say where it stopped.
- Brief with the research report path, the photos that are ground truth for the area, the budget for the area, the technique references (konbini surfaces, Suga foliage and sky), and what the device does differently (detail distance, baked light).
- The lead verifies on the device; agents' self-reports are claims until the captures agree.

## Traps that cost hours

- **Atlas borders**: sign or prop art packed into one texture needs its cells edge-extended (`shared/atlas.ts`); black borders bleed into distant signs through low mips and BC1 blocks (dark squares that come and go with the view).
- **Flipbooks**: mips stop while a cell is ≥ 4 texels (the cooker does this from `cols`/`rows`).
- **GXM swizzles are spelled in ABGR order**: `U8_R111` puts the texel in alpha. Use `U8_RRRR` for single-channel masks read as `.r`. When a texture samples wrong, draw it on screen with `ui.image` to see what the GPU reads.
- **Uniform names are one global table** (`vita/src/gpu.rs`): a new shader must not reuse a name with another meaning. New shader files go into `vita/src/shaders.rs` `SOURCES` and into the lint cases in `tools/atlas.ts`.
- **`dynamic`** marks moving nodes (no static lighting bake); rigid nodes can use LODs and the moving sunlight shadow map, while skins retain topology and do not cast into that map. Never use it as a batching opt-out.
- **Pack version** is checked exactly: bump the affected target's format version when its encoding changes and re-cook its packs. Vita PLCE/ATLS, PICA PLCE/table and PSP PLPS have independent version contracts; never propagate a Vita bump into a native target's envelope.
- **zsh**: `case $s in $pat)` does not glob a pattern held in a variable.

## Before merge

Review the whole diff from `main` for drift, as for the first four places:

- cross-place imports (shared code belongs in `places/shared/`), forked copies of shared modules (sky, atlas packers, stage scaffolding, post), dead code left by agents, debug logging, write-only `userData`;
- contracts that disagree between web export, cooker and Vita (sign, water, twilight fields; blending of `glass`);
- the README's place table, kind sections and hardware numbers, and this skill, updated for what the place added.
