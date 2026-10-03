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
    display_texture: Option<u32>,
    #[serde(default)]
    display_flags: u32,
    detail: [String; 2],
    far: [String; 2],
    reflection: [String; 2],
    performance: [String; 2],
    #[serde(default)]
    performance_reflection: Option<[String; 2]>,
    #[serde(default)]
    wet_response: Option<[String; 2]>,
    #[serde(default)]
    water_response: Option<[String; 2]>,
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
    pub wet_response: Vec<Option<usize>>,
    pub water_response: Vec<Option<usize>>,
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
        color: impl Fn(usize) -> Option<(u32, bool, Option<u32>)>,
    ) -> Result<(), String> {
        if self.draws.len() != count {
            return Err("pipeline draw count does not match place".into());
        }
        for (i, draw) in self.draws.iter().enumerate() {
            let expected = draw
                .as_ref()
                .filter(|d| d.display_color)
                .map(|d| (d.display_flags, d.display_float, d.display_texture));
            if draw.as_ref().is_some_and(|d| d.wet_response.is_some() != (d.display_color && d.display_flags & 16 != 0)) {
                return Err("pipeline wet response does not match display material".into());
            }
            if expected != color(i) {
                return Err("pipeline display colors do not match place sidecar".into());
            }
        }
        Ok(())
    }
    pub fn validate_water(&self, count: usize, eligible: impl Fn(usize) -> bool) -> Result<(), String> {
        if self.draws.len() != count || self.draws.iter().enumerate().any(|(i, d)|
            d.as_ref().is_some_and(|d| d.water_response.is_some()) != eligible(i)) {
            return Err("pipeline water response does not match opaque water material".into());
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
        let mut wet_response = Vec::with_capacity(self.draws.len());
        let mut water_response = Vec::with_capacity(self.draws.len());
        for draw in self.draws {
            water_response.push(if performance {
                draw.as_ref().and_then(|d| d.water_response.as_ref()).map(&mut add).transpose()?
            } else { None });
            wet_response.push(if performance {
                draw.as_ref().and_then(|d| d.wet_response.as_ref()).map(&mut add).transpose()?
            } else { None });
            draws.push(match draw {
                Some(draw) if performance => {
                    let main = add(&draw.performance)?;
                    let mirror = draw.performance_reflection.as_ref().map(&mut add).transpose()?.unwrap_or(main);
                    [main, main, mirror, main]
                },
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
            wet_response,
            water_response,
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
            .validate_colors(3, |i| (i == 0).then_some((0, false, None)))
            .is_err());
        let mut cfg = config();
        cfg.draws[0].as_mut().unwrap().display_color = true;
        assert!(cfg.validate_colors(3, |_| None).is_err());
        assert!(cfg
            .validate_colors(3, |i| (i == 0).then_some((0, false, None)))
            .is_ok());
        assert!(cfg
            .validate_colors(3, |i| (i == 0).then_some((16, false, None)))
            .is_err());
        assert!(cfg
            .validate_colors(3, |i| (i == 0).then_some((0, true, None)))
            .is_err());
        assert!(cfg
            .validate_colors(3, |i| (i == 0).then_some((0, false, Some(0))))
            .is_err());
    }

    #[test]
    fn wet_response_presence_is_exactly_the_validated_wet_display_contract() {
        for display in [false, true] {
            for flags in [0, 8, 16, 24] {
                for response in [false, true] {
                    let mut cfg = config();
                    let draw = cfg.draws[0].as_mut().unwrap();
                    draw.display_color = display;
                    draw.display_flags = flags;
                    draw.wet_response = response.then(|| ["v".into(), "wet".into()]);
                    let valid = cfg.validate_colors(3, |i| {
                        (i == 0 && display).then_some((flags, false, None))
                    });
                    assert_eq!(valid.is_ok(), response == (display && flags & 16 != 0),
                        "display {display}, flags {flags}, response {response}");
                }
            }
        }
    }

    #[test]
    fn optimized_response_programs_are_shared_and_reference_never_compiles_them() {
        for performance in [true, false] {
            let mut cfg = config();
            for draw in cfg.draws.iter_mut().flatten() {
                draw.display_color = true;
                draw.display_flags = 16;
                draw.wet_response = Some(["wv".into(), "response".into()]);
            }
            cfg.validate_colors(3, |i| (i < 2).then_some((16, false, None))).unwrap();
            let compiled = cfg.compile(performance, |pair| Ok(pair[1].clone())).unwrap();
            assert_eq!(compiled.wet_response.len(), 3);
            assert_eq!(compiled.wet_response[2], None);
            if performance {
                let index = compiled.wet_response[0].unwrap();
                assert_eq!(compiled.wet_response[1], Some(index));
                assert_eq!(compiled.programs[index], "response");
                assert_ne!(index, compiled.draws[0][0]);
                assert_eq!(compiled.programs.iter().filter(|p| *p == "response").count(), 1);
                assert!(!compiled.programs.iter().any(|p| ["detail", "far", "reflection"].contains(&p.as_str())));
            } else {
                assert!(compiled.wet_response.iter().all(Option::is_none));
                assert!(!compiled.programs.iter().any(|p| ["response", "performance"].contains(&p.as_str())));
            }
        }
    }

    #[test]
    fn optimized_reflection_has_its_own_program_and_reference_keeps_its_variants() {
        for performance in [true, false] {
            let mut cfg = config();
            cfg.draws[0].as_mut().unwrap().performance_reflection = Some(["v".into(), "display-mirror".into()]);
            let c = cfg.compile(performance, |p| Ok(p[1].clone())).unwrap();
            assert_eq!(c.programs[c.draws[0][0]], if performance { "performance" } else { "detail" });
            assert_eq!(c.programs[c.draws[0][2]], if performance { "display-mirror" } else { "reflection" });
            if performance {
                assert_eq!(c.draws[1], [c.draws[1][0]; 4]);
            } else {
                assert!(!c.programs.iter().any(|p| p == "display-mirror"));
            }
        }
    }

    #[test]
    fn water_response_is_required_only_for_eligible_materials_and_never_compiled_by_reference() {
        let mut cfg = config();
        assert!(cfg.validate_water(3, |_| false).is_ok());
        assert!(cfg.validate_water(3, |i| i == 0).is_err());
        cfg.draws[0].as_mut().unwrap().water_response = Some(["v".into(), "water".into()]);
        assert!(cfg.validate_water(3, |i| i == 0).is_ok());
        assert!(cfg.validate_water(2, |i| i == 0).is_err());
        assert!(cfg.validate_water(3, |_| false).is_err());
        assert!(cfg.validate_water(3, |i| i == 2).is_err());
        let compiled = cfg.compile(true, |p| Ok(p[1].clone())).unwrap();
        assert_eq!(compiled.programs[compiled.water_response[0].unwrap()], "water");
        assert!(compiled.water_response[1..].iter().all(Option::is_none));
        let mut cfg = config();
        cfg.draws[0].as_mut().unwrap().water_response = Some(["v".into(), "water".into()]);
        let reference = cfg.compile(false, |p| Ok(p[1].clone())).unwrap();
        assert!(reference.water_response.iter().all(Option::is_none));
        assert!(!reference.programs.iter().any(|p| p == "water"));
    }

    #[test]
    fn failed_response_compile_releases_already_compiled_main_programs() {
        let live = Rc::new(Cell::new(0));
        let mut cfg = config();
        cfg.draws[1].as_mut().unwrap().wet_response = Some(["v".into(), "response".into()]);
        let result = cfg.compile(true, |pair| {
            if pair[1] == "response" { return Err("injected response compile failure".into()); }
            Ok(owned(&live))
        });
        assert!(result.is_err());
        assert_eq!(live.get(), 0);
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
