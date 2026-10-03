# Routes

A route is a real road driven end to end (`web/src/routes/<id>`). Its architecture and formats are in `docs/ROUTES.md`; this is the workflow and what the first route (Route 237 in snow) taught.

## Workflow

1. **Survey**: write `web/src/routes/<id>/survey.json` (the road's OSM `ref`, both ends, corridor widths) and run `bun tools/route-survey.ts --route <id>`. It needs an Overpass endpoint (`OVERPASS=url`; the default mirror answers 504 now and then and is retried) and the GSI elevation tiles. Check the printed length, the name and limit changes, and the feature counts. The data files are checked in.
2. **Research** as for a place (`.pocket-build/research/<id>/REPORT.md`, photos, sampled colours), plus what a route needs: the road's cross-section in that season, its furniture with dimensions and spacing, what stands along it by kilometre, visibility in that weather. Do it before the generators are written: the first route's arrow posts were drawn wrong from memory and its road was 1.3 m too wide.
3. **Registry entry** with `route: { from, to, km, stops }` (the stops are projected onto the line; they are the trip's checkpoints and the display's names) and `web/src/routes/<id>/route.ts` (departure time, weather, named views by kilometre).
4. **Generators and kit** in `web/src/routes/shared`, by area, one agent each with file ownership: roadside equipment, buildings, vegetation, structures (bridges, rivers, railway), and the car, surfaces and sky. Every agent gets the shared brief (what a generator is, what the Vita can draw, budgets) and the research report.
5. **Export, cook, estimate**: `export-place.ts --out …/routes/<id>/kit`, `export-route.ts`, `atlas.ts cook-route`, then `bun tools/route-budget.ts`: draws and triangles the Vita would submit every 250 m. Fix the generators until no stretch is far over ~250 draws or ~170k triangles before going to the device.
6. **Device**: `atlas.ts native`, `ctl '{"place":"<id>"}'` (the first entry copies the pack to the memory card), `atlas.ts drive --from A --to B --kmh 90` for frame time per kilometre on autopilot, captures at the named views (`ctl '{"place":"<id>","shot":k}'`) and while driving.
7. **Atlas**: `preview-place.ts --place <id>`, `export-atlas.ts`, `cook-atlas`.

## What keeps a route inside the Vita's budget

- **Detail follows distance from the driven road**, in the generators: the camera never leaves it. Buildings beyond 45 m lose their window geometry, beyond 110 m they are boxes with painted windows; side streets get a lighter cross-section than the driven road.
- **One atlas per area.** Every kit material in a cell is a draw per cell: eleven materials gave 166 draws on average and 237 at worst.
- **The weather sets the radii.** In light snow things are gone by 2 km, so the corridor loads to 1.8 km. A clear day needs a different budget, not a bigger radius.
- **Reduced levels**: boxes and ribbons do not collapse under the attribute-aware simplifier; the corridor's last level uses position-only clustering, and only vertices on a cell's cut are held.

## Traps

- **GLSL ES 3 reserved words** (`long`, `patch`, `sample`, `input`, `output`, `filter`) cannot be identifiers in `Baker.surface` bodies; a noise period of 0 in either axis gives NaN (a surface that bakes to garbage without an error).
- **Generators run in a worker and under Bun**: nothing in `gen/` may import three.js or touch the DOM; atlas layouts shared with a painter live in a plain data module.
- **Vertex colours are sRGB bytes**; the web converts them for three.js, the Vita decodes them in its shader.
- **The car, trip and traffic exist twice** (`drive/*.ts`, `crates/pocket3d-drive`). Regenerate `vehicle-trace.json` with `web/scripts/vehicle-trace.ts` in the same change; a width or lane constant stored as f32 on one side is enough to fail the replay at the first snowbank.
- **A control message that enters a place is applied once the place runs**: anything a new mode reads from it (`drive`) must be read there too, not only in the loop.
- **The kit's swatches are how the compiler and the device learn a material**: a generator's material without a swatch in the kit export fails the cook; on the device the swatches' programs are warmed before they are dropped.
- **Stops come back**: the device resumes a trip from the last stop reached (`route-<id>.json` in the data folder), so a measurement that expects kilometre 0 must place the car (`drive.km`).
