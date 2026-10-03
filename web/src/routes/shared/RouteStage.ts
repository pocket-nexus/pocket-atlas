import { BufferAttribute, BufferGeometry, CircleGeometry, FogExp2, Group, HemisphereLight, Mesh, PerspectiveCamera, Vector3, type Material, type Texture } from "three";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { Baker } from "../../places/shared/bake";
import type { Box6, Shot, ShotKey } from "../../places/shared/camera";
import type { ExportFogLight } from "../../places/shared/export";
import { bearing } from "../../places/shared/geo";
import { createPlacePost } from "../../places/shared/post";
import { bakeCloudPanorama, buildSky, type Sky } from "../../places/shared/sky";
import { PlaceStage } from "../../places/shared/stage";
import { driveSound, QUIET, RouteAudio, type DriveSound } from "./audio";
import type { RouteDef, RouteView } from "./def";
import { autopilot } from "./drive/autopilot";
import { newChase, stepChase, type DriveView, type Eye } from "./drive/chase";
import { newTraffic, stepTraffic, type Traffic } from "./drive/traffic";
import { newTrip, nextStop, stepTrip, type Stop, type TripState } from "./drive/trip";
import { KEI, startState, stepCar, type CarState, type Controls, type Surface } from "./drive/vehicle";
import { Snow } from "./fx/snow";
import { sunPosition, toLocal, type Frame, JPRCS_XII } from "./geodesy";
import { RouteHud } from "./hud";
import { buildCar, type Car } from "./kit/car";
import { Kit } from "./kit/materials";
import { buildTraffic, type TrafficFleet } from "./kit/traffic";
import { Cells } from "./layers";
import { Line } from "./line";
import { fetchRouteFiles, type RouteFiles, type RouteJson } from "./source";
import { Streamer } from "./stream";

/** What the kit's export holds: the car, the swatches, the sky and the light. */
interface RouteExport {
  root: Group;
  updaters: ((dt: number, t: number) => void)[];
  fogLights: ExportFogLight[];
}

/** Keyboard and gamepad into the car's controls; keys ramp like a hand on the wheel. */
class Pad {
  readonly controls: Controls = { steer: 0, throttle: 0, brake: 0 };
  private keys = new Set<string>();
  private presses: string[] = [];
  private down = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    this.keys.add(k);
    this.presses.push(k);
    if (k.startsWith("Arrow") || k === " ") e.preventDefault();
  };
  private up = (e: KeyboardEvent) => this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  private blur = () => this.keys.clear();

  constructor() {
    addEventListener("keydown", this.down);
    addEventListener("keyup", this.up);
    addEventListener("blur", this.blur);
  }

  /** Keys pressed since the last call. */
  pressed(): string[] {
    const p = this.presses;
    this.presses = [];
    return p;
  }

  update(dt: number, speed: number): void {
    const has = (...k: string[]) => k.some((x) => this.keys.has(x));
    let steer = (has("d", "ArrowRight") ? 1 : 0) - (has("a", "ArrowLeft") ? 1 : 0);
    let throttle = has("w", "ArrowUp") ? 1 : 0;
    let brake = has("s", "ArrowDown", " ") ? 1 : 0;
    let analog = false;
    const gp = navigator.getGamepads?.().find((g) => g && g.connected);
    if (gp) {
      const ax = gp.axes[0] ?? 0;
      if (Math.abs(ax) > 0.08) {
        steer = Math.sign(ax) * Math.pow((Math.abs(ax) - 0.08) / 0.92, 1.6);
        analog = true;
      }
      throttle = Math.max(throttle, gp.buttons[7]?.value ?? 0, gp.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, gp.buttons[6]?.value ?? 0, gp.buttons[2]?.pressed ? 1 : 0);
    }
    const c = this.controls;
    if (analog) c.steer = steer;
    else {
      // Keys: the wheel moves toward the key at a rate that slows with speed and centres faster than it turns.
      const rate = (steer === 0 || Math.sign(steer) !== Math.sign(c.steer) ? 3.6 : 2.2) / (1 + speed / 22);
      c.steer += Math.max(-rate * dt, Math.min(rate * dt, steer - c.steer));
    }
    c.throttle += Math.max(-6 * dt, Math.min(3.2 * dt, throttle - c.throttle));
    c.brake += Math.max(-8 * dt, Math.min(5 * dt, brake - c.brake));
  }

  dispose(): void {
    removeEventListener("keydown", this.down);
    removeEventListener("keyup", this.up);
    removeEventListener("blur", this.blur);
  }
}

