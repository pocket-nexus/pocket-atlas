import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";

export async function createStage(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<Stage> {
  const { TokyoStage } = await import("./TokyoStage");
  return TokyoStage.create(ctx, place, progress);
}
