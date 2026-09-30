import {
  ClampToEdgeWrapping,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  WebGLRenderTarget,
  type IUniform,
  type TextureDataType,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { ATMOSPHERE, COMMON, f, NOISE } from "../shaders/chunks";

interface BakeOptions {
  type?: TextureDataType;
  srgb?: boolean;
  mipmaps?: boolean;
  wrapS?: typeof RepeatWrapping | typeof ClampToEdgeWrapping;
  uniforms?: Record<string, IUniform>;
  anisotropy?: number;
}

/** Renders full-screen fragment programs into owned render targets. */
export class GpuBaker {
  private quad = new FullScreenQuad();
  constructor(private renderer: WebGLRenderer) {}

  bake(width: number, height: number, body: string, opts: BakeOptions = {}): WebGLRenderTarget {
    const mip = !!opts.mipmaps;
    const rt = new WebGLRenderTarget(width, height, {
      type: opts.type ?? UnsignedByteType,
      generateMipmaps: mip,
      minFilter: mip ? LinearMipmapLinearFilter : LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      colorSpace: opts.srgb ? SRGBColorSpace : NoColorSpace,
      anisotropy: opts.anisotropy ?? 1,
    });
    rt.texture.wrapS = opts.wrapS ?? RepeatWrapping;
    rt.texture.wrapT = ClampToEdgeWrapping;
    const mat = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: { uRes: { value: [width, height] }, ...(opts.uniforms ?? {}) },
      vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec2 uRes;
        out vec4 outColor;
        ${COMMON}
        ${body}`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad.material = mat;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(prev);
    mat.dispose();
    return rt;
  }

  dispose(): void {
    this.quad.dispose();
  }
}

// ------------------------------------------------------------------ data
// Regions are anisotropic gaussians in (lat, lon) degrees: [lat, lon, rLat, rLon].

const glslVec4Array = (name: string, rows: number[][]) =>
  `const vec4 ${name}[${rows.length}] = vec4[](${rows.map((r) => `vec4(${r.map(f).join(", ")})`).join(", ")});`;

const DESERTS = [
  [23, 12, 8, 26], [21, -7, 7, 10], [27, 28, 5, 6], [18, 20, 5, 12], [23, 46, 7, 9], [19, 51, 4, 5], [27, 71, 3, 4.5],
  [30, 60, 4.5, 9], [33, 55, 3, 5], [41, 61, 4, 7], [39, 83, 3, 7], [42, 101, 4, 10], [44, 92, 2.5, 5], [-24, 19, 5, 6],
  [-24, 15, 5, 2], [-25, 128, 8, 13], [-28, 136, 4, 5], [-23, -69.5, 5, 1.4], [32, -113, 4, 4], [39.5, -116, 3, 3.5],
  [-44, -68.5, 6, 3], [8, 46, 5, 5], [15, 38, 2.5, 3], [31, 36.5, 2.5, 3], [34, 42, 3, 5], [47, 62, 3, 10], [35, -104, 3, 3],
  [30, -104, 3, 3], [15.5, 49, 2, 4],
];
const JUNGLES = [
  [-4, -62, 8, 14], [-10, -55, 5, 8], [1, 20, 5, 9], [-3, 25, 4, 5], [1, 111, 5, 7], [-4, 140, 3, 6], [0, 101, 4, 3],
  [12, -84, 5, 5], [16, -91, 3, 4], [6, -6, 2.5, 9], [5, 8, 2.5, 3], [-17, 49, 5, 2], [13, 104, 5, 5], [21, 97, 5, 3],
  [5, -74, 5, 3], [-16, 146, 2.5, 1.5], [-9, -38, 3, 1.2], [10, 76, 5, 1.2], [24, 91, 3, 3],
];
const SAVANNAS = [
  [11, 5, 3, 20], [11, 30, 3, 10], [-12, 25, 5, 12], [-17, 33, 5, 8], [-15, -48, 6, 8], [-15, 133, 4, 14], [7, -66, 3, 7],
  [21, 78, 7, 7], [0, 36, 4, 4], [-22, 30, 4, 5], [-19, 140, 3, 6], [23, -102, 4, 4], [-22, -60, 5, 5], [15, 100, 3, 3],
];
const STEPPES = [
  [48, 68, 4, 18], [45, 108, 4, 12], [49, 40, 3, 12], [42, -103, 7, 6], [51, -107, 3, 7], [-35, -63, 5, 5], [38, 35, 3, 6],
  [14, 7, 3, 20], [15, 30, 3, 10], [-30, 144, 5, 7], [-20, 22, 5, 6], [36, 68, 3, 5], [-31, 22, 3, 5], [-28, 120, 4, 4],
];
const SHALLOW_SEAS = [
  [3, 108, 6, 7], [-5, 113, 3, 8], [36, 123, 4, 4], [29, 123, 4, 4], [27, 51, 2.5, 5], [56, 3, 3, 4], [24, -78, 2.5, 3],
  [22, -79, 1.5, 4], [-18, 148, 5, 3], [-10, 136, 3, 8], [-48, -63, 5, 5], [46, -52, 3, 5], [72, 130, 4, 30], [60, -175, 4, 8],
  [21, -86, 2, 2], [24, 37, 5, 2], [11, 104, 3, 4], [47, 36, 2, 3], [65, -168, 2, 5], [9, 80, 2, 2], [22, 91, 1.5, 2],
];
const TURQUOISE = [
  [24, -77.5, 1.8, 2.2], [22.5, -75, 1, 2], [-18, 147.5, 4, 1.3], [21.5, -86.5, 1, 1], [26.5, 51, 1.5, 3], [12, 50, 0.6, 2],
  [-21, 164, 1.2, 1.5], [4, 73, 3, 0.8], [-10, 124, 0.8, 2], [23.5, 119.5, 0.5, 0.5],
];
// Real lakes the land polygons keep as land.
const LAKES = [
  [47.7, -87.5, 0.9, 3.4], [44, -87, 1.7, 0.5], [44.8, -82.3, 0.9, 1.1], [42.2, -81.2, 0.35, 1.8], [43.65, -77.9, 0.35, 1.5],
  [-1, 33, 1.1, 1.2], [-6, 29.6, 3, 0.35], [-12, 34.5, 2.2, 0.3], [53.5, 108, 2, 0.5], [61, 31.5, 0.6, 0.8], [61.6, 35.5, 0.5, 0.4],
  [46.5, 75, 0.35, 2.5], [66, -121, 1.2, 3.5], [61.5, -114, 0.8, 3.2], [52.5, -97.8, 1.4, 0.6], [-15.8, -69.4, 0.4, 0.5],
  [45, 59.5, 0.8, 0.8], [13, 14.3, 0.5, 0.5], [3.5, 36, 1.5, 0.3], [58.9, 13.5, 0.6, 1.2],
];
// Mountain chains: [lat1, lon1, lat2, lon2] + [halfWidthDeg, height].
const RANGES: [number, number, number, number, number, number][] = [
  [35.5, 74, 27.8, 88, 2.2, 1.0], [27.8, 88, 28.0, 97, 1.8, 0.9], [34.5, 80, 33.5, 97, 4.5, 0.62], [36, 70, 36, 77.5, 1.5, 0.9],
  [34.5, 67, 36.5, 71.5, 1.2, 0.7], [42, 70, 43, 87, 1.4, 0.7], [36.2, 78, 35.5, 98, 1.3, 0.75], [49, 86, 47, 94, 1.5, 0.5],
  [32, 99, 25, 100, 1.6, 0.6], [37, 44.5, 28, 55, 1.4, 0.5], [36.5, 50, 36.3, 56, 0.8, 0.5], [43.3, 40, 41.7, 48, 0.9, 0.7],
  [39, 30, 39, 42, 3, 0.35], [44, 7, 46.5, 10.5, 1.0, 0.7], [46.5, 10.5, 47.2, 15, 0.9, 0.6], [42.8, -1.5, 42.5, 2.5, 0.6, 0.5],
  [49.3, 19, 47.5, 25.5, 0.9, 0.35], [47.5, 25.5, 45.5, 25, 0.8, 0.35], [58.5, 7, 69, 18, 1.8, 0.4], [67, 64, 52, 58.5, 1.3, 0.3],
  [30.5, -9, 35.5, 7, 1.5, 0.5], [8, 37, 14, 38.5, 3.5, 0.55], [-3, 36, 3, 36, 2, 0.45], [-9, 33.5, -3, 30, 1.5, 0.4],
  [-30.5, 27.5, -25, 30.5, 1.2, 0.4], [10, -73, 5, -75.5, 1.2, 0.6], [5, -75.5, -2, -78.5, 1.2, 0.7], [-2, -78.5, -15, -73, 1.5, 0.8],
  [-15, -72, -22, -67, 3.5, 0.85], [-22, -67.5, -33, -70, 1.4, 0.9], [-33, -70, -45, -72, 1.0, 0.6], [-45, -72, -53, -73.5, 0.9, 0.5],
  [60, -135, 55, -125, 2, 0.5], [55, -125, 49, -116, 2, 0.55], [49, -116, 44, -110, 2.5, 0.55], [44, -110, 36, -106, 2.5, 0.6],
  [49, -121.5, 40, -121.5, 0.8, 0.45], [40, -121, 35.5, -118.5, 0.7, 0.55], [40, -117, 36, -110, 4, 0.3], [30, -108, 22, -104, 1.5, 0.45],
  [25, -100.5, 19.5, -97.5, 1.2, 0.4], [19.5, -103, 17, -95, 1.4, 0.45], [34, -84.5, 44, -72, 1.4, 0.2], [-20, -44, -15, -47, 3, 0.2],
  [63, -152, 61, -142, 1.2, 0.55], [-37.5, 148, -28, 152, 1.2, 0.25], [-28, 152, -17, 145.5, 1.3, 0.18], [-45, 168, -42, 172, 0.6, 0.45],
  [36.5, 137.5, 35.5, 138.5, 0.5, 0.35], [34, 132, 41, 141, 0.8, 0.2], [22.5, 120.8, 25, 121.5, 0.5, 0.35], [-4, 136, -6, 145, 1.2, 0.5],
  [32, 52, 33, 60, 3, 0.25], [20, 73.5, 9, 77, 0.6, 0.25], [28, 36, 17, 43.5, 1.2, 0.3], [47, 96, 46, 110, 4, 0.3],
  [64, 100, 64, 110, 5, 0.15], [67, 128, 62, 135, 1.8, 0.3], [51, 157, 60, 162, 0.8, 0.35], [18, 74, 15, 76, 2, 0.15],
  [72, -40, 66, -45, 6, 0.55], [-80, 0, -80, 120, 12, 0.5], [-78, -120, -80, 160, 9, 0.35], [37.5, 139, 40, 140.5, 0.6, 0.2],
  [24, 57, 23, 59, 0.7, 0.3], [16, 44, 13, 45, 1.2, 0.35], [-19, 47, -24, 46.5, 1.2, 0.25], [-8, 110, -8, 114, 0.5, 0.25],
  [2, 98.5, -5, 103, 0.6, 0.3], [53, -3, 57.5, -5, 0.8, 0.15], [44, 22, 42, 25, 1, 0.25], [40, 21, 38, 22.5, 1, 0.3],
];

const REGION_FN = /* glsl */ `
float regionSum(vec2 ll, vec4 r) {
  float dl = ll.y - r.y;
  dl -= 360.0 * floor((dl + 180.0) / 360.0);
  vec2 d = vec2((ll.x - r.x) / r.z, dl / r.w);
  return exp(-dot(d, d));
}
#define REGIONS(ARR, LL, OUT) for (int i = 0; i < ARR.length(); i++) OUT = max(OUT, regionSum(LL, ARR[i]));
`;

// ------------------------------------------------------------------ passes

export function bakeTransmittance(b: GpuBaker): WebGLRenderTarget {
  return b.bake(
    256,
    64,
    /* glsl */ `
    ${ATMOSPHERE}
    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      float mu = uv.x * 2.0 - 1.0;
      float h = uv.y * uv.y * ATMOS_H;
      float r = PLANET_R + h;
      vec3 ro = vec3(0.0, r, 0.0);
      vec3 rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
      float tEnd = raySphere(ro, rd, ATMOS_R).y;
      const int N = 80;
      float dt = tEnd / float(N);
      vec2 od = vec2(0.0);
      for (int i = 0; i < N; i++) {
        float hs = max(length(ro + rd * (float(i) + 0.5) * dt) - PLANET_R, 0.0);
        od += exp(-hs / vec2(HR, HM)) * dt;
      }
      vec3 T = exp(-(BETA_R * od.x + BETA_M * 1.1 * od.y));
      // Soft planet shadow: the sun is a disc and the terminator should not alias.
      float muH = -sqrt(max(0.0, 1.0 - sq(PLANET_R / r)));
      T *= smoothstep(muH - 0.02, muH + 0.03, mu);
      outColor = vec4(T, 1.0);
    }`,
    { type: HalfFloatType, wrapS: ClampToEdgeWrapping, uniforms: { tTransmittance: { value: null }, uSunI: { value: 0 } } },
  );
}

/** R = elevation (0 = sea level, 1 ≈ 8 km), G = mountain proximity. Half resolution, float. */
export function bakeRelief(b: GpuBaker, width: number, height: number, uniforms: Record<string, IUniform>): WebGLRenderTarget {
  const v = (lat: number, lon: number) => {
    const la = (lat * Math.PI) / 180;
    const lo = (lon * Math.PI) / 180;
    return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
  };
  // Endpoints on the unit sphere (xyz) with the half-width in radians / height in w.
  const segA = RANGES.map((r) => [...v(r[0], r[1]), (r[4] * Math.PI) / 180]);
  const segB = RANGES.map((r) => [...v(r[2], r[3]), r[5]]);
  return b.bake(
    width,
    height,
    /* glsl */ `
    uniform sampler2D tMask;
    ${NOISE}
    ${glslVec4Array("SEGA", segA)}
    ${glslVec4Array("SEGB", segB)}
    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      float lon = (uv.x - 0.5) * TAU;
      float lat = (0.5 - uv.y) * PI;
      vec3 p = latLonToVec(lat, lon);
      float land = texture(tMask, uv).r;
      float mtn = 0.0;
      float elev = 0.0;
      vec3 pw = p + 0.012 * vec3(snoise(p * 9.0), snoise(p * 9.0 + 5.2), snoise(p * 9.0 - 3.7));
      for (int i = 0; i < SEGA.length(); i++) {
        vec3 a = SEGA[i].xyz;
        vec3 ab = SEGB[i].xyz - a;
        float t = saturate(dot(pw - a, ab) / max(dot(ab, ab), 1e-6));
        float d = length(pw - (a + ab * t));
        float k = exp(-sq(d / SEGA[i].w) * 1.6);
        mtn = max(mtn, k);
        elev = max(elev, SEGB[i].w * k);
      }
      float r1 = ridged(p * 24.0, 6);
      float r2 = ridged(p * 70.0 + 3.0, 4);
      float hills = fbm(p * 14.0 + 11.0, 6) * 0.5 + 0.5;
      float e = elev * (0.35 + 0.65 * r1) * (0.8 + 0.4 * r2);
      e += 0.1 * hills * hills * (0.3 + mtn) + 0.03 * r2 * mtn;
      e *= smoothstep(0.1, 0.6, land);
      outColor = vec4(e, mtn * smoothstep(0.1, 0.6, land), 0.0, 1.0);
    }`,
    { type: HalfFloatType, uniforms },
  );
}

/** Tangent-space (east, north, up) normal map from the relief; alpha = elevation. */
export function bakeNormals(b: GpuBaker, width: number, height: number, uniforms: Record<string, IUniform>, anisotropy: number): WebGLRenderTarget {
  return b.bake(
    width,
    height,
    /* glsl */ `
    uniform sampler2D tRelief;
    uniform vec2 uReliefRes;
    uniform float uBump;
    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      vec2 e = 1.0 / uReliefRes;
      float hl = texture(tRelief, uv - vec2(e.x, 0.0)).r;
      float hr = texture(tRelief, uv + vec2(e.x, 0.0)).r;
      float hn = texture(tRelief, uv - vec2(0.0, e.y)).r;
      float hs = texture(tRelief, uv + vec2(0.0, e.y)).r;
      float lat = (0.5 - uv.y) * PI;
      float dx = TAU * max(cos(lat), 0.05) / uReliefRes.x;
      float dy = PI / uReliefRes.y;
      vec2 g = vec2((hr - hl) / (2.0 * dx), (hn - hs) / (2.0 * dy)) * uBump;
      vec3 n = normalize(vec3(-g, 1.0));
      // Alpha carries elevation so the surface shader can darken mountain country.
      outColor = vec4(n * 0.5 + 0.5, saturate(texture(tRelief, uv).r));
    }`,
    { mipmaps: true, uniforms, anisotropy },
  );
}

/** sRGB albedo; alpha = open water (specular / glint mask). */
export function bakeAlbedo(b: GpuBaker, width: number, height: number, uniforms: Record<string, IUniform>, anisotropy: number): WebGLRenderTarget {
  return b.bake(
    width,
    height,
    /* glsl */ `
    uniform sampler2D tMask;
    uniform sampler2D tFields;
    uniform sampler2D tRelief;
    ${NOISE}
    ${REGION_FN}
    ${glslVec4Array("DESERT", DESERTS)}
    ${glslVec4Array("JUNGLE", JUNGLES)}
    ${glslVec4Array("SAVANNA", SAVANNAS)}
    ${glslVec4Array("STEPPE", STEPPES)}
    ${glslVec4Array("SHALLOW", SHALLOW_SEAS)}
    ${glslVec4Array("TURQ", TURQUOISE)}
    ${glslVec4Array("LAKE", LAKES)}

    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      float lon = (uv.x - 0.5) * TAU;
      float lat = (0.5 - uv.y) * PI;
      vec3 p = latLonToVec(lat, lon);
      float latD = degrees(lat);
      float lonD = degrees(lon);
      float aLat = abs(latD);

      float land = texture(tMask, uv).r;
      vec4 cf = texture(tFields, uv);
      vec2 rel = texture(tRelief, uv).rg;
      float elev = rel.r;

      float n1 = fbm(p * 5.0, 5);
      float n2 = fbm(p * 19.0 + 3.1, 5);
      float n3 = fbm(p * 80.0 - 1.7, 4);
      float n4 = fbm(p * 260.0 + 8.3, 3);

      // Region boundaries are warped so no gaussian blob reads as a blob.
      vec2 ll = vec2(latD, lonD) + vec2(fbm(p * 4.0 + 7.0, 5), fbm(p * 4.0 - 5.0, 5)) * vec2(3.5, 5.0)
                + vec2(n2, n3) * vec2(1.2, 1.6);
      float desert = 0.0; REGIONS(DESERT, ll, desert)
      float jungle = 0.0; REGIONS(JUNGLE, ll, jungle)
      float savanna = 0.0; REGIONS(SAVANNA, ll, savanna)
      float steppe = 0.0; REGIONS(STEPPE, ll, steppe)
      float lake = 0.0; REGIONS(LAKE, vec2(latD, lonD) + vec2(n3, n4) * 0.25, lake)

      float interior = smoothstep(0.55, 0.97, cf.b);

      // ---- land
      vec3 cForest = vec3(0.14, 0.22, 0.09);
      vec3 cJungle = vec3(0.06, 0.15, 0.05);
      vec3 cGrass = vec3(0.33, 0.36, 0.17);
      vec3 cFarm = vec3(0.42, 0.42, 0.24);
      vec3 cSavanna = vec3(0.50, 0.44, 0.25);
      vec3 cSteppe = vec3(0.55, 0.49, 0.33);
      vec3 cDesert = vec3(0.80, 0.67, 0.47);
      vec3 cDesertPale = vec3(0.87, 0.79, 0.62);
      vec3 cDesertRed = vec3(0.70, 0.50, 0.33);
      vec3 cDesertDark = vec3(0.45, 0.36, 0.28);
      vec3 cTaiga = vec3(0.09, 0.15, 0.09);
      vec3 cTundra = vec3(0.38, 0.37, 0.30);
      vec3 cRock = vec3(0.40, 0.36, 0.31);
      vec3 cSnow = vec3(0.92, 0.94, 0.97);

      vec3 col = mix(cForest, cGrass, saturate(0.35 + n2 * 0.9 + interior * 0.45));
      col = mix(col, cFarm, saturate(n3 * 1.3 + 0.1) * 0.45 * (1.0 - smoothstep(55.0, 62.0, aLat)));
      col = mix(col, cSteppe, saturate(steppe * 1.3 + interior * 0.2 * smoothstep(35.0, 45.0, aLat)) * 0.9);
      col = mix(col, cSavanna, saturate(savanna * 1.3));
      col = mix(col, cJungle, saturate(jungle * 1.4));
      // Sand seas, ochre plains and dark rocky massifs; broad variation, fine streaks.
      vec3 dcol = mix(cDesert, cDesertRed, smoothstep(-0.35, 0.45, n1 + 0.4 * n2));
      dcol = mix(dcol, cDesertPale, smoothstep(0.05, 0.5, n2 + 0.25 * fbm(p * vec3(60.0, 20.0, 60.0), 3)) * 0.55);
      dcol = mix(dcol, cDesertDark, smoothstep(0.35, 0.75, elev + 0.25 * n3) * 0.7);
      dcol *= 0.92 + 0.16 * (n4 * 0.5 + 0.5);
      col = mix(col, dcol, saturate(desert * 1.35 - 0.05));
      // Boreal forest and tundra by latitude (the northern hemisphere carries most of it).
      float north = step(0.0, latD);
      float taiga = smoothstep(49.0, 56.0, aLat + n1 * 5.0) * (1.0 - smoothstep(64.0, 70.0, aLat + n1 * 4.0)) * mix(0.25, 1.0, north);
      col = mix(col, cTaiga * (0.85 + 0.3 * (n3 * 0.5 + 0.5)), taiga * (1.0 - desert));
      col = mix(col, cTundra * (0.85 + 0.3 * (n2 * 0.5 + 0.5)), smoothstep(63.0, 71.0, aLat + n1 * 4.0));
      // Mountains: bare rock, then snow above a latitude-dependent line.
      col = mix(col, cRock * (0.8 + 0.4 * (n3 * 0.5 + 0.5)), smoothstep(0.18, 0.55, elev) * 0.85);
      float snowLine = mix(0.62, 0.18, smoothstep(25.0, 62.0, aLat));
      col = mix(col, cSnow, smoothstep(snowLine, snowLine + 0.12, elev + n3 * 0.06) * 0.95);
      // Ice sheets: Antarctica, Greenland, the high Arctic islands.
      float greenland = smoothstep(59.5, 61.5, latD) * smoothstep(-74.0, -71.0, lonD) * (1.0 - smoothstep(-15.0, -11.0, lonD));
      float gEdge = smoothstep(0.62, 0.9, cf.g);
      float ice = max(smoothstep(-62.0, -64.0, latD), greenland * gEdge);
      ice = max(ice, smoothstep(76.0, 80.0, latD + n2 * 2.0));
      col = mix(col, cSnow * (0.93 + 0.07 * n3), saturate(ice));
      col *= 0.9 + 0.2 * (n4 * 0.5 + 0.5);

      // ---- water
      float shallowR = 0.0; REGIONS(SHALLOW, ll, shallowR)
      float turq = 0.0; REGIONS(TURQ, vec2(latD, lonD) + vec2(n3, n4) * 0.4, turq)
      float shelf = smoothstep(0.04, 0.45, cf.r) * (0.75 + 0.25 * n2);
      shelf = max(shelf, shallowR * smoothstep(-0.2, 0.4, n2 + 0.3) * 0.85);
      vec3 cDeep = vec3(0.010, 0.030, 0.078);
      vec3 cMid = vec3(0.016, 0.055, 0.125);
      vec3 cShelf = vec3(0.035, 0.135, 0.19);
      vec3 cShallow = vec3(0.09, 0.32, 0.36);
      vec3 water = mix(cDeep, cMid, saturate(smoothstep(0.0, 0.2, cf.g) * 0.8 + n1 * 0.25 + 0.1));
      water = mix(water, cShelf, saturate(shelf));
      water = mix(water, cShallow, saturate(turq * 1.2) * smoothstep(-0.3, 0.3, n3 + 0.2));
      // Polar sea ice: the Arctic pack and the Antarctic fringe.
      float seaIce = smoothstep(73.0, 79.0, latD + n2 * 5.0 + n3 * 2.0);
      seaIce = max(seaIce, smoothstep(-64.0, -69.0, latD + n2 * 4.0 + n3 * 2.0));
      seaIce *= smoothstep(-0.35, 0.1, n3 + n4 * 0.5 + 0.2);
      vec3 cIce = vec3(0.80, 0.85, 0.90) * (0.85 + 0.15 * n3);
      water = mix(water, cIce, saturate(seaIce));

      // Lakes the polygons keep as land.
      float lakeMask = smoothstep(0.35, 0.65, lake) * land;
      vec3 cLake = vec3(0.02, 0.06, 0.10);

      vec3 albedo = mix(water, col, land);
      albedo = mix(albedo, cLake, lakeMask);
      float wet = saturate((1.0 - land) * (1.0 - seaIce) + lakeMask);
      outColor = vec4(pow(albedo, vec3(2.2)), wet);
    }`,
    { srgb: true, mipmaps: true, uniforms, anisotropy },
  );
}

// Cyclones: [lat, lon, radiusDeg, strength]; the sign of strength sets the spin.
const CYCLONES = [
  [19, 134, 5.5, 1.0], [24, -63, 5, 0.9], [-15, 70, 5, 1.0], [49, -158, 11, 0.8], [57, -27, 10, 0.8], [-54, 18, 11, 0.8],
  [-52, 118, 12, 0.8], [-57, -112, 10, 0.7], [44, 170, 9, 0.6], [62, 5, 7, 0.5], [-45, -30, 9, 0.6], [12, -110, 4, 0.8],
];
// Stratocumulus decks off the subtropical west coasts: [lat, lon, rLat, rLon].
const DECKS = [
  [28, -128, 7, 12], [-18, -84, 8, 12], [-19, 5, 7, 10], [26, -22, 5, 8], [-30, 102, 5, 10], [45, -40, 5, 15], [40, 160, 5, 12],
];

/** Cloud cover: R = density, G = optical thickness, B = fine detail. */
export function bakeClouds(b: GpuBaker, width: number, height: number, anisotropy: number): WebGLRenderTarget {
  return b.bake(
    width,
    height,
    /* glsl */ `
    ${NOISE}
    ${REGION_FN}
    ${glslVec4Array("CYC", CYCLONES)}
    ${glslVec4Array("DECK", DECKS)}

    vec3 rotateAxis(vec3 v, vec3 k, float a) {
      float c = cos(a), s = sin(a);
      return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      float lon = (uv.x - 0.5) * TAU;
      float lat = (0.5 - uv.y) * PI;
      vec3 p = latLonToVec(lat, lon);
      float latD = degrees(lat);
      float aLat = abs(latD);

      // Spiral storms: rotate the sample point around each centre by an angle
      // that grows towards the eye.
      vec3 q = p;
      float storm = 0.0;
      float eye = 1.0;
      for (int i = 0; i < CYC.length(); i++) {
        vec3 c = latLonToVec(radians(CYC[i].x), radians(CYC[i].y));
        float r = radians(CYC[i].z);
        float d = acos(clamp(dot(q, c), -1.0, 1.0));
        float k = saturate(1.0 - d / (r * 2.2));
        float spin = CYC[i].x > 0.0 ? 1.0 : -1.0;
        q = rotateAxis(q, c, spin * CYC[i].w * 3.6 * k * k * k);
        storm = max(storm, CYC[i].w * exp(-sq(d / r)));
        if (CYC[i].z < 7.0) eye = min(eye, smoothstep(0.08, 0.2, d / r));
      }
      // Storm tracks: squash the noise domain north-south so systems streak
      // east-west, and lay long frontal bands along ridged noise.
      float track = smoothstep(22.0, 42.0, aLat) * (1.0 - smoothstep(70.0, 86.0, aLat));
      vec3 qs = vec3(q.x, q.y * (1.0 + 0.7 * track), q.z);
      vec3 w = vec3(fbm(qs * 3.1 + 1.3, 4), fbm(qs * 3.1 - 4.2, 4), fbm(qs * 3.1 + 7.7, 4));
      vec3 qw = qs + w * 0.11;
      float base = fbm(qw * 2.3, 6) * 0.5 + 0.5;
      float mid = fbm(qw * 8.5 + 3.3, 5) * 0.5 + 0.5;
      float fine = fbm(qw * 34.0 - 1.1, 5) * 0.5 + 0.5;
      float front = pow(saturate(1.0 - abs(snoise(qw * vec3(1.3, 2.4, 1.3) + 5.0))), 6.0) * track;

      // Coverage by latitude: ITCZ, dry subtropics, storm tracks, Southern Ocean.
      // The ITCZ is clusters, not a belt: its boost is gated by blob noise.
      float itcz = exp(-sq((latD - 6.0) / 6.5)) * smoothstep(-0.1, 0.35, fbm(p * 4.0 + 9.0, 3));
      float cov = 0.38
        + 0.2 * itcz
        - 0.18 * exp(-sq((aLat - 22.0) / 9.0))
        + 0.17 * smoothstep(35.0, 52.0, aLat) * (1.0 - 0.3 * smoothstep(70.0, 85.0, aLat))
        + 0.08 * smoothstep(-42.0, -55.0, latD);
      cov += 0.14 * fbm(p * 1.4 + 20.0, 3) + 0.3 * storm;
      float field = base * 0.62 + mid * 0.38 + (fine - 0.5) * 0.22 + front * 0.4;
      float thr = 1.0 - cov;
      float d = smoothstep(thr - 0.035, thr + 0.13, field);
      // Wispy, fractal edges.
      d *= smoothstep(0.22, 0.6, fine + d * 0.45);

      // Marine stratocumulus: a finely textured sheet off the subtropical west coasts.
      float deck = 0.0; REGIONS(DECK, vec2(latD, degrees(lon)) + vec2(w.x, w.y) * 5.0, deck)
      float cells = smoothstep(0.3, 0.75, 1.0 - worley(q * 260.0));
      d = max(d, deck * smoothstep(0.35, 0.65, mid) * (0.35 + 0.35 * cells));

      // Trade-wind cumulus: sparse speckle over the subtropical oceans.
      float trade = smoothstep(4.0, 12.0, aLat) * (1.0 - smoothstep(26.0, 34.0, aLat));
      float pop = smoothstep(0.64, 0.84, fbm(q * 70.0, 3) * 0.5 + 0.5) * smoothstep(0.45, 0.65, mid);
      d = max(d, pop * trade * 0.3);

      // Spiral bands and a clear eye in the tropical systems.
      d = max(d, storm * smoothstep(0.5, 0.72, base + (fine - 0.5) * 0.3 + 0.1) * 0.95);
      d *= eye;
      float thick = saturate(d * (0.3 + 0.9 * base) + storm * 0.25 + front * 0.2);
      outColor = vec4(saturate(d), thick, fine, 1.0);
    }`,
    { mipmaps: true, anisotropy },
  );
}

/** Milky Way and faint background light, linear HDR, equirectangular in world directions. */
export function bakeSky(b: GpuBaker, width: number, height: number, uniforms: Record<string, IUniform>): WebGLRenderTarget {
  return b.bake(
    width,
    height,
    /* glsl */ `
    uniform vec3 uGalN;
    uniform vec3 uGalC;
    ${NOISE}
    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      float lon = (uv.x - 0.5) * TAU;
      float lat = (0.5 - uv.y) * PI;
      vec3 d = latLonToVec(lat, lon);
      vec3 e2 = cross(uGalN, uGalC);
      float gb = asin(clamp(dot(d, uGalN), -1.0, 1.0));
      float gl = atan(dot(d, e2), dot(d, uGalC));

      float width = 0.11 + 0.05 * (fbm(d * 2.0, 3) * 0.5 + 0.5) + 0.08 * exp(-sq(gl / 0.7));
      float band = exp(-sq(gb / width));
      float core = exp(-sq(gl / 0.95));
      float bulge = exp(-(sq(gl / 0.32) + sq(gb / 0.18)));
      float clouds = saturate(fbm(d * 5.0 + 2.0, 7) * 0.5 + 0.5);
      float knots = pow(saturate(fbm(d * 18.0 - 4.0, 5) * 0.5 + 0.5), 3.0);
      float dust = smoothstep(0.42, 0.72, fbm(d * 7.0 + vec3(3.0, 1.0, -2.0), 7) * 0.5 + 0.5);
      float rift = exp(-sq((gb + 0.015 * snoise(d * 6.0)) / 0.035)) * smoothstep(1.9, 0.2, abs(gl));

      vec3 warm = vec3(1.0, 0.86, 0.72);
      vec3 cool = vec3(0.66, 0.74, 1.0);
      float lumps = pow(saturate(clouds * 1.25 - 0.2), 2.2);
      vec3 col = band * (0.18 + 0.82 * core) * (0.2 + 1.5 * lumps + 0.9 * knots) * mix(cool, warm, core * 0.7);
      col += bulge * warm * 0.8;
      col *= 1.0 - 0.85 * saturate(dust * band * 1.5 + rift * 0.95);
      // Magellanic clouds.
      vec3 lmc = normalize(uGalC * cos(radians(80.0)) - e2 * sin(radians(80.0)) - uGalN * 0.62);
      vec3 smc = normalize(uGalC * cos(radians(58.0)) - e2 * sin(radians(58.0)) - uGalN * 0.85);
      col += vec3(0.8, 0.8, 0.95) * (0.35 * exp(-sq(acos(clamp(dot(d, lmc), -1.0, 1.0)) / 0.05)) + 0.2 * exp(-sq(acos(clamp(dot(d, smc), -1.0, 1.0)) / 0.03))) * (0.6 + 0.8 * knots);
      // Very faint zodiacal / background glow keeps the black from reading as a hole.
      col += vec3(0.25, 0.3, 0.45) * 0.04 * (0.6 + 0.4 * clouds);
      outColor = vec4(col * 0.045, 1.0);
    }`,
    { type: HalfFloatType, uniforms, mipmaps: false },
  );
}
