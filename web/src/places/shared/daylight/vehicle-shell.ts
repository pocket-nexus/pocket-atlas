import { BufferGeometry, Float32BufferAttribute } from "three";

export type VehicleSection = readonly [z: number, width: number, sill: number, belt: number, crown: number, roofWidth: number];
export interface VehicleShellProfile {
  sections: readonly VehicleSection[];
  wheelbase: number;
  wheelRadius: number;
  /** Exact longitudinal boundaries are sampled, including narrow pillar strips. */
  sideWindows: readonly (readonly [number, number])[];
  windscreen: readonly [number, number];
  rearWindow?: readonly [number, number];
}
type Point = [number, number, number];

/** Shape-preserving Hermite interpolation: rounded longitudinal lines without
 * overshooting a surveyed envelope or shrinking a wheel opening. */
function sectionValue(sections: readonly VehicleSection[], z: number, component: number): number {
  let i = sections.findIndex(p => p[0] > z) - 1;
  if (i < 0) i = z <= sections[0][0] ? 0 : sections.length - 2;
  const a = sections[i], b = sections[i + 1], h = b[0] - a[0];
  const slope = (j: number) => (sections[j + 1][component] - sections[j][component]) / (sections[j + 1][0] - sections[j][0]);
  const tangent = (j: number) => {
    if (j === 0) return slope(0);
    if (j === sections.length - 1) return slope(j - 1);
    const l = slope(j - 1), r = slope(j);
    return l * r <= 0 ? 0 : 2 * l * r / (l + r);
  };
  const t = Math.max(0, Math.min(1, (z - a[0]) / h)), t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a[component] + (t3 - 2 * t2 + t) * h * tangent(i)
    + (-2 * t3 + 3 * t2) * b[component] + (t3 - t2) * h * tangent(i + 1);
}

/** A continuous exterior, including pillars and glazing. All material regions
 * reference the same sampled boundary; there is no separate floating cabin or
 * opaque deck under its windows. Shared indexed normals soften body highlights
 * without increasing tessellation or introducing a runtime subdivision pass. */
