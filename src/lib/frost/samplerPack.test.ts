import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./demo";
import { KITS } from "./kits";
import { learnNote } from "./noteMap";
import {
  DRUM_BASE_NOTE,
  buildChopPack,
  buildSamplerPack,
  chopAssignments,
  isPitchedKit,
} from "./samplerPack";
import { emptyMidi } from "./types";
import { crc32 } from "./zip";
import { decodeWav } from "./wav";

/** Read a stored (uncompressed) zip back: name → bytes, checking each CRC. */
function unzip(z: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let e = z.length - 22;
  expect(v.getUint32(e, true)).toBe(0x06054b50);
  const count = v.getUint16(e + 10, true);
  let o = v.getUint32(e + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(o, true)).toBe(0x02014b50);
    const crc = v.getUint32(o + 16, true),
      size = v.getUint32(o + 20, true),
      nlen = v.getUint16(o + 28, true),
      at = v.getUint32(o + 42, true);
    const name = new TextDecoder().decode(z.subarray(o + 46, o + 46 + nlen));
    const lnlen = v.getUint16(at + 26, true);
    const data = z.subarray(at + 30 + lnlen, at + 30 + lnlen + size);
    expect(crc32(data), name).toBe(crc);
    out.set(name, data);
    o += 46 + nlen;
  }
  return out;
}

describe("sampler packs for the DAW", () => {
  it("packs the 808s as one mono, chromatic Decent Sampler preset each, WAVs carrying their root note", () => {
    const kit = KITS.find((k) => k.id === "metro808")!;
    expect(isPitchedKit(kit)).toBe(true);
    const { fileName, bytes } = buildSamplerPack(kit, 22050);
    expect(fileName).toBe("Frost_Metro-style_808s.zip");
    const files = unzip(bytes);
    const presets = [...files.keys()].filter((n) => n.endsWith(".dspreset"));
    const wavs = [...files.keys()].filter((n) => n.endsWith(".wav"));
    expect(presets).toHaveLength(30);
    expect(wavs).toHaveLength(30);
    expect(files.has("Frost Metro-style 808s/README.txt")).toBe(true);
    const first = new TextDecoder().decode(
      files.get("Frost Metro-style 808s/808 01 Long Clean.dspreset")!,
    );
    expect(first).toContain(
      '<sample path="Samples/808 01 Long Clean.wav" rootNote="24" loNote="0" hiNote="127"/>',
    );
    expect(first).toContain('silencedByTags="mono"');
    const w = decodeWav(files.get("Frost Metro-style 808s/Samples/808 01 Long Clean.wav")!);
    expect(w.rootMidi).toBe(24);
    expect(w.sampleRate).toBe(22050);
  }, 60_000);

  it("packs a drum kit as one preset with a sound per key from MIDI 36", () => {
    const kit = KITS.find((k) => k.id === "drekicks")!;
    expect(isPitchedKit(kit)).toBe(false);
    const files = unzip(buildSamplerPack(kit, 22050).bytes);
    const preset = new TextDecoder().decode(
      files.get("Frost Dre-style kicks/Dre-style kicks.dspreset")!,
    );
    expect(preset.match(/<sample /g)).toHaveLength(20);
    expect(preset).toContain(
      `rootNote="${DRUM_BASE_NOTE + 19}" loNote="${DRUM_BASE_NOTE + 19}" hiNote="${DRUM_BASE_NOTE + 19}"`,
    );
    expect(
      decodeWav(files.get("Frost Dre-style kicks/Samples/Kick 05 Low Boom.wav")!).rootMidi,
    ).toBe(DRUM_BASE_NOTE + 4);
    expect(new TextDecoder().decode(files.get("Frost Dre-style kicks/README.txt")!)).toContain(
      "Kick 20 West Coast",
    );
  }, 60_000);

  it("packs a project's chops on the shared note map, with stable paths and note numbers", () => {
    let p = createEmptyProject("Night");
    p = {
      ...p,
      slices: [{ id: "sl", sourceId: "s", name: "Kick & snare", start: 0, end: 1 }],
      pads: p.pads.map((pad) =>
        pad.id === "A1" ? { ...pad, sliceId: "sl", mode: "loop" as const } : pad,
      ),
      midi: learnNote(emptyMidi(), "A1", 72),
    };
    const hit = chopAssignments(p).find((a) => a.pad.id === "A1");
    expect(hit?.note).toBe(72);
    const { fileName, bytes } = buildChopPack({
      projectName: p.name,
      samples: [
        {
          padId: "A1",
          chopName: "Kick & snare",
          note: hit!.note,
          wav: new Uint8Array([1, 2, 3, 4]),
          release: 0.2,
          loop: true,
          frames: 48,
        },
      ],
    });
    expect(fileName).toBe("Frost_Night_Chops.zip");
    const files = unzip(bytes);
    expect(files.has("Frost Night/Samples/A1.wav")).toBe(true);
    expect(files.has("Frost Night/Chops.dspreset")).toBe(true);
    const preset = new TextDecoder().decode(files.get("Frost Night/Chops.dspreset")!);
    expect(preset).toContain('path="Samples/A1.wav"');
    expect(preset).toContain('rootNote="72" loNote="72" hiNote="72"');
    expect(preset).toContain('loopEnabled="1"');
    const readme = new TextDecoder().decode(files.get("Frost Night/README.txt")!);
    expect(readme).toContain("72  A1");
    expect(readme).not.toContain("C4");
    // A second export of a re-chopped A1 keeps the same preset and sample path.
    const again = buildChopPack({
      projectName: "Night",
      samples: [
        {
          padId: "A1",
          chopName: "New chop",
          note: 72,
          wav: new Uint8Array([9]),
          release: 30,
          loop: false,
          frames: 8,
        },
      ],
    });
    const files2 = unzip(again.bytes);
    expect(
      [...files2.keys()].filter((n) => n.endsWith(".dspreset") || n.endsWith(".wav")).sort(),
    ).toEqual(
      [...files.keys()].filter((n) => n.endsWith(".dspreset") || n.endsWith(".wav")).sort(),
    );
  });
});
