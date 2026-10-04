import { Color, FogExp2, HemisphereLight, PerspectiveCamera, Vector3 } from "three";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { Baker } from "../shared/bake";
import type { Box6, Shot, ShotKey } from "../shared/camera";
import { batchStatic, bearing } from "../shared/geo";
import { createPlacePost, type PostLook } from "../shared/post";
import { skyColor, type Sky, type SkySpec } from "../shared/sky";
import { PlaceStage } from "../shared/stage";
import { GriffithAudio } from "./audio";
import { GriffithWorld } from "./world/context";
import { GEO, LOOP, SUN, SUN_DIR, VIEW } from "./world/layout";
import { buildObservatory } from "./world/observatory";
import { groundY } from "./world/dem";
import { LEVEL } from "./world/observatory/plan";
import { HAZE } from "./world/haze";
import { buildLife } from "./world/life";
import { BLUE_HOUR, buildBlueHourSky } from "./world/sky";
import { buildVista } from "./world/vista";

/**
 * A shot key from an eye position, a compass heading and a pitch (degrees).
 * The target sits 25 m out, inside FOCUS, so the free camera (`?shot&cam=`)
 * keeps the framing instead of clamping a far target and moving the eye.
 */
function key(pos: [number, number, number], heading: number, pitch: number, fov: number): ShotKey {
  const d = bearing(heading, pitch);
  return { pos, target: [pos[0] + d.x * 25, pos[1] + d.y * 25, pos[2] + d.z * 25], fov };
}

/** Eye heights over the bare-earth DEM (trails and lookouts outside the building). */
const groundAt = (x: number, z: number): number => groundY(x, z);

const S = VIEW.sign;

const SHOTS: Shot[] = [
  {
    // The front lawn west of the monument, looking SSE at the lit north façade
    // (p04): the entrance 6° left of centre, the west dome large on the right,
    // the east dome on the left, the planetarium dome and the green rotunda
    // roof behind. Solved from p04's dome and entrance bearings (the photo's
    // geotag is ~20 m off).
    name: "Lawn",
    from: key([-13.2, groundAt(-13.2, -89.2) + 1.62, -89.2], 170.5, 8, 38),
    to: key([-11.8, groundAt(-11.8, -88) + 1.62, -88], 172.5, 8, 38),
    duration: 12,
  },
  {
    // The roof walkway on the drum's west side over the basin (p09, 31 Aug
    // 2015, A's reading of the photo): the arcade and the uplit drum at the
    // left, the parapet, the grid running to the vanishing point due south,
    // the pale horizon band under the navy sky.
    name: "Terrace",
    from: key([-16.7, LEVEL.deck + 1.62, -2.0], 172, 2, 40),
    to: key([-16.3, LEVEL.deck + 1.62, -1.2], 177, 2.5, 40),
    duration: 12,
  },
  {
    // O3: the Hollywood Sign and the Mt Lee tower over the west lawn (p13, p22).
    name: "Sign",
    from: key([S.x, S.eye, S.z], 311.2, 3, 14),
    to: key([S.x - 0.5, S.eye, S.z - 0.3], 312.4, 3.1, 14),
    duration: 10,
  },
  {
    // The Mt Hollywood trail 42 m east of the Tiffany & Co. Foundation
    // Overlook, telephoto (p02, Dec 2013): solved from p02's bearings to the
    // three domes, the entrance and the US Bank Tower crown plus the tower
    // top's height over the dome (6 px RMS at 960 px): eye (−438, 44.2,
    // −912) on the DEM, heading 153.0°, horizontal FOV 5.6°, pitch −1.4°.
    // The US Bank Tower stands 2.4° left of the east dome.
    name: "Overlook",
    from: key([-441, groundAt(-441, -911) + 1.6, -911], 152.8, -1.4, 3.15),
    to: key([-435, groundAt(-435, -913) + 1.6, -913], 153.2, -1.4, 3.15),
    duration: 12,
  },
  {
    // The drum from the hillside path below the west terrace (p01: the
    // "lookout just below"), 108 m WSW and 45 m below the drum's foot: the
    // uplit drum over the oaks, the west dome to its left.
    name: "Drum",
    from: key([-104, groundAt(-104, 43) + 1.6, 43], 58, 23, 32),
    to: key([-99, groundAt(-99, 39) + 1.6, 39], 61, 24, 32),
    duration: 11,
  },
  {
    // The east deck's south parapet looking SSE (p14): downtown left of
    // centre, the grid's vanishing line right, the uplit drum at the right
    // edge, visitors on the lower east terrace below.
    name: "Roof",
    from: key([25.6, LEVEL.deck + 1.62, -9.3], 180, -14, 44),
    to: key([24.4, LEVEL.deck + 1.62, -9.1], 185, -14, 44),
    duration: 11,
  },
];

