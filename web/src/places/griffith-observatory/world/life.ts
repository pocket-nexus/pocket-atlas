import { BoxGeometry, BufferGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3, type Material, type Object3D } from "three";
import { bearing } from "../../shared/geo";
import { HAZE_GLSL } from "../../shared/haze";
import { buildLightField, LightSet } from "../../shared/lights";
import { phone } from "../../shared/people/gear";
import { stand, walk, type Gait } from "../../shared/people/motion";
import { patrol } from "../../shared/people/paths";
import { Figure, type Build, type Look } from "../../shared/people/rig";
import { Wear } from "../../shared/people/wear";
import { merge } from "../../shared/shapes";
import type { GriffithWorld } from "./context";
import { groundY } from "./dem";
import { HAZE } from "./haze";
import { LOOP, place } from "./layout";
import { LEVEL } from "./observatory/plan";

/*
 * What moves at blue hour besides the city's traffic (area B): airliners on
 * the LAX west-flow approach sliding across the southern sky, a few bright
 * stars, ordinary visitors on the terraces and lawn, and cars and the DASH
 * bus on the observatory roads. Every motion is periodic over LOOP.
 */

// ------------------------------------------------------------------ aircraft

/**
 * LAX west flow: arrivals land on the outer runways 24R and 25L, true course
 * 263° (the runways run almost due west to the sea), on a 3° glide slope
 * from ~1,500 m at 30 km out. From the observatory the approach line crosses
 * the southern sky from ESE (114°, 33 km) to S (178°, 17 km) at +2° to +3°,
 * dropping to the horizon haze as it nears LAX (207°, 20.6 km).
 *
 * The contract's paths are linear and wrap once per cycle, so each runway's
 * stream is a chain of 9.3 km segments (one per LOOP, ~78 m/s, 150 kt) that
 * all share one phase: when a light reaches the end of its segment and wraps,
 * the light of the next segment down appears exactly there. The far end of
 * the chain (r = 48 km, 37 km away, high and small) is where an aircraft
 * appears; the near end (r = 2 km) is low in the haze at LAX, where it fades.
 * Two runways half a loop apart: one arrival a minute.
 */
const THRESHOLDS: { lat: number; lon: number; phase: number }[] = [
  { lat: 33.9521, lon: -118.4019, phase: 0 }, // 24R
  { lat: 33.9373, lon: -118.3967, phase: 0.5 }, // 25L
];
const COURSE = 263; // true, toward the runway
const SEGMENT = 9300;
const R0 = 2000;
const SEGMENTS = 5;
const M_PER_DEG_LAT = 111320;

/** Altitude above sea level (m) r metres out on the approach: 3° glide slope to ~1,550 m, then a shallow climb outward. */
function approachAltitude(r: number): number {
  const glide = 53 + r * Math.tan((3 * Math.PI) / 180);
  return r < 28000 ? glide : 53 + 28000 * Math.tan((3 * Math.PI) / 180) + (r - 28000) * 0.03;
}

/** A point r metres out from a threshold along the reciprocal of the course, in place coordinates. */
function approachPoint(th: { lat: number; lon: number }, r: number, out = new Vector3()): Vector3 {
  const back = ((COURSE + 180) * Math.PI) / 180;
  const lat = th.lat + (r * Math.cos(back)) / M_PER_DEG_LAT;
  const lon = th.lon + (r * Math.sin(back)) / (M_PER_DEG_LAT * Math.cos((th.lat * Math.PI) / 180));
  return place(lat, lon, approachAltitude(r), out);
}

function buildAircraft(set: LightSet): void {
  const a = new Vector3();
  const b = new Vector3();
  for (const th of THRESHOLDS) {
    for (let s = 0; s < SEGMENTS; s++) {
      const r1 = R0 + (s + 1) * SEGMENT;
      const r0 = R0 + s * SEGMENT;
      approachPoint(th, r1, a);
      approachPoint(th, r0, b);
      const path: [number, number, number, number] = [b.x - a.x, b.y - a.y, b.z - a.z, 1];
      const phase = th.phase;
      // Landing lights (seen from the side, 5,000 K), the red beacon and the white strobes.
      set.add({ x: a.x, y: a.y, z: a.z, r: 1.0, g: 0.93, b: 0.84, intensity: 9000, radius: 0.8, phase, twinkle: 0.2, path });
      set.add({ x: a.x, y: a.y - 2, z: a.z, r: 1.0, g: 0.08, b: 0.03, intensity: 5000, radius: 0.5, phase, path, blink: [100, 0.14] });
      set.add({ x: a.x, y: a.y + 1, z: a.z + 4, r: 1.0, g: 1.0, b: 1.0, intensity: 16000, radius: 0.5, phase, path, blink: [90, 0.04] });
    }
  }
}

