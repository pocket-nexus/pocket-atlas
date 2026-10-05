// The places on the globe, generated from the web registry.
import { PLACES } from "./generated/catalog.ts";

export interface Place {
  id: string;
  name: string;
  /** The name in the local script. */
  native: string;
  locality: string;
  country: string;
  lat: number;
  lon: number;
  /** "#rrggbb" */
  accent: string;
  kind: string;
  tags: string[];
  summary: string;
  weather: string;
  featured: boolean;
  /** A scene exists for it (on some device). */
  live: boolean;
  /** Baked card image, or "" when none was exported. */
  preview: string;
}

export { PLACES };

export function placeById(id: string): Place | undefined {
  return PLACES.find((place) => place.id === id);
}

/** Cosine of the angle between two points on the globe. */
export function nearness(lat: number, lon: number, place: Place): number {
  const r = Math.PI / 180;
  return Math.sin(lat * r) * Math.sin(place.lat * r) + Math.cos(lat * r) * Math.cos(place.lat * r) * Math.cos((lon - place.lon) * r);
}
