use crate::state::{Store, UserState};
use std::{fs, path::PathBuf};

fn fixture(name: &str) -> (PathBuf, Store) {
    let directory = crate::test_artifact_dir().join("state").join(name);
    if directory.exists() {
        fs::remove_dir_all(&directory).unwrap();
    }
    fs::create_dir_all(&directory).unwrap();
    let store = Store::new(directory.to_str().unwrap()).unwrap();
    (directory, store)
}

fn saved_view() -> UserState {
    UserState {
        version: UserState::VERSION,
        place: Some("tokyo-konbini".into()),
        time: 137.25,
        shot: 3,
        shot_time: 8.5,
        paused: true,
        cinematic: false,
        eye: [4.0, 1.7, 9.0],
        target: [-2.0, 2.0, -5.0],
        fov: 53.0,
        door: 0.6,
        globe_rotation: [-42.0, 279.0],
        sound: true,
        rain: false,
        reflection: true,
        bloom: false,
        quality: 0,
    }
}

#[test]
fn cold_launch_preserves_full_view_and_settings_without_diagnostics() {
    let (directory, store) = fixture("cold-launch");
    assert_eq!(store.load(), Ok(None));
    let state = saved_view();
    store.save(&state).unwrap();
    drop(store);
    let relaunched = Store::new(directory.to_str().unwrap()).unwrap();
    assert_eq!(relaunched.load().unwrap().unwrap(), state);
    let bytes = fs::read(directory.join("pocket-atlas-state.json")).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    for diagnostic in ["freeze", "renderWidth", "profile", "nonce", "touches"] {
        assert!(json.get(diagnostic).is_none());
    }
    assert!(!directory.join("pocket-atlas-state.json.new").exists());
}

#[test]
fn catalog_reordering_uses_stable_ids_and_removed_places_fall_back() {
    let state = saved_view();
    assert_eq!(
        state.selected(["suga-shrine", "tokyo-konbini"].into_iter()),
        Ok(Some(1))
    );
    assert!(state.selected(["suga-shrine"].into_iter()).is_err());
    let mut atlas = state;
    atlas.place = None;
    assert_eq!(atlas.selected(core::iter::empty()), Ok(None));
    assert!(atlas.validate().is_ok());
}

#[test]
fn legacy_retina_default_migrates_once_without_losing_user_view() {
    let (directory, store) = fixture("quality-migration");
    for version in [1, 2] {
        for quality in [0, 1, 2] {
            let mut legacy = saved_view();
            legacy.version = version;
            legacy.quality = quality;
            fs::write(directory.join("pocket-atlas-state.json"), serde_json::to_vec(&legacy).unwrap()).unwrap();
            assert_eq!(store.load().unwrap().unwrap(), saved_view());
        }
    }
    // Migration accepts old choices, not arbitrary corrupt setting values.
    for quality in [-1, 3] {
        let mut invalid = saved_view();
        invalid.quality = quality;
        fs::write(directory.join("pocket-atlas-state.json"), serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(store.load().is_err());
    }
}

#[test]
fn malformed_future_and_oversized_documents_are_rejected() {
    let (directory, store) = fixture("bad-documents");
    let path = directory.join("pocket-atlas-state.json");
    for bytes in [b"{".to_vec(), vec![b' '; 4097], b"null".to_vec()] {
        fs::write(&path, bytes).unwrap();
        assert!(store.load().is_err());
    }
    let mut json = serde_json::to_value(saved_view()).unwrap();
    json["version"] = 999.into();
    fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    assert_eq!(store.load().unwrap_err(), "unsupported user state version");
    json["version"] = UserState::VERSION.into();
    json["profile"] = true.into();
    fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    assert!(store.load().is_err());
    fs::write(&path, b"{\"version\":1,\"time\":1e300}").unwrap();
    assert!(store.load().is_err());
}

#[test]
fn nonfinite_out_of_range_and_degenerate_views_cannot_be_saved() {
    let (_, store) = fixture("invalid-ranges");
    let bad_values = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY];
    for value in bad_values {
        for field in 0..9 {
            let mut state = saved_view();
            match field {
                0 => state.time = value,
                1 => state.shot_time = value,
                2 => state.eye[0] = value,
                3 => state.target[2] = value,
                4 => state.fov = value,
                5 => state.door = value,
                6 => state.globe_rotation[0] = value,
                7 => state.globe_rotation[1] = value,
                _ => state.eye[1] = value,
            }
            assert!(store.save(&state).is_err());
        }
    }
    let mut json = serde_json::to_value(saved_view()).unwrap();
    for (field, value) in [
        ("version", serde_json::json!(0)),
        ("place", serde_json::json!("../escape")),
        ("time", serde_json::json!(-1)),
        ("shot", serde_json::json!(4096)),
        ("shot_time", serde_json::json!(100000)),
        ("quality", serde_json::json!(3)),
        ("door", serde_json::json!(1.5)),
        ("fov", serde_json::json!(180)),
        ("globe_rotation", serde_json::json!([90, 360])),
        ("eye", serde_json::json!([100001, 2, 3])),
    ] {
        let original = json[field].take();
        json[field] = value;
        assert!(serde_json::from_value::<UserState>(json.clone())
            .unwrap()
            .validate()
            .is_err());
        json[field] = original;
    }
    let mut vertical = saved_view();
    vertical.target = vertical.eye;
    vertical.target[1] += 10.0;
    assert!(vertical.validate().is_err());
}

#[test]
fn interrupted_or_failed_checkpoint_keeps_previous_complete_document() {
    let (directory, store) = fixture("interrupted-write");
    let original = saved_view();
    store.save(&original).unwrap();
    let temporary = directory.join("pocket-atlas-state.json.new");
    fs::write(&temporary, b"{\"version\":").unwrap();
    assert_eq!(store.load().unwrap().unwrap(), original);
    fs::remove_file(&temporary).unwrap();
    fs::create_dir(&temporary).unwrap();
    let mut replacement = original.clone();
    replacement.time += 1.0;
    assert!(store.save(&replacement).is_err());
    assert_eq!(store.load().unwrap().unwrap(), original);
    fs::remove_dir(&temporary).unwrap();
    store.save(&replacement).unwrap();
    assert_eq!(store.load().unwrap().unwrap(), replacement);
}

#[test]
fn concurrent_readers_only_observe_complete_replacements() {
    let (directory, store) = fixture("atomic-read");
    store.save(&saved_view()).unwrap();
    let reader = Store::new(directory.to_str().unwrap()).unwrap();
    let thread = std::thread::spawn(move || {
        for _ in 0..500 {
            let state = reader.load().unwrap().unwrap();
            assert_eq!(state.time, 137.25 + state.shot as f32 - 3.0);
        }
    });
    for shot in 0..30 {
        let mut state = saved_view();
        state.shot = shot;
        state.time = 137.25 + shot as f32 - 3.0;
        store.save(&state).unwrap();
    }
    thread.join().unwrap();
}
