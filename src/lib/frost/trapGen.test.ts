import { describe, expect, it } from "vitest";
import { createEmptyProject, makePad } from "./demo";
import { assignDrum, type LoadedDrum } from "./kitActions";
import { findDrum, kitSourceId } from "./kits";
import { TICKS_PER_STEP } from "./midi";
import { patternMidi, planHits } from "./render";
import { applyRoll, rollCount, rollNotes } from "./roll";
import {
  FINE,
  effectiveStep,
  eventsInRange,
  onFine,
  patternSections,
  stepDur,
  toFine,
} from "./timing";
import {
  BACKING_PAD_ID,
  TRAP_KIT,
  TRAP_ROLES,
  TRAP_TAG,
  addTrapDrums,
  clearTrapDrums,
  generateTrapNotes,
  normaliseSections,
  planTrapPads,
  wholeSection,
  type TrapPads,
  type TrapRole,
} from "./trapGen";
import { MAX_NUDGE_MS, nudgeOf } from "./voice";
import type { NoteEvent, Project } from "./types";

let seq = 0;
const makeId = () => `n${++seq}`;
const drum = (role: TrapRole): LoadedDrum => {
  const id = kitSourceId(TRAP_KIT, TRAP_ROLES[role]);
  return {
    asset: {
      id,
      name: role,
      durationSec: 0.3,
      sampleRate: 44100,
      channels: 1,
      origin: "kit",
      persistence: "generated",
      detectedBpm: null,
    },
    slice: { sourceId: id, name: role, start: 0, end: 0.3 },
    level: 0.5,
  };
};
/** A 16-bar pattern with the trap drums on A1–A5 and one user hit. */
function fixture(bars = 16, bpm = 132): { p: Project; pads: TrapPads } {
  let p: Project = { ...createEmptyProject(), bpm };
  const pads = { hat: "A1", ohat: "A2", snare: "A3", clap: "A4", perc: "A5" } as TrapPads;
  for (const role of Object.keys(pads) as TrapRole[])
    p = assignDrum(p, pads[role], drum(role), `s_${role}`);
  p = {
    ...p,
    patterns: [
      {
        ...p.patterns[0],
        lengthSteps: bars * 16,
        notes: [{ id: "user1", padId: "A3", step: 4, velocity: 99, offset: 0 }],
      },
    ],
  };
  return { p, pads };
}

