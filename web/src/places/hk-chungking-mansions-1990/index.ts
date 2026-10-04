import { shotVolumes } from "../shared/camera";
import { Color, Mesh, MeshStandardMaterial } from "three";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { createDefinedStage, defineOutdoorPlace } from "../shared/authoring";
import { bearing } from "../shared/geo";
import { buildMansions, buildArcade } from "./world/fabric";
import { buildMeasuredBlocks } from "./world/massing";
import { buildStreet, buildNeighbours } from "./world/street";
import { buildMotion } from "./world/motion";
import { LOOP, SHOTS, SITE } from "./world/layout";

/** Reconstructed 1990 fabric, bracketed by 1981/1994 photographs; see README for the evidence boundary. */
export const definition = defineOutdoorPlace({
  id: "hk-chungking-mansions-1990", kind: "dusk-street", seed: 19901008,
  resources: [], sampling: { startSeconds: 0, durationSeconds: LOOP, fps: 15 },
  season: "summer", shots: SHOTS,
  walkable: [...shotVolumes(SHOTS), [-31.5, .35, -116, -.5, 45, 115], [-1, .4, -2.35, 25, 3.25, 2.35], [31, .35, 8.1, 88, 44, 12.5]],
  focus: [-74, -.5, -120, 92, 57, 120],
  intro: { pos: [-44, 6.2, 40], target: [0, 18, 0], fov: 61 }, introSeconds: 6,
  sunDirection: bearing(265, -5), sunIntensity: 0,
  sunCenter: [0, 15, 0], shadowBounds: [-33, 0, -30, 45, 55, 32],
  envPosition: [-8, 4, 0], envIntensity: .76, fogDensity: .0055,
  atmosphere: {
    sky: {
      zenith: new Color(.012, .032, .052), horizon: new Color(.14, .16, .15), ground: new Color(.035, .042, .036),
      gradientPower: .58, groundBlend: 7, sun: bearing(265, -5), sunColor: new Color(.71, .33, .12),
      glow: { intensity: .16, wide: [.3, 8], tight: [.3, 36] },
      twilight: { band: { color: new Color(.18, .12, .071), height: .08, sunBias: .8, sunPower: 2 }, belt: { color: new Color(.08, .058, .065), elevation: .15, width: .10, power: 1.5 }, shadow: { strength: .22, height: .07, power: 1.5 } },
    },
    hemisphere: { sky: new Color(.18, .22, .23), ground: new Color(.09, .085, .055), intensity: 1.35 },
    fogColor: new Color(.064, .09, .088), exposure: 1.12,
    skyOcclusion: { rays: 32, reach: 2.5, foliage: .55 },
    post: {
      tone: "agx", ao: { radius: .7, intensity: 1.05, color: [0, .01, .008] },
      bloom: { threshold: 1.25, smoothing: .45, intensity: .52, radius: .60, levels: 7 },
      grade: { grain: .003, vignette: .24, lift: [.045, .07, .06], gain: [1.04, 1.0, .92], saturation: .96, contrast: 1.06 },
      aberration: { offset: [.00015, .0001], modulationOffset: .2 },
    },
  },
  metadata: {
    era: 1990, reconstruction: "Evidence-based interpretation; no exact 1990 facade photograph located. Retained block footprints use modern OSM with inferred historical persistence; heights, tenant panels, arcade fit-out and lighting are estimates.",
    geo: { lat: SITE.lat, lon: SITE.lon, bearing: 0, note: "Origin at Nathan Road threshold; +X east, -Z north. Modern OSM retained-block outlines plus photo-estimated heights; not a 1990 cadastral survey." },
    excluded: ["2011 glazed facade", "LED video advertising", "1994 film characters", "Toyota Comfort", "iSquare"],
    references: ["https://gwulo.com/media/41308", "https://gwulo.com/media/38539", "https://gwulo.com/media/46437", "https://www.info.gov.hk/gia/general/201211/20/P201211200507.htm", "https://hub.hku.hk/bitstream/10722/244763/1/content.pdf"],
    motion: { period: LOOP, ordinaryPedestrians: 3, vehicles: ["photo-derived 9.7 m cream/red double-decker", "pre-Comfort red/silver taxi silhouette"] },
  },
  async build(world, progress) {
    await progress(.25, "Laying Nathan Road in 1990"); buildStreet(world);
    await progress(.36, "Raising the original concrete facade"); buildMansions(world); buildMeasuredBlocks(world);
    await progress(.49, "Opening the shopping arcade"); buildArcade(world);
    await progress(.60, "Hanging the projecting signs"); buildNeighbours(world);
    await progress(.69, "Bringing the evening street to life"); buildMotion(world);
    // Authored roughness relief: centimetre-scale facade plaster must not read as pebbled concrete.
    const seen = new Set<MeshStandardMaterial>();
    world.root.traverse(node => {
      if (!(node instanceof Mesh)) return;
      for (const mat of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!(mat instanceof MeshStandardMaterial) || seen.has(mat)) continue;
        seen.add(mat); mat.normalScale.multiplyScalar(.25);
      }
    });
  },
});

export const createStage = (ctx: StageContext, place: PlaceDef, progress: Progress) => createDefinedStage(definition, ctx, place, progress);
