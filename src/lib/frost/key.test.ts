import { describe, expect, it } from "vitest";
import { detectKey, detectPitch, keyShift, parseKey, rootShift, transposeKey } from "./key";
import * as ops from "./ops";
import { findDrum } from "./kits";
import { playPlan } from "./timing";
import { makePad } from "./demo";

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

  it("works out the smallest move into the beat's key (relative major/minor count as the same notes)", () => {
    const Em = { tonic: 4, mode: "minor" as const };
    expect(keyShift({ tonic: 7, mode: "minor" }, Em)).toBe(-3); // G minor → E minor
    expect(keyShift({ tonic: 7, mode: "major" }, Em)).toBe(0); // G major has E minor's notes
    expect(keyShift({ tonic: 11, mode: "minor" }, Em)).toBe(5); // B minor → E minor (up a 4th)
    expect(keyShift({ tonic: 10, mode: "minor" }, Em)).toBe(-6);
    expect(rootShift(29, Em)).toBe(-1); // an 808 on F1 → E1
    expect(rootShift(36, Em)).toBe(4); // C2 → E2
  });

  it("hears the note of pitched drums, and none in a hat", () => {
    const at = (kit: string, drum: string) => detectPitch(findDrum(kit, drum)!.drum.render(SR), SR);
    expect(Math.round(at("trap808", "808f")!)).toBe(29); // F1 (43.65 Hz)
    expect(Math.round(at("trap808", "808c")!)).toBe(24); // C1
    expect(at("trap808", "hat")).toBeNull();
  });

  it("changes key without changing speed when Keep speed is on", () => {
    const slice = { id: "s", sourceId: "x", name: "s", start: 0, end: 2 };
    const pad = { ...makePad("A", 0), pitch: -3 };
    expect(playPlan(pad, slice, 120).duration).toBeCloseTo(2 / Math.pow(2, -3 / 12)); // classic: slower
    const kept = playPlan({ ...pad, keepSpeed: true }, slice, 120);
    expect(kept.duration).toBe(2);
    expect(kept.pitchSemis).toBe(-3);
    expect(kept.stretch).toBeCloseTo(Math.pow(2, -3 / 12));
  });

  it("reads key names and stores the beat key on the project", () => {
    expect(parseKey("E minor")).toEqual({ tonic: 4, mode: "minor" });
    expect(parseKey("F# major")).toEqual({ tonic: 6, mode: "major" });
    expect(parseKey("Bbm")).toEqual({ tonic: 10, mode: "minor" });
    expect(parseKey("H minor")).toBeNull();
    const p = ops.setProjectFields(ops.newProject("t"), { beatKey: "E minor" });
    expect(p.key).toEqual({ tonic: 4, mode: "minor" });
    expect(ops.summarize(p).beatKey).toBe("E minor");
    expect(ops.setProjectFields(p, { beatKey: "" }).key).toBeUndefined();
    expect(() => ops.setProjectFields(p, { beatKey: "nope" })).toThrow(ops.OpsError);
  });
});
