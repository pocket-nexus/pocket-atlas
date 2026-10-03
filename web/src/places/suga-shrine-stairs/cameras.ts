import type { Shot } from "../shared/camera";

export const CAMERAS: Shot[] = [
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