/** A view beside the road as a shot key. */
function viewKey(line: Line, v: RouteView, travel: number): ShotKey {
  const s = v.km * 1000 + travel;
  const p = line.at(s);
  const pos: [number, number, number] = [p.x - p.tz * v.right, p.y + v.up, p.z + p.tx * v.right];
  const q = line.at(s + v.ahead);
  const r = v.aheadRight ?? 0;
  return { pos, target: [q.x - q.tz * r, q.y + (v.aheadUp ?? 1), q.z + q.tx * r], fov: v.fov };
}

/**
 * A route: a real road driven end to end. The page streams the road's cells
 * around the camera from a worker (`Streamer`), drives the car on the
 * route's centre line (`drive/vehicle.ts`) and follows it with the chase
 * camera; `C` hands the camera to the place rig (named views, free orbit).
 *
 * What a place stage exports for the cooker is here the route's kit: the
 * car, one swatch of every kit material, the sky, the light and the look.
 * The cells are exported separately (`scripts/export-route.ts`).
 */
export class RouteStage extends PlaceStage<RouteExport, RouteAudio> {
  private sky!: Sky;
  /** The weather's cloud panorama, when it has one (exported as `sky-clouds.png`). */
  private clouds: Texture | null = null;
  private kit!: Kit;
  private streamer!: Streamer;
  private car!: Car;
  private snow!: Snow;
  private hud!: RouteHud;
  private pad = new Pad();
  private state!: CarState;
  private trip: TripState = newTrip();
  private chase = newChase();
  private eye: Eye = { pos: [0, 0, 0], target: [0, 0, 0], fov: 50 };
  private view: DriveView = "chase";
  private driving = true;
  private streamClock = 0;
  /** `?auto=60`: the autopilot drives at up to this speed (m/s), for captures and for watching. */
  private auto = 0;
  private sound: DriveSound = QUIET;
  private traffic!: Traffic;
  private fleet!: TrafficFleet;
  private sunDir: Vector3;
  private stops: Stop[];
  private surface: Surface;

  private constructor(
    ctx: StageContext,
    place: PlaceDef,
    private def: RouteDef,
    private files: RouteFiles,
    private line: Line,
    private cells: Cells,
    shots: Shot[],
  ) {
    const p0 = line.at(0);
    const focus: Box6 = [p0.x - 60000, -200, p0.z - 60000, p0.x + 60000, 3000, p0.z + 60000];
    super(ctx, place, new PerspectiveCamera(50, 1, 0.3, 60000), { shots, walkable: [focus], focus, intro: shots[0].from, introSeconds: 0.01, viewFov: 50 }, new RouteAudio(ctx.audio));
    const json = files.route;
    const frame: Frame = { zone: JPRCS_XII, north0: json.frame.north0, east0: json.frame.east0 };
    const stops = place.route?.stops ?? [];
    if (stops.length < 2) throw new Error(`${place.id} has no route stops in the registry`);
    this.stops = stops.map((s, i) => {
      if (i === 0) return { name: s.name, native: s.native, s: 0 };
      if (i === stops.length - 1) return { name: s.name, native: s.native, s: line.length };
      const [x, z] = toLocal(frame, s.lat, s.lon);
      const p = line.project(x, z, 400);
      if (!p) throw new Error(`stop ${s.name} is not within 400 m of the route`);
      return { name: s.name, native: s.native, s: p.s };
    });
    const sun = sunPosition(json.frame.origin.lat, json.frame.origin.lon, new Date(def.departure));
    this.sunDir = bearing(sun.azimuth, Math.max(sun.elevation, 4));
    this.surface = {
      line,
      half: () => 3.6,
      // Packed snow; ice where traffic has polished it, in long patches.
      grip: (s, d) => 0.34 + 0.06 * Math.sin(s * 0.013) * Math.sin(s * 0.0031 + d),
    };
  }

