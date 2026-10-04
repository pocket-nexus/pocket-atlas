import { CAMERAS } from "./cameras";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { createDefinedStage, definePlace } from "../shared/authoring";

export const definition = definePlace({
  id: "suga-shrine-stairs", kind: "daytime-slope", seed: 20160826,
  cameras: CAMERAS,
  sampling: { startSeconds: 0, durationSeconds: 1, fps: 15 },
  async create(ctx, place, progress) {
    const { SugaStage } = await import("./SugaStage");
    return SugaStage.create(ctx, place, progress);
  },
});

export function createStage(ctx: StageContext, place: PlaceDef, progress: Progress) {
  return createDefinedStage(definition, ctx, place, progress);
}
