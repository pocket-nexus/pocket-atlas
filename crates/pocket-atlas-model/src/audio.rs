//! Authored procedural ambience; no recordings, device formats or scene IDs.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioRecipe {
    pub version: u32,
    pub loop_seconds: f32,
    pub wind_gain: f32,
    pub birds: Option<BirdAudio>,
    pub railway: Option<RailwayAudio>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BirdAudio {
    pub gain: f32,
    pub first: f32,
    pub interval: f32,
    pub seed: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RailwayAudio {
    pub warning: f32,
    pub raised: f32,
    pub arrival: f32,
    pub speed: f32,
    pub length: f32,
    pub visible_from: f32,
    pub visible_until: f32,
    pub origin: [f32; 3],
    pub yaw: f32,
    pub train_gain: f32,
    pub bell_gain: f32,
}

impl AudioRecipe {
    pub fn validate(&self) -> Result<(), String> {
        let gain = |v: f32| v.is_finite() && (0.0..=1.0).contains(&v);
        let in_loop = |v: f32| v.is_finite() && (0.0..=self.loop_seconds).contains(&v);
        if self.version != 1
            || !self.loop_seconds.is_finite()
            || !(1.0..=3600.0).contains(&self.loop_seconds)
            || !gain(self.wind_gain)
        {
            return Err("audio requires version 1, a 1..3600 second loop and bounded gains".into());
        }
        if let Some(b) = &self.birds {
            if !gain(b.gain)
                || !in_loop(b.first)
                || !b.interval.is_finite()
                || b.interval < 1.0
                || b.seed > 0x00ff_ffff
            {
                return Err("invalid procedural bird timing, gain or seed".into());
            }
        }
        if let Some(r) = &self.railway {
            if ![
                r.warning,
                r.raised,
                r.arrival,
                r.visible_from,
                r.visible_until,
            ]
            .into_iter()
            .all(in_loop)
                || r.warning >= r.raised
                || r.visible_from >= r.visible_until
                || !r.speed.is_finite()
                || r.speed <= 0.0
                || !r.length.is_finite()
                || r.length <= 0.0
                || !r.origin.iter().chain([&r.yaw]).all(|v| v.is_finite())
                || !gain(r.train_gain)
                || !gain(r.bell_gain)
            {
                return Err("invalid procedural railway timing, geometry or gain".into());
            }
        }
        Ok(())
    }
}
