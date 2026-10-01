import { CatmullRomCurve3, Vector3 } from "three";

/**
 * Site plan of the Kamakura-Kōkōmae No. 1 crossing (鎌倉高校前1号踏切), where
 * the slope road (日坂) from Kamakura High School meets the Enoden line and
 * Route 134 on the shore of Shichirigahama.
 *
 * Frame: metres, origin at the crossing (OSM node 3937261506, 35.3066013 N,
 * 139.5020923 E) at rail level, +X east, −Z north, y up. Heights are relative
 * to the rail at the crossing, 10.2 m T.P. (Tokyo Peil, mean sea level), so
 * the sea surface lies at y = −10.2. Local metres use the research frame's
 * spherical conversion (R = 6378137 m).
 *
 *                    −Z (north): the slope climbs 10 % to the school
 *        park ░░ hospital         │ slope road      villas on 4–6 m walls ▓▓
 *        ───────────── footway ───┼──── ▓ rock-faced retaining walls ▓▓▓▓▓
 *   ══════ Enoden (98.7° east) ═══╬══════════════════════════════════════
 *   track fence │ sidewalk 2.8–7.6 m south of the track centreline
 *   ─────────── Route 134: lanes 7.6–17.1 m ───────────────────────────
 *   sea-wall top and fence 17.1–18.8 m, then ~8 m down to the sand
 *                    +Z (south): Sagami Bay
 */

export const GEO = {
  lat: 35.3066013,
  lon: 139.5020923,
  /** Rail level at the crossing (m T.P.). */
  datum: 10.2,
  address: "神奈川県鎌倉市腰越 江ノ島電鉄 鎌倉高校前1号踏切",
};

/** Mean sea level (T.P. 0) in place coordinates. */
export const SEA_Y = -GEO.datum;

/** Late July, 15:30 JST: the sun over Enoshima's side of the bay. */
export const SUN = { azimuth: 266, elevation: 40 };

/** Seconds of motion the device loops (one train, one crossing sequence). */
export const LOOP = 120;

const R = 6378137;
const M_LAT = (R * Math.PI) / 180;
const M_LON = M_LAT * Math.cos((GEO.lat * Math.PI) / 180);

/** Latitude / longitude to place x, z (m). */
export function local(lat: number, lon: number): { x: number; z: number } {
  return { x: (lon - GEO.lon) * M_LON, z: -(lat - GEO.lat) * M_LAT };
}

// ------------------------------------------------------------- lines

/**
 * A smoothed polyline sampled every metre by arc length; `u` counts metres
 * from a chosen origin point along it.
 */
export class Line {
  private pts: Vector3[] = [];
  private u0 = 0;
  readonly min: number;
  readonly max: number;

