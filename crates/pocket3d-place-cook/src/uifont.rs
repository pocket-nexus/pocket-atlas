//! `pocket-atlas-cook ui-font`: the handheld's interface text, baked. Each
//! style is a face at a pixel size; glyphs are rasterized 1:1 (the interface
//! draws at the display's 960×544) into one 8-bit coverage atlas, so text
//! lands on whole pixels. Latin comes from Inter, everything else from Noto
//! Sans CJK; the charset is the interface's own characters plus every
//! character in the places' names, localities, tags and summaries.
//!
//! File (`ui.font`): `PAUF`, version u32, JSON length u32, atlas width u32,
//! height u32, the JSON (styles; glyphs as [style, codepoint, x, y, w, h,
//! left, top, advance], left/top from the pen on the baseline), then the
//! coverage bytes, top row first.

use ab_glyph::{Font, FontVec, PxScale, ScaleFont};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

pub const MAGIC: [u8; 4] = *b"PAUF";

/// (name, size px, bold). Order is the style index the Vita uses (`ui::T`).
pub const STYLES: [(&str, f32, bool); 8] = [
    ("caption", 15.0, false),
    ("label", 13.0, true),
    ("body", 17.0, false),
    ("strong", 17.0, true),
    ("title", 21.0, true),
    ("heading", 27.0, true),
    ("brand", 34.0, true),
    ("small", 15.0, true),
];

/// Characters the interface itself writes.
const UI_EXTRA: &str = "·•…“”‘’–—×★☆‹›°±²³½→←↑↓⇄✓";

fn charset(places: &Value) -> BTreeSet<char> {
    let mut set: BTreeSet<char> = (0x20u32..0x7f).chain(0xa0..0x180).filter_map(char::from_u32).collect();
    set.extend(UI_EXTRA.chars());
    for p in places.as_array().into_iter().flatten() {
        for k in ["name", "native", "locality", "localityNative", "country", "weather", "author", "summary", "kind"] {
            if let Some(s) = p[k].as_str() {
                set.extend(s.chars().flat_map(|c| [c].into_iter().chain(c.to_uppercase())));
            }
        }
        for t in p["tags"].as_array().into_iter().flatten() {
            if let Some(s) = t.as_str() {
                set.extend(s.chars());
            }
        }
    }
    set.retain(|c| !c.is_control());
    set
}

struct Glyph {
    style: usize,
    cp: u32,
    w: u32,
    h: u32,
    left: i32,
    top: i32,
    adv: f32,
    px: Vec<u8>,
}

/// Font-size (em) scale: `px` pixels per em, as CSS sizes text.
fn em_scale(f: &FontVec, px: f32) -> PxScale {
    let upem = f.units_per_em().unwrap_or(1000.0);
    PxScale::from(px * f.height_unscaled() / upem)
}

pub fn bake(places_json: &Path, latin: [&Path; 2], cjk: [&Path; 2], out: &Path) {
    let load = |p: &Path| FontVec::try_from_vec(std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    let (lat, cj) = ([load(latin[0]), load(latin[1])], [load(cjk[0]), load(cjk[1])]);
    let places: Value = serde_json::from_slice(&std::fs::read(places_json).expect("places.json")).expect("places.json");
    let chars = charset(&places);

    let mut glyphs = Vec::new();
    let mut styles = Vec::new();
    let mut missing = BTreeSet::new();
    for (si, &(name, px, bold)) in STYLES.iter().enumerate() {
        let b = bold as usize;
        let ls = lat[b].as_scaled(em_scale(&lat[b], px));
        styles.push(json!({ "name": name, "px": px, "bold": bold, "ascent": ls.ascent(), "descent": ls.descent(), "line": ls.height() + ls.line_gap() }));
        for &c in &chars {
            // Inter for Latin and its symbols; Noto Sans CJK for the rest.
            let (font, scale) = if lat[b].glyph_id(c).0 != 0 && (c as u32) < 0x2e80 {
                (&lat[b], em_scale(&lat[b], px))
            } else if cj[b].glyph_id(c).0 != 0 {
                (&cj[b], em_scale(&cj[b], px))
            } else {
                missing.insert(c);
                continue;
            };
            let id = font.glyph_id(c);
            let adv = font.as_scaled(scale).h_advance(id);
            let mut g = Glyph { style: si, cp: c as u32, w: 0, h: 0, left: 0, top: 0, adv, px: Vec::new() };
            if let Some(o) = font.outline_glyph(id.with_scale(scale)) {
                let r = o.px_bounds();
                g.left = r.min.x.floor() as i32;
                g.top = r.min.y.floor() as i32;
                g.w = (r.max.x.ceil() - r.min.x.floor()) as u32;
                g.h = (r.max.y.ceil() - r.min.y.floor()) as u32;
                g.px = vec![0u8; (g.w * g.h) as usize];
                let (ox, oy) = (r.min.x - r.min.x.floor(), r.min.y - r.min.y.floor());
                o.draw(|x, y, cov| {
                    let (xx, yy) = (x + ox.round() as u32, y + oy.round() as u32);
                    if xx < g.w && yy < g.h {
                        let v = &mut g.px[(yy * g.w + xx) as usize];
                        *v = (*v).max((cov.clamp(0.0, 1.0) * 255.0).round() as u8);
                    }
                });
            }
            glyphs.push(g);
        }
    }

    // Shelf packing, tallest first, 2 px apart.
    let width = 1024u32;
    let mut order: Vec<usize> = (0..glyphs.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse((glyphs[i].h, glyphs[i].w)));
    let (mut x, mut y, mut shelf) = (1u32, 1u32, 0u32);
    let mut at = vec![(0u32, 0u32); glyphs.len()];
    for &i in &order {
        let g = &glyphs[i];
        if g.w == 0 {
            continue;
        }
        if x + g.w + 1 > width {
            x = 1;
            y += shelf + 2;
            shelf = 0;
        }
        at[i] = (x, y);
        x += g.w + 2;
        shelf = shelf.max(g.h);
    }
    let height = (y + shelf + 1).next_power_of_two().max(64);
    let mut atlas = vec![0u8; (width * height) as usize];
    for (i, g) in glyphs.iter().enumerate() {
        let (gx, gy) = at[i];
        for row in 0..g.h {
            let dst = ((gy + row) * width + gx) as usize;
            atlas[dst..dst + g.w as usize].copy_from_slice(&g.px[(row * g.w) as usize..((row + 1) * g.w) as usize]);
        }
    }

    let table: Vec<Value> = glyphs
        .iter()
        .enumerate()
        .map(|(i, g)| json!([g.style, g.cp, at[i].0, at[i].1, g.w, g.h, g.left, g.top, (g.adv * 64.0).round() / 64.0]))
        .collect();
    let meta = serde_json::to_vec(&json!({ "styles": styles, "glyphs": table })).unwrap();
    let mut file = Vec::with_capacity(20 + meta.len() + atlas.len());
    file.extend_from_slice(&MAGIC);
    for v in [1u32, meta.len() as u32, width, height] {
        file.extend_from_slice(&v.to_le_bytes());
    }
    file.extend_from_slice(&meta);
    file.extend_from_slice(&atlas);
    std::fs::write(out, &file).unwrap_or_else(|e| panic!("{}: {e}", out.display()));
    println!(
        "wrote {} ({} styles, {} chars, {} glyphs, atlas {width}×{height}, {} KiB){}",
        out.display(),
        STYLES.len(),
        chars.len(),
        glyphs.len(),
        file.len() / 1024,
        if missing.is_empty() { String::new() } else { format!("; no glyph for {}", missing.iter().collect::<String>()) }
    );
}
