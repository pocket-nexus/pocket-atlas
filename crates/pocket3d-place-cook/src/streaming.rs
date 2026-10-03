//! Lower a driving scene to fixed spatial pages. Texture/material identity is
//! global; static geometry pages carry quantized vertices and all their LODs.
use pc::streaming::{Driving, Page};
use pocket3d_place as pc;
use std::{collections::BTreeMap, path::Path};

fn copy_range(src: &[u8], dst: &mut Vec<u8>, r: &mut pc::Range) {
    let bytes = &src[r.offset as usize..(r.offset + r.size) as usize];
    while dst.len() % 16 != 0 {
        dst.push(0);
    }
    r.offset = dst.len() as u32;
    dst.extend_from_slice(bytes);
}
fn copy_draw(src: &[u8], dst: &mut Vec<u8>, d: &mut pc::Draw) {
    copy_range(src, dst, &mut d.vertices);
    copy_range(src, dst, &mut d.indices);
    for l in &mut d.lods {
        copy_range(src, dst, &mut l.indices);
    }
}
/// Sample long source segments too, including the widest layby and GPU allocation padding.
fn preload_peak(road: &pocket3d_drive::Route, pages: &[Page], radius: f32) -> u64 {
    let length = road.points.last().unwrap().s;
    let steps = (length / 32.).ceil().max(1.) as usize;
    (0..=steps)
        .map(|i| {
            let p = pocket3d_drive::sample_route(road, length * i as f64 / steps as f64);
            pages
                .iter()
                .filter(|page| {
                    pc::streaming::distance2(
                        [p.x as f32, p.y as f32, p.z as f32],
                        page.min,
                        page.max,
                    ) <= (radius + 14.).powi(2)
                })
                .map(|p| (p.bytes as u64).next_multiple_of(4096))
                .sum::<u64>()
        })
        .max()
        .unwrap_or(0)
}
pub fn compile(
    route: serde_json::Value,
    vehicle_node: u32,
    draws: &mut [pc::Draw],
    geom: &mut Vec<u8>,
    out: &Path,
) -> Result<Driving, String> {
    let source = std::mem::take(geom);
    let dir = out.with_extension("place.pages");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut groups: BTreeMap<(i32, i32), Vec<u32>> = BTreeMap::new();
    let mut plan = Driving {
        route,
        vehicle_node,
        view_m: 700.,
        prefetch_m: 1000.,
        budget_bytes: 64 << 20,
        pages: vec![],
        persistent: vec![],
    };
    for (i, d) in draws.iter_mut().enumerate() {
        if d.node.is_some() {
            plan.persistent.push(i as u32);
            copy_draw(&source, geom, d);
        } else {
            let x = ((d.min[0] + d.max[0]) * 0.5 / 512.).floor() as i32;
            let z = ((d.min[2] + d.max[2]) * 0.5 / 512.).floor() as i32;
            groups.entry((x, z)).or_default().push(i as u32);
        }
    }
    for ids in groups.into_values() {
        let mut bytes = Vec::new();
        let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
        for &i in &ids {
            let d = &mut draws[i as usize];
            for k in 0..3 {
                lo[k] = lo[k].min(d.min[k]);
                hi[k] = hi[k].max(d.max[k]);
            }
            copy_draw(&source, &mut bytes, d);
        }
        if bytes.len() > 8 << 20 {
            return Err("stream page exceeds 8 MiB; reduce scene density".into());
        }
        let file = format!("{:05}.bin", plan.pages.len());
        let tmp = dir.join(format!("{file}.tmp"));
        std::fs::write(&tmp, &bytes)
            .and_then(|_| std::fs::rename(tmp, dir.join(&file)))
            .map_err(|e| e.to_string())?;
        plan.pages.push(Page {
            file,
            bytes: bytes.len() as u32,
            checksum: pc::streaming::checksum(&bytes),
            min: lo,
            max: hi,
            draws: ids,
        });
    }
    let road: pocket3d_drive::Route =
        serde_json::from_value(plan.route.clone()).map_err(|e| e.to_string())?;
    let peak = preload_peak(&road, &plan.pages, plan.prefetch_m);
    if peak > plan.budget_bytes as u64 {
        return Err(format!(
            "driving residency {peak} exceeds {} bytes",
            plan.budget_bytes
        ));
    }
    println!(
        "driving: {} pages; peak preload {:.2} MiB; persistent {:.2} MiB",
        plan.pages.len(),
        peak as f64 / 1048576.,
        geom.len() as f64 / 1048576.
    );
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn residency_accounts_for_mid_segment_pages_and_alignment() {
        let road: pocket3d_drive::Route = serde_json::from_value(serde_json::json!({
            "version":1,"id":"long-segment","title":"Test","origin":[142,43],"distance_scale":1,
            "points":[{"s":0,"real_m":0,"x":0,"y":0,"z":0},{"s":4000,"real_m":4000,"x":4000,"y":0,"z":0}],
            "stops":[{"id":"end","name":"End","s":4000,"kind":"finish","radius":24}],"attribution":"test"
        })).unwrap();
        let page = Page {
            file: "00000.bin".into(),
            bytes: 4100,
            checksum: 0,
            min: [1900., 0., 0.],
            max: [2100., 0., 0.],
            draws: vec![],
        };
        assert_eq!(preload_peak(&road, &[page], 1000.), 8192);
    }
}
