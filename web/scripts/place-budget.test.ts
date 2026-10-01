import { describe, expect, test } from 'bun:test';
import { Matrix4 } from 'three';
import { budget, drawBounds, frustum, pose, readPlace, selectLod, visible } from './place-budget';
import type { Meta, ShotKey } from './place-budget';

const key: ShotKey = { pos: [0, 0, 0], target: [0, 0, -1], fov: 60 };
function fixture() {
  const meta: Meta = {
    version: 5, name: 'Fixture', kind: 'daytime-street', min: [-1, -1, -11], max: [1, 1, -9],
    textures: [], materials: [{ name: 'Metal', blend: 'opaque', albedo: null, normal: null, orm: null, emission: null, emissive_track: null }],
    draws: [{ material: 0, layout: 'static', vertices: { offset: 0, size: 72 }, vertex_count: 3, indices: { offset: 72, size: 6 }, index_count: 3,
      pos_offset: [0, 0, -10], pos_scale: [1, 1, 1], uv_offset: [0, 0], uv_scale: [1, 1], min: [-1, -1, -11], max: [1, 1, -9], node: null, skin: null,
      lods: [{ indices: { offset: 78, size: 6 }, index_count: 3, error: 0.02 }, { indices: { offset: 84, size: 0 }, index_count: 0, error: 0.2 }] }],
    nodes: [], skins: [], fps: 2, frames: 2, camera: { shots: [{ name: 'Forward', from: key, to: key, duration: 10 }], intro: key },
    fog_tracks: [], material_tracks: [], lights: [], fog_lights: [], doors: null,
  };
  const geom = new Uint8Array(84), view = new DataView(geom.buffer);
  for (let i = 0; i < 3; i++) { view.setUint16(72 + i * 2, i, true); view.setUint16(78 + i * 2, i, true); }
  return { meta, geom, anim: new Uint8Array(0) };
}
function serialize(f: ReturnType<typeof fixture>): Uint8Array {
  const sections = [['META', new TextEncoder().encode(JSON.stringify(f.meta))], ['TEXD', new Uint8Array(0)], ['GEOM', f.geom], ['ANIM', f.anim]] as const;
  const offsets: number[] = []; let end = 80;
  sections.forEach(([, data]) => { end = Math.ceil(end / 4) * 4; offsets.push(end); end += data.length; });
  const result = new Uint8Array(end), view = new DataView(result.buffer);
  result.set(new TextEncoder().encode('PLCE')); view.setUint32(4, 5, true); view.setUint32(8, 4, true);
  sections.forEach(([tag, data], i) => {
    const h = 16 + i * 16;
    result.set(new TextEncoder().encode(tag), h); view.setUint32(h + 4, offsets[i]!, true); view.setUint32(h + 8, data.length, true); view.setUint32(h + 12, 4, true);
    result.set(data, offsets[i]!);
  });
  return result;
}
function withTrack() {
  const f = fixture();
  f.meta.nodes = [
    { name: 'Parent', parent: null, translation: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], track: null },
    { name: 'Moving', parent: 0, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], track: { offset: 0, size: 56 } },
  ];
  const anim = new Float32Array([0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  f.anim = new Uint8Array(anim.buffer); f.meta.draws[0]!.node = 1;
  return f;
}
function withSkin() {
  const f = fixture();
  f.meta.nodes = [
    { name: 'Joint A', parent: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], track: null },
    { name: 'Joint B', parent: null, translation: [15, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], track: null },
  ];
  f.meta.skins = [{ joints: [0, 1], inverse_bind: { offset: 0, size: 128 } }];
  // Joint B was bound at x=5, so its deformation is +10, not +15.
  f.anim = new Uint8Array(new Float32Array([...new Matrix4().elements, ...new Matrix4().makeTranslation(-5, 0, 0).elements]).buffer);
  const d = f.meta.draws[0]!; d.layout = 'skinned'; d.skin = 0; d.vertices.size = 96; d.indices.offset = 96; d.lods = [];
  f.geom = new Uint8Array(102);
  for (let i = 0; i < 3; i++) { f.geom[i * 32 + 24] = i % 2; f.geom[i * 32 + 28] = 255; new DataView(f.geom.buffer).setUint16(96 + i * 2, i, true); }
  return f;
}

