/** The render owner measures these dimensions at readback. A status read made
 * before a drawable transition cannot safely describe the resulting buffer. */
export type DrawableCapture = {
  source: "drawable";
  width: number;
  height: number;
  format: "rgba8";
  encoding: "display-srgb";
  origin: "bottom-left";
};

export function validateDrawableCapture(value: unknown, byteLength: number): DrawableCapture {
  const metadata = value as Partial<DrawableCapture> | null;
  if (!metadata || metadata.source !== "drawable" || metadata.format !== "rgba8" ||
      metadata.encoding !== "display-srgb" || metadata.origin !== "bottom-left" ||
      !Number.isInteger(metadata.width) || metadata.width! <= 0 || metadata.width! > 4096 ||
      !Number.isInteger(metadata.height) || metadata.height! <= 0 || metadata.height! > 4096 ||
      byteLength !== metadata.width! * metadata.height! * 4)
    throw new Error("Invalid drawable capture metadata or raw buffer length");
  return metadata as DrawableCapture;
}
