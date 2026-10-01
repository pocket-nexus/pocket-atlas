/** Canvas drawing helpers shared by every place: fonts, canvases, textures, text layout. */
import { CanvasTexture, ClampToEdgeWrapping, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace } from "three";

export const JP_SANS = `"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif`;
export const JP_SERIF = `"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", "Noto Serif CJK JP", serif`;
export const LATIN = `"Helvetica Neue", "Arial", sans-serif`;

export type Ctx = CanvasRenderingContext2D;

export function canvas(w: number, h: number): { c: HTMLCanvasElement; g: Ctx } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  return { c, g };
}

export function toTexture(c: HTMLCanvasElement, repeat = false, anisotropy = 8): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.minFilter = LinearMipmapLinearFilter;
  t.wrapS = t.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  return t;
}

export function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Draws text vertically (one glyph per line), centered on x. */
export function verticalText(g: Ctx, text: string, x: number, y: number, size: number, gap = 1.08): void {
  const chars = Array.from(text);
  g.textAlign = "center";
  g.textBaseline = "middle";
  chars.forEach((ch, i) => {
    const cy = y + size * gap * (i + 0.5);
    // Long vowel mark and dashes rotate in vertical writing.
    if (ch === "ー" || ch === "—" || ch === "-") {
      g.save();
      g.translate(x, cy);
      g.rotate(Math.PI / 2);
      g.fillText(ch, 0, 0);
      g.restore();
    } else g.fillText(ch, x, cy);
  });
}
