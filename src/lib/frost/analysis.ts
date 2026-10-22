/**
 * Pure analysis on mono Float32 samples: transient detection (auto-slice), a source-tempo
 * *suggestion*, beat-grid generation, and min/max columns for the zoomable waveform.
 */
import type { BeatGrid } from "./types";

const HOP = 256;
/** Slices start slightly before the detected attack so the transient is never cut. */
export const PRE_ROLL_SEC = 0.001;

/**
 * Hops an attack may take to develop. Drums rise within one hop (~6 ms); bowed strings, voices
 * and pads swell over 50–80 ms, so the rise is measured against the quietest hop in this window.
 */
const RISE_LOOKBACK = 12;

/**
 * Per-hop onset strength (dB): how far high-frequency energy has risen above its minimum over the
 * previous RISE_LOOKBACK hops. Sharp transients and slow swells both register.
 */
export function onsetFunction(x: Float32Array): Float32Array {
  const hops = Math.floor(x.length / HOP);
  const db = new Float32Array(Math.max(0, hops));
  for (let h = 0; h < hops; h++) {
    let e = 0;
    const base = h * HOP;
    for (let i = Math.max(1, base); i < base + HOP; i++) {
      const d = x[i] - x[i - 1]; // first difference emphasises attacks
      e += d * d;
    }
    db[h] = Math.max(-80, 10 * Math.log10(e / HOP + 1e-10));
  }
  const flux = new Float32Array(db.length);
  for (let h = 1; h < db.length; h++) {
    let floor = db[h - 1];
    for (let k = Math.max(0, h - RISE_LOOKBACK); k < h - 1; k++) if (db[k] < floor) floor = db[k];
    // A hop must also be louder than the one before it, so a rise is only credited at its crest.
    flux[h] = db[h] > db[h - 1] ? Math.max(0, db[h] - floor) : 0;
  }
  return flux;
}

/**
 * Time (seconds) of the first sample above `thresholdDb` dBFS — where the recording audibly
 * starts, so a default selection never sits in leading silence. 0 when the file is silent.
 */
export function firstAudible(x: Float32Array, sampleRate: number, thresholdDb = -40): number {
  const lim = Math.pow(10, thresholdDb / 20);
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= lim) return i / sampleRate;
  return 0;
}

/** Transient times (seconds) within [start, end). sensitivity 0..1, higher = more slices. */
export function detectOnsets(
  x: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
  sensitivity: number,
): number[] {
  const a = Math.max(0, Math.floor(start * sampleRate));
  const b = Math.min(x.length, Math.floor(end * sampleRate));
  if (b - a < HOP * 4) return [];
  const seg = x.subarray(a, b);
  const flux = onsetFunction(seg);
  const s = Math.min(1, Math.max(0, sensitivity));
  const threshold = 4 + (1 - s) * 16; // dB rise: 20 (strict) .. 4 (loose)
  const minGap = Math.max(1, Math.floor((0.08 * sampleRate) / HOP));
  const out: number[] = [];
  let last = -minGap;
  for (let h = 1; h < flux.length - 1; h++) {
    const v = flux[h];
    if (v < threshold || h - last < minGap) continue;
    // crest of the rise: the strongest hop within one attack window either side
    let crest = true;
    for (let k = Math.max(0, h - RISE_LOOKBACK); k <= Math.min(flux.length - 1, h + RISE_LOOKBACK) && crest; k++)
      if (flux[k] > v || (flux[k] === v && k < h)) crest = false;
    if (!crest) continue;
    last = h;
    // refine to the first sample reaching 25% of the local peak
    const r0 = Math.max(0, (h - 1) * HOP),
      r1 = Math.min(seg.length, (h + 1) * HOP);
    let peak = 0;
    for (let i = r0; i < r1; i++) peak = Math.max(peak, Math.abs(seg[i]));
    let first = h * HOP;
    for (let i = r0; i < r1; i++)
      if (Math.abs(seg[i]) >= peak * 0.25) {
        first = i;
        break;
      }
    out.push(Math.max(start, (a + first) / sampleRate - PRE_ROLL_SEC));
  }
  return out;
}

