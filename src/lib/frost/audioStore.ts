/**
 * Non-React storage for audio buffers and waveform peaks.
 * Buffers must never live in React state.
 */
const buffers = new Map<string, AudioBuffer>();
const peaks = new Map<string, { data: Float32Array; demo: boolean }>();

export const audioStore = {
  setBuffer(id: string, b: AudioBuffer) {
    buffers.set(id, b);
  },
  getBuffer(id: string) {
    return buffers.get(id);
  },
  hasBuffer(id: string) {
    return buffers.has(id);
  },
  setPeaks(id: string, data: Float32Array, demo: boolean) {
    peaks.set(id, { data, demo });
  },
  getPeaks(id: string) {
    return peaks.get(id);
  },
  delete(id: string) {
    buffers.delete(id);
    peaks.delete(id);
  },
};

export function computePeaks(buffer: AudioBuffer, bins = 2000): Float32Array {
  const out = new Float32Array(bins);
  const len = buffer.length;
  const step = Math.max(1, Math.floor(len / bins));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < bins; i++) {
      let max = 0;
      const s = i * step;
      for (let j = 0; j < step && s + j < len; j += 4) {
        const v = Math.abs(ch[s + j]);
        if (v > max) max = v;
      }
      if (max > out[i]) out[i] = max;
    }
  }
  return out;
}
