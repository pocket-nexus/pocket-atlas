import type { RouteDef } from "../shared/def";
import { OVERCAST_SNOW } from "../shared/weather";

/**
 * National Route 237 from the southern edge of Asahikawa to Furano, 50.8 km
 * through Nishi-Kagura, Biei, Miyama Pass, Kami-Furano and Naka-Furano, on a
 * mid-January afternoon in light snow. Surveyed from OpenStreetMap and the
 * GSI elevation tiles (`survey.json`, `tools/route-survey.ts`); the stops
 * are places the road passes.
 */
const data = (name: string) => new URL(`./data/${name}`, import.meta.url).href;

export const ROUTE: RouteDef = {
  files: {
    route: data("route.json"),
    centerline: data("centerline.bin"),
    features: data("features.bin"),
    demNear: data("dem-near.bin"),
    demMid: data("dem-mid.bin"),
    demFar: data("dem-far.bin"),
  },
  stops: [
    { name: "Nishi-Goryō, Asahikawa", native: "旭川・西御料", lat: 43.7186, lon: 142.3725 },
    // JR Nishi-Kagura station, beside the road.
    { name: "Nishi-Kagura", native: "西神楽", lat: 43.6822, lon: 142.3936 },
    // The junction by the Biei fire station and the 7-Eleven (OSM).
    { name: "Biei", native: "美瑛", lat: 43.5967, lon: 142.4629 },
    // The viewpoint at the top of the pass (OSM tourism=viewpoint).
    { name: "Miyama Pass", native: "深山峠", lat: 43.5182, lon: 142.4477 },
    // Where the bypass rejoins the old road, by the Lawson.
    { name: "Kami-Furano", native: "上富良野", lat: 43.4485, lon: 142.4643 },
    { name: "Naka-Furano", native: "中富良野", lat: 43.4033, lon: 142.4203 },
    { name: "Furano Marché", native: "フラノマルシェ", lat: 43.3421, lon: 142.3862 },
  ],
  // Sunset at Biei on 20 January is 16:20; the drive starts with the sun 11° up in the south-west.
  departure: "2026-01-20T15:00:00+09:00",
  weather: OVERCAST_SNOW,
  views: [
    { name: "Departure", km: 0.06, right: -7.5, up: 1.6, ahead: 60, aheadRight: 0, fov: 42, travel: 4 },
    { name: "Nishi-Kagura", km: 4.6, right: 6.5, up: 2.2, ahead: 90, fov: 38, travel: 6 },
    { name: "Biei", km: 16.2, right: -6, up: 3.0, ahead: 80, fov: 40, travel: 6 },
    { name: "Hills", km: 22.4, right: 9, up: 5, ahead: 160, aheadUp: 4, fov: 34, travel: 8 },
    { name: "Miyama Pass", km: 25.9, right: -8, up: 2.4, ahead: 120, fov: 36, travel: 6 },
    { name: "Kami-Furano", km: 33.6, right: 5, up: 1.8, ahead: 70, fov: 42, travel: 5 },
    { name: "Furano", km: 49.9, right: -5.5, up: 1.7, ahead: 60, fov: 44, travel: 4 },
  ],
};
