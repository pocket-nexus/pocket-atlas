import {
  DoubleSide, Float32BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, NormalBlending, ShaderMaterial, Vector3, Vector4,
  type Camera, type FogExp2, type Group, type HemisphereLight, type Scene,
} from "three";
import { Rng } from "../../../core/random";

// The Vita snow_v/snow_f programs use this same bounded particle recipe. All
// flakes follow world time, so a streaming boundary never resets the weather.
// Native buffers: 2,400 flakes + 240 puffs, two draws / 5,280 triangles / 443.4 KiB.
const SNOW_COUNT = 2400;
const PLUME_COUNT = 240;

const VERTEX = /* glsl */ `uniform vec4 uSnowCam;      // camera xyz, world size of one target pixel at 1 m
uniform vec4 uSnowRight;    // unit camera right, -
uniform vec4 uSnowUp;       // unit camera up, -
uniform vec4 uSnowMotion;   // elapsed seconds, opacity, radius min, radius range
uniform vec4 uSnowWind;     // integrated gust x/z displacement, gust strength, -
uniform vec4 uSnowDrift;    // horizontal velocity xyz, falling speed
uniform vec4 uSnowColor;    // diffuse snow radiance, -
uniform vec4 uSnowFog;      // scene fog rgb, exponential-squared density
uniform vec4 uSnowVehicle;  // vehicle origin xyz, signed speed in m/s
uniform vec4 uSnowHeading;  // vehicle forward (-Z transformed), enabled

attribute vec4 aSeed;
attribute vec3 aA;
varying vec3 vColor;
varying vec2 vUv;
varying float vOpacity;
void main()
{
    vec2 aCorner = position.xy;
    float t = uSnowMotion.x;
    vec3 cam = uSnowCam.xyz;
    vec3 car = uSnowVehicle.xyz;
    vec3 heading = uSnowHeading.xyz;
    vec3 carRight = vec3(-heading.z, 0.0, heading.x);
    float speed = uSnowVehicle.w;
    float absSpeed = abs(speed);
    float gust = uSnowWind.z;
    vec3 p;
    float radius;
    float alpha;
    float stretch = 1.0;
    vec2 major = vec2(0.0, 1.0);
#ifdef PLUME
    float kind = aA.x;
    if (kind < 1.5) {
        // Reconstruct only the last 0.85 s of wheel wake. Powder ceases at
        // rest; it does not leave a persistent route-sized particle trail.
        float duration = 0.52 + aSeed.y * 0.33;
        float life = fract(t / duration + aSeed.x);
        float age = life * duration;
        float side = kind < 0.5 ? -1.0 : 1.0;
        float travel = speed < 0.0 ? -1.0 : 1.0;
        float lateral = side * (0.63 + age * (0.35 + aSeed.z * 0.9));
        p = car + carRight * lateral - heading * (travel * 1.18 + speed * age * 0.68);
        p.y += 0.08 + age * (0.5 + aSeed.w * 0.75) - age * age * 0.5;
        p.x += age * (0.25 + gust * 0.45);
        radius = 0.07 + age * (0.18 + aSeed.z * 0.29);
        alpha = smoothstep(0.3, 4.0, absSpeed) * smoothstep(0.0, 0.08, life) * (1.0 - life) * (1.0 - life) * 0.19;
        stretch = 1.0 + life * 0.65;
    } else if (kind < 2.5) {
        float duration = 1.8 + aSeed.y * 0.8;
        float life = fract(t / duration + aSeed.x);
        float age = life * duration;
        p = car - carRight * 0.44 - heading * (1.72 + speed * age * 0.82 + age * 0.32);
        p.y += 0.3 + age * 0.3 + age * age * 0.035;
        p.x += age * (0.14 + gust * 0.25) + sin(age * 2.4 + aSeed.z * 6.283185) * age * 0.09;
        p.z += cos(age * 2.1 + aSeed.w * 6.283185) * age * 0.09;
        radius = 0.065 + age * (0.19 + aSeed.z * 0.08);
        alpha = smoothstep(0.0, 0.075, life) * (1.0 - life) * (1.0 - life) * 0.105 / (1.0 + absSpeed * 0.095);
    } else {
        // A few depth-tested puffs give the headlamp cone body. Their
        // footprint is local to the road, not a fullscreen fog layer.
        float phase = fract(t * 0.06 + aSeed.x);
        float along = 2.0 + phase * 25.0;
        float lateral = (aSeed.y - 0.5) * (0.4 + along * 0.39);
        p = car + heading * (1.6 + along) + carRight * lateral;
        p.y += 0.52 + aSeed.z * 0.65 + sin(t * 0.41 + aSeed.w * 6.283185) * 0.12;
        radius = 0.22 + along * 0.085;
        alpha = smoothstep(0.0, 0.12, phase) * (1.0 - smoothstep(0.7, 1.0, phase)) * 0.035;
    }
    float rot = aSeed.w * 6.283185 + t * 0.18;
    major = vec2(sin(rot), cos(rot));
    alpha *= uSnowHeading.w;
#else
    // 1,200 near / 800 middle / 400 far flakes. Dense nearby flakes, middle
    // detail and sparse small far flakes read at 480x272 without giant dots.
    float layer = aA.x;
    vec3 box = layer < 0.5 ? vec3(16.0, 10.0, 16.0) : (layer < 1.5 ? vec3(38.0, 22.0, 38.0) : vec3(84.0, 40.0, 84.0));
    float limit = layer < 0.5 ? 10.0 : (layer < 1.5 ? 22.0 : 47.0);
    vec3 origin = cam - vec3(box.x * 0.5, box.y * 0.35, box.z * 0.5);
    vec3 velocity = vec3(uSnowDrift.x, -uSnowDrift.w * (0.65 + 0.7 * aSeed.w), uSnowDrift.z);
    p = aSeed.xyz * box + velocity * t;
    p.x += uSnowWind.x + sin(t * 0.91 + aSeed.w * 6.283185) * 0.48;
    p.z += uSnowWind.y + cos(t * 0.73 + aSeed.x * 6.283185) * 0.34;
    vec3 relative = p - origin;
    p = origin + relative - box * floor(relative / box);
    float bandDistance = length(p - cam);
    float rangeFade = 1.0 - smoothstep(limit * 0.65, limit, bandDistance);
    float y = p.y - origin.y;
    float verticalFade = smoothstep(0.0, 1.5, y) * (1.0 - smoothstep(box.y - 2.0, box.y, y));
    radius = (uSnowMotion.z + uSnowMotion.w * aSeed.w * aSeed.w) * (1.0 + layer * 0.6);
    vec3 apparent = velocity - heading * speed * uSnowHeading.w;
    vec2 motion = vec2(dot(apparent, uSnowRight.xyz), dot(apparent, uSnowUp.xyz));
    major = normalize(motion + vec2(0.001, 0.001));
    stretch = 1.0 + min(2.6, absSpeed * 0.065 + gust * 0.65) * step(0.6, aSeed.z);
    alpha = rangeFade * verticalFade * (0.62 + aSeed.y * 0.38) / sqrt(stretch);
    // Keep the cabin dry in both driving views. Outside flakes still show
    // through the glass; particles cannot spawn inside the enclosed car.
    vec3 cabin = p - car;
    if (uSnowHeading.w > 0.5 && abs(dot(cabin, carRight)) < 0.74 && abs(dot(cabin, heading)) < 1.6 && cabin.y > 0.0 && cabin.y < 1.82) alpha = 0.0;
#endif
    vec3 toFlake = p - cam;
    float dist = length(toFlake);
    vec3 forward = -cross(uSnowRight.xyz, uSnowUp.xyz);
    float depth = dot(toFlake, forward);
    float drawnRadius = max(radius, max(depth, 0.1) * uSnowCam.w * 0.55);
    float coverage = (radius * radius) / (drawnRadius * drawnRadius);
#ifndef PLUME
    // Reserve subpixel visibility at the handheld target resolution.
    coverage = max(coverage, 0.22);
#endif
    vec2 minor = vec2(major.y, -major.x);
    vec2 corner = minor * aCorner.x + major * aCorner.y * stretch;
    vec3 wp = p + (uSnowRight.xyz * corner.x + uSnowUp.xyz * corner.y) * drawnRadius;
    alpha *= coverage * smoothstep(0.4, 1.0, depth) * uSnowMotion.y;

    // Forward lighting in the drifting flakes provides inexpensive volume
    // scattering aligned to the same live car transform as its real lights.
    vec3 lightDelta = p - (car + heading * 1.71 + vec3(0.0, 0.82, 0.0));
    float along = dot(lightDelta, heading);
    float lateral = dot(lightDelta, carRight);
    float vertical = lightDelta.y + along * 0.0332;
    float width = 0.35 + max(along, 0.0) * 0.46;
    float beam = 1.0 - smoothstep(0.35, 1.0, (lateral * lateral + vertical * vertical * 2.8) / (width * width));
    beam *= smoothstep(0.0, 1.0, along) * (1.0 - smoothstep(16.0, 33.0, along)) * uSnowHeading.w;
    vec3 color = uSnowColor.rgb * (0.9 + 0.1 * aSeed.y) + vec3(2.1, 1.77, 1.22) * beam;
#ifdef PLUME
    if (aA.x > 2.5) alpha *= beam;
#endif
    float haze = uSnowFog.w * dist;
    color = mix(uSnowFog.rgb, color, exp(-haze * haze));
    gl_Position = (projectionMatrix * viewMatrix * vec4(wp, 1.0));
    if (depth < 0.1 || alpha < 0.0001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = color;
    vUv = aCorner;
    vOpacity = alpha;
}
`;