// ------------------------------------------------------------------ stars

/**
 * Only what the eye and p09's exposure show 5° after sunset: the zero-
 * magnitude stars and Saturn (mag 0.6), positions for 2015-09-09 02:30 UT
 * at the observatory (altitude, azimuth). Spica (13°, in the afterglow) and
 * fainter stars are not yet out.
 */
const STARS: { name: string; alt: number; az: number; mag: number; rgb: [number, number, number] }[] = [
  { name: "Arcturus", alt: 40.8, az: 266.5, mag: -0.05, rgb: [1.0, 0.82, 0.62] },
  { name: "Vega", alt: 79.1, az: 61.0, mag: 0.03, rgb: [0.82, 0.88, 1.0] },
  { name: "Altair", alt: 52.2, az: 124.7, mag: 0.77, rgb: [0.92, 0.94, 1.0] },
  { name: "Saturn", alt: 31.1, az: 210.9, mag: 0.6, rgb: [1.0, 0.9, 0.7] },
  { name: "Antares", alt: 26.6, az: 199.7, mag: 1.06, rgb: [1.0, 0.62, 0.42] },
];
const STAR_DISTANCE = 60000;

function buildStars(set: LightSet): void {
  for (const s of STARS) {
    const d = bearing(s.az, s.alt).multiplyScalar(STAR_DISTANCE);
    // Brightness by magnitude: a 40° view gets ~0.4 for magnitude 0, faint
    // specks in the twilight blue as in p09 (the sprite is far below a pixel).
    const i = 50 * Math.pow(10, -0.4 * s.mag);
    set.add({ x: d.x, y: d.y, z: d.z, r: s.rgb[0], g: s.rgb[1], b: s.rgb[2], intensity: i, radius: 10, twinkle: 0.6, phase: (s.az / 360) % 1 });
  }
}

// ------------------------------------------------------------------ materials

/** Plain PBR paint for the figures and vehicles, one material per (colour, roughness, metalness). */
class Paints {
  private m = new Map<string, MeshStandardMaterial>();
  private g = new Map<string, MeshBasicMaterial>();
  plain(hex: number, rough = 0.6, metal = 0): MeshStandardMaterial {
    const k = `${hex}|${rough}|${metal}`;
    let m = this.m.get(k);
    if (!m) this.m.set(k, (m = new MeshStandardMaterial({ name: "life", color: hex, roughness: rough, metalness: metal })));
    return m;
  }
  /** An unlit lamp (linear HDR colour). */
  glow(r: number, g: number, b: number): MeshBasicMaterial {
    const k = `${r}|${g}|${b}`;
    let m = this.g.get(k);
    if (!m) {
      m = new MeshBasicMaterial({ name: "life-lamp", color: 0xffffff });
      m.color.setRGB(r, g, b);
      this.g.set(k, m);
    }
    return m;
  }
}

// ------------------------------------------------------------------ roads

const _t0 = new Vector3();
const _t1 = new Vector3();

