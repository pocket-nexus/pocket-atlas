/** Offline .place readback and main-camera CPU budget estimate.
 * Mirrors Vita scene.rs pose/bounds, camera.rs infinite reverse-Z frustum and
 * frame.rs draw_meshes LOD at VITA30 step 0. It does not measure GPU time.
 * bun web/scripts/place-budget.ts --in .pocket-build/places/ID/ID.place --out .pocket-build/validation/ID/budget.json
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Keep in sync with pocket3d-place::VERSION; v7 requires vertex PBR decoding.
export const PLACE_VERSION = 7;

interface Range { offset: number; size: number }
type V3 = [number, number, number];
interface Lod { indices: Range; index_count: number; error: number }
interface Draw {
  material: number; layout: 'static' | 'baked' | 'skinned' | 'lights';
  vertices: Range; vertex_count: number; indices: Range; index_count: number;
  pos_offset: V3; pos_scale: V3; uv_offset: number[]; uv_scale: number[];
  min: V3; max: V3; node: number | null; skin: number | null; lods: Lod[];
}
interface Node { name: string; parent: number | null; translation: V3; rotation: number[]; scale: V3; track: Range | null }
interface Skin { joints: number[]; inverse_bind: Range }
interface Material { name: string; blend: string; albedo: number | null; normal: number | null; orm: number | null; emission: number | null; emissive_track: number | null; vertex_pbr?: boolean }
interface Texture { data: Range; width: number; height: number; mips: number }
export interface ShotKey { pos: V3; target: V3; fov: number }
interface Shot { name: string; from: ShotKey; to: ShotKey; duration: number }
export interface Meta {
  version: number; name: string; kind: string; min: V3; max: V3;
  textures: Texture[]; materials: Material[]; draws: Draw[]; nodes: Node[]; skins: Skin[];
  fps: number; frames: number; camera: { shots: Shot[]; intro: ShotKey };
  fog_tracks: { data: Range }[]; material_tracks: { data: Range }[];
  lights: { node: number | null }[]; fog_lights: { track: number | null }[];
  doors: { left: number; right: number } | null;
}
interface Section { tag: string; offset: number; size: number; align: number }
export interface Place { meta: Meta; sections: Section[]; geom: DataView; anim: DataView; bytes: number }
export interface Bounds { min: V3; max: V3 }
type Plane = [number, number, number, number];
export interface Counts {
  draws: number; triangles: number; movingDraws: number; movingTriangles: number;
  transparentDraws: number; culledFrustum: number; culledLod: number; lodDraws: Record<string, number>;
}
const STRIDE = { static: 24, baked: 28, skinned: 32, lights: 40 };
const WIDTH = 480, HEIGHT = 272, NEAR = 0.1;
const PHASES = ['from', 'mid', 'to'] as const;
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function integer(n: number, label: string) { assert(Number.isSafeInteger(n) && n >= 0, `${label}: expected a nonnegative integer`); }
function finite(a: number[], n: number, label: string) { assert(Array.isArray(a) && a.length === n && a.every(Number.isFinite), `${label}: expected ${n} finite components`); }
function reference(n: number | null | undefined, count: number, label: string) {
  if (n == null) return;
  index(n, count, label);
}
function index(n: number, count: number, label: string) {
  integer(n, label); assert(n < count, `${label}: reference ${n} outside 0..${count - 1}`);
}
function range(r: Range, section: DataView, align: number, label: string, size?: number) {
  assert(r != null, `${label}: missing range`); integer(r.offset, `${label}.offset`); integer(r.size, `${label}.size`);
  assert(r.offset % align === 0, `${label}: misaligned offset`);
  assert(r.offset + r.size <= section.byteLength, `${label}: range exceeds section`);
  if (size !== undefined) assert(r.size === size, `${label}: expected ${size} bytes, got ${r.size}`);
}
function floatRange(r: Range, section: DataView, count: number, label: string) {
  range(r, section, 4, label, count * 4);
  for (let k = 0; k < count; k++) assert(Number.isFinite(section.getFloat32(r.offset + k * 4, true)), `${label}: nonfinite float at ${k}`);
}
function boundsValid(lo: V3, hi: V3, label: string) {
  finite(lo, 3, `${label}.min`); finite(hi, 3, `${label}.max`);
  assert(lo.every((v, k) => v <= hi[k]!), `${label}: inverted bounds`);
}
function keyValid(k: ShotKey, label: string) {
  finite(k.pos, 3, `${label}.pos`); finite(k.target, 3, `${label}.target`);
  assert(k.pos.some((v, i) => Math.abs(v - k.target[i]!) > 1e-8), `${label}: eye equals target`);
  assert(Number.isFinite(k.fov) && k.fov > 0 && k.fov < 180, `${label}: invalid FOV`);
}

/** Reject bad references before reading blobs, including faults hidden in culled draws. */
export function readPlace(bytes: Uint8Array): Place {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  assert(bytes.length >= 16 && decoder.decode(bytes.subarray(0, 4)) === 'PLCE', 'not a .place pack');
  assert(view.getUint32(4, true) === PLACE_VERSION, 'unsupported .place version');
  const count = view.getUint32(8, true), tableEnd = 16 + count * 16;
  assert(count > 0 && tableEnd <= bytes.length, 'truncated section table');
  const sections: Section[] = [], tags = new Set<string>();
  for (let i = 0; i < count; i++) {
    const at = 16 + i * 16, tag = decoder.decode(bytes.subarray(at, at + 4));
    const offset = view.getUint32(at + 4, true), size = view.getUint32(at + 8, true), align = view.getUint32(at + 12, true);
    assert(align > 0 && (align & (align - 1)) === 0 && offset % align === 0, `${tag}: invalid alignment`);
    assert(offset >= tableEnd && offset + size <= bytes.length, `${tag}: range exceeds pack or overlaps header`);
    assert(!tags.has(tag), `${tag}: duplicate section`); tags.add(tag);
    sections.push({ tag, offset, size, align });
  }
  const sorted = [...sections].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) assert(sorted[i - 1]!.offset + sorted[i - 1]!.size <= sorted[i]!.offset, 'overlapping sections');
  const section = (tag: string) => {
    const s = sections.find(s => s.tag === tag); assert(s, `missing ${tag} section`);
    return new DataView(bytes.buffer, bytes.byteOffset + s.offset, s.size);
  };
  const md = section('META'), geom = section('GEOM'), anim = section('ANIM'), tex = section('TEXD');
  const meta: Meta = JSON.parse(decoder.decode(new Uint8Array(md.buffer, md.byteOffset, md.byteLength)));
  assert(meta.version === PLACE_VERSION, 'META version differs from container');
  for (const field of ['textures', 'materials', 'draws', 'nodes', 'skins', 'fog_tracks', 'material_tracks', 'lights', 'fog_lights'] as const) assert(Array.isArray(meta[field]), `missing META.${field}`);
  integer(meta.frames, 'frames'); assert(meta.frames > 0 && Number.isFinite(meta.fps) && meta.fps > 0, 'animation rate/length must be positive');
  boundsValid(meta.min, meta.max, 'scene');
  for (const [i, t] of meta.textures.entries()) {
    range(t.data, tex, 1, `texture ${i}`);
    for (const k of ['width', 'height', 'mips'] as const) { integer(t[k], `texture ${i}.${k}`); assert(t[k] > 0, `texture ${i}.${k}: zero`); }
  }
  for (const [i, m] of meta.materials.entries()) {
    for (const k of ['albedo', 'normal', 'orm', 'emission'] as const) reference(m[k], meta.textures.length, `material ${i}.${k}`);
    reference(m.emissive_track, meta.material_tracks.length, `material ${i}.emissive_track`);
  }
  for (const [i, n] of meta.nodes.entries()) {
    // Native update is a single forward pass, so a merely acyclic graph is insufficient.
    reference(n.parent, i, `node ${i}.parent`);
    finite(n.translation, 3, `node ${i}.translation`); finite(n.scale, 3, `node ${i}.scale`); finite(n.rotation, 4, `node ${i}.rotation`);
    assert(n.rotation.reduce((s, v) => s + v * v, 0) > 1e-12, `node ${i}: zero quaternion`);
    if (n.track) {
      floatRange(n.track, anim, meta.frames * 7, `node ${i}.track`);
      for (let f = 0; f < meta.frames; f++) {
        let length2 = 0, midLength2 = 0;
        for (let k = 3; k < 7; k++) {
          const a = anim.getFloat32(n.track.offset + (f * 7 + k) * 4, true);
          const b = anim.getFloat32(n.track.offset + (((f + 1) % meta.frames) * 7 + k) * 4, true);
          length2 += a * a; midLength2 += (a + b) * (a + b);
        }
        assert(length2 > 1e-12 && midLength2 > 1e-12, `node ${i}.track: degenerate quaternion at frame ${f}`);
      }
    }
  }
  for (const [i, s] of meta.skins.entries()) {
    assert(s.joints.length > 0 && s.joints.length <= 24, `skin ${i}: shader requires 1..24 joints`);
    s.joints.forEach((n, j) => index(n, meta.nodes.length, `skin ${i}.joint ${j}`));
    floatRange(s.inverse_bind, anim, s.joints.length * 16, `skin ${i}.inverse_bind`);
  }
  for (const [i, d] of meta.draws.entries()) {
    const label = `draw ${i}`, stride = STRIDE[d.layout];
    assert(stride !== undefined, `${label}: unknown vertex layout`);
    index(d.material, meta.materials.length, `${label}.material`);
    reference(d.node, meta.nodes.length, `${label}.node`); reference(d.skin, meta.skins.length, `${label}.skin`);
    integer(d.vertex_count, `${label}.vertex_count`); assert(d.vertex_count > 0 && d.vertex_count <= 65536, `${label}: invalid vertex count`);
    range(d.vertices, geom, 2, `${label}.vertices`, d.vertex_count * stride);
    boundsValid(d.min, d.max, label); finite(d.pos_offset, 3, `${label}.pos_offset`); finite(d.pos_scale, 3, `${label}.pos_scale`);
    assert(d.pos_scale.every(v => v >= 0), `${label}: negative dequantisation extent`);
    finite(d.uv_offset, 2, `${label}.uv_offset`); finite(d.uv_scale, 2, `${label}.uv_scale`);
    if (d.layout === 'lights') {
      // Light fields use the native shared sequential index buffer; their
      // index_count counts points, not triangle indices in the GEOM blob.
      assert(d.vertex_count <= 16384 && d.index_count === d.vertex_count, `${label}: invalid light point count`);
      range(d.indices, geom, 2, `${label}.indices`, 0);
      assert(d.node == null && d.skin == null && !d.lods.length, `${label}: light fields cannot have mesh transforms or LODs`);
      for (let v = 0; v < d.vertex_count; v++) {
        const at = d.vertices.offset + v * stride;
        for (let k = 12; k <= 32; k += 4) assert(Number.isFinite(geom.getFloat32(at + k, true)), `${label}: nonfinite light value`);
        assert(geom.getFloat32(at + 12, true) >= 0 && geom.getFloat32(at + 16, true) >= 0, `${label}: negative light intensity or radius`);
      }
      continue;
    }
    const indices = (r: Range, n: number, label: string) => {
      integer(n, `${label}.count`); assert(n % 3 === 0, `${label}: incomplete triangle`); range(r, geom, 2, label, n * 2);
      for (let k = 0; k < n; k++) assert(geom.getUint16(r.offset + k * 2, true) < d.vertex_count, `${label}: index ${k} exceeds vertex count`);
    };
    indices(d.indices, d.index_count, `${label}.indices`);
    let error = 0;
    for (const [j, l] of (d.lods ?? []).entries()) {
      assert(Number.isFinite(l.error) && l.error >= error && l.error >= 0, `${label}.LOD${j + 1}: errors must be finite and ordered`);
      error = l.error; indices(l.indices, l.index_count, `${label}.LOD${j + 1}`);
    }
    if (d.layout === 'skinned') {
      assert(d.skin != null, `${label}: skinned vertices without a skin`);
      const joints = meta.skins[d.skin]!.joints.length;
      for (let v = 0; v < d.vertex_count; v++) {
        const at = d.vertices.offset + v * stride + 24; let weight = 0;
        for (let k = 0; k < 4; k++) {
          assert(geom.getUint8(at + k) < joints, `${label}: vertex ${v} joint ${k} exceeds skin`);
          weight += geom.getUint8(at + 4 + k);
        }
        assert(weight > 0, `${label}: vertex ${v} has zero skin weights`);
      }
    } else assert(d.skin == null, `${label}: skin without skinned vertices`);
  }
  meta.fog_tracks.forEach((t, i) => floatRange(t.data, anim, meta.frames * 4, `fog track ${i}`));
  meta.material_tracks.forEach((t, i) => floatRange(t.data, anim, meta.frames, `material track ${i}`));
  meta.lights.forEach((l, i) => reference(l.node, meta.nodes.length, `light ${i}.node`));
  meta.fog_lights.forEach((l, i) => reference(l.track, meta.fog_tracks.length, `fog light ${i}.track`));
  if (meta.doors) { index(meta.doors.left, meta.nodes.length, 'doors.left'); index(meta.doors.right, meta.nodes.length, 'doors.right'); }
  assert(meta.camera?.shots?.length > 0, 'no camera shots'); keyValid(meta.camera.intro, 'camera.intro');
  meta.camera.shots.forEach((s, i) => { keyValid(s.from, `shot ${i}.from`); keyValid(s.to, `shot ${i}.to`); assert(s.duration > 0 && Number.isFinite(s.duration), `shot ${i}: invalid duration`); });
  return { meta, sections, geom, anim, bytes: bytes.length };
}

