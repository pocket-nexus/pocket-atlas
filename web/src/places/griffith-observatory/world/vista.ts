import { MeshStandardMaterial } from "three";
import { HAZE_GLSL } from "../../shared/haze";
import { buildLightField, type LightFieldOptions, type LightSet } from "../../shared/lights";
import type { GriffithWorld } from "./context";
import { HAZE } from "./haze";
import { LOOP } from "./layout";
import { cityLightSets } from "./vista/city";
import { buildLandmarks } from "./vista/landmarks";
import { buildPlants } from "./vista/plants";
import { buildTerrainGeometry } from "./vista/terrain";

/**
 * Griffith Park's terrain, the basin and its city lights, the landmarks on
 * the horizon (area B): everything outside `SITE`.
 */

/** The light field's sprite and gain settings (contract 1; sizes in pixels of a 272-pixel-high frame). */
export const VISTA_LIGHTS: LightFieldOptions = {
  minPixels: 2,
  maxPixels: 10,
  gain: 1,
  loop: LOOP,
  depthPull: 0.012,
  haze: { glsl: HAZE_GLSL, uniforms: HAZE.uniforms },
};

/** Gain of the static city carpet (C's grade and haze fixed; measured on the Terrace view). */
const CARPET_GAIN = 1.1;

/** Adds one light set to the world as a Points object driven by the loop clock. */
export function addLights(w: GriffithWorld, set: LightSet, opts: LightFieldOptions = VISTA_LIGHTS): void {
  if (!set.count) return;
  const field = buildLightField(set, opts);
  w.root.add(field.points);
  w.updaters.push((_dt, t) => field.update(t));
}

export function buildVista(w: GriffithWorld): void {
  const { geometry } = buildTerrainGeometry();
  const ground = new MeshStandardMaterial({ name: "vista-ground", vertexColors: true, roughness: 1, metalness: 0 });
  const mesh = w.mesh(geometry, ground, 0, 0, 0, w.root, { cast: false, receive: false });
  mesh.name = "vista-terrain";

  const landmarks = buildLandmarks(w);
  addLights(w, landmarks.beacons);

  buildPlants(w);

  // The static carpet's gain is set against p09: the Terrace carpet's mean reads ~(42, 40, 46).
  for (const set of cityLightSets()) addLights(w, set, set.name === "city" ? { ...VISTA_LIGHTS, gain: CARPET_GAIN } : VISTA_LIGHTS);
}
