import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";
export async function createStage(ctx:StageContext,place:PlaceDef,progress:Progress):Promise<Stage>{
  const {LombardStage}=await import('./LombardStage');return LombardStage.create(ctx,place,progress);
}
