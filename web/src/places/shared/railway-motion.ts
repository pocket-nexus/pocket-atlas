/** A deterministic, seekable pass: the front runs along local +X, in metres. */
export interface RailPass {
  period: number;
  arrival: number;
  speed: number;
  length: number;
  warning: number;
  lower: number;
  lowered: number;
  release: number;
  raised: number;
  visibleFrom: number;
  visibleUntil: number;
}

const ease = (v: number) => { const x = Math.max(0, Math.min(1, v)); return x * x * (3 - 2 * x); };

export function railState(pass: RailPass, time: number) {
  const phase = ((time % pass.period) + pass.period) % pass.period;
  const front = (phase - pass.arrival) * pass.speed;
  const gate = phase < pass.release
    ? ease((phase - pass.lower) / (pass.lowered - pass.lower))
    : 1 - ease((phase - pass.release) / (pass.raised - pass.release));
  return {
    phase, front, tail: front - pass.length, gate,
    warning: phase >= pass.warning && phase < pass.raised,
    lamp: Math.floor(phase * 2.2) % 2,
    visible: phase >= pass.visibleFrom && phase <= pass.visibleUntil,
  };
}
