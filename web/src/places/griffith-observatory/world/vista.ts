import { MeshStandardMaterial } from "three";
import { HAZE_GLSL } from "../../shared/haze";
import { buildLightField, type LightFieldOptions, type LightSet } from "../../shared/lights";
import type { GriffithWorld } from "./context";
import { HAZE } from "./haze";
import { LOOP } from "./layout";
import { CITY_COUNTS, cityLightSets } from "./vista/city";
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

/** Adds one light set to the world as a Points object driven by the loop clock. */
export function addLights(w: GriffithWorld, set: LightSet, opts: LightFieldOptions = VISTA_LIGHTS): void {
  if (!set.count) return;
  const field = buildLightField(set, opts);
  w.root.add(field.points);
  w.updaters.push((_dt, t) => field.update(t));
}

export function buildVista(w: GriffithWorld): void {
  const t0 = performance.now();
  const { geometry, stats } = buildTerrainGeometry();
  const ground = new MeshStandardMaterial({ name: "vista-ground", vertexColors: true, roughness: 1, metalness: 0 });
  const mesh = w.mesh(geometry, ground, 0, 0, 0, w.root, { cast: false, receive: false });
  mesh.name = "vista-terrain";
  console.info(`[griffith] vista terrain: ${stats.tiles} tiles (${stats.hidden} hidden, viewshed ${stats.viewshedMs} ms), ${stats.triangles} triangles + ${stats.skirts} skirt, by distance ${stats.bands.join("/")}, ${Math.round(performance.now() - t0)} ms`);

  const t1 = performance.now();
  const landmarks = buildLandmarks(w);
  addLights(w, landmarks.beacons);
  console.info(`[griffith] vista landmarks: ${landmarks.triangles} triangles, ${landmarks.beacons.count} beacon / work lights, ${Math.round(performance.now() - t1)} ms`);

  const t2 = performance.now();
  const plants = buildPlants(w);
  console.info(`[griffith] vista plants: ${plants.trees} trees, ${plants.shrubs} shrubs, ${plants.triangles} triangles, ${Math.round(performance.now() - t2)} ms`);

  for (const set of cityLightSets()) addLights(w, set);
  console.info(`[griffith] vista lights: ${CITY_COUNTS.static} static, ${CITY_COUNTS.signals} signal heads, ${CITY_COUNTS.moving} moving`);
}
