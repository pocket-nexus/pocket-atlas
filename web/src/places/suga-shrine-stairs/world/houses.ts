import type { Material } from "three";
import { Rng } from "../../../core/random";
import type { SugaWorld } from "./context";
import { groundY, LANE, roadX, STAIRS } from "./layout";
import { house, houseKit, type HouseKit, type HouseSpec, type RoofKind } from "../../shared/daylight/houses";
export { house, houseKit, type HouseKit, type HouseSpec } from "../../shared/daylight/houses";

// ------------------------------------------------------------ the street

/** Hand-placed houses around the flight and along the lane; a procedural neighbourhood beyond. */
export function buildHouses(w: SugaWorld): void {
  const lib = w.lib;
  const k = houseKit(w);
  const S = {
    white: lib.siding(0xf2f0ea),
    cream: lib.siding(0xece2cc),
    grey: lib.siding(0xcdd1d1),
    beige: lib.siding(0xd9c6a8),
    brown: lib.siding(0x8f735c),
    stuccoW: lib.stucco(0xefece4),
    stuccoB: lib.stucco(0xe3d4b8),
    tile: lib.stucco(0x94604a),
    stuccoG: lib.stucco(0xb9bbb6),
    darkSiding: lib.siding(0x62676b),
    form: lib.formConcrete(),
  };
  const R = {
    grey: lib.sheetRoof(0x6b7073),
    dark: lib.sheetRoof(0x3e4346),
    brown: lib.sheetRoof(0x5c4638),
    blue: lib.tileRoof(0x2a4d91),
    silver: lib.tileRoof(0x6e7479),
    slab: lib.concrete([0.7, 0.7, 0.68], false),
  };
  const zb = STAIRS.bottomZ;
  const ly = LANE.y;
  let seed = 100;
  const H = (spec: Omit<HouseSpec, "seed">) => house(w, k, { ...spec, seed: seed++ });

  // Right of the stair head: bare concrete house whose side wall is the tall wall beside the flight.
  H({ x0: 2.12, x1: 9.4, z0: -4.5, z1: 0.9, base: 0, floors: 2, floorH: 3.0, wall: S.form, roof: { kind: "flat", mat: R.slab }, faces: { "+z": { door: true }, "-z": { balcony: 1 }, "+x": {} } });
  // Right, stepping down the flight.
  H({ x0: 2.3, x1: 9.2, z0: -10.35, z1: -4.85, base: -2.3, foot: -5.2, floors: 2, wall: S.white, roof: { kind: "gable", ridge: "z", mat: R.grey }, faces: { "-x": { dense: 2.2 }, "-z": { balcony: 1 }, "+z": { floors: [1] } } });
  H({ x0: 3.7, x1: 9.6, z0: -15.3, z1: -10.8, base: -5.2, foot: ly, floors: 2, wall: S.cream, roof: { kind: "hip", mat: R.blue, pitch: 0.45 }, faces: { "-x": { floors: [1] }, "-z": { balcony: 1 }, "+x": {} } });
  // Its single-storey lean-to toward the stairs under grey sheet metal.
  H({ x0: 2.3, x1: 3.7, z0: -15.0, z1: -11.1, base: -5.2, foot: ly, floors: 1, floorH: 2.5, wall: S.cream, roof: { kind: "shed", ridge: "z", mat: R.grey, pitch: 0.25, low: "-x" }, faces: { "-x": {} } });

  // Right side of the lane (facades face −x).
  H({ x0: 3.0, x1: 10.5, z0: -24.2, z1: -16.4, base: ly, floors: 3, floorH: 2.75, wall: S.white, roof: { kind: "flat", mat: R.slab }, faces: { "-x": { balcony: 2, door: true }, "+z": {}, "-z": { floors: [1, 2] } } });
  H({ x0: 3.4, x1: 11, z0: -31.8, z1: -24.9, base: ly, floors: 2, wall: S.stuccoB, roof: { kind: "gable", ridge: "z", mat: R.dark }, faces: { "-x": { door: true, balcony: 1 }, "-z": {} } });
  H({ x0: 3.1, x1: 10.5, z0: -39.6, z1: -32.4, base: ly, floors: 3, floorH: 2.7, wall: S.grey, roof: { kind: "shed", ridge: "z", mat: R.grey, pitch: 0.2, low: "+x" }, faces: { "-x": { balcony: 1 }, "+z": {} } });
  H({ x0: 3.4, x1: 11.5, z0: -48, z1: -40.3, base: ly, floors: 2, wall: S.white, roof: { kind: "gable", ridge: "x", mat: R.silver }, faces: { "-x": { door: true }, "+z": { balcony: 1 } } });
  H({ x0: 3.0, x1: 12, z0: -57.4, z1: -48.6, base: ly, floors: 4, floorH: 2.85, wall: S.stuccoB, roof: { kind: "flat", mat: R.slab }, faces: { "-x": { balcony: 2 }, "+z": { balcony: 3 }, "-z": {} } });
  H({ x0: 3.2, x1: 10.8, z0: -62.1, z1: -58.0, base: ly, floors: 2, wall: S.cream, roof: { kind: "gable", ridge: "x", mat: R.brown }, faces: { "-x": { door: true }, "-z": {} } });

  // Left side of the lane (facades face +x); the white block with solar panels first.
  H({ x0: -11.6, x1: -2.95, z0: -31.4, z1: -21.6, base: ly, floors: 3, floorH: 2.62, wall: S.stuccoW, roof: { kind: "flat", mat: R.slab }, solar: true, faces: { "+x": { door: true, balcony: 2 }, "-z": {}, "+z": { dense: 1.7 } } });
  H({ x0: -10.5, x1: -3.1, z0: -38.8, z1: -31.0, base: ly, floors: 2, wall: S.grey, roof: { kind: "gable", ridge: "z", mat: R.dark }, faces: { "+x": { door: true, balcony: 1 }, "-z": {} } });
  H({ x0: -11, x1: -3.0, z0: -47.5, z1: -39.4, base: ly, floors: 3, floorH: 2.8, wall: S.white, roof: { kind: "flat", mat: R.slab }, faces: { "+x": { balcony: 1 }, "+z": {}, "-z": {} } });
  H({ x0: -10.2, x1: -3.2, z0: -55.2, z1: -48.1, base: ly, floors: 2, wall: S.cream, roof: { kind: "hip", mat: R.silver }, faces: { "+x": { door: true }, "-z": { balcony: 1 } } });
  H({ x0: -12, x1: -3.0, z0: -62.1, z1: -55.8, base: ly, floors: 2, wall: S.brown, roof: { kind: "gable", ridge: "x", mat: R.grey }, faces: { "+x": {}, "-z": { door: true } } });

  // Across the plateau street, behind the stair head.
  H({ x0: 2.6, x1: 10.5, z0: 7.0, z1: 15.5, base: 0, floors: 2, wall: S.white, roof: { kind: "gable", ridge: "x", mat: R.dark }, faces: { "-z": { door: true }, "-x": {} } });
  H({ x0: 11.2, x1: 19, z0: 6.8, z1: 14.5, base: 0, floors: 3, wall: S.stuccoW, roof: { kind: "flat", mat: R.slab }, faces: { "-z": { balcony: 2 }, "-x": {} } });

  // Terraced lots right of the houses along the flight (seen across the roofs).
  const rightCols: [number, number][] = [
    [10.1, 17.4],
    [18.0, 25.6],
    [26.2, 34.5],
    [35.1, 43],
  ];
  const levels: [number, number, number][] = [
    [-4.4, 0.8, 0],
    [-10.3, -5.0, -2.3],
    [zb + 0.3, -10.9, -5.2],
  ];
  const walls = [S.white, S.cream, S.grey, S.stuccoW, S.beige, S.white];
  const roofs = [R.grey, R.dark, R.blue, R.silver, R.brown, R.grey];
  for (const [ci, [x0, x1]] of rightCols.entries()) {
    for (const [li, [z0, z1, base]] of levels.entries()) {
      const r = new Rng(900 + ci * 7 + li);
      const kind = r.pick(["gable", "hip", "gable", "flat"] as RoofKind[]);
      H({
        x0: x0 + r.range(0, 0.4),
        x1: x1 - r.range(0, 0.4),
        z0: z0 + r.range(0, 0.3),
        z1: z1 - r.range(0, 0.3),
        base,
        foot: base - 0.4,
        floors: r.int(2, 3),
        wall: r.pick(walls),
        roof: { kind, mat: kind === "flat" ? R.slab : r.pick(roofs), ridge: r.chance(0.5) ? "x" : "z" },
        faces: { "-z": { balcony: 1 }, "-x": {}, "+z": {} },
        detail: ci < 2 ? "near" : "mid",
      });
    }
  }
  // Lots left of the terrace.
  const leftLevels: [number, number, number][] = [
    [-6.2, 0.9, 0.2],
    [-12.7, -6.8, -2.2],
    [-19.5, -13.3, -4.6],
  ];
  for (const [ci, [x0, x1]] of [
    [-25.5, -17],
    [-34, -26.2],
    [-43, -34.8],
  ].entries()) {
    for (const [li, [z0, z1, base]] of leftLevels.entries()) {
      const r = new Rng(700 + ci * 5 + li);
      const kind = r.pick(["gable", "hip", "flat", "gable"] as RoofKind[]);
      H({
        x0,
        x1,
        z0,
        z1,
        base,
        floors: r.int(2, 3),
        wall: r.pick(walls),
        roof: { kind, mat: kind === "flat" ? R.slab : r.pick(roofs), ridge: r.chance(0.5) ? "x" : "z" },
        faces: { "-z": { balcony: 1 }, "+x": {} },
        detail: ci === 0 ? "near" : "mid",
      });
    }
  }

  buildNeighbourhood(w, k, S, R);
}

