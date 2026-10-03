import type { Weather } from "./weather";

/** What a route provides besides its surveyed data: its stops, its hour, its weather and its named views. */
export interface RouteDef {
  /** URLs of the files in the route's `data/` folder. */
  files: { route: string; centerline: string; features: string; demNear: string; demMid: string; demFar: string };
  /** The start, the places on the way where a trip can resume, and the end, in driving order. */
  stops: { name: string; native: string; lat: number; lon: number }[];
  /** Local date and time of departure (ISO 8601 with offset): the sun's place in the sky. */
  departure: string;
  weather: Weather;
  /** Named views for the cinematic camera, captures and measurements. */
  views: RouteView[];
}

/** A camera beside the road: where along it, how far to the right of the centre line and above the road, and what it looks at. */
export interface RouteView {
  name: string;
  /** Kilometres from the start. */
  km: number;
  /** Eye: metres right of the centre line (negative: left), metres above the road. */
  right: number;
  up: number;
  /** Looks at the road this many metres further on, this far right of it, this high above it. */
  ahead: number;
  aheadRight?: number;
  aheadUp?: number;
  fov: number;
  /** The shot drifts this many metres along the road while it plays. */
  travel?: number;
  seconds?: number;
}
