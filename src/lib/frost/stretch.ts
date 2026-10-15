/**
 * Pitch-preserving time-stretch (WSOLA: waveform-similarity overlap-add). Runs offline when a
 * pad's length, the project BPM or the slice changes; playback then reads the baked buffer, so
 * pads stay cheap to trigger. Output length is exact: round(input * ratio).
 *
 * WSOLA keeps transients and rhythm tight, which suits chopped drums and phrases; it can sound
 * grainy on long sustained chords at extreme ratios (> ~1.6x or < ~0.6x).
 */
const N = 1024; // frame
const HS = N / 2; // synthesis hop
const DELTA = 256; // similarity search radius (frames)
const DECIM = 4; // correlation decimation for speed

const WINDOW = (() => {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); // periodic Hann, sums to 1 at 50% overlap
  return w;
})();

export function stretchLength(inputFrames: number, ratio: number) {
  return Math.max(1, Math.round(inputFrames * ratio));
}

export function wsola(channels: Float32Array[], ratio: number): Float32Array[] {
  const n = channels[0]?.length ?? 0;
  const outLen = stretchLength(n, ratio);
  if (n === 0) return channels.map(() => new Float32Array(outLen));
  if (Math.abs(ratio - 1) < 1e-6) return channels.map((c) => c.slice());
  // mono guide for similarity search
  const mono = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[i] / channels.length;
  const at = (i: number) => (i >= 0 && i < n ? mono[i] : 0);

  const out = channels.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const ha = HS / ratio;
  let prev = 0; // input position of previous chosen frame
  const frames = Math.ceil(outLen / HS) + 1;
  for (let k = 0; k < frames; k++) {
    const nominal = Math.round(k * ha);
    let pos = nominal;
    if (k > 0) {
      // natural continuation of the previous frame
      const target = prev + HS;
      let best = -Infinity;
      const lo = Math.max(-DELTA, -nominal),
        hi = DELTA;
      for (let d = lo; d <= hi; d += 2) {
        const cand = nominal + d;
        let s = 0;
        for (let i = 0; i < N; i += DECIM) s += at(target + i) * at(cand + i);
        if (s > best) {
          best = s;
          pos = cand;
        }
      }
    }
    prev = pos;
    const o = k * HS;
    for (let i = 0; i < N; i++) {
      const src = pos + i;
      // first half-frame unwindowed so the slice's opening transient is copied untouched
      const w = k === 0 && i < HS ? 1 : WINDOW[i];
      norm[o + i] += w;
      if (src < 0 || src >= n) continue;
      for (let c = 0; c < channels.length; c++) out[c][o + i] += channels[c][src] * w;
    }
  }
  return out.map((c) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? c[i] / Math.max(norm[i], 0.5) : 0;
    return r;
  });
}
