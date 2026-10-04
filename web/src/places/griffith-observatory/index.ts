import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { createDefinedStage, definePlace } from "../shared/authoring";

export const definition = definePlace({
  id: "griffith-observatory", kind: "dusk-vista", seed: 0,
  sampling: { startSeconds: 0, durationSeconds: 120, fps: 15 },
  async create(ctx, place, progress) {
    const { GriffithStage } = await import("./GriffithStage");
    return GriffithStage.create(ctx, place, progress);
  },
});

export function createStage(ctx: StageContext, place: PlaceDef, progress: Progress) {
  return createDefinedStage(definition, ctx, place, progress);
}
