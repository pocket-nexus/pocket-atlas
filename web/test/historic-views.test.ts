import { expect, test } from "bun:test";
import { PerspectiveCamera } from "three";
import { PLACES } from "../src/places/registry";
import { CameraRig } from "../src/places/shared/camera";
import type { DayPlace } from "../src/places/shared/daylight/DayStage";

test("historic and waterfront named views retain their authored framing after entering free mode", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  try {
    for (const id of ["sf-fishermans-wharf", "shanghai-bund-1920", "hk-chungking-mansions-1990"]) {
      const loaded = await PLACES.find(p => p.id === id)!.load!();
      const spec = loaded.definition as unknown as DayPlace;
      const camera = new PerspectiveCamera();
      const rig = new CameraRig(camera, new EventTarget() as unknown as HTMLElement, spec.shots, spec.walkable, spec.focus);
      try {
        for (const shot of spec.shots) for (const view of [shot.from, shot.to]) {
          rig.goToKey(view);
          for (let frame = 0; frame < 60; frame++) rig.update(1 / 60, 25 + frame / 60);
          for (let axis = 0; axis < 3; axis++) {
            expect(camera.position.getComponent(axis)).toBeCloseTo(view.pos[axis], 5);
            expect(rig.target.getComponent(axis)).toBeCloseTo(view.target[axis], 5);
          }
          expect(camera.fov).toBe(view.fov);
        }
      } finally { rig.dispose(); }
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
