//! GPU-specific texture sampling decisions on resolved materials.
use super::*;

pub(super) fn run(cook: &mut Cook<'_>, prims: &[Prim], solid_pbr: bool) -> crate::recipe::Output<()> {
    // ---- `lodBias` (materials that ask for it): a number, or "auto" — a
    // texture whose mapping lays more texels per metre one way than the
    // other (mean over the area it covers) gets a negative bias, so the
    // GPU's isotropic mip choice follows the sparser direction instead of
    // blurring it (window grids whose floors blur at 480×272).
    let mut aniso: HashMap<u32, (f64, f64)> = HashMap::new();
    let mut manual: HashMap<u32, f32> = HashMap::new();
    for (&mi, &b) in &cook.lod_bias {
        let m = &cook.materials[mi as usize];
        for t in [m.albedo, m.emission].into_iter().flatten() {
            match b {
                Some(b) => {
                    let e = manual.entry(t).or_insert(b);
                    *e = e.min(b);
                }
                None => {
                    aniso.entry(t).or_default();
                }
            }
        }
    }
    for p in prims {
        if !cook.lod_bias.contains_key(&p.material) {
            continue;
        }
        let m = &cook.materials[p.material as usize];
        for t in [m.albedo, m.emission].into_iter().flatten() {
            if !aniso.contains_key(&t) {
                continue;
            }
            let tex = &cook.textures[t as usize];
            let (w, h) = if solid_pbr {
                let cap = cook.profile.vita_texture_cap(tex);
                textures::pow2_fit(tex.width, tex.height, cap)
            } else { (tex.width, tex.height) };
            let texels = Vec2::new(w as f32, h as f32);
            let e = aniso.entry(t).or_default();
            for tri in &p.tris {
                let v = tri.map(|i| p.verts[i as usize]);
                if let Some((log2_ratio, area)) = geometry::texel_anisotropy(v.map(|v| v.pos), v.map(|v| v.uv), texels) {
                    e.0 += (log2_ratio * area) as f64;
                    e.1 += area as f64;
                }
            }
        }
    }
    for (t, (sum, area)) in aniso {
        let mean = if area > 0.0 { (sum / area) as f32 } else { 0.0 };
        let bias = anisotropy_bias(mean).unwrap_or(0.0);
        let tex = &mut cook.textures[t as usize];
        tex.lod_bias = bias;
        cook.log.push(format!("texture {}: texels {:.2}:1 across its {:.0} m², LOD bias {bias:.2}", tex.name, mean.exp2(), area));
    }
    for (t, bias) in manual {
        let tex = &mut cook.textures[t as usize];
        tex.lod_bias = tex.lod_bias.min(bias);
        cook.log.push(format!("texture {}: LOD bias {:.2}", tex.name, tex.lod_bias));
    }

    crate::recipe::Output::new((), json!({"targetResolutionAnisotropy":solid_pbr}))
}

