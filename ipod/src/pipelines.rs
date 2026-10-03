//! Compile exactly one material profile. Draw slots remain stable for the
//! renderer; aliases refer to the same owned Program and never duplicate it.
use alloc::{collections::BTreeMap, string::String, vec::Vec};
use serde::Deserialize;

#[derive(Deserialize)]
struct DrawPrograms {
    #[serde(default)]
    display_color: bool,
    #[serde(default)]
    display_float: bool,
    #[serde(default)]
    display_texture: bool,
    #[serde(default)]
    display_flags: u32,
    detail: [String; 2],
    far: [String; 2],
    reflection: [String; 2],
    performance: [String; 2],
}

#[derive(Deserialize)]
pub struct Pipelines {
    draws: Vec<Option<DrawPrograms>>,
    sky: [String; 2],
    sky_performance: [String; 2],
    post: [String; 2],
    post_performance: [String; 2],
    blit: [String; 2],
    copy: [String; 2],
    down: [String; 2],
}

pub struct Compiled<P> {
    pub programs: Vec<P>,
    pub draws: Vec<[usize; 4]>,
    pub sky: usize,
    pub post: usize,
    pub blit: usize,
    pub copy: usize,
    pub down: usize,
}

impl Pipelines {
    /// Both profiles use stable draw indices. Only light fields omit a mesh
    /// program; accepting a null ordinary draw would silently use program zero.
    pub fn validate_draws(
        &self,
        count: usize,
        is_light: impl Fn(usize) -> bool,
    ) -> Result<(), String> {
        if self.draws.len() != count {
            return Err("pipeline draw count does not match place".into());
        }
        if self
            .draws
            .iter()
            .enumerate()
            .any(|(i, d)| d.is_none() != is_light(i))
        {
            return Err("pipeline draw presence does not match place layout".into());
        }
        Ok(())
    }
    pub fn validate_colors(
        &self,
        count: usize,
        color: impl Fn(usize) -> Option<(u32, bool, bool)>,
    ) -> Result<(), String> {
        if self.draws.len() != count {
            return Err("pipeline draw count does not match place".into());
        }
        for (i, draw) in self.draws.iter().enumerate() {
            let expected = draw
                .as_ref()
                .filter(|d| d.display_color)
                .map(|d| (d.display_flags, d.display_float, d.display_texture));
            if expected != color(i) {
                return Err("pipeline display colors do not match place sidecar".into());
            }
        }
        Ok(())
    }
    pub fn compile<P>(
        self,
        performance: bool,
        mut create: impl FnMut(&[String; 2]) -> Result<P, String>,
    ) -> Result<Compiled<P>, String> {
        let mut programs = Vec::new();
        let mut cache = BTreeMap::new();
        let mut add = |pair: &[String; 2]| -> Result<usize, String> {
            if let Some(&index) = cache.get(pair) {
                return Ok(index);
            }
            let index = programs.len();
            programs.push(create(pair)?);
            cache.insert(pair.clone(), index);
            Ok(index)
        };
        let mut draws = Vec::with_capacity(self.draws.len());
        for draw in self.draws {
            draws.push(match draw {
                Some(draw) if performance => [add(&draw.performance)?; 4],
                Some(draw) => {
                    let detail = add(&draw.detail)?;
                    [detail, add(&draw.far)?, add(&draw.reflection)?, detail]
                }
                None => [0; 4],
            });
        }
        let blit = add(&self.blit)?;
        let copy = if performance { add(&self.copy)? } else { blit };
        let sky = add(if performance {
            &self.sky_performance
        } else {
            &self.sky
        })?;
        let post = add(if performance {
            &self.post_performance
        } else {
            &self.post
        })?;
        let down = if performance { blit } else { add(&self.down)? };
        Ok(Compiled {
            programs,
            draws,
            sky,
            post,
            blit,
            copy,
            down,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::{rc::Rc, vec};
    use core::cell::Cell;

    fn config() -> Pipelines {
        serde_json::from_value(serde_json::json!({
            "draws": [
                {"detail":["v","detail"],"far":["v","far"],"reflection":["v","reflection"],"performance":["v","performance"]},
                {"detail":["v","detail"],"far":["v","far"],"reflection":["v","reflection"],"performance":["v","performance"]},
                null
            ],
            "sky":["v","sky"],"sky_performance":["v","sky"],"post":["v","full-post"],"post_performance":["v","fast-post"],"blit":["v","blit"],"copy":["v","copy"],"down":["v","down"]
        })).unwrap()
    }

    #[test]
    fn one_profile_compiles_only_used_variants_and_shares_programs() {
        let fast = config().compile(true, |pair| Ok(pair[1].clone())).unwrap();
        assert_eq!(
            fast.programs,
            vec!["performance", "blit", "copy", "sky", "fast-post"]
        );
        assert_eq!(fast.draws[0], [0; 4]);
        assert_eq!(fast.draws[0], fast.draws[1]);
        let full = config().compile(false, |pair| Ok(pair[1].clone())).unwrap();
        assert_eq!(
            full.programs,
            vec![
                "detail",
                "far",
                "reflection",
                "blit",
                "sky",
                "full-post",
                "down"
            ]
        );
        assert_eq!(full.draws[0], [0, 1, 2, 0]);
    }

    #[test]
    fn both_profiles_require_every_mesh_program_and_only_omit_lights() {
        let cfg = config();
        assert!(cfg.validate_draws(3, |i| i == 2).is_ok());
        // A shortened or expanded table must fail before indexed rendering.
        assert!(cfg.validate_draws(2, |i| i == 2).is_err());
        assert!(cfg.validate_draws(4, |i| i == 2).is_err());
        // Null is not a fallback program for an ordinary mesh, and light fields
        // must not accidentally consume a mesh program.
        assert!(cfg.validate_draws(3, |_| false).is_err());
        assert!(cfg.validate_draws(3, |i| i >= 1).is_err());
        for performance in [false, true] {
            let cfg = config();
            cfg.validate_draws(3, |i| i == 2).unwrap();
            assert_eq!(
                cfg.compile(performance, |p| Ok(p.clone()))
                    .unwrap()
                    .draws
                    .len(),
                3
            );
        }
    }

    #[test]
    fn mismatched_color_assets_fail_before_compiling_a_shader() {
        let cfg = config();
        assert!(cfg.validate_colors(3, |_| None).is_ok());
        assert!(cfg.validate_colors(2, |_| None).is_err());
        assert!(cfg
            .validate_colors(3, |i| (i == 0).then_some((0, false, false)))
            .is_err());
        let mut cfg = config();
        cfg.draws[0].as_mut().unwrap().display_color = true;
        assert!(cfg.validate_colors(3, |_| None).is_err());
        assert!(cfg
            .validate_colors(3, |i| (i == 0).then_some((0, false, false)))
            .is_ok());
        assert!(cfg
            .validate_colors(3, |i| (i == 0).then_some((16, false, false)))
            .is_err());
        assert!(cfg
            .validate_colors(3, |i| (i == 0).then_some((0, true, false)))
            .is_err());
        assert!(cfg
            .validate_colors(3, |i| (i == 0).then_some((0, false, true)))
            .is_err());
    }

    struct Owned(Rc<Cell<usize>>);
    impl Drop for Owned {
        fn drop(&mut self) {
            self.0.set(self.0.get() - 1);
        }
    }
    fn owned(live: &Rc<Cell<usize>>) -> Owned {
        live.set(live.get() + 1);
        Owned(live.clone())
    }

    #[test]
    fn failed_compile_releases_partial_programs() {
        let live = Rc::new(Cell::new(0));
        let result = config().compile(true, |pair| {
            if pair[1] == "sky" {
                return Err("injected compile failure".into());
            }
            Ok(owned(&live))
        });
        assert!(result.is_err());
        assert_eq!(live.get(), 0);
    }

}
