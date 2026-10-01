import {
  AnimationClip,
  CanvasTexture,
  Color,
  Group,
  HemisphereLight,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Points,
  QuaternionKeyframeTrack,
  RectAreaLight,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  VectorKeyframeTrack,
  type Light,
  type WebGLCubeRenderTarget,
  type WebGLRenderer,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Baker } from "./gfx/bake";
import type { ShotKey, Shot } from "./camera";
import type { World } from "./world/context";

/**
 * Exports the built Tokyo scene as glTF 2.0 (binary) plus `extras.pocketAtlas`
 * metadata, the input of the Pocket Atlas cooker. Everything the web renderer
 * computes in patched shaders is carried as explicit, JSON-safe parameters;
 * procedural motion (people, the taxi) is sampled into glTF animations and
 * scalar tracks.
 */

export interface ExportInput {
  renderer: WebGLRenderer;
  world: World;
  baker: Baker;
  env: WebGLCubeRenderTarget | null;
  envPosition: [number, number, number];
  shots: Shot[];
  walkable: number[][];
  intro: ShotKey;
  shopBox: { min: readonly number[]; max: readonly number[] };
  fog: { color: number[]; density: number };
  haze: { density: number; ambient: number[]; ambientDensity: number };
  environmentIntensity: number;
  doors: { left: Object3D; right: Object3D; open: number };
  /** Seconds of motion to sample into animations. */
  record: number;
  fps: number;
  onProgress?: (label: string) => void;
}

export interface ExportOutput {
  glb: ArrayBuffer;
  env: Uint16Array | null;
  report: Record<string, unknown>;
}

const round = (v: number, p = 1e5) => Math.round(v * p) / p;
const arr = (v: { x: number; y: number; z: number }) => [round(v.x), round(v.y), round(v.z)];
const col = (c: Color) => [round(c.r), round(c.g), round(c.b)];

function safeName(o: Object3D): string {
  const base = (o.name || o.type).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);
  return `${base}_${o.id}`;
}

/** JSON-safe copy of a pocketAtlas annotation (textures become a marker). */
function clean(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "number") return Number.isFinite(v) ? round(v, 1e6) : 0;
  if (typeof v !== "object") return v;
  if ((v as Texture).isTexture) return "texture";
  if (Array.isArray(v)) return v.map(clean);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clean(x);
  return out;
}

// ------------------------------------------------------------------ textures

class Textures {
  private cache = new Map<string, Texture>();
  readonly converted: string[] = [];
  constructor(
    private renderer: WebGLRenderer,
    private baker: Baker,
  ) {}

