import { expect, test } from "bun:test";
import { Box3, Mesh, Ray, Vector3 } from "three";
import { makeRobotaxi, ROBOTAXI_DIMENSIONS, ROBOTAXI_PROFILES, type RobotaxiKind } from "./robotaxis";
import { vehicleShell } from "./vehicle-shell";

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
    expect(triangles).toBeLessThan(kind === "waymo-ipace" ? 3900 : 2600);
    expect(triangles).toBeGreaterThan(1000);
  });
  test(`${kind} cabin and body form one closed outward-facing shell without overlapping glazing`, () => {
    const shell = vehicleShell(ROBOTAXI_PROFILES[kind]);
    const edges = new Map<string, number>(), faces: Vector3[][] = [];
    const key = (p: Vector3) => p.toArray().map(n => n.toFixed(6)).join(",");
    let volume = 0, glassFaces = 0;
    for (const [name, g] of Object.entries(shell)) {
      const p=g.getAttribute("position"),ix=g.index!;
      for (let i=0;i<ix.count;i+=3) {
        const vs=[0,1,2].map(j=>new Vector3().fromBufferAttribute(p,ix.getX(i+j)));
        const [a,b,c]=vs;
        expect(b.clone().sub(a).cross(c.clone().sub(a)).lengthSq()).toBeGreaterThan(1e-16);
        volume += a.dot(b.clone().cross(c))/6;
        for(let j=0;j<3;j++) {
          const edge=[key(vs[j]),key(vs[(j+1)%3])].sort().join("|");
          edges.set(edge,(edges.get(edge)??0)+1);
        }
        faces.push(vs);
        if (name === "glass") glassFaces++;
      }
    }
    // Weld by position across the material split. Every boundary is shared
    // by exactly two faces, including the old A/B-pillar-to-shoulder gap.
    expect([...edges.values()].every(n=>n===2)).toBe(true);
    expect(volume).toBeGreaterThan(3);
    expect(glassFaces).toBeGreaterThan(20);
    // The gradient includes both windscreen edges; falling back to side UVs
    // at the roof boundary creates a narrow reversed reflection stripe.
    const glassPosition = shell.glass.getAttribute("position"), glassUv = shell.glass.getAttribute("uv");
    for (const [edge, z] of ROBOTAXI_PROFILES[kind].windscreen.entries()) {
      let found = false;
      for (let i = 0; i < glassPosition.count; i++) {
        if (Math.abs(glassPosition.getX(i)) < 1e-6 && Math.abs(glassPosition.getZ(i) - z) < 1e-6) {
          expect(glassUv.getY(i)).toBeCloseTo(edge, 6); found = true;
        }
      }
      expect(found).toBe(true);
    }
    // Exterior rays must enter then exit the shell, never hit an opaque deck
    // behind a window. Pick off-grid rays so triangle diagonals cannot double-hit.
    for (const z of [-.71,.13,.81]) {
      const ray=new Ray(new Vector3(3,1.101,z),new Vector3(-1,0,0));
      const hits=faces.map(([a,b,c])=>ray.intersectTriangle(a,b,c,false,new Vector3())).filter(Boolean);
      expect(hits.length).toBe(2);
    }
    shell.paint.dispose();shell.glass.dispose();
  });
}