describe("fine grid (1/6 step): triplets and 1/32 together", () => {
  it("rounds onto the grid and recognises grid positions", () => {
    expect(toFine(0.3333)).toBeCloseTo(1 / 3, 9);
    expect(toFine(0.6667)).toBeCloseTo(2 / 3, 9);
    expect(toFine(0.5)).toBe(0.5);
    expect(onFine(5 + 1 / 3)).toBe(true);
    expect(onFine(5.4)).toBe(false);
  });

  it("swing leaves triplet and 1/32 hits where they are", () => {
    for (const step of [2 / 3, 1 / 3, 0.5, 4 + 2 / 3]) {
      const n = { step, offset: 0, exact: true };
      expect(effectiveStep(n, "1/16", 70, 16)).toBeCloseTo(step, 9);
    }
    // ...but an on-grid offbeat 16th still swings
    expect(effectiveStep({ step: 1, offset: 0, exact: true }, "1/16", 75, 16)).toBeCloseTo(1.5, 9);
  });

  it("places 1/24 and 1/48 hits at the exact sample at 120, 132 and 145 BPM", () => {
    for (const bpm of [120, 132, 145]) {
      for (const sr of [44100, 48000]) {
        const { p } = fixture(1, bpm);
        const notes: NoteEvent[] = [
          { id: "a", padId: "A1", step: 2 / 3, velocity: 100, offset: 0, exact: true },
          { id: "b", padId: "A1", step: 4 + 1 / 3, velocity: 100, offset: 0, exact: true },
          { id: "c", padId: "A1", step: 8.5, velocity: 100, offset: 0, exact: true },
        ];
        const q = { ...p, patterns: [{ ...p.patterns[0], notes }] };
        const { hits } = planHits(q, patternSections(q, 1));
        const sd = stepDur(bpm);
        // time is float-exact; the frame index may only differ at an exact half-sample tie
        const check = (t: number, steps: number) => {
          expect(t).toBeCloseTo(steps * sd, 12);
          const exact = steps * sd * sr;
          const tie = Math.abs(exact - Math.floor(exact) - 0.5) < 1e-6;
          expect(Math.abs(Math.round(t * sr) - Math.round(exact))).toBeLessThanOrEqual(tie ? 1 : 0);
        };
        check(hits.find((h) => h.noteId === "a")!.time, 2 / 3);
        check(hits.find((h) => h.noteId === "b")!.time, 4 + 1 / 3);
        check(hits.find((h) => h.noteId === "c")!.time, 8.5);
        // and eventsInRange (what live playback schedules) agrees
        const ev = eventsInRange(q, patternSections(q, 1), 0, 16, false);
        check(ev.find((h) => h.noteId === "a")!.at * sd, 2 / 3);
      }
    }
  });

  it("exports triplet hits to MIDI on exact ticks (and 1/32 too)", () => {
    expect(TICKS_PER_STEP % 6).toBe(0);
    const { p } = fixture(1);
    const notes: NoteEvent[] = [
      { id: "a", padId: "A1", step: 2 / 3, velocity: 100, offset: 0, exact: true },
      { id: "b", padId: "A1", step: 1 / 3, velocity: 100, offset: 0, exact: true },
      { id: "c", padId: "A1", step: 0.5, velocity: 100, offset: 0, exact: true },
    ];
    const q = { ...p, patterns: [{ ...p.patterns[0], notes }] };
    const bytes = patternMidi(q, q.patterns[0].id, ["A1"]);
    // read the drum track's note-on ticks back
    const ons: number[] = [];
    let o = 14;
    for (let t = 0; t < 2; t++) {
      const len = (bytes[o + 4] << 24) | (bytes[o + 5] << 16) | (bytes[o + 6] << 8) | bytes[o + 7];
      const end = o + 8 + len;
      o += 8;
      let tick = 0;
      while (o < end) {
        let d = 0;
        for (;;) {
          const c = bytes[o++];
          d = (d << 7) | (c & 0x7f);
          if (!(c & 0x80)) break;
        }
        tick += d;
        const st = bytes[o];
        if (st === 0xff) o += 3 + bytes[o + 2];
        else {
          if ((st & 0xf0) === 0x90 && bytes[o + 2] > 0) ons.push(tick);
          o += 3;
        }
      }
    }
    expect(ons.sort((a, b) => a - b)).toEqual([
      TICKS_PER_STEP / 3,
      TICKS_PER_STEP / 2,
      (TICKS_PER_STEP * 2) / 3,
    ]);
  });
});

