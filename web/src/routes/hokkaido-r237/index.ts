import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";

export async function createStage(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<Stage> {
  const [{ RouteStage }, { ROUTE }] = await Promise.all([import("../shared/RouteStage"), import("./route")]);
  return RouteStage.create(ctx, place, ROUTE, progress);
}
