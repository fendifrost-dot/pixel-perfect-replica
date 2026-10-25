/**
 * Turning a hummed or beatboxed take into hits. Pure analysis (no Web Audio) so it is unit-tested
 * directly and runs on the phone without any service.
 *
 * - Melody: YIN pitch tracking on a 16 kHz copy, then notes cut where the pitch moves to a new
 *   semitone, the voice stops, or the level dips and comes back (a re-sung note).
 * - Beatbox: onsets, each classed kick / snare / hat by how low or noisy its first 60 ms is.
 */
import { detectOnsets } from "./analysis";

export interface HumNote {
  /** Seconds into the take. */
  start: number;
  end: number;
  /** Nearest MIDI note. */
  midi: number;
  /** 0..1, relative to the loudest note. */
  level: number;
}

export type BeatboxKind = "kick" | "snare" | "hat";
export interface BeatboxHit {
  time: number;
  kind: BeatboxKind;
  level: number;
}

const HOP_SEC = 0.01;
const MIN_NOTE_SEC = 0.06;

/** Crude low-pass + decimate to about 16 kHz: plenty for a voice's pitch, ~10× less work. */
function downsample(x: Float32Array, sr: number): { y: Float32Array; sr: number } {
  const k = Math.max(1, Math.floor(sr / 16000));
  if (k === 1) return { y: x, sr };
  const y = new Float32Array(Math.floor(x.length / k));
  for (let i = 0; i < y.length; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += x[i * k + j];
    y[i] = s / k;
  }
  return { y, sr: sr / k };
}

/** YIN fundamental estimate for one frame; null when no clear period (breath, noise, silence). */
export function yinPitch(x: Float32Array, at: number, w: number, sr: number, fMin = 55, fMax = 1000): number | null {
  const tauMin = Math.max(2, Math.floor(sr / fMax));
  const tauMax = Math.min(Math.floor(sr / fMin), Math.floor((x.length - at - w) / 1));
  if (tauMax <= tauMin + 2) return null;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const v = x[at + j] - x[at + j + tau];
      s += v * v;
    }
    d[tau] = s;
  }
  // cumulative mean normalised difference
  let run = 0;
  let best = -1;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau];
    const c = run > 0 ? (d[tau] * tau) / run : 1;
    d[tau] = c;
  }
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < 0.15) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) return null;
  // parabolic interpolation around the dip
  const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1] ?? d[best];
  const den = a - 2 * b + c;
  const t = den ? best + (0.5 * (a - c)) / den : best;
  return sr / t;
}

const toMidi = (f: number) => 69 + 12 * Math.log2(f / 440);

/** Notes sung in `x` (mono samples at `sampleRate`). */
export function transcribeHum(x: Float32Array, sampleRate: number): HumNote[] {
  const { y, sr } = downsample(x, sampleRate);
  const hop = Math.round(HOP_SEC * sr);
  const w = Math.round(0.03 * sr);
  const frames: { t: number; rms: number; midi: number | null }[] = [];
  const tauMax = Math.floor(sr / 55);
  for (let at = 0; at + w + tauMax < y.length; at += hop) {
    let e = 0;
    for (let j = 0; j < w; j++) e += y[at + j] * y[at + j];
    const rms = Math.sqrt(e / w);
    const f = rms > 1e-3 ? yinPitch(y, at, w, sr) : null;
    frames.push({ t: at / sr, rms, midi: f ? toMidi(f) : null });
  }
  if (!frames.length) return [];
  const loud = [...frames.map((f) => f.rms)].sort((a, b) => a - b)[Math.floor(frames.length * 0.95)] ?? 0;
  const floor = Math.max(0.004, loud * 0.12);
  // 5-frame median of pitch smooths YIN's odd octave slip
  const med = frames.map((f, i) => {
    if (f.midi == null || f.rms < floor) return null;
    const win = frames.slice(Math.max(0, i - 2), i + 3).map((g) => g.midi).filter((m): m is number => m != null);
    win.sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)];
  });

  const notes: HumNote[] = [];
  let cur: { start: number; pitches: number[]; peak: number; gap: number; dip: boolean; away: number } | null = null;
  const close = (end: number) => {
    if (!cur) return;
    if (end - cur.start >= MIN_NOTE_SEC) {
      const ps = [...cur.pitches].sort((a, b) => a - b);
      notes.push({ start: cur.start, end, midi: Math.round(ps[Math.floor(ps.length / 2)]), level: cur.peak });
    }
    cur = null;
  };
  for (let i = 0; i < frames.length; i++) {
    const m = med[i];
    const t = frames[i].t;
    const rms = frames[i].rms;
    if (m == null) {
      if (cur && ++cur.gap >= 2) close(t - (cur.gap - 1) * HOP_SEC);
      continue;
    }
    if (!cur) {
      cur = { start: t, pitches: [m], peak: rms, gap: 0, dip: false, away: 0 };
      continue;
    }
    cur.gap = 0;
    const centre = [...cur.pitches].sort((a, b) => a - b)[Math.floor(cur.pitches.length / 2)];
    // a level dip then a rise on the same pitch = the note was sung again
    if (rms < cur.peak * 0.4) cur.dip = true;
    else if (cur.dip && rms > cur.peak * 0.7) {
      close(t);
      cur = { start: t, pitches: [m], peak: rms, gap: 0, dip: false, away: 0 };
      continue;
    }
    if (Math.abs(m - centre) > 0.7) {
      // moved to another note once it holds for 3 frames (not a scoop or vibrato)
      if (++cur.away >= 3) {
        close(t - 2 * HOP_SEC);
        cur = { start: t - 2 * HOP_SEC, pitches: [m], peak: rms, gap: 0, dip: false, away: 0 };
      }
      continue;
    }
    cur.away = 0;
    cur.pitches.push(m);
    cur.peak = Math.max(cur.peak, rms);
  }
  if (frames.length) close(frames[frames.length - 1].t + HOP_SEC);
  const top = Math.max(1e-9, ...notes.map((n) => n.level));
  return notes.map((n) => ({ ...n, level: n.level / top }));
}