/** Camera volumes: the lawn and walks, the terraces and roof decks, the hillside lookout, the overlook. */
const WALKABLE: Box6[] = [
  [-60, 0.5, -170, 60, 6, -30],
  [-50, 0, -40, 50, 14, 40],
  [-110, -52, 30, -92, -35, 50],
  [-500, 30, -935, -425, 50, -890],
];
/** Orbit targets: the grounds and every shot's target (the Overlook 1 km north, the hillside below the drum). */
const FOCUS: Box6 = [-520, -100, -940, 120, 60, 130];
/** Intro: from high over Mount Hollywood (NNW, the Overlook's bearing), the observatory against the lit basin. */
const INTRO_FROM: ShotKey = { pos: [-900, 330, -1700], target: [0, 8, 0], fov: 24 };

/**
 * Sky light for the hemisphere: the dome's cosine-weighted mean over the
 * upper hemisphere (not its zenith), moved `desat` of the way to its
 * luminance grey so shade reads a soft grey-blue as in the photos, ×π
 * (three's hemisphere colour is irradiance; a white wall facing up then
 * shows the mean sky radiance).
 */
function hemisphereSky(s: SkySpec, desat: number): Color {
  const acc = new Color(0, 0, 0);
  let wsum = 0;
  const d = new Vector3();
  for (let i = 0; i < 24; i++) {
    const el = ((i + 0.5) / 24) * (Math.PI / 2);
    for (let j = 0; j < 36; j++) {
      const az = (j / 36) * Math.PI * 2;
      d.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
      const w = Math.sin(el) * Math.cos(el);
      acc.add(skyColor(s, d).multiplyScalar(w));
      wsum += w;
    }
  }
  acc.multiplyScalar(1 / wsum);
  const l = 0.2126 * acc.r + 0.7152 * acc.g + 0.0722 * acc.b;
  return acc.lerp(new Color(l, l, l), desat).multiplyScalar(Math.PI);
}

/**
 * Light balance at blue hour. No sun: the hemisphere carries the twilight
 * sky (its mean, desaturated, not the zenith) and the ground bounce; the
 * probe adds the reflections the domes and glass need. Exposure 1: the sky
 * terms are fitted through the post at that exposure (world/sky.ts).
 */
const LIGHT = {
  desat: 0.75,
  hemisphere: 1.0,
  ground: new Color(0.02, 0.017, 0.014),
  probeAt: new Vector3(0, 14, -62),
  probe: 0.6,
  probeSky: 0.3,
  exposure: 1.0,
};

/**
 * Blue-hour finish, checked against p09 (sky profile, horizon band, carpet
 * mean), p01 (drum, dome, sky, hillside) and p04 (façade, window, globe,
 * lawn): AgX; bloom only on lamp globes, headlamps and the brightest
 * points (threshold 1.2, so the carpet's points keep sharp cores as in p09);
 * a slight cool lift in the shadows and warm gain in the highlights;
 * light grain (the dark frame shows it strongly). The sky in world/sky.ts
 * is fitted through exactly this grade.
 */
const LOOK: PostLook = {
  tone: "agx",
  ao: { radius: 0.8, intensity: 2.0, color: [0, 0, 0] },
  bloom: { threshold: 1.2, smoothing: 0.5, intensity: 0.4, radius: 0.55, levels: 7 },
  grade: { grain: 0.008, vignette: 0.25, lift: [0.02, 0.03, 0.06], gain: [1.02, 1.0, 0.96], saturation: 1.15, contrast: 1.05 },
};

export class GriffithStage extends PlaceStage<GriffithWorld, GriffithAudio> {
  private sky!: Sky;

