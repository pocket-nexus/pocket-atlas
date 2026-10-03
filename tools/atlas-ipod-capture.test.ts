import { expect, test } from "bun:test";
import { validateDrawableCapture } from "./atlas-ipod-capture";

test("raw decode uses the captured surface dimensions through quality transitions", () => {
  const capture = { source: "drawable", width: 480, height: 320, format: "rgba8", encoding: "display-srgb", origin: "bottom-left" };
  expect(validateDrawableCapture(capture, 480 * 320 * 4)).toEqual(capture);
  expect(() => validateDrawableCapture({ ...capture, width: 960, height: 640 }, 480 * 320 * 4)).toThrow();
  expect(validateDrawableCapture({ ...capture, width: 960, height: 640 }, 960 * 640 * 4).width).toBe(960);
});

test("incomplete and differently encoded raw buffers cannot be treated as the display", () => {
  const capture = { source: "drawable", width: 4, height: 2, format: "rgba8", encoding: "display-srgb", origin: "bottom-left" };
  for (const value of [null, {}, { ...capture, width: 0 }, { ...capture, height: 2.5 },
    { ...capture, encoding: "sqrt(c/(1+c))" }, { ...capture, origin: "top-left" }])
    expect(() => validateDrawableCapture(value, 32)).toThrow();
  expect(() => validateDrawableCapture(capture, 28)).toThrow();
});
