import { Color, Vector3 } from "three";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { createDefinedStage, defineDayPlace } from "../shared/authoring";
import { shotVolumes, type Shot } from "../shared/camera";
import { LOOP, ORIGIN } from "./layout";
import { buildBuildings, buildDistantBay, buildGround, buildPromenade } from "./world";
import { buildCrabWheel, buildFerryArch, buildSkyStar } from "./landmarks";
import { buildCruise, buildFleet, buildPampanito } from "./maritime";
import { buildLife } from "./life";
import { buildPalms } from "./palms";

export const SHOTS: Shot[] = [
  { name: "Crab Wheel", from: { pos: [-13, 1.65, 17], target: [12, 5.0, -14], fov: 48 }, to: { pos: [-11, 1.65, 15], target: [12, 5.0, -14], fov: 48 }, duration: 20 },
  { name: "Fishing Harbor", from: { pos: [-108, 1.7, 18], target: [-104, 1.2, -37], fov: 52 }, to: { pos: [-110, 1.7, 17], target: [-110, 1.3, -40], fov: 52 }, duration: 20 },
  { name: "Pier 43 Arch", from: { pos: [239, 1.7, -85], target: [209.7, 6.8, -103], fov: 47 }, to: { pos: [237, 1.7, -83], target: [209.7, 6.8, -103], fov: 47 }, duration: 20 },
  { name: "Jefferson", from: { pos: [-20, 1.8, 25], target: [88, 8, -20], fov: 49 }, to: { pos: [-16, 1.8, 24], target: [98, 9, -24], fov: 49 }, duration: 20 },
  { name: "Working Wharf", from: { pos: [-47, 2, -88], target: [-132, 3.5, -152], fov: 51 }, to: { pos: [-49, 2, -91], target: [-139, 3.5, -158], fov: 51 }, duration: 20 },
  { name: "Bay", from: { pos: [152, 1.8, -71], target: [-33, 13, -410], fov: 51 }, to: { pos: [155, 1.8, -71], target: [-38, 13, -430], fov: 51 }, duration: 20 },
];
// 2025-09-15 16:15 PDT clear-afternoon interpretation (NOAA solar equations); fixed sun and zero cloud drift retain the 120 s seam.
const SUN = new Vector3(-0.736222, 0.567783, 0.368239).normalize();
export const definition = defineDayPlace({
  id: "sf-fishermans-wharf", kind: "daytime-coast", seed: 18842024,
  sampling: { startSeconds: 0, durationSeconds: LOOP, fps: 15 }, resources: [], season: "summer", shots: SHOTS,
  walkable: [...shotVolumes(SHOTS), [-150, .2, -5, 10, 12, 40], [-12, .2, -91, 11, 12, 40], [13, .2, -72, 245, 14, -52]],
  focus: [-270, -3, -440, 285, 54, 130], intro: { pos: [-26, 5.5, 27], target: [3, 4.5, -14], fov: 47 }, introSeconds: 5,
  sunDirection: SUN, sunIntensity: 4.8, sunCenter: [0, 0, -45], shadowBounds: [-180, -4, -215, 245, 52, 80],
  // Capture open water: the old inland probe saw a wall and painted a false black sea horizon.
  envPosition: [155, 12, -120], envIntensity: .85, fogDensity: .00043,
  atmosphere: {
    sky: { zenith: new Color(.14, .32, .52), horizon: new Color(.68, .74, .73), ground: new Color(.33, .34, .31), gradientPower: .48, groundBlend: 6, sun: SUN, sunColor: new Color(1, .94, .83), glow: { intensity: .14, wide: [.35, 6], tight: [1, 48] }, disc: { intensity: 32 } },
    hemisphere: { sky: new Color(.64, .69, .71), ground: new Color(.35, .33, .28), intensity: .78 }, fogColor: new Color(.68, .74, .73),
    post: { tone: "aces", ao: { radius: .75, intensity: 1.1, color: [.16, .19, .18] }, bloom: { threshold: 1.8, smoothing: .3, intensity: .08, radius: .7, levels: 5 }, grade: { grain: .002, vignette: .10, lift: [0, 0, 0], gain: [1, 1, .98], saturation: .97, contrast: 1.02 } },
    skyOcclusion: { rays: 48, reach: 1.8, foliage: .55 },
  },
  metadata: {
    geo: { ...ORIGIN, bearing: 0, frame: "+X east; -Z north; y metres above promenade", note: "Selected OpenStreetMap footprints, coastline and tagged heights; facade relief and small equipment dimensions are photographic estimates." },
    era: "Modern waterfront, 2024–2026 reference window", loopSeconds: LOOP,
    sunlight: { date: "2025-09-15T16:15:00-07:00", azimuth: 243.427, elevation: 34.596, method: "NOAA general solar equations; fixed during loop" },
    references: ["https://www.fishermanswharf.org/about-us/faqs/", "https://www.sfport.com/about/news/san-francisco-unveils-vibrant-new-fishermans-wharf-promenade", "https://maritime.org/visit-us/", "https://www.skystarwheel.com/", "https://ssjeremiahobrien.org/", "https://www.openstreetmap.org/node/5455630121"],
    fidelity: { authoritative: ["crab-wheel location", "selected OSM plans", "SkyStar height and gondola count", "Pampanito pier", "2024 promenade pergola count"], estimated: ["facade subdivisions", "boat fleet and berths", "small equipment", "pergola spacing", "weather artistic interpretation"], exclusions: ["Jeremiah O’Brien at former Pier 45 berth", "burned Pier 45 Shed C", "Pier 39 sea lions at Pier 45", "operational maritime simulation"] },
  },
  async build(w, progress) {
    await progress(.28, "Laying the surveyed waterfront"); buildGround(w);
    await progress(.39, "Restoring Jefferson and Pier 45"); buildBuildings(w); buildCrabWheel(w);
    await progress(.49, "Building the working fishing harbor"); buildFleet(w); buildPampanito(w); buildCruise(w);
    await progress(.58, "Opening the waterfront promenade"); buildPromenade(w); buildFerryArch(w); buildSkyStar(w);
    await progress(.66, "Looking across San Francisco Bay"); buildDistantBay(w); buildLife(w); buildPalms(w);
  },
});
export function createStage(ctx: StageContext, place: PlaceDef, progress: Progress) { return createDefinedStage(definition, ctx, place, progress); }
