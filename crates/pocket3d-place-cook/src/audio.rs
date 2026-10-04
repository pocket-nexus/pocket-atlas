//! The small, versioned procedural-audio record shared by native adapters.
use pocket_atlas_model::AudioRecipe;

pub fn read(value: &serde_json::Value) -> Result<Option<AudioRecipe>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let recipe: AudioRecipe = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    recipe.validate()?;
    Ok(Some(recipe))
}

/// 32 little-endian f32s in the target's own optional audio table. Version,
/// period, wind, birds(gain/first/interval/seed), railway-present,
/// warning/raised/arrival/speed/length/visible-from/until, origin.xyz/yaw,
/// train/bell gain, then eleven reserved zeroes. No samples are stored.
pub fn native_record(recipe: Option<&AudioRecipe>) -> Option<[f32; 32]> {
    let r = recipe?;
    r.validate().expect("validated audio recipe");
    let mut out = [0.0; 32];
    out[..3].copy_from_slice(&[1.0, r.loop_seconds, r.wind_gain]);
    if let Some(b) = &r.birds {
        out[3..7].copy_from_slice(&[b.gain, b.first, b.interval, b.seed as f32]);
    }
    if let Some(t) = &r.railway {
        out[7..21].copy_from_slice(&[
            1.0,
            t.warning,
            t.raised,
            t.arrival,
            t.speed,
            t.length,
            t.visible_from,
            t.visible_until,
            t.origin[0],
            t.origin[1],
            t.origin[2],
            t.yaw,
            t.train_gain,
            t.bell_gain,
        ]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_recipe_stays_absent_and_unknown_or_invalid_recipe_fails() {
        assert!(read(&serde_json::Value::Null).unwrap().is_none());
        assert!(native_record(None).is_none());
        for bad in [
            serde_json::json!({"version":2}),
            serde_json::json!({"version":1,"loopSeconds":0,"windGain":0.5,"birds":null,"railway":null}),
        ] {
            assert!(read(&bad).is_err());
        }
    }
    #[test]
    fn record_retains_authored_timing_and_tracks() {
        let value = serde_json::json!({"version":1,"loopSeconds":64,"windGain":0.55,
            "birds":{"gain":0.01375,"first":3,"interval":11,"seed":500},
            "railway":{"warning":3,"raised":39,"arrival":18,"speed":10.5,"length":160.4,
                "visibleFrom":3,"visibleUntil":48,"origin":[0,0.102,1.82],"yaw":-0.1,"trainGain":0.28,"bellGain":1}});
        let recipe = read(&value).unwrap().unwrap();
        let data = native_record(Some(&recipe)).unwrap();
        assert_eq!(
            &data[..15],
            &[
                1.0, 64.0, 0.55, 0.01375, 3.0, 11.0, 500.0, 1.0, 3.0, 39.0, 18.0, 10.5, 160.4, 3.0,
                48.0
            ]
        );
        assert_eq!(&data[15..21], &[0.0, 0.102, 1.82, -0.1, 0.28, 1.0]);
        assert!(data[21..].iter().all(|&v| v == 0.0));
        let mut invalid = value;
        invalid["railway"]["raised"] = 2.into();
        assert!(read(&invalid).is_err());
    }
}
