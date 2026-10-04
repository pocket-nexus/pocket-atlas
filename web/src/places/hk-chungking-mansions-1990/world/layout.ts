import type { Shot } from "../../shared/camera";

/** Metres, threshold at 36–44 Nathan Road; +X east, -Z north. Modern retained-block plan from OSM; elevations and street section are photo estimates, not a 1990 survey. */
export const SITE = {
  lat: 22.29646, lon: 114.172402,
  frontage: 36.4, depth: 92.6, roof: 55, podium: 9.2,
  roadCenter: -16.4, roadWidth: 23.6, pavement: 4.6,
} as const;
export const LOOP = 120;
export const SHOTS: Shot[] = [
  { name: "Nathan Road", from: { pos: [-30.8, 1.7, 23], target: [0, 13, -2], fov: 60 }, to: { pos: [-30.3, 1.7, 21.4], target: [0, 13, -3], fov: 60 }, duration: 23 },
  { name: "Mansions", from: { pos: [-29.8, 2.4, -19], target: [0, 25.7, 0], fov: 71 }, to: { pos: [-29.4, 2.4, -18], target: [0, 26.5, 0], fov: 71 }, duration: 21 },
  { name: "Signs", from: { pos: [-3.4, 1.72, 12], target: [-10, 7.5, -43], fov: 61 }, to: { pos: [-3.4, 1.72, 11], target: [-10, 7.5, -43], fov: 61 }, duration: 19 },
  { name: "Entrance", from: { pos: [-9.2, 1.66, -0.5], target: [1.5, 2.65, 0], fov: 62 }, to: { pos: [-8.6, 1.66, -0.3], target: [1.5, 2.65, 0], fov: 62 }, duration: 19 },
  { name: "Arcade", from: { pos: [9.2, 1.66, -0.4], target: [21, 2.2, 0.5], fov: 63 }, to: { pos: [10.5, 1.66, -0.3], target: [22, 2.2, 0.5], fov: 63 }, duration: 19 },
  { name: "Lightwell", from: { pos: [36, 1.75, 10.2], target: [52, 22, 14.2], fov: 68 }, to: { pos: [37, 1.75, 10.2], target: [53, 23, 14.2], fov: 68 }, duration: 19 },
];
