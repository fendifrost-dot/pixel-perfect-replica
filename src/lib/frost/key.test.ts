import { describe, expect, it } from "vitest";
import { detectKey, transposeKey } from "./key";

const SR = 44100;
const hz = (midi: number, cents = 0) => 440 * Math.pow(2, (midi - 69 + cents / 100) / 12);

/** Chords as harmonic-rich tones, one per second: a stand-in for a real arrangement. */
function progression(chords: number[][], cents = 0, sec = 1): Float32Array {
  const n = Math.round(sec * SR);
  const out = new Float32Array(n * chords.length);
  chords.forEach((notes, c) => {
    for (const m of notes)
      for (let h = 1; h <= 5; h++) {
        const f = hz(m, cents) * h;
        for (let i = 0; i < n; i++) out[c * n + i] += (0.15 / h) * Math.sin((2 * Math.PI * f * i) / SR) * Math.min(1, i / 500, (n - i) / 500);
      }
  });
  return out;
}

// bass note + triad, root position
const minorCadence = (t: number) => [
  [t - 12, t, t + 3, t + 7], // i
  [t - 7, t + 5, t + 8, t + 12], // iv
  [t - 5, t + 7, t + 11, t + 14], // V (raised leading tone)
  [t - 12, t, t + 3, t + 7], // i
  [t - 9, t + 3, t + 7, t + 10], // III
  [t - 5, t + 7, t + 11, t + 14],
  [t - 12, t, t + 3, t + 7],
];
const majorCadence = (t: number) => [
  [t - 12, t, t + 4, t + 7],
  [t - 7, t + 5, t + 9, t + 12],
  [t - 5, t + 7, t + 11, t + 14],
  [t - 12, t, t + 4, t + 7],
  [t - 3, t + 9, t + 12, t + 16], // vi
  [t - 5, t + 7, t + 11, t + 14],
  [t - 12, t, t + 4, t + 7],
];

describe("key detection", () => {
  it("finds a minor key", () => {
    const k = detectKey(progression(minorCadence(57)), SR)!; // A minor
    expect(k.name).toBe("A minor");
    expect(k.relative).toBe("C major");
    expect(Math.abs(k.tuningCents)).toBeLessThanOrEqual(5);
  });

  it("finds a major key", () => {
    expect(detectKey(progression(majorCadence(60)), SR)!.name).toBe("C major");
  });

  it("reads a Baroque A=415 recording in F minor as E minor at modern pitch", () => {
    // F minor played a semitone (≈ −101 cents) low
    const k = detectKey(progression(minorCadence(65), -101), SR)!;
    expect(k.name).toBe("E minor");
    expect(Math.abs(k.tuningCents)).toBeLessThanOrEqual(5);
  });

  it("keeps the key and reports the offset when a recording is a little out of tune", () => {
    const k = detectKey(progression(minorCadence(65), -30), SR)!;
    expect(k.name).toBe("F minor");
    expect(k.tuningCents).toBeGreaterThanOrEqual(-36);
    expect(k.tuningCents).toBeLessThanOrEqual(-24);
  });

  it("analyses just a part of a recording, and transposes for pad pitch", () => {
    const x = new Float32Array([...progression(majorCadence(60)), ...progression(minorCadence(57))]);
    expect(detectKey(x, SR, 7, 14)!.name).toBe("A minor");
    expect(transposeKey({ tonic: 4, mode: "minor" }, 1)).toBe("F minor");
    expect(transposeKey({ tonic: 0, mode: "major" }, -1)).toBe("B major");
    expect(detectKey(new Float32Array(100), SR)).toBeNull();
  });
});
