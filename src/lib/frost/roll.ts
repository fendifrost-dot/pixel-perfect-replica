/**
 * Roll: one hit becomes N repeats on a fine grid (1/24, 1/32 or 1/48) over a chosen length — a
 * hi-hat roll, a snare rush, a stutter. Pure; the result is ordinary exact NoteEvents, so the
 * Timeline, playback, export and MIDI treat them like any other hit, and the edit is one undo.
 */
import { FINE_DIV, toFine } from "./timing";
import type { NoteEvent } from "./types";

/** Roll rates as the spacing between repeats, in 16th steps. */
export const ROLL_RATES: { value: number; label: string }[] = [
  { value: 2 / 3, label: "1/24" },
  { value: 1 / 2, label: "1/32" },
  { value: 1 / 3, label: "1/48" },
];

export type VelocityRamp = "none" | "up" | "down";

export interface RollOptions {
  /** Spacing between repeats in steps: 2/3, 1/2 or 1/3 (any multiple of 1/6 works). */
  rate: number;
  /** Total length of the roll in steps (the last repeat ends here). */
  lengthSteps: number;
  /** "up": quiet → the hit's velocity; "down": the hit's velocity → quiet; "none": all equal. */
  velocityRamp: VelocityRamp;
  /** Semitones added across the roll, first → last repeat (0 = no pitch ramp); -12..12. */
  pitchRamp: number;
  makeId: () => string;
}

/** Quietest end of a velocity ramp, as a fraction of the hit's velocity. */
const RAMP_FLOOR = 0.45;

/** How many repeats a roll of `lengthSteps` at `rate` holds (at least 2). */
export function rollCount(rate: number, lengthSteps: number): number {
  return Math.max(2, Math.round(lengthSteps / rate));
}

/**
 * The repeats that replace `note`. Each is placed exactly at note.step + i·rate, on the fine grid,
 * sounds for one spacing (so repeats never pile up), and keeps the hit's pad, velocity (ramped),
 * pitch (ramped on top of the hit's own) and any generator tag.
 */
export function rollNotes(note: NoteEvent, o: RollOptions): NoteEvent[] {
  const rate = toFine(Math.max(1 / FINE_DIV, o.rate));
  const n = rollCount(rate, o.lengthSteps);
  const ramp = Math.max(-12, Math.min(12, Math.round(o.pitchRamp)));
  const out: NoteEvent[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    const vScale =
      o.velocityRamp === "up"
        ? RAMP_FLOOR + (1 - RAMP_FLOOR) * t
        : o.velocityRamp === "down"
          ? 1 - (1 - RAMP_FLOOR) * t
          : 1;
    const velocity = Math.max(1, Math.min(127, Math.round(note.velocity * vScale)));
    const pitch = (note.pitch ?? 0) + Math.round(ramp * t);
    out.push({
      id: i === 0 ? note.id : o.makeId(),
      padId: note.padId,
      step: toFine(note.step + i * rate),
      velocity,
      offset: 0,
      exact: true,
      length: rate,
      ...(pitch ? { pitch } : {}),
      ...(note.gen ? { gen: note.gen } : {}),
    });
  }
  return out;
}

/** Replace `noteId` in `notes` with its roll (other notes untouched, order kept). */
export function applyRoll(notes: NoteEvent[], noteId: string, o: RollOptions): NoteEvent[] {
  const i = notes.findIndex((n) => n.id === noteId);
  if (i < 0) return notes;
  return [...notes.slice(0, i), ...rollNotes(notes[i], o), ...notes.slice(i + 1)];
}
