/**
 * Musical key of a recording (or part of one). Pure analysis, no Web Audio, so the phone and the
 * MCP server run the same code.
 *
 * 1. Spectrum frames of a ~11 kHz mono copy; every peak bin between ~55 Hz and 2 kHz votes for
 *    its pitch class.
 * 2. Tuning is measured first (how far the whole recording sits from A = 440, e.g. a Baroque
 *    A = 415 band) so a slightly flat or sharp recording still lands on the right notes. The key is
 *    reported as it sounds at A = 440 — what a modern DAW and other samples will match.
 * 3. The 12-note profile is matched against Krumhansl–Kessler major / minor key profiles; the best
 *    of the 24 keys wins, with a confidence from how far ahead of the runner-up it is.
 */

import { yinPitch } from "./hum";

export interface KeyResult {
  /** 0 = C … 11 = B. */
  tonic: number;
  mode: "major" | "minor";
  /** e.g. "E minor". */
  name: string;
  /** Relative major / minor, e.g. "G major" for E minor. */
  relative: string;
  /** 0..1 — how clearly this key beat the next best. */
  confidence: number;
  /** How far the recording's tuning sits from A = 440, in cents (−50..50). */
  tuningCents: number;
  /** Second-best key, for display when the call is close. */
  runnerUp: string;
}

export const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export const keyName = (tonic: number, mode: "major" | "minor") => `${NOTE_NAMES[((tonic % 12) + 12) % 12]} ${mode}`;
/** The key a recording in `k` sounds in after shifting `semis` semitones (pad pitch / repitch). */
export const transposeKey = (k: Pick<KeyResult, "tonic" | "mode">, semis: number) => keyName(k.tonic + Math.round(semis), k.mode);

/** In-place iterative radix-2 FFT (re, im of length 2^n). */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function pearson(a: number[], b: number[]) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? n / Math.sqrt(da * db) : 0;
}

/** Key of `x` (mono, `sr` Hz) between `start` and `end` seconds (whole recording by default). Null when too short or silent. */
export function detectKey(x: Float32Array, sr: number, start = 0, end = x.length / sr): KeyResult | null {
  // ~11 kHz copy: keeps everything up to ~5 kHz, 4× less work
  const k = Math.max(1, Math.floor(sr / 11025));
  const a = Math.max(0, Math.floor(start * sr)), b = Math.min(x.length, Math.floor(end * sr));
  const n = Math.floor((b - a) / k);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += x[a + i * k + j];
    y[i] = s / k;
  }
  const fs = sr / k;
  const N = 4096, hop = 2048;
  if (n < N) return null;
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const lo = Math.ceil((55 * N) / fs), hi = Math.floor((2000 * N) / fs);
  // first pass collects peaks; tuning comes from them, then they are binned into pitch classes
  const peaks: { midi: number; w: number }[] = [];
  const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(N / 2);
  const maxFrames = 600; // spread over long recordings instead of reading every frame
  const frames = Math.floor((n - N) / hop) + 1;
  const stride = Math.max(1, Math.floor(frames / maxFrames));
  for (let f = 0; f < frames; f += stride) {
    const o = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = y[o + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let frameMax = 0;
    for (let i = lo; i <= hi; i++) {
      mag[i] = Math.hypot(re[i], im[i]);
      frameMax = Math.max(frameMax, mag[i]);
    }
    if (frameMax < 1e-4) continue;
    for (let i = lo + 1; i < hi; i++) {
      const m = mag[i];
      if (m < frameMax * 0.05 || m < mag[i - 1] || m < mag[i + 1]) continue;
      // parabolic peak position for a precise frequency (tuning needs better than bin accuracy)
      const p = 0.5 * (mag[i - 1] - mag[i + 1]) / (mag[i - 1] - 2 * m + mag[i + 1] || 1);
      const freq = ((i + p) * fs) / N;
      peaks.push({ midi: 69 + 12 * Math.log2(freq / 440), w: Math.sqrt(m / frameMax) });
    }
  }
  if (peaks.length < 20) return null;
  // tuning = circular mean of how far peaks sit from the equal-tempered grid
  let cx = 0, cy = 0;
  for (const pk of peaks) {
    const ang = 2 * Math.PI * (pk.midi - Math.round(pk.midi));
    cx += pk.w * Math.cos(ang);
    cy += pk.w * Math.sin(ang);
  }
  const tuning = Math.atan2(cy, cx) / (2 * Math.PI); // in semitones, −0.5..0.5
  const chroma = new Array(12).fill(0);
  for (const pk of peaks) {
    const pc = ((Math.round(pk.midi - tuning) % 12) + 12) % 12;
    chroma[pc] += pk.w;
  }
  const scores: { tonic: number; mode: "major" | "minor"; r: number }[] = [];
  for (let t = 0; t < 12; t++) {
    const rot = (p: number[]) => p.map((_, i) => p[(i - t + 12) % 12]);
    scores.push({ tonic: t, mode: "major", r: pearson(chroma, rot(MAJOR)) });
    scores.push({ tonic: t, mode: "minor", r: pearson(chroma, rot(MINOR)) });
  }
  scores.sort((p, q) => q.r - p.r);
  const [best, second] = scores;
  const rel = best.mode === "minor" ? keyName(best.tonic + 3, "major") : keyName(best.tonic + 9, "minor");
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: keyName(best.tonic, best.mode),
    relative: rel,
    confidence: Math.max(0, Math.min(1, (best.r - second.r) * 5 + Math.max(0, best.r - 0.5))),
    tuningCents: Math.round(tuning * 100),
    runnerUp: keyName(second.tonic, second.mode),
  };
}