/** A polyline on the ground, parametrised by arc length. */
class Route {
  readonly pts: Vector3[];
  readonly cum: number[] = [0];
  constructor(xz: [number, number][], lift = 0) {
    // Resample to ~4 m so the DEM's slope reaches the vehicles' pitch.
    const dense: [number, number][] = [];
    for (let i = 0; i < xz.length - 1; i++) {
      const [ax, az] = xz[i];
      const [bx, bz] = xz[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 4));
      for (let k = 0; k < n; k++) dense.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
    }
    dense.push(xz[xz.length - 1]);
    this.pts = dense.map(([x, z]) => new Vector3(x, groundY(x, z) + lift, z));
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + this.pts[i].distanceTo(this.pts[i - 1]));
  }
  get length(): number {
    return this.cum[this.cum.length - 1];
  }
  /** Position at arc length s (clamped) and the unit tangent. */
  at(s: number, out: Vector3, dir: Vector3): void {
    const c = this.cum;
    s = Math.max(0, Math.min(this.length, s));
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = this.pts[lo];
    const b = this.pts[hi];
    const u = (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
    out.copy(a).lerp(b, u);
    // Tangent over ±6 m keeps the heading smooth through the resampled corners.
    this.point(s - 6, _t0);
    this.point(s + 6, _t1);
    dir.copy(_t1).sub(_t0).normalize();
  }
  private point(s: number, out: Vector3): void {
    const c = this.cum;
    s = Math.max(0, Math.min(this.length, s));
    let i = 1;
    while (i < c.length - 1 && c[i] < s) i++;
    const u = (s - c[i - 1]) / Math.max(1e-6, c[i] - c[i - 1]);
    out.copy(this.pts[i - 1]).lerp(this.pts[i], u);
  }
  /** Arc length nearest a point (for stops and slow zones). */
  nearest(x: number, z: number): number {
    let best = 0;
    let bd = Infinity;
    this.pts.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) {
        bd = d;
        best = this.cum[i];
      }
    });
    return best;
  }
}

/**
 * The one-way loop through the grounds (OSM): up West Observatory Road from
 * the Fern Dell side to the horseshoe north of the lawn, round its apex
 * (x 2, z −118) and down East Observatory Road. Lanes keep right, ~1.6 m
 * off the centre line. Both far ends lie north of the lawn, behind the Lawn
 * shot and below the Overlook's frame, so a vehicle leaving one and
 * re-entering the other is never seen.
 */
const WEST_ROAD: [number, number][] = [
  [-169, -584], [-217, -546], [-227, -536], [-231, -521], [-228, -506], [-224, -499], [-176, -431], [-162, -413], [-150, -407], [-133, -408],
  [-110, -418], [-92, -422], [-74, -420], [-59, -412], [-49, -402], [-36, -379], [-28, -358], [-17, -314], [-14, -294], [-10, -281], [-8, -265],
  [-8, -234], [-8, -214], [-10, -191], [-10, -164], [-9, -143], [-9, -127], [-6, -121], [-3, -119], [0, -118], [2, -118],
];
const EAST_ROAD: [number, number][] = [
  [4, -118], [9, -121], [12, -126], [13, -135], [13, -141], [10, -153], [9, -169], [9, -188], [12, -202], [18, -213], [26, -224], [45, -243],
  [64, -265], [72, -281], [75, -297], [70, -312], [54, -330], [41, -347], [35, -364], [33, -381], [40, -406], [47, -417], [62, -445], [67, -462],
  [65, -476], [41, -508], [35, -537], [43, -556],
];

/** Offsets a polyline to the right of travel by `d` metres. */
function keepRight(xz: [number, number][], d: number): [number, number][] {
  return xz.map(([x, z], i) => {
    const a = xz[Math.max(0, i - 1)];
    const b = xz[Math.min(xz.length - 1, i + 1)];
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    // Right of travel in x–z with −Z north: (−tz, tx).
    return [x - (tz / l) * d, z + (tx / l) * d];
  });
}

/**
 * Time warp over the route: a speed profile (slow through the horseshoe
 * apex, optionally a dwell) integrated into s(u) for u = fraction of LOOP,
 * so each vehicle laps once per loop.
 */