/** Native tracks linearly interpolate all seven values then normalise rotation. */
export function pose(place: Place, time: number): Matrix4[] {
  const { meta, anim } = place, frame = ((time * meta.fps) % meta.frames + meta.frames) % meta.frames;
  const f0 = Math.floor(frame), f1 = (f0 + 1) % meta.frames, t = frame - f0;
  const world: Matrix4[] = [];
  for (const n of meta.nodes) {
    let tr = n.translation, rot = n.rotation;
    if (n.track) {
      const v = Array.from({ length: 7 }, (_, k) => {
        const a = anim.getFloat32(n.track!.offset + (f0 * 7 + k) * 4, true), b = anim.getFloat32(n.track!.offset + (f1 * 7 + k) * 4, true);
        return a + (b - a) * t;
      });
      tr = v.slice(0, 3) as V3; rot = v.slice(3);
    }
    const q = new Quaternion().fromArray(rot); if (n.track) q.normalize();
    const local = new Matrix4().compose(new Vector3().fromArray(tr), q, new Vector3().fromArray(n.scale));
    world.push(n.parent == null ? local : new Matrix4().multiplyMatrices(world[n.parent]!, local));
  }
  return world;
}
function transformedBounds(center: V3, extent: V3, m: Matrix4): Bounds {
  const e = m.elements, c = new Vector3().fromArray(center).applyMatrix4(m);
  const ex = Math.abs(e[0]!) * extent[0] + Math.abs(e[4]!) * extent[1] + Math.abs(e[8]!) * extent[2];
  const ey = Math.abs(e[1]!) * extent[0] + Math.abs(e[5]!) * extent[1] + Math.abs(e[9]!) * extent[2];
  const ez = Math.abs(e[2]!) * extent[0] + Math.abs(e[6]!) * extent[1] + Math.abs(e[10]!) * extent[2];
  return { min: [c.x - ex, c.y - ey, c.z - ez], max: [c.x + ex, c.y + ey, c.z + ez] };
}
export function drawBounds(place: Place, draw: Draw, world: Matrix4[]): Bounds {
  if (draw.node != null) return transformedBounds(draw.pos_offset, draw.pos_scale, world[draw.node]!);
  if (draw.skin != null) {
    const skin = place.meta.skins[draw.skin]!, result: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    skin.joints.forEach((node, joint) => {
      const inv = new Matrix4().fromArray(Array.from({ length: 16 }, (_, k) => place.anim.getFloat32(skin.inverse_bind.offset + (joint * 16 + k) * 4, true)));
      const b = transformedBounds(draw.pos_offset, draw.pos_scale, new Matrix4().multiplyMatrices(world[node]!, inv));
      for (let k = 0; k < 3; k++) { result.min[k] = Math.min(result.min[k]!, b.min[k]!); result.max[k] = Math.max(result.max[k]!, b.max[k]!); }
    });
    return result;
  }
  return { min: draw.min, max: draw.max };
}
/** Five planes: an infinite far distance must not discard the rail corridor. */
export function frustum(key: ShotKey): Plane[] {
  const f = 1 / Math.tan(key.fov * Math.PI / 360), aspect = WIDTH / HEIGHT;
  const p = new Matrix4().fromArray([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, 0, -1, 0, 0, NEAR, 0]);
  const eye = new Vector3().fromArray(key.pos), target = new Vector3().fromArray(key.target);
  const view = new Matrix4().lookAt(eye, target, new Vector3(0, 1, 0)).setPosition(eye).invert();
  const e = p.multiply(view).elements;
  const row = (r: number) => [e[r]!, e[r + 4]!, e[r + 8]!, e[r + 12]!];
  const [x, y, z, w] = [row(0), row(1), row(2), row(3)];
  return [[x!, 1], [x!, -1], [y!, 1], [y!, -1], [z!, -1]].map(([r, sign]) => {
    const q = w!.map((v, k) => v + (r as number[])[k]! * (sign as number));
    const length = Math.hypot(q[0]!, q[1]!, q[2]!); return q.map(v => v / length) as Plane;
  });
}
export function visible(planes: Plane[], b: Bounds): boolean {
  return planes.every(p => p[0] * (p[0] >= 0 ? b.max[0] : b.min[0]) + p[1] * (p[1] >= 0 ? b.max[1] : b.min[1]) + p[2] * (p[2] >= 0 ? b.max[2] : b.min[2]) + p[3] >= 0);
}
function nearestDistance(b: Bounds, key: ShotKey): number {
  let distance2 = 0;
  for (let k = 0; k < 3; k++) { const v = key.pos[k]!, delta = Math.max(b.min[k]!, Math.min(b.max[k]!, v)) - v; distance2 += delta * delta; }
  return Math.sqrt(distance2);
}
function lodLimit(b: Bounds, key: ShotKey): number { return Math.max(nearestDistance(b, key), 0.1) * 2 * Math.tan(key.fov * Math.PI / 360) / HEIGHT; }
export function selectLod(draw: Draw, b: Bounds, key: ShotKey): number {
  const limit = lodLimit(b, key);
  for (let i = (draw.lods ?? []).length - 1; i >= 0; i--) if (draw.lods[i]!.error < limit) return i + 1;
  return 0;
}
function countFrame(place: Place, bounds: Bounds[], key: ShotKey, planes: Plane[]): Counts {
  const count: Counts = { draws: 0, triangles: 0, movingDraws: 0, movingTriangles: 0, transparentDraws: 0, culledFrustum: 0, culledLod: 0, lodDraws: {} };
  place.meta.draws.forEach((d, i) => {
    if (d.layout === 'lights') return;
    const b = bounds[i]!;
    if (!visible(planes, b)) { count.culledFrustum++; return; }
    const lod = selectLod(d, b, key), triangles = (lod ? d.lods[lod - 1]!.index_count : d.index_count) / 3;
    if (triangles === 0) { count.culledLod++; return; }
    count.draws++; count.triangles += triangles; count.lodDraws[`LOD${lod}`] = (count.lodDraws[`LOD${lod}`] ?? 0) + 1;
    if (d.node != null || d.skin != null) { count.movingDraws++; count.movingTriangles += triangles; }
    if (place.meta.materials[d.material]!.blend !== 'opaque') count.transparentDraws++;
  });
  return count;
}
function lerpKey(a: ShotKey, b: ShotKey, t: number): ShotKey {
  return { pos: a.pos.map((v, i) => v + (b.pos[i]! - v) * t) as V3, target: a.target.map((v, i) => v + (b.target[i]! - v) * t) as V3, fov: a.fov + (b.fov - a.fov) * t };
}
interface Peak { time: number; shot: string; pose: string; counts: Counts }
function peak(a: Peak | null, b: Peak, metric: 'draws' | 'triangles' | 'movingTriangles'): Peak { return a == null || b.counts[metric] > a.counts[metric] ? b : a; }
function peakDetails(place: Place, p: Peak) {
  const shot = place.meta.camera.shots.find(s => s.name === p.shot)!;
  const key = lerpKey(shot.from, shot.to, PHASES.indexOf(p.pose as typeof PHASES[number]) / 2);
  const world = pose(place, p.time), planes = frustum(key);
  const draws = place.meta.draws.flatMap((d, i) => {
    if (d.layout === 'lights') return [];
    const bounds = drawBounds(place, d, world);
    if (!visible(planes, bounds)) return [];
    const lod = selectLod(d, bounds, key), chosen = lod ? d.lods[lod - 1]! : null;
    const triangles = (chosen?.index_count ?? d.index_count) / 3;
    if (!triangles) return [];
    const path: string[] = []; let node = d.node;
    while (node != null) { path.unshift(place.meta.nodes[node]!.name); node = place.meta.nodes[node]!.parent; }
    return [{ draw: i, name: path.at(-1) ?? (d.skin != null ? `skin ${d.skin}` : 'static'), nodePath: path,
      material: place.meta.materials[d.material]!.name, moving: d.node != null || d.skin != null,
      baseTriangles: d.index_count / 3, triangles, lod, error: chosen?.error ?? 0,
      levels: d.lods.map((l, i) => ({ lod: i + 1, triangles: l.index_count / 3, error: l.error })),
      nearDistance: nearestDistance(bounds, key), errorLimit: lodLimit(bounds, key), bounds }];
  }).sort((a, b) => b.triangles - a.triangles);
  const materials = new Map<string, { material: string; draws: number; triangles: number; movingTriangles: number }>();
  for (const d of draws) {
    const m = materials.get(d.material) ?? { material: d.material, draws: 0, triangles: 0, movingTriangles: 0 };
    m.draws++; m.triangles += d.triangles; if (d.moving) m.movingTriangles += d.triangles;
    materials.set(d.material, m);
  }
  return { time: p.time, shot: p.shot, pose: p.pose,
    topMoving: draws.filter(d => d.moving).slice(0, 30), topStatic: draws.filter(d => !d.moving).slice(0, 30),
    materials: [...materials.values()].sort((a, b) => b.triangles - a.triangles) };
}