describe('place readback rejects unusable GPU inputs', () => {
  test('reads complete ranges, indices and metadata', () => {
    const pack = readPlace(serialize(fixture())); expect(pack.meta.name).toBe('Fixture');
    const report = budget(pack); expect(report.readback.valid).toBe(true); expect(report.sampling.combinations).toBe(45);
    expect(report.peaks.triangles!.counts.triangles).toBe(1); expect(report.peaks.draws!.counts.lodDraws).toEqual({ LOD1: 1 });
  });
  test('checks the section table, overlapping blobs and truncated payload', () => {
    const original = serialize(fixture());
    expect(() => readPlace(original.subarray(0, original.length - 1))).toThrow('range exceeds pack');
    const duplicate = original.slice(); duplicate.set(new TextEncoder().encode('META'), 32);
    expect(() => readPlace(duplicate)).toThrow('duplicate section');
    const overlap = original.slice(), view = new DataView(overlap.buffer);
    view.setUint32(52, view.getUint32(20, true), true);
    expect(() => readPlace(overlap)).toThrow('overlapping sections');
  });
  test('checks culled meshes too, including LOD indices and material references', () => {
    const f = fixture(); f.meta.draws[0]!.min = [-1, -1, 9]; f.meta.draws[0]!.max = [1, 1, 11];
    new DataView(f.geom.buffer).setUint16(78, 3, true);
    expect(() => readPlace(serialize(f))).toThrow('LOD1: index 0 exceeds vertex count');
    const badMaterial = fixture(); badMaterial.meta.draws[0]!.material = 1;
    expect(() => readPlace(serialize(badMaterial))).toThrow('material: reference 1');
    const badRange = fixture(); badRange.meta.draws[0]!.vertices.size = 74;
    expect(() => readPlace(serialize(badRange))).toThrow('expected 72 bytes');
  });
  test('rejects nonfinite animation and hierarchy that native cannot evaluate in order', () => {
    const f = withTrack(); new DataView(f.anim.buffer).setFloat32(0, NaN, true);
    expect(() => readPlace(serialize(f))).toThrow('nonfinite float');
    const badParent = withTrack(); badParent.meta.nodes[0]!.parent = 1;
    expect(() => readPlace(serialize(badParent))).toThrow('node 0.parent');
    const shortTrack = withTrack(); shortTrack.meta.nodes[1]!.track!.size -= 4;
    expect(() => readPlace(serialize(shortTrack))).toThrow('expected 56 bytes');
  });
  test('rejects a zero quaternion between opposite signed keys', () => {
    const f = withTrack(), v = new DataView(f.anim.buffer);
    [0, 0, 0, -1].forEach((n, i) => v.setFloat32((10 + i) * 4, n, true));
    expect(() => readPlace(serialize(f))).toThrow('degenerate quaternion');
  });
  test('checks shader joint limit, vertex joints and inverse bind data', () => {
    const f = withSkin(); f.geom[24] = 2;
    expect(() => readPlace(serialize(f))).toThrow('joint 0 exceeds skin');
    const zero = withSkin(); zero.geom[28] = 0;
    expect(() => readPlace(serialize(zero))).toThrow('zero skin weights');
    const nonfinite = withSkin(); new DataView(nonfinite.anim.buffer).setFloat32(0, Infinity, true);
    expect(() => readPlace(serialize(nonfinite))).toThrow('nonfinite float');
    const tooMany = withSkin(); tooMany.meta.skins[0]!.joints = Array(25).fill(0);
    expect(() => readPlace(serialize(tooMany))).toThrow('1..24 joints');
  });
});

