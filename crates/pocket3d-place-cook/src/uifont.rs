//! The handheld's interface text, baked into the atlas pack. Each style of
//! [`STYLES`] is a face at a pixel size; glyphs are rasterized 1:1
//! (the interface draws at the display's 960×544) into one 8-bit coverage
//! atlas, so text lands on whole pixels. Latin comes from Inter, everything
//! else from Noto Sans CJK; the charset is ASCII, Latin-1, Latin Extended-A,
//! [`UI_EXTRA`] and every character in the places' strings.

use ab_glyph::{Font, FontVec, PxScale, ScaleFont};
use pocket3d_place::atlas::{AtlasPlace, FontMeta, FontStyle, Glyph, STYLES, UI_EXTRA};
use std::collections::BTreeSet;
use std::path::PathBuf;

/// Regular and bold faces for Latin and for CJK.
pub struct Faces {
    pub latin: [PathBuf; 2],
    pub cjk: [PathBuf; 2],
}

/// Characters the interface may draw.
pub fn charset(places: &[AtlasPlace]) -> BTreeSet<char> {
    let mut set: BTreeSet<char> = (0x20u32..0x7f).chain(0xa0..0x180).filter_map(char::from_u32).collect();
    set.extend(UI_EXTRA.chars());
    for p in places {
        // A route's display names its stops as the car reaches them.
        let stops = p.route.iter().flat_map(|r| r.stops.iter().flat_map(|s| [&s.0, &s.1]).chain([&r.from, &r.to]));
        for s in [&p.name, &p.native, &p.locality, &p.locality_native, &p.country, &p.weather, &p.author, &p.summary, &p.kind].into_iter().chain(&p.tags).chain(stops) {
            // Kind and weather labels are drawn upper-case.
            set.extend(s.chars().flat_map(|c| [c].into_iter().chain(c.to_uppercase())));
        }
    }
    set.retain(|c| !c.is_control());
    set
}

/// Font-size (em) scale: `px` pixels per em, as CSS sizes text.
fn em_scale(f: &FontVec, px: f32) -> PxScale {
    let upem = f.units_per_em().unwrap_or(1000.0);
    PxScale::from(px * f.height_unscaled() / upem)
}

/// The font metadata and its coverage atlas (`width` × `height` bytes).
pub fn bake(places: &[AtlasPlace], faces: &Faces) -> (FontMeta, Vec<u8>) {
    let load = |p: &PathBuf| FontVec::try_from_vec(std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    let (lat, cj) = (faces.latin.each_ref().map(load), faces.cjk.each_ref().map(load));
    let chars = charset(places);

    struct Cell {
        glyph: Glyph,
        px: Vec<u8>,
    }
    let mut cells = Vec::new();
    let mut styles = Vec::new();
    let mut missing = BTreeSet::new();
    for (si, &(name, px, bold)) in STYLES.iter().enumerate() {
        let b = bold as usize;
        let ls = lat[b].as_scaled(em_scale(&lat[b], px));
        styles.push(FontStyle { name: name.into(), px, bold, ascent: ls.ascent(), descent: ls.descent(), line: ls.height() + ls.line_gap() });
        for &c in &chars {
            // Inter for Latin and its symbols; Noto Sans CJK for the rest.
            let font = if lat[b].glyph_id(c).0 != 0 && (c as u32) < 0x2e80 {
                &lat[b]
            } else if cj[b].glyph_id(c).0 != 0 {
                &cj[b]
            } else {
                missing.insert(c);
                continue;
            };
            let scale = em_scale(font, px);
            let id = font.glyph_id(c);
            let mut cell = Cell { glyph: Glyph { style: si as u8, cp: c as u32, advance: font.as_scaled(scale).h_advance(id), ..Glyph::default() }, px: Vec::new() };
            if let Some(o) = font.outline_glyph(id.with_scale(scale)) {
                // Whole-pixel bounds; `draw` covers exactly that box.
                let r = o.px_bounds();
                let (w, h) = (r.width() as u32, r.height() as u32);
                cell.glyph.left = r.min.x as i16;
                cell.glyph.top = r.min.y as i16;
                cell.glyph.w = w as u16;
                cell.glyph.h = h as u16;
                cell.px = vec![0u8; (w * h) as usize];
                o.draw(|x, y, cov| {
                    if x < w && y < h {
                        cell.px[(y * w + x) as usize] = (cov.clamp(0.0, 1.0) * 255.0).round() as u8;
                    }
                });
            }
            cells.push(cell);
        }
    }

    // Shelf packing, tallest first, 2 px apart.
    let width = 1024u32;
    let mut order: Vec<usize> = (0..cells.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse((cells[i].glyph.h, cells[i].glyph.w)));
    let (mut x, mut y, mut shelf) = (1u32, 1u32, 0u32);
    for &i in &order {
        let g = &mut cells[i].glyph;
        if g.w == 0 {
            continue;
        }
        if x + g.w as u32 + 1 > width {
            x = 1;
            y += shelf + 2;
            shelf = 0;
        }
        (g.x, g.y) = (x as u16, y as u16);
        x += g.w as u32 + 2;
        shelf = shelf.max(g.h as u32);
    }
    let height = (y + shelf + 1).next_power_of_two().max(64);
    let mut atlas = vec![0u8; (width * height) as usize];
    for c in &cells {
        let g = &c.glyph;
        for row in 0..g.h as usize {
            let dst = (g.y as usize + row) * width as usize + g.x as usize;
            atlas[dst..dst + g.w as usize].copy_from_slice(&c.px[row * g.w as usize..(row + 1) * g.w as usize]);
        }
    }
    println!(
        "  ui font: {} styles, {} chars, {} glyphs, {width}×{height}{}",
        STYLES.len(),
        chars.len(),
        cells.len(),
        if missing.is_empty() { String::new() } else { format!("; no glyph for {}", missing.iter().collect::<String>()) }
    );
    (FontMeta { width, height, styles, glyphs: cells.into_iter().map(|c| c.glyph).collect() }, atlas)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every non-ASCII character the handheld's interface writes in a string
    /// literal is in the baked charset (or the system font draws it instead).
    #[test]
    fn interface_characters_are_baked() {
        let set = charset(&[]);
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../vita/src");
        let mut missing = BTreeSet::new();
        for f in ["browser.rs", "settings.rs", "ui.rs", "main.rs", "drive/mod.rs", "drive/hud.rs"] {
            let src = std::fs::read_to_string(format!("{dir}/{f}")).unwrap();
            // Characters inside "…" literals on lines that are not comments.
            for line in src.lines().filter(|l| !l.trim_start().starts_with("//")) {
                let mut inside = false;
                for c in line.chars() {
                    if c == '"' {
                        inside = !inside;
                    } else if inside && !c.is_ascii() && !set.contains(&c) {
                        missing.insert(c);
                    }
                }
            }
        }
        assert!(missing.is_empty(), "not in the baked charset: {}", missing.iter().collect::<String>());
    }
}
