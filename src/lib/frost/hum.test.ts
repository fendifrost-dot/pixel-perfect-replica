import { describe, expect, it } from "vitest";
import { beatboxHits, melodyHits, noteName, octaveShift, transcribeBeatbox, transcribeHum } from "./hum";

const SR = 48000;

/** A voice-ish tone: fundamental plus a couple of harmonics, with soft edges. */
function tone(f: number, sec: number, amp = 0.4): Float32Array {
  const n = Math.round(sec * SR);
  const out = new Float32Array(n);
  const edge = Math.round(0.01 * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const e = Math.min(1, i / edge, (n - i) / edge);
    out[i] = amp * e * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t)) / 1.75;
  }
  return out;
}
const silence = (sec: number) => new Float32Array(Math.round(sec * SR));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

describe("hum to notes", () => {
  it("hears a sung line as its notes, in time", () => {
    // A2 (110 Hz), E3, a gap, then A2 again
    const x = join(silence(0.2), tone(110, 0.4), tone(164.81, 0.4), silence(0.15), tone(110, 0.3), silence(0.2));
    const notes = transcribeHum(x, SR);
    expect(notes.map((n) => n.midi)).toEqual([45, 52, 45]);
    expect(notes[0].start).toBeCloseTo(0.2, 1);
    expect(notes[1].start).toBeCloseTo(0.6, 1);
    expect(notes[2].start).toBeCloseTo(1.15, 1);
    expect(notes[2].end - notes[2].start).toBeGreaterThan(0.2);
  });

  it("moves a hummed bassline into the instrument's register", () => {
    const notes = [45, 52, 45].map((midi, i) => ({ start: i, end: i + 0.5, midi, level: 1 }));
    expect(octaveShift(notes, 24)).toBe(-12); // A2 → A1, in an 808's range (root C1)
    expect(octaveShift(notes, 60)).toBe(24); // A2 → A4 for keys (root C4)
    expect(noteName(36)).toBe("C2");
  });

  it("tells beatboxed kick, snare and hat apart", () => {
    const n = Math.round(0.12 * SR);
    const kick = new Float32Array(n).map((_, i) => 0.8 * Math.sin(2 * Math.PI * 60 * (i / SR)) * Math.exp(-i / SR / 0.05));
    let lp1 = 0, lp2 = 0, hp = 0;
    const snare = new Float32Array(n).map((_, i) => {
      // noise band-limited to roughly 1–4 kHz, like a voiced "ka"
      lp1 += 0.3 * (rand() - lp1);
      lp2 += 0.3 * (lp1 - lp2);
      hp += 0.12 * (lp2 - hp);
      return 4 * (lp2 - hp) * Math.exp(-i / SR / 0.04);
    });
    let prev = 0;
    const hat = new Float32Array(n).map((_, i) => {
      const r = rand();
      const v = r - prev; // high-passed noise
      prev = r;
      return 0.4 * v * Math.exp(-i / SR / 0.02);
    });
    const x = join(silence(0.3), kick, silence(0.3), snare, silence(0.3), hat, silence(0.3));
    const hits = transcribeBeatbox(x, SR);
    expect(hits.map((h) => h.kind)).toEqual(["kick", "snare", "hat"]);
  });

  it("places a take on the timeline at the beat, snapped, with each note's pitch", () => {
    let i = 0;
    // take started at step 16 (bar 2) at 120 BPM: one step = 0.125 s
    const at = { stepAt: (sec: number) => 16 + sec / 0.125, snap: 1, makeId: () => `n${i++}` };
    const hits = melodyHits(
      [
        { start: 0.02, end: 0.49, midi: 45, level: 1 },
        { start: 0.51, end: 0.6, midi: 48, level: 0.5 },
      ],
      "B1",
      24,
      -12,
      at,
    );
    expect(hits.map((h) => [h.step, h.length, h.pitch])).toEqual([
      [16, 4, 9], // A1 on an 808 rooted at C1 = +9
      [20, 1, 12],
    ]);
    const bb = beatboxHits(
      [
        { time: 0, kind: "kick", level: 1 },
        { time: 0.01, kind: "kick", level: 1 },
        { time: 0.5, kind: "snare", level: 0.8 },
      ],
      { kick: "A1", snare: "A2", hat: "A3" },
      at,
    );
    expect(bb.map((h) => [h.padId, h.step])).toEqual([
      ["A1", 16],
      ["A2", 20],
    ]);
  });
});
