import { describe, expect, it } from "vitest";
import {
  effectiveStep,
  eventsInRange,
  holdEnds,
  patternSections,
  playPlan,
  recordPosition,
  regionPattern,
  soundingAt,
  songSections,
  stepDur,
} from "./timing";
import { decodeWav, encodeWav24 } from "./wav";
import { padSampleName, planHits } from "./render";
import { boundaries, detectOnsets, firstAudible, generateBeatGrid, moveBeat, suggestTempo } from "./analysis";
import { stretchLength, wsola } from "./stretch";
import { createDemoProject, makePad } from "./demo";
import { migrateProject } from "./persist";
import type { Pad, Slice } from "./types";

describe("timing", () => {
  it("leaves on-grid hits alone at 50% swing", () => {
    expect(effectiveStep({ step: 3, offset: 0 }, "1/16", 50, 16)).toBe(3);
  });

  it("quantizes the played position without touching the note", () => {
    const note = { step: 4, offset: 0.3 };
    expect(effectiveStep(note, "1/16", 50, 16)).toBe(4);
    expect(effectiveStep(note, "off", 50, 16)).toBeCloseTo(4.3);
    expect(effectiveStep(note, "1/8", 50, 16)).toBe(4);
    expect(effectiveStep({ step: 5, offset: 0.2 }, "1/8", 50, 16)).toBe(6);
    expect(note.offset).toBe(0.3);
  });

  it("applies MPC-style swing to off-beats only", () => {
    // 66% swing: off-beat 16th lands 0.32 of a step late
    expect(effectiveStep({ step: 1, offset: 0 }, "1/16", 66, 16)).toBeCloseTo(1.32);
    expect(effectiveStep({ step: 2, offset: 0 }, "1/16", 66, 16)).toBe(2);
    // 1/8 grid swings odd eighths (steps 2, 6, ...) by a fraction of an eighth
    expect(effectiveStep({ step: 2, offset: 0 }, "1/8", 75, 16)).toBeCloseTo(3);
  });

  it("keeps unquantized played timing out of swing", () => {
    expect(effectiveStep({ step: 1, offset: 0.12 }, "off", 70, 16)).toBeCloseTo(1.12);
  });

  it("wraps hits quantized past the loop end", () => {
    expect(effectiveStep({ step: 15, offset: 0.49 }, "1/8", 50, 16)).toBe(0);
  });

  it("leaves Timeline hits (exact, 1/32) where they were put", () => {
    expect(effectiveStep({ step: 3.5, offset: 0, exact: true }, "1/16", 50, 16)).toBe(3.5);
    expect(effectiveStep({ step: 3.5, offset: 0 }, "1/16", 50, 16)).toBe(4);
  });

  it("carries a hit's own length into the schedule and the export plan", () => {
    const p = createDemoProject();
    const pat = p.patterns.find((x) => x.id === p.currentPatternId)!;
    const n = pat.notes[0];
    n.length = 0.5;
    const hit = eventsInRange(p, patternSections(p, 1), 0, pat.lengthSteps, false).find((h) => h.noteId === n.id)!;
    expect(hit.length).toBe(0.5);
    const planned = planHits(p, patternSections(p, 1)).hits.find((h) => h.noteId === n.id)!;
    expect(planned.stopAt).toBeCloseTo((hit.at + 0.5) * stepDur(p.bpm));
  });

  it("records taps as step + offset", () => {
    expect(recordPosition(6.27, 16)).toEqual({ step: 6, offset: 0.27 });
    expect(recordPosition(6.8, 16)).toEqual({ step: 7, offset: -0.2 });
    expect(recordPosition(15.7, 16).step).toBe(0);
  });

  it("schedules the same hits for live loop windows and a one-shot export range", () => {
    const p = createDemoProject();
    const secs = patternSections(p, 4);
    const all = eventsInRange(p, secs, 0, 64, false);
    const pieces = [0, 7.3, 16, 33.1, 50, 64];
    const live = pieces
      .slice(0, -1)
      .flatMap((a, i) => eventsInRange(p, patternSections(p, 1), a, pieces[i + 1], true));
    expect(live.map((h) => [h.padId, h.at])).toEqual(all.map((h) => [h.padId, h.at]));
  });

  it("respects mute and solo", () => {
    const p = createDemoProject();
    const pat = p.patterns[0];
    pat.lanes = pat.lanes.map((l) => ({ ...l, solo: l.padId === "A2" }));
    const hits = eventsInRange(p, patternSections(p, 1), 0, 16, false);
    expect(new Set(hits.map((h) => h.padId))).toEqual(new Set(["A2"]));
  });

  it("lays out the song in arrangement order", () => {
    const p = createDemoProject();
    const s = songSections(p);
    expect(s.map((x) => [x.pattern.id, x.startStep])).toEqual([
      ["p2", 0],
      ["p1", 16],
      ["p1", 32],
    ]);
  });

  it("holds gate hits until the next hit on the same pad", () => {
    const hits = [
      { noteId: "a", padId: "A1", velocity: 100, at: 0 },
      { noteId: "b", padId: "A2", velocity: 100, at: 2 },
      { noteId: "c", padId: "A1", velocity: 100, at: 4 },
    ];
    const ends = holdEnds(hits, 16);
    expect(ends.get("a@0")).toBe(4);
    expect(ends.get("c@4")).toBe(16);
    expect(ends.get("b@2")).toBe(16);
  });

  it("step duration is a 16th note", () => {
    expect(stepDur(120)).toBeCloseTo(0.125);
  });
});

