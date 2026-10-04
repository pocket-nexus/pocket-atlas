# Fisherman’s Wharf, modern waterfront

> **DO NOT MERGE — visual acceptance failed, 2026-10-04.** The user rejected
> the Vita appearance. This experiment is not an accepted fidelity baseline.
> Further tuning and packaging were stopped; successful host checks do not
> establish visual acceptance.

`sf-fishermans-wharf` covers the Jefferson/Taylor crab-wheel sign, the inner
working fishing harbor, Pier 45, Pier 43’s railroad ferry arch and the renewed
waterfront promenade. The reference window is **2024–2026**. It includes the
SkyStar observation wheel and seven promenade pergolas. The former Shed C and
Jeremiah O’Brien’s old Pier 45 berth are deliberately absent. Pier 39’s sea lions
are not transplanted to this harbor.

This is a researched, procedural interpretation. It is not a survey, a record
of one exact day’s vessels or a claim that every business remains open. Three
ordinary visitors, gulls and anonymous working boats supply restrained life.
There are no film characters, downloaded photo textures or traced logos.

## Sources and frame

- [Fisherman’s Wharf Community Benefit District FAQ](https://www.fishermanswharf.org/about-us/faqs/)
  identifies the sign’s northeast Jefferson/Taylor corner.
- [Port of San Francisco, promenade opening, 12 November 2024](https://www.sfport.com/about/news/san-francisco-unveils-vibrant-new-fishermans-wharf-promenade)
  documents seven pergolas, seating, planting and the teal welcome kiosk.
- [SkyStar’s operator](https://www.skystarwheel.com/) specifies 150 ft overall
  height and 36 gondolas. The 41.8 m wheel diameter is an OSM tag.
- [San Francisco Maritime National Park Association](https://maritime.org/visit-us/)
  locates Pampanito at Pier 45; its [technical fact sheet](https://maritime.org/tech/facts.php)
  gives 311 ft 6½ in length and 27 ft 3½ in beam (94.958 m × 8.319 m).
- [Jeremiah O’Brien’s operator](https://ssjeremiahobrien.org/)
  identifies the ship’s present home as Pier 35.
- [San Francisco Fire Commission, 10 June 2020](https://sf-fire.org/calendar/fire-commission-june-10-2020)
  records the fire that destroyed Pier 45 Shed C.

The origin is [OSM node 5455630121](https://www.openstreetmap.org/node/5455630121),
37.8083294° N, 122.4157264° W. +X is east, −Z north, Y is metres above the
promenade. `layout.ts` is selected **© OpenStreetMap contributors** data,
retrieved 2026-10-04, available under the [Open Database Licence](https://www.openstreetmap.org/copyright).
Coordinates use a local equirectangular projection (111,320 m per latitude
degree, longitude scaled by cos(origin latitude)). Buildings, coastline and
road centerlines retain the selected OSM plan. `heightTagged` means an OSM
height tag exists; it does **not** mean that height was professionally surveyed.
Absent heights, road widths, quay elevation, facade divisions, roof details,
boat berths and equipment dimensions are explicit estimates.

The Boudin west glazed gable, long pitched roof, red awnings, nearby date palms,
crab-wheel mast/rope/rim, warehouse clerestory/loading shutters and ferry arch’s
plain, unlettered stucco front come from photographs. In particular:

- [Jefferson/Taylor, March 2026](https://commons.wikimedia.org/wiki/File:Muni_1059_at_Jefferson_and_Taylor,_March_2026.JPG),
  Pi.1415926535, CC BY-SA 4.0: contemporary gable, palms, wheel and street layout.
- [Crab wheel and tram, 6 August 2015](https://commons.wikimedia.org/wiki/File:California-06102_-_Fisherman%E2%80%99s_Wharf_Sign_and_Tram_%2820449795518%29.jpg),
  Dennis G. Jarvis, CC BY-SA 2.0: mast, rope wraps, rim and storefront relief.
- [Pier 43, 30 June 2022](https://commons.wikimedia.org/wiki/File:San_Francisco_%28CA,_USA%29,_Pier_43_Ferry_Arch_--_2022_--_202545.jpg),
  Dietmar Rabich, CC BY-SA 4.0: pediment, arch opening, dentils and transfer bridge.
- [Fishing vessel Leslie Jane, 3 May 2014](https://commons.wikimedia.org/wiki/File:Leslie_Jane_San_Francisco_2014_%2814505394039%29.jpg),
  Mobilus In Mobili, CC BY 2.0: vessel construction and working shed detail; the
  modeled fleet does not assert that this particular vessel is present today.

The ignored research directory holds 18 dated Commons reference records with
individual authors/licences, 960 px copies, the raw OSM snapshot, 50 m plan grid,
solar calculation and `REPORT.md`. Reference dates and historical changes are
kept separate; ambiguous day/month fields are retained as originally reported.

## Scene and loop

Shared `defineDayPlace`/`DayStage` owns PBR baking, daylight, batching, sky,
reflection probe, grading and export. Shared `DayWorld.water` owns the wave
material and native annotations. There is no new shader or place-ID rendering
branch. The probe is sampled over open water at `[155, 12, -120]`; a probe among
the buildings produces an incorrect dark reflected horizon.

The **120-second** loop uses seeded construction and absolute-time transforms:
moored boats rock, an anonymous sightseeing vessel follows a closed route,
SkyStar makes one rotation with all 36 cabins staying upright, gulls circle and
visitors shift their stance. This is a compressed presentation cycle, not an
operational sailing or wheel timetable. Both water layers travel exactly two
texture tiles per loop. Sky and sun are fixed. The sun is calculated using
[NOAA’s published equations](https://gml.noaa.gov/grad/solcalc/solareqns.PDF)
for 2025-09-15 16:15 PDT: azimuth 243.427°, geometric elevation 34.596°. Weather,
visibility, tide and lighting balance are an artistic clear-afternoon choice.

Six 20-second shots: **Crab Wheel** (preview), **Fishing Harbor**, **Pier 43 Arch**,
**Jefferson**, **Working Wharf**, **Bay**. Camera coordinates are inspectable in
`index.ts`. They are composed from ground-level photographs and the OSM plan;
photo-camera locations and lens values are estimates, not calibrated EXIF poses.

## Validation boundary

The source has passed TypeScript checking. Initial web captures exposed two
cameras inside building footprints, overly repetitive facades and an inland
reflection probe; the subsequent fidelity pass corrected those issues, added
the Boudin roof/glazing and reduced hidden facade geometry. Web captures and
research artifacts stay under `.pocket-build/`.

The intended Vita planning limits are approximately 250 visible draws, 130k
visible triangles, 30k moving triangles and a pack below 50 MiB. These are
**targets**, not achieved measurements. A fresh export, cook report, every-shot
Vita capture and serialized GPU/frame-time sweep are needed before claiming
30 fps or device fidelity. This source README does not claim hardware acceptance.
