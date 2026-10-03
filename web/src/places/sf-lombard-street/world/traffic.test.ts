import { expect, test } from "bun:test";
import { ROBOTAXI_DIMENSIONS } from "../../shared/daylight/robotaxis";
import { Vector3 } from "three";
import { laneEdge, LOOP, siteUV } from "./layout";
import { trafficPose, TRAFFIC_SPEED } from "./traffic";

test("downhill traffic repeats without a pose jump at the export seam", () => {
  for (const offset of [8, 68]) {
    const a = trafficPose(0, offset), b = trafficPose(LOOP, offset);
    expect(a.position.distanceTo(b.position)).toBeLessThan(1e-9);
    expect(a.forward.distanceTo(b.forward)).toBeLessThan(1e-9);
    expect(Math.abs(a.steer - b.steer)).toBeLessThan(1e-9);
  }
  expect(TRAFFIC_SPEED).toBeLessThan(2.2352); // Posted 5 mph limit.
});

test("the largest car footprint stays inside the tapered switchback curbs", () => {
  const edge = [
    ...Array.from({ length: 1001 }, (_, i) => laneEdge(i / 1000, 1)),
    ...Array.from({ length: 1001 }, (_, i) => laneEdge(1 - i / 1000, -1)),
  ];
  function inside(q: Vector3): boolean {
    let result = false;
    for (let i = 0, j = edge.length - 1; i < edge.length; j = i++) {
      const a = edge[i], b = edge[j];
      if ((a.z > q.z) !== (b.z > q.z)
        && q.x < (b.x - a.x) * (q.z - a.z) / (b.z - a.z) + a.x) result = !result;
    }
    return result;
  }
  let sampled = 0, outside = 0;
  for (let t = 0; t < 118; t += .125) {
    const pose = trafficPose(t, 0, ROBOTAXI_DIMENSIONS["waymo-ipace"].wheelbase), [u] = siteUV(pose.position.x, pose.position.z);
    if (u < 5 || u > 142) continue; // Cross-street ingress/egress lies beyond the ribbon.
    const right = new Vector3().crossVectors(new Vector3(0, 1, 0), pose.forward).normalize();
    for (const side of [-1, 1]) for (const end of [-1, 1]) {
      const corner = pose.position.clone().addScaledVector(pose.forward, end * (ROBOTAXI_DIMENSIONS["waymo-ipace"].length / 2))
        .addScaledVector(right, side * (ROBOTAXI_DIMENSIONS["waymo-ipace"].envelopeWidth / 2));
      sampled++;
      if (!inside(corner)) outside++;
    }
  }
  expect(sampled).toBeGreaterThan(2000);
  expect(outside).toBe(0);
});
