import {
  AdditiveBlending,
  BackSide,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type PerspectiveCamera,
} from "three";
import { Rng } from "../../../core/random";
import { LAYER_NO_REFLECT } from "../gfx/layers";
import type { FogLight } from "./post";

const MAX_LIGHTS = 16;
const MAX_DRY = 8;

const LIGHT_PARS = /* glsl */ `
uniform vec4 uLPos[${MAX_LIGHTS}];
uniform vec4 uLCol[${MAX_LIGHTS}];
uniform int uLCount;
uniform vec3 uAmbient;
uniform vec3 uDryMin[${MAX_DRY}];
uniform vec3 uDryMax[${MAX_DRY}];
uniform int uDryCount;
vec3 lightAt(vec3 p) {
  vec3 c = uAmbient;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLCount) break;
    vec3 d = uLPos[i].xyz - p;
    float r = uLPos[i].w;
    c += uLCol[i].rgb * (r * r) / (dot(d, d) + r * r);
  }
  return c;
}
bool isDry(vec3 p) {
  for (int i = 0; i < ${MAX_DRY}; i++) {
    if (i >= uDryCount) break;
    if (all(greaterThan(p, uDryMin[i])) && all(lessThan(p, uDryMax[i]))) return true;
  }
  return false;
}
float rHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

const STREAK_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uBox;
uniform vec3 uWind;
uniform float uSpeed;
uniform float uLen;
uniform float uWidth;
uniform float uPixel;
attribute vec4 aSeed;
varying vec3 vColor;
varying vec2 vUv;
varying float vAlpha;
${LIGHT_PARS}
void main() {
  float sp = uSpeed * (0.85 + 0.3 * aSeed.w);
  vec3 vel = vec3(uWind.x, -sp, uWind.z);
  vec3 origin = uCamPos - vec3(uBox.x * 0.5, uBox.y * 0.3, uBox.z * 0.5);
  vec3 p = aSeed.xyz * uBox + vel * uTime;
  p = origin + mod(p - origin, uBox);
  vec3 toCam = uCamPos - p;
  float dist = length(toCam);
  bool hidden = p.y < 0.0 || isDry(p);
  vec3 axis = normalize(vel);
  vec3 side = normalize(cross(axis, toCam / dist));
  // Keep streaks at least ~1.3 px wide; thinner ones fade instead (no shimmer).
  float minW = dist * uPixel * 1.3;
  float wdt = max(uWidth, minW);
  float len = uLen * (0.7 + 0.6 * aSeed.w);
  vec3 wp = p + side * position.x * wdt + axis * (position.y - 0.5) * len;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (hidden) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = vec2(position.x + 0.5, position.y);
  vColor = lightAt(p);
  vAlpha = (uWidth / wdt) * smoothstep(0.35, 1.4, dist) * (1.0 - smoothstep(uBox.x * 0.32, uBox.x * 0.5, dist));
}
`;

const STREAK_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying vec2 vUv;
varying float vAlpha;
void main() {
  float e = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float along = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
  float a = e * e * along * vAlpha * uOpacity;
  gl_FragColor = vec4(vColor * a, a);
}
`;

const SPLASH_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCenter;
uniform float uArea;
uniform vec3 uCamPos;
attribute vec4 aSeed;
varying vec3 vColor;
varying vec2 vUv;
varying float vLife;
varying float vKind;
${LIGHT_PARS}
void main() {
  float rate = 1.1 + aSeed.z * 1.3;
  float cyc = uTime * rate + aSeed.w * 17.0;
  float id = floor(cyc);
  vLife = fract(cyc);
  vec2 r = vec2(rHash(aSeed.xy * 131.7 + id), rHash(aSeed.yx * 71.3 + id * 1.7));
  vec3 p = vec3(uCenter.x + (r.x - 0.5) * uArea, 0.0, uCenter.z + (r.y - 0.5) * uArea);
  vKind = rHash(vec2(id, aSeed.z * 97.0));
  float size = mix(0.05, 0.11, aSeed.x);
  vec3 toCam = uCamPos - p;
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 wp = p + right * position.x * size * 2.0 + vec3(0.0, 1.0, 0.0) * position.y * size * 1.4;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  float d = length(toCam);
  if (isDry(p + vec3(0.0, 0.05, 0.0)) || d > uArea * 0.55) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = vec2(position.x, position.y);
  vColor = lightAt(p + vec3(0.0, 0.1, 0.0)) * smoothstep(uArea * 0.55, uArea * 0.3, d);
}
`;

