import { describe, expect, it } from "vitest";
import { KITS, findDrum, kitSourceId, parseKitSourceId } from "./kits";
import { detectOnsets } from "./analysis";

describe("built-in kits", () => {
  const sr = 44100;
  it("every drum renders a non-silent, finite, peak-normalised hit of sensible length", () => {
    for (const kit of KITS)
      for (const d of kit.drums) {
        const x = d.render(sr);
        expect(x.length / sr, `${kit.id}/${d.id} length`).toBeGreaterThan(0.08);
        // drums are short hits; pitched instruments sustain so a held bass note can ring
        expect(x.length / sr, `${kit.id}/${d.id} length`).toBeLessThanOrEqual(d.rootMidi != null ? 3 : 1.6);
        let peak = 0,
          energy = 0;
        for (const v of x) {
          expect(Number.isFinite(v)).toBe(true);
          peak = Math.max(peak, Math.abs(v));
          energy += v * v;
        }
        expect(peak, `${kit.id}/${d.id} peak`).toBeGreaterThan(0.8);
        expect(peak, `${kit.id}/${d.id} peak`).toBeLessThanOrEqual(1);
        expect(energy / x.length, `${kit.id}/${d.id} energy`).toBeGreaterThan(1e-4);
        // ends silent (no click on a cut-off)
        expect(Math.abs(x[x.length - 1])).toBeLessThan(0.01);
      }
  }, 30_000); // renders every drum: slow under parallel test load

  it("renders deterministically, so a reopened project gets the same drum", () => {
    for (const kit of KITS)
      for (const d of kit.drums) {
        const a = d.render(sr),
          b = d.render(sr);
        expect(a).toEqual(b);
      }
  });

  it("every drum is one hit to the auto-chopper (no double markers, 808s included)", () => {
    for (const kit of KITS)
      for (const d of kit.drums) {
        const x = d.render(sr);
        const pad = new Float32Array(x.length + sr);
        pad.set(x, Math.round(0.2 * sr));
        const on = detectOnsets(pad, sr, 0, pad.length / sr, 0.8);
        expect(on, `${kit.id}/${d.id}`).toHaveLength(1);
        // a multi-burst clap marks at its loudest burst (≤ 35 ms in); everything else at the attack
        expect(Math.abs(on[0] - 0.2), `${kit.id}/${d.id} position`).toBeLessThan(d.id === "clap" ? 0.04 : 0.01);
      }
  });

  it("has unique ids and round-trips source ids", () => {
    const ids = new Set<string>();
    for (const kit of KITS)
      for (const d of kit.drums) {
        const id = kitSourceId(kit.id, d.id);
        expect(ids.has(id)).toBe(false);
        ids.add(id);
        expect(parseKitSourceId(id)).toEqual({ kitId: kit.id, drumId: d.id });
        expect(findDrum(kit.id, d.id)?.drum).toBe(d);
        expect(d.level).toBeGreaterThan(0.2);
        expect(d.level).toBeLessThanOrEqual(0.8);
      }
    expect(parseKitSourceId("src_abc123")).toBeNull();
    expect(findDrum("nope", "kick")).toBeNull();
  });

  it("renders at 48 kHz too, with the same duration", () => {
    const d = findDrum("trap808", "808c")!.drum;
    expect(d.render(48000).length / 48000).toBeCloseTo(d.render(44100).length / 44100, 2);
  });
});
