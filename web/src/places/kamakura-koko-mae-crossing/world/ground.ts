import { slopeEdges, slopeY } from "./layout";

/**
 * The east side of the slope road between the crossing and the canonical
 * camera, measured from p01–p03 by casting the photographs' pixels into the
 * Crossing camera and from the Esri aerial (10 m grid):
 *
 *   n 2.9–23.6  a 0.75 m sidewalk at the foot of a battered rubble wall
 *               (batter 0.12) that carries the villa terrace 4.1–4.5 m up;
 *   n 20–24     the stone-clad garage block at the wall's north end;
 *   n 24–30     the planted triangle, 1.6–2.1 m above the road behind a
 *               low rubble wall, grass, silver grass and cycads;
 *   n 30–56     the junction mouth: a concrete apron flush with the kerb,
 *               rising east into the side road.
 *
 * The carriageway's east kerb (where the steel grating runs) lies 0.4–2 m
 * inside PLATEAU's road polygon, whose east edge includes the junction mouth.
 */

/** Carriageway east kerb x by metres north (p01 grating; aerial). */
const KERB: [number, number][] = [
  [-3, 5.15],
  [3, 5.1],
  [10, 4.85],
  [19, 4.5],
  [24, 4.35],
  [33, 3.85],
  [41, 3.4],
  [51, 3.1],
  [62, 2.3],
];

function interp(table: [number, number][], v: number): number {
  if (v <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (v <= table[i][0]) {
      const [a, ya] = table[i - 1];
      const [b, yb] = table[i];
      return ya + ((yb - ya) * (v - a)) / (b - a);
    }
  }
  return table[table.length - 1][1];
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** East kerb of the carriageway (x) at `n` metres north. */
export function eastKerb(n: number): number {
  if (n >= 62) return slopeEdges(n)[1];
  return interp(KERB, n);
}

/** The narrow sidewalk at the foot of the villa wall. */
export const WALK = { from: 2.9, to: 23.6, width: 0.75, height: 0.13 };

/** Battered wall: horizontal setback per metre of height. */
export const BATTER = 0.12;

/** The villa terrace above the wall (above the rail): PLATEAU ground 14.2 m T.P. at the corner villa. */
export function terraceY(n: number): number {
  // p01's wall silhouette: 4.8 m at 20 m north, 4.25 m at 12 m, falling to the crossing corner.
  return interp(
    [
      [2.9, 1.2],
      [5, 2.2],
      [8, 3.4],
      [12, 4.25],
      [20, 4.8],
      [23.6, 4.85],
    ],
    n,
  );
}

export const roadAt = (n: number) => slopeY(n);

/** Foot of the villa wall (x), on the sidewalk's back edge. */
export function wallBase(n: number): number {
  return eastKerb(n) + WALK.width;
}

/** Top of the villa wall (x): the foot set back by the batter over the wall's height. */
export function wallTop(n: number): number {
  return wallBase(n) + BATTER * (terraceY(n) - (roadAt(n) + WALK.height));
}

/** The planted triangle north of the garage. */
export const TRIANGLE = { from: 23.6, to: 30, lift: 1.6, inset: 0.35 };

/** Triangle top above the road: 1.6 m at its north tip, 2.1 m against the garage (p01: it hides the shutter's foot). */
export function triangleLift(n: number): number {
  return TRIANGLE.lift + 0.5 * Math.min(1, Math.max(0, (TRIANGLE.to - n) / (TRIANGLE.to - TRIANGLE.from)));
}

/**
 * West edge (x) of the hillside ground east of the slope road for n < 62:
 * the villa wall's top, the triangle's low wall, the apron behind the kerb.
 */
export function eastGroundEdge(n: number): number {
  if (n <= WALK.to) return wallTop(n);
  const tri = eastKerb(n) + 0.25;
  if (n <= WALK.to + 1.2) {
    const t = smooth(WALK.to, WALK.to + 1.2, n);
    return wallTop(WALK.to) * (1 - t) + tri * t;
  }
  if (n <= 62) return eastKerb(n) + 0.25;
  return slopeEdges(n)[1];
}

/**
 * Ground height override east of the slope road (n < 60): the villa terrace
 * level behind the wall top, the triangle's raised top, the apron flush with
 * the kerb; blended into the surveyed hillside over a few metres. Returns
 * `base` unchanged elsewhere.
 */
export function eastGround(x: number, n: number, base: number): number {
  if (n < 2.0 || n > 60) return base;
  const edge = eastGroundEdge(Math.max(2.9, n));
  if (x < edge - 0.6) return base;
  const into = x - edge;
  let target: number;
  let reach: number;
  if (n <= WALK.to) {
    target = terraceY(n);
    reach = 9;
  } else {
    // The junction mouth (and the ground under the triangle, which is its own prism): flush with
    // the kerb, rising east into the side road.
    target = roadAt(n) + 0.15 + Math.max(0, into) * 0.07;
    reach = n < TRIANGLE.to ? 14 : 6;
  }
  // Fade the override out at its north and south ends.
  const along = smooth(1.5, 2.9, n) * (1 - smooth(54, 60, n));
  const t = smooth(reach * 0.45, reach, into) * 1;
  const y = target * (1 - t) + base * t;
  return base + (y - base) * along;
}
