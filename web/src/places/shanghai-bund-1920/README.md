# Shanghai Bund, 1920

> **DO NOT MERGE — visual acceptance failed, 2026-10-04.** The user rejected
> the Vita appearance. This experiment is not an accepted fidelity baseline.
> Further tuning and packaging were stopped; successful host checks do not
> establish visual acceptance.

A reconstruction of the quay opposite the **1893 Customs House**, before the
large rebuilding projects that produced the familiar later Bund skyline. The
three-storey **1875 HSBC office** is south of the Customs House. This is a
period interpretation, not an exact photograph of a proven day in 1920:
Darwent's handbook, published in 1920 with text updated in 1919, anticipates the
bank's demolition; the precise demolition date and changing plot conditions
have not been established here.

## Evidence and limits

- [Darwent, *Shanghai Handbook* (1920), pp. 6–9](https://commons.wikimedia.org/wiki/File:C._E._Darwent_-_Shanghai_Handbook_(1920).pdf): Customs frontage 135 ft, depth along Hankow Road 155 ft, tower 110 ft, converted to **41.148 × 47.244 m / 33.528 m**. Describes the river paths, lawn, tramcars, rickshaws, Customs pontoon and receiving shed. The book's colonial descriptions are historical source language, not the scene's editorial viewpoint.
- [Wright, *Twentieth Century Impressions* (1908), Customs photograph](https://commons.wikimedia.org/wiki/File:Tcitp_d468_the_customs_house.jpg): gabled projecting wings, windowed inner returns, recessed middle, four-faced clock and crenellated crown. [The bank plate](https://commons.wikimedia.org/wiki/File:Tcitp_d447_hong_kong_and_shanghai_banking_corporation.jpg) supplies the earlier HSBC facade and projecting portico.
- Virtual Shanghai's reproductions from [Cameron's 1917 publication, Customs](https://www.virtualshanghai.net/Photos/Images?ID=14925) and [HSBC](https://www.virtualshanghai.net/Photos/Images?ID=14942) corroborate those building generations. An archive entry whose range is “1920–1939” is **not** treated as a photograph taken in 1920.
- [George Trobridge collection, 1919 Bund view, University of Bristol](https://hpcbristol.net/visual/Tr02-188): period trees, chain boundary, rickshaws and quay surface. This farther-north photograph supplies streetscape context, not the Customs building layout.
- [HSBC's own archive](https://history.hsbc.com/collections/snapshots/housing-the-bank/a-shanghai-landmark) dates the successor building's opening to 23 June 1923. That dome and its lions, the 1927 Customs tower, 1929 Sassoon House and modern Pudong are excluded.

All other facade dimensions, roof details hidden in the photographs, pavement
widths, river level, cargo positions, boat dimensions and colors are estimated.
The northern cupola is interpreted from the period Bund plate; distant office
blocks and Pudong warehouses establish scale without claiming surveyed tenant
or parcel identities. Black-and-white images cannot supply measured colors.
The vessels and tram are anonymous period types; no exact fleet number,
timetable, cargo owner or encounter is asserted. No source images ship in the
place: every rendered surface is procedural.

## Authoring

The origin is the old Customs entrance, approximately **31.23862 N,
121.48562 E**; +X east, −Z north, Y up, in metres. The near frontage is locally
straightened; the current OSM road bears roughly 352° northward, but current
reclamation and modern building footprints are not substituted for the lost
quay. The research-only OSM extract, source plates, attribution manifest,
dimensions, camera notes and evidence report live in
`.pocket-build/research/shanghai-bund-1920/`.

`defineDayPlace` uses the shared `daytime-coast` family, shared PBR brick/stone,
river water, daylight, light-bake, tone mapping and batching. Near-camera
window reveals, trim, balustrades, rails, boat battens and rigging are geometry.
The six 20-second shots total **120 seconds**. Rigid animation and both water
layers repeat at that boundary. The tram travels at 7.824 m/s along the quay,
turns west outside the detailed frontage and returns behind the banks. Its
rounded 939 m block is an animation closure, not an asserted historical route.
The preview shot is `Old Customs`; at t=25 the tram is passing
near the Customs House. Atmospheric light is an authored hazy autumn morning,
not a claim about recorded 1920 weather.

The goals are 30 fps at Vita step 0, serialized GPU ≤25 ms per camera,
approximately 250 visible draws / 130k triangles, moving geometry ≤30k triangles
and ≤50 MiB. These are budgets, **not measured hardware results**. Host
construction, export/cook receipts, on-device shader compilation, GPU timings
and human review must be reported separately by the integration run.
