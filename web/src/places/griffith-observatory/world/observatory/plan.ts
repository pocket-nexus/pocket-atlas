import { arc, type P2 } from "./kit";

/**
 * The observatory's measurements in place metres (origin at the planetarium
 * dome's centre, +X east, −Z north, y above the front lawn at 346.0 m).
 *
 * Plan: the LA County 2023 roof outline (`buildings/lacounty-buildings-
 * observatory.json`, 69.2 × 53.5 m, 63 vertices), the OSM dome outlines and
 * paths (`osm/observatory-survey.json`) and the Esri z19 ortho (10 m grid)
 * agree to within half a metre on everything below. Heights: lidar roof top
 * 371.0 m ASL (the planetarium dome, y = 25.0), telescope dome tops 363.8 m
 * (y = 17.8); the rest is read off the photographs against those two (est.).
 */

/** Levels (place y). */
export const LEVEL = {
  /** Entrance plaza in front of the north façade (DEM 0.7–1.1 m). */
  plaza: 1.0,
  /** Main floor at the entrance doors (DEM: landing 1.8, the recess 2.1–2.3). */
  floor: 2.15,
  /** Roof decks over the halls and the promenade round the drum (est. from p03, p04, p17). */
  deck: 8.6,
  /** Parapet height above a deck (guard ~1.07 m, est.). */
  parapet: 1.05,
  /** Lower west (café) terrace beside the Gottlieb Transit Corridor (DEM −3.8). */
  cafe: -3.8,
  /** Lower east terrace / loading access south-east of the drum (DEM −1.5). */
  east: -1.5,
};

/** The planetarium: drum, promenade and dome. */
export const DRUM = {
  /**
   * Centre of the drum and dome: the roof outline's drum arc and the OSM dome
   * outline are both centred ~0.5 m east and ~0.3 m south of the frame origin.
   */
  x: 0.5,
  z: 0.3,
  /** Lower drum outer wall between its pilasters (outline r 15.3 ± 0.3, pilasters to 15.75). */
  r: 15.3,
  /** Upper drum wall, rising from the promenade (walkway ~1.5–2 m wide, p23). */
  rUpper: 13.0,
  /** Upper drum cornice top: the dome shows above it (p03). */
  top: 14.3,
  /** Copper dome: hemisphere, outer Ø 25.8 m (OSM), apex at the lidar roof top. */
  domeR: 12.9,
  domeTop: 25.0,
  /** Pilasters round the drum (p01, p03, p17: 8 on a half). */
  bays: 16,
  /** Angle of the first pilaster (θ, rad): one on the south axis. */
  phase: Math.PI / 2,
};

/** Where the drum's lower ring is exposed: θ from the east shoulder (z 2.0) round the south to the west one (z 2.1). */
export function drumOpen(): [number, number] {
  const r = DRUM.r;
  return [Math.asin((2.0 - DRUM.z) / r), Math.PI - Math.asin((2.1 - DRUM.z) / r)];
}

/** Telescope domes: copper on a drum that rises from the ground at the façade corners. */
export const DOMES = {
  /** West (coelostat, solar) dome: shutter closed at night. */
  west: { x: -29.2, z: -28.9 },
  /** East (12-inch Zeiss) dome: shutter open, public viewing on clear nights (p20). */
  east: { x: 29.5, z: -28.6 },
  /** Drum radius (OSM dome outlines Ø 10.2 m). */
  drumR: 5.0,
  /** Drum top / copper skirt / dome (30 ft = 9.14 m, est. 9.6 m over the skirt). */
  drumTop: 11.6,
  skirtTop: 13.0,
  domeR: 4.8,
};

/** North façade line and the entrance pavilion (LA County outline). */
export const FACADE = {
  z: -34.7,
  west: -29.5,
  east: 31.2,
  /** Entrance pavilion: projects to z −37.7 between x −9.6 and 11.2 … */
  pav: { x0: -9.6, x1: 11.2, z: -37.7, top: 10.6 },
  /** … with its doorway recessed to z −35.7 between x −3.9 and 5.6. */
  recess: { x0: -3.9, x1: 5.6, z: -35.7 },
  /** Five tall windows a wing (p02, p05), 1.6 × 3.2 m, sill at 2.2 (est.). */
  windows: 5,
  bay: 3.3,
  winW: 1.6,
  sill: 2.2,
  head: 5.4,
};

