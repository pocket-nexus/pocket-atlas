import { CAMERAS } from "./cameras";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { createDefinedStage, definePlace } from "../shared/authoring";

export const definition = definePlace({
  id: "tokyo-konbini", kind: "night-street", seed: 20240929,
  cameras: CAMERAS,
  sampling: { startSeconds: 0, durationSeconds: 20, fps: 15 },
  async create(ctx, place, progress) {
    const { TokyoStage } = await import("./TokyoStage");
    return TokyoStage.create(ctx, place, progress);
  },
});

export function createStage(ctx: StageContext, place: PlaceDef, progress: Progress) {
  return createDefinedStage(definition, ctx, place, progress);
}
