import { commuter, CAR_PITCH, WHEEL_RADIUS, type CommuterSpec } from "../shared/daylight/commuter";
import type { DayWorld } from "../shared/daylight/context";
import { railState, type RailPass } from "../shared/railway-motion";

/** Photo-based 1081 eight-car formation; a historical impression, not a current fleet claim. */
export const FORMATION: CommuterSpec = {
  stripe: 0x1686b2, destination: "新宿", service: "各停", destinationLatin: "SHINJUKU", serviceLatin: "LOCAL",
  cars: [
    { number: "1081", cab: "front" }, { number: "1031", motor: true, pantograph: true },
    { number: "1131", motor: true }, { number: "1181" },
    { number: "1331", motor: true, pantograph: true }, { number: "1381" },
    { number: "1431", motor: true }, { number: "1481", cab: "rear" },
  ],
};
export const PASS: RailPass = {
  period: 64, arrival: 18, speed: 10.5, length: FORMATION.cars.length * CAR_PITCH,
  warning: 3, lower: 6, lowered: 10, release: 34, raised: 39,
  visibleFrom: 3, visibleUntil: 48,
};
export const RAIL_YAW = -Math.atan(0.105);

export function buildPassingTrain(w: DayWorld): void {
  const track = w.group(0, 0.102, 0, RAIL_YAW);
  const { root, wheels } = commuter(w, FORMATION);
  track.add(root);
  root.position.set(-200, -1000, 1.82);
  let wasNear = false, previousTime = NaN;
  w.update((_dt, t) => {
    const state = railState(PASS, t);
    root.position.set(state.front, state.visible ? 0 : -1000, 1.82);
    // A rotated rear cab uses the opposite axle rotation for the same travel direction.
    for (const axle of wheels) axle.rotation.z = -state.front / WHEEL_RADIUS * (axle.parent?.rotation.y ? -1 : 1);
    const near = state.visible && state.front > -45 && state.tail < 45;
    if ((near || wasNear) && t !== previousTime) w.shadowsDirty = true;
    wasNear = near; previousTime = t;
  });
}
