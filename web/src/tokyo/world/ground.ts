import { CircleGeometry, MeshStandardMaterial, PlaneGeometry, Vector2, type Texture } from "three";
import type { Baker } from "../gfx/bake";
import { roadText, toTexture } from "../gfx/canvas";
import { box } from "../gfx/geo";
import { makeWet } from "../gfx/wet";
import type { World } from "./context";
import { L } from "./layout";

/** Horizontal rectangle on y = h (x0..x1, z0..z1). */
function flat(x0: number, x1: number, z0: number, z1: number): PlaneGeometry {
  const g = new PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
  return g;
}

export function bakePuddles(baker: Baker): Texture {
  return baker.bake(
    512,
    512,
    /* glsl */ `
      float a = fbm(vUv * 4.0, vec2(4.0), 6);
      float b = fbm(vUv * 9.0 + 3.0, vec2(9.0), 5);
      outColor = vec4(a, b, 0.0, 1.0);`,
  );
}

function manholeTexture(baker: Baker): { map: Texture; normalMap: Texture } {
  const header = /* glsl */ `
    float pattern(vec2 uv) {
      vec2 p = uv * 2.0 - 1.0;
      float r = length(p);
      float a = atan(p.y, p.x);
      float rim = smoothstep(0.98, 0.95, r) * (1.0 - smoothstep(0.9, 0.87, r));
      // hexagonal studs + a sakura-ish rosette, a nod to municipal manhole art
      vec2 q = p * 9.0;
      q.x += mod(floor(q.y), 2.0) * 0.5;
      float stud = smoothstep(0.32, 0.26, length(fract(q) - 0.5)) * step(r, 0.62);
      float petals = smoothstep(0.02, 0.0, abs(r - 0.34 - 0.08 * cos(a * 5.0)) - 0.035);
      float ring = smoothstep(0.02, 0.0, abs(r - 0.72) - 0.03) + smoothstep(0.02, 0.0, abs(r - 0.8) - 0.012);
      float spokes = smoothstep(0.03, 0.0, abs(sin(a * 12.0)) * r - 0.02) * step(0.64, r) * step(r, 0.86);
      return clamp(rim + stud * 0.7 + petals + ring + spokes, 0.0, 1.0);
    }`;
  const map = baker.bake(
    512,
    512,
    /* glsl */ `
      float h = pattern(vUv);
      float n = fbm(vUv * 12.0, vec2(12.0), 4);
      vec3 c = mix(vec3(0.05, 0.05, 0.055), vec3(0.16, 0.15, 0.14), h) * (0.8 + 0.4 * n);
      c = mix(c, vec3(0.18, 0.09, 0.04), smoothstep(0.7, 0.85, fbm(vUv * 6.0 + 2.0, vec2(6.0), 4)) * 0.6);
      outColor = vec4(c, 1.0);`,
    { srgb: true, header, repeat: false },
  );
  const normalMap = baker.bake(
    512,
    512,
    /* glsl */ `
      vec2 e = 1.0 / uRes;
      float l = pattern(vUv - vec2(e.x, 0.0)), r = pattern(vUv + vec2(e.x, 0.0));
      float d = pattern(vUv - vec2(0.0, e.y)), u = pattern(vUv + vec2(0.0, e.y));
      vec3 n = normalize(vec3((l - r) * 2.0, (d - u) * 2.0, 1.0));
      outColor = vec4(n * 0.5 + 0.5, 1.0);`,
    { header, repeat: false },
  );
  return { map, normalMap };
}

