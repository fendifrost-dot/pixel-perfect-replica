import { describe, expect, it } from "vitest";
import { KITS } from "./kits";
import { DRUM_BASE_NOTE, buildSamplerPack, isPitchedKit } from "./samplerPack";
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
});
