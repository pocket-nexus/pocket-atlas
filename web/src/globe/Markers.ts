import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  GLSL3,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
  type Camera,
} from "three";
import type { PlaceDef } from "../core/types";
import { latLonToVec } from "./geo";

const LIFT = 0.0016;

const COMMON_VERT = /* glsl */ `
in vec3 iDir;
in vec3 iColor;
in vec4 iState; // live, hover, phase, visibility
uniform float uTime;
uniform float uPx;       // world units per CSS pixel at unit distance
uniform float uDive;     // 0 → 1 while flying in
out vec2 vUv;
out vec3 vColor;
out vec4 vState;
out float vFade;
vec3 surfaceBase() { return (modelMatrix * vec4(iDir * (1.0 + ${LIFT}), 1.0)).xyz; }
vec3 surfaceUp() { return normalize(mat3(modelMatrix) * iDir); }
`;

const DOT_VERT = /* glsl */ `
${COMMON_VERT}
void main() {
  vec3 base = surfaceBase();
  vec3 up = surfaceUp();
  vec3 toCam = cameraPosition - base;
  float dist = length(toCam);
  float live = iState.x;
  float hover = iState.y;
  float sizePx = mix(22.0, 34.0, live) * (1.0 + 0.45 * hover);
  float s = sizePx * uPx * dist;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = base + (right * position.x + camUp * position.y) * s + up * 0.001;
  vUv = position.xy * 2.0;
  vColor = iColor;
  vState = iState;
  vFade = smoothstep(-0.02, 0.2, dot(up, toCam / dist)) * iState.w * (1.0 - uDive);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const DOT_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
float sq(float x) { return x * x; }
float saturate(float x) { return clamp(x, 0.0, 1.0); }
in vec2 vUv;
in vec3 vColor;
in vec4 vState;
in float vFade;
out vec4 fragColor;
void main() {
  float r = length(vUv);
  float live = vState.x;
  float hover = vState.y;
  float core = exp(-r * r * 60.0);
  float halo = exp(-r * r * 9.0);
  float pulse = 0.85 + 0.15 * sin(uTime * 3.2 + vState.z);
  vec3 white = vec3(1.0, 0.97, 0.92);
  vec3 liveCol = vColor * (halo * 1.6 * pulse + core * 4.0) + white * core * 5.0;
  float ring = exp(-sq((r - 0.5) / 0.06));
  vec3 tint = mix(white, vColor, 0.55 + 0.45 * hover);
  vec3 soonCol = tint * (core * (2.4 + 2.5 * hover) + halo * (0.2 + 0.5 * hover) + ring * (0.45 + 0.9 * hover));
  vec3 col = mix(soonCol, liveCol, live);
  fragColor = vec4(col * vFade, 1.0);
}`;

const RING_VERT = /* glsl */ `
${COMMON_VERT}
void main() {
  vec3 base = surfaceBase();
  vec3 toCam = cameraPosition - base;
  float dist = length(toCam);
  vec3 e = normalize(vec3(iDir.z, 0.0, -iDir.x) + vec3(1e-5, 0.0, 0.0));
  vec3 n = cross(iDir, e);
  float sizePx = mix(34.0, 68.0, iState.x) * (1.0 + 0.4 * iState.y);
  float s = sizePx * uPx * dist;
  vec3 obj = iDir * (1.0 + ${LIFT}) + (e * position.x + n * position.y) * s;
  vUv = position.xy * 2.0;
  vColor = iColor;
  vState = iState;
  vFade = smoothstep(0.0, 0.25, dot(surfaceUp(), toCam / dist)) * iState.w * (1.0 - uDive);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(obj, 1.0);
}`;