function warp(route: Route, slowAt: number, dwell: { at: number; seconds: number } | null): (u: number) => number {
  const n = 600;
  const L = route.length;
  const ts: number[] = [0];
  for (let i = 1; i <= n; i++) {
    const s = (L * (i - 0.5)) / n;
    const slow = 1 - 0.6 * Math.exp(-(((s - slowAt) / 30) ** 2));
    ts.push(ts[i - 1] + 1 / slow);
  }
  const drive = ts[n];
  const dwellShare = dwell ? dwell.seconds / LOOP : 0;
  return (u: number) => {
    u = ((u % 1) + 1) % 1;
    let k: number;
    if (dwell) {
      const sd = dwell.at / L;
      // Time share before the stop, at the stop, after it.
      const before = ts[Math.round(sd * n)] / drive;
      const ud = before * (1 - dwellShare);
      if (u < ud) k = (u / (1 - dwellShare)) * drive;
      else if (u < ud + dwellShare) return dwell.at;
      else k = ((u - dwellShare) / (1 - dwellShare)) * drive;
    } else k = u * drive;
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= k) lo = mid;
      else hi = mid;
    }
    const f = (k - ts[lo]) / Math.max(1e-9, ts[hi] - ts[lo]);
    return (L * (lo + f)) / n;
  };
}

/** A generic sedan / SUV: body, cabin glass, wheels, head and tail lamps (~250 triangles). */
function vehicle(p: Paints, o: { len: number; wid: number; body: number; cabin: number; paint: number; metal?: number; bus?: boolean }): Group {
  const g = new Group();
  const parts = new Map<Material, BufferGeometry[]>();
  const add = (m: Material, geo: BufferGeometry, x: number, y: number, z: number) => {
    geo.translate(x, y, z);
    let l = parts.get(m);
    if (!l) parts.set(m, (l = []));
    l.push(geo);
  };
  const { len, wid, body, cabin } = o;
  const paint = p.plain(o.paint, 0.35, o.metal ?? 0.4);
  const glass = p.plain(0x0b0d10, 0.1, 0.6);
  const tyre = p.plain(0x111111, 0.85);
  const clear = 0.32;
  // Body: lower box, then the cabin set back (a bus is one tall box with a window band).
  add(paint, new BoxGeometry(wid, body, len), 0, clear + body / 2, 0);
  if (o.bus) {
    // A 30-ft transit bus: white box, a row of side windows lit from the
    // cabin with pillars between, the DASH blue and green stripes under them,
    // a dark windscreen with the amber destination sign over it, black bumpers.
    const top = clear + body + cabin;
    add(paint, new BoxGeometry(wid, cabin, len), 0, clear + body + cabin / 2 - 0.001, 0);
    add(p.plain(0xd2d4d6, 0.5, 0.1), new BoxGeometry(wid * 0.8, 0.28, len * 0.35), 0, top + 0.14, len * 0.12);
    add(p.plain(0x2a6ab0, 0.4, 0.2), new BoxGeometry(wid + 0.03, 0.2, len * 0.98), 0, clear + body * 0.7, 0);
    add(p.plain(0x2e9a4e, 0.4, 0.2), new BoxGeometry(wid + 0.03, 0.07, len * 0.98), 0, clear + body * 0.7 + 0.16, 0);
    add(p.plain(0x111214, 0.6), new BoxGeometry(wid + 0.04, 0.3, 0.12), 0, clear + 0.15, -len / 2 - 0.02);
    add(p.plain(0x111214, 0.6), new BoxGeometry(wid + 0.04, 0.3, 0.12), 0, clear + 0.15, len / 2 + 0.02);
    const cabinLit = p.glow(0.32, 0.31, 0.27);
    const panes = 6;
    const run = len * 0.72;
    const pw = (run / panes) * 0.84;
    const wy = clear + body + cabin * 0.45;
    for (const sx of [-1, 1])
      for (let i = 0; i < panes; i++) {
        const z = -len * 0.5 + len * 0.2 + (run * (i + 0.5)) / panes;
        add(cabinLit, new BoxGeometry(0.03, cabin * 0.5, pw), sx * (wid / 2 + 0.01), wy, z);
      }
    // Windscreen (front, −Z), dark with the dash's faint light, and the sign over it.
    add(glass, new BoxGeometry(wid * 0.86, cabin * 0.62, 0.04), 0, clear + body + cabin * 0.36, -len / 2 - 0.01);
    add(p.glow(1.6, 0.9, 0.2), new BoxGeometry(wid * 0.62, 0.2, 0.04), 0, top - 0.17, -len / 2 - 0.02);
  } else {
    add(glass, new BoxGeometry(wid * 0.86, cabin, len * 0.5), 0, clear + body + cabin / 2, len * 0.04);
    add(paint, new BoxGeometry(wid * 0.84, 0.06, len * 0.46), 0, clear + body + cabin + 0.03, len * 0.05);
  }
  // Wheels.
  const r = o.bus ? 0.48 : 0.33;
  for (const sx of [-1, 1])
    for (const sz of [-0.33, 0.33]) {
      const w = new CylinderGeometry(r, r, 0.22, 10).rotateZ(Math.PI / 2);
      add(tyre, w, sx * (wid / 2 - 0.08), r, sz * len);
    }
  // Lamps: −Z is the front.
  const head = p.glow(6, 5.6, 5);
  const tail = p.glow(2.4, 0.08, 0.04);
  for (const sx of [-1, 1]) {
    add(head, new BoxGeometry(0.28, 0.12, 0.04), sx * (wid / 2 - 0.25), clear + body * 0.7, -len / 2 - 0.01);
    add(tail, new BoxGeometry(0.26, 0.12, 0.04), sx * (wid / 2 - 0.2), clear + body * 0.75, len / 2 + 0.01);
  }
  for (const [m, geos] of parts) {
    const mesh = new Mesh(merge(geos), m);
    mesh.castShadow = false;
    g.add(mesh);
  }
  g.userData.dynamic = true;
  return g;
}

