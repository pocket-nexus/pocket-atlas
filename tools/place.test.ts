import { expect, test } from "bun:test";
import { parseOptions, run } from "./place";
test("authoring inspection does not create a DOM, GPU or audio runtime", async () => {
  const result = await run(["inspect", "--place", "sangubashi-crossing"]);
  expect(result.authoring.sampling.durationSeconds).toBe(64);
  expect(result.authoring.cameras).toHaveLength(6);
});
test("misspelled or partial authoring/compiler options fail instead of silently selecting defaults", () => {
  for (const args of [["unknown"], ["cook", "--profle", "psp30"], ["export", "--seconds"], ["check", "--profile", "vita30", "--profile", "psp30"]])
    expect(() => parseOptions(args)).toThrow();
});