const RING_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
float sq(float x) { return x * x; }
float saturate(float x) { return clamp(x, 0.0, 1.0); }
in vec2 vUv;
in vec3 vColor;
in vec4 vState;
in float vFade;
out vec4 fragColor;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float live = vState.x;
  float hover = vState.y;
  float waves = 0.0;
  for (int k = 0; k < 3; k++) {
    float ph = fract(uTime * 0.42 + float(k) / 3.0 + vState.z * 0.1);
    float w = 0.02 + 0.05 * ph;
    waves += exp(-sq((r - ph) / w)) * pow(saturate(1.0 - ph), 1.6);
  }
  float inner = exp(-sq((r - 0.16) / 0.018));
  float disc = exp(-r * r * 30.0) * 0.4;
  float liveI = (waves * 0.9 + inner * 0.7 + disc * 0.6) * (1.0 + 1.2 * hover);
  float soonI = (exp(-sq((r - 0.62) / 0.05)) * 0.9 + disc * 0.5) * hover;
  fragColor = vec4(vColor * mix(soonI, liveI, live) * vFade, 1.0);
}`;

const BEAM_VERT = /* glsl */ `
${COMMON_VERT}
uniform float uBeamHeight;
out float vT;
void main() {
  vec3 base = surfaceBase();
  vec3 up = surfaceUp();
  vec3 toCam = cameraPosition - base;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 side = cross(up, V);
  float sl = length(side);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  side = sl > 0.02 ? side / sl : right;
  float t = position.y + 0.5;
  float w = (5.0 + 5.0 * iState.y) * uPx * dist;
  vec3 wp = base + up * t * uBeamHeight + side * position.x * w;
  vUv = vec2(position.x * 2.0, t);
  vT = t;
  vColor = iColor;
  vState = iState;
  vFade = smoothstep(-0.45, 0.1, dot(up, V)) * iState.w * (1.0 - uDive) * smoothstep(0.0, 0.18, sl);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const BEAM_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
float sq(float x) { return x * x; }
float saturate(float x) { return clamp(x, 0.0, 1.0); }
in vec2 vUv;
in vec3 vColor;
in vec4 vState;
in float vFade;
in float vT;
out vec4 fragColor;
void main() {
  float x = vUv.x;
  float core = exp(-x * x * 18.0) + 0.22 * exp(-x * x * 2.5);
  float fall = pow(saturate(1.0 - vT), 1.8) * smoothstep(0.0, 0.03, vT);
  float flow = 0.75 + 0.25 * sin(vT * 38.0 - uTime * 5.0);
  vec3 col = vColor * core * fall * flow * (1.4 + 1.2 * vState.y) + vec3(1.0) * exp(-x * x * 60.0) * fall * 0.8;
  fragColor = vec4(col * vFade, 1.0);
}`;

export interface MarkerHit {
  place: PlaceDef;
  x: number;
  y: number;
  dist: number;
}

/**
 * All place markers as three instanced draws (dots, ground rings, beams). Per
 * place hover / visibility live in an instanced attribute that is eased on the CPU.
 */
export class Markers {
  readonly group = new Group();
  private dotMat: ShaderMaterial;
  private ringMat: ShaderMaterial;
  private beamMat: ShaderMaterial;
  private state: InstancedBufferAttribute;
  private beamState: InstancedBufferAttribute;
  private hover: Float32Array;
  private vis: Float32Array;
  private liveIdx: number[] = [];
  private tmp = new Vector3();
  private dirs: Vector3[];
  private geos: InstancedBufferGeometry[] = [];

  constructor(readonly places: PlaceDef[]) {
    const n = places.length;
    this.hover = new Float32Array(n);
    this.vis = new Float32Array(n).fill(1);
    this.dirs = places.map((c) => latLonToVec(c.lat, c.lon));
    const dir = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const st = new Float32Array(n * 4);
    const c = new Color();
    places.forEach((place, i) => {
      this.dirs[i].toArray(dir, i * 3);
      c.set(place.accent);
      col.set([c.r, c.g, c.b], i * 3);
      st.set([place.status === "live" ? 1 : 0, 0, i * 1.37, 1], i * 4);
      if (place.status === "live") this.liveIdx.push(i);
    });
    this.state = new InstancedBufferAttribute(st, 4);
    this.state.setUsage(DynamicDrawUsage);

    const uniforms = () => ({ uTime: { value: 0 }, uPx: { value: 0.001 }, uDive: { value: 0 } });
    const mat = (vert: string, frag: string, extra = {}) =>
      new ShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: { ...uniforms(), ...extra },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
    this.dotMat = mat(DOT_VERT, DOT_FRAG);
    this.ringMat = mat(RING_VERT, RING_FRAG);
    this.beamMat = mat(BEAM_VERT, BEAM_FRAG, { uBeamHeight: { value: 0.16 } });

    const quad = new PlaneGeometry(1, 1);
    const make = (count: number, attrs: Record<string, InstancedBufferAttribute>) => {
      const g = new InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute("position", quad.getAttribute("position"));
      for (const [k, v] of Object.entries(attrs)) g.setAttribute(k, v);
      g.instanceCount = count;
      this.geos.push(g);
      return g;
    };
    const dirAttr = new InstancedBufferAttribute(dir, 3);
    const colAttr = new InstancedBufferAttribute(col, 3);
    const ringMesh = new Mesh(make(n, { iDir: dirAttr, iColor: colAttr, iState: this.state }), this.ringMat);
    const dotMesh = new Mesh(make(n, { iDir: dirAttr, iColor: colAttr, iState: this.state }), this.dotMat);

    // Beams only for enterable places.
    const ln = this.liveIdx.length;
    const bDir = new Float32Array(ln * 3);
    const bCol = new Float32Array(ln * 3);
    const bSt = new Float32Array(ln * 4);
    this.liveIdx.forEach((i, j) => {
      bDir.set(dir.subarray(i * 3, i * 3 + 3), j * 3);
      bCol.set(col.subarray(i * 3, i * 3 + 3), j * 3);
      bSt.set(st.subarray(i * 4, i * 4 + 4), j * 4);
    });
    this.beamState = new InstancedBufferAttribute(bSt, 4);
    const beamMesh = new Mesh(
      make(ln, { iDir: new InstancedBufferAttribute(bDir, 3), iColor: new InstancedBufferAttribute(bCol, 3), iState: this.beamState }),
      this.beamMat,
    );
    quad.dispose();
    for (const m of [ringMesh, beamMesh, dotMesh]) {
      m.frustumCulled = false;
      m.renderOrder = 10;
      this.group.add(m);
    }
    ringMesh.renderOrder = 9;
  }

  /** Targets are eased toward; `hovered` = index or -1. */
  update(dt: number, time: number, hovered: number, pxPerUnit: number, dive: number, divePlace: number): void {
    const k = 1 - Math.exp(-dt * 10);
    const arr = this.state.array as Float32Array;
    for (let i = 0; i < this.places.length; i++) {
      this.hover[i] += ((i === hovered ? 1 : 0) - this.hover[i]) * k;
      // While diving, everything except the destination fades out.
      const vTarget = dive > 0 && i !== divePlace ? 0 : 1;
      this.vis[i] += (vTarget - this.vis[i]) * k;
      arr[i * 4 + 1] = this.hover[i];
      arr[i * 4 + 3] = this.vis[i];
    }
    this.state.needsUpdate = true;
    const b = this.beamState.array as Float32Array;
    this.liveIdx.forEach((i, j) => {
      b[j * 4 + 1] = this.hover[i];
      b[j * 4 + 3] = this.vis[i];
    });
    this.beamState.needsUpdate = true;
    for (const m of [this.dotMat, this.ringMat, this.beamMat]) {
      m.uniforms.uTime.value = time;
      m.uniforms.uPx.value = pxPerUnit;
      m.uniforms.uDive.value = dive;
    }
  }

  /** World position of place `i` on the surface (the group's parent carries the globe rotation). */
  worldPos(i: number, out: Vector3): Vector3 {
    return out.copy(this.dirs[i]).applyMatrix4(this.group.matrixWorld);
  }

  /**
   * Nearest visible marker to a pointer, in CSS pixels. Places over the limb
   * (facing away from the camera) are not pickable.
   */
  pick(camera: Camera, cx: number, cy: number, w: number, h: number, radiusPx: number): MarkerHit | null {
    let best: MarkerHit | null = null;
    const camPos = camera.position;
    for (let i = 0; i < this.places.length; i++) {
      const p = this.worldPos(i, this.tmp);
      const facing = (p.x * (camPos.x - p.x) + p.y * (camPos.y - p.y) + p.z * (camPos.z - p.z)) / camPos.distanceTo(p);
      if (facing < 0.12 || this.vis[i] < 0.5) continue;
      p.project(camera);
      const x = (p.x * 0.5 + 0.5) * w;
      const y = (-p.y * 0.5 + 0.5) * h;
      const d = Math.hypot(x - cx, y - cy);
      const r = this.places[i].status === "live" ? radiusPx * 1.35 : radiusPx;
      if (d < r && (!best || d < best.dist)) best = { place: this.places[i], x, y, dist: d };
    }
    return best;
  }

  /** Screen position of a place if it is on the visible hemisphere. */
  screenPos(i: number, camera: Camera, w: number, h: number): { x: number; y: number } | null {
    const p = this.worldPos(i, this.tmp);
    const camPos = camera.position;
    const facing = (p.x * (camPos.x - p.x) + p.y * (camPos.y - p.y) + p.z * (camPos.z - p.z)) / camPos.distanceTo(p);
    if (facing < 0.05) return null;
    p.project(camera);
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    this.dotMat.dispose();
    this.ringMat.dispose();
    this.beamMat.dispose();
  }
}