const FRAGMENT = /* glsl */ `varying vec3 vColor;
varying vec2 vUv;
varying float vOpacity;
void main() {
    vec2 uv = vUv;
    float radius2 = dot(uv, uv);
#ifdef PLUME
    radius2 *= 1.0 + uv.x * uv.y * 0.28 + (uv.x * uv.x - uv.y * uv.y) * 0.18;
    float edge = 1.0 - smoothstep(0.02, 1.0, radius2);
    float shape = edge * edge;
#else
    float edge = 1.0 - smoothstep(0.07, 1.0, radius2);
    float arms = 1.0 - clamp(min(abs(uv.x), abs(uv.y)) * 3.4, 0.0, 1.0);
    float shape = edge * (0.72 + 0.28 * arms);
#endif
    gl_FragColor = vec4(vColor, shape * vOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

function particleGeometry(count: number, plume: boolean): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const random = new Rng(plume ? 237032 : 237031);
  const seeds = new Float32Array(count * 4), kinds = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < 4; j++) seeds[i * 4 + j] = random.next();
    // 80 puffs per rear tyre, 48 cold exhaust puffs, 32 lit mist puffs.
    kinds[i * 3] = plume ? (i < 160 ? i % 2 : i < 208 ? 2 : 3) : (i % 6 < 3 ? 0 : i % 6 < 5 ? 1 : 2);
  }
  geometry.setAttribute("aSeed", new InstancedBufferAttribute(seeds, 4));
  geometry.setAttribute("aA", new InstancedBufferAttribute(kinds, 3));
  geometry.instanceCount = count;
  return geometry;
}

export class Snowfall {
  private eye = new Vector3();
  private carPosition = new Vector3();
  private heading = new Vector3(0, 0, -1);
  private cameraRight = new Vector3();
  private cameraUp = new Vector3();
  private snow: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private plumes: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private uniforms = {
    uSnowCam: { value: new Vector4() },
    uSnowRight: { value: new Vector4() },
    uSnowUp: { value: new Vector4() },
    uSnowMotion: { value: new Vector4(0, 0.9, 0.006, 0.014) },
    uSnowWind: { value: new Vector4() },
    uSnowDrift: { value: new Vector4(0.86, 0, 0.31, 1.05) },
    uSnowColor: { value: new Vector4(0.61, 0.66, 0.7, 0) },
    uSnowFog: { value: new Vector4() },
    uSnowVehicle: { value: new Vector4() },
    uSnowHeading: { value: new Vector4(0, 0, -1, 0) },
  };

  constructor(scene: Scene, count = SNOW_COUNT) {
    // Snow reflects the scene's overcast fill; headlight scattering is added
    // in the vertex shader. Irradiance-to-radiance agrees with the Vita pass.
    scene.traverse((object) => {
      const light = object as HemisphereLight;
      if (light.isHemisphereLight) {
        const sky = light.color, ground = light.groundColor, gain = light.intensity * 3.8 / Math.PI;
        this.uniforms.uSnowColor.value.set((sky.r * 0.7 + ground.r * 0.3) * gain, (sky.g * 0.7 + ground.g * 0.3) * gain, (sky.b * 0.7 + ground.b * 0.3) * gain, 0);
      }
    });
    const fog = scene.fog as FogExp2 | null;
    if (fog?.isFogExp2) this.uniforms.uSnowFog.value.set(fog.color.r, fog.color.g, fog.color.b, fog.density);
    const make = (plume: boolean) => {
      const material = new ShaderMaterial({
        uniforms: this.uniforms, defines: plume ? { PLUME: 1 } : {}, vertexShader: VERTEX, fragmentShader: FRAGMENT,
        transparent: true, depthTest: true, depthWrite: false, blending: NormalBlending, side: DoubleSide,
      });
      material.forceSinglePass = true;
      material.name = plume ? "vehicle-winter-plumes" : "layered-winter-snowfall";
      const mesh = new Mesh(particleGeometry(plume ? PLUME_COUNT : Math.max(0, Math.min(12000, Math.floor(count))), plume), material);
      mesh.name = plume ? "winter-powder-exhaust-headlight-mist" : "winter-layered-snow";
      mesh.frustumCulled = false;
      // Weather is outside the exported static world and behind car glass.
      mesh.renderOrder = -10;
      scene.add(mesh);
      return mesh;
    };
    this.snow = make(false);
    this.plumes = make(true);
  }

  update(time: number, camera: Camera, car?: Group, speed = 0): void {
    camera.getWorldPosition(this.eye);
    this.cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.cameraUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const height = Math.max(272, typeof innerHeight === "number" ? innerHeight : 544);
    this.uniforms.uSnowCam.value.set(this.eye.x, this.eye.y, this.eye.z, 2 / (height * camera.projectionMatrix.elements[5]));
    this.uniforms.uSnowRight.value.set(this.cameraRight.x, this.cameraRight.y, this.cameraRight.z, 0);
    this.uniforms.uSnowUp.value.set(this.cameraUp.x, this.cameraUp.y, this.cameraUp.z, 0);
    this.uniforms.uSnowMotion.value.x = time;
    this.uniforms.uSnowWind.value.set(Math.sin(time * 0.19) * 2.3, Math.sin(time * 0.11 + 0.7) * 1.2, 0.5 + 0.5 * Math.sin(time * 0.19) * Math.sin(time * 0.071 + 1.3), 0);
    if (car) {
      car.getWorldPosition(this.carPosition);
      this.heading.set(0, 0, -1).transformDirection(car.matrixWorld);
      this.uniforms.uSnowVehicle.value.set(this.carPosition.x, this.carPosition.y, this.carPosition.z, Number.isFinite(speed) ? speed : 0);
      this.uniforms.uSnowHeading.value.set(this.heading.x, this.heading.y, this.heading.z, 1);
    } else {
      this.uniforms.uSnowVehicle.value.w = 0;
      this.uniforms.uSnowHeading.value.w = 0;
    }
    this.plumes.visible = !!car;
  }

  dispose(): void {
    for (const mesh of [this.snow, this.plumes]) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); }
  }
}
