import { describe, expect, it } from "vitest";
import { assignDrum, ensureLane, nextEmptyPad, pruneKitSources, type LoadedDrum } from "./kitActions";
import { createEmptyProject } from "./demo";
import { kitSourceId } from "./kits";

const drum = (kit: string, id: string): LoadedDrum => ({
  asset: { id: kitSourceId(kit, id), name: id, durationSec: 0.4, sampleRate: 44100, channels: 1, origin: "kit", persistence: "generated", detectedBpm: null },
  slice: { sourceId: kitSourceId(kit, id), name: id, start: 0, end: 0.4 },
  level: 0.45,
});

describe("kit actions", () => {
  it("fills pads in order and shares one source between pads using the same drum", () => {
    let p = { ...createEmptyProject(), isDemo: true };
    expect(nextEmptyPad(p, "A")?.id).toBe("A1");
    p = assignDrum(p, "A1", drum("westside", "kick"), "s1");
    p = assignDrum(p, nextEmptyPad(p, "A")!.id, drum("westside", "snare"), "s2");
    p = assignDrum(p, nextEmptyPad(p, "A")!.id, drum("westside", "kick"), "s3");
    expect(p.pads.filter((x) => x.sliceId).map((x) => x.id)).toEqual(["A1", "A2", "A3"]);
    expect(p.sources.map((s) => s.id)).toEqual([kitSourceId("westside", "kick"), kitSourceId("westside", "snare")]);
    expect(p.slices).toHaveLength(3);
    expect(p.selectedPadId).toBe("A3");
    expect(p.isDemo).toBe(false);
    expect(p.pads.find((x) => x.id === "A1")!.volume).toBe(0.45); // untouched pad takes the drum's level
  });

  it("resets chop-specific settings on the pad but keeps its mix role", () => {
    let p = createEmptyProject();
    p = { ...p, pads: p.pads.map((x) => (x.id === "B4" ? { ...x, reverse: true, pitch: -5, lengthUnit: "bars", volume: 0.3, pan: -0.5, choke: 2 } : x)) };
    p = assignDrum(p, "B4", drum("trap808", "808c"), "s1");
    const pad = p.pads.find((x) => x.id === "B4")!;
    expect(pad).toMatchObject({ sliceId: "s1", reverse: false, pitch: 0, lengthUnit: "off", mode: "oneshot", volume: 0.3, pan: -0.5, choke: 2 }); // mixed volume kept
  });

  it("gives the pad a lane in the current pattern once", () => {
    let p = assignDrum(createEmptyProject(), "A1", drum("westside", "kick"), "s1");
    p = ensureLane(ensureLane(p, "A1"), "A1");
    expect(p.patterns[0].lanes).toEqual([{ padId: "A1", mute: false, solo: false }]);
  });

  it("prunes kit sources and slices nothing uses, never recordings", () => {
    let p = createEmptyProject();
    p = { ...p, sources: [{ id: "src_x", name: "rec", durationSec: 10, sampleRate: 44100, channels: 2, origin: "imported", persistence: "device", detectedBpm: null }], slices: [{ id: "c1", sourceId: "src_x", name: "Chop", start: 0, end: 1 }] };
    p = assignDrum(p, "A1", drum("westside", "kick"), "s1");
    p = assignDrum(p, "A2", drum("westside", "kick"), "s2");
    p = { ...p, pads: p.pads.map((x) => (x.id === "A1" ? { ...x, sliceId: null } : x)) };
    const q = pruneKitSources(p);
    expect(q.slices.map((s) => s.id)).toEqual(["c1", "s2"]); // unassigned chop kept, unused drum slice dropped
    expect(q.sources.map((s) => s.id)).toEqual(["src_x", kitSourceId("westside", "kick")]);
    const r = pruneKitSources({ ...q, pads: q.pads.map((x) => (x.id === "A2" ? { ...x, sliceId: null } : x)) });
    expect(r.sources.map((s) => s.id)).toEqual(["src_x"]);
    expect(pruneKitSources(r)).toBe(r); // no change → same object
  });
});
