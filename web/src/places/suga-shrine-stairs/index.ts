import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";

export async function createStage(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<Stage> {
  const { SugaStage } = await import("./SugaStage");
  return SugaStage.create(ctx, place, progress);
}
