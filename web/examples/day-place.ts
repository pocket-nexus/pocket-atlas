/** Synthetic teaching layout. Copy into src/places/<real-id>/; research the location before publishing. */
import { BoxGeometry, Vector3 } from "three";
import type { PlaceDef, Progress, StageContext } from "../src/core/types";
import { createDefinedStage, defineDayPlace } from "../src/places/shared/authoring";
import { source } from "../src/places/shared/provenance";

export const definition = defineDayPlace({
  id: "example-day-street", kind: "daytime-street", seed: 42,
  sampling: { startSeconds: 0, durationSeconds: 8, fps: 15 },
  resources: [], // For public/ files: { path: "textures/wall.png", sha256: "...64 hex..." }
  season: "summer",
  shots: [{ name: "Street", from: { pos: [5, 2, 8], target: [0, 1, 0], fov: 45 },
    to: { pos: [4, 2, 7], target: [0, 1, 0], fov: 45 }, duration: 8 }],
  walkable: [[-8, 0.3, -8, 8, 8, 8]], focus: [-8, 0, -8, 8, 8, 8],
  intro: { pos: [6, 4, 10], target: [0, 1, 0], fov: 45 }, introSeconds: 3,
  sunDirection: new Vector3(0.4, 0.8, 0.3).normalize(), sunIntensity: 7,
  sunCenter: [0, 0, 0], shadowBounds: [-10, -1, -10, 10, 8, 10],
  envPosition: [0, 2, 0], envIntensity: 0.9, fogDensity: 0.008,
  metadata: { example: true, note: "Synthetic layout, not a researched Atlas location" },
  async build(world, progress) {
    await progress(0.3, "Building the street");
    source("street/ground", world.mesh(new BoxGeometry(20, 0.2, 20), world.lib.plain(0x77756b), 0, -0.1, 0));
    source("street/building", world.mesh(new BoxGeometry(3, 4, 3), world.lib.plain(0xc9bd9e), -3, 2, -2));
    const sign = source("street/sign", world.mesh(new BoxGeometry(1, 0.6, 0.1), world.lib.plain(0xb25138), 0, 2, 0));
    sign.userData.dynamic = true;
    // An explicit function of sample time makes a seamless, replayable rigid-motion loop.
    world.updaters.push((_dt, t) => { sign.rotation.y = Math.sin(t * Math.PI * 2 / 8) * 0.2; });
  },
});

export function createStage(ctx: StageContext, place: PlaceDef, progress: Progress) {
  return createDefinedStage(definition, ctx, place, progress);
}
