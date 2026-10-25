/**
 * Pure tempo / grid / event math. Live playback (engine.ts) and offline export (render.ts) both
 * build their schedules from `eventsInRange`, so an export plays hits at exactly the times the
 * transport did. No Web Audio in here — it is unit-tested directly.
 */
import type { NoteEvent, Pad, Pattern, Project, Slice } from "./types";

export const STEPS_PER_BEAT = 4;

export const stepDur = (bpm: number) => 60 / bpm / STEPS_PER_BEAT;

const GRID_STEPS: Record<Project["quantize"], number | null> = {
  off: null,
  "1/8": 2,
  "1/16": 1,
  "1/32": 0.5,
};

/**
 * Where a hit plays, in steps from pattern start (0 <= result < lengthSteps).
 * - Quantize snaps the played position (step + offset) to the grid, non-destructively.
 * - Swing (MPC-style) delays off-beats of the grid; at 50% straight, 66% triplet feel, 75% max.
 *   It only applies to hits that sit on the grid, so unquantized playing keeps its own timing.
 */
export function effectiveStep(
  note: Pick<NoteEvent, "step" | "offset" | "exact">,
  quantize: Project["quantize"],
  swing: number,
  lengthSteps: number,
): number {
  const raw = note.step + note.offset;
  const g = GRID_STEPS[quantize];
  let pos = g == null || note.exact ? raw : Math.round(raw / g) * g;
  // Swing unit is the quantize grid for 1/8 and 1/16, otherwise 16ths.
  const unit = g === 2 ? 2 : 1;
  const k = pos / unit;
  if (Math.abs(k - Math.round(k)) < 1e-9 && Math.round(k) % 2 !== 0) {
    pos += ((Math.min(75, Math.max(50, swing)) - 50) / 50) * unit;
  }
  return ((pos % lengthSteps) + lengthSteps) % lengthSteps;
}

/** Convert a tap at `posSteps` (fractional, inside the pattern) into a raw note position. */
export function recordPosition(
  posSteps: number,
  lengthSteps: number,
): { step: number; offset: number } {
  const p = ((posSteps % lengthSteps) + lengthSteps) % lengthSteps;
  const step = Math.round(p) % lengthSteps;
  let offset = p - Math.round(p);
  if (offset >= 0.5) offset = 0.4999;
  if (offset < -0.5) offset = -0.5;
  return { step, offset: Math.round(offset * 1000) / 1000 };
}

/** A section of the timeline: one pattern placed at an absolute step. */
export interface Section {
  pattern: Pattern;
  startStep: number;
}

/** The song (arrangement) as a list of sections; falls back to the current pattern. */
export function songSections(p: Project): Section[] {
  const out: Section[] = [];
  let at = 0;
  for (const b of p.arrangement) {
    const pattern = p.patterns.find((x) => x.id === b.patternId);
    if (!pattern) continue;
    out.push({ pattern, startStep: at });
    at += pattern.lengthSteps;
  }
  return out.length ? out : patternSections(p, 1);
}

export function patternSections(p: Project, repeats: number): Section[] {
  const pattern = p.patterns.find((x) => x.id === p.currentPatternId) ?? p.patterns[0];
  return Array.from({ length: repeats }, (_, i) => ({
    pattern,
    startStep: i * pattern.lengthSteps,
  }));
}

export const sectionsLength = (s: Section[]) =>
  s.reduce((n, x) => Math.max(n, x.startStep + x.pattern.lengthSteps), 0);

export interface ScheduledHit {
  noteId: string;
  padId: string;
  velocity: number;
  /** Absolute position in steps from timeline start. */
  at: number;
  /** Steps the hit sounds for, when the note sets one. */
  length?: number;
}

/**
 * Hits whose effective position falls in [fromStep, toStep), for a timeline built from `sections`.
 * With `loop`, the section list repeats forever (pattern loop / song loop).
 */
export function eventsInRange(
  p: Project,
  sections: Section[],
  fromStep: number,
  toStep: number,
  loop: boolean,
): ScheduledHit[] {
  const total = sectionsLength(sections);
  if (!total || toStep <= fromStep) return [];
  const out: ScheduledHit[] = [];
  const firstCycle = loop ? Math.floor(fromStep / total) - 1 : 0;
  const lastCycle = loop ? Math.floor(toStep / total) : 0;
  for (let c = firstCycle; c <= lastCycle; c++) {
    if (c < 0) continue;
    for (const sec of sections) {
      const pat = sec.pattern;
      const anySolo = pat.lanes.some((l) => l.solo);
      const base = c * total + sec.startStep;
      if (base + pat.lengthSteps + 1 <= fromStep || base - 1 >= toStep) continue;
      for (const n of pat.notes) {
        const lane = pat.lanes.find((l) => l.padId === n.padId);
        if (lane && (lane.mute || (anySolo && !lane.solo))) continue;
        const at = base + effectiveStep(n, p.quantize, p.swing, pat.lengthSteps);
        if (at >= fromStep && at < toStep)
          out.push({ noteId: n.id, padId: n.padId, velocity: n.velocity, at, ...(n.length ? { length: n.length } : {}) });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at || a.padId.localeCompare(b.padId));
}

/** How a pad turns a slice into sound at the project tempo. */
export interface PlayPlan {
  /** Playback rate for the (possibly pre-stretched) buffer. */
  rate: number;
  /** Pitch-preserving stretch to bake first: output/input duration ratio, or null. */
  stretch: number | null;
  /** Seconds the hit lasts (one-shot). */
  duration: number;
  /** Audible pitch change in semitones, for display. */
  pitchSemis: number;
}

export function lengthBeats(pad: Pad) {
  return pad.lengthUnit === "bars" ? pad.lengthValue * 4 : pad.lengthValue;
}

/**
 * - No musical length: classic sampler pitch — rate = 2^(pitch/12), length follows.
 * - Length + repitch: speed (and pitch) change to fill the length at project BPM; pitch knob is overridden.
 * - Length + stretch: pitch-preserving stretch to the length, then the pitch knob transposes
 *   without changing the length (stretch by an extra pitch ratio, play back faster by the same ratio).
 */
export function playPlan(pad: Pad, slice: Slice, bpm: number): PlayPlan {
  const dur = slice.end - slice.start;
  const pitchRate = Math.pow(2, pad.pitch / 12);
  if (pad.lengthUnit === "off" || lengthBeats(pad) <= 0 || dur <= 0) {
    return { rate: pitchRate, stretch: null, duration: dur / pitchRate, pitchSemis: pad.pitch };
  }
  const target = (lengthBeats(pad) * 60) / bpm;
  if (pad.timeMode === "repitch") {
    const rate = dur / target;
    return { rate, stretch: null, duration: target, pitchSemis: 12 * Math.log2(rate) };
  }
  return {
    rate: pitchRate,
    stretch: (target / dur) * pitchRate,
    duration: target,
    pitchSemis: pad.pitch,
  };
}

/**
 * For gate / loop pads in a sequence, a hit holds until the next hit on the same pad
 * (or the end of the timeline). Returns noteId -> release position in steps.
 */
export function holdEnds(hits: ScheduledHit[], endStep: number): Map<string, number> {
  const next = new Map<string, number>();
  const res = new Map<string, number>();
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    res.set(h.noteId + "@" + h.at, next.get(h.padId) ?? endStep);
    next.set(h.padId, h.at);
  }
  return res;
}