const SPLASH_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying vec2 vUv;
varying float vLife;
varying float vKind;
void main() {
  float t = vLife;
  float a = 0.0;
  // crown droplets thrown out on parabolas
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float dir = (fi - 2.0) / 2.0;
    float x = dir * t * 0.9;
    float y = (4.0 * t * (1.0 - t)) * (0.55 + 0.35 * fract(fi * 0.618 + vKind)) ;
    vec2 d = vec2(vUv.x - x, vUv.y - y);
    a += smoothstep(0.08, 0.0, length(d * vec2(1.0, 0.8)));
  }
  // flattened ring at the impact point
  float ring = abs(length(vec2(vUv.x, vUv.y * 5.0)) - t * 0.9);
  a += smoothstep(0.06, 0.0, ring) * 0.6 * step(vUv.y, 0.12);
  a *= (1.0 - t) * (1.0 - t) * uOpacity;
  gl_FragColor = vec4(vColor * a, a);
}
`;

// Water running off edges (sign bands, balconies, eaves): each instance is a
// stream anchored on an edge segment; drops fall under gravity and restart.
const DRIP_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCamPos;
attribute vec4 aSeed;
attribute vec3 aA;
attribute vec3 aB;
varying vec3 vColor;
varying vec2 vUv;
varying float vAlpha;
${LIGHT_PARS}
void main() {
  vec3 edge = mix(aA, aB, aSeed.x);
  float period = 0.35 + aSeed.y * 1.1;
  float ph = fract(uTime / period + aSeed.z * 7.0);
  float fallT = ph * period;
  float y = edge.y - 0.5 * 9.8 * fallT * fallT;
  vec3 p = vec3(edge.x, y, edge.z);
  float speed = 9.8 * fallT + 0.5;
  float len = clamp(speed * 0.02, 0.03, 0.25);
  vec3 toCam = uCamPos - p;
  float dist = length(toCam);
  vec3 axis = vec3(0.0, -1.0, 0.0);
  vec3 side = normalize(cross(axis, toCam / dist));
  float wdt = max(0.006, dist * 0.0012);
  vec3 wp = p + side * position.x * wdt + axis * (position.y - 0.5) * len;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (y < 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = vec2(position.x + 0.5, position.y);
  vColor = lightAt(p) * 1.4;
  vAlpha = (0.006 / wdt) * smoothstep(0.3, 1.0, dist) * (1.0 - smoothstep(18.0, 30.0, dist));
}
`;

