import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { createDefinedStage, definePlace } from "../shared/authoring";
import { LOOP } from "./world/layout";

export const definition = definePlace({
  id: "sf-lombard-street", kind: "daytime-slope", seed: 0,
  sampling: { startSeconds: 0, durationSeconds: LOOP, fps: 15 },
  async create(ctx, place, progress) {
    const { LombardStage } = await import("./LombardStage");
    return LombardStage.create(ctx, place, progress);
  },
});

export function createStage(ctx: StageContext, place: PlaceDef, progress: Progress) {
  return createDefinedStage(definition, ctx, place, progress);
}