function buildTraffic(w: GriffithWorld, p: Paints): void {
  const west = keepRight(WEST_ROAD, 1.6);
  const east = keepRight(EAST_ROAD, 1.6);
  const route = new Route([...west, ...east]);
  const apex = route.nearest(2, -118);
  const _p = new Vector3();
  const _d = new Vector3();
  const drive = (g: Object3D, phase: number, s: (u: number) => number) => {
    w.root.add(g);
    w.updaters.push((_dt, t) => {
      route.at(s(t / LOOP + phase), _p, _d);
      g.position.copy(_p);
      g.rotation.set(0, Math.atan2(-_d.x, -_d.z), 0, "YXZ");
      g.rotateX(Math.asin(Math.max(-1, Math.min(1, _d.y))));
    });
  };
  const cars = [
    { paint: 0xd8d8d4, len: 4.8, wid: 1.85, body: 0.72, cabin: 0.55, phase: 0.08 },
    { paint: 0x1a1c20, len: 4.9, wid: 1.9, body: 0.8, cabin: 0.62, phase: 0.43 },
    { paint: 0x6e7176, len: 4.6, wid: 1.8, body: 0.7, cabin: 0.52, phase: 0.71 },
  ];
  const carWarp = warp(route, apex, null);
  for (const c of cars) drive(vehicle(p, c), c.phase, carWarp);
  // The DASH Observatory shuttle: a 30-ft bus that waits at the horseshoe stop.
  const bus = vehicle(p, { paint: 0xe9e9e4, len: 9.2, wid: 2.5, body: 1.1, cabin: 1.6, metal: 0.1, bus: true });
  drive(bus, 0.25, warp(route, apex, { at: route.nearest(13, -132), seconds: 18 }));
}

// ------------------------------------------------------------------ visitors

type Outfit = [Build, Look];
const SKIN = [0xc49c82, 0x8d5e44, 0xe0b49a, 0x6b4430, 0xb48e76];
const HAIR = [0x15110f, 0x2a1c16, 0x5a4030, 0x0f0d0c];