describe("fit to musical length", () => {
  const slice: Slice = { id: "s", sourceId: "x", name: "s", start: 1, end: 3 }; // 2 s
  const pad = (patch: Partial<Pad>): Pad => ({ ...makePad("A", 0), ...patch });

  it("classic pitch with no length", () => {
    const pl = playPlan(pad({ pitch: 12 }), slice, 120);
    expect(pl.rate).toBeCloseTo(2);
    expect(pl.duration).toBeCloseTo(1);
    expect(pl.stretch).toBeNull();
  });

  it("repitch fills the length by changing speed", () => {
    const pl = playPlan(
      pad({ lengthUnit: "bars", lengthValue: 1, timeMode: "repitch" }),
      slice,
      120,
    ); // 1 bar = 2 s
    expect(pl.rate).toBeCloseTo(1);
    const pl2 = playPlan(
      pad({ lengthUnit: "beats", lengthValue: 2, timeMode: "repitch" }),
      slice,
      120,
    ); // 1 s
    expect(pl2.rate).toBeCloseTo(2);
    expect(pl2.pitchSemis).toBeCloseTo(12);
  });

  it("stretch keeps pitch and lets the pitch knob transpose without changing length", () => {
    const pl = playPlan(
      pad({ lengthUnit: "beats", lengthValue: 2, timeMode: "stretch" }),
      slice,
      120,
    );
    expect(pl.rate).toBe(1);
    expect(pl.stretch).toBeCloseTo(0.5);
    expect(pl.duration).toBeCloseTo(1);
    const up = playPlan(
      pad({ lengthUnit: "beats", lengthValue: 2, timeMode: "stretch", pitch: 12 }),
      slice,
      120,
    );
    expect(up.rate).toBeCloseTo(2);
    expect((2 * up.stretch!) / up.rate).toBeCloseTo(1); // played length still 1 s
  });
});

describe("wav", () => {
  it("round-trips 24-bit stereo exactly to 24-bit precision", () => {
    const l = Float32Array.from([0, 0.5, -0.5, 0.999, -1, 1e-7]);
    const r = Float32Array.from([1.5, -2, 0.25, 0, 0.1, -0.1]);
    const enc = encodeWav24([l, r], 48000);
    expect(enc.clipped).toBe(2);
    expect(enc.bytes.length).toBe(44 + 6 * 6);
    const dec = decodeWav(enc.bytes);
    expect(dec.sampleRate).toBe(48000);
    expect(dec.bitsPerSample).toBe(24);
    for (let i = 0; i < 6; i++)
      expect(Math.abs(dec.channels[0][i] - l[i])).toBeLessThan(1.5 / 8388608);
    expect(dec.channels[1][0]).toBeCloseTo(8388607 / 8388608, 7);
    expect(dec.channels[1][1]).toBe(-1);
  });
});

