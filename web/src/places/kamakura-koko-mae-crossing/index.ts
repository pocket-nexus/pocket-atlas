import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { createDefinedStage, definePlace } from "../shared/authoring";

export const definition = definePlace({
  id: "kamakura-koko-mae-crossing", kind: "daytime-coast", seed: 0,
  sampling: { startSeconds: 0, durationSeconds: 120, fps: 15 },
  async create(ctx, place, progress) {
    const { KamakuraStage } = await import("./KamakuraStage");
    return KamakuraStage.create(ctx, place, progress);
  },
});

export function createStage(ctx: StageContext, place: PlaceDef, progress: Progress) {
  return createDefinedStage(definition, ctx, place, progress);
}
