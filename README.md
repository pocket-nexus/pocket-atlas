# Pocket City

A rain-soaked Tokyo backstreet with a 24-hour konbini, picked from a night-side globe. The scene exists twice:

- **`web/`** is the reference renderer: a standalone three.js + Vite app with no PocketJS dependency. Every asset is generated at load time.
- **`vita/`** renders the same scene on a PS Vita with its own GXM pipeline: custom Cg programs compiled on the device by SceShaccCg, 4× MSAA HDR targets, a planar street reflection, lit rain haze, bloom and AgX tone mapping.

The two are connected by a pack: the web app exports the scene as glTF 2.0 with `extras.pocketCity`, and the cooker (`crates/pocket3d-city-cook`) turns it into a `.pcity` pack for the handheld GPU.

## Layout

| Path | Contents |
| --- | --- |
| `web/` | three.js reference scene, globe, export script (`scripts/export-city.ts`) |
| `crates/pocket3d-city` | `.pcity` pack format: META JSON + texture, geometry and animation blobs |
| `crates/pocket3d-city-cook` | glTF → pack: BC1/BC3/BC5 textures with mips, quantized vertices, baked vertex lighting, low-poly shelf stock, octahedral environment, effect textures |
| `crates/pocket3d-gxm` | GXM layer: GXP registration and patching, own shader patcher, render targets, texture upload, runtime SceShaccCg |
| `vita/` | Vita app: pack loader, frame renderer, Cg programs (`vita/shaders`), LiveArea art |
| `tools/city.ts` | cook, build, deploy over USB, status/capture/profile, standalone VPK |
| `vendor/pocketjs` | PocketJS: Vita dev host and wired debug transport |

## Web

```sh
cd web
bun install
bun run dev          # http://127.0.0.1:5173
```

Controls and URL switches are listed in `web/README.md`.

## Vita

Requirements: VitaSDK at `~/vitasdk`, `cargo-vita`, Rust `nightly-2026-05-28` with `rust-src`, a Vita with HENkaku/Ensō, and `ur0:data/libshacccg.suprx` (extracted from Sony's PSM Runtime, for example with ShaRKBR33D) on the development console. Packaged builds carry compiled programs and do not need the compiler.

```sh
git submodule update --init
# 1. Export the scene (dev server running) and cook it
(cd web && bun run dev) &
(cd web && bun scripts/export-city.ts)       # → .pocket-build/city/tokyo/scene.glb
bun tools/city.ts cook                        # → .pocket-build/city/tokyo/tokyo.pcity

# 2. Development loop on a console running the PocketJS Hero dev runtime
bun tools/city.ts serve &                     # USB host
bun tools/city.ts native                      # sync pack + shaders, build, replace Hero's native slot
bun tools/city.ts status                      # renderer telemetry under `engine`
bun tools/city.ts profile                     # GPU time per scene
bun tools/city.ts capture                     # → .pocket-build/validation/captures/

# 3. Standalone package (title PKCT00001)
bun tools/city.ts vpk                         # → dist/vita/pocket-city-PKCT00001.vpk
```

Shader sources in `vita/shaders` hot-reload: `bun tools/city.ts sync` copies them to the USB share and the device recompiles the programs whose expanded source changed. Compiled programs are cached on the share by content hash; `vpk` packages the ones listed in the device's `gxp/manifest.txt`.

`bun tools/city.ts ctl '{"view":…,"time":…,"settings":{…}}'` steers the camera and renderer switches (`reflection`, `haze`, `bloom`, `rain`, `msaa`, `scale` 0–3, `amortize`, `maxLights`, `fx`, `skip`, `flat`, `hud`, `profile`).

## Status on hardware

Measured on a PS Vita 2000 (CPU 444 MHz, GPU 222 MHz), fixed camera and clock, `scale` = 2 (640×362 scene, 4× MSAA, composited and scaled to 960×544), reflection and haze updates alternating between frames:

| View | Frame time | Rate |
| --- | --- | --- |
| Konbini (street, storefront, both building rows) | 52.8 ms | 18.9 fps |
| Puddles (low camera over the wet street) | 60.6 ms | 16.5 fps |

At 720×408 the same views take 60.6 ms and 69.5 ms. `scale` 3 (the default) steps between 960×544, 720×408 and 640×362 from the measured frame time. `bun tools/city.ts profile` reports GPU time per scene; material shading of the wet street, the storefront glass and the lit walls is the largest remaining cost.

## License

MIT
