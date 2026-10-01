import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  Points,
  BufferGeometry,
  Float32BufferAttribute,
} from "three";
import { Rng } from "../../../core/random";
import { GLSL_NOISE } from "../gfx/glsl";
import type { World } from "./context";

export const SKY = {
  zenith: new Color(0x04050b),
  horizon: new Color(0x191827),
  glow: new Color(0x4a3030),
};

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
varying vec3 vDir;
${GLSL_NOISE}
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(h, 0.4));
  // Low rain-cloud deck lit from below by the city: sodium orange near the
  // horizon, cooler LED magenta-violet overhead.
  vec2 uv = d.xz / max(d.y + 0.06, 0.03);
  float c1 = fbm(uv * 0.28 + vec2(uTime * 0.005, uTime * 0.002), vec2(0.0), 6);
  float c2 = fbm(uv * 0.85 - vec2(uTime * 0.009, 0.0), vec2(0.0), 5);
  float dens = c1 * 0.72 + c2 * 0.28;
  float clouds = smoothstep(0.42, 0.78, dens);
  float under = smoothstep(0.5, 0.7, c2);
  float lit = exp(-h * 3.2);
  vec3 cityGlow = mix(uGlow, vec3(0.16, 0.1, 0.22), smoothstep(0.05, 0.5, h));
  col += cityGlow * clouds * (0.35 + 0.65 * lit) * (0.7 + 0.5 * under);
  col += uGlow * lit * lit * 0.3;
  // Gaps between clouds are darker.
  col *= mix(0.72, 1.0, clouds);
  gl_FragColor = vec4(col, 1.0);
}`;

const TOWER_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const TOWER_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uHaze;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  float y = vWorld.y;
  // Truss: four corner legs, a horizontal chord every 22 m and X-bracing
  // between chords, as lit by the tower's orange landmark lights.
  float fu = fract(vUv.x * 4.0);
  float legs = smoothstep(0.07, 0.0, min(fu, 1.0 - fu));
  float seg = 22.0;
  float t = fract(y / seg);
  float chord = smoothstep(0.05, 0.0, min(t, 1.0 - t));
  float diag = smoothstep(0.045, 0.0, min(abs(fu - t), abs(fu - (1.0 - t))));
  float lattice = max(max(legs, chord * 0.8), diag * 0.6);
  vec3 orange = vec3(1.0, 0.38, 0.1);
  vec3 white = vec3(1.0, 0.92, 0.82);
  vec3 col = mix(orange, white, smoothstep(215.0, 262.0, y) * 0.6) * lattice * 1.6;
  // A faint glow fills the structure so it reads as a solid silhouette too.
  col += orange * 0.12;
  // Observation decks.
  col += white * 3.0 * (smoothstep(4.0, 0.0, abs(y - 150.0)) + smoothstep(2.5, 0.0, abs(y - 250.0)));
  // Aviation warning light at the tip.
  col += vec3(1.0, 0.05, 0.02) * 30.0 * smoothstep(3.0, 0.0, abs(y - 330.0)) * step(0.5, fract(uTime * 0.5));
  float dist = length(vWorld.xz);
  float fog = 1.0 - exp(-dist * 0.00045);
  gl_FragColor = vec4(col * (1.0 - fog * 0.6), 1.0);
}`;

const CITY_VERT = /* glsl */ `
attribute vec4 aInfo;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec4 vInfo;
varying vec3 vLocal;
varying vec3 vScale;
void main() {
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  vInfo = aInfo;
  vLocal = position;
  vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const CITY_FRAG = /* glsl */ `
