/** 24-bit PCM WAV encode (for LUNA / Pro Tools) and decode (to verify exports). Pure, unit-tested. */

export interface EncodeResult {
  bytes: Uint8Array;
  /** Samples that exceeded full scale and were clamped. */
  clipped: number;
  /** Peak absolute sample value before clamping. */
  peak: number;
}

export function encodeWav24(channels: Float32Array[], sampleRate: number): EncodeResult {
  const nch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const blockAlign = nch * 3;
  const dataBytes = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 24, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  const out = new Uint8Array(buf);
  let o = 44;
  let clipped = 0;
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const x = channels[c][i];
      const a = Math.abs(x);
      if (a > peak) peak = a;
      let s = Math.round(x * 8388608);
      if (s > 8388607) {
        s = 8388607;
        clipped++;
      } else if (s < -8388608) {
        s = -8388608;
        clipped++;
      }
      out[o++] = s & 0xff;
      out[o++] = (s >> 8) & 0xff;
      out[o++] = (s >> 16) & 0xff;
    }
  }
  return { bytes: out, clipped, peak };
}

export interface DecodedWav {
  sampleRate: number;
  bitsPerSample: number;
  channels: Float32Array[];
}

/** Decodes 16/24-bit PCM and 32-bit float WAV. Enough to verify our own exports. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let pos = 12;
  let fmt: { format: number; nch: number; sr: number; bits: number } | null = null;
  let data: [number, number] | null = null;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = v.getUint32(pos + 4, true);
    if (id === "fmt ") {
      let format = v.getUint16(pos + 8, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(pos + 32, true);
      fmt = {
        format,
        nch: v.getUint16(pos + 10, true),
        sr: v.getUint32(pos + 12, true),
        bits: v.getUint16(pos + 22, true),
      };
    } else if (id === "data") data = [pos + 8, Math.min(size, bytes.length - pos - 8)];
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV missing fmt or data chunk");
  const bps = fmt.bits / 8;
  const frames = Math.floor(data[1] / (bps * fmt.nch));
  const channels = Array.from({ length: fmt.nch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.nch; c++) {
      const o = data[0] + (i * fmt.nch + c) * bps;
      let x: number;
      if (fmt.format === 3 && fmt.bits === 32) x = v.getFloat32(o, true);
      else if (fmt.format === 1 && fmt.bits === 24)
        x = (((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8) / 8388608;
      else if (fmt.format === 1 && fmt.bits === 16) x = v.getInt16(o, true) / 32768;
      else throw new Error(`Unsupported WAV format ${fmt.format}/${fmt.bits}-bit`);
      channels[c][i] = x;
    }
  }
  return { sampleRate: fmt.sr, bitsPerSample: fmt.bits, channels };
}
