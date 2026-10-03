//! The compiler and legacy startup fallback share one environment bake.
//! Direction sampling below is test-only experimental comparison code.
pub use pocket3d_place::ipod::display_environment::{bake, CUBE_BYTES, FACE_SIZE};
#[cfg(test)]
pub use pocket3d_place::ipod::display_environment::{cube_faces, oct_pixels};

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use alloc::{vec, vec::Vec};
    // OpenGL ES 2.0.25 section 3.7.5, table 3.11. The order matches
    // GL_TEXTURE_CUBE_MAP_POSITIVE_X + face. Rows increase with texture t.
    fn direction(face: usize, s: f32, t: f32) -> [f32; 3] {
        let (s, t) = (s * 2.0 - 1.0, t * 2.0 - 1.0);
        match face {
            0 => [1.0, -t, -s],
            1 => [-1.0, -t, s],
            2 => [s, 1.0, t],
            3 => [s, -1.0, -t],
            4 => [s, -t, 1.0],
            5 => [-s, -t, -1.0],
            _ => unreachable!(),
        }
    }

    fn oct_uv(d: [f32; 3]) -> [f32; 2] {
        let sum = d[0].abs() + d[1].abs() + d[2].abs();
        let mut p = [d[0] / sum, d[2] / sum];
        if d[1] < 0.0 {
            p = [
                (1.0 - p[1].abs()) * if p[0] >= 0.0 { 1.0 } else { -1.0 },
                (1.0 - p[0].abs()) * if p[1] >= 0.0 { 1.0 } else { -1.0 },
            ];
        }
        p.map(|v| v * 0.5 + 0.5)
    }

    // Match the previous level-zero GL_LINEAR / CLAMP_TO_EDGE display texture.
    fn sample(width: u32, height: u32, pixels: &[u8], uv: [f32; 2]) -> [f32; 4] {
        let x = (uv[0] * width as f32 - 0.5).clamp(0.0, width as f32 - 1.0);
        let y = (uv[1] * height as f32 - 0.5).clamp(0.0, height as f32 - 1.0);
        let (x0, y0) = (x as u32, y as u32);
        let (x1, y1) = ((x0 + 1).min(width - 1), (y0 + 1).min(height - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        core::array::from_fn(|c| {
            let get = |x: u32, y: u32| pixels[((y * width + x) * 4) as usize + c] as f32;
            let a = get(x0, y0) * (1.0 - fx) + get(x1, y0) * fx;
            let b = get(x0, y1) * (1.0 - fx) + get(x1, y1) * fx;
            a * (1.0 - fy) + b * fy
        })
    }

    fn cube_sample(faces: &[Vec<u8>; 6], d: [f32; 3]) -> [f32; 4] {
        cube_sample_at_size(FACE_SIZE, faces, d)
    }

    fn cube_sample_at_size(size: u32, faces: &[Vec<u8>; 6], d: [f32; 3]) -> [f32; 4] {
        let [x, y, z] = d;
        let (face, sc, tc, major) = if x.abs() >= y.abs() && x.abs() >= z.abs() {
            if x >= 0.0 {
                (0, -z, -y, x.abs())
            } else {
                (1, z, -y, x.abs())
            }
        } else if y.abs() >= z.abs() {
            if y >= 0.0 {
                (2, x, z, y.abs())
            } else {
                (3, x, -z, y.abs())
            }
        } else if z >= 0.0 {
            (4, x, -y, z.abs())
        } else {
            (5, -x, -y, z.abs())
        };
        sample(
            size,
            size,
            &faces[face],
            [(sc / major + 1.0) * 0.5, (tc / major + 1.0) * 0.5],
        )
    }

    /// A deterministic angular sample, including every face edge/corner and
    /// both sides of seams. Values are display-byte errors, not GPU precision.
    pub(crate) fn error(width: u32, height: u32, pixels: &[u8]) -> (f64, f32, usize) {
        error_at_size(width, height, pixels, FACE_SIZE)
    }

    pub(crate) fn error_at_size(
        width: u32,
        height: u32,
        pixels: &[u8],
        size: u32,
    ) -> (f64, f32, usize) {
        assert!([32, 64, 128].contains(&size));
        // Experiment only: production uses the shared fixed 64px implementation.
        let faces: [Vec<u8>; 6] = core::array::from_fn(|face| {
            let mut data = Vec::new();
            for y in 0..size {
                for x in 0..size {
                    let d = direction(
                        face,
                        (x as f32 + 0.5) / size as f32,
                        (y as f32 + 0.5) / size as f32,
                    );
                    data.extend(sample(width, height, pixels, oct_uv(d)).map(|c| (c + 0.5) as u8));
                }
            }
            data
        });
        if size == FACE_SIZE {
            assert_eq!(faces, cube_faces(width, height, pixels).unwrap());
        }
        let mut sum = 0.0f64;
        let mut max = 0.0f32;
        let mut count = 0;
        for face in 0..6 {
            for y in 0..=128 {
                for x in 0..=128 {
                    let d = direction(face, x as f32 / 128.0, y as f32 / 128.0);
                    let expected = sample(width, height, pixels, oct_uv(d));
                    let actual = cube_sample_at_size(size, &faces, d);
                    for c in 0..3 {
                        let e = (expected[c] - actual[c]).abs();
                        sum += f64::from(e * e);
                        max = max.max(e);
                        count += 1;
                    }
                }
            }
        }
        (sum.sqrt() / (count as f64).sqrt(), max, count / 3)
    }

    #[test]
    fn face_centers_and_rows_follow_es2_cube_orientation() {
        assert_eq!(
            (0..6).map(|f| direction(f, 0.5, 0.5)).collect::<Vec<_>>(),
            [
                [1.0, 0.0, 0.0],
                [-1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, -1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, -1.0]
            ]
        );
        assert_eq!(direction(0, 0.0, 0.0), [1.0, 1.0, 1.0]);
        assert_eq!(direction(2, 0.0, 0.0), [-1.0, 1.0, -1.0]);
        assert_eq!(direction(5, 0.0, 1.0), [1.0, -1.0, -1.0]);
        assert_eq!(oct_uv([0.0, 1.0, 0.0]), [0.5, 0.5]);
        assert_eq!(oct_uv([0.0, -1.0, 0.0]), [1.0, 1.0]);
    }

    #[test]
    fn constant_maps_are_exact_and_invalid_maps_are_rejected() {
        let faces = cube_faces(1, 1, &[51, 102, 153, 255]).unwrap();
        assert_eq!(faces.iter().map(Vec::len).sum::<usize>(), CUBE_BYTES);
        assert!(faces
            .iter()
            .all(|f| f.chunks_exact(4).all(|p| p == [51, 102, 153, 255])));
        for (w, h, n) in [(0, 1, 0), (1, 0, 0), (65, 1, 260), (1, 1, 3), (1, 1, 8)] {
            assert!(cube_faces(w, h, &vec![0; n]).is_err());
        }
    }

    #[test]
    fn direction_colored_map_preserves_axes_and_measures_seam_error() {
        let mut pixels = Vec::new();
        for y in 0..64 {
            for x in 0..64 {
                let (u, v) = ((x as f32 + 0.5) / 32.0 - 1.0, (y as f32 + 0.5) / 32.0 - 1.0);
                let mut d = [u, 1.0 - u.abs() - v.abs(), v];
                if d[1] < 0.0 {
                    d[0] = (1.0 - v.abs()) * u.signum();
                    d[2] = (1.0 - u.abs()) * v.signum();
                }
                let length = libm::sqrtf(d.iter().map(|v| v * v).sum());
                pixels.extend(d.map(|v| ((v / length * 0.5 + 0.5) * 255.0 + 0.5) as u8));
                pixels.push(255);
            }
        }
        let faces = cube_faces(64, 64, &pixels).unwrap();
        for face in 0..6 {
            let d = direction(face, 0.5, 0.5);
            let actual = cube_sample(&faces, d);
            for c in 0..3 {
                assert!((actual[c] - (d[c] * 0.5 + 0.5) * 255.0).abs() < 2.5);
            }
        }
        let (rmse, max, count) = error(64, 64, &pixels);
        std::println!("cube synthetic: samples={count}, RGB byte RMSE={rmse:.6}, max={max:.6}");
        assert!(rmse < 0.7 && max < 3.5, "{rmse} / {max}");
    }
}
