# Lombard Street in Bloom

The real crooked block between Hyde and Leavenworth, Russian Hill, San Francisco, in clear summer daylight. There are six named cameras: Postcard, Switchbacks, Hydrangeas, Glass House, Downhill and Hyde. Export the full `120` seconds; car turnarounds are outside the authored views and the ordinary visitors' poses repeat at the seam.

## Survey and attribution

- Road: [OpenStreetMap way 402111597](https://www.openstreetmap.org/way/402111597), 157 plan samples, 146.664 m endpoint separation and 197.558 m planar centreline. Nearby building and footway geometry is © OpenStreetMap contributors, available under [ODbL 1.0](https://www.openstreetmap.org/copyright). `world/data.ts` retains the source IDs; heights come from tags where available and otherwise use explicit estimates.
- Frame: origin at Leavenworth/Lombard, 37.8022186° N, 122.4179869° W. +X east, −Z north, Y up, metres. The local `u` axis points uphill and `v` points to the north side.
- Elevation: [USGS EPQS](https://epqs.nationalmap.gov/v1/json?x=-122.4179869&y=37.8022186&units=Meters&wkid=4326&includeDate=true), 1 m DEM acquired 2023-03-04, sampled at quarter-block intervals: 53.051, 59.598, 68.845, 78.652, 85.894 m. Model heights are relative to 53.051 m.
- Context: [SFCTA September 2016 existing-conditions report](https://www.sfcta.org/sites/default/files/2019-03/Lombard_existing_conditions_report_092816.pdf) and [San Francisco Travel](https://www.sftravel.com/things-to-do/attractions/iconic-sf/lombard-street).
- Appearance: 16 dated Wikimedia Commons references, including Benoît Prieur's 2022-07-20 CC0 photographs, checked for curb/brick proportions, planting, bay windows and the blue steel/glass facade at 1040. Photos are references only; every product texture is procedural. Download URLs, dates, authors and licenses are retained in the ignored research manifest.

Research and screenshots are under `.pocket-build/research/sf-lombard-street/` and `.pocket-build/validation/lombard/`. No photograph or capture is bundled with the source.

## Authored estimates

The road's maximum width is 5.8 m, tapering beside the surveyed stairs. Treads are 0.55 m deep and 1.35 m wide; their risers follow the elevation interpolation. Junction cross-grades are −0.11 at Leavenworth and −0.19 at Hyde. Openings, roof details, small retaining walls, tree shapes and North Beach/Telegraph Hill masses are photo-based estimates, not survey measurements. Coit Tower is placed approximately 1.068 km east and 20 m north of the origin, with a 64 m tower height.

Lighting represents 2022-07-20 at 11:00 PDT: approximate solar azimuth 110.37°, elevation 56.13°, computed with the NOAA fractional-year equations. Camera positions and lenses are authored photographic estimates. The Postcard view is 1.8 m above the approach road, facing uphill at a 29° vertical field of view.

## Handheld pipeline

Use the existing web export → canonical `.place` cook → native target cook. `daytime-slope` reuses Vita's sun/shadow/sky path and the PICA daytime bake; PSP's shared daylight bake adds a sky panorama and vertex sunlight/static shadows. PSP uses the separate `PLPS` v2 format. Moving-object lighting on the fixed-function targets is baked at the initial orientation; web ambient audio is not reproduced on the handhelds.

```sh
(cd web && bun scripts/export-place.ts --place sf-lombard-street --seconds 120)
bun tools/atlas.ts cook --place sf-lombard-street
bun tools/atlas.ts build
bun tools/atlas-3ds.ts cook --place sf-lombard-street
bun tools/atlas-psp.ts cook --place sf-lombard-street
bun tools/atlas-psp.ts package --place sf-lombard-street
```

Host builds and simulator images do not establish physical-device frame budgets. Measure every shot on each device before claiming 30 fps. Standalone Vita packaging additionally needs the exact current shader variants compiled by SceShaccCg on a Vita.
