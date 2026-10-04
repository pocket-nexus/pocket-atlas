// Exercise the actual Vita stream reader without a device SDK.
#[allow(dead_code)]
#[path = "../../../vita/src/pack_io.rs"]
mod pack_io;
use sha2::{Digest, Sha256};

#[test]
fn digest_includes_skips_tail_and_reopened_ranges_exactly_once() {
    let path = std::env::temp_dir().join(format!("atlas-stream-{}.bin", std::process::id()));
    let bytes: Vec<u8> = (0..210000).map(|i| (i * 13 % 251) as u8).collect();
    std::fs::write(&path, &bytes).unwrap();
    let expected = format!("{:x}", Sha256::digest(&bytes));
    let mut reader = pack_io::Seq::open(path.to_str().unwrap()).unwrap();
    let mut data = vec![0; 100];
    for offset in [0u64, 70000, 64, 90000, 90001] {
        reader.read_at(offset, &mut data).unwrap();
        assert_eq!(data, &bytes[offset as usize..offset as usize + 100]);
    }
    assert_eq!(reader.finish_digest().unwrap(), expected);
    let mut reader = pack_io::Seq::open(path.to_str().unwrap()).unwrap();
    assert!(reader.read_at(209999, &mut data).is_err());
    std::fs::remove_file(path).unwrap();
}
