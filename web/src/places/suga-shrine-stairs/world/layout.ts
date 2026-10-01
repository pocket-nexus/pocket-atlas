/**
 * Site plan of the Suga Shrine men's stairway (須賀神社 男坂), Yotsuya.
 * Metres, y up. The top nosing of the flight sits at the origin and the
 * stairs descend along −Z; looking down the stairs (−Z) faces a bearing of
 * about 33° (NNE). The world is not rotated to north: `bearing(az, el, BEARING)` (shared/geo.ts) converts.
 *
 *                    +Z  (shrine plateau, 29.4 m above sea level)
 *        shrine/torii ░░ street along x ░░░░░░░░░░░░
 *                       ┌── stair head (z = 0, y = 0)
 *   stone wall + tree ▓ │█│ █ bare concrete wall
 *     (terrace, left)   │█│ ▒ houses on stepped lots (right)
 *                       │█│   48 risers, 7.5 m rise over 15.5 m
 *   cut-stone corner ▓ ─┴─┴─ z = −15.5, y = −7.5 (21.9 m)
 *        white block    lane ~48 m, poles and wires on the west (left) side
 *                   ────┼──── five-way junction, z ≈ −66, 止まれ
 *                       │  東福院坂 climbs to the ridge ~300 m ahead
 *                    −Z  (bearing 33°)
 */
export const STAIRS = {
  count: 48,
  rise: 7.5 / 48,
  tread: 0.33,
  width: 3.6,
  /** Horizontal distance from the top nosing to the bottom riser. */
  run: 47 * 0.33,
  bottomZ: -47 * 0.33,
  bottomY: -7.5,
  /** Handrail lines (x) and heights above the nosing line. */
  rails: [-1.6, 0, 1.6] as const,
  railHeight: 0.85,
  lowerRail: 0.42,
};

/** Tread height at z (top surface of the step under that point). */
export function stepY(z: number): number {
  if (z >= 0) return 0;
  const k = Math.min(STAIRS.count, Math.ceil(-z / STAIRS.tread - 1e-6));
  return -k * STAIRS.rise;
}

/** The pitch line through the nosings. */
export function pitchY(z: number): number {
  return (z * STAIRS.rise) / STAIRS.tread;
}

export const LANE = {
  y: -7.5,
  half: 2.2,
  z0: STAIRS.bottomZ,
  /** Stop line before the five-way junction. */
  stopZ: -61.2,
  junction: { z0: -62.5, z1: -70.5 },
};

/** Ground behind the left retaining wall: low at the head, 4 m above the lane at the foot. */
export function terraceY(z: number): number {
  const t = Math.min(1, Math.max(0, -z / 17.5));
  return 0.55 + (-3.45 - 0.55) * t;
}
export const WALL_X = -1.95;

/** Far slope: the lane is flat to the junction, then 東福院坂 climbs to the ridge. */
export function groundY(z: number): number {
  if (z > LANE.junction.z1) return LANE.y;
  const t = Math.min(1, (LANE.junction.z1 - z) / 200);
  const s = t * t * (3 - 2 * t);
  return LANE.y + 12.5 * s;
}

/** Centre line of 東福院坂: straight past the junction, then bending right up the slope. */
export function roadX(z: number): number {
  const d = Math.max(0, -95 - z);
  return 0.0035 * d * d;
}

/** Looking down the stairs (−Z) faces this bearing (degrees clockwise from north). */
export const BEARING = 33;

/** Summer afternoon, about 15:30 JST in late July. */
export const SUN = { azimuth: 255, elevation: 35 };

export const GEO = {
  lat: 35.68502,
  lon: 139.7233,
  /** Metres above sea level at the stair head and at the foot. */
  top: 29.4,
  bottom: 21.9,
  address: "東京都新宿区須賀町5-6",
};