  /** A texture GLTFExporter can encode (render-target bakes are read back into canvases). */
  convert(t: Texture | null | undefined): Texture | null {
    if (!t) return null;
    const hit = this.cache.get(t.uuid);
    if (hit) return hit;
    let out: Texture = t;
    const rt = this.baker.targetOf(t);
    if (rt) {
      const w = rt.width;
      const h = rt.height;
      const px = new Uint8Array(w * h * 4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d")!;
      const img = g.createImageData(w, h);
      // WebGL rows run bottom-up; canvas rows top-down.
      for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      g.putImageData(img, 0, 0);
      const ct = new CanvasTexture(c);
      ct.flipY = true;
      this.converted.push(t.uuid);
      out = ct;
    }
    if (out !== t) {
      out.colorSpace = t.colorSpace;
      out.wrapS = t.wrapS;
      out.wrapT = t.wrapT;
      out.repeat.copy(t.repeat);
      out.offset.copy(t.offset);
      out.name = t.name;
    }
    this.cache.set(t.uuid, out);
    return out;
  }

  /** White RGB with the alpha map in A (glTF has no separate alpha texture). */
  alphaAsBase(alpha: Texture): Texture {
    const key = `alpha:${alpha.uuid}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const src = this.convert(alpha)!;
    const img = src.image as HTMLCanvasElement;
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      d.data[i + 3] = d.data[i];
      d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
    }
    g.putImageData(d, 0, 0);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.wrapS = alpha.wrapS;
    t.wrapT = alpha.wrapT;
    this.cache.set(key, t);
    return t;
  }
}

// ----------------------------------------------------------------- materials

class Materials {
  private cache = new Map<string, Material>();
  constructor(private tex: Textures) {}

  convert(m: Material): Material {
    const hit = this.cache.get(m.uuid);
    if (hit) return hit;
    const out = this.make(m);
    out.name = m.name || m.type;
    this.cache.set(m.uuid, out);
    return out;
  }

  private make(m: Material): Material {
    const pc = (clean(m.userData.pocketAtlas ?? {}) as Record<string, unknown>) ?? {};
    const common = {
      side: m.side,
      transparent: m.transparent,
      opacity: m.opacity,
      alphaTest: m.alphaTest,
      depthWrite: m.depthWrite,
    };
    if ((m as MeshBasicMaterial).isMeshBasicMaterial) {
      const b = m as MeshBasicMaterial;
      if (pc.kind === "products") {
        const pack = this.tex.convert((m.userData.pocketAtlas as { pack?: Texture }).pack);
        const out = new MeshBasicMaterial({ map: pack, vertexColors: false, ...common });
        out.userData = { pocketAtlas: { ...pc, pack: "map" } };
        return out;
      }
      const hdr = b.color.clone();
      const peak = Math.max(hdr.r, hdr.g, hdr.b, 1e-6);
      const out = new MeshBasicMaterial({
        color: peak > 1 ? hdr.clone().multiplyScalar(1 / peak) : hdr,
        map: this.tex.convert(b.map),
        vertexColors: b.vertexColors,
        ...common,
      });
      out.userData = { pocketAtlas: { kind: "unlit", color: col(hdr), fog: b.fog, ...pc } };
      return out;
    }
    const s = m as MeshStandardMaterial;
    const physical = (m as MeshPhysicalMaterial).isMeshPhysicalMaterial ? (m as MeshPhysicalMaterial) : null;
    const params = {
      color: s.color.clone(),
      roughness: s.roughness,
      metalness: s.metalness,
      map: this.tex.convert(s.map),
      normalMap: this.tex.convert(s.normalMap),
      normalScale: s.normalScale.clone(),
      roughnessMap: this.tex.convert(s.roughnessMap),
      metalnessMap: this.tex.convert(s.metalnessMap),
      aoMap: this.tex.convert(s.aoMap),
      aoMapIntensity: s.aoMapIntensity,
      emissive: s.emissive.clone(),
      emissiveMap: this.tex.convert(s.emissiveMap),
      emissiveIntensity: s.emissiveIntensity,
      vertexColors: s.vertexColors,
      ...common,
    };
    if (s.alphaMap && !s.map) {
      params.map = this.tex.alphaAsBase(s.alphaMap);
      params.transparent = true;
    }
    const out = physical
      ? new MeshPhysicalMaterial({ ...params, clearcoat: physical.clearcoat, clearcoatRoughness: physical.clearcoatRoughness })
      : new MeshStandardMaterial(params);
    const extra: Record<string, unknown> = {
      ...pc,
      fog: s.fog,
      envMapIntensity: round(s.envMapIntensity),
      // Emission of interior surfaces carries their lighting; flag it so the
      // Vita shader does not light them twice.
      polygonOffset: s.polygonOffset ? [s.polygonOffsetFactor, s.polygonOffsetUnits] : undefined,
      premultiplied: pc.kind === "glass" ? true : undefined,
      people: m.name.includes("people") || undefined,
    };
    if (s.alphaMap) extra.alphaFromMap = true;
    out.userData = { pocketAtlas: clean(extra) };
    return out;
  }
}

// ----------------------------------------------------------------- recording

interface Track {
  node: Object3D;
  pos: number[];
  quat: number[];
  scale: number[];
  moved: boolean;
}

/**
 * Runs the world's updaters for `seconds` at `fps` and samples every transform
 * below a dynamic subtree, fog-light positions and gains, and material
 * emissive intensities. Returns only what actually changed.
 */
function record(world: World, seconds: number, fps: number) {
  const dynamic: Object3D[] = [];
  world.root.traverse((o) => {
    let under = false;
    for (let p: Object3D | null = o; p; p = p.parent) if (p.userData.dynamic) under = true;
    if (under && !(o as Light).isLight && o.userData.pocketAtlas?.kind !== "sky") dynamic.push(o);
  });
  const tracks: Track[] = dynamic.map((node) => ({ node, pos: [], quat: [], scale: [], moved: false }));
  const fogs = world.fogLights.map(() => ({ pos: [] as number[], gain: [] as number[], moved: false }));
  const mats = new Map<Material, { values: number[]; moved: boolean }>();
  world.root.traverse((o) => {
    const m = (o as Mesh).material as MeshStandardMaterial | undefined;
    if (m && !Array.isArray(m) && "emissiveIntensity" in m && !mats.has(m)) mats.set(m, { values: [], moved: false });
  });
  const frames = Math.round(seconds * fps);
  const dt = 1 / fps;
  const first = new Map<Track, number[]>();
  for (let f = 0; f < frames; f++) {
    const t = f * dt;
    for (const u of world.updaters) u(dt, t);
    for (const tr of tracks) {
      const n = tr.node;
      const v = [n.position.x, n.position.y, n.position.z, n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w, n.scale.x, n.scale.y, n.scale.z];
      if (f === 0) first.set(tr, v);
      else if (!tr.moved) {
        const a = first.get(tr)!;
        if (v.some((x, i) => Math.abs(x - a[i]) > 1e-5)) tr.moved = true;
      }
      tr.pos.push(v[0], v[1], v[2]);
      tr.quat.push(v[3], v[4], v[5], v[6]);
      tr.scale.push(v[7], v[8], v[9]);
    }
    world.fogLights.forEach((l, i) => {
      const s = fogs[i];
      const g = l.gain ?? 1;
      if (f > 0 && (Math.abs(g - s.gain[0]) > 1e-4 || Math.abs(l.position.x - s.pos[0]) > 1e-4 || Math.abs(l.position.z - s.pos[2]) > 1e-4)) s.moved = true;
      s.pos.push(l.position.x, l.position.y, l.position.z);
      s.gain.push(g);
    });
    for (const [m, s] of mats) {
      const e = (m as MeshStandardMaterial).emissiveIntensity;
      if (f > 0 && Math.abs(e - s.values[0]) > 1e-4) s.moved = true;
      s.values.push(e);
    }
  }
  // Back to the first frame's pose for the exported rest state.
  for (const u of world.updaters) u(0, 0);
  return { tracks: tracks.filter((t) => t.moved), fogs, mats, frames };
}

/** Drops keys that linear interpolation of their neighbours reproduces. */
function reduce(times: number[], values: number[], stride: number, eps: number): [number[], number[]] {
  const n = times.length;
  if (n <= 2) return [times, values];
  const keep = [0];
  for (let i = 1; i < n - 1; i++) {
    const a = keep[keep.length - 1];
    const b = i + 1;
    const k = (times[i] - times[a]) / (times[b] - times[a]);
    let err = 0;
    for (let c = 0; c < stride; c++) {
      const lerp = values[a * stride + c] + (values[b * stride + c] - values[a * stride + c]) * k;
      err = Math.max(err, Math.abs(lerp - values[i * stride + c]));
    }
    if (err > eps) keep.push(i);
  }
  keep.push(n - 1);
  return [keep.map((i) => times[i]), keep.flatMap((i) => values.slice(i * stride, i * stride + stride))];
}

// -------------------------------------------------------------------- export

export async function exportPlace(input: ExportInput): Promise<ExportOutput> {
  const { world, renderer } = input;
  const say = input.onProgress ?? (() => {});
  const started = performance.now();

  // Unique, binding-safe names for every node so animation tracks resolve.
  world.root.traverse((o) => (o.name = safeName(o)));

  say("recording motion");
  const rec = record(world, input.record, input.fps);
  const times = Array.from({ length: rec.frames }, (_, i) => i / input.fps);
  const clipTracks = [];
  for (const tr of rec.tracks) {
    const [tp, vp] = reduce(times, tr.pos, 3, 2e-4);
    const [tq, vq] = reduce(times, tr.quat, 4, 5e-4);
    if (tp.length > 2 || vp.some((v, i) => Math.abs(v - vp[i % 3]) > 1e-5)) clipTracks.push(new VectorKeyframeTrack(`${tr.node.name}.position`, tp, vp));
    if (tq.length > 2 || vq.some((v, i) => Math.abs(v - vq[i % 4]) > 1e-5)) clipTracks.push(new QuaternionKeyframeTrack(`${tr.node.name}.quaternion`, tq, vq));
  }
  const clip = new AnimationClip("place", input.record, clipTracks);

  say("converting materials");
  const textures = new Textures(renderer, input.baker);
  const materials = new Materials(textures);
  const root = new Scene();
  root.name = "pocket-atlas";

  // Special objects become scene metadata instead of meshes.
  const special: Record<string, unknown> = {};
  const rectLights: unknown[] = [];
  let hemisphere: unknown = null;
  world.root.updateMatrixWorld(true);
  world.root.traverse((o) => {
    const kind = o.userData.pocketAtlas?.kind;
    if (kind === "sky") special.sky = clean(o.userData.pocketAtlas);
    if (kind === "skyline") {
      const im = o as InstancedMesh;
      const info = im.geometry.getAttribute("aInfo");
      const boxes: number[][] = [];
      const m = new Matrix4();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        const e = m.elements;
        boxes.push([...e.map((v) => round(v, 1e3)), info.getX(i), info.getY(i), info.getZ(i), info.getW(i)].map((v) => round(v, 1e4)));
      }
      special.skyline = { ...(clean(o.userData.pocketAtlas) as object), boxes };
    }
    if (kind === "beacons") {
      const p = (o as Points).geometry.getAttribute("position");
      special.beacons = Array.from({ length: p.count }, (_, i) => [round(p.getX(i)), round(p.getY(i)), round(p.getZ(i))]);
    }
    if ((o as RectAreaLight).isRectAreaLight) {
      const l = o as RectAreaLight;
      const n = new Vector3(0, 0, -1).transformDirection(l.matrixWorld);
      const right = new Vector3(1, 0, 0).transformDirection(l.matrixWorld);
      rectLights.push({ position: arr(l.getWorldPosition(new Vector3())), normal: arr(n), right: arr(right), width: l.width, height: l.height, color: col(l.color), intensity: l.intensity });
    }
    if ((o as HemisphereLight).isHemisphereLight) {
      const h = o as HemisphereLight;
      hemisphere = { sky: col(h.color), ground: col(h.groundColor), intensity: h.intensity };
    }
  });

  const clone = cloneSkinned(world.root) as Group;
  const drop: Object3D[] = [];
  clone.traverse((o) => {
    const kind = o.userData.pocketAtlas?.kind;
    if (kind === "sky" || kind === "skyline" || kind === "beacons" || (o as Points).isPoints || (o as RectAreaLight).isRectAreaLight || (o as HemisphereLight).isHemisphereLight) {
      drop.push(o);
      return;
    }
    const mesh = o as Mesh;
    if (mesh.isMesh) {
      if (kind === "tower") {
        const m = new MeshBasicMaterial({ color: 0xff6020 });
        m.userData = { pocketAtlas: { kind: "tower" } };
        mesh.material = m;
      } else {
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => materials.convert(m)) : materials.convert(mesh.material);
      }
    }
    const light = o as Light & { castShadow?: boolean; angle?: number; penumbra?: number; distance?: number; decay?: number };
    if (light.isLight) o.userData = { pocketAtlas: { castShadow: !!light.castShadow } };
    else if (o.userData.pocketAtlas || o.userData.dynamic) o.userData = { pocketAtlas: clean({ ...(o.userData.pocketAtlas ?? {}), dynamic: !!o.userData.dynamic || undefined }) };
    else o.userData = {};
  });
  for (const o of drop) o.removeFromParent();
  root.add(clone);

  const fogLights = world.fogLights.map((l, i) => ({
    position: arr(l.position),
    color: col(l.color),
    intensity: round(l.intensity),
    radius: round(l.radius),
    spot: l.direction ? { direction: arr(l.direction), cosOuter: round(l.cosOuter ?? 0.5), cosInner: round(l.cosInner ?? 0.9) } : undefined,
    track: rec.fogs[i].moved ? i : undefined,
  }));
  const fogTracks = rec.fogs.map((s, i) => ({ s, i })).filter(({ s }) => s.moved).map(({ s, i }) => ({ fog: i, position: s.pos.map((v) => round(v, 1e3)), gain: s.gain.map((v) => round(v, 1e3)) }));
  const materialTracks = [...rec.mats].filter(([, s]) => s.moved).map(([m, s]) => ({ material: materials.convert(m).name, emissiveIntensity: s.values.map((v) => round(v, 1e3)) }));

  root.userData = {
    pocketAtlas: {
      version: 1,
      units: "m",
      up: "y",
      fog: input.fog,
      haze: { ...input.haze, dryBox: { min: [...input.shopBox.min], max: [...input.shopBox.max] } },
      hemisphere,
      rectLights,
      fogLights,
      environment: input.env ? { file: "env.rgba16f", size: input.env.width, format: "rgba16f-cube", position: input.envPosition, intensity: input.environmentIntensity } : null,
      rain: {
        dryBoxes: world.dryBoxes.map(([a, b]) => [arr(a), arr(b)]),
        dripEdges: world.dripEdges.map(([a, b]) => [arr(a), arr(b)]),
        steamVents: world.steamVents.map((v) => ({ origin: arr(v.origin), dir: arr(v.dir) })),
      },
      camera: { shots: input.shots, walkable: input.walkable, intro: input.intro },
      doors: { left: input.doors.left.name, right: input.doors.right.name, travel: 0.98, trigger: [2.1, 1.0, -3.0], radius: 3.2 },
      ...special,
      tracks: { fps: input.fps, frames: rec.frames, fogs: fogTracks, materials: materialTracks },
    },
  };

  say("encoding glTF");
  const exporter = new GLTFExporter();
  const glb = (await exporter.parseAsync(root, {
    binary: true,
    animations: clipTracks.length ? [clip] : [],
    onlyVisible: false,
    maxTextureSize: 4096,
  })) as ArrayBuffer;

  let env: Uint16Array | null = null;
  if (input.env) {
    say("reading environment");
    const size = input.env.width;
    env = new Uint16Array(6 * size * size * 4);
    for (let f = 0; f < 6; f++) {
      const face = new Uint16Array(size * size * 4);
      renderer.readRenderTargetPixels(input.env, 0, 0, size, size, face, f);
      env.set(face, f * size * size * 4);
    }
  }

  const report = {
    ms: Math.round(performance.now() - started),
    glbBytes: glb.byteLength,
    animatedNodes: rec.tracks.length,
    tracks: clipTracks.length,
    keys: clipTracks.reduce((n, t) => n + t.times.length, 0),
    fogTracks: fogTracks.length,
    materialTracks: materialTracks.length,
    bakedTexturesRead: textures.converted.length,
    rectLights: rectLights.length,
    fogLights: fogLights.length,
  };
  return { glb, env, report };
}

