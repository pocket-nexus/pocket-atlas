import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Mesh, ShaderMaterial, Vector3, type PerspectiveCamera } from "three";

/**
 * Falling snow: flakes seeded in a box that wraps around the camera, each a
 * small quad drawn along its velocity relative to the camera — still air
 * shows dots drifting down, a moving car shows streaks rushing at the
 * windscreen. The handheld draws the same flakes (`fx_v.cg`, FLAKE) from
 * the same parameters (`snow` in the scene's annotation).
 */
export interface SnowSpec {
  /** Flakes in the box. */
  count: number;
  /** Box edge lengths (m): across, up, along. */
  box: [number, number, number];
  /** Fall speed (m/s) and wind (m/s along x, z). */
  fall: number;
  wind: [number, number];
  /** Flake diameter (m) and the exposure the streaks are drawn for (s). */
  size: number;
  shutter: number;
  /** Radiance of a flake (linear, under the sky's light). */
  color: [number, number, number];
  opacity: number;
}

export const LIGHT_SNOW: SnowSpec = { count: 5200, box: [44, 26, 44], fall: 1.25, wind: [0.9, 0.4], size: 0.028, shutter: 1 / 60, color: [1, 1, 1.03], opacity: 0.55 };

const VERT = /* glsl */ `
attribute vec4 aSeed;
attribute vec2 aCorner;
uniform vec3 uCam;
uniform vec3 uCamVel;
uniform vec3 uBox;
uniform vec3 uVel;
uniform float uTime;
uniform float uSize;
uniform float uShutter;
uniform float uPixel;
varying vec2 vUv;
varying float vAlpha;
void main() {
  // Each flake drifts with its own flutter around the common fall and wind.
  vec3 vel = uVel * (0.8 + 0.4 * aSeed.w);
  vec3 p = aSeed.xyz * uBox + vel * uTime;
  p.x += sin(uTime * (0.7 + aSeed.w) + aSeed.x * 40.0) * 0.18;
  p.z += cos(uTime * (0.6 + aSeed.y) + aSeed.z * 40.0) * 0.18;
  vec3 origin = uCam - uBox * 0.5;
  p = origin + mod(p - origin, uBox);
  vec3 toCam = uCam - p;
  float dist = length(toCam);
  // Streak along the velocity relative to the camera, at least a dot.
  vec3 rel = (vel - uCamVel) * uShutter;
  float len = length(rel);
  float width = max(uSize, dist * uPixel * 1.2);
  vec3 axis = len > 1e-4 ? rel / len : vec3(0.0, -1.0, 0.0);
  vec3 side = normalize(cross(axis, toCam / max(dist, 1e-3)));
  vec3 wp = p + side * aCorner.x * width + axis * aCorner.y * (len + width);
  vUv = aCorner;
  // Energy stays with the flake: a wider or longer quad is dimmer.
  vAlpha = (uSize / width) * (width / (len + width)) * smoothstep(0.4, 1.6, dist) * (1.0 - smoothstep(uBox.x * 0.34, uBox.x * 0.5, dist));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vAlpha;
void main() {
  float e = 1.0 - abs(vUv.x) * 2.0;
  float along = 1.0 - abs(vUv.y) * 2.0;
  float a = smoothstep(0.0, 0.6, e) * smoothstep(0.0, 0.35, along) * vAlpha * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
}`;

export class Snow {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;
  private last = new Vector3();
  private vel = new Vector3();
  private started = false;

  constructor(readonly spec: SnowSpec) {
    const n = spec.count;
    const seed = new Float32Array(n * 4 * 4);
    const corner = new Float32Array(n * 4 * 2);
    const index = new Uint32Array(n * 6);
    // xorshift: the same flakes every run.
    let s = 0x2545f491;
    const rnd = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 8) & 0xffffff) / 16777216;
    };
    const corners = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
    for (let i = 0; i < n; i++) {
      const q = [rnd(), rnd(), rnd(), rnd()];
      for (let k = 0; k < 4; k++) {
        seed.set(q, (i * 4 + k) * 4);
        corner.set([corners[k * 2], corners[k * 2 + 1]], (i * 4 + k) * 2);
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(n * 4 * 3), 3));
    geo.setAttribute("aSeed", new BufferAttribute(seed, 4));
    geo.setAttribute("aCorner", new BufferAttribute(corner, 2));
    geo.setIndex(new BufferAttribute(index, 1));
    this.mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCam: { value: new Vector3() },
        uCamVel: { value: new Vector3() },
        uBox: { value: new Vector3(...spec.box) },
        uVel: { value: new Vector3(spec.wind[0], -spec.fall, spec.wind[1]) },
        uTime: { value: 0 },
        uSize: { value: spec.size },
        uShutter: { value: spec.shutter },
        uPixel: { value: 0.002 },
        uColor: { value: new Color(...spec.color) },
        uOpacity: { value: spec.opacity },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.name = "snow";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }

  /** Follows the camera; `dt` gives its velocity for the streaks. */
  update(dt: number, time: number, camera: PerspectiveCamera, viewportHeight: number): void {
    const u = this.mat.uniforms;
    const p = camera.position;
    if (this.started && dt > 1e-4) this.vel.copy(p).sub(this.last).multiplyScalar(1 / dt);
    // A cut is not motion.
    if (this.vel.length() > 80) this.vel.set(0, 0, 0);
    this.last.copy(p);
    this.started = true;
    (u.uCam.value as Vector3).copy(p);
    (u.uCamVel.value as Vector3).lerp(this.vel, 0.25);
    u.uTime.value = time;
    u.uPixel.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight);
  }

  /** The annotation the handheld reads. */
  annotation(): Record<string, unknown> {
    const s = this.spec;
    return { count: s.count, box: s.box, fall: s.fall, wind: s.wind, size: s.size, shutter: s.shutter, color: s.color, opacity: s.opacity };
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
