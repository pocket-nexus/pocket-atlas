//! RouteIR → a Vita route pack (`.route`).
//!
//! A RouteIR directory holds the route's kit as a place export (`kit/`: the
//! car, a swatch of every material, the sky, the light and the look, cooked
//! by the place pipeline), and the world the route's generators made:
//!
//! ```text
//! route.json   the route: length, layers, stops, limits, the car, views
//! line.bin     the driven line: count × { x, y, z, half width } f32
//! cells.bin    every cell of every layer, float geometry by kit material name
//! ```
//!
//! `cells.bin` (little-endian): "RCEL", version, material count, cell count,
//! offset of the first cell; the material names (u16 length + UTF-8); from
//! that offset, per cell: layer u32, ix i32, iz i32, primitive count u32, origin f64 × 3; per
//! primitive: material u32, vertex count u32, index count u32, flags u32,
//! then positions f32 × 3 (relative to the origin), normals f32 × 3, UVs
//! f32 × 2, sRGB colours u8 × 4 and indices u32.
//!
//! The Vita lowering bakes the sky's light into every vertex (hemisphere
//! and probe, scaled by the sky a vertex sees past the banks, trees and
//! walls around it — there is no sun on a snowy afternoon), builds reduced
//! index lists per draw with the edges a cell shares with its neighbours
//! held, quantizes each cell in its own frame and writes each as one blob
//! a runtime reads when the vehicle comes near.

use crate::geometry::{self, Vertex};
use crate::{bake, cook_place, ir, occlusion, place_pack, Args, Cooked};
use glam::{Vec2, Vec3};
use pocket3d_place as pc;
use pocket3d_place::route as rt;
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

struct Prim {
    material: u32,
    position: Vec<Vec3>,
    normal: Vec<Vec3>,
    uv: Vec<Vec2>,
    color: Vec<[u8; 4]>,
    tris: Vec<[u32; 3]>,
}

struct Cell {
    layer: u32,
    ix: i32,
    iz: i32,
    origin: [f64; 3],
    prims: Vec<Prim>,
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        let s = self.b.get(self.at..self.at + n).ok_or("cells.bin: truncated")?;
        self.at += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32, String> {
        Ok(self.u32()? as i32)
    }
    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn f32s(&mut self, n: usize) -> Result<Vec<f32>, String> {
        Ok(self.take(n * 4)?.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
    }
}

/// The cells and the material names they use.
fn read_cells(bytes: &[u8]) -> Result<(Vec<String>, Vec<Cell>), String> {
    let mut r = Reader { b: bytes, at: 0 };
    if r.take(4)? != b"RCEL" {
        return Err("cells.bin: not a route cell file".into());
    }
    let version = r.u32()?;
    if version != 1 {
        return Err(format!("cells.bin: unsupported version {version}"));
    }
    let (materials, count, cells_at) = (r.u32()? as usize, r.u32()? as usize, r.u32()? as usize);
    let mut names = Vec::with_capacity(materials);
    for _ in 0..materials {
        let n = u16::from_le_bytes(r.take(2)?.try_into().unwrap()) as usize;
        names.push(String::from_utf8(r.take(n)?.to_vec()).map_err(|e| e.to_string())?);
    }
    if cells_at < r.at {
        return Err("cells.bin: the cells overlap the header".into());
    }
    r.at = cells_at;
    let mut cells = Vec::with_capacity(count);
    for _ in 0..count {
        let (layer, ix, iz, prims) = (r.u32()?, r.i32()?, r.i32()?, r.u32()? as usize);
        let origin = [r.f64()?, r.f64()?, r.f64()?];
        let mut list = Vec::with_capacity(prims);
        for _ in 0..prims {
            let (material, vc, ic, _flags) = (r.u32()?, r.u32()? as usize, r.u32()? as usize, r.u32()?);
            let v3 = |f: Vec<f32>| f.chunks_exact(3).map(|c| Vec3::new(c[0], c[1], c[2])).collect::<Vec<_>>();
            let position = v3(r.f32s(vc * 3)?);
            let normal = v3(r.f32s(vc * 3)?);
            let uv = r.f32s(vc * 2)?.chunks_exact(2).map(|c| Vec2::new(c[0], c[1])).collect();
            let color = r.take(vc * 4)?.chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();
            let idx = r.take(ic * 4)?;
            let tris: Vec<[u32; 3]> = idx.chunks_exact(12).map(|c| core::array::from_fn(|k| u32::from_le_bytes([c[k * 4], c[k * 4 + 1], c[k * 4 + 2], c[k * 4 + 3]]))).collect();
            if tris.iter().flatten().any(|&i| i as usize >= vc) {
                return Err(format!("cells.bin: cell {layer}:{ix}:{iz} indexes past its vertices"));
            }
            list.push(Prim { material, position, normal, uv, color, tris });
        }
        cells.push(Cell { layer, ix, iz, origin, prims: list });
    }
    Ok((names, cells))
}

/// Reduced-level errors (m) per layer, finest first: what a pixel of the
/// 480 × 272 frame covers at the distances a layer is seen from.
fn lod_bounds(layer: &str) -> &'static [f32] {
    match layer {
        "detail" => &[0.12, 0.5],
        "base" => &[0.15, 0.6, 2.4],
        "mid" => &[1.2, 5.0],
        _ => &[10.0, 40.0],
    }
}

