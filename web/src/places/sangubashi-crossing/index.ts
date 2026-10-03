import { Vector3 } from "three";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import type { Box6, Shot } from "../shared/camera";
import { createDefinedStage, defineDayPlace } from "../shared/authoring";
import { SpringAudio } from "./sound";
import { buildGardens, buildGround, buildNeighbourhood, buildStreetDetails, roadY } from "./world";
import { buildPassingTrain, PASS } from "./rail";

const SHOTS: Shot[] = [
  { name: "Crossing", from: { pos: [-0.65, 1.18, 11], target: [-1.7, 2.5, -18], fov: 35 }, to: { pos: [-0.65, 1.15, 10], target: [-1.7, 2.5, -18], fov: 35 }, duration: 14 },
  { name: "Blossom", from: { pos: [-1.8, 1.75, 7.6], target: [3.3, 3.7, -9.4], fov: 43 }, to: { pos: [-1.5, 1.8, 6.8], target: [3.4, 3.8, -9.4], fov: 43 }, duration: 11 },
  { name: "Tracks", from: { pos: [2.5, 2.4, 9.9], target: [-10, 2.2, -0.7], fov: 51 }, to: { pos: [2.5, 2.1, 8.8], target: [-11, 2.5, -1.3], fov: 51 }, duration: 12 },
  { name: "Train", from: { pos: [2.5, 2.45, 10.2], target: [-6, 2.15, 1], fov: 49 }, to: { pos: [2.5, 2.3, 9.7], target: [-6, 2.15, 1], fov: 49 }, duration: 12 },
  { name: "Lane", from: { pos: [0.1, 0.3, -18.8], target: [-0.3, 3.8, 3.5], fov: 48 }, to: { pos: [0.3, 0.5, -17.5], target: [-0.3, 3.9, 3.5], fov: 48 }, duration: 12 },
  { name: "Spring", from: { pos: [0.5, 2.4, 26], target: [0, 3, -9], fov: 43 }, to: { pos: [0.4, 2.3, 24.5], target: [0, 3, -9], fov: 43 }, duration: 12 },
];
const WALKABLE: Box6[] = Array.from({ length: 21 }, (_, i) => {
  const z = -35 + i * 3.5;
  return [-2.55, Math.max(roadY(z), roadY(z + 3.5)) + 0.4, z, 2.55, 13, z + 3.5];
});

export const definition = defineDayPlace({
    id: "sangubashi-crossing", seed: 20160826,
    sampling: { startSeconds: 0, durationSeconds: PASS.period, fps: 15 },
    kind: "daytime-street", season: "spring", shots: SHOTS, walkable: WALKABLE,
    focus: [-28, -5, -65, 28, 22, 48],
    intro: { pos: [-0.5, 5.5, 24], target: [-1.7, 2.5, -18], fov: 42 }, introSeconds: 5,
    sunDirection: new Vector3(0.58, 0.7, 0.34).normalize(), sunIntensity: 7.2,
    sunCenter: [0, 1, -8], shadowBounds: [-18, -4, -36, 18, 13, 25],
    envPosition: [0, 2.1, -2], envIntensity: 0.95, fogDensity: 0.009,
    metadata: {
      geo: { lat: 35.67528, lon: 139.69175, bearing: 276, note: "Approximate photo-based layout; −Z looks down the western lane. Not a measured survey." },
      season: "spring", railway: { gauge: 1.067, tracks: 2, skew: 0.105, pass: PASS, rollingStock: "Odakyu 1000, photo-based 1081 eight-car formation" },
      references: ["https://fujisyuu01.hatenablog.jp/entry/14371167", "https://shinkaifan.com/past/5-centimeters-per-second/"],
    },
    createAudio: ctx => new SpringAudio(ctx.audio),
    build: async (world, progress) => {
      await progress(0.28, "Laying the double tracks"); buildGround(world);
      await progress(0.4, "Building the Yoyogi lane"); buildNeighbourhood(world);
      await progress(0.52, "Stringing the overhead wires"); buildStreetDetails(world);
      await progress(0.62, "Opening the cherry blossoms"); buildGardens(world);
      await progress(0.68, "Preparing the passing local"); buildPassingTrain(world);
    },
});

export function createStage(ctx: StageContext, place: PlaceDef, progress: Progress) {
  return createDefinedStage(definition, ctx, place, progress);
}
