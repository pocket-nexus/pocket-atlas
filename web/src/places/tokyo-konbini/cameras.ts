import type { Shot } from "../shared/camera";

export const CAMERAS: Shot[] = [
  {
    name: "Konbini",
    from: { pos: [12.7, 1.55, 8.6], target: [1.6, 2.1, -3.2], fov: 36 },
    to: { pos: [12.1, 1.6, 7.0], target: [1.2, 2.2, -3.2], fov: 36 },
    duration: 12,
  },
  {
    name: "Puddles",
    from: { pos: [3.6, 0.3, 6.5], target: [1.2, 1.25, -3.2], fov: 40 },
    to: { pos: [2.2, 0.26, 6.3], target: [1.0, 1.35, -3.2], fov: 40 },
    duration: 10,
  },
  {
    name: "Vending",
    from: { pos: [-8.3, 1.45, 3.9], target: [-5.6, 1.05, -1.4], fov: 40 },
    to: { pos: [-7.3, 1.35, 3.2], target: [-5.4, 1.1, -1.4], fov: 40 },
    duration: 10,
  },
  {
    name: "Crossing",
    from: { pos: [10.4, 1.7, -0.9], target: [10.0, 8.0, -80], fov: 34 },
    to: { pos: [10.1, 1.7, -3.4], target: [10.0, 8.5, -80], fov: 32 },
    duration: 12,
  },
  {
    name: "Inside",
    from: { pos: [-1.6, 1.45, -9.5], target: [0.4, 1.3, 4.0], fov: 44 },
    to: { pos: [-1.3, 1.5, -7.6], target: [0.8, 1.4, 4.0], fov: 44 },
    duration: 10,
  },
  {
    name: "Wires",
    from: { pos: [9.4, 0.9, -0.2], target: [5.8, 8.5, -2.8], fov: 50 },
    to: { pos: [8.9, 1.1, -0.7], target: [5.2, 9.0, -3.0], fov: 50 },
    duration: 9,
  },
];