/** A warm September evening (~24 °C): T-shirts, light shirts, jeans. */
function outfit(i: number): Outfit {
  const skin = { hex: SKIN[i % SKIN.length], rough: 0.55 };
  const hair = { hex: HAIR[(i * 3) % HAIR.length], rough: 0.4 };
  const list: Outfit[] = [
    [{ height: 1.78, hair: "short", top: { t: 0.012, hem: 0.8, cuff: 0.004 }, legs: { loose: 0.006 }, shoe: "sneaker" }, { skin, hair, top: { hex: 0x5c6066, rough: 0.8 }, bottom: { hex: 0x2a3550, rough: 0.6 }, shoes: { hex: 0xdedcd4, rough: 0.5 } }],
    [{ height: 1.64, fem: 1, hair: "bob", top: { t: 0.012, hem: 0.66, flare: 0.04, cuff: 0.004 }, legs: { loose: 0.004 }, shoe: "sneaker" }, { skin, hair, top: { hex: 0xd9d2c6, rough: 0.75 }, bottom: { hex: 0x1f2533, rough: 0.6 }, shoes: { hex: 0x2a2a2c, rough: 0.5 } }],
    [{ height: 1.75, hair: "short", top: { t: 0.016, hem: 0.78, cuff: 0.004 }, legs: { loose: 0.008 }, shoe: "shoe" }, { skin, hair, top: { hex: 0x3b4a5e, rough: 0.7 }, bottom: { hex: 0x8a7d66, rough: 0.7 }, shoes: { hex: 0x3a2a20, rough: 0.4 } }],
    [{ height: 1.6, fem: 1, hair: "bob", top: { t: 0.02, hem: 0.62, flare: 0.06, cuff: 0.006 }, legs: { tights: true }, shoe: "boot" }, { skin, hair, top: { hex: 0x2b2b30, rough: 0.7 }, bottom: { hex: 0x161618, rough: 0.5 }, shoes: { hex: 0x121212, rough: 0.35 } }],
    [{ height: 1.82, hair: "short", top: { t: 0.014, hem: 0.8, cuff: 0.004 }, legs: { loose: 0.006 }, shoe: "sneaker" }, { skin, hair, top: { hex: 0x7a2a2e, rough: 0.75 }, bottom: { hex: 0x24272e, rough: 0.55 }, shoes: { hex: 0x303236, rough: 0.5 }, cap: { hex: 0x1a1c20, rough: 0.6 } }],
    [{ height: 1.68, fem: 1, hair: "bob", top: { t: 0.014, hem: 0.7, cuff: 0.004 }, legs: { loose: 0.005 }, shoe: "sneaker" }, { skin, hair, top: { hex: 0x9fb0c4, rough: 0.75 }, bottom: { hex: 0x2e3a52, rough: 0.6 }, shoes: { hex: 0xeeeeea, rough: 0.5 } }],
  ];
  return list[i % list.length];
}

/** Periodic wander in [−1, 1] over LOOP (whole cycles only, so the loop is seamless). */
function sway(t: number, seed: number): number {
  const w = (2 * Math.PI) / LOOP;
  return (Math.sin(w * 3 * t + seed * 1.7) + 0.6 * Math.sin(w * 7 * t + seed * 4.1) + 0.3 * Math.sin(w * 17 * t + seed * 7.3)) / 1.9;
}

const _a = new Vector3();
const _b = new Vector3();
const _pole = new Vector3();