/** Tempo suggestion from onset autocorrelation, folded into 80..160 BPM. Null when unclear. */
export function suggestTempo(
  x: Float32Array,
  sampleRate: number,
): { bpm: number; confidence: number } | null {
  // analyse at most ~90 s to keep this quick on a phone
  const flux = onsetFunction(x.subarray(0, Math.min(x.length, sampleRate * 90)));
  if (flux.length < 64) return null;
  let mean = 0;
  for (const v of flux) mean += v;
  mean /= flux.length;
  const f = flux.map((v) => v - mean);
  const hopSec = HOP / sampleRate;
  const minLag = Math.floor(60 / 180 / hopSec),
    maxLag = Math.ceil(60 / 70 / hopSec);
  if (maxLag >= f.length / 2) return null;
  const ac = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < f.length; i++) s += f[i] * f[i + lag];
    return s;
  };
  const zero = ac(0);
  if (zero <= 0) return null;
  let best = -Infinity,
    bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = ac(lag);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  if (bestLag <= 0 || best <= 0) return null;
  const y0 = ac(bestLag - 1),
    y2 = ac(bestLag + 1);
  const den = y0 - 2 * best + y2;
  const lag = bestLag + (den !== 0 ? (0.5 * (y0 - y2)) / den : 0);
  let bpm = 60 / (lag * hopSec);
  while (bpm < 80) bpm *= 2;
  while (bpm > 160) bpm /= 2;
  return { bpm: Math.round(bpm * 10) / 10, confidence: best / zero };
}

export function generateBeatGrid(
  bpm: number,
  firstBeat: number,
  duration: number,
  beatsPerBar = 4,
): BeatGrid {
  const beats: number[] = [];
  const spb = 60 / bpm;
  for (let t = firstBeat; t < duration; t += spb) beats.push(Math.round(t * 1e6) / 1e6);
  return { bpm, beatsPerBar, beats };
}

/** Move one beat marker, kept between its neighbours. */
export function moveBeat(grid: BeatGrid, index: number, t: number): BeatGrid {
  const beats = [...grid.beats];
  const lo = index > 0 ? beats[index - 1] + 0.001 : 0;
  const hi = index < beats.length - 1 ? beats[index + 1] - 0.001 : Infinity;
  beats[index] = Math.min(hi, Math.max(lo, t));
  return { ...grid, beats };
}

/** Sorted unique boundaries for [start, end] including both ends. */
export function boundaries(cuts: number[], start: number, end: number, minLen = 0.01): number[] {
  const inside = cuts.filter((c) => c > start + minLen && c < end - minLen).sort((a, b) => a - b);
  const out = [start];
  for (const c of inside) if (c - out[out.length - 1] >= minLen) out.push(c);
  out.push(end);
  return out;
}

/** Min/max per column across `channels` for [t0, t1). */
export function waveColumns(
  channels: Float32Array[],
  sampleRate: number,
  t0: number,
  t1: number,
  columns: number,
): Float32Array {
  const out = new Float32Array(columns * 2);
  const f0 = t0 * sampleRate,
    fpc = ((t1 - t0) * sampleRate) / columns;
  const step = Math.max(1, Math.floor(fpc / 64)); // sparse read when zoomed out
  for (let c = 0; c < columns; c++) {
    const a = Math.max(0, Math.floor(f0 + c * fpc));
    const b = Math.min(channels[0].length, Math.max(a + 1, Math.floor(f0 + (c + 1) * fpc)));
    let mn = 0,
      mx = 0;
    for (const ch of channels)
      for (let i = a; i < b; i += step) {
        const v = ch[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    out[c * 2] = mn;
    out[c * 2 + 1] = mx;
  }
  return out;
}
