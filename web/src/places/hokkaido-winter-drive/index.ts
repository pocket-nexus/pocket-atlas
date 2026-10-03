import type { PlaceDef,Progress,StageContext } from "../../core/types";
import { DriveStage } from "../shared/drive/DriveStage";
import type { DriveRoute } from "../shared/drive/types";
import route from "./data/route.json";
export const createStage=(ctx:StageContext,place:PlaceDef,progress:Progress)=>DriveStage.create(ctx,place,route as DriveRoute,progress);
