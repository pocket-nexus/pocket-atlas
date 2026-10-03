//! Vita-specific compiled residency, independent of the route's simulation.
use crate::{Draw, Range};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Driving {
    pub route: serde_json::Value,
    pub vehicle_node: u32,
    pub view_m: f32,
    pub prefetch_m: f32,
    pub budget_bytes: u32,
    pub pages: Vec<Page>,
    /// Draws stored in the root pack's GEOM (the vehicle and other persistent actors).
    pub persistent: Vec<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Page {
    pub file: String,
    pub bytes: u32,
    pub checksum: u32,
    pub min: [f32; 3],
    pub max: [f32; 3],
    /// Each referenced draw's ranges address this page, not root GEOM.
    pub draws: Vec<u32>,
}
pub fn checksum(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .fold(2166136261u32, |h, b| (h ^ *b as u32).wrapping_mul(16777619))
}
pub fn distance2(p: [f32; 3], lo: [f32; 3], hi: [f32; 3]) -> f32 {
    [0, 2]
        .iter()
        .map(|&k| (lo[k] - p[k]).max(0.0).max(p[k] - hi[k]).powi(2))
        .sum()
}
fn range(r: &Range, size: u32) -> bool {
    r.offset.checked_add(r.size).is_some_and(|end| end <= size)
}
fn draw_fits(d: &Draw, size: u32) -> bool {
    range(&d.vertices, size)
        && range(&d.indices, size)
        && d.vertices.offset % 4 == 0
        && d.indices.offset % 2 == 0
        && d.vertices.size as u64 >= d.vertex_count as u64 * d.layout.stride() as u64
        && d.indices.size as u64 >= d.index_count as u64 * 2
        && d.lods.iter().all(|l| {
            range(&l.indices, size)
                && l.indices.offset % 2 == 0
                && l.indices.size as u64 >= l.index_count as u64 * 2
        })
}
impl Driving {
    /// Reject malformed residency before any device pointer arithmetic/allocation.
    pub fn validate(&self, draws: &[Draw], nodes: usize, root_bytes: u32) -> Result<(), String> {
        if self.vehicle_node as usize >= nodes
            || !(100.0..=1200.0).contains(&self.view_m)
            || !(self.view_m + 100.0..=1800.0).contains(&self.prefetch_m)
            || self.budget_bytes > 64 << 20
            || self.budget_bytes == 0
        {
            return Err("invalid driving residency budget or vehicle".into());
        }
        let mut seen = vec![false; draws.len()];
        for (&id, size) in self.persistent.iter().map(|id| (id, root_bytes)).chain(
            self.pages
                .iter()
                .flat_map(|p| p.draws.iter().map(move |id| (id, p.bytes))),
        ) {
            let i = id as usize;
            if i >= draws.len() || seen[i] || !draw_fits(&draws[i], size) {
                return Err(format!("invalid/duplicate streaming draw {i}"));
            }
            seen[i] = true;
        }
        if seen.iter().any(|v| !*v) {
            return Err("unassigned streaming draw".into());
        }
        for p in &self.pages {
            let stem = p.file.strip_suffix(".bin").unwrap_or("");
            if stem.is_empty()
                || !stem.bytes().all(|c| c.is_ascii_digit())
                || p.bytes == 0
                || p.bytes > 8 << 20
                || p.bytes > self.budget_bytes
                || p.min.iter().chain(p.max.iter()).any(|v| !v.is_finite())
                || (0..3).any(|k| p.min[k] > p.max[k])
            {
                return Err("invalid streaming page".into());
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hash_and_distance() {
        assert_eq!(checksum(b"hello"), 0x4f9f2cab);
        assert_eq!(distance2([3., 9., 4.], [0.; 3], [1.; 3]), 13.);
        assert_eq!(distance2([0.5, 90., 0.5], [0.; 3], [1.; 3]), 0.);
    }
    #[test]
    fn budgets_are_checked() {
        let d = Driving {
            route: serde_json::Value::Null,
            vehicle_node: 0,
            view_m: 700.,
            prefetch_m: 1000.,
            budget_bytes: 64 << 20,
            pages: vec![],
            persistent: vec![],
        };
        assert!(d.validate(&[], 1, 0).is_ok());
        let mut x = d.clone();
        x.prefetch_m = f32::NAN;
        assert!(x.validate(&[], 1, 0).is_err());
        let mut x = d.clone();
        x.budget_bytes = 65 << 20;
        assert!(x.validate(&[], 1, 0).is_err());
        let mut x = d;
        x.pages.push(Page {
            file: "../escape.bin".into(),
            bytes: 16,
            checksum: 0,
            min: [0.; 3],
            max: [1.; 3],
            draws: vec![],
        });
        assert!(x.validate(&[], 1, 0).is_err());
    }
}