/** Beatboxed hits in `x`: boom → kick, ka / psh → snare, ts → hat. */
export function transcribeBeatbox(x: Float32Array, sr: number, sensitivity = 0.6): BeatboxHit[] {
  const onsets = detectOnsets(x, sr, 0, x.length / sr, sensitivity);
  let peakAll = 0;
  for (let i = 0; i < x.length; i++) peakAll = Math.max(peakAll, Math.abs(x[i]));
  const n = Math.round(0.06 * sr);
  const out: BeatboxHit[] = [];
  const k = 1 - Math.exp((-2 * Math.PI * 200) / sr); // one-pole low-pass at ~200 Hz
  for (const t of onsets) {
    const a = Math.max(0, Math.round(t * sr));
    const b = Math.min(x.length, a + n);
    if (b - a < n / 3) continue;
    let zc = 0, e = 0, eLow = 0, low = 0, peak = 0;
    for (let i = a; i < b; i++) {
      const v = x[i];
      if (i > a && (v >= 0) !== (x[i - 1] >= 0)) zc++;
      low += k * (v - low);
      e += v * v;
      eLow += low * low;
      peak = Math.max(peak, Math.abs(v));
    }
    if (peak < peakAll * 0.08) continue;
    // zero crossings ≈ twice the dominant frequency: "ts" sits above ~6 kHz, "ka/psh" below
    const brightHz = ((zc / (b - a)) * sr) / 2;
    const lowRatio = e > 0 ? eLow / e : 0;
    const kind: BeatboxKind = lowRatio > 0.5 ? "kick" : brightHz > 6000 ? "hat" : "snare";
    out.push({ time: t, kind, level: peakAll ? peak / peakAll : 1 });
  }
  return out;
}

/**
 * Octaves to shift a sung line so its middle note sits in an instrument's own register
 * (a hummed bassline is usually an octave or two above where an 808 lives).
 */
export function octaveShift(notes: HumNote[], rootMidi: number): number {
  if (!notes.length) return 0;
  const ms = notes.map((n) => n.midi).sort((a, b) => a - b);
  const mid = ms[Math.floor(ms.length / 2)];
  return Math.round((rootMidi + 11 - mid) / 12) * 12; // middle note lands in the octave above the root
}

/** MIDI note number → name, e.g. 36 → "C2". */
export function noteName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export interface TakePlacement {
  /** Timeline position (steps) of a moment `sec` seconds into the take. */
  stepAt: (sec: number) => number;
  /** Grid to snap to, in steps (0 = keep the timing exactly as sung). */
  snap: number;
  makeId: () => string;
}

const snapStep = (v: number, snap: number) => (snap > 0 ? Math.round(v / snap) * snap : Math.round(v * 1000) / 1000);
const velocityOf = (level: number) => Math.round(Math.max(1, Math.min(127, 50 + 77 * level)));

/** A sung line as hits on one instrument pad: each note at its time, length and pitch. */
export function melodyHits(
  notes: HumNote[],
  padId: string,
  rootMidi: number,
  shift: number,
  at: TakePlacement,
): { id: string; padId: string; step: number; velocity: number; offset: number; exact: true; length: number; pitch?: number }[] {
  const out = [];
  for (const n of notes) {
    const step = snapStep(at.stepAt(n.start), at.snap);
    if (step < 0) continue;
    const end = snapStep(at.stepAt(n.end), at.snap);
    const length = Math.max(at.snap || 0.5, end - step, 0.5);
    const pitch = n.midi + shift - rootMidi;
    out.push({ id: at.makeId(), padId, step, velocity: velocityOf(n.level), offset: 0, exact: true as const, length, ...(pitch ? { pitch } : {}) });
  }
  return out;
}

/** Beatboxed hits on the kick / snare / hat pads. */
export function beatboxHits(
  hits: BeatboxHit[],
  padFor: Record<BeatboxKind, string>,
  at: TakePlacement,
): { id: string; padId: string; step: number; velocity: number; offset: number; exact: true }[] {
  const out = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const step = snapStep(at.stepAt(h.time), at.snap);
    const key = `${h.kind}@${step}`;
    if (step < 0 || seen.has(key)) continue; // two detections snapping to one step = one hit
    seen.add(key);
    out.push({ id: at.makeId(), padId: padFor[h.kind], step, velocity: velocityOf(h.level), offset: 0, exact: true as const });
  }
  return out;
}
