import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";

export async function createStage(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<Stage> {
  const { KamakuraStage } = await import("./KamakuraStage");
  return KamakuraStage.create(ctx, place, progress);
}
