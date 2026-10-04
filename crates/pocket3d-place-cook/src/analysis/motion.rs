//! Sampled motion and skin palettes; preserves the full source timeline.
use super::*;

pub(super) struct Motion {
    pub node_ids: BTreeMap<usize, u32>,
    pub nodes: Vec<pc::Node>,
    pub skin_ids: HashMap<usize, u32>,
    pub skins: Vec<pc::Skin>,
    pub fps: f32,
    pub frames: u32,
}
pub(super) fn run(a: &Args, source: &read::Source, resolved: &resolve::Resolved<'_>) -> crate::recipe::Output<Motion> {
    let read::Source {doc, buffers, sx, ..} = source;
    let resolve::Resolved {hierarchy, prims, lights, ..} = resolved;
    let resolve::Hierarchy {parent, door_names, ..} = hierarchy;
    let moving = |i| hierarchy.moving(i);
    // ---- node table for moving content (ancestors included for hierarchy)
    let mut node_ids: BTreeMap<usize, u32> = BTreeMap::new();
    let mut need: Vec<usize> = Vec::new();
    for p in prims {
        if p.moving && p.skin.is_none() {
            need.push(p.mesh_node);
        }
    }
    for s in doc.skins() {
        for j in s.joints() {
            need.push(j.index());
        }
    }
    for (ni, _, _) in lights {
        if moving(*ni) {
            need.push(*ni);
        }
    }
    for n in doc.nodes() {
        if n.name().is_some_and(|name| door_names.iter().any(|d| d == name)) {
            need.push(n.index());
        }
    }
    let mut ordered: Vec<usize> = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();
    fn add(i: usize, parent: &HashMap<usize, usize>, seen: &mut HashSet<usize>, ordered: &mut Vec<usize>) {
        if seen.contains(&i) {
            return;
        }
        if let Some(&p) = parent.get(&i) {
            add(p, parent, seen, ordered);
        }
        seen.insert(i);
        ordered.push(i);
    }
    for &i in &need {
        add(i, &parent, &mut seen, &mut ordered);
    }
    for (k, &i) in ordered.iter().enumerate() {
        node_ids.insert(i, k as u32);
    }

    // ---- animation: resample every animated node uniformly
    let fps = sx.get("tracks").map(|t| f(t, "fps", 15.0)).unwrap_or(15.0);
    let mut duration = 0.0f32;
    let mut chans: HashMap<usize, (Option<(Vec<f32>, Vec<[f32; 3]>)>, Option<(Vec<f32>, Vec<[f32; 4]>)>)> = HashMap::new();
    for anim in doc.animations() {
        for ch in anim.channels() {
            let r = ch.reader(|b| Some(&buffers[b.index()]));
            let times: Vec<f32> = r.read_inputs().map(|i| i.collect()).unwrap_or_default();
            if let Some(&t) = times.last() {
                duration = duration.max(t);
            }
            let e = chans.entry(ch.target().node().index()).or_default();
            match r.read_outputs() {
                Some(gltf::animation::util::ReadOutputs::Translations(v)) => e.0 = Some((times, v.collect())),
                Some(gltf::animation::util::ReadOutputs::Rotations(v)) => e.1 = Some((times, v.into_f32().collect())),
                _ => {}
            }
        }
    }
    let frames = if duration > 0.0 { (duration * fps).round() as u32 + 1 } else { 1 };
    let sample3 = |k: &(Vec<f32>, Vec<[f32; 3]>), t: f32| -> Vec3 {
        let (ts, vs) = k;
        let i = ts.partition_point(|&x| x <= t);
        if i == 0 {
            return Vec3::from(vs[0]);
        }
        if i >= ts.len() {
            return Vec3::from(*vs.last().unwrap());
        }
        let u = (t - ts[i - 1]) / (ts[i] - ts[i - 1]).max(1e-6);
        Vec3::from(vs[i - 1]).lerp(Vec3::from(vs[i]), u)
    };
    let sample4 = |k: &(Vec<f32>, Vec<[f32; 4]>), t: f32| -> Quat {
        let (ts, vs) = k;
        let i = ts.partition_point(|&x| x <= t);
        if i == 0 {
            return Quat::from_array(vs[0]);
        }
        if i >= ts.len() {
            return Quat::from_array(*vs.last().unwrap());
        }
        let u = (t - ts[i - 1]) / (ts[i] - ts[i - 1]).max(1e-6);
        Quat::from_array(vs[i - 1]).slerp(Quat::from_array(vs[i]), u)
    };
    let mut nodes: Vec<pc::Node> = Vec::new();
    for &i in &ordered {
        let n = doc.nodes().nth(i).unwrap();
        let (t, r, s) = n.transform().decomposed();
        let track = chans.get(&i).map(|(tc, rc)| {
            let mut data = Vec::with_capacity(frames as usize * 7);
            for fr in 0..frames {
                let time = fr as f32 / fps;
                let tt = tc.as_ref().map(|k| sample3(k, time)).unwrap_or(Vec3::from(t));
                let rr = rc.as_ref().map(|k| sample4(k, time)).unwrap_or(Quat::from_array(r));
                data.extend([tt.x, tt.y, tt.z, rr.x, rr.y, rr.z, rr.w]);
            }
            data.chunks_exact(7).map(|v| v.try_into().unwrap()).collect()
        });
        nodes.push(pc::Node {
            name: n.name().unwrap_or("").to_string(),
            parent: parent.get(&i).and_then(|p| node_ids.get(p)).copied(),
            translation: t,
            rotation: r,
            scale: s,
            track,
        });
    }

    // ---- skins
    let mut skins: Vec<pc::Skin> = Vec::new();
    let mut skin_ids: HashMap<usize, u32> = HashMap::new();
    for s in doc.skins() {
        let joints: Vec<u32> = s.joints().map(|j| node_ids[&j.index()]).collect();
        assert!(!joints.is_empty(), "skin {} ({:?}) has no joints", s.index(), s.name().unwrap_or(""));
        if a.target == ir::Target::Vita {
            assert!(joints.len() <= 24, "skin {} ({:?}) has {} joints; Vita supports 1..=24 per draw, split the source mesh into palettes", s.index(), s.name().unwrap_or(""), joints.len());
        }
        let r = s.reader(|b| Some(&buffers[b.index()]));
        // glTF permits omitted inverse binds and defines them as identity.
        let ibm: Vec<f32> = r.read_inverse_bind_matrices()
            .map(|m| m.flat_map(|c| c.into_iter().flatten()).collect())
            .unwrap_or_else(|| (0..joints.len()).flat_map(|_| Mat4::IDENTITY.to_cols_array()).collect());
        assert_eq!(ibm.len(), joints.len() * 16, "skin {} inverse bind count does not match its joint palette", s.index());
        skins.push(pc::Skin { joints, inverse_bind: ibm.chunks_exact(16).map(|v| v.try_into().unwrap()).collect() });
        skin_ids.insert(s.index(), (skins.len() - 1) as u32);
    }

    let decision = json!({"fps":fps,"frames":frames,"nodes":nodes.len(),"skins":skins.len()});
    crate::recipe::Output::new(Motion {node_ids, nodes, skin_ids, skins, fps, frames}, decision)
}

