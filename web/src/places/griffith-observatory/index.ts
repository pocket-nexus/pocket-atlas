import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";

export async function createStage(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<Stage> {
  const { GriffithStage } = await import("./GriffithStage");
  return GriffithStage.create(ctx, place, progress);
}