/**
 * Semitones to move a sample in key `from` so it fits key `to`: −6…+5, the smallest move.
 * Major and minor are compared through their relative keys (same notes): a C-major sample already
 * fits an A-minor beat, so that's 0.
 */
export function keyShift(from: Pick<KeyResult, "tonic" | "mode">, to: Pick<KeyResult, "tonic" | "mode">): number {
  const asMajor = (k: Pick<KeyResult, "tonic" | "mode">) => (k.mode === "minor" ? k.tonic + 3 : k.tonic);
  const d = (((asMajor(to) - asMajor(from)) % 12) + 12) % 12;
  return d > 5 ? d - 12 : d;
}

/** Semitones to move a single note (a drum's pitch, as MIDI) onto the key's root: −6…+5. */
export function rootShift(midi: number, to: Pick<KeyResult, "tonic">): number {
  const d = (((to.tonic - Math.round(midi)) % 12) + 12) % 12;
  return d > 5 ? d - 12 : d;
}

/**
 * The note a single hit sounds (an 808, a kick's body, a tom), as a MIDI number, from the part
 * after the attack. Null for noise (hats, snares) or anything without one clear pitch.
 */
export function detectPitch(x: Float32Array, sr: number, start = 0, end = x.length / sr): number | null {
  // 8 kHz copy is plenty for a drum's fundamental (down to ~25 Hz)
  const k = Math.max(1, Math.floor(sr / 8000));
  const a = Math.floor((start + 0.015) * sr), b = Math.min(x.length, Math.floor(Math.min(end, start + 0.6) * sr));
  const n = Math.floor((b - a) / k);
  if (n <= 0) return null;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += x[a + i * k + j];
    y[i] = s / k;
  }
  const fs = sr / k;
  const w = Math.round(0.08 * fs);
  const hop = Math.round(0.02 * fs);
  const pitches: number[] = [];
  for (let at = 0; at + w + fs / 25 < n; at += hop) {
    let e = 0;
    for (let j = 0; j < w; j++) e += y[at + j] * y[at + j];
    if (Math.sqrt(e / w) < 0.01) continue;
    const f = yinPitch(y, at, w, fs, 25, 1000);
    if (f) pitches.push(69 + 12 * Math.log2(f / 440));
  }
  if (pitches.length < 2) return null;
  pitches.sort((p, q) => p - q);
  const med = pitches[Math.floor(pitches.length / 2)];
  // most frames must agree (within a semitone) for it to count as one clear note
  const agree = pitches.filter((p) => Math.abs(p - med) < 1).length / pitches.length;
  return agree >= 0.6 ? med : null;
}

/** "E minor", "F# major", "Bb minor", "Em", "C" → a key; null if it isn't one. */
export function parseKey(text: string): Pick<KeyResult, "tonic" | "mode"> | null {
  const m = /^\s*([A-Ga-g])\s*([#♯b♭]?)\s*(major|maj|minor|min|m)?\s*$/i.exec(text);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase() as "C"];
  const acc = m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0;
  const q = (m[3] ?? "").toLowerCase();
  const mode = q === "m" || q.startsWith("min") ? "minor" : "major";
  return { tonic: (((base + acc) % 12) + 12) % 12, mode };
}
