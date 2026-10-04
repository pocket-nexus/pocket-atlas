import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { createDefinedStage, definePlace } from "../shared/authoring";

export const definition = definePlace({
  id: "akihabara-radio-kaikan", kind: "dusk-street", seed: 0,
  sampling: { startSeconds: 0, durationSeconds: 20, fps: 15 },
  async create(ctx, place, progress) {
    const { AkibaStage } = await import("./AkibaStage");
    return AkibaStage.create(ctx, place, progress);
  },
});

export function createStage(ctx: StageContext, place: PlaceDef, progress: Progress) {
  return createDefinedStage(definition, ctx, place, progress);
}