uniform vec3 uHaze;
uniform vec3 uCam;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec4 vInfo;
varying vec3 vLocal;
varying vec3 vScale;
${GLSL_NOISE}
void main() {
  vec3 n = normalize(vNormalW);
  vec3 base = vec3(0.018, 0.019, 0.024) * (0.6 + vInfo.y * 0.8);
  vec3 col = base;
  if (abs(n.y) < 0.5) {
    // Facade coordinates in meters.
    float u = abs(n.x) > 0.5 ? vLocal.z * vScale.z : vLocal.x * vScale.x;
    float v = vWorld.y;
    float fw = 1.8 + vInfo.z * 1.2;
    vec2 cell = floor(vec2(u / fw, v / 3.3));
    vec2 f = fract(vec2(u / fw, v / 3.3));
    float win = step(0.28, f.x) * step(f.x, 0.72) * step(0.35, f.y) * step(f.y, 0.75);
    float r = hash12(cell + vInfo.w * 113.0);
    float lit = step(1.0 - (0.08 + vInfo.x * 0.22), r);
    vec3 warm = vec3(1.0, 0.72, 0.42);
    vec3 cool = vec3(0.7, 0.85, 1.0);
    vec3 wc = mix(warm, cool, step(0.6, hash12(cell * 1.7 + 5.0))) * (0.4 + 0.6 * hash12(cell + 3.3));
    col += wc * win * lit * 0.8;
    // Office floors: continuous ribbon glazing on some towers.
    if (vInfo.z > 0.8) col += cool * 0.12 * step(0.4, f.y) * step(f.y, 0.75) * step(0.7, hash12(vec2(cell.y, vInfo.w)));
    // Red aviation-light band near the top of tall ones is handled by points.
  }
  float dist = length(vWorld - uCam);
  float fog = 1.0 - exp(-dist * 0.0032);
  float heightFade = exp(-max(vWorld.y, 0.0) * 0.004);
  col = mix(col, uHaze, clamp(fog * mix(0.75, 1.0, heightFade), 0.0, 0.97));
  gl_FragColor = vec4(col, 1.0);
}`;

/** Sky dome, far skyline (instanced towers with procedural windows) and Tokyo Tower. */
export function buildSky(w: World): { sky: Mesh; update: (t: number, cam: Vector3) => void } {
  const skyMat = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uZenith: { value: SKY.zenith },
      uHorizon: { value: SKY.horizon },
      uGlow: { value: SKY.glow },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new Mesh(new SphereGeometry(900, 48, 24), skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.userData.dynamic = true;
  sky.userData.pocketAtlas = { kind: "sky", zenith: SKY.zenith.toArray(), horizon: SKY.horizon.toArray(), glow: SKY.glow.toArray() };
  w.root.add(sky);

  // ------------------------------------------------------------ skyline
  const rng = new Rng(404);
  const count = w.quality.level === "low" ? 260 : 620;
  const geo = new BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const info = new Float32Array(count * 4);
  const cityMat = new ShaderMaterial({
    uniforms: { uHaze: { value: new Color(0x1a1826) }, uCam: { value: new Vector3() }, uTime: { value: 0 } },
    vertexShader: CITY_VERT,
    fragmentShader: CITY_FRAG,
  });
  const city = new InstancedMesh(geo, cityMat, count);
  const m = new Matrix4();
  const q = new Object3D();
  const beacons: number[] = [];
  let i = 0;
  while (i < count) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(170, 900);
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    // Keep the street vistas open: down the cross street toward the tower and
    // both ways along the main street.
    if (Math.abs(x - 10) < 45 && Math.abs(z) > 100) continue;
    if (Math.abs(z - 3) < 60 && Math.abs(x) > 90) continue;
    const tall = rng.chance(0.12);
    const h = tall ? rng.range(90, 240) : rng.range(18, 70);
    const wdt = rng.range(18, 45);
    const dpt = rng.range(18, 45);
    q.position.set(x, 0, z);
    q.rotation.y = rng.chance(0.7) ? 0 : rng.range(0, Math.PI);
    q.scale.set(wdt, h, dpt);
    q.updateMatrix();
    m.copy(q.matrix);
    city.setMatrixAt(i, m);
    info.set([rng.next(), rng.next(), rng.next(), rng.next()], i * 4);
    if (tall) beacons.push(x, h + 1, z);
    i++;
  }
  geo.setAttribute("aInfo", new InstancedBufferAttribute(info, 4));
  city.frustumCulled = false;
  city.userData.pocketAtlas = { kind: "skyline", haze: [0x1a / 255, 0x18 / 255, 0x26 / 255] };
  city.userData.dynamic = true;
  w.root.add(city);

  // Red aviation lights on the tall ones (blinking together, as they do).
  const bGeo = new BufferGeometry();
  bGeo.setAttribute("position", new Float32BufferAttribute(beacons, 3));
  const bMat = new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying float vOn;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(900.0 / -mv.z, 1.5, 6.0);
        vOn = 0.35 + 0.65 * step(0.45, fract(uTime * 0.55 + position.x * 0.0003));
      }`,
    fragmentShader: /* glsl */ `
      varying float vOn;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vec3(1.0, 0.08, 0.04) * 6.0 * vOn * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const bPts = new Points(bGeo, bMat);
  bPts.userData.pocketAtlas = { kind: "beacons" };
  bPts.frustumCulled = false;
  bPts.userData.dynamic = true;
  w.root.add(bPts);

  // ---------------------------------------------------------- the tower
  const profile = [
    new Vector2(46, 0),
    new Vector2(34, 30),
    new Vector2(24, 70),
    new Vector2(17, 125),
    new Vector2(15, 150),
    new Vector2(11, 190),
    new Vector2(7.5, 223),
    new Vector2(6.5, 250),
    new Vector2(2.2, 262),
    new Vector2(1.2, 300),
    new Vector2(0.4, 333),
  ];
  const towerGeo = new LatheGeometry(profile, 4);
  towerGeo.rotateY(Math.PI / 4);
  const towerMat = new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHaze: { value: new Color(0x2a2230) } },
    vertexShader: TOWER_VERT,
    fragmentShader: TOWER_FRAG,
    side: 2,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const tower = new Mesh(towerGeo, towerMat);
  tower.userData.pocketAtlas = { kind: "tower" };
  tower.position.set(14, 0, -2100);
  tower.userData.dynamic = true;
  tower.renderOrder = -5;
  w.root.add(tower);
  // Main deck body.
  const deck = new Mesh(new BoxGeometry(30, 10, 30), towerMat);
  deck.userData.pocketAtlas = { kind: "tower" };
  deck.position.set(14, 150, -2100);
  deck.userData.dynamic = true;
  deck.renderOrder = -5;
  w.root.add(deck);

  return {
    sky,
    update: (t, cam) => {
      skyMat.uniforms.uTime.value = t;
      towerMat.uniforms.uTime.value = t;
      bMat.uniforms.uTime.value = t;
      (cityMat.uniforms.uCam.value as Vector3).copy(cam);
      sky.position.copy(cam);
    },
  };
}
