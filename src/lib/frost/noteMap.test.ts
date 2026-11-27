import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./demo";
import { mergeProjects } from "./merge";
import {
  applyControl,
  bankPadIds,
  ccToPitch,
  forgetNote,
  learnCc,
  learnNext,
  learnNote,
  noteMap,
  padForMidiNote,
  recordedPosition,
  withRecordedHit,
} from "./noteMap";
import { parseMidiBytes } from "./midiIn";
import { migrateProject } from "./persist";
import { effectiveStep } from "./timing";
import { emptyMidi } from "./types";

describe("note map", () => {
  const pads = createEmptyProject().pads;

  it("hands note 36 upward in bank order, and a learned note is shared with lookup", () => {
    expect(noteMap(pads).slice(0, 3)).toEqual([
      { padId: "A1", note: 36 },
      { padId: "A2", note: 37 },
      { padId: "A3", note: 38 },
    ]);
    expect(noteMap(pads).find((m) => m.padId === "B1")?.note).toBe(52);
    const learned = learnNote(emptyMidi(), "A1", 72);
    expect(padForMidiNote(pads, learned.notes, 72)).toBe("A1");
    expect(noteMap(pads, learned.notes).find((m) => m.padId === "A1")?.note).toBe(72);
    // A1 left 36, and no other pad's default is 36.
    expect(padForMidiNote(pads, learned.notes, 36)).toBeNull();
    expect(padForMidiNote(pads, learned.notes, 37)).toBe("A2");
  });

  it("gives a learned note to the pad that just took it", () => {
    const map = learnNote(learnNote(emptyMidi(), "A1", 40), "B2", 40);
    expect(map.notes["A1"]).toBeUndefined();
    expect(map.notes["B2"]).toBe(40);
    expect(padForMidiNote(pads, map.notes, 40)).toBe("B2");
    expect(forgetNote(map, "B2").notes["B2"]).toBeUndefined();
  });

  it("learns a bank in order from the notes that arrive", () => {
    const ids = bankPadIds(pads, "A").slice(0, 3);
    let map = emptyMidi();
    let index = 0;
    for (const note of [12, 13, 14]) {
      const step = learnNext(map, ids, index, note);
      map = step.map;
      index = step.index;
      expect(step.padId).toBe(ids[index - 1]);
    }
    expect(index).toBe(3);
    expect(map.notes).toEqual({ A1: 12, A2: 13, A3: 14 });
    expect(learnNext(map, ids, index, 15).done).toBe(true);
  });

  it("learns one knob per target, on whatever channel it arrived", () => {
    let map = learnCc(emptyMidi(), { cc: 70, channel: 2, target: "volume" });
    map = learnCc(map, { cc: 71, channel: 10, target: "volume" });
    map = learnCc(map, { cc: 1, channel: 1, target: "pitch" });
    expect(map.ccs).toEqual([
      { cc: 71, channel: 10, target: "volume" },
      { cc: 1, channel: 1, target: "pitch" },
    ]);
  });

  it("maps a knob onto pitch, volume, and the chop edges", () => {
    expect(ccToPitch(0)).toBe(-24);
    expect(ccToPitch(64)).toBe(0);
    expect(ccToPitch(127)).toBe(24);
    let p = createEmptyProject();
    p = {
      ...p,
      selectedPadId: "A1",
      sources: [
        {
          id: "s",
          name: "a.wav",
          durationSec: 2,
          sampleRate: 48000,
          channels: 1,
          origin: "imported",
          persistence: "device",
          detectedBpm: null,
        },
      ],
      slices: [{ id: "sl", sourceId: "s", name: "chop", start: 0, end: 2 }],
      pads: p.pads.map((pad) => (pad.id === "A1" ? { ...pad, sliceId: "sl", pitch: 0 } : pad)),
    };
    expect(applyControl(p, "pitch", 127).pads.find((x) => x.id === "A1")?.pitch).toBe(24);
    expect(applyControl(p, "volume", 0).pads.find((x) => x.id === "A1")?.volume).toBe(0);
    const edged = applyControl(p, "start", 127);
    expect(edged.slices[0]?.start).toBeCloseTo(1.98);
    expect(edged.slices[0]?.end).toBe(2);
    const tail = applyControl(p, "end", 0);
    expect(tail.slices[0]?.start).toBe(0);
    expect(tail.slices[0]?.end).toBeCloseTo(0.02);
    expect(applyControl(p, "pitch", 64)).toBe(p);
  });

  it("writes a quantized hit, and the project from before the hit is the undo", () => {
    const p = { ...createEmptyProject(), quantize: "1/16" as const };
    const next = withRecordedHit(p, "A3", 90, 4.4, "hit1");
    expect(p.patterns[0]?.notes).toHaveLength(0);
    expect(next.patterns[0]?.notes[0]).toMatchObject({
      padId: "A3",
      step: 4,
      offset: 0,
      velocity: 90,
    });
    const note = next.patterns[0]!.notes[0]!;
    expect(effectiveStep(note, next.quantize, next.swing, next.patterns[0]!.lengthSteps)).toBe(4);

    const loose = { ...createEmptyProject(), quantize: "off" as const };
    expect(recordedPosition("off", 32, 4.4)).toEqual({ step: 4, offset: 0.4 });
    expect(withRecordedHit(loose, "A1", 100, 4.4, "h").patterns[0]?.notes[0]?.offset).toBe(0.4);
    expect(recordedPosition("1/8", 32, 5.1)).toEqual({ step: 6, offset: 0 });
    expect(recordedPosition("1/32", 32, 4.4).step).toBe(4.5);
  });

  it("keeps a saved map through migrate, and merges note and knob edits from both sides", () => {
    const raw = createEmptyProject() as unknown as Record<string, unknown>;
    delete raw["midi"];
    raw["schemaVersion"] = 2;
    const migrated = migrateProject(raw);
    expect(migrated.midi).toEqual({ notes: {}, ccs: [] });

    const dirty = migrateProject({
      ...createEmptyProject(),
      midi: {
        notes: { A1: 200, A2: 40 },
        ccs: [
          { cc: 7, channel: 1, target: "volume" },
          { cc: 8, channel: 1, target: "volume" },
          { cc: 3, channel: 0, target: "pitch" },
        ],
      },
    });
    expect(dirty.midi).toEqual({
      notes: { A2: 40 },
      ccs: [{ cc: 7, channel: 1, target: "volume" }],
    });

    const base = createEmptyProject();
    const local = { ...base, midi: learnNote(emptyMidi(), "A1", 60) };
    const remote = { ...base, midi: learnCc(emptyMidi(), { cc: 74, channel: 3, target: "start" }) };
    const merged = mergeProjects(base, local, remote);
    expect(merged.midi?.notes["A1"]).toBe(60);
    expect(merged.midi?.ccs).toEqual([{ cc: 74, channel: 3, target: "start" }]);
  });
});

describe("MIDI bytes", () => {
  it("reads notes and CCs on every channel, including a zero-velocity note-on", () => {
    const data = new Uint8Array([
      0x90,
      36,
      100, // ch 1 note on
      0x80,
      36,
      0, // ch 1 note off
      0x99,
      40,
      0, // ch 10 note-on velocity 0 = note off
      0xbf,
      74,
      20, // ch 16 CC
      0xf8, // clock, ignored
      0x91,
      12,
      64,
    ]);
    expect(parseMidiBytes(data, "in", "Controller")).toEqual([
      {
        kind: "noteon",
        channel: 1,
        number: 36,
        value: 100,
        inputId: "in",
        inputName: "Controller",
      },
      { kind: "noteoff", channel: 1, number: 36, value: 0, inputId: "in", inputName: "Controller" },
      {
        kind: "noteoff",
        channel: 10,
        number: 40,
        value: 0,
        inputId: "in",
        inputName: "Controller",
      },
      { kind: "cc", channel: 16, number: 74, value: 20, inputId: "in", inputName: "Controller" },
      { kind: "noteon", channel: 2, number: 12, value: 64, inputId: "in", inputName: "Controller" },
    ]);
  });
});