/// Vertices on an open border of a primitive's mesh (an edge one triangle
/// uses): where a cell was cut from its neighbours, or where the mesh ends.
/// They hold their place in every reduced level, so cells stay sealed.
fn open_border(position: &[Vec3], tris: &[[u32; 3]]) -> Vec<bool> {
    let mut edges: HashMap<([u32; 3], [u32; 3]), u32> = HashMap::new();
    for t in tris {
        for k in 0..3 {
            let (a, b) = (geometry::pos_bits(position[t[k] as usize]), geometry::pos_bits(position[t[(k + 1) % 3] as usize]));
            *edges.entry(if a <= b { (a, b) } else { (b, a) }).or_default() += 1;
        }
    }
    let mut open: std::collections::HashSet<[u32; 3]> = Default::default();
    for ((a, b), n) in edges {
        if n == 1 {
            open.insert(a);
            open.insert(b);
        }
    }
    position.iter().map(|p| open.contains(&geometry::pos_bits(*p))).collect()
}

struct CookedCell {
    entry: rt::CellEntry,
    blob: Vec<u8>,
    triangles: usize,
    draws: usize,
}

pub fn cook(input: &Path, output: &Path, tex_cap: u32) -> Result<(), String> {
    let t0 = Instant::now();
    let manifest: Value = serde_json::from_slice(&std::fs::read(input.join("route.json")).map_err(|e| format!("route.json: {e}"))?).map_err(|e| format!("route.json: {e}"))?;
    if manifest["version"].as_u64() != Some(1) {
        return Err("route.json: unsupported RouteIR version".into());
    }
    let name = manifest["id"].as_str().ok_or("route.json: missing id")?.to_string();

    // ---- the kit: a place
    let (kit_root, kit_manifest) = ir::prepare(&input.join("kit"))?;
    kit_manifest.check_target(ir::Target::Vita)?;
    let args = Args { input: kit_root, output: output.to_path_buf(), cell: 32.0, tex_cap, target: ir::Target::Vita };
    let Cooked { meta: kit, blobs: kit_blobs, mut log } = cook_place(&args, name.clone());
    let material_of: HashMap<&str, u32> = kit.materials.iter().enumerate().map(|(i, m)| (m.name.as_str(), i as u32)).collect();

    // ---- the cells
    let bytes = std::fs::read(input.join("cells.bin")).map_err(|e| format!("cells.bin: {e}"))?;
    let (names, cells) = read_cells(&bytes)?;
    drop(bytes);
    let remap: Vec<u32> = names
        .iter()
        .map(|n| material_of.get(n.as_str()).copied().ok_or_else(|| format!("cells use material \"{n}\", which the kit does not have (its swatch is missing from the kit export)")))
        .collect::<Result<_, _>>()?;
    let layers: Vec<rt::Layer> = manifest["layers"]
        .as_array()
        .ok_or("route.json: missing layers")?
        .iter()
        .map(|l| rt::Layer { name: l["name"].as_str().unwrap_or("").into(), size: l["size"].as_f64().unwrap_or(256.0) as f32, radius: l["radius"].as_f64().unwrap_or(1000.0) as f32 })
        .collect();
    println!("route {name}: {} cells, {} materials ({} ms)", cells.len(), names.len(), t0.elapsed().as_millis());

    let env = kit.atmosphere.environment.map(|i| {
        let t = &kit.textures[i as usize];
        (&kit_blobs.tex[t.data.offset as usize..(t.data.offset + t.data.size) as usize], t.width, t.mips)
    });
    let baker = bake::Baker::new(&[], (kit.atmosphere.hemisphere_sky, kit.atmosphere.hemisphere_ground), env);
    let env_scene = kit.atmosphere.environment_strength;

    // Cells by position on the corridor's grid, for the neighbours a vertex's sky may be blocked by.
    let mut by_place: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    for (i, c) in cells.iter().enumerate() {
        let l = layers.get(c.layer as usize).ok_or("cells.bin: unknown layer")?;
        if l.name == "detail" || l.name == "base" {
            by_place.entry((c.ix, c.iz)).or_default().push(i);
        }
    }
    const REACH: f32 = 5.0;
    const RAYS: usize = 24;

    let t_cells = Instant::now();
    let cooked: Vec<CookedCell> = cells
        .par_iter()
        .map(|cell| {
            let layer = &layers[cell.layer as usize];
            let near = layer.name == "detail" || layer.name == "base";
            let origin = Vec3::new(cell.origin[0] as f32, cell.origin[1] as f32, cell.origin[2] as f32);
            // What can block the sky over this cell: its own and its neighbours' solid triangles within reach.
            let occluder = near.then(|| {
                let (lo, hi) = (origin - Vec3::splat(REACH), origin + Vec3::new(layer.size, 0.0, layer.size) + Vec3::splat(REACH));
                let mut tris = Vec::new();
                for dx in -1..=1 {
                    for dz in -1..=1 {
                        for &i in by_place.get(&(cell.ix + dx, cell.iz + dz)).map(|v| v.as_slice()).unwrap_or(&[]) {
                            let other = &cells[i];
                            let o = Vec3::new(other.origin[0] as f32, other.origin[1] as f32, other.origin[2] as f32);
                            for p in &other.prims {
                                let m = &kit.materials[remap[p.material as usize] as usize];
                                if m.kind == pc::Kind::Glass || m.blend != pc::Blend::Opaque {
                                    continue;
                                }
                                let opacity = if m.alpha_test > 0.0 { 0.55 } else { 1.0 };
                                for t in &p.tris {
                                    let (a, b, c) = (p.position[t[0] as usize] + o, p.position[t[1] as usize] + o, p.position[t[2] as usize] + o);
                                    let (tlo, thi) = (a.min(b).min(c), a.max(b).max(c));
                                    if thi.x < lo.x || tlo.x > hi.x || thi.z < lo.z || tlo.z > hi.z {
                                        continue;
                                    }
                                    tris.push(occlusion::Tri { a, e1: b - a, e2: c - a, opacity });
                                }
                            }
                        }
                    }
                }
                occlusion::Occluder::new(tris, RAYS, REACH)
            });
            let mut draws: Vec<rt::CellDraw> = Vec::new();
            let mut geom: Vec<u8> = Vec::new();
            let (mut min_y, mut max_y) = (f32::MAX, f32::MIN);
            let mut triangles = 0;
            let push = |buf: &mut Vec<u8>, data: &[u8]| -> u32 {
                while buf.len() % 16 != 0 {
                    buf.push(0);
                }
                let at = buf.len() as u32;
                buf.extend_from_slice(data);
                at
            };
            for p in &cell.prims {
                let material = remap[p.material as usize];
                let m = &kit.materials[material as usize];
                let lit = matches!(m.kind, pc::Kind::Standard | pc::Kind::Glass);
                let tan = geometry::tangents(&p.position, &p.normal, &p.uv, &p.tris);
                let env_k = m.env_strength * env_scene;
                let verts: Vec<Vertex> = (0..p.position.len())
                    .map(|i| {
                        let n = p.normal[i].normalize_or(Vec3::Y);
                        let light = if lit {
                            let world = p.position[i] + origin;
                            let sky = occluder.as_ref().map_or(1.0, |o| o.visibility(world, n));
                            bake::encode(baker.irradiance(world, n, env_k, true, sky))
                        } else {
                            [0; 4]
                        };
                        Vertex { pos: p.position[i], normal: n, tangent: tan[i], uv: p.uv[i], color: p.color[i], joints: [0; 4], weights: [255, 0, 0, 0], light }
                    })
                    .collect();
                let layout = if lit { pc::VertexLayout::Baked } else { pc::VertexLayout::Static };
                let drop_parts = m.kind == pc::Kind::Standard && m.emissive.iter().all(|&e| e <= 0.0) && m.emission.is_none();
                for (v, t) in geometry::split(&verts, &p.tris) {
                    let positions: Vec<Vec3> = v.iter().map(|x| x.pos).collect();
                    let locked = open_border(&positions, &t);
                    let lods = geometry::lods(&v, &t, &locked, drop_parts, lod_bounds(&layer.name));
                    let b = geometry::build(&v, &t, layout, lods, true);
                    let mut d = rt::CellDraw {
                        material,
                        vertex_offset: push(&mut geom, &b.vertices),
                        vertex_count: b.vertex_count,
                        index_offset: push(&mut geom, &b.indices),
                        index_count: b.index_count,
                        pos_offset: b.pos_offset,
                        pos_scale: b.pos_scale,
                        uv_offset: b.uv_offset,
                        uv_scale: b.uv_scale,
                        min: b.min,
                        max: b.max,
                        lods: Default::default(),
                        lod_count: b.lods.len().min(rt::CELL_LODS) as u32,
                    };
                    for (k, (idx, count, error)) in b.lods.iter().take(rt::CELL_LODS).enumerate() {
                        d.lods[k] = (push(&mut geom, idx), *count, *error);
                    }
                    min_y = min_y.min(b.min[1] + origin.y);
                    max_y = max_y.max(b.max[1] + origin.y);
                    triangles += t.len();
                    draws.push(d);
                }
            }
            // Solid surfaces before cut-outs, as the renderer sorts them anyway; by material within.
            draws.sort_by_key(|d| d.material);
            let blob = rt::write_cell(&draws, &geom);
            CookedCell {
                entry: rt::CellEntry { layer: cell.layer as u8, ix: cell.ix as i16, iz: cell.iz as i16, offset: 0, size: blob.len() as u32, origin: origin.to_array(), min_y, max_y },
                draws: draws.len(),
                blob,
                triangles,
            }
        })
        .collect();
    println!("cooked {} cells in {} ms", cooked.len(), t_cells.elapsed().as_millis());

    // ---- the pack
    let mut index = Vec::with_capacity(cooked.len() * rt::CellEntry::SIZE);
    let mut blobs: Vec<u8> = Vec::new();
    let mut per_layer: Vec<(usize, usize, usize, usize)> = vec![(0, 0, 0, 0); layers.len()];
    for c in &cooked {
        // A cell nothing was put in is not a cell: no entry, no read.
        if c.draws == 0 {
            continue;
        }
        while blobs.len() % 16 != 0 {
            blobs.push(0);
        }
        let mut e = c.entry;
        e.offset = blobs.len() as u32;
        e.encode(&mut index);
        blobs.extend_from_slice(&c.blob);
        let l = &mut per_layer[c.entry.layer as usize];
        *l = (l.0 + 1, l.1 + c.triangles, l.2 + c.blob.len(), l.3 + c.draws);
    }
    let line = std::fs::read(input.join("line.bin")).map_err(|e| format!("line.bin: {e}"))?;
    let samples = (line.len() / 16) as u32;
    let num = |v: &Value, d: f32| v.as_f64().map_or(d, |x| x as f32);
    let v3 = |v: &Value| -> [f32; 3] { core::array::from_fn(|k| num(&v[k], 0.0)) };
    let stats = json!({
        "cells": cooked.iter().filter(|c| c.draws > 0).count(),
        "layers": layers.iter().zip(&per_layer).map(|(l, s)| json!({"name": l.name, "cells": s.0, "triangles": s.1, "bytes": s.2, "draws": s.3})).collect::<Vec<_>>(),
        "cellBytes": blobs.len(),
        "kit": kit.stats,
    });
    let meta = rt::RouteMeta {
        version: rt::VERSION,
        name: name.clone(),
        length: num(&manifest["length"], 0.0),
        step: num(&manifest["step"], 5.0),
        samples,
        layers,
        stops: manifest["stops"].as_array().into_iter().flatten().map(|s| rt::Stop { name: s["name"].as_str().unwrap_or("").into(), native: s["native"].as_str().unwrap_or("").into(), s: num(&s["s"], 0.0) }).collect(),
        limits: manifest["limits"].as_array().into_iter().flatten().map(|l| (num(&l["s"], 0.0), num(&l["kmh"], 0.0))).collect(),
        car: serde_json::from_value(manifest["car"].clone()).map_err(|e| format!("route.json: car: {e}"))?,
        departure: num(&manifest["departure"], 900.0),
        views: manifest["views"].as_array().into_iter().flatten().map(|v| rt::View { name: v["name"].as_str().unwrap_or("").into(), pos: v3(&v["pos"]), target: v3(&v["target"]), fov: num(&v["fov"], 45.0) }).collect(),
        stats: stats.clone(),
    };
    let kit_pack = place_pack(&kit, &kit_blobs);
    let meta_json = serde_json::to_vec(&meta).unwrap();
    let pack = pc::write_versioned(
        rt::MAGIC,
        rt::VERSION,
        &[(rt::TAG_META, &meta_json, 16), (rt::TAG_KIT, &kit_pack, 4096), (rt::TAG_LINE, &line, 16), (rt::TAG_INDEX, &index, 16), (rt::TAG_CELLS, &blobs, 4096)],
    );
    std::fs::write(output, &pack).map_err(|e| format!("{}: {e}", output.display()))?;
    for (l, s) in meta.layers.iter().zip(&per_layer) {
        log.push(format!("layer {}: {} cells, {} triangles, {} draws, {} KiB", l.name, s.0, s.1, s.3, s.2 / 1024));
    }
    std::fs::write(output.with_extension("log"), log.join("\n") + "\n").map_err(|e| e.to_string())?;
    println!("{}", serde_json::to_string_pretty(&stats).unwrap());
    println!("wrote {} ({:.1} MiB: kit {:.1}, cells {:.1}) in {} s", output.display(), pack.len() as f64 / 1048576.0, kit_pack.len() as f64 / 1048576.0, blobs.len() as f64 / 1048576.0, t0.elapsed().as_secs());
    Ok(())
}
