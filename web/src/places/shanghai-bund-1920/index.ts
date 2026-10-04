import { Color } from "three";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { createDefinedStage, defineDayPlace } from "../shared/authoring";
import { shotVolumes, type Shot } from "../shared/camera";
import { bearing } from "../shared/geo";
import { buildArchitecture } from "./world/architecture";
import { buildWaterfront } from "./world/waterfront";
import { buildMotion, LOOP } from "./world/motion";

const SUN = bearing(122, 42);
const SHOTS: Shot[] = [
  { name: "Old Customs", from: { pos: [42, 1.7, 7], target: [-5, 13.3, 0], fov: 50 }, to: { pos: [41, 1.7, 5], target: [-5, 13.3, 0], fov: 50 }, duration: 20 },
  { name: "Bank Portico", from: { pos: [30, 2.2, 72], target: [-1, 8.2, 43], fov: 48 }, to: { pos: [28, 2.2, 70], target: [-1, 8.2, 43], fov: 48 }, duration: 20 },
  { name: "Customs Pontoon", from: { pos: [75, 2.8, -58], target: [5, 11.5, 3], fov: 52 }, to: { pos: [74, 2.9, -55], target: [5, 11.5, 3], fov: 52 }, duration: 20 },
  { name: "Bund Tramway", from: { pos: [25, 2.05, 104], target: [0, 9, -35], fov: 43 }, to: { pos: [25.2, 2.1, 101], target: [0, 9, -35], fov: 43 }, duration: 20 },
  { name: "Huangpu Junks", from: { pos: [43, 2.2, 66], target: [105, 5.1, 13], fov: 48 }, to: { pos: [43, 2.35, 62], target: [106, 5.2, 14], fov: 48 }, duration: 20 },
  { name: "Riverfront 1920", from: { pos: [157, 9.5, 118], target: [-4, 13, -28], fov: 43 }, to: { pos: [152, 9.3, 115], target: [-4, 13, -28], fov: 43 }, duration: 20 },
];

export const definition = defineDayPlace({
  id: "shanghai-bund-1920", kind: "daytime-coast", seed: 19200101,
  sampling: { startSeconds: 0, durationSeconds: LOOP, fps: 15 },
  season: "summer", shots: SHOTS,
  walkable: [...shotVolumes(SHOTS), [1.8, 0.52, -172, 6.2, 12, 170], [31, 0.52, -172, 42, 12, 170]],
  focus: [-48, -2, -180, 190, 39, 178],
  intro: { pos: [156, 12, 121], target: [-7, 12.6, -8], fov: 43 }, introSeconds: 5,
  sunDirection: SUN, sunIntensity: 4.6, sunCenter: [-5, 6, 1],
  shadowBounds: [-48, -2, -167, 88, 37, 165],
  envPosition: [32, 7, 5], envIntensity: 0.88, fogDensity: 0.0036,
  atmosphere: {
    sky: { zenith: new Color(0.2, 0.32, 0.43), horizon: new Color(0.62, 0.65, 0.62), ground: new Color(0.24, 0.24, 0.2),
      gradientPower: 0.48, groundBlend: 6, sun: SUN, sunColor: new Color(1, 0.89, 0.69),
      glow: { intensity: 0.23, wide: [0.2, 7], tight: [0.4, 80] }, disc: { intensity: 2.5 } },
    hemisphere: { sky: new Color(0.73, 0.78, 0.8), ground: new Color(0.48, 0.43, 0.34), intensity: 1.7 },
    fogColor: new Color(0.53, 0.56, 0.54), exposure: 1,
    post: { tone: "aces", ao: { radius: 1.1, intensity: 2.3, color: [0.035, 0.038, 0.041] },
      bloom: { threshold: 2, smoothing: 0.55, intensity: 0.15, radius: 0.6, levels: 5 },
      grade: { grain: 0.007, vignette: 0.15, lift: [0.02, 0.025, 0.035], gain: [1.025, 1, 0.97], saturation: 0.94, contrast: 1.02 } },
  },
  metadata: {
    geo: { lat: 31.23862, lon: 121.48562, bearing: 0, origin: "1893 Customs House entrance", frame: "+X east, -Z north, metres", note: "Lost buildings reconstructed from period plates; street is locally straightened. Not a historical cadastral survey." },
    era: { year: 1920, interpretation: "Before the HSBC rebuilding; exact demolition date and transitional plot condition are unverified" },
    measured: { customsFrontage: 41.148, customsDepth: 47.244, customsTowerHeight: 33.528, source: "Darwent, Shanghai Handbook (1920), p.8, 135/155/110 feet" },
    motion: { loopSeconds: LOOP, vessels: "Battened-sail junks and a steam tender; anonymous period types", tram: "Single-deck electric tram, unassigned route and number" },
    references: [
      "https://commons.wikimedia.org/wiki/File:C._E._Darwent_-_Shanghai_Handbook_(1920).pdf",
      "https://commons.wikimedia.org/wiki/File:Tcitp_d468_the_customs_house.jpg",
      "https://www.virtualshanghai.net/Photos/Images?ID=14942",
      "https://www.virtualshanghai.net/Photos/Images?ID=14925",
      "https://hpcbristol.net/visual/Tr02-188",
      "https://history.hsbc.com/collections/snapshots/housing-the-bank/a-shanghai-landmark",
    ],
    exclusions: ["1923 HSBC dome and bronze lions", "1927 Customs tower", "1929 Sassoon House", "1934 Broadway Mansions", "Modern Pudong towers", "Modern floodwall and road markings"],
  },
  async build(world, progress) {
    await progress(0.3, "Rebuilding the 1893 Customs House"); buildArchitecture(world);
    await progress(0.48, "Laying the old quay and tram wires"); buildWaterfront(world);
    await progress(0.65, "Mooring the junks on the Huangpu"); buildMotion(world);
  },
});

export function createStage(ctx: StageContext, place: PlaceDef, progress: Progress) {
  return createDefinedStage(definition, ctx, place, progress);
}
