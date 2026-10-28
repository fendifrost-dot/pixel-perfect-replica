import { describe, expect, it } from "vitest";
import { KITS, findDrum, kitSourceId, parseKitSourceId } from "./kits";
import { detectOnsets } from "./analysis";
import { detectPitch } from "./key";

describe("built-in kits", () => {
  const sr = 44100;
  it("every drum renders a non-silent, finite, peak-normalised hit of sensible length", () => {
    for (const kit of KITS)
      for (const d of kit.drums) {
        const x = d.render(sr);
        expect(x.length / sr, `${kit.id}/${d.id} length`).toBeGreaterThan(0.08);
        // drums are short hits; pitched instruments sustain so a held bass note can ring
        expect(x.length / sr, `${kit.id}/${d.id} length`).toBeLessThanOrEqual(
          d.rootMidi != null || kit.id === "metrodrums" ? 3 : 1.6,
        ); // instruments and cymbals/swells ring longer
        let peak = 0,
          energy = 0,
          finite = true;
        for (const v of x) {
          finite &&= Number.isFinite(v);
          peak = Math.max(peak, Math.abs(v));
          energy += v * v;
        }
        // one assertion per drum (not per sample): the same check, fast enough for 100 drums
        expect(finite, `${kit.id}/${d.id} finite`).toBe(true);
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
        // compared sample by sample (a deep-equal of long arrays is very slow), still exact
        expect(b.length, `${kit.id}/${d.id}`).toBe(a.length);
        expect(
          a.findIndex((v, i) => !Object.is(v, b[i])),
          `${kit.id}/${d.id} first difference`,
        ).toBe(-1);
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
        // a multi-burst clap marks at its loudest burst (≤ 50 ms in); a reverse cymbal swells for most of
        // its length, so it marks where the swell crests; everything else marks at the attack
        const slack =
          d.id.startsWith("cl") ||
          d.id.startsWith("snr") ||
          d.id === "crash" ||
          d.id === "stut" ||
          kit.id === "keem808"
            ? 0.05 // multi-burst claps and square/clipped 808 attacks crest a few hops in
            : d.id === "revcym"
              ? 2
              : 0.02;
        expect(Math.abs(on[0] - 0.2), `${kit.id}/${d.id} position`).toBeLessThan(slack);
      }
  });

  it("every Metro-style 808 really sounds at its root note (C1), so a sampler maps it right", () => {
    const kit = KITS.find((k) => k.id === "metro808")!;
    expect(kit.drums).toHaveLength(30);
    expect(KITS.find((k) => k.id === "drekicks")!.drums).toHaveLength(20);
    for (const d of kit.drums) {
      const p = detectPitch(d.render(sr), sr);
      expect(p, d.id).not.toBeNull();
      expect(Math.abs(p! - d.rootMidi!), `${d.id} pitch`).toBeLessThan(0.6);
    }
  }, 60_000);

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
