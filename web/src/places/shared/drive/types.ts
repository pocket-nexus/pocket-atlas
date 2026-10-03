/** Compiler input and portable simulation contract. Coordinates are metres, +X east, -Z north. */
export interface RoutePoint { s: number; real_m: number; x: number; y: number; z: number }
export interface RouteStop { id: string; name: string; s: number; kind: "delivery" | "service" | "finish"; radius: number }
export interface DriveRoute {
  version: number;
  id: string;
  title: string;
  origin: [number, number];
  distance_scale: number;
  points: RoutePoint[];
  stops: RouteStop[];
  attribution: string;
}
export interface RouteSample extends RoutePoint { dx: number; dz: number; yaw: number }