export function vehicleShell(profile: VehicleShellProfile): { paint: BufferGeometry; glass: BufferGeometry } {
  const { sections, wheelRadius: r, wheelbase: wb } = profile;
  const tail = sections[0][0], nose = sections.at(-1)![0];
  const stations = new Set<number>(sections.map(p => p[0]));
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i][0], b = sections[i + 1][0];
    if (b - a > .38) stations.add((a + b) * .5);
  }
  for (const range of [...profile.sideWindows, profile.windscreen, ...(profile.rearWindow ? [profile.rearWindow] : [])])
    for (const z of range) stations.add(z);
  // Angular sampling retains the circular arch with fewer points than uniform Z.
  for (const wheel of [-wb / 2, wb / 2]) for (let i = 0; i <= 8; i++)
    stations.add(wheel + Math.cos(i * Math.PI / 8) * r * 1.075);
  const zs = [...new Set([...stations].map(z => Math.round(z * 1e6) / 1e6))]
    .filter(z => z >= tail && z <= nose).sort((a, b) => a - b);
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [], glazed: boolean[] = [];
  const rings: Point[][] = [];
  const inside = (z: number, range: readonly [number, number]) => z > range[0] && z < range[1];
  for (const z of zs) {
    const width = sectionValue(sections, z, 1), sill = sectionValue(sections, z, 2);
    const belt = sectionValue(sections, z, 3), crown = sectionValue(sections, z, 4);
    const roofWidth = sectionValue(sections, z, 5);
    let bottom = sill;
    for (const wheel of [-wb / 2, wb / 2]) {
      const dz = z - wheel, radius = r * 1.075;
      if (Math.abs(dz) < radius) bottom = Math.max(bottom, r + Math.sqrt(radius * radius - dz * dz));
    }
    const depth = belt - bottom;
    const base: Point = [width * .925, belt, z];
    const roof: Point = [roofWidth, Math.max(belt + .006, crown - .034), z];
    const pane = (t: number): Point => [base[0] + (roof[0] - base[0]) * t, base[1] + (roof[1] - base[1]) * t, z];
    const right: Point[] = [
      [width * .72, bottom - .045, z], [width * .93, bottom, z],
      [width * .982, bottom + depth * .30, z], [width, bottom + depth * .79, z],
      [width * .992, belt - depth * .055, z], base,
      pane(.07), pane(.93), roof,
      [roofWidth * .67, crown - .008, z], [0, crown, z],
    ];
    const ring = [...right, ...right.slice(0, -1).reverse().map(([x,y,z]): Point => [-x,y,z])];
    rings.push(ring);
    for (let j = 0; j < ring.length; j++) {
      positions.push(...ring[j]);
      // Reflection gradient is continuous along the glass, with vertical UVs.
      const range = z >= profile.windscreen[0] && z <= profile.windscreen[1] ? profile.windscreen : profile.rearWindow;
      if (j >= 8 && j <= 12 && range && z >= range[0] && z <= range[1])
        uvs.push(.5 + ring[j][0] / (2 * roofWidth), (z - range[0]) / (range[1] - range[0]));
      else {
        const band = j <= 10 ? j : 20 - j;
        uvs.push((z - tail) / (nose - tail), band === 6 ? .07 : band === 7 ? .93 : band < 6 ? 0 : 1);
      }
    }
  }
  const stride = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    const z = (zs[i] + zs[i + 1]) / 2;
    for (let j = 0; j < stride; j++) {
      const a = i * stride + j, b = i * stride + (j + 1) % stride;
      const c = b + stride, d = a + stride;
      const side = (j === 6 || j === 13) && profile.sideWindows.some(range => inside(z, range));
      const top = j >= 8 && j <= 11 && (inside(z, profile.windscreen) || !!profile.rearWindow && inside(z, profile.rearWindow));
      indices.push(a, b, c, a, c, d); glazed.push(side || top, side || top);
    }
  }
  // End caps share their boundary. Separate normals preserve the bumper edge.
  for (const [row, front] of [[0,false], [rings.length-1,true]] as const) {
    const ring = rings[row], offset = positions.length / 3;
    positions.push(0, (ring[0][1] + ring[10][1]) * .5, zs[row]); uvs.push(.5,.5);
    for (const p of ring) { positions.push(...p); uvs.push(0,0); }
    for (let j = 0; j < stride; j++) {
      const a = offset + 1 + j, b = offset + 1 + (j + 1) % stride;
      indices.push(...(front ? [offset,a,b] : [offset,b,a])); glazed.push(false);
    }
  }
  const whole = new BufferGeometry();
  whole.setAttribute("position", new Float32BufferAttribute(positions,3));
  whole.setAttribute("uv", new Float32BufferAttribute(uvs,2));
  whole.setIndex(indices); whole.computeVertexNormals();
  const extract = (glass: boolean) => {
    const remap = new Map<number,number>(), p: number[] = [], n: number[] = [], uv: number[] = [], ix: number[] = [];
    const normals = whole.getAttribute("normal");
    for (let i = 0; i < indices.length; i++) {
      if (glazed[Math.floor(i/3)] !== glass) continue;
      const source = indices[i]; let target = remap.get(source);
      if (target === undefined) {
        target = remap.size; remap.set(source,target);
        p.push(...positions.slice(source*3,source*3+3));
        n.push(normals.getX(source),normals.getY(source),normals.getZ(source));
        uv.push(...uvs.slice(source*2,source*2+2));
      }
      ix.push(target);
    }
    const g = new BufferGeometry(); g.setAttribute("position",new Float32BufferAttribute(p,3));
    g.setAttribute("normal",new Float32BufferAttribute(n,3)); g.setAttribute("uv",new Float32BufferAttribute(uv,2));g.setIndex(ix);
    return g;
  };
  const result = { paint: extract(false), glass: extract(true) }; whole.dispose(); return result;
}