describe("roll", () => {
  const base: NoteEvent = {
    id: "x",
    padId: "A1",
    step: 12,
    velocity: 100,
    offset: 0,
    exact: true,
    pitch: 2,
    gen: "trap",
  };
  it("replaces one hit with evenly spaced exact hits that end at the roll's length", () => {
    const out = rollNotes(base, {
      rate: 1 / 3,
      lengthSteps: 4,
      velocityRamp: "none",
      pitchRamp: 0,
      makeId,
    });
    expect(out).toHaveLength(rollCount(1 / 3, 4));
    expect(out).toHaveLength(12);
    out.forEach((n, i) => {
      expect(n.step).toBeCloseTo(12 + i / 3, 9);
      expect(onFine(n.step)).toBe(true);
      expect(n.length).toBeCloseTo(1 / 3, 9);
      expect(n.exact).toBe(true);
      expect(n.velocity).toBe(100);
      expect(n.pitch).toBe(2);
      expect(n.gen).toBe("trap");
      expect(n.padId).toBe("A1");
    });
    expect(out[0].id).toBe("x"); // the original keeps its id (stays selected)
    expect(new Set(out.map((n) => n.id)).size).toBe(12);
  });

  it("ramps velocity up or down and pitch across the roll", () => {
    const up = rollNotes(base, {
      rate: 0.5,
      lengthSteps: 2,
      velocityRamp: "up",
      pitchRamp: 12,
      makeId,
    });
    expect(up.map((n) => n.velocity)).toEqual([45, 63, 82, 100]);
    expect(up.map((n) => n.pitch)).toEqual([2, 6, 10, 14]);
    const down = rollNotes(base, {
      rate: 0.5,
      lengthSteps: 2,
      velocityRamp: "down",
      pitchRamp: -12,
      makeId,
    });
    expect(down.map((n) => n.velocity)).toEqual([100, 82, 63, 45]);
    expect(down.map((n) => n.pitch)).toEqual([2, -2, -6, -10]);
  });

  it("applyRoll leaves other notes untouched and keeps order", () => {
    const notes: NoteEvent[] = [
      { ...base, id: "p", step: 0 },
      base,
      { ...base, id: "q", step: 20 },
    ];
    const out = applyRoll(notes, "x", {
      rate: 2 / 3,
      lengthSteps: 2,
      velocityRamp: "none",
      pitchRamp: 0,
      makeId,
    });
    expect(out[0]).toBe(notes[0]);
    expect(out[out.length - 1]).toBe(notes[2]);
    expect(out).toHaveLength(2 + 3);
    expect(
      applyRoll(notes, "nope", {
        rate: 0.5,
        lengthSteps: 2,
        velocityRamp: "none",
        pitchRamp: 0,
        makeId,
      }),
    ).toBe(notes);
  });
});

