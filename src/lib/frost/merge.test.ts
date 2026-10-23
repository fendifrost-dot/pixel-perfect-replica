import { describe, expect, it } from "vitest";
import { keepView, mergeProjects } from "./merge";
import { cleanName, migrateProject } from "./persist";
import * as ops from "./ops";

const base = () => {
  let p = ops.newProject("Beat", 90);
  p = ops.addSource(p, {
    id: "src_a",
    name: "a.wav",
    durationSec: 10,
    sampleRate: 48000,
    channels: 2,
    origin: "imported",
    persistence: "device",
    detectedBpm: null,
  });
  p = ops.setChopMarkers(p, "src_a", [1, 2, 3]);
  return { ...p, isDemo: false };
};

describe("merging phone and assistant edits", () => {
  it("keeps both sides' changes", () => {
    const b = base();
    const local = ops.setChopMarkers(b, "src_a", []); // phone cleared the markers
    const remote = ops.addHits(ops.setProjectFields(b, { bpm: 120 }), undefined, [
      { pad: "A1", step: 0 },
    ]); // assistant: BPM + a hit
    const m = mergeProjects(b, local, remote);
    expect(m.markers["src_a"]).toEqual([]);
    expect(m.bpm).toBe(120);
    expect(m.patterns[0].notes).toHaveLength(1);
  });

  it("merges hits and pads item by item", () => {
    const b = ops.addHits(base(), undefined, [{ pad: "A1", step: 0 }]);
    const local = ops.addHits(b, undefined, [{ pad: "A2", step: 4 }]);
    const remote = ops.setPad(ops.addHits(b, undefined, [{ pad: "A3", step: 8 }]), "A5", {
      volume: 0.3,
    });
    const m = mergeProjects(b, local, remote);
    expect(m.patterns[0].notes.map((n) => n.padId).sort()).toEqual(["A1", "A2", "A3"]);
    expect(m.pads.find((x) => x.id === "A5")!.volume).toBe(0.3);
  });

  it("lets the phone win where both changed the same thing", () => {
    const b = base();
    const m = mergeProjects(
      b,
      ops.setProjectFields(b, { bpm: 100 }),
      ops.setProjectFields(b, { bpm: 140 }),
    );
    expect(m.bpm).toBe(100);
  });

  it("honours deletions from either side", () => {
    const b = ops.addHits(base(), undefined, [
      { pad: "A1", step: 0 },
      { pad: "A2", step: 4 },
    ]);
    const local = ops.removeHits(b, undefined, "A1");
    const remote = ops.removeHits(b, undefined, "A2");
    expect(mergeProjects(b, local, remote).patterns[0].notes).toHaveLength(0);
  });

  it("always keeps the phone's view (selection, open pad, bank)", () => {
    const b = base();
    const local = {
      ...b,
      selection: { sourceId: "src_a", start: 1, end: 2 },
      selectedPadId: "B3",
      bank: "B" as const,
    };
    const remote = {
      ...ops.setProjectFields(b, { bpm: 101 }),
      selection: null,
      selectedPadId: "A1",
    };
    const m = mergeProjects(b, local, remote);
    expect(m).toMatchObject({
      selection: { start: 1, end: 2 },
      selectedPadId: "B3",
      bank: "B",
      bpm: 101,
    });
    expect(keepView(local, remote)).toMatchObject({
      selection: { start: 1, end: 2 },
      selectedPadId: "B3",
      bpm: 101,
    });
  });
});

describe("names", () => {
  it("decodes web-encoded names", () => {
    expect(cleanName("Vivaldi%20Gelido%20in%20ogni%20vena%20(Winter)")).toBe(
      "Vivaldi Gelido in ogni vena (Winter)",
    );
    expect(cleanName("Track%2520One")).toBe("Track One");
    expect(cleanName("100% real")).toBe("100% real");
  });
  it("cleans names when a project is loaded", () => {
    const p = { ...base(), name: "My%20Beat" };
    p.sources[0].name = "a%20b.mp3";
    const m = migrateProject(p);
    expect(m.name).toBe("My Beat");
    expect(m.sources[0].name).toBe("a b.mp3");
  });
});