export function buildGround(w: World, baker: Baker): void {
  const lib = w.lib;
  const E = L.extent;
  const road = lib.road();

  // Asphalt: main street, the intersection, and the cross street both ways.
  const asphalt = [
    flat(-E, E, L.mainNorth, L.mainSouth),
    flat(L.crossWest, L.crossEast, -E, L.mainNorth),
    flat(L.crossWest, L.crossEast, L.mainSouth, E),
  ];
  for (const g of asphalt) w.mesh(g, road, 0, 0, 0, w.root, { cast: false });
  // Concrete apron under every building line (recessed shopfronts stand on it).
  w.mesh(flat(-E, E, -E, E), lib.curb(), 0, -0.03, 0, w.root, { cast: false });
  // Far ground so street vistas never end at an edge (the haze hides detail).
  w.mesh(flat(-900, 900, -900, 900), lib.plain(0x08080a, 0.6), 0, -0.08, 0, w.root, { cast: false, receive: false });

  // Paved forecourt and the strip along the shop's east side.
  const pavers = lib.pavers();
  w.mesh(flat(L.apron.x0, L.apron.x1, L.apron.z0, L.apron.z1), pavers, 0, 0.004, 0, w.root, { cast: false });
  w.mesh(flat(L.konbini.x1, L.crossWest, L.konbini.z0 - 30, L.apron.z0), pavers, 0, 0.004, 0, w.root, { cast: false });
  // Alley floor.
  const alleyMat = lib.curb();
  w.mesh(flat(L.alley.x0, L.alley.x1, L.konbini.z0, L.mainNorth), alleyMat, 0, 0.003, 0, w.root, { cast: false });

  // Side-ditch covers (側溝): concrete slabs with a steel grate every few meters.
  const slab = lib.curb();
  const grate = makeWet(
    new MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.4, metalness: 0.9 }),
    lib.wet,
    { puddles: 0, darken: 0.9, roughness: 0.7, planar: true },
  );
  const ditch = (x0: number, x1: number, z: number) => {
    for (let x = x0; x < x1 - 0.5; x += 1.0) {
      const isGrate = Math.round(x) % 5 === 0;
      w.mesh(box(0.98, 0.03, 0.42), isGrate ? grate : slab, x + 0.5, 0.0, z, w.root, { cast: false });
      if (isGrate) {
        for (let s = -0.4; s <= 0.4; s += 0.08) w.mesh(box(0.035, 0.035, 0.36), slab, x + 0.5 + s, 0.0, z, w.root, { cast: false });
      }
    }
  };
  ditch(-E, L.alley.x0, L.mainNorth + 0.21);
  ditch(-E, L.crossWest, L.mainSouth - 0.21);
  ditch(L.crossEast, E, L.mainSouth - 0.21);
  ditch(L.crossEast + 9, E, L.mainNorth + 0.21);

  // ------------------------------------------------------------- markings
  const paint = lib.roadPaint();
  const line = (x0: number, x1: number, z0: number, z1: number) =>
    w.mesh(flat(x0, x1, z0, z1), paint, 0, 0.006, 0, w.root, { cast: false });

  // Edge lines along the main street (broken by the intersection and crosswalk).
  line(-E, 4.3, L.edgeNorth - 0.075, L.edgeNorth + 0.075);
  line(-E, 4.3, L.edgeSouth - 0.075, L.edgeSouth + 0.075);
  line(L.crossEast + 0.4, E, L.edgeNorth - 0.075, L.edgeNorth + 0.075);
  line(L.crossEast + 0.4, E, L.edgeSouth - 0.075, L.edgeSouth + 0.075);
  // Cross street edge lines.
  line(L.crossWest + 0.55, L.crossWest + 0.7, -E, -4.4);
  line(L.crossEast - 0.7, L.crossEast - 0.55, -E, -4.4);
  line(L.crossWest + 0.55, L.crossWest + 0.7, L.mainSouth + 0.4, E);
  line(L.crossEast - 0.7, L.crossEast - 0.55, L.mainSouth + 0.4, E);

  // Green pedestrian belt on the south side.
  const green = makeWet(new MeshStandardMaterial({ color: 0x1f6b3a, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), lib.wet, {
    puddles: 0.3,
    darken: 0.7,
    roughness: 0.55,
    planar: true,
  });
  w.mesh(flat(-E, 4.3, L.edgeSouth + 0.1, L.mainSouth - 0.45), green, 0, 0.005, 0, w.root, { cast: false });
  w.mesh(flat(L.crossEast + 0.4, E, L.edgeSouth + 0.1, L.mainSouth - 0.45), green, 0, 0.005, 0, w.root, { cast: false });

  // Zebra crossing over the main street, west of the intersection.
  for (let z = L.mainNorth + 0.35; z < L.mainSouth - 0.5; z += 0.9) line(4.6, 6.6, z, z + 0.45);
  // Zebra crossing over the cross street, north of the intersection.
  for (let x = L.crossWest + 0.3; x < L.crossEast - 0.4; x += 0.9) line(x, x + 0.45, -3.6, -1.5);
  // Stop line + 止まれ for southbound traffic on the cross street.
  line(L.crossWest + 0.7, 10.0, -4.4, -4.1);
  const stopTex = toTexture(roadText("止まれ"));
  const stencil = lib.roadStencil(stopTex);
  const sg = new PlaneGeometry(2.1, 4.2);
  sg.rotateZ(Math.PI); // text baseline faces the approaching (southbound) driver
  sg.rotateX(-Math.PI / 2);
  w.mesh(sg, stencil, 8.55, 0.007, -7.2, w.root, { cast: false });

  // Tactile warning blocks at the kerbless crossing ends.
  const tactile = lib.tactile();
  w.mesh(flat(4.6, 6.6, -1.6, -1.3), tactile, 0, 0.008, 0, w.root, { cast: false });
  w.mesh(flat(L.crossWest - 0.5, L.crossWest - 0.2, -3.6, -1.5), tactile, 0, 0.008, 0, w.root, { cast: false });

  // Manholes.
  const mh = manholeTexture(baker);
  const mhMat = makeWet(
    new MeshStandardMaterial({ map: mh.map, normalMap: mh.normalMap, normalScale: new Vector2(1.6, 1.6), roughness: 0.35, metalness: 0.75 }),
    lib.wet,
    { puddles: 0.1, darken: 0.85, roughness: 0.6, planar: true },
  );
  const disk = new CircleGeometry(0.33, 48);
  disk.rotateX(-Math.PI / 2);
  for (const [x, z] of [
    [-2.2, 3.4],
    [10.1, -9.5],
    [22.5, 2.6],
    [-19.5, 3.1],
  ]) {
    w.mesh(disk, mhMat, x, 0.009, z, w.root, { cast: false });
  }
}
