import { BufferGeometry, CylinderGeometry, Float32BufferAttribute, SphereGeometry, Vector3 } from "three";
import { merge } from "../../shared/shapes";
import type { KamakuraWorld } from "./context";
import { bearing, VIEW } from "./layout";

/**
 * The coast in the haze, as low-poly land the fog greys out with distance:
 * Inamuragasaki (105.8°, 2.5 km), the Miura peninsula from Zushi (102°,
 * 7 km) past Hayama and Ōkusu-yama (125°, 9.5–13 km) to Jogashima (152°,
 * 22 km), the hills behind Shichirigahama and the school, Koshigoe and the
 * Shonan shore to the west, Enoshima (248.5°, 2.2 km) with the Sea Candle.
 * Heights come from the angles above the horizon measured from the
 * canonical eye (sun-landmarks.txt), so silhouettes sit where they appear in
 * the photographs although the world here is flat. Fuji, Hakone, Izu and
 * Ōshima are hidden in the July haze and not modelled.
 */

const EYE = new Vector3(VIEW.crossing.x, 6.8, VIEW.crossing.z);

/** Ground point at a bearing and distance (km) from the canonical eye, at the height that subtends `elev`° there. */
function at(az: number, km: number, elev: number): Vector3 {
  const d = bearing(az).multiplyScalar(km * 1000);
  return new Vector3(EYE.x + d.x, EYE.y + km * 1000 * Math.tan((elev * Math.PI) / 180), EYE.z + d.z);
}

/** A curtain from a ridgeline down below the sea, leaning back so the sun lights it. */
function curtain(ridge: Vector3[], foot = -40, lean = 0.35): BufferGeometry {
  const pos: number[] = [];
  for (let i = 0; i < ridge.length - 1; i++) {
    const a = ridge[i];
    const b = ridge[i + 1];
    // Base points pushed toward the eye so the face slopes back like a hillside.
    const toward = (p: Vector3) => {
      const d = EYE.clone().sub(p).setY(0).normalize();
      return p.clone().addScaledVector(d, (p.y - foot) / lean).setY(foot);
    };
    const a0 = toward(a);
    const b0 = toward(b);
    // Facing the eye: order so the normal points toward it.
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(a0, a));
    const toEye = EYE.clone().sub(a);
    const q = n.dot(toEye) > 0 ? [a, b, a0, b, b0, a0] : [a, a0, b, b, a0, b0];
    for (const p of q) pos.push(p.x, p.y, p.z);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function buildFar(w: KamakuraWorld): void {
  const lib = w.lib;
  const forest = lib.farLand("forest");
  const town = lib.farLand("town");
  const land: BufferGeometry[] = [];
  const towns: BufferGeometry[] = [];

  // Miura peninsula: the near coastal hills, then the inland ridge with Ōkusu-yama behind.
  // (Few, long segments: on the handheld each far 256 m chunk a triangle lands in is a draw.)
  land.push(curtain([at(97.5, 6.2, 0.36), at(102.4, 7.05, 0.65), at(112, 8.2, 0.55), at(125.2, 9.55, 0.76), at(136, 12.2, 0.32), at(151.6, 21.65, -0.03)], -30, 0.25));
  // Inamuragasaki: a wooded headland, and the shore hills between it and the modelled hillside.
  {
    const c = at(105.8, 2.49, 0.0);
    const head = new SphereGeometry(1, 7, 2, 0, Math.PI * 2, 0, Math.PI / 2);
    head.scale(230, 26, 170);
    head.translate(c.x, -10, c.z);
    land.push(head);
  }
  // The wooded hillside east above Shichirigahama, beyond the modelled slope, running out to Inamuragasaki.
  land.push(curtain([at(52, 0.62, 4.2), at(76, 0.9, 2.9), at(96, 1.9, 1.3), at(104, 2.5, 0.45)], -8, 0.6));
  // The ridge behind Kamakura High School and the hills along the coast both ways (behind the modelled slope).
  land.push(curtain([at(300, 0.9, 3.8), at(335, 0.65, 5.4), at(10, 0.6, 5.7), at(45, 0.9, 3.9), at(80, 1.55, 2.2)], -5, 0.6));
  // Koshigoe and the hills toward Enoshima; the Shonan shore beyond, low and grey.
  land.push(curtain([at(262, 0.9, 2.2), at(280, 1.0, 3.2), at(300, 0.9, 3.8)], -5, 0.6));
  towns.push(curtain([at(254, 1.35, 0.2), at(262, 7, 0.1), at(276, 18, 0.06)], -20, 0.3));
  // Enoshima: the wooded island and the Sea Candle (top 119.6 m T.P.).
  {
    const c = at(248.5, 2.18, 0);
    const isle = new SphereGeometry(1, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    isle.scale(320, 70, 230);
    isle.translate(c.x, -12, c.z);
    land.push(isle);
    const t = at(248.7, 2.07, 0);
    const shaft = new CylinderGeometry(3.5, 4.5, 58, 8, 1, true);
    shaft.translate(t.x, 48 + 29, t.z);
    const deck = new CylinderGeometry(8, 7, 7, 10);
    deck.translate(t.x, 48 + 54, t.z);
    w.mesh(w.tint(merge([shaft, deck]), "white"), w.printed, 0, 0, 0, w.root, { cast: false, receive: false });
  }
  w.mesh(merge(land), forest, 0, 0, 0, w.root, { cast: false, receive: false });
  w.mesh(merge(towns), town, 0, 0, 0, w.root, { cast: false, receive: false });
}
