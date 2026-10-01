import { CircleGeometry, PlaneGeometry } from "three";
import { box } from "../../shared/geo";
import type { AkibaWorld } from "./context";
import { CHUO, CROSSINGS, KERB_H, ROAD_Y, STREET } from "./layout";

/** Horizontal rectangle [x0, x1] × [z0, z1] at height y, facing up. */
function slab(x0: number, x1: number, z0: number, z1: number): PlaneGeometry {
  const g = new PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
  return g;
}

/**
 * The street: asphalt carriageway 12 cm below two paver sidewalks with
 * granite kerbs, zebra crossings with tactile strips, the alleys beside
 * Radio Kaikan, the station plaza at the east end, and Chuo-dori across the
 * west end. Pavers and asphalt take world UVs (batchStatic), so separate
 * pieces line up.
 */
export function buildGround(w: AkibaWorld): void {
  const lib = w.lib;
  const pav = lib.pavers();
  const asp = lib.asphalt();
  const kerb = lib.granite([0.85, 0.85, 0.83]);
  const S = STREET;

  // Carriageway of this street and of Chuo-dori (one surface, same level).
  w.mesh(slab(CHUO.kerbEast, S.east + 0.5, S.northKerb, S.southKerb), asp, 0, ROAD_Y, 0);
  w.mesh(slab(CHUO.kerbWest, CHUO.kerbEast, -110, 90), asp, 0, ROAD_Y, 0);
  // Sidewalks: south (into the alleys and under Radio Kaikan's soffit), north (to the building line).
  w.mesh(slab(CHUO.lineEast, S.east, S.southKerb, 2.2), pav, 0, 0, 0);
  w.mesh(slab(CHUO.lineEast, S.east + 8, S.northLine - 0.6, S.northKerb), pav, 0, 0, 0);
  // Chuo-dori's sidewalks.
  w.mesh(slab(CHUO.kerbEast, CHUO.lineEast, -110, S.northKerb), pav, 0, 0, 0);
  w.mesh(slab(CHUO.kerbEast, CHUO.lineEast, S.southKerb, 90), pav, 0, 0, 0);
  w.mesh(slab(CHUO.lineWest - 1, CHUO.kerbWest, -110, 90), pav, 0, 0, 0);
  // Alleys along Radio Kaikan's east and west walls.
  w.mesh(slab(0, 3.9, 2.2, 50), pav, 0, 0, 0);
  w.mesh(slab(-28.7, -24, 2.2, 50), pav, 0, 0, 0);
  // Footway north under the Sobu Line viaduct, between Gamers and atre 1.
  w.mesh(slab(-20.7, -16.9, -64, S.northLine - 0.6), pav, 0, 0, 0);
  // Station plaza at the east end (Electric Town South exit) and the way south past namco.
  w.mesh(slab(S.east, 72, -34, S.northKerb), pav, 0, 0, 0);
  w.mesh(slab(S.east + 0.5, 72, S.northKerb, 60), pav, 0, 0, 0);

  // Granite kerbs (vertical faces show; tops flush with the sidewalk).
  const kerbRun = (x0: number, x1: number, z: number, side: 1 | -1) => {
    const len = x1 - x0;
    w.mesh(box(len, KERB_H + 0.02, 0.18), kerb, (x0 + x1) / 2, -KERB_H / 2 + 0.01, z + side * 0.09, w.root);
  };
  kerbRun(CHUO.kerbEast, S.east + 0.5, S.southKerb, 1);
  kerbRun(CHUO.kerbEast, S.east + 0.5, S.northKerb, -1);
  const kerbZ = (x: number, z0: number, z1: number, side: 1 | -1) => w.mesh(box(0.18, KERB_H + 0.02, z1 - z0), kerb, x + side * 0.09, -KERB_H / 2 + 0.01, (z0 + z1) / 2);
  kerbZ(CHUO.kerbEast, -110, S.northKerb, 1);
  kerbZ(CHUO.kerbEast, S.southKerb, 90, 1);
  kerbZ(CHUO.kerbWest, -110, 90, -1);
  kerbZ(S.east + 0.5, S.northKerb, S.southKerb, 1);

  // Zebra crossings: bars along the traffic direction, stacked across the street.
  const paint = lib.roadPaint();
  const zebra = (xc: number, width: number, z0: number, z1: number) => {
    for (let z = z0 + 0.3; z + 0.45 < z1 - 0.2; z += 0.9) w.mesh(slab(xc - width / 2, xc + width / 2, z, z + 0.45), paint, 0, ROAD_Y + 0.004, 0);
  };
  for (const c of CROSSINGS) zebra(c.x, c.w, S.northKerb, S.southKerb);
  zebra(-61.2, 3.6, S.northKerb, S.southKerb);
  // Chuo-dori's crossings north and south of the street mouth (bars along z).
  for (const zc of [27, -46]) {
    for (let x = CHUO.kerbWest + 0.4; x + 0.45 < CHUO.kerbEast - 0.2; x += 0.9) w.mesh(slab(x, x + 0.45, zc - 2.2, zc + 2.2), paint, 0, ROAD_Y + 0.004, 0);
  }

  // Tactile warning strips (yellow) at the crossing landings and the station exit.
  const tactile = lib.plain(0xd9a400, 0.6);
  for (const c of [...CROSSINGS, { x: -61.2, w: 3.6 }]) {
    w.mesh(slab(c.x - c.w / 2 + 0.3, c.x + c.w / 2 - 0.3, S.southKerb + 0.25, S.southKerb + 0.55), tactile, 0, 0.004, 0);
    w.mesh(slab(c.x - c.w / 2 + 0.3, c.x + c.w / 2 - 0.3, S.northKerb - 0.55, S.northKerb - 0.25), tactile, 0, 0.004, 0);
  }
  w.mesh(slab(36.5, 37.0, -18.6, -14.5), tactile, 0, 0.004, 0);

  // Manholes and utility lids.
  const lid = lib.plain(0x2a2b2c, 0.55, 0.6);
  const disc = new CircleGeometry(0.32, 20);
  disc.rotateX(-Math.PI / 2);
  for (const [x, z] of [[-34, -9.2], [-6, -8.4], [18, -9.6], [-50, -10.4]]) w.mesh(disc, lid, x, ROAD_Y + 0.003, z);
  for (const [x, z] of [[-14, -3.4], [12, -16.2], [-40, -2.6]]) w.mesh(box(0.6, 0.012, 0.6), lid, x, 0.006, z);
}