// Kitchen exhaust steam: soft billboards puffed out of a vent, rising,
// swelling and thinning, lit by the nearby lights.
const STEAM_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCamPos;
attribute vec4 aSeed;
attribute vec3 aOrigin;
attribute vec3 aDir;
varying vec3 vColor;
varying vec2 vUv;
varying float vAlpha;
${LIGHT_PARS}
void main() {
  float life = 3.2 + aSeed.y * 1.6;
  float t = fract(uTime / life + aSeed.x);
  float age = t * life;
  vec3 p = aOrigin + aDir * (1.0 - exp(-age * 2.2)) * 0.55;
  p.y += age * 0.42 + age * age * 0.04;
  p.x += sin(age * 1.3 + aSeed.z * 6.28) * 0.12 * age + age * 0.18;
  p.z += cos(age * 1.1 + aSeed.w * 6.28) * 0.08 * age;
  float size = 0.18 + age * 0.34;
  vec3 toCam = normalize(uCamPos - p);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 up = cross(toCam, right);
  float rot = aSeed.w * 6.28 + age * 0.4;
  vec2 q = vec2(cos(rot) * position.x - sin(rot) * position.y, sin(rot) * position.x + cos(rot) * position.y);
  vec3 wp = p + (right * q.x + up * q.y) * size;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vUv = position.xy;
  vColor = lightAt(p);
  vAlpha = smoothstep(0.0, 0.08, t) * (1.0 - t) * (1.0 - t);
}
`;

const STEAM_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying vec2 vUv;
varying float vAlpha;
float sh(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float sn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sh(i), sh(i + vec2(1.0, 0.0)), f.x), mix(sh(i + vec2(0.0, 1.0)), sh(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float r = length(vUv);
  float n = sn(vUv * 3.0 + 5.0) * 0.6 + sn(vUv * 7.0) * 0.4;
  float a = smoothstep(1.0, 0.0, r + (n - 0.5) * 0.6);
  a = a * a * vAlpha * uOpacity;
  gl_FragColor = vec4(vColor * a * 0.28, a * 0.16);
}
`;

