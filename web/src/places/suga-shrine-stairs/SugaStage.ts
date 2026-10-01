import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { DayStage } from "../shared/daylight/DayStage";
import type { Box6, Shot, ShotKey } from "../shared/camera";
import { SugaAudio } from "./audio";
import { buildFar } from "./world/far";
import { buildHouses } from "./world/houses";
import { bearing, BEARING, GEO, stepY, SUN } from "./world/layout";
import { buildProps } from "./world/props";
import { buildStairs } from "./world/stairs";
import { buildTerrain } from "./world/terrain";
import { buildTree } from "./world/tree";

const SHOTS: Shot[] = [
  {
    name: "Stairs",
    from: { pos: [0.3, 1.64, 1.1], target: [-0.3, -9.6, -44], fov: 40 },
    to: { pos: [0.25, 1.62, 0.2], target: [-0.35, -10.3, -44], fov: 40 },
    duration: 12,
  },
  {
    name: "Rails",
    from: { pos: [0.34, -0.2, -2.6], target: [-0.08, -7.6, -24], fov: 38 },
    to: { pos: [0.33, -0.62, -3.5], target: [-0.08, -7.9, -24], fov: 38 },
    duration: 10,
  },
  {
    name: "Below",
    from: { pos: [0.15, -5.95, -24.2], target: [-0.5, -0.6, 1], fov: 42 },
    to: { pos: [0.05, -5.95, -22.6], target: [-0.6, -0.2, 1], fov: 42 },
    duration: 11,
  },
  {
    name: "Lane",
    from: { pos: [0.9, -5.85, -67.2], target: [-0.1, -3.7, -8], fov: 34 },
    to: { pos: [0.7, -5.85, -65.2], target: [-0.1, -3.6, -8], fov: 34 },
    duration: 11,
  },
  {
    name: "Canopy",
    from: { pos: [-1.35, 1.66, 0.2], target: [-13, 0.3, -40], fov: 50 },
    to: { pos: [-1.5, 1.66, -0.4], target: [-14, 0.5, -40], fov: 50 },
    duration: 10,
  },
];

/** Camera volumes: the stair head and street, the flight in steps, the lane, the junction. */
const WALKABLE: Box6[] = [
  [-8, 0.4, -0.3, 8, 12, 7],
  ...Array.from({ length: 6 }, (_, i): Box6 => {
    const z1 = -i * 2.6;
    const z0 = z1 - 2.6;
    return [-1.75, stepY(z0) + 0.35, z0, 1.75, 12, z1];
  }),
  [-9, 0.9, -8, -2.6, 10, 0.8],
  [-2.0, -7.1, -64, 2.0, 8, -15.4],
  [-10, -7.1, -71, 10, 8, -61],
];
const FOCUS: Box6 = [-60, -24, -150, 60, 30, 20];
const INTRO_FROM: ShotKey = { pos: [3.5, 36, 14], target: [0, -6, -34], fov: 40 };

export class SugaStage {
  static create(ctx: StageContext, place: PlaceDef, progress: Progress) {
    const sunDirection = bearing(SUN.azimuth, SUN.elevation);
    return DayStage.create(ctx, place, progress, {
      kind: "daytime-slope", season: "summer", shots: SHOTS, walkable: WALKABLE,
      focus: FOCUS, intro: INTRO_FROM, introSeconds: 7.5,
      sunDirection, sunIntensity: 10.5,
      sunCenter: [0, -3.5, -30], shadowBounds: [-14, -8, -70, 14, 13, 8],
      envPosition: [0, -2.5, -9], envIntensity: 0.86, fogDensity: 0.0011,
      metadata: { geo: { ...GEO, bearing: BEARING, note: "−Z faces the bearing; the world is not rotated to north" }, sun: { ...SUN, direction: sunDirection.toArray() } },
      audio: new SugaAudio(ctx.audio),
      build: async (world, progress) => {
        await progress(0.28, "Laying the stairs");
        buildTerrain(world); buildStairs(world);
        await progress(0.4, "Building the neighbourhood");
        buildHouses(world);
        await progress(0.52, "Stringing the wires");
        buildProps(world);
        await progress(0.6, "Leafing the cherry tree");
        buildTree(world);
        await progress(0.66, "Raising the ridge");
        buildFar(world);
      },
    });
  }
}