export function budget(place: Place, sampleFps = 15) {
  assert(Number.isFinite(sampleFps) && sampleFps > 0, 'sample FPS must be positive');
  const { meta } = place, duration = meta.frames / meta.fps, samples = Math.max(1, Math.ceil(duration * sampleFps));
  const views = meta.camera.shots.flatMap(s => PHASES.map((name, i) => {
    const key = lerpKey(s.from, s.to, i / 2);
    return { shot: s.name, pose: name, key, planes: frustum(key), peaks: { draws: null as Peak | null, triangles: null as Peak | null, movingTriangles: null as Peak | null } };
  }));
  let drawPeak: Peak | null = null, trianglePeak: Peak | null = null, movingPeak: Peak | null = null;
  const lodDrawSamples: Record<string, number> = {};
  for (let frame = 0; frame < samples; frame++) {
    const time = frame / sampleFps, world = pose(place, time), bounds = meta.draws.map(d => drawBounds(place, d, world));
    for (const v of views) {
      const counts = countFrame(place, bounds, v.key, v.planes), p: Peak = { time, shot: v.shot, pose: v.pose, counts };
      drawPeak = peak(drawPeak, p, 'draws'); trianglePeak = peak(trianglePeak, p, 'triangles'); movingPeak = peak(movingPeak, p, 'movingTriangles');
      for (const metric of ['draws', 'triangles', 'movingTriangles'] as const) v.peaks[metric] = peak(v.peaks[metric], p, metric);
      for (const [lod, n] of Object.entries(counts.lodDraws)) lodDrawSamples[lod] = (lodDrawSamples[lod] ?? 0) + n;
    }
  }
  const moving = meta.draws.filter(d => d.node != null || d.skin != null), guide = { draws: 250, triangles: 130000, movingTriangles: 30000, packMiB: 50.6 };
  return {
    evidence: 'offline CPU main-camera culling and geometry estimate; NOT device compile, GPU timing, frame rate, or visual acceptance',
    model: { profile: 'vita30', step: 0, width: WIDTH, height: HEIGHT, near: NEAR, far: 'infinite', lodPixels: 1, cullSize: 0, skinBounds: 'union of bind AABB transformed by each joint world * inverse bind', doorState: 'closed', numericPrecision: 'host double; device uses float32' },
    sampling: { fps: sampleFps, duration, frames: samples, cameraPoses: PHASES, combinations: samples * views.length, interval: '[0, duration)' },
    limits: ['Main scene mesh passes only; excludes light-field sprites, shadow, reflection, sky, postprocessing, rain, UI and draw submission costs.', 'Conservative bounds include occluded geometry; no occlusion or raster coverage estimate.', 'Three camera poses per shot and fixed time samples are estimates; between-sample and free-camera peaks may be higher.', 'No device connected or read. Planning guides are not performance gates.'],
    pack: { name: meta.name, kind: meta.kind, bytes: place.bytes, MiB: place.bytes / 1048576, sections: place.sections, draws: meta.draws.length, triangles: meta.draws.reduce((n, d) => n + (d.layout === 'lights' ? 0 : d.index_count / 3), 0), lightPoints: meta.draws.reduce((n, d) => n + (d.layout === 'lights' ? d.vertex_count : 0), 0), movingDraws: moving.length, movingTriangles: moving.reduce((n, d) => n + d.index_count / 3, 0), drawsWithLod: meta.draws.filter(d => d.lods.length).length, nodes: meta.nodes.length, animatedNodes: meta.nodes.filter(n => n.track).length, skins: meta.skins.length, textures: meta.textures.length },
    readback: { valid: true, checked: ['section table and range alignment', 'geometry and texture ranges', 'all base and LOD indices', 'material/node/skin/texture/track references', 'skin joint indices and nonzero weights', 'parent-before-child hierarchy', 'finite animation and inverse-bind floats', 'nondegenerate interpolated quaternion keys', 'camera and dequantisation bounds'] },
    peaks: { draws: drawPeak, triangles: trianglePeak, movingTriangles: movingPeak }, lodDrawSamples,
    peakDetails: { triangles: peakDetails(place, trianglePeak!), movingTriangles: peakDetails(place, movingPeak!) },
    guide, exceedsGuide: { draws: drawPeak!.counts.draws > guide.draws, triangles: trianglePeak!.counts.triangles > guide.triangles, movingTriangles: movingPeak!.counts.movingTriangles > guide.movingTriangles, packMiB: place.bytes / 1048576 > guide.packMiB },
    shots: views.map(v => ({ shot: v.shot, pose: v.pose, key: v.key, peaks: v.peaks })),
  };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2), value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const input = value('--in'), output = value('--out');
  if (!input || !output) throw new Error('Usage: bun web/scripts/place-budget.ts --in PACK.place --out REPORT.json [--fps 15]');
  const bytes = new Uint8Array(await Bun.file(input).arrayBuffer()), place = readPlace(bytes);
  const report = { input: resolve(input), sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), ...budget(place, Number(value('--fps') ?? 15)) };
  await mkdir(dirname(resolve(output)), { recursive: true }); await Bun.write(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: resolve(output), packMiB: report.pack.MiB, peaks: report.peaks, exceedsGuide: report.exceedsGuide }, null, 2));
}