const SHEET_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SHEET_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uOpacity;
uniform vec3 uCamPos;
varying vec3 vWorld;
float sHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float layer(vec2 uv, float speed, float cols) {
  float col = floor(uv.x * cols);
  float h = sHash(vec2(col, 1.0));
  float y = fract(uv.y * 0.6 + uTime * speed * (0.8 + 0.4 * h) + h * 11.0);
  float streak = smoothstep(0.0, 0.08, y) * smoothstep(0.35, 0.1, y);
  float xw = abs(fract(uv.x * cols) - 0.5);
  return streak * smoothstep(0.22, 0.0, xw) * step(0.55, sHash(vec2(col, floor(uv.y * 0.6 + uTime * speed * (0.8 + 0.4 * h) + h * 11.0))));
}
void main() {
  vec3 d = normalize(vWorld - uCamPos);
  float ang = atan(d.z, d.x);
  vec2 uv = vec2(ang * 6.0, vWorld.y * 0.35);
  float r = layer(uv, 1.6, 30.0) + layer(uv * 1.7 + 3.0, 2.1, 30.0) * 0.7;
  float fadeY = smoothstep(-1.0, 3.0, vWorld.y) * (1.0 - smoothstep(12.0, 22.0, vWorld.y));
  float a = r * uOpacity * fadeY;
  gl_FragColor = vec4(uColor * a, a);
}
`;

function lightUniforms() {
  return {
    uLPos: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector4()) },
    uLCol: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector4()) },
    uLCount: { value: 0 },
    uAmbient: { value: new Color(0.05, 0.06, 0.08) },
    uDryMin: { value: Array.from({ length: MAX_DRY }, () => new Vector3()) },
    uDryMax: { value: Array.from({ length: MAX_DRY }, () => new Vector3()) },
    uDryCount: { value: 0 },
  };
}

/**
 * Rain: camera-anchored instanced streaks (lit by nearby fog lights), ground
 * splashes, and a far curtain cylinder that sells density down the street.
 */
export class Rain {
  readonly group = new Group();
  private streaks: ShaderMaterial;
  private splashes: ShaderMaterial;
  private sheet: ShaderMaterial;
  private sheetMesh: Mesh;
  private lights: FogLight[] = [];
  intensity = 1;
  /** Horizontal wind (m/s) on x and z. */
  readonly wind = new Vector2(0.9, 0.35);

  constructor(drops: number, splashes: number, dry: [Vector3, Vector3][]) {
    const rng = new Rng(77);
    // ---- streaks
    const quad = new InstancedBufferGeometry();
    quad.setAttribute("position", new Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(drops * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rng.next();
    quad.setAttribute("aSeed", new InstancedBufferAttribute(seeds, 4));
    quad.instanceCount = drops;
    this.streaks = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: new Vector3() },
        uBox: { value: new Vector3(30, 18, 30) },
        uWind: { value: new Vector3(0.9, 0, 0.35) },
        uSpeed: { value: 9.5 },
        uLen: { value: 0.55 },
        uWidth: { value: 0.0045 },
        uPixel: { value: 0.001 },
        uOpacity: { value: 0.9 },
        ...lightUniforms(),
      },
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const sm = new Mesh(quad, this.streaks);
    sm.frustumCulled = false;
    sm.renderOrder = 10;
    sm.layers.set(LAYER_NO_REFLECT);
    this.group.add(sm);

    // ---- splashes
    const sq = new InstancedBufferGeometry();
    sq.setAttribute("position", new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    sq.setIndex([0, 1, 2, 0, 2, 3]);
    const ss = new Float32Array(splashes * 4);
    for (let i = 0; i < ss.length; i++) ss[i] = rng.next();
    sq.setAttribute("aSeed", new InstancedBufferAttribute(ss, 4));
    sq.instanceCount = splashes;
    this.splashes = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new Vector3() },
        uArea: { value: 26 },
        uCamPos: { value: new Vector3() },
        uOpacity: { value: 1.3 },
        ...lightUniforms(),
      },
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const spm = new Mesh(sq, this.splashes);
    spm.frustumCulled = false;
    spm.renderOrder = 11;
    spm.layers.set(LAYER_NO_REFLECT);
    this.group.add(spm);

    // ---- far curtain
    this.sheet = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color(0.55, 0.6, 0.72) },
        uOpacity: { value: 0.08 },
        uCamPos: { value: new Vector3() },
      },
      vertexShader: SHEET_VERT,
      fragmentShader: SHEET_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: BackSide,
    });
    this.sheetMesh = new Mesh(new CylinderGeometry(16, 16, 26, 48, 1, true), this.sheet);
    this.sheetMesh.frustumCulled = false;
    this.sheetMesh.renderOrder = 9;
    this.sheetMesh.layers.set(LAYER_NO_REFLECT);
    this.group.add(this.sheetMesh);

    for (const mat of [this.streaks, this.splashes]) {
      const u = mat.uniforms;
      dry.slice(0, MAX_DRY).forEach(([a, b], i) => {
        (u.uDryMin.value as Vector3[])[i].copy(a);
        (u.uDryMax.value as Vector3[])[i].copy(b);
      });
      u.uDryCount.value = Math.min(dry.length, MAX_DRY);
    }
  }

  setLights(lights: FogLight[]): void {
    this.lights = lights;
  }

  /** Streams of drops running off the given edges (about 2.5 streams per meter). */
  addDrips(edges: [Vector3, Vector3][], dry: [Vector3, Vector3][]): void {
    const rng = new Rng(311);
    const a: number[] = [];
    const b: number[] = [];
    const seeds: number[] = [];
    for (const [p, q] of edges) {
      const n = Math.max(1, Math.round(p.distanceTo(q) * 2.5));
      for (let i = 0; i < n; i++) {
        a.push(p.x, p.y, p.z);
        b.push(q.x, q.y, q.z);
        seeds.push(rng.next(), rng.next(), rng.next(), rng.next());
      }
    }
    const count = seeds.length / 4;
    if (!count) return;
    const geo = new InstancedBufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute("aA", new InstancedBufferAttribute(new Float32Array(a), 3));
    geo.setAttribute("aB", new InstancedBufferAttribute(new Float32Array(b), 3));
    geo.setAttribute("aSeed", new InstancedBufferAttribute(new Float32Array(seeds), 4));
    geo.instanceCount = count;
    const mat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCamPos: { value: new Vector3() }, uOpacity: { value: 1.2 }, ...lightUniforms() },
      vertexShader: DRIP_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    dry.slice(0, MAX_DRY).forEach(([lo, hi], i) => {
      (mat.uniforms.uDryMin.value as Vector3[])[i].copy(lo);
      (mat.uniforms.uDryMax.value as Vector3[])[i].copy(hi);
    });
    const m = new Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = 10;
    m.layers.set(LAYER_NO_REFLECT);
    this.group.add(m);
    this.drips = mat;
  }

  private drips: ShaderMaterial | null = null;
  private steam: ShaderMaterial | null = null;

  /** Steam puffs from vents: `origin` on the wall, `dir` the outward push. */
  addSteam(vents: { origin: Vector3; dir: Vector3 }[], perVent = 26): void {
    if (!vents.length) return;
    const rng = new Rng(733);
    const o: number[] = [];
    const d: number[] = [];
    const s: number[] = [];
    for (const v of vents)
      for (let i = 0; i < perVent; i++) {
        o.push(v.origin.x, v.origin.y, v.origin.z);
        d.push(v.dir.x, v.dir.y, v.dir.z);
        s.push(i / perVent + rng.range(0, 0.02), rng.next(), rng.next(), rng.next());
      }
    const geo = new InstancedBufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute("aOrigin", new InstancedBufferAttribute(new Float32Array(o), 3));
    geo.setAttribute("aDir", new InstancedBufferAttribute(new Float32Array(d), 3));
    geo.setAttribute("aSeed", new InstancedBufferAttribute(new Float32Array(s), 4));
    geo.instanceCount = s.length / 4;
    this.steam = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCamPos: { value: new Vector3() }, uOpacity: { value: 1 }, ...lightUniforms() },
      vertexShader: STEAM_VERT,
      fragmentShader: STEAM_FRAG,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
    });
    const m = new Mesh(geo, this.steam);
    m.frustumCulled = false;
    m.renderOrder = 8;
    m.layers.set(LAYER_NO_REFLECT);
    this.group.add(m);
  }

  update(time: number, camera: PerspectiveCamera, focus: Vector3, viewportHeight: number): void {
    const cam = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    // Nearest lights to the camera light the drops.
    const ranked = this.lights
      .filter((l) => (l.gain ?? 1) * l.intensity > 0.001)
      .map((l) => ({ l, d: l.position.distanceToSquared(cam) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_LIGHTS);
    const mats = [this.streaks, this.splashes];
    if (this.drips) mats.push(this.drips);
    if (this.steam) mats.push(this.steam);
    for (const mat of mats) {
      const u = mat.uniforms;
      u.uTime.value = time;
      (u.uCamPos.value as Vector3).copy(cam);
      ranked.forEach(({ l }, i) => {
        const g = (l.gain ?? 1) * l.intensity * 2.2;
        (u.uLPos.value as Vector4[])[i].set(l.position.x, l.position.y, l.position.z, Math.max(0.8, l.radius * 2.5));
        (u.uLCol.value as Vector4[])[i].set(l.color.r * g, l.color.g * g, l.color.b * g, 0);
      });
      u.uLCount.value = ranked.length;
    }
    this.streaks.uniforms.uOpacity.value = 0.9 * this.intensity;
    (this.streaks.uniforms.uWind.value as Vector3).set(this.wind.x, 0, this.wind.y);
    this.streaks.uniforms.uPixel.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight);
    (this.splashes.uniforms.uCenter.value as Vector3).set(focus.x * 0.5 + cam.x * 0.5, 0, focus.z * 0.5 + cam.z * 0.5);
    this.splashes.uniforms.uOpacity.value = 1.3 * this.intensity;
    this.sheet.uniforms.uTime.value = time;
    (this.sheet.uniforms.uCamPos.value as Vector3).copy(cam);
    this.sheet.uniforms.uOpacity.value = 0.08 * this.intensity;
    this.sheetMesh.position.set(cam.x, 11, cam.z);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.streaks.dispose();
    this.splashes.dispose();
    this.drips?.dispose();
    this.steam?.dispose();
    this.sheet.dispose();
  }
}