describe("analysis", () => {
  const sr = 48000;
  const clicks = (times: number[], dur: number) => {
    const x = new Float32Array(Math.round(dur * sr));
    for (const t of times) {
      const s = Math.round(t * sr);
      for (let i = 0; i < 2000 && s + i < x.length; i++)
        x[s + i] += Math.exp(-i / 300) * Math.sin(i * 0.9) * 0.8;
    }
    return x;
  };

  it("finds transients within a couple of milliseconds", () => {
    const times = [0.25, 0.71, 1.2, 1.9];
    const found = detectOnsets(clicks(times, 2.5), sr, 0, 2.5, 0.5);
    expect(found).toHaveLength(times.length);
    found.forEach((f, i) => {
      expect(f).toBeLessThanOrEqual(times[i] + 0.0005);
      expect(times[i] - f).toBeLessThan(0.003);
    });
  });

  it("finds slow swells (bowed strings, voices), not only sharp hits", () => {
    // Sustained tone whose level swells over 80 ms at each note entry, with a short rest between notes.
    const x = new Float32Array(Math.round(3 * sr));
    const entries = [0.3, 1.1, 1.9];
    for (const t of entries) {
      const s = Math.round(t * sr);
      const len = Math.round(0.6 * sr);
      for (let i = 0; i < len && s + i < x.length; i++) {
        const env = Math.min(1, i / (0.08 * sr)) * (1 - i / len);
        x[s + i] += 0.5 * env * (Math.sin((2 * Math.PI * 440 * i) / sr) + 0.3 * Math.sin((2 * Math.PI * 1320 * i) / sr));
      }
    }
    const found = detectOnsets(x, sr, 0, 3, 0.5);
    expect(found).toHaveLength(entries.length);
    found.forEach((f, i) => {
      expect(f).toBeGreaterThanOrEqual(entries[i] - 0.005);
      expect(f - entries[i]).toBeLessThan(0.09);
    });
  });

  it("does not mark every cycle of a clipped 808", () => {
    // Hard-clipped 37 Hz sub, 1 s long, hit at 0.3 s: its waveform corners pulse HF energy twice per cycle.
    const x = new Float32Array(Math.round(2 * sr));
    const s0 = Math.round(0.3 * sr);
    for (let i = 0; s0 + i < x.length && i < sr; i++) {
      const v = Math.sin((2 * Math.PI * 37 * i) / sr) * 4 * Math.exp(-i / (0.5 * sr));
      x[s0 + i] = Math.max(-0.9, Math.min(0.9, v));
    }
    const found = detectOnsets(x, sr, 0, 2, 0.8);
    expect(found).toHaveLength(1);
    expect(Math.abs(found[0] - 0.3)).toBeLessThan(0.01);
  });

  it("does not split one hit's decay into several markers", () => {
    const found = detectOnsets(clicks([0.5], 1.5), sr, 0, 1.5, 0.9);
    expect(found).toHaveLength(1);
  });

  it("locates where a recording becomes audible", () => {
    const x = new Float32Array(sr);
    expect(firstAudible(x, sr)).toBe(0);
    for (let i = Math.round(0.4 * sr); i < x.length; i++) x[i] = 0.3 * Math.sin(i * 0.05);
    expect(firstAudible(x, sr)).toBeCloseTo(0.4, 2);
    for (let i = 0; i < Math.round(0.4 * sr); i++) x[i] = 0.001; // -60 dBFS hiss is not "audible"
    expect(firstAudible(x, sr)).toBeCloseTo(0.4, 2);
  });

  it("suggests the tempo of a steady pulse", () => {
    const bpm = 96;
    const times = Array.from({ length: 48 }, (_, i) => 0.1 + (i * 60) / bpm);
    const s = suggestTempo(clicks(times, 32), sr);
    expect(s).not.toBeNull();
    expect(Math.abs(s!.bpm - bpm)).toBeLessThan(1.5);
  });

  it("generates and edits beat markers", () => {
    const g = generateBeatGrid(120, 0.1, 2.2);
    expect(g.beats).toEqual([0.1, 0.6, 1.1, 1.6, 2.1]);
    const m = moveBeat(g, 2, 5);
    expect(m.beats[2]).toBeCloseTo(1.599);
    expect(g.beats[2]).toBe(1.1);
  });

  it("builds slice boundaries", () => {
    expect(boundaries([0.5, 0.2, 3, 0.505], 0, 1)).toEqual([0, 0.2, 0.5, 1]);
  });
});

describe("stretch", () => {
  it("produces an exact length and keeps the pitch", () => {
    const sr = 48000;
    const n = sr; // 1 s of 440 Hz
    const x = Float32Array.from(
      { length: n },
      (_, i) => Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5,
    );
    for (const ratio of [0.5, 0.8, 1.25, 2]) {
      const [y] = wsola([x], ratio);
      expect(y.length).toBe(stretchLength(n, ratio));
      // zero-crossing rate in the steady middle stays ~ 880 per second
      let zc = 0;
      const a = Math.floor(y.length * 0.2),
        b = Math.floor(y.length * 0.8);
      for (let i = a + 1; i < b; i++) if (y[i - 1] < 0 !== y[i] < 0) zc++;
      const hz = zc / 2 / ((b - a) / sr);
      expect(Math.abs(hz - 440)).toBeLessThan(15);
    }
  });

  it("copies the opening transient untouched", () => {
    const x = Float32Array.from({ length: 20000 }, (_, i) => (i < 100 ? 0.9 : 0.01 * Math.sin(i)));
    const [y] = wsola([x], 1.5);
    for (let i = 0; i < 100; i++) expect(y[i]).toBeCloseTo(0.9, 5);
  });
});

