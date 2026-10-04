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

## Robotaxi vehicles

The traffic is one white Waymo Jaguar I-PACE and one gold Tesla Cybercab, 60 seconds apart on the existing 120-second downhill route. These are an authored fleet choice, not a claim that the Cybercab ran on this street in the 2022 lighting-reference photographs. Both models live in `shared/daylight/robotaxis.ts`; the scene owns only the route and scheduling. No renderer identifies either brand.

- **Waymo:** [Waymo's fifth-generation Driver photographs and sensor diagram (2020-03-04)](https://waymo.com/blog/2020/03/introducing-5th-generation-waymo-driver/) determine the roof lidar/camera pod, forward fender sensors and rear quarter modules. [Jaguar specifications](https://chile.jaguar.com/jaguar-range/i-pace/specifications) give length 4.682 m, wheelbase 2.990 m, roof height 1.566 m and mirror width 2.139 m. Body width 1.895 m, wheel radius, sensor dimensions, trim and surfaces are photographic estimates. The door marking is typeset text, not traced logo artwork.
- **Cybercab:** [Tesla's Q3 2024 update, photos 14–15](https://ir.tesla.com/_flysystem/s3/sec/000162828024043432/tsla-20241023-gen.pdf) supplies the gold two-door coupe silhouette, aero wheel covers, door outlines and closed rear deck. The [Tesla rider guide dimensions](https://www.tesla.com/robotaxi/riderguides/cybercab/en_us/GUID-3229BCDF-16D8-447B-BCED-77E3E067AFBB.html) give width 1.754 m and height 1.408 m; model length 4.42 m, wheelbase 2.74 m and tire radius 0.355 m are estimates from photographs, not published specifications. The [exterior guide](https://www.tesla.com/robotaxi/riderguides/cybercab/en_us/GUID-669E83C2-E7DE-40F4-9DBD-C9A32E7F6DFF.html) documents the front/rear lightbars. Doors stay closed during the drive.

Sources were checked on 2026-10-04. Models, lettering and reflection textures are generated locally; reference photos are not shipped. Wheels have separate rigid tracks for steering/rolling. Body shoulder, pillars and glazing now share a closed, indexed cross-section loft: the roof crown, tapered planform, rounded flanks and wheel openings follow the photographs, while shared boundary vertices keep the cabin joined to the body. Windows replace shell faces, so no opaque deck competes for their depth. Hermite interpolation adds curvature at authoring time; no runtime subdivision is needed. Wheel discs use surface fans instead of overlapping solid cylinders to keep the silhouette budget small. The larger Waymo envelope is checked against the surveyed curbs. Moving casters invalidate the shared web shadow cache; each native compiler keeps its existing lighting policy.

## Handheld pipeline

Use the existing web export → sealed PlaceIR → independent target lowering. `daytime-slope` reuses Vita's sun/shadow/sky path and the PICA daytime bake; PSP's shared daylight bake adds a sky panorama and vertex sunlight/static shadows. PSP uses the separate `PLPS` v3 format. Moving-object lighting on the fixed-function targets is baked at the initial orientation; web ambient audio is not reproduced on the handhelds.

```sh
(cd web && bun scripts/export-place.ts --place sf-lombard-street --seconds 120)
bun tools/atlas.ts cook --place sf-lombard-street
bun tools/atlas.ts build
bun tools/atlas-3ds.ts cook --place sf-lombard-street
bun tools/atlas-psp.ts cook --place sf-lombard-street
bun tools/atlas-psp.ts package --place sf-lombard-street
```

Host builds and simulator images do not establish physical-device frame budgets. Measure every shot on each device before claiming 30 fps. Standalone Vita packaging additionally needs the exact current shader variants compiled by SceShaccCg on a Vita.