  constructor(control: [number, number][], origin: [number, number]) {
    const curve = new CatmullRomCurve3(
      control.map(([x, z]) => new Vector3(x, 0, z)),
      false,
      "centripetal",
    );
    const len = curve.getLength();
    const n = Math.ceil(len);
    this.pts = curve.getSpacedPoints(n);
    // Arc length of the point nearest the origin.
    let best = 0;
    let bd = Infinity;
    this.pts.forEach((p, i) => {
      const d = (p.x - origin[0]) ** 2 + (p.z - origin[1]) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    const step = len / n;
    this.u0 = best * step;
    this.step = step;
    this.min = -this.u0;
    this.max = len - this.u0;
  }

  private step: number;

  /** Point at arc length u (clamped to the line). */
  point(u: number, out = new Vector3()): Vector3 {
    const f = Math.min(this.pts.length - 1.0001, Math.max(0, (u + this.u0) / this.step));
    const i = Math.floor(f);
    return out.lerpVectors(this.pts[i], this.pts[i + 1], f - i);
  }

  /** Unit tangent at u (toward increasing u). */
  tangent(u: number, out = new Vector3()): Vector3 {
    const f = Math.min(this.pts.length - 2, Math.max(0, Math.floor((u + this.u0) / this.step)));
    return out.subVectors(this.pts[f + 1], this.pts[f]).normalize();
  }

  /** Point at arc length u, offset s to the right of the direction of travel (south for an eastward line). */
  offset(u: number, s: number, out = new Vector3()): Vector3 {
    const t = this.tangent(u, _t);
    this.point(u, out);
    return out.set(out.x - t.z * s, out.y, out.z + t.x * s);
  }

  /** Arc length of the sample nearest (x, z). */
  project(x: number, z: number): number {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.pts.length; i++) {
      const d = (this.pts[i].x - x) ** 2 + (this.pts[i].z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best * this.step - this.u0;
  }
}
const _t = new Vector3();

/**
 * Coast line: the Enoden centreline (OSM way 1080901865) where the track
 * runs beside Route 134, extended along its end bearings (272.2° past the
 * platform, 97.5° east) and bending toward Inamuragasaki (105.8°, 2.5 km).
 * Route 134, the sea wall and the beach follow it at the offsets of
 * `SECTION`. u = 0 at the crossing, + east; offsets s are metres south.
 */
export const COAST = new Line(
  [
    [-720, -32.2],
    [-420, -20.6],
    [-174.2, -11.7],
    [-125.2, -9.9],
    [-71.5, -7.2],
    [-43.6, -5.9],
    [-27.7, -4.2],
    [0, 0],
    [37.5, 5.8],
    [77.5, 11.6],
    [128.0, 17.7],
    [180.8, 24.6],
    [223.8, 30.1],
    [420, 56],
    [700, 94],
    [1100, 160],
    [1500, 255],
    [1900, 400],
  ],
  [0, 0],
);

/**
 * Enoden centreline: the coast line as far as x ≈ 420 m, then the bend
 * inland toward Shichirigahama station (EN09, about 1.07 km east and 100 m
 * north of the crossing; the bend's radius is an estimate). Houses between
 * Route 134 and the bend hide trains there.
 */
export const TRACK = new Line(
  [
    [-720, -32.2],
    [-420, -20.6],
    [-174.2, -11.7],
    [-125.2, -9.9],
    [-71.5, -7.2],
    [-43.6, -5.9],
    [-27.7, -4.2],
    [0, 0],
    [37.5, 5.8],
    [77.5, 11.6],
    [128.0, 17.7],
    [180.8, 24.6],
    [223.8, 30.1],
    [330, 44],
    [420, 55.5],
    [500, 61],
    [570, 55],
    [630, 36],
    [690, 5],
    [770, -38],
    [900, -78],
    [1070, -100],
  ],
  [0, 0],
);

/** Where the track leaves the coast line (u, both lines). */
export const TRACK_SPLIT = 410;

/**
 * Cross-section of the coastal strip, metres south of the track centreline
 * (Route 134 junction section, Kanagawa 2019; GSI 1 m survey).
 */
export const SECTION = {
  gauge: 1.067,
  /** Ballast shoulders. */
  bedNorth: -2.4,
  bedSouth: 2.1,
  /** Wood-look concrete fence between the track and the sidewalk. */
  fence: 2.55,
  sidewalk: [2.8, 7.6] as const,
  /** Carriageway: 0.5 m strips, eastbound 3.0 m, right-turn lane 2.5 m, westbound 3.0 m. */
  road: [7.6, 17.1] as const,
  lanes: { east: 9.6, turn: 12.35, west: 15.1 },
  centre: [11.1, 13.6] as const,
  wallTop: [17.1, 18.8] as const,
  /** Steel-post fence on the sea wall. */
  wallFence: 18.45,
  /** Kerb heights above the rail datum. */
  kerb: 0.15,
  /** Beach sand at the wall foot (2.3 m T.P.). */
  sandTop: -7.9,
};

/** Overhead line above the rail: the messenger wire and the contact wire the pantographs press against (m). */
export const CATENARY = { messenger: 5.6, contact: 5.0 };

/** Station platform (EN08) on the north side: OSM way 605969832. */
export const PLATFORM = { west: -171.4, east: -108.0, height: 0.95, edge: -1.45, back: -4.6 };

// --------------------------------------------------------- slope road

/** GSI 1 m survey along the slope road: [metres north, height above the rail]. */
const SLOPE_PROFILE: [number, number][] = [
  [-11.2, 0.1],
  [0, 0],
  [3.5, 0.0],
  [6.7, 0.5],
  [16.9, 1.6],
  [26.7, 2.5],
  [36.5, 3.6],
  [46.3, 4.7],
  [58.3, 6.1],
  [70.2, 7.2],
  [84.7, 8.6],
  [99.1, 10.0],
  [114.0, 11.2],
  [128.9, 12.3],
  [158.0, 13.5],
  [187.4, 14.0],
  [210, 14.2],
  [240, 14.4],
];

function interp(table: [number, number][], v: number): number {
  if (v <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (v <= table[i][0]) {
      const [a, ya] = table[i - 1];
      const [b, yb] = table[i];
      const t = (v - a) / (b - a);
      return ya + (yb - ya) * t;
    }
  }
  return table[table.length - 1][1];
}

/** Road height at `north` metres north of the crossing. */
export function slopeY(north: number): number {
  // Average the piecewise-linear survey over ±3 m so the grade has no kinks.
  let s = 0;
  for (let k = -2; k <= 2; k++) s += interp(SLOPE_PROFILE, north + k * 1.5);
  return s / 5;
}

/** Road edges (x) by metres north: PLATEAU road polygons, with the side-road mouths left out. */
const EDGES: [number, number, number][] = [
  // north, west, east
  [-2, -3.7, 5.1],
  [3, -3.7, 5.2],
  [5, -3.8, 5.7],
  [10, -4.1, 6.3],
  [16, -4.3, 6.6],
  [24, -4.6, 6.0],
  [32, -4.9, 5.4],
  [40, -5.3, 5.0],
  [47, -5.6, 5.6],
  [54, -6.0, 4.6],
  [62, -6.5, 2.3],
  [80, -7.9, -1.6],
  [100, -9.4, -3.1],
  [120, -11.8, -5.2],
  [160, -16.4, -10.0],
  [190, -20.0, -13.6],
];

/** West and east edge of the slope road (x) at `north` metres north. */
export function slopeEdges(north: number): [number, number] {
  const n = Math.max(EDGES[0][0], Math.min(EDGES[EDGES.length - 1][0], north));
  for (let i = 1; i < EDGES.length; i++) {
    if (n <= EDGES[i][0]) {
      const [a, wa, ea] = EDGES[i - 1];
      const [b, wb, eb] = EDGES[i];
      const t = (n - a) / (b - a);
      return [wa + (wb - wa) * t, ea + (eb - ea) * t];
    }
  }
  const l = EDGES[EDGES.length - 1];
  return [l[1], l[2]];
}

/** The crossing: deck between the gates, gate lines north and south of the track. */
export const CROSSING = {
  /** Road across the track (x): carriageway and the green pedestrian strip on the west. */
  road: [-2.2, 5.0] as const,
  strip: [-3.7, -2.2] as const,
  /** Deck panels along the road (s, metres south of the track centre). */
  deck: [-1.75, 1.75] as const,
  /** Arm lines (s) of the east gate machines; the west gates stand a hand's width farther from the track. */
  gateNorth: -3.62,
  gateSouth: 3.42,
};

// ------------------------------------------------------------ terrain

/**
 * Ground heights on the hillside (above the rail), sampled by the GSI 1 m
 * survey beside the slope road and along the track; PLATEAU building bases
 * are added at run time. Values off the survey (the wooded ridge behind the
 * school, the hills toward Inamuragasaki) are estimates from the GSI map.
 */
export const GROUND_POINTS: [number, number, number][] = [
  // x, z, y
  [-30, -10, 1.0],
  [-15, -10, 0.8],
  [15, -10, 5.9],
  [30, -10, 7.5],
  [-30, -20, 3.0],
  [-15, -20, 2.1],
  [15, -20, 3.8],
  [30, -20, 7.1],
  [-30, -30, 5.4],
  [-15, -30, 2.1],
  [15, -30, 5.1],
  [30, -30, 7.6],
  [-30, -45, 13.5],
  [-15, -45, 9.6],
  [15, -45, 12.2],
  [30, -45, 13.1],
  [-30, -60, 13.0],
  [-15, -60, 11.3],
  [15, -60, 12.9],
  [30, -60, 18.8],
  // Along the track's north side (GSI).
  [-170, -13.6, -0.2],
  [-140, -11.2, -0.6],
  [-110, -8.8, -0.5],
  [-80, -6.4, -0.3],
  [-50, -4.0, -0.2],
  [80, 12.0, 0.0],
  [120, 18.0, 0.0],
  // The wooded ridge north of the school and the coastal hills east and west (estimates).
  [-200, -330, 32],
  [0, -330, 30],
  [200, -320, 34],
  [400, -260, 38],
  [-400, -260, 26],
  [-150, -480, 55],
  [100, -480, 62],
  [350, -460, 60],
  [600, -380, 52],
  [900, -250, 46],
  [1200, -150, 42],
  [1500, -60, 38],
  [-650, -320, 40],
  [-700, -150, 18],
  [700, 30, 14],
  [1000, 80, 18],
  [1350, 150, 26],
];

/** Shots (shared camera rig): positions from the research viewpoints. */
export const VIEW = {
  /** 51 m up the slope, eye 1.6 m above the road (17.0 m T.P.), heading 183°. */
  crossing: local(35.307059, 139.502125),
  /** 65 m up, eye 18.6 m T.P. */
  postcard: local(35.307185, 139.502065),
  platform: local(35.306718, 139.500881),
  route134: local(35.306556, 139.501784),
  seawall: local(35.306444, 139.502224),
  park: local(35.306763, 139.501894),
};
