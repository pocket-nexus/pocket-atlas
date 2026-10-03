import type { RailPass } from "./railway-motion";

/** Small procedural descriptions exported as scene extras; never recordings. */
export interface AudioRecipe {
  version: 1;
  loopSeconds: number;
  windGain: number;
  birds: { gain: number; first: number; interval: number; seed: number } | null;
  railway: {
    warning: number; raised: number; arrival: number; speed: number; length: number;
    visibleFrom: number; visibleUntil: number; origin: [number, number, number]; yaw: number;
    trainGain: number; bellGain: number;
  } | null;
}

/** Use the same pass and track frame as the visual train and warning lamps. */
export function railwayAudioRecipe(pass: RailPass, origin: [number, number, number], yaw: number): NonNullable<AudioRecipe["railway"]> {
  return {
    warning: pass.warning, raised: pass.raised, arrival: pass.arrival, speed: pass.speed, length: pass.length,
    visibleFrom: pass.visibleFrom, visibleUntil: pass.visibleUntil, origin, yaw, trainGain: 0.28, bellGain: 1,
  };
}
