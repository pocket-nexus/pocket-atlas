import { MeshPhysicalMaterial, PointLight, SpotLight, Vector3 } from "three";
import { canvas, JP_SANS, LATIN, roundRect, toTexture } from "../gfx/canvas";
import type { World } from "./context";
import { buildCar, CAR, LAMPS } from "./props/car";

/** Lane centres on the main street (traffic keeps left). */
const LANE = { east: 1.8, west: 4.8 };
/** Speeds in m/s; the taxi eases off around the zebra and the intersection. */
const RUN = { from: 80, vmax: 9.0, vslow: 3.4, slowAt: 8.0, slowWidth: 7.5, gap: [5, 11] as const, first: 3 };
const HEAD = { color: 0xfff2dc, intensity: 230, distance: 48, angle: 0.44, penumbra: 0.6 };
const TAIL = { color: 0xff2412, intensity: 2.2, distance: 7 };

/** Roof sign, 空車 LED, commercial (green) plates and door badge in one small canvas. */
function taxiCanvas(): HTMLCanvasElement {
  const { c, g } = canvas(512, 256);
  // Roof lamp face.
  g.fillStyle = "#fff7e6";
  g.fillRect(0, 0, 256, 80);
  g.fillStyle = "#0e5a3a";
  g.font = `900 52px ${LATIN}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("TAXI", 150, 42);
  g.beginPath();
  g.arc(40, 40, 26, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#f2c230";
  g.font = `900 30px ${JP_SANS}`;
  g.fillText("ポ", 40, 42);
  // 空車 in red LED dots.
  g.fillStyle = "#060606";
  g.fillRect(256, 0, 256, 80);
  g.fillStyle = "#ff2a18";
  g.font = `900 60px ${JP_SANS}`;
  g.fillText("空車", 384, 42);
  g.fillStyle = "rgba(6,6,6,0.55)";
  for (let x = 256; x < 512; x += 5) g.fillRect(x, 0, 1.5, 80);
  for (let y = 0; y < 80; y += 5) g.fillRect(256, y, 256, 1.5);
  // Green commercial plate.
  g.fillStyle = "#1c6a3c";
  roundRect(g, 4, 100, 248, 124, 10);
  g.fill();
  g.strokeStyle = "#e8f0ea";
  g.lineWidth = 3;
  roundRect(g, 9, 105, 238, 114, 8);
  g.stroke();
  g.fillStyle = "#f2f6f2";
  g.font = `700 30px ${JP_SANS}`;
  g.fillText("品川 500", 128, 128);
  g.font = `700 26px ${JP_SANS}`;
  g.fillText("か", 34, 184);
  g.font = `800 64px ${LATIN}`;
  g.fillText("12-34", 146, 186);
  // Door badge.
  g.fillStyle = "#f4efe0";
  g.fillRect(256, 100, 256, 62);
  g.fillStyle = "#0e5a3a";
  g.font = `900 30px ${JP_SANS}`;
  g.fillText("ポケット交通", 384, 124);
  g.font = `700 15px ${LATIN}`;
  g.fillText("POCKET KOTSU  03-3822-0001", 384, 150);
  return c;
}

const px = (x: number, y: number, w: number, h: number) => ({ u0: x / 512, u1: (x + w) / 512, v1: 1 - y / 256, v0: 1 - (y + h) / 256 });

/**
 * A Crown-Comfort-style taxi that cruises the main street every half minute,
 * alternating direction and easing off through the crossing. Its lights stay
 * in the scene at zero intensity while it is away (adding or removing lights
 * would recompile every material).
 */
export function buildTraffic(w: World): void {
  const lib = w.lib;
  const tex = toTexture(taxiCanvas());
  const plateMat = lib.sign(tex, 0.45, { key: "taxi-plate" });
  const rig = buildCar({
    paint: new MeshPhysicalMaterial({ color: 0x0d3a2a, metalness: 0.35, roughness: 0.36, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.55 }),
    glass: new MeshPhysicalMaterial({ color: 0x05080b, metalness: 0, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.3 }),
    trim: lib.plain(0x121314, 0.5),
    chrome: lib.chrome(),
    rubber: lib.rubber(),
    head: lib.glow(0xfff1dc, 10),
    tail: lib.glow(0xff1e0e, 4),
    amber: lib.plain(0xd07a18, 0.35),
    plate: { mat: plateMat, front: px(4, 100, 248, 124), rear: px(4, 100, 248, 124) },
    taxi: {
      stripe: new MeshPhysicalMaterial({ color: 0xd9a11a, metalness: 0.2, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.08 }),
      sign: lib.sign(tex, 1.9, { key: "taxi-sign" }),
      lampBody: lib.glow(0xfff4e0, 1.6),
      roof: px(2, 2, 252, 76),
      vacant: px(258, 2, 252, 76),
      emblem: px(258, 102, 252, 58),
    },
  });

  const holder = w.group();
  holder.name = "traffic";
  holder.userData.dynamic = true;
  holder.add(rig.root);
  const show = (on: boolean) => {
    rig.body.visible = on;
    for (const wh of rig.wheels) wh.visible = on;
  };

  // Lights live under the car's transform, which never hides (only its meshes do).
  const heads = LAMPS.head.map((p) => {
    const s = new SpotLight(HEAD.color, 0, HEAD.distance, HEAD.angle, HEAD.penumbra, 2);
    s.position.copy(p);
    s.target.position.set(p.x + 14, 0, p.z * 1.6);
    rig.root.add(s, s.target);
    return s;
  });
  const tail = new PointLight(TAIL.color, 0, TAIL.distance, 2);
  tail.position.copy(LAMPS.tail);
  rig.root.add(tail);

  const fogHeads = LAMPS.head.map(() => w.fog(new Vector3(), HEAD.color, 1.25, 0.22, { direction: new Vector3(1, -0.04, 0), cosOuter: Math.cos(HEAD.angle), cosInner: Math.cos(HEAD.angle * 0.35) }));
  const fogTail = w.fog(new Vector3(), TAIL.color, 0.4, 0.3);
  const fogs = [...fogHeads, fogTail];

  const st = { active: false, wait: RUN.first, dir: 1, x: 0, v: 0, pitch: 0, lane: LANE.east };
  const park = () => {
    st.active = false;
    show(false);
    rig.root.position.set(0, 0, -600);
    for (const h of heads) h.intensity = 0;
    tail.intensity = 0;
    for (const f of fogs) f.gain = 0;
  };
  const start = () => {
    st.active = true;
    st.x = -st.dir * RUN.from;
    st.lane = st.dir > 0 ? LANE.east : LANE.west;
    st.v = RUN.vmax;
    st.pitch = 0;
    show(true);
  };
  park();
  const target = (x: number) => RUN.vmax - (RUN.vmax - RUN.vslow) * Math.exp(-(((x - RUN.slowAt) / RUN.slowWidth) ** 2));
  const tmp = new Vector3();
  const fwd = new Vector3();

  w.update((dtRaw, t) => {
    const dt = Math.min(dtRaw, 0.1);
    if (!st.active) {
      st.wait -= dt;
      if (st.wait > 0) return;
      start();
    }
    const acc = Math.max(-3.2, Math.min(2.0, (target(st.x) - st.v) * 1.4));
    st.v = Math.max(0.5, st.v + acc * dt);
    st.x += st.dir * st.v * dt;
    rig.root.position.set(st.x, 0, st.lane);
    rig.root.rotation.y = st.dir > 0 ? 0 : Math.PI;
    // Nose dips under braking; a little road texture in the springs.
    st.pitch += (acc * 0.0055 - st.pitch) * (1 - Math.exp(-dt * 5));
    rig.body.rotation.z = st.pitch;
    rig.body.position.y = Math.sin(t * 9.1 + st.x) * 0.003 + Math.sin(t * 4.7) * 0.002;
    const spin = (st.v * dt) / CAR.wheelR;
    for (const wh of rig.wheels) wh.rotation.z -= (wh.userData.spin as number) * spin;

    // Lamps fade in and out at the ends of the run, deep in the haze.
    const edge = Math.min(1, Math.max(0, (RUN.from + 2 - Math.abs(st.x)) / 12));
    for (const h of heads) h.intensity = HEAD.intensity * edge;
    tail.intensity = TAIL.intensity * edge;
    rig.root.updateMatrixWorld();
    fwd.set(st.dir, -0.05, 0).normalize();
    fogHeads.forEach((f, i) => {
      f.position.copy(tmp.copy(LAMPS.head[i]).applyMatrix4(rig.root.matrixWorld));
      f.direction!.copy(fwd);
      f.gain = edge;
    });
    fogTail.position.copy(tmp.copy(LAMPS.tail).applyMatrix4(rig.root.matrixWorld));
    fogTail.gain = edge;

    if (Math.abs(st.x) > RUN.from + 2) {
      park();
      st.dir = -st.dir;
      st.wait = RUN.gap[0] + w.rng.next() * (RUN.gap[1] - RUN.gap[0]);
    }
  });
}