/**
 * Procedural blocks of 2–4 storey houses and small apartment buildings on the
 * valley floor and up the far slope toward the ridge, leaving the lane, the
 * junction and 東福院坂 open.
 */
function buildNeighbourhood(w: SugaWorld, k: HouseKit, S: Record<string, Material>, R: Record<string, Material>): void {
  const r = new Rng(4242);
  const walls = [S.white, S.cream, S.grey, S.stuccoB, S.beige, S.brown, S.darkSiding, S.cream, S.grey, S.stuccoG, S.stuccoB, S.tile];
  const roofs = [R.grey, R.dark, R.grey, R.silver, R.brown, R.blue];
  let seed = 5000;
  const taken: [number, number, number, number][] = [
    [-12.5, 12.5, -63, -15],
    [-62, 62, -20.5, 20],
  ];
  const free = (x0: number, x1: number, z0: number, z1: number) => !taken.some(([a0, a1, b0, b1]) => x0 < a1 && x1 > a0 && z0 < b1 && z1 > b0);
  for (let z = -18; z > -265; ) {
    const depth = r.range(8, 12);
    for (let x = -150; x < 150; ) {
      const width = r.range(6.5, 11);
      const x0 = x + r.range(0.3, 1.0);
      const x1 = x + width - r.range(0.3, 1.0);
      const z1 = z - r.range(0.3, 1.2);
      const z0 = z - depth + r.range(0.3, 1.2);
      x += width;
      // Roads: 東福院坂, the crossing road at the junction, and a grid of alleys.
      const rc = roadX((z0 + z1) / 2);
      const road = (x0 < rc + 3.6 && x1 > rc - 3.6) || (z1 > -71.5 && z0 < -61.5) || Math.abs(((x0 + x1) / 2) % 38) < 2.2;
      if (road || !free(x0, x1, z0, z1)) continue;
      const base = Math.min(groundY(z0), groundY(z1));
      const tall = r.chance(0.12);
      const floors = tall ? r.int(4, 6) : r.int(2, 3);
      const kind: RoofKind = tall ? "flat" : r.pick(["gable", "gable", "hip", "flat", "shed"]);
      const dist = Math.hypot((x0 + x1) / 2, (z0 + z1) / 2);
      house(w, k, {
        x0,
        x1,
        z0,
        z1,
        base,
        foot: base - 1.5,
        floors,
        floorH: tall ? 2.9 : 2.8,
        wall: tall ? r.pick([S.stuccoB, S.stuccoW, S.white, S.tile, S.tile]) : r.pick(walls),
        roof: { kind, mat: kind === "flat" ? R.slab : r.pick(roofs), ridge: r.chance(0.5) ? "x" : "z", pitch: kind === "shed" ? r.range(0.1, 0.18) : r.range(0.3, 0.5) },
        faces: dist < 110 ? { "+z": { balcony: floors > 1 && r.chance(0.7) ? 1 : undefined, dense: 1.4 }, "-x": { dense: 1.3 }, "+x": { dense: 1.3 } } : { "+z": { balcony: floors > 2 ? floors - 1 : undefined, dense: 1.4 } },
        detail: "mid",
        seed: seed++,
      });
    }
    z -= depth + (r.chance(0.3) ? 3.5 : 0.6);
  }
}
