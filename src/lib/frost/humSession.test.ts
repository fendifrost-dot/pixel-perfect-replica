import { describe, expect, it } from "vitest";
import {
  clearSection,
  humLayers,
  setHumTempo,
  startHumSession,
  stepsForSeconds,
} from "./humSession";
import type { SourceAsset } from "./types";
import { patternMidi } from "./render";
import { kitSourceId } from "./kits";

const beat: SourceAsset = {
  id: "src_beat",
  name: "skeleton.wav",
  durationSec: 60, // 33.3 bars at 133.33 BPM
  sampleRate: 48000,
  channels: 2,
  origin: "imported",
  persistence: "device",
  detectedBpm: null,
};

describe("hum session", () => {
  it("puts the beat on a backing pad at bar 1, at the session's own tempo", () => {
    const p = startHumSession(beat, 133.33, { slice: "s1", note: "n1" });
    expect(p.bpm).toBe(133.33);
    expect(p.name).toBe("Hum · skeleton");
    const pat = p.patterns.find((x) => x.id === p.humSession!.patternId)!;
    expect(pat.lengthSteps).toBe(34 * 16); // 33.3 bars → 34 whole bars
    expect(pat.notes).toEqual([
      { id: "n1", padId: "D16", step: 0, velocity: 127, offset: 0, exact: true },
    ]);
    expect(p.pads.find((x) => x.id === "D16")).toMatchObject({
      sliceId: "s1",
      mode: "oneshot",
      lengthUnit: "off",
    });
    expect(humLayers(p)).toEqual([]);
  });

  it("follows a tempo change and clears just a section of chosen layers", () => {
    let p = startHumSession(beat, 132, { slice: "s1", note: "n1" });
    expect(p.patterns[0].lengthSteps).toBe(stepsForSeconds(60, 132));
    p = {
      ...p,
      pads: p.pads.map((x) => (x.id === "A1" || x.id === "A2" ? { ...x, sliceId: "s1" } : x)),
    };
    p = {
      ...p,
      patterns: p.patterns.map((pt) => ({
        ...pt,
        notes: [
          ...pt.notes,
          ...[0, 16, 32, 48].map((step, i) => ({
            id: `k${i}`,
            padId: "A1",
            step,
            velocity: 100,
            offset: 0,
          })),
          { id: "h", padId: "A2", step: 20, velocity: 100, offset: 0 },
        ],
      })),
    };
    expect(humLayers(p).map((x) => x.id)).toEqual(["A1", "A2"]);
    const cleared = clearSection(p, ["A1"], 16, 48);
    expect(cleared.patterns[0].notes.map((n) => n.id)).toEqual(["n1", "k0", "k3", "h"]);
    const faster = setHumTempo(p, 140);
    expect(faster.bpm).toBe(140);
    expect(faster.patterns[0].lengthSteps).toBe(stepsForSeconds(60, 140));
  });

  it("writes hummed parts as MIDI: kit drums on GM channel 10, an 808 line at its own notes", () => {
    let p = startHumSession(beat, 132, { slice: "s1", note: "n1" });
    p = {
      ...p,
      slices: [
        ...p.slices,
        { id: "k", sourceId: kitSourceId("westside", "kick"), name: "Kick", start: 0, end: 0.45 },
        {
          id: "b",
          sourceId: kitSourceId("instruments", "808"),
          name: "808 bass",
          start: 0,
          end: 1.4,
        },
      ],
      pads: p.pads.map((x) =>
        x.id === "A1" ? { ...x, sliceId: "k" } : x.id === "A2" ? { ...x, sliceId: "b" } : x,
      ),
      patterns: p.patterns.map((pt) => ({
        ...pt,
        notes: [
          ...pt.notes,
          { id: "k1", padId: "A1", step: 0, velocity: 110, offset: 0 },
          {
            id: "b1",
            padId: "A2",
            step: 4,
            velocity: 120,
            offset: 0,
            exact: true,
            length: 4,
            pitch: 9,
          },
        ],
      })),
    };
    const m = [...patternMidi(p, p.humSession!.patternId, ["A1", "A2"])];
    const has = (seq: number[]) => m.some((_, i) => seq.every((v, j) => m[i + j] === v));
    expect(has([0x99, 36, 110])).toBe(true); // kick → GM 36 on channel 10
    expect(has([0x90, 33, 120])).toBe(true); // 808 rooted at C1 (24) + 9 = A1 (33)
    expect(has([0x99, 33])).toBe(false);
  });
});
