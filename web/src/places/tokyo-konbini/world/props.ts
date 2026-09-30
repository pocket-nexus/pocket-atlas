import type { World } from "./context";
import { parkedCars } from "./props/car";
import { buildClutter, placeBicycles } from "./props/clutter";
import { buildPoles } from "./props/poles";
import { buildMirror, buildParking, buildStopSign } from "./props/signs";
import type { Kit } from "./props/util";
import { buildVending } from "./props/vending";

/** Street furniture: poles and cables, lamps, vending machines, bicycles, signs. */
export function buildProps(w: World): void {
  const kit: Kit = {
    draw: (key, pw, ph, paint) => w.atlas.shared(`props-${key}`, pw, ph, paint),
    labels: w.lib.sign(w.atlas.texture, 0.3, { key: "atlas-labels" }),
    lit: w.lib.sign(w.atlas.texture, 1.8, { key: "atlas-signs" }),
  };
  buildPoles(w, kit);
  buildVending(w, kit);
  placeBicycles(w);
  buildStopSign(w, kit);
  buildMirror(w);
  const lot = buildParking(w, kit);
  const [b1, , b3] = lot.bays;
  parkedCars(w, kit, [
    { ...b3, color: 0xdcdcd4, plate: "足立 330|さ|48-19" },
    { ...b1, color: 0x1d2a3c, plate: "練馬 500|ね|7-02" },
  ]);
  buildClutter(w, kit);
}