  static async create(ctx: StageContext, place: PlaceDef, def: RouteDef, progress: Progress): Promise<RouteStage> {
    await progress(0.03, "Unfolding the map");
    const files = await fetchRouteFiles(def.files);
    const n = files.route.samples;
    const xzy = new Float32Array(files.centerline.slice(16, 16 + n * 12));
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = xzy[i * 3];
      z[i] = xzy[i * 3 + 1];
      y[i] = xzy[i * 3 + 2];
    }
    const line = new Line(x, y, z);
    const cells = new Cells(line);
    const shots: Shot[] = def.views.map((v) => ({ name: v.name, from: viewKey(line, v, 0), to: viewKey(line, v, v.travel ?? 6), duration: v.seconds ?? 12 }));
    const s = new RouteStage(ctx, place, def, files, line, cells, shots);
    await s.build(progress);
    return s;
  }

  private async build(progress: Progress): Promise<void> {
    const { renderer, quality, params } = this.ctx;
    const w = this.def.weather;
    const skySpec = w.sky(this.sunDir);
    this.scene.fog = new FogExp2(skySpec.horizon.clone(), w.fogDensity);
    this.scene.background = skySpec.horizon.clone();
    renderer.toneMappingExposure = w.exposure;

    await progress(0.1, "Packing the snow");
    this.baker = new Baker(renderer);
    this.kit = new Kit(this.baker, quality);
    const root = new Group();
    root.name = "kit";
    this.world = { root, updaters: [], fogLights: [] };

    await progress(0.3, "Warming up the car");
    this.car = buildCar();
    root.add(this.car.root);
    const q = new URLSearchParams(location.search);
    const km = Number(q.get("km"));
    this.auto = (Number(q.get("auto")) || 0) / 3.6;
    const startS = Number.isFinite(km) && km > 0 ? Math.min(this.line.length - 50, km * 1000) : 12;
    this.state = startState(this.surface, startS, -1.65);
    this.trip.reached = Math.max(0, this.stops.findIndex((st) => st.s > startS) - 1);
    this.car.pose(this.state, false);
    this.fleet = buildTraffic();
    root.add(this.fleet.root);
    this.traffic = newTraffic(this.state.s, this.line.length);
    root.add(this.swatches());

    if (w.clouds) {
      this.clouds = bakeCloudPanorama(this.baker, this.sunDir, w.clouds.bake);
      skySpec.clouds = { texture: this.clouds, ...w.clouds };
    }
    this.sky = buildSky(root, skySpec, 30000);
    root.add(new HemisphereLight(w.hemiSky, w.hemiGround, w.hemiIntensity));
    this.scene.add(root);

    await progress(0.4, "Clearing the road");
    this.streamer = new Streamer(this.files, this.cells, (name) => this.kit.material(name));
    if (params.shot) this.streamer.reach = 1;
    this.scene.add(this.streamer.group);
    await this.streamer.whenReady();
    // The ground around the start before the curtain lifts.
    const at = this.driving && !(params.shot && params.cam) ? new Vector3(this.state.x, this.state.y, this.state.z) : new Vector3(...this.views.shots.find((sh) => sh.name.toLowerCase() === (params.cam ?? "").toLowerCase())?.to.pos ?? this.views.shots[0].to.pos);
    for (let i = 0; i < 400; i++) {
      this.streamer.update(at.x, at.z);
      if (i > 2 && this.streamer.outstanding === 0) break;
      if (i % 5 === 0) await progress(0.4 + 0.4 * Math.min(1, i / 120), "Clearing the road");
      await new Promise((r) => setTimeout(r, 25));
    }

    await progress(0.84, "Reading the sky");
    // The probe: the sky over open snow, as anywhere along the road.
    const ground = new Mesh(new CircleGeometry(4000, 24).rotateX(-Math.PI / 2), this.kit.material("snow"));
    const colors = new Uint8Array(ground.geometry.getAttribute("position").count * 4).fill(255);
    ground.geometry.setAttribute("color", new BufferAttribute(colors, 4, true));
    ground.position.set(this.state.x, this.state.y - 0.5, this.state.z);
    this.scene.add(ground);
    this.streamer.group.visible = false;
    this.car.root.visible = false;
    this.captureProbe(new Vector3(this.state.x, this.state.y + 1.4, this.state.z), { near: 0.3, far: 40000, intensity: w.environmentIntensity });
    this.car.root.visible = true;
    this.streamer.group.visible = true;
    this.scene.remove(ground);
    ground.geometry.dispose();

    this.snow = new Snow(w.snow);
    this.scene.add(this.snow.mesh);

    await progress(0.93, "Setting the mirrors");
    this.post = createPlacePost(renderer, this.scene, this.camera, quality, w.look);
    this.startRig();
    this.hud = new RouteHud(this.ctx.overlay.root, this.stops, this.line.length, this.place.accent);
    this.driving = !(params.shot && params.cam);
    await progress(1, "Ready");
    if (params.exporting) this.exposeRouteExport();
  }

  /** One small quad of every kit material, under the road at the start: the compiler learns the materials from them. */
  private swatches(): Group {
    const g = new Group();
    g.name = "swatches";
    const p = this.line.at(0);
    this.kit.names().forEach((name, i) => {
      const geo = new BufferGeometry();
      const x = p.x + i * 0.3;
      const y = p.y - 3;
      geo.setAttribute("position", new BufferAttribute(new Float32Array([x, y, p.z, x + 0.2, y, p.z, x + 0.2, y, p.z - 0.2, x, y, p.z - 0.2]), 3));
      geo.setAttribute("normal", new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
      geo.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
      const m: Material = this.kit.material(name);
      if ((m as Material & { vertexColors?: boolean }).vertexColors) geo.setAttribute("color", new BufferAttribute(new Float32Array(16).fill(1), 4));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      const mesh = new Mesh(geo, m);
      mesh.name = `swatch-${name}`;
      g.add(mesh);
    });
    return g;
  }

  private exposeRouteExport(): void {
    const w = this.def.weather;
    this.exposeExport({
      seconds: 1,
      files: this.clouds ? [{ name: "sky-clouds.png", texture: this.clouds }] : undefined,
      meta: (c) => ({
        version: c.version,
        units: c.units,
        up: c.up,
        kind: this.place.kind,
        geo: { ...this.files.route.frame, note: "the route frame: +X east, −Z north, y metres above sea level" },
        sun: { direction: [this.sunDir.x, this.sunDir.y, this.sunDir.z] },
        fog: c.fog,
        hemisphere: c.hemisphere,
        directionalLights: c.directionalLights,
        environment: c.environment,
        camera: c.camera,
        ...c.special,
        tracks: c.tracks,
        post: this.postMeta(),
        snow: this.snow.annotation(),
        route: { id: this.files.route.id, length: this.line.length, car: { ...KEI }, exposure: w.exposure },
      }),
    });
  }

  protected toggleCinematic(): void {
    this.driving = !this.driving;
    if (this.driving) {
      this.chase.ready = false;
      this.ctx.overlay.setCinematic(false);
    } else this.rig.startCinematic();
    this.hud.show(this.driving);
  }

  enter(): void {
    super.enter();
    this.hud.show(this.driving);
    if (this.driving && this.trip.phase === "ready") {
      const a = this.stops[0];
      const b = this.stops[this.stops.length - 1];
      this.hud.panel(`<h2>${a.name} → ${b.name}</h2><p>${a.native} → ${b.native} · ${(this.line.length / 1000).toFixed(1)} km</p><p>Press <kbd>W</kbd> to set off</p>`);
    }
  }

  leave(): void {
    this.hud.show(false);
    super.leave();
  }

  /** Local time of the drive: departure plus the seconds at the wheel. */
  private clock(): string {
    const t = new Date(new Date(this.def.departure).getTime() + this.trip.seconds * 1000);
    return new Intl.DateTimeFormat("en-GB", { timeZone: this.place.timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(t);
  }

  private drive(dt: number): void {
    const c = this.state;
    this.pad.update(dt, Math.abs(c.vx));
    for (const k of this.pad.pressed()) {
      if (k === "v") this.view = this.view === "chase" ? "hood" : "chase";
      if (k === "r") {
        // Back to the last stop reached, in the left lane.
        this.state = startState(this.surface, Math.max(12, this.stops[this.trip.reached].s), -1.65);
        this.traffic = newTraffic(this.state.s, this.line.length);
        this.chase.ready = false;
        return;
      }
    }
    const before = c.odometer;
    const wheel = this.auto > 0 ? autopilot(c, this.line, this.auto, -1.65) : this.pad.controls;
    const input = this.trip.phase === "arrived" ? { steer: wheel.steer, throttle: 0, brake: 1 } : wheel;
    stepCar(c, input, this.surface, dt);
    if (stepTraffic(this.traffic, c, this.line.length, dt)) {
      // Both stop where they met.
      c.vx = 0;
      c.vy = 0;
      c.yawRate = 0;
      this.trip.scrapes++;
      this.hud.say("Easy — keep to the left lane", 4);
    }
    this.fleet.pose(this.traffic, this.line);
    for (const e of stepTrip(this.trip, c, this.stops, dt, c.odometer - before, c.scrape === 0 && c.impact > 1.5)) {
      if (e.type === "stop") this.hud.say(`<b>${this.stops[e.index].name}</b> · ${this.stops[e.index].native}`);
      else {
        const t = this.trip;
        const mm = Math.floor(t.seconds / 60);
        const ss = Math.floor(t.seconds % 60);
        this.hud.panel(
          `<h2>${this.stops[this.stops.length - 1].name}</h2><p>${this.stops[this.stops.length - 1].native}</p><dl><dt>Distance</dt><dd>${(t.metres / 1000).toFixed(1)} km</dd><dt>Time</dt><dd>${mm}:${String(ss).padStart(2, "0")}</dd><dt>Average</dt><dd>${((t.metres / Math.max(1, t.seconds)) * 3.6).toFixed(0)} km/h</dd><dt>Top speed</dt><dd>${(t.top * 3.6).toFixed(0)} km/h</dd><dt>Snowbank touches</dt><dd>${t.scrapes}</dd></dl>`,
        );
      }
    }
    if (this.trip.phase === "driving" && this.trip.seconds < 0.5) this.hud.panel("");
    this.sound = driveSound(c, c.reverse ? input.brake : input.throttle, this.sound, dt);
    this.audio.update(this.sound);
    this.car.pose(c, input.brake > 0.1 && !c.reverse);
    stepChase(this.chase, c, this.view, dt, this.eye);
    this.camera.position.set(...this.eye.pos);
    this.camera.lookAt(...this.eye.target);
    if (Math.abs(this.camera.fov - this.eye.fov) > 0.01) {
      this.camera.fov = this.eye.fov;
      this.camera.updateProjectionMatrix();
    }
    this.car.root.visible = this.view !== "hood";
    const ns = nextStop(this.stops, c.s);
    const limit = this.files.route.limits.reduce((v, l) => (l.s <= c.s ? l.kmh : v), 0);
    this.hud.update(Math.abs(c.vx) * 3.6, c.s, ns.index, ns.metres, this.clock(), limit);
  }

  frame(dt: number, time: number): void {
    if (this.driving) this.drive(dt);
    else {
      this.car.root.visible = true;
      this.rig.update(dt, time);
      this.sound = { ...QUIET, rpm: this.sound.rpm + (900 - this.sound.rpm) * Math.min(1, dt * 3) };
      this.audio.update(this.sound);
    }
    this.camera.updateMatrixWorld();
    this.advance(dt, time);
    const u = this.post.grade.uniforms;
    u.get("uFade")!.value = this.driving ? 0 : this.rig.fade;
    const bars = u.get("uBars")!;
    bars.value += ((!this.driving && this.rig.mode === "cinematic" ? 1 : 0) - bars.value) * (1 - Math.exp(-dt * 2.5));
    this.post.render(dt);
  }

  protected advance(dt: number, time: number): void {
    this.streamClock -= dt;
    if (this.streamClock <= 0) {
      this.streamClock = 0.1;
      this.streamer.update(this.camera.position.x, this.camera.position.z);
    }
    this.sky.update(time, this.camera.position);
    this.snow.update(dt, time, this.camera, this.ctx.canvas.height);
    for (const u of this.world.updaters) u(dt, time);
    if (this.ctx.params.stats) {
      const st = this.streamer.stats;
      this.hud.say(`${st.built} cells · ${(st.ms / Math.max(1, st.built)).toFixed(0)} ms each · ${this.streamer.outstanding} to come · ${(this.state.s / 1000).toFixed(2)} km`, 1);
    }
  }

  dispose(): void {
    this.pad.dispose();
    this.hud.dispose();
    this.snow.dispose();
    this.scene.remove(this.snow.mesh);
    this.streamer.dispose();
    this.scene.remove(this.streamer.group);
    this.kit.dispose();
    super.dispose();
  }
}

export type { RouteJson };
