---
name: pocket-atlas-place
description: Make, rebuild or polish a first-party Pocket Atlas place — a real location (a street corner, a pilgrimage spot from a film or anime, a photo) recreated as a three.js reference scene, exported, cooked into a .place pack and rendered on the PS Vita at 30 fps — and add the rendering its kind of place needs to the shared renderer. Use when asked to build a new place, research a location for one, raise a place's fidelity against reference photos, fix how a place looks or performs on the Vita, or review a place before merge.
---

# Pocket Atlas place

A place is one real spot, recreated faithfully enough that someone who has stood there recognises it, and rendered on a PS Vita (480×272, paced 30 fps, `vita30` profile) at the best image quality the handheld holds. Read `AGENTS.md` and `README.md` first; this skill is the workflow and the quality bar that the first four places (Rainy Night Konbini, Suga Shrine Stairs, Radio Kaikan at Blue Hour, Kamakura-Kōkōmae Crossing) established.

## Rules that are not negotiable

- **Real location only.** A film or anime still is a composition and mood reference; never model its characters, fan goods, collaboration decorations, costume tourists, crowds or traffic guards. People are a few ordinary figures. Signs may carry real names as lettering; do not trace logo artwork.
- **Kind, not place.** Every place has a kind (`PlaceKind`: `night-street`, `daytime-slope`, `dusk-street`, `daytime-coast`, …). Rendering a place needs goes into `web/src/places/shared/`, the cooker and the Vita renderer, keyed by kind — never into code only one place can use, and never by importing another place's internals.
- **Measured, not guessed.** Geometry comes from OSM, national 3D city models and elevation data, and dated photos; anything estimated is marked as such in the research report.
- **The device decides.** A place is done when its captures on the Vita read as the reference photos at the same camera and every shot holds 30.0 fps at step 0. Web captures are a step, not the verdict.

## Workflow

1. **Research** → `.pocket-build/research/<id>/REPORT.md` plus the data. Collect: OSM for ~400 m around the spot; building heights (PLATEAU in Japan); an elevation profile (GSI 1 m in Japan); 10–20 dated Wikimedia Commons photos with author/date/licence in a `manifest.tsv`; aerials with a metre grid. Write the origin and frame, every dimension, the canonical viewpoint (lat/lon, eye height, heading, vertical FOV, from a reference photo), the time and sun (azimuth/elevation from a sun table), sampled colours, what moves and when, and what to exclude. Make 960 px copies of the photos (`photos-960/`) for agents.
2. **Scene** in `web/src/places/<id>/`: `index.ts` (`createStage`), `<Name>Stage.ts`, `world/`, `gfx/`, `fx/`; a registry entry with every `PlaceDef` field (author, kind, tags, summary, featured, preview shot). Frame: origin at a named landmark, +X east, −Z north, y up, metres. One `LOOP` (seconds) that the device repeats; every animation is a function of `t mod LOOP` with an invisible seam. The preview card is captured at t = 25 in the `preview` shot: something should be happening then.
3. **Fidelity pass** (large places): split by area — ground/walls/buildings/planting; equipment/poles/wires/signs; vehicles/people; sky/water/light/grade — one agent per area with file ownership, one shared dev server, captures compared side by side with the reference photos at the same camera. See `references/device-loop.md` for agent hygiene.
4. **Export and cook**: `(cd web && bun scripts/export-place.ts --place <id> --seconds <LOOP>)`, `bun tools/atlas.ts cook --place <id>`; read the cook report (draws, triangles, texture list, pack size).
5. **Device**: run it in Pocket Devkit, capture every shot at the same views, compare with the photos and the web, measure (`shots`, `profile`), fix, repeat. Commands and traps: `references/device-loop.md`.
6. **Atlas and package**: `(cd web && bun scripts/preview-place.ts --place <id>)`, `bun scripts/export-atlas.ts`, `bun tools/atlas.ts cook-atlas` (also bakes the interface font from the places' strings), then `vpk` after visiting every place and the atlas in one device session.
7. **Ship**: Conventional Commits, a draft PR with the device numbers and limits in the description, captures kept in `.pocket-build/validation/` (never committed). Review for drift before merge (`references/device-loop.md`, "Before merge").

## Quality bar

- **Surfaces**: procedural PBR baked on the GPU (`shared/bake.ts`; the konbini's `gfx/surfaces.ts` asphalt is the reference: aggregate, binder, patches, sealed cracks, grime, wear) with normal and ORM maps; colours sampled from the photos and checked numerically (lit and shaded asphalt, walls, paint, sea, sky).
- **Relief where the camera is**: on the Vita, normal and ORM maps only apply within the detail distance (4–8 m), so window reveals, sills, balconies, railings and equipment near viewpoints are geometry; texel density per storey, not one texture stretched over a wall.
- **Planting**: alpha-tested leaf cards with leaf textures in clusters (cycads, palms, shrubs, hedges, grass) — never single blobs.
- **Clutter that makes the place**: wires with catenary sag (keep them ≥ ~0.3 device pixel wide from the nearest shot), poles with hardware, signs with legible text, kerbs, drains, manholes, worn paint.
- **Light**: shade is the photos' value and hue — a soft grey-blue, never saturated blue. The probe and hemisphere fill must not be the sky's zenith colour; give the ground bounce its weight. The cooker bakes this light into vertices, so the web light balance is what the device gets.
- **Motion**: the loop is seamless; moving content (trains, cars, gates, signs, surf) is modelled with the same care as the static scene.
- **Budget** per shot on the Vita: 30.0 fps at step 0 under `shots` and serialized GPU ≤ ~25 ms under `profile` (headroom for the passing train or taxi) are the verdict. Guides for planning: about 250 draws and 130k triangles after LOD (Kamakura's Platform view, 263 draws and 141k triangles, takes 20.9 ms), moving geometry ≤ 30k triangles, a pack no larger than the konbini's 50.6 MiB.

## Routes

A route (a real road driven end to end, streamed as cells) follows `references/routes.md` and `docs/ROUTES.md`: survey, research, generators by area, export and cook, a host estimate of the device's load, then the device.

## Export annotations

What the cooker reads from `extras.pocketAtlas` — material kinds (`unlit`, `sign`, `glass`, `interiorWindow`, `products`, `tower`, `water`), signage animation, water, day and twilight sky, sun, sky occlusion, post — is in `references/annotations.md`. Add a new annotation only together with its cooker reader (`crates/pocket3d-place-cook/src/extras.rs`, with a test), its pack field (`crates/pocket3d-place/src/meta.rs`), the Vita side, and a README section.
