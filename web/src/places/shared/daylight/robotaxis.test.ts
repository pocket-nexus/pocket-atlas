import { expect, test } from "bun:test";
import { Box3, Mesh, Vector3 } from "three";
import { makeRobotaxi, ROBOTAXI_DIMENSIONS, type RobotaxiKind } from "./robotaxis";

for (const kind of Object.keys(ROBOTAXI_DIMENSIONS) as RobotaxiKind[]) {
  test(`${kind} exports finite bounded geometry and four independent road-contact wheels`, () => {
    const car = makeRobotaxi(kind), d = ROBOTAXI_DIMENSIONS[kind];
    expect(car.wheels.length).toBe(4);
    expect(car.wheels[0].position.z - car.wheels[2].position.z).toBeCloseTo(d.wheelbase, 6);
    expect(new Box3().setFromObject(car.root).min.y).toBeCloseTo(0, 5);
    const bounds = new Box3().setFromObject(car.root).getSize(new Vector3());
    expect(bounds.z).toBeLessThan(d.length + .12);
    expect(bounds.x).toBeLessThan(d.envelopeWidth + .01);
    expect(bounds.y).toBeGreaterThanOrEqual(d.height - .001);
    let triangles = 0;
    car.root.traverse(node => {
      if (!(node instanceof Mesh)) return;
      const p = node.geometry.getAttribute("position");
      expect([...p.array].every(Number.isFinite)).toBe(true);
      triangles += node.geometry.index!.count / 3;
      expect(node.geometry.index!.array.every((i: number) => i < p.count)).toBe(true);
    });
    expect(triangles).toBeLessThan(5000);
    expect(triangles).toBeGreaterThan(1000);
  });
}