  private constructor(ctx: StageContext, place: PlaceDef) {
    super(ctx, place, new PerspectiveCamera(40, 1, 0.3, 120000), { shots: SHOTS, walkable: WALKABLE, focus: FOCUS, intro: INTRO_FROM, introSeconds: 8, viewFov: 40 }, new GriffithAudio(ctx.audio));
  }

  static async create(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<GriffithStage> {
    const s = new GriffithStage(ctx, place);
    await s.build(progress);
    return s;
  }

  private async build(progress: Progress): Promise<void> {
    const { renderer, quality } = this.ctx;
    renderer.shadowMap.enabled = false;
    // The vista haze (world/haze.ts) replaces three's fog chunks; the scene fog
    // stays only as the export's `fog` field, at zero density.
    this.scene.fog = new FogExp2(BLUE_HOUR.horizon.clone(), 0);
    this.scene.background = BLUE_HOUR.zenith.clone();

    await progress(0.05, "Pouring the concrete");
    this.baker = new Baker(renderer);
    const world = (this.world = new GriffithWorld(this.baker, quality));

    await progress(0.2, "Raising the domes");
    buildObservatory(world);

    await progress(0.45, "Lighting the basin");
    buildVista(world);

    await progress(0.7, "Waiting for blue hour");
    this.sky = buildBlueHourSky(world);
    buildLife(world);
    // Sky light from the twilight dome (soft grey-blue); the ground side is the
    // dark chaparral below with the lit basin's faint warm bounce.
    world.root.add(new HemisphereLight(hemisphereSky(BLUE_HOUR, LIGHT.desat), LIGHT.ground, LIGHT.hemisphere));

    await progress(0.8, "Batching geometry");
    const stats = batchStatic(world.root, { preserveObjects: this.ctx.params.exporting });
    console.info(`[griffith] batched ${stats.before} meshes into ${stats.after}`);
    this.scene.add(world.root);
    HAZE.apply(this.scene);

    await progress(0.88, "Capturing the terrace");
    // The probe hangs over the lawn in front of the façade: the sky, the lit
    // north front, the park and (past the domes) the basin's horizon band.
    this.captureProbe(LIGHT.probeAt, {
      near: 0.3,
      far: 60000,
      intensity: LIGHT.probe,
      before: () => {
        this.sky.setProbe(LIGHT.probeSky);
        for (const u of this.world.updaters) u(0, this.ctx.params.startTime);
      },
      after: () => this.sky.setProbe(0),
    });

    await progress(0.94, "Grading the evening");
    this.post = createPlacePost(renderer, this.scene, this.camera, quality, LOOK);
    renderer.toneMappingExposure = LIGHT.exposure;
    this.startRig();
    await progress(1, "Lights on");
    if (this.ctx.params.exporting) this.exposeGriffithExport();
  }

  /** `window.pocketAtlasExport()` → glTF and environment for the cooker. */
  private exposeGriffithExport(): void {
    this.exposeExport({
      seconds: LOOP,
      meta: (c, seconds) => ({
        version: c.version,
        units: c.units,
        up: c.up,
        kind: this.place.kind,
        geo: {
          lat: GEO.lat,
          lon: GEO.lon,
          datum: GEO.datum,
          address: GEO.address,
          note: "origin at the planetarium dome's centre; +X east, −Z north; y above the front lawn (346.0 m above sea level); sea level at y = −346",
        },
        sun: { azimuth: SUN.azimuth, elevation: SUN.elevation, direction: SUN_DIR.toArray(), note: "below the horizon: no sun light, sky only" },
        fog: c.fog,
        hemisphere: c.hemisphere,
        directionalLights: c.directionalLights,
        environment: c.environment,
        camera: c.camera,
        ...c.special,
        tracks: c.tracks,
        loop: { seconds },
        post: this.postMeta(),
        haze: HAZE.annotation(),
      }),
    });
  }

  dispose(): void {
    super.dispose();
    HAZE.remove();
  }

  protected advance(dt: number, time: number): void {
    for (const u of this.world.updaters) u(dt, time);
    this.sky.update(time, this.camera.position);
    this.audio.update(dt, time, this.camera);
  }
}