describe("trap drum generator", () => {
  it("is deterministic for a seed and different for another", () => {
    const { pads } = fixture();
    const o = {
      sections: [{ startBar: 0, endBar: 16, offsetSteps: 0, density: "normal" as const }],
      pads,
      makeId: () => "id",
    };
    const a = generateTrapNotes(256, { ...o, seed: 7 });
    const b = generateTrapNotes(256, { ...o, seed: 7 });
    const c = generateTrapNotes(256, { ...o, seed: 8 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(100);
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it("writes only tagged exact notes on the fine grid, inside the pattern, with the expected roles", () => {
    const { pads } = fixture();
    const notes = generateTrapNotes(256, {
      sections: [wholeSection({ lengthSteps: 256 } as never, "busy")],
      seed: 3,
      pads,
      makeId,
    });
    for (const n of notes) {
      expect(n.gen).toBe(TRAP_TAG);
      expect(n.exact).toBe(true);
      expect(onFine(n.step)).toBe(true);
      expect(n.step).toBeGreaterThanOrEqual(0);
      expect(n.step).toBeLessThan(256);
      expect(n.velocity).toBeGreaterThanOrEqual(1);
      expect(n.velocity).toBeLessThanOrEqual(127);
      expect(Object.values(pads)).toContain(n.padId);
    }
    // snare + clap on beat 3 of every bar
    for (let bar = 0; bar < 16; bar++) {
      expect(notes.some((n) => n.padId === pads.snare && n.step === bar * 16 + 8)).toBe(true);
      expect(notes.some((n) => n.padId === pads.clap && n.step === bar * 16 + 8)).toBe(true);
    }
    // rolls exist: hats with triplet / 1/32 spacing and ramped velocity
    const rolled = notes.filter((n) => n.padId === pads.hat && n.length != null);
    expect(rolled.length).toBeGreaterThan(4);
    expect(
      rolled.some((n) => Math.abs(n.length! - 1 / 3) < 1e-9 || Math.abs(n.length! - 2 / 3) < 1e-9),
    ).toBe(true);
  });

  it("drops hats out of the first bar of each 8-bar section on normal / busy, not on sparse", () => {
    const { pads } = fixture();
    const hatsInBar = (density: "sparse" | "normal" | "busy", bar: number) =>
      generateTrapNotes(256, {
        sections: [{ startBar: 0, endBar: 16, offsetSteps: 0, density }],
        seed: 11,
        pads,
        makeId,
      }).filter((n) => n.padId === pads.hat && n.step >= bar * 16 && n.step < bar * 16 + 16).length;
    expect(hatsInBar("normal", 0)).toBe(0);
    expect(hatsInBar("normal", 8)).toBe(0);
    expect(hatsInBar("normal", 1)).toBeGreaterThan(4);
    expect(hatsInBar("busy", 0)).toBe(0);
    expect(hatsInBar("sparse", 0)).toBeGreaterThan(4);
  });

  it("places a section's hits shifted by its offset, skips skipped sections, and keeps sections apart", () => {
    const { pads } = fixture();
    const sections = [
      { startBar: 0, endBar: 4, offsetSteps: 0, density: "sparse" as const },
      { startBar: 4, endBar: 8, offsetSteps: 0, density: "sparse" as const, skip: true },
      { startBar: 8, endBar: 12, offsetSteps: 2, density: "sparse" as const },
      { startBar: 12, endBar: 16, offsetSteps: -1 / 3, density: "sparse" as const },
    ];
    const notes = generateTrapNotes(256, { sections, seed: 5, pads, makeId });
    expect(notes.some((n) => n.step >= 64 && n.step < 128)).toBe(false); // the interlude is silent
    // snares in the offset sections sit at beat 3 + offset
    for (let bar = 8; bar < 12; bar++)
      expect(
        notes.some((n) => n.padId === pads.snare && Math.abs(n.step - (bar * 16 + 10)) < 1e-9),
      ).toBe(true);
    for (let bar = 12; bar < 16; bar++)
      expect(
        notes.some(
          (n) => n.padId === pads.snare && Math.abs(n.step - (bar * 16 + 8 - 1 / 3)) < 1e-9,
        ),
      ).toBe(true);
    // a +2 offset shifts the hat grid onto the "&": the section's first hat sits at bar start + 2
    const firstHat = notes
      .filter((n) => n.padId === pads.hat && n.step >= 8 * 16)
      .map((n) => n.step)
      .sort((a, b) => a - b)[0];
    expect(firstHat).toBe(8 * 16 + 2);
  });

  it("offset sections land at the right sample at 132 BPM", () => {
    const { p, pads } = fixture(4, 132);
    const q = addTrapDrums(p, p.patterns[0].id, {
      sections: [{ startBar: 0, endBar: 4, offsetSteps: 2 + 1 / 3, density: "sparse" }],
      seed: 1,
      pads,
      makeId,
    });
    const { hits } = planHits(q, patternSections(q, 1));
    const sd = stepDur(132);
    const snare = hits.filter((h) => h.padId === pads.snare && h.noteId !== "user1");
    expect(snare.length).toBeGreaterThanOrEqual(3);
    for (const h of snare) {
      const bar = Math.floor(h.at / 16);
      expect(Math.round(h.time * 44100)).toBe(Math.round((bar * 16 + 8 + 2 + 1 / 3) * sd * 44100));
    }
  });

  it("normalises sections: clamps, orders, trims overlaps, fine-grid offsets", () => {
    const out = normaliseSections(
      [
        { startBar: 6, endBar: 20, offsetSteps: 9, density: "busy" },
        { startBar: -2, endBar: 8, offsetSteps: 0.3, density: "sparse" },
      ],
      16,
    );
    expect(out).toEqual([
      { startBar: 0, endBar: 8, offsetSteps: 1 / 3, density: "sparse" },
      { startBar: 8, endBar: 16, offsetSteps: 8, density: "busy" },
    ]);
  });

  it("adds to a pattern without touching user notes; regenerate replaces only its own; remove clears only its own", () => {
    const { p, pads } = fixture();
    const o = { sections: [wholeSection(p.patterns[0])], seed: 42, pads, makeId };
    const q = addTrapDrums(p, p.patterns[0].id, o);
    const user = q.patterns[0].notes.find((n) => n.id === "user1");
    expect(user).toEqual(p.patterns[0].notes[0]);
    expect(q.patterns[0].notes.filter((n) => n.gen === TRAP_TAG).length).toBeGreaterThan(50);
    // lanes added for the drum pads
    for (const id of Object.values(pads))
      expect(q.patterns[0].lanes.some((l) => l.padId === id)).toBe(true);
    // regenerate with another seed: user note kept, generated set replaced (no accumulation)
    const r = addTrapDrums(q, p.patterns[0].id, { ...o, seed: 43 });
    expect(r.patterns[0].notes.find((n) => n.id === "user1")).toEqual(user);
    const genQ = q.patterns[0].notes.filter((n) => n.gen === TRAP_TAG).length;
    const genR = r.patterns[0].notes.filter((n) => n.gen === TRAP_TAG).length;
    expect(Math.abs(genR - genQ)).toBeLessThan(genQ); // a fresh set, not twice the notes
    expect(r.patterns[0].notes.filter((n) => n.gen !== TRAP_TAG)).toEqual([user]);
    // other patterns untouched
    expect(p.patterns[0].notes).toHaveLength(1);
    const cleared = clearTrapDrums(r, p.patterns[0].id);
    expect(cleared.patterns[0].notes).toEqual([user]);
  });

  it("never uses the backing (song) pad and fills empty pads in order", () => {
    let p = createEmptyProject();
    // bank D: D16 is the song pad; everything else free
    const plan = planTrapPads(p, "D")!;
    expect(plan.toLoad.map((x) => x.padId)).toEqual(["D1", "D2", "D3", "D4", "D5"]);
    expect(Object.values(plan.pads)).not.toContain(BACKING_PAD_ID);
    // bank D with only D15 and D16 free → not enough room
    p = {
      ...p,
      pads: p.pads.map((x) => (x.bank === "D" && x.index < 14 ? { ...x, sliceId: "taken" } : x)),
    };
    expect(planTrapPads(p, "D")).toBeNull();
    // drums already on the bank are reused rather than duplicated
    let r = createEmptyProject();
    r = assignDrum(r, "B7", drum("snare"), "s1");
    const plan2 = planTrapPads(r, "B")!;
    expect(plan2.pads.snare).toBe("B7");
    expect(plan2.toLoad.map((x) => x.role)).toEqual(["hat", "ohat", "clap", "perc"]);
    expect(plan2.toLoad.map((x) => x.padId)).toEqual(["B1", "B2", "B3", "B4"]);
    // the roles exist in the kit
    for (const id of Object.values(TRAP_ROLES)) expect(findDrum(TRAP_KIT, id)).not.toBeNull();
  });
});

describe("song start nudge", () => {
  it("maps ms to a delay or a skip, clamped, and is zero by default", () => {
    const pad = makePad("D", 15);
    expect(nudgeOf(pad)).toEqual({ delay: 0, skip: 0 });
    expect(nudgeOf({ ...pad, nudgeMs: 120 })).toEqual({ delay: 0.12, skip: 0 });
    expect(nudgeOf({ ...pad, nudgeMs: -80 })).toEqual({ delay: 0, skip: 0.08 });
    expect(nudgeOf({ ...pad, nudgeMs: 9999 })).toEqual({ delay: MAX_NUDGE_MS / 1000, skip: 0 });
    expect(nudgeOf({ ...pad, nudgeMs: -9999 })).toEqual({ delay: 0, skip: MAX_NUDGE_MS / 1000 });
  });
  it("is applied by startVoice, which both live playback and offline render use (one code path)", async () => {
    const src = await import("./voice");
    const txt = src.startVoice.toString();
    expect(txt).toContain("nudgeOf(pad)");
  });
  it("fine step constant matches the generator's offset granularity", () => {
    expect(FINE).toBeCloseTo(1 / 6, 12);
  });
});
