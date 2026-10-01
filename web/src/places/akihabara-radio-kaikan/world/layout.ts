import { Vector3 } from "three";

/**
 * Site plan of the street in front of Akihabara Radio Kaikan (秋葉原ラジオ会館,
 * the 2014 building), 外神田1-15-16. Metres, y up. The origin is the
 * building's NE corner at sidewalk level; +X runs east and −Z north, so the
 * one-way street runs along X and the 24 m north facade lies on z = 0 facing
 * −Z. The facade line runs 0.7° off east in OpenStreetMap; the world is
 * aligned to true north and that offset is dropped. Footprints and street
 * lines come from OSM (way 47127856 and its neighbours); heights from the
 * research report and photographs.
 *
 *                       −Z (north)
 *        Sobu Line viaduct (z ≈ −38 … −42, deck ≈ 16 m), Akiba Crossfield beyond
 *   ──────┬──────────┬─┬─────────────────── atre 1 ─────────────┬──── station
 *   宝田  │  Gamers  │ │ (footway under the viaduct, x −20.7 … −16.9) │   plaza
 *   ──────┴──────────┴─┴──── north building line z = −18.9 ─────┴──── 電気街南口
 *          north sidewalk (pavers)                    ⊙ pole clock (16, −15.7)
 *   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ kerb z = −12.6 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ A (38.1, −16.7)
 *    Chuo-   one-way westbound, pedestrian-only 16:00–19:00 (asphalt, y = −0.12)
 *    dori ─ ─ ─ ─ ─ ─ ─ ─ ─ kerb z = −5.8 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
 *   x≈−63     south sidewalk (pavers)
 *   ──┬───────┬─────┬──┬═════ RADIO KAIKAN ═════┬──┬──┬──── Sofmap ──┬── namco ──
 *     │corner │ pa- │  │ x −24 … 0, z 0 … 48.6  │  │fi│ x 8 … 24     │ x 25 … 36
 *     │tower  │chinko  alley                     alley nance
 *                       +Z (south)
 */
export const KAIKAN = {
  x0: -24,
  x1: 0,
  z0: 0,
  z1: 48.6,
  /** Parapet top of the main volume and the top of the penthouse levels (GL+46.5 m). */
  roof: 44.2,
  top: 46.5,
  /** Storey height of the 3F–10F ribbon floors. */
  floorH: 4.2,
  /** 3F floor level. */
  f3: 9.8,
  /** Ribbon-window span; the louvre strip fills the facade west of it. */
  ribbon: { x0: -19.6, x1: 0 },
  /** 2F LED sign band (yellow, ribbed) and the LED screen west of it. */
  band: { x0: -13.9, x1: 0, y0: 4.75, y1: 8.55, depth: 0.45 },
  screen: { x0: -19.5, x1: -14.3, y0: 4.95, y1: 8.45 },
  /** Leased billboard over 3F–4F on the west two-thirds of the ribbon span. */
  billboard: { x0: -19.2, x1: -6.6, y0: 9.95, y1: 18.1 },
  /** Ground-floor shopfront line under the soffit (recessed from the facade). */
  shopfront: 1.35,
  soffit: 4.55,
  /** Main entrance (glass doors), centre x. */
  entrance: { x0: -13.3, x1: -8.7 },
};

/** Street lines (z), sidewalk level y = 0, carriageway y = ROAD_Y. */
export const STREET = {
  southLine: 0,
  southKerb: -5.8,
  northKerb: -12.6,
  northLine: -18.9,
  /** East end of the street: the station plaza. */
  east: 36,
};
export const ROAD_Y = -0.12;
export const KERB_H = 0.12;

/** Chuo-dori (one-way, N–S) and the building line across it that closes the vista. */
export const CHUO = { kerbEast: -63.5, kerbWest: -88.5, lineWest: -93.6, lineEast: -59.8 };

/** Zebra crossings across the street (x of the centre line, width in x). */
export const CROSSINGS = [
  { x: 7.9, w: 4.0 },
  { x: 34.2, w: 4.0 },
];

/** The two canonical viewpoints of the research report, and the pole clock. */
export const VIEW = {
  /** A: the Electric Town South exit (35.698252, 139.772507), eye at 1.6 m, looking ~250°. */
  arrival: new Vector3(38.1, 1.6, -16.7),
  /** B: the north sidewalk opposite the entrance (35.698243, 139.771987), looking 180°. */
  frontal: new Vector3(-8.95, 1.6, -15.7),
  clock: new Vector3(16.0, 0, -15.7),
};

/**
 * Blue hour in mid-October, about 17:35 JST: the sun sits 5° below the
 * horizon at azimuth 262°, almost straight down the street toward Chuo-dori.
 */
export const SUN = { azimuth: 262, elevation: -5 };

export const GEO = {
  /** The origin (NE corner of the footprint) and the centre of the north facade. */
  lat: 35.698101,
  lon: 139.772086,
  facade: { lat: 35.6981, lon: 139.77195 },
  address: "東京都千代田区外神田1-15-16",
  /** Ground level above sea level (m). */
  elevation: 4,
};
