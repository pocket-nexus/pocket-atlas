import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";

export async function createStage(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<Stage> {
  const { AkibaStage } = await import("./AkibaStage");
  return AkibaStage.create(ctx, place, progress);
}