/** Main block behind the façade: halls, rotunda, the south-east wing (outline). */
export const BLOCK = {
  north: { x0: -29.5, x1: 31.2, z0: -34.7, z1: -21.7 },
  centre: { x0: -15.3, x1: 18.8, z0: -21.7, z1: -8.2 },
  eastWing: { x0: 18.8, x1: 31.1, z0: -21.7, z1: -8.3 },
  eastShoulder: { x0: 15.8, x1: 18.8, z0: -8.3, z1: 2.0 },
  westShoulder: { x0: -17.2, x1: -14.6, z0: -8.1, z1: 2.1 },
};

/** The rotunda (Foucault pendulum hall): octagon in a light well, green copper roof (ortho, p17). */
export const ROTUNDA = { x: 0.4, z: -26.6, r: 6.2, wallTop: 11.6, roofTop: 14.0, lanternTop: 15.0 };

/**
 * Deck outline at LEVEL.deck (clockwise from the north-west, x–z): the north
 * block, the shoulders and the promenade ring, simplified from the roof
 * outline. The telescope drums, the rotunda well and the upper drum are holes.
 */
export function deckOutline(arcSeg = 48): P2[] {
  const r = DRUM.r;
  const cx = DRUM.x;
  const cz = DRUM.z;
  const rd = DOMES.drumR + 0.05;
  const E = DOMES.east;
  const W = DOMES.west;
  const pts: P2[] = [
    [FACADE.west, FACADE.z],
    [FACADE.east, FACADE.z],
  ];
  // East edge meets the east telescope drum: round its west side.
  const dzE = Math.sqrt(rd * rd - (FACADE.east - E.x) ** 2);
  pts.push(...arc(E.x, E.z, rd, Math.atan2(-dzE, FACADE.east - E.x), Math.atan2(dzE, FACADE.east - E.x) - Math.PI * 2, 28));
  pts.push([31.2, -21.6], [31.1, -8.3], [18.8, -8.3], [18.8, 2.0]);
  // Promenade ring round the south of the drum.
  const [a0, a1] = drumOpen();
  pts.push(...arc(cx, cz, r, a0, a1, arcSeg));
  pts.push([-17.1, 2.1], [-17.2, -8.1], [-15.2, -8.1], [-15.3, -21.7], [-31.3, -21.7]);
  // West edge meets the west telescope drum: round its east side to the façade's west end.
  const dzW = Math.sqrt(rd * rd - (-31.3 - W.x) ** 2);
  const dzN = Math.sqrt(rd * rd - (FACADE.west - W.x) ** 2);
  pts.push(...arc(W.x, W.z, rd, Math.atan2(dzW, -31.3 - W.x), Math.atan2(-dzN, FACADE.west - W.x), 28));
  return pts;
}

/** Gottlieb Transit Corridor (below the west lawn) and the café terrace beside it (OSM). */
export const WEST = {
  corridor: { x0: -49.2, x1: -46.2, z0: -51.6, z1: -11.7 },
  cafe: { x0: -53.6, x1: -49.2, z0: -54.4, z1: -9.7 },
  /** Upper west terrace over the corridor, level with the lawn. */
  terrace: { x0: -46.2, x1: -31.3, z0: -60.4, z1: -11.7 },
};

/**
 * Ground plan of the grounds (place x, z; clockwise with north up), drawn
 * from the OSM ways (walks, retaining walls, sidewalks, the parking area)
 * and checked on the z19 ortho.
 */