describe('native visibility and animation budget model', () => {
  test('infinite reverse-Z keeps the distant corridor and culls behind/near/side boxes', () => {
    const planes = frustum(key);
    expect(planes).toHaveLength(5);
    expect(visible(planes, { min: [-1, -1, -100001], max: [1, 1, -99999] })).toBe(true);
    expect(visible(planes, { min: [-1, -1, 9], max: [1, 1, 11] })).toBe(false);
    expect(visible(planes, { min: [-0.01, -0.01, -0.08], max: [0.01, 0.01, -0.02] })).toBe(false);
    expect(visible(planes, { min: [99, -1, -11], max: [101, 1, -9] })).toBe(false);
    const turned = frustum({ pos: [3, 2, 1], target: [4, 2, 1], fov: 60 });
    expect(visible(turned, { min: [10, 1, 0], max: [12, 3, 2] })).toBe(true);
    expect(visible(turned, { min: [-12, 1, 0], max: [-10, 3, 2] })).toBe(false);
  });
  test('selects LOD using nearest AABB distance, allowing empty far LOD', () => {
    const d = fixture().meta.draws[0]!;
    expect(selectLod(d, { min: [-1, -1, -3], max: [1, 1, -1] }, key)).toBe(0);
    expect(selectLod(d, { min: [-1, -1, -11], max: [1, 1, -9] }, key)).toBe(1);
    expect(selectLod(d, { min: [-1, -1, -101], max: [1, 1, -99] }, key)).toBe(2);
    // Long geometry passing next to the eye stays detailed even if its centre is distant.
    expect(selectLod(d, { min: [-1, -1, -100], max: [1, 1, -1] }, key)).toBe(0);
  });
  test('normalised linear rotation, parent transforms and seam wrap match native pose', () => {
    const pack = readPlace(serialize(withTrack())), halfway = pose(pack, 0.25)[1]!;
    expect(halfway.elements[12]).toBeCloseTo(11, 6);
    expect(halfway.elements[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(halfway.elements[2]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(pose(pack, 1)[1]!.elements).toEqual(pose(pack, 0)[1]!.elements);
    expect(pose(pack, -0.25)[1]!.elements).toEqual(pose(pack, 0.75)[1]!.elements);
  });
  test('rigid bounds conservatively transform a scaled and rotated dequant box', () => {
    const f = fixture(), d = f.meta.draws[0]!; d.node = 0; d.pos_offset = [1, 0, 0]; d.pos_scale = [2, 1, 0.5];
    f.meta.nodes = [{ name: 'Rigid', parent: null, translation: [10, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 1, 1], track: null }];
    const pack = readPlace(serialize(f)), b = drawBounds(pack, pack.meta.draws[0]!, pose(pack, 0));
    expect(b.min[0]).toBeCloseTo(9); expect(b.max[0]).toBeCloseTo(11);
    expect(b.min[1]).toBeCloseTo(-2); expect(b.max[1]).toBeCloseTo(6);
  });
  test('skin bounds include every joint and subtract its bind transform', () => {
    const pack = readPlace(serialize(withSkin())), b = drawBounds(pack, pack.meta.draws[0]!, pose(pack, 0));
    expect(b).toEqual({ min: [-1, -1, -11], max: [11, 1, -9] });
    const report = budget(pack, 2); expect(report.peaks.movingTriangles!.counts.movingTriangles).toBe(1);
  });
  test('enumerates full-loop motion independently for all shot camera poses', () => {
    const f = withTrack(); f.meta.nodes[0]!.translation = [0, 0, 0];
    // At t=0 the object is behind the eye; at t=.5 it moves into view.
    f.meta.draws[0]!.pos_offset = [0, 0, 0]; f.meta.draws[0]!.pos_scale = [1, 1, 1]; f.meta.draws[0]!.lods = [];
    f.anim = new Uint8Array(new Float32Array([0, 0, 10, 0, 0, 0, 1, 0, 0, -10, 0, 0, 0, 1]).buffer);
    const report = budget(readPlace(serialize(f)), 2);
    expect(report.sampling.combinations).toBe(6); expect(report.shots).toHaveLength(3);
    expect(report.peaks.movingTriangles!.time).toBe(0.5); expect(report.peaks.movingTriangles!.counts.movingTriangles).toBe(1);
    expect(report.evidence).toContain('NOT device compile');
  });
});
