import { ObsLib } from "../gfx/observatory-materials";
import type { GriffithWorld } from "./context";
import { buildGrounds } from "./grounds";
import { buildBlock } from "./observatory/block";
import { buildDomes } from "./observatory/domes";
import { buildDrum } from "./observatory/drum";
import { Kits } from "./observatory/kit";
import { buildFloodlights } from "./observatory/lights";
import { buildPlanting, buildSite } from "./site";

/**
 * The observatory building, its terraces and domes, the front lawn and
 * grounds, and the site terrain inside `SITE` (area A). The building is
 * built at the LA County roof outline and the OSM / ortho positions
 * (`observatory/plan.ts`); floodlights are real lights the cooker bakes.
 */
export function buildObservatory(w: GriffithWorld): void {
  const lib = new ObsLib(w.baker, w.quality);
  lib.bakeAll();
  w.updaters.push((_dt, t) => {
    lib.time.value = t;
  });
  const K = new Kits();
  const { piers } = buildBlock(K, lib);
  const drum = buildDrum(K, lib);
  const domes = buildDomes(K, lib);
  buildFloodlights(w, lib, K, { piers, drum, domes });
  K.emit(w);
  buildGrounds(w, lib);
  buildSite(w, lib);
  buildPlanting(w, lib);
}