export const GROUND = {
  /**
   * The paved precinct: entrance plaza, the walks round the lawn panels, the
   * upper west terrace over the Gottlieb corridor and the terraces south of
   * the west wing. North edge: the sidewalk round the turnaround; west edge:
   * the retaining wall (way 443097364); east edge: the service walk (way
   * 481633339) and the plaza round the east dome.
   */
  precinct: [
    [-18.4, -118.1], [-15.6, -117.5], [-13.7, -115.0], [-8.2, -111.2], [-2.4, -109.5], [3.5, -109.4], [7.4, -110.8], [11.7, -112.8], [14.4, -114.6], [15.8, -117.8],
    [17.4, -117.4], [17.0, -56.0], [18.5, -51.5], [21.0, -49.4], [25.4, -47.6], [30.6, -45.7], [34.0, -43.0], [36.3, -40.3], [36.4, -37.2], [34.2, -34.8],
    [-29.5, -34.6], [-31.0, -34.6], [-33.4, -33.4], [-35.0, -31.3], [-35.6, -28.6], [-35.0, -25.9], [-33.3, -23.6], [-31.3, -22.5], [-31.3, -21.7],
    [-15.3, -21.7], [-15.2, -8.1], [-17.2, -8.1], [-17.3, -2.2], [-19.2, -2.2], [-19.2, -7.7], [-35.2, -7.7], [-35.3, -11.7], [-46.2, -11.7],
    [-46.2, -60.6], [-50.7, -60.6], [-50.7, -63.4], [-46.0, -63.4], [-46.1, -70.2], [-41.7, -70.2], [-38.6, -76.5],
  ] as P2[],
  /** The horseshoe drive round the turnaround island, between the sidewalks (ways 1158002857, 1158002874), to the parking area. */
  drive: [
    [-15.6, -117.5], [-15.5, -128.8], [-15.6, -155.0], [-16.6, -160.5], [-19.0, -167.5], [-26.6, -207.4], [-17.2, -215.5], [2.0, -215.5], [19.3, -208.6],
    [15.8, -200.9], [13.5, -191.1], [11.8, -176.6], [12.1, -165.1], [14.8, -147.7], [17.5, -139.9], [17.8, -134.5], [16.8, -128.5], [15.8, -117.8],
    [14.4, -114.6], [11.7, -112.8], [7.4, -110.8], [3.5, -109.4], [-2.4, -109.5], [-8.2, -111.2], [-13.7, -115.0],
  ] as P2[],
  /** Surface parking (way 481634398). */
  parking: [
    [1.8, -215.1], [3.9, -220.3], [6.5, -224.2], [10.7, -228.6], [19.2, -236.0], [27.4, -243.8], [33.0, -250.5], [38.8, -259.5], [46.4, -272.5], [48.7, -278.1],
    [50.0, -283.3], [50.1, -286.8], [49.2, -291.3], [47.7, -295.1], [45.4, -297.8], [41.2, -300.8], [24.4, -310.8], [7.7, -319.2], [1.6, -312.8], [0.4, -310.1],
    [-2.7, -308.1], [-15.3, -304.5], [-13.6, -293.5], [-11.7, -285.9], [-9.0, -276.1], [-8.2, -270.7], [-7.5, -265.0], [-7.5, -262.6], [-7.4, -257.4], [-7.9, -248.6],
    [-8.1, -233.7], [-8.3, -223.5], [-8.4, -214.8],
  ] as P2[],
  /** East Observatory Road beyond the drive (way 861162413), 6.5 m wide. */
  eastRoad: [
    [15.8, -200.9], [17.6, -212.6], [21.2, -218.1], [26.0, -224.2], [31.5, -229.6], [45.4, -242.9], [64.4, -265.3], [69.5, -274.0], [72.3, -280.5], [74.0, -287.6],
    [74.8, -296.5], [72.9, -304.9], [70.1, -311.5], [64.7, -319.4], [58.0, -326.0],
  ] as P2[],
  /** West Observatory Road beyond the drive (way 174533647). */
  westRoad: [
    [-12.0, -213.7], [-12.2, -223.3], [-11.8, -233.7], [-11.6, -248.6], [-11.1, -257.4], [-11.2, -265.0], [-11.9, -270.7], [-12.7, -276.1], [-14.1, -281.1], [-15.4, -285.9],
    [-17.3, -293.5], [-18.4, -300.8], [-19.4, -307.0], [-20.4, -312.2], [-22.0, -326.0],
  ] as P2[],
  /** Loading access round the east dome to the lower east terrace (way 1231004293), 4.5 m wide. */
  loading: [
    [35.2, -40.0], [37.4, -37.4], [38.7, -34.5], [39.7, -31.1], [39.8, -27.7], [39.2, -24.0], [38.1, -20.8], [35.7, -16.8], [34.2, -14.4], [31.7, -5.9],
    [30.5, -3.8], [29.8, -2.7], [27.2, 0.6], [23.9, 3.9], [21.4, 5.6], [19.4, 6.2], [17.7, 6.5],
  ] as P2[],
  /** Lower east terrace south-east of the drum (service yard, parked vans in p14, p17). */
  eastTerrace: [
    [18.8, -8.3], [31.1, -8.3], [32.4, -3.5], [30.6, 4.9], [30.8, 10.6], [28.3, 10.0], [18.5, 10.1], [16.7, 10.1], [16.4, 6.0], [16.8, 2.0], [18.8, 2.0],
  ] as P2[],
  /** Turnaround island (planted, raised kerb) and the median walk up the drive (way 1158002854). */
  island: { x: 0.8, z: -135.3, r: 4.6 },
  median: [
    [0.6, -141.2], [-0.2, -160.0], [-1.0, -175.0], [-1.5, -184.6], [-0.4, -200.0], [0.9, -210.4],
  ] as P2[],
};