describe("project migration", () => {
  it("upgrades a schema 1 project", () => {
    const p = createDemoProject() as unknown as Record<string, unknown>;
    p["schemaVersion"] = 1;
    delete p["beatGrids"];
    const m = migrateProject(p);
    expect(m.schemaVersion).toBe(2);
    expect(m.beatGrids).toEqual({});
  });

  it("rejects unknown versions", () => {
    expect(() => migrateProject({ schemaVersion: 99 })).toThrow();
  });
});

describe("pad sample export", () => {
  it("names each sample by pad and chop, with its musical length when fitted", () => {
    const p = { ...createDemoProject(), name: "My beat", bpm: 132 };
    const pad = { ...makePad("A", 12), lengthUnit: "bars" as const, lengthValue: 2, timeMode: "stretch" as const };
    expect(padSampleName(p, pad, "Chop 12", "pad")).toBe("My_beat_A13_Chop_12_8beats_132bpm.wav");
    expect(padSampleName(p, pad, "Chop 12", "original")).toBe("My_beat_A13_Chop_12_original.wav");
    expect(padSampleName(p, { ...pad, lengthUnit: "off" }, "Kick", "pad")).toBe("My_beat_A13_Kick.wav");
  });
});

describe("playing a section", () => {
  it("cuts a section out of a pattern and finds long sounds to join part-way", () => {
    const p = createDemoProject();
    const pad = p.pads.find((x) => x.sliceId)!;
    const slice = p.slices.find((x) => x.id === pad.sliceId)!;
    // a long one-shot at step 0 (like a whole beat bounced from a DAW) plus two short hits
    const longSlice = { ...slice, id: "long", start: 0, end: 30 };
    const q = {
      ...p,
      quantize: "off" as const,
      slices: [...p.slices, longSlice],
      pads: p.pads.map((x) => (x.id === pad.id ? { ...x, sliceId: "long", lengthUnit: "off" as const, pitch: 0, mode: "oneshot" as const } : x)),
      patterns: p.patterns.map((pt) =>
        pt.id === p.currentPatternId
          ? { ...pt, lengthSteps: 64, notes: [
              { id: "bed", padId: pad.id, step: 0, velocity: 100, offset: 0 },
              { id: "a", padId: "A2", step: 20, velocity: 100, offset: 0 },
              { id: "b", padId: "A2", step: 40, velocity: 100, offset: 0 },
            ] }
          : pt,
      ),
    };
    const pat = q.patterns.find((x) => x.id === q.currentPatternId)!;
    const r = regionPattern(q, pat, 16, 32);
    expect(r.lengthSteps).toBe(16);
    expect(r.notes.map((n) => [n.id, n.step])).toEqual([["a", 4]]);
    // the 30 s bed started at step 0 is still sounding at step 16 → join it 16 steps in
    expect(soundingAt(q, pat, 16)).toEqual([{ note: pat.notes[0], skip: 16 }]);
    expect(soundingAt(q, pat, 0)).toEqual([]);
  });
});

describe("wav tempo tag", () => {
  it("writes and reads back an ACID tempo chunk (also on an odd-length mono file)", () => {
    const loop = encodeWav24([new Float32Array(48001).fill(0.1)], 48000, { bpm: 132, beats: 8 });
    expect(decodeWav(loop.bytes).tempo).toMatchObject({ beats: 8, oneShot: false });
    expect(decodeWav(loop.bytes).tempo!.bpm).toBeCloseTo(132);
    expect(decodeWav(loop.bytes).channels[0].length).toBe(48001);
    const hit = encodeWav24([new Float32Array(100), new Float32Array(100)], 48000, { bpm: 132, oneShot: true });
    expect(decodeWav(hit.bytes).tempo).toMatchObject({ oneShot: true });
    expect(decodeWav(encodeWav24([new Float32Array(10)], 48000).bytes).tempo).toBeUndefined();
  });
});