function buildVisitors(w: GriffithWorld, p: Paints): void {
  const root = new Group();
  root.name = "visitors";
  root.userData.dynamic = true;
  w.root.add(root);
  const wear = new Wear(p, false);
  const screen = p.glow(0.75, 0.85, 1.1);
  const case_ = p.plain(0x121316, 0.25, 0.3);

  // Two walking slowly up the central walk toward the entrance and back (Lawn shot).
  const walkers: { lane: [number, number]; run: [number, number]; laps: number; i: number; lead: number }[] = [
    { lane: [-1.3, 1.1], run: [-82, -44], laps: 1, i: 0, lead: 0 },
    { lane: [-0.75, 1.65], run: [-82, -44], laps: 1, i: 1, lead: 0.6 },
  ];
  for (const k of walkers) {
    const [build, look] = outfit(k.i);
    const f = new Figure(build, look, wear);
    root.add(f.root);
    const path = patrol("z", k.run[0], k.run[1], k.lane[0], k.lane[1]);
    // Whole strides per lap and whole laps per loop keep the seam invisible.
    const stride = path.length / Math.round(path.length / (1.18 * f.d.s));
    const speed = (path.length * k.laps) / LOOP;
    const gait: Gait = { stride, lift: 0.09, arm: 0.16, lean: 0.03, look: 0.05 };
    const y = groundY(0, -60);
    w.updaters.push((_dt, t) => {
      const d = t * speed + k.lead;
      f.root.rotation.y = path.at(d, f.root.position);
      f.root.position.y = y;
      walk(f, d / gait.stride, gait, [true, true]);
    });
  }

  // Standing at the parapets: on the roof promenade round the drum (west and
  // east, over the basin) and by the Astronomers Monument. θ: 0 east, π/2 south.
  const standers: { x: number; y: number; z: number; face: number; i: number; phone: boolean }[] = [
    // At the parapet of the roof walkway round the drum, south-west (Terrace shot).
    { x: Math.cos(Math.PI * 0.78) * 14.3, y: LEVEL.deck, z: Math.sin(Math.PI * 0.78) * 14.3, face: Math.PI * 0.74, i: 2, phone: false },
    { x: Math.cos(Math.PI * 0.725) * 14.3, y: LEVEL.deck, z: Math.sin(Math.PI * 0.725) * 14.3, face: Math.PI * 0.62, i: 3, phone: true },
    // On the lower east terrace below the east deck (Roof shot, p14).
    { x: 23.4, y: LEVEL.east, z: 9.6, face: Math.PI * 0.55, i: 5, phone: true },
    { x: 27.0, y: LEVEL.east, z: 9.8, face: Math.PI * 0.4, i: 0, phone: false },
    // On the lawn by the Astronomers Monument.
    { x: 7.5, y: groundY(7.5, -94), z: -94, face: Math.PI * 1.15, i: 4, phone: false },
  ];
  standers.forEach((st, n) => {
    const [build, look] = outfit(st.i);
    const f = new Figure(build, look, wear);
    f.root.position.set(st.x, st.y, st.z);
    // Face the direction θ (x = cos θ, z = sin θ): the figure's +Z is its front.
    f.root.rotation.y = Math.atan2(Math.cos(st.face), Math.sin(st.face));
    root.add(f.root);
    const s = f.d.s;
    const ph = st.phone ? phone(case_, screen, f.chest) : null;
    if (ph) {
      // Held up, taking a picture of the view.
      ph.position.set(-0.02, 0.06, 0.34);
      ph.rotation.set(0.1, 0.05, 0.02);
    }
    const feet: [Vector3, Vector3] = [new Vector3(0.12, 0.075 * s, 0.03), new Vector3(-0.1, 0.075 * s, -0.03)];
    w.updaters.push((_dt, t) => {
      stand(f, {
        feet,
        toe: [0.16, -0.16],
        weight: 0.5 * Math.tanh(2 * sway(t, n)),
        lean: 0.04,
        twist: 0.05 * sway(t * 1.3, n + 2),
        breath: (2 * Math.PI * 30 * t) / LOOP,
        yaw: 0.3 * sway(t, n + 3) * (ph ? 0.3 : 1),
        pitch: ph ? 0.1 : 0.05 + 0.04 * sway(t, n + 5),
      });
      if (ph) {
        ph.updateMatrixWorld();
        f.reach(1, f.root.worldToLocal(ph.localToWorld(_a.set(0.01, -0.06, 0.0))), _pole.set(-1, -0.8, -0.3).normalize());
        f.aim(1, f.root.worldToLocal(ph.localToWorld(_b.set(0.005, -0.03, 0.012))));
        f.reach(0, f.root.worldToLocal(ph.localToWorld(_a.set(-0.01, 0.06, 0.0))), _pole.set(1, -0.8, -0.3).normalize());
      } else {
        f.swing(0, 0.04, -0.04, 0.25, 0.1);
        f.swing(1, -0.03, -0.04, 0.25, 0.1);
      }
    });
  });
}

// ------------------------------------------------------------------ build

export function buildLife(w: GriffithWorld): void {
  const paints = new Paints();
  buildTraffic(w, paints);
  buildVisitors(w, paints);
  const sky = new LightSet("sky-life");
  buildAircraft(sky);
  buildStars(sky);
  const field = buildLightField(sky, { minPixels: 1.4, maxPixels: 4, gain: 1, loop: LOOP, haze: { glsl: HAZE_GLSL, uniforms: HAZE.uniforms } });
  // The aircraft move inside the shader: keep the field out of the frustum cull and the batches.
  field.points.frustumCulled = false;
  w.root.add(field.points);
  w.updaters.push((_dt, t) => field.update(t));
}
