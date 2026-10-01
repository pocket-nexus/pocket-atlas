import { describe, expect, test } from "bun:test";
import { railState, type RailPass } from "../src/places/shared/railway-motion";
import { PASS } from "../src/places/sangubashi-crossing/rail";

const shorter: RailPass = { ...PASS, period: 50, arrival: 14, length: 60, speed: 8, release: 24, raised: 29, visibleUntil: 38 };

describe("level-crossing interlock", () => {
  for (const [name, pass] of [["Sangubashi eight-car local", PASS], ["shorter, slower local", shorter]] as const) {
    test(`${name}: both gates stay down and lamps warn while any car occupies the road`, () => {
      for (let t = 0; t < pass.period * 2; t += 0.025) {
        const s = railState(pass, t);
        if (s.front >= -3.5 && s.tail <= 3.5) {
          expect(s.visible).toBe(true);
          expect(s.gate).toBe(1);
          expect(s.warning).toBe(true);
        }
      }
      expect(railState(pass, pass.release).tail).toBeGreaterThan(3.5);
    });
    test(`${name}: seeking and loop wrap preserve the same pose`, () => {
      for (const t of [0, 3.4, 7.1, 18.2, 28.9, pass.period - 0.01]) {
        const a = railState(pass, t), b = railState(pass, t + pass.period * 3);
        expect(a.front).toBeCloseTo(b.front, 8);
        expect(a.gate).toBeCloseTo(b.gate, 8);
        expect(a.warning).toBe(b.warning);
      }
      const end = railState(pass, pass.period - 0.001), start = railState(pass, 0);
      expect(end.visible || start.visible).toBe(false);
      expect(end.gate + start.gate).toBe(0);
      expect(end.warning || start.warning).toBe(false);
    });
  }
  test("warning leads the descent and the two lights alternate", () => {
    expect(PASS.warning).toBeLessThan(PASS.lower);
    expect(railState(PASS, PASS.lowered).front).toBeLessThan(-3.5);
    expect(railState(PASS, 15).lamp).not.toBe(railState(PASS, 15 + 1 / 2.2).lamp);
  });
});
