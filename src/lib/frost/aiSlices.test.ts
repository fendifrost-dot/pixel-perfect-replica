import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./demo";
import { applyAiSlices, validateAiSlices } from "./aiSlices";

describe("AI slice suggestions", () => {
  it("keeps validated chops when the model omits the narrative", () => {
    expect(validateAiSlices({ slices: [{ start: 0, end: 0.3, label: "Kick", pad: 1, reason: "Attack" }] }, 1, [1]).slices).toHaveLength(1);
  });
  it("rejects times outside the audio and duplicate or unavailable pad assignments", () => {
    const slice = { start: 0, end: 0.5, label: "Kick", pad: 1, reason: "Clean onset" };
    const result = validateAiSlices({ summary: "Drums", slices: [slice, { ...slice, start: -1 }, { ...slice, end: 3, pad: 2 }, { ...slice, pad: 3 }, { ...slice, start: 0.6, end: 1 }] }, 2, [1, 2]);
    expect(result.slices).toEqual([slice]);
  });
  it("does not overwrite an occupied pad or partially apply a bad set", () => {
    const project = createEmptyProject();
    project.sources = [{ id: "src", name: "Audio", durationSec: 2, sampleRate: 48000, channels: 1, origin: "imported", persistence: "device", detectedBpm: null }];
    project.pads[0].sliceId = "existing";
    expect(() => applyAiSlices(project, "src", [{ padId: "A2", start: 0, end: 1, label: "Snare" }, { padId: "A1", start: 1, end: 2, label: "Kick" }], () => "new")).toThrow("empty pad");
    expect(project.slices).toEqual([]);
    expect(project.pads[0].sliceId).toBe("existing");
    expect(project.pads[1].sliceId).toBeNull();
  });
  it("adds real source-referenced slices and preserves original slices, notes and audio metadata", () => {
    const project = createEmptyProject();
    project.sources = [{ id: "src", name: "Audio", durationSec: 2, sampleRate: 48000, channels: 1, origin: "imported", persistence: "device", detectedBpm: null }];
    const next = applyAiSlices(project, "src", [{ padId: "A1", start: 0.25, end: 0.75, label: "Kick" }], () => "new");
    expect(next.slices).toEqual([{ id: "new", sourceId: "src", name: "Kick", start: 0.25, end: 0.75 }]);
    expect(next.pads[0].sliceId).toBe("new");
    expect(next.sources).toBe(project.sources);
    expect(next.patterns).toBe(project.patterns);
    expect(project.slices).toEqual([]);
  });
});