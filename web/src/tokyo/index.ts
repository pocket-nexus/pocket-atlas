import type { CityDef, Progress, Stage, StageContext } from "../core/types";

export async function createStage(ctx: StageContext, city: CityDef, progress: Progress): Promise<Stage> {
  const { TokyoStage } = await import("./TokyoStage");
  return TokyoStage.create(ctx, city, progress);
}
