/**
 * Which MIDI note plays which pad, and how a learned knob edits the selected pad.
 * Pure. The live input (midiIn.ts) and the DAW pack (samplerPack.ts) both import `noteMap`,
 * so a pad lands on the same note in Frost and in the sampler preset.
 */
import type { MidiCcBinding, MidiCcTarget, MidiMap, NoteEvent, Pad, Project } from "./types";
import { emptyMidi } from "./types";
import { recordPosition } from "./timing";

/** First default note. Pads with nothing learned take this, then the next, in bank order. */
export const DEFAULT_NOTE = 36;

const TARGETS: readonly MidiCcTarget[] = ["pitch", "volume", "start", "end"];
const MIN_CHOP = 0.02;

export function midiOf(midi: MidiMap | undefined): MidiMap {
  return midi ?? emptyMidi();
}

/** Pads in the order notes are handed out: bank A, then B, then any other bank, each by index. */
export function padsInMapOrder(pads: Pad[]): Pad[] {
  const banks: string[] = [];
  for (const pad of pads) if (!banks.includes(pad.bank)) banks.push(pad.bank);
  const known = ["A", "B", "C", "D"].filter((b) => banks.includes(b));
  const rest = banks.filter((b) => !known.includes(b));
  return [...known, ...rest].flatMap((bank) =>
    pads.filter((p) => p.bank === bank).sort((a, b) => a.index - b.index),
  );
}

export function bankPadIds(pads: Pad[], bank: string): string[] {
  return pads
    .filter((p) => p.bank === bank)
    .sort((a, b) => a.index - b.index)
    .map((p) => p.id);
}

export interface MappedNote {
  padId: string;
  note: number;
}

/**
 * The project's note map. A learned note wins. Every other pad takes 36, 37, 38… by its place
 * in bank order, skipping a number another pad already owns.
 */
export function noteMap(pads: Pad[], learned?: Record<string, number>): MappedNote[] {
  const order = padsInMapOrder(pads);
  const notes = learned ?? {};
  const used = new Set<number>();
  const explicit = new Map<string, number>();
  for (const pad of order) {
    const n = notes[pad.id];
    if (n == null || !ownedNote(n) || used.has(n)) continue;
    explicit.set(pad.id, n);
    used.add(n);
  }
  const out: MappedNote[] = [];
  for (let i = 0; i < order.length; i++) {
    const pad = order[i];
    const learnedNote = explicit.get(pad.id);
    if (learnedNote != null) {
      out.push({ padId: pad.id, note: learnedNote });
      continue;
    }
    const n = DEFAULT_NOTE + i;
    if (n > 127 || used.has(n)) continue;
    used.add(n);
    out.push({ padId: pad.id, note: n });
  }
  return out;
}

/** The pad a note plays, on any channel. Null when the note is outside the map. */
export function padForMidiNote(
  pads: Pad[],
  learned: Record<string, number> | undefined,
  note: number,
): string | null {
  return noteMap(pads, learned).find((m) => m.note === note)?.padId ?? null;
}

const ownedNote = (n: number) => Number.isInteger(n) && n >= 0 && n <= 127;

/** Put `padId` on `note` and take that note away from any other pad. */
export function learnNote(map: MidiMap, padId: string, note: number): MidiMap {
  const n = Math.max(0, Math.min(127, Math.round(note)));
  const notes: Record<string, number> = {};
  for (const [id, v] of Object.entries(map.notes)) if (id !== padId && v !== n) notes[id] = v;
  notes[padId] = n;
  return { ...map, notes };
}

/** Drop a pad's learned note so it falls back to the default. */
export function forgetNote(map: MidiMap, padId: string): MidiMap {
  if (map.notes[padId] == null) return map;
  const notes = { ...map.notes };
  delete notes[padId];
  return { ...map, notes };
}

/**
 * Learn the next pad in `padIds`. `index` is how many have been learned in this pass.
 * Returns the same map when the pass is already finished.
 */
export function learnNext(
  map: MidiMap,
  padIds: string[],
  index: number,
  note: number,
): { map: MidiMap; index: number; done: boolean; padId: string | null } {
  const padId = padIds[index];
  if (!padId) return { map, index, done: true, padId: null };
  const next = index + 1;
  return { map: learnNote(map, padId, note), index: next, done: next >= padIds.length, padId };
}

/** One knob per target. Learning the same target again replaces the binding. */
export function learnCc(map: MidiMap, binding: MidiCcBinding): MidiMap {
  const cc = Math.max(0, Math.min(127, Math.round(binding.cc)));
  const channel = Math.max(1, Math.min(16, Math.round(binding.channel)));
  const next: MidiCcBinding = { cc, channel, target: binding.target };
  return { ...map, ccs: [...map.ccs.filter((c) => c.target !== next.target), next] };
}

export function ccToPitch(cc: number): number {
  const n = Math.max(0, Math.min(127, cc));
  return Math.round((n / 127) * 48 - 24);
}

export function ccToVolume(cc: number): number {
  return Math.round((Math.max(0, Math.min(127, cc)) / 127) * 1000) / 1000;
}

/** Map a knob across [lo, hi]. */
export function ccToRange(cc: number, lo: number, hi: number): number {
  const t = Math.max(0, Math.min(127, cc)) / 127;
  return lo + (hi - lo) * t;
}

/**
 * Move the selected pad's pitch or volume, or the start / end of its chop.
 * Returns the same project when there is nothing to edit.
 */
export function applyControl(p: Project, target: MidiCcTarget, cc: number): Project {
  const pad = p.pads.find((x) => x.id === p.selectedPadId);
  if (!pad) return p;
  if (target === "pitch") {
    const pitch = ccToPitch(cc);
    if (pitch === pad.pitch) return p;
    return { ...p, pads: p.pads.map((x) => (x.id === pad.id ? { ...x, pitch } : x)) };
  }
  if (target === "volume") {
    const volume = ccToVolume(cc);
    if (volume === pad.volume) return p;
    return { ...p, pads: p.pads.map((x) => (x.id === pad.id ? { ...x, volume } : x)) };
  }
  const slice = p.slices.find((s) => s.id === pad.sliceId);
  const src = p.sources.find((s) => s.id === slice?.sourceId);
  if (!slice || !src || src.durationSec <= MIN_CHOP) return p;
  let start = slice.start;
  let end = slice.end;
  if (target === "start") start = ccToRange(cc, 0, Math.max(0, end - MIN_CHOP));
  else end = ccToRange(cc, Math.min(src.durationSec, start + MIN_CHOP), src.durationSec);
  start = Math.round(start * 1000) / 1000;
  end = Math.round(end * 1000) / 1000;
  if (end - start < MIN_CHOP || (start === slice.start && end === slice.end)) return p;
  return {
    ...p,
    slices: p.slices.map((s) => (s.id === slice.id ? { ...s, start, end } : s)),
  };
}

const GRID: Record<Project["quantize"], number | null> = {
  off: null,
  "1/8": 2,
  "1/16": 1,
  "1/32": 0.5,
};

/**
 * Where a recorded hit is written. Quantize snaps it onto the project's grid (the played offset
 * is kept only while quantize is off). Swing stays a playback concern, the same as every other hit.
 */
export function recordedPosition(
  quantize: Project["quantize"],
  lengthSteps: number,
  posSteps: number,
): { step: number; offset: number } {
  const raw = recordPosition(posSteps, lengthSteps);
  const g = GRID[quantize];
  if (g == null) return raw;
  let s = Math.round((raw.step + raw.offset) / g) * g;
  s = ((s % lengthSteps) + lengthSteps) % lengthSteps;
  s = Math.round(s * 1000) / 1000;
  return { step: s, offset: 0 };
}

/** Append one ordinary note. The previous project is what Undo restores. */
export function withRecordedHit(
  p: Project,
  padId: string,
  velocity: number,
  posSteps: number,
  id: string,
): Project {
  const pat = p.patterns.find((x) => x.id === p.currentPatternId);
  if (!pat) return p;
  const at = recordedPosition(p.quantize, pat.lengthSteps, posSteps);
  const note: NoteEvent = {
    id,
    padId,
    step: at.step,
    offset: at.offset,
    velocity: Math.max(1, Math.min(127, Math.round(velocity))),
  };
  return {
    ...p,
    patterns: p.patterns.map((pt) =>
      pt.id !== pat.id ? pt : { ...pt, notes: [...pt.notes, note] },
    ),
  };
}

/** Drop impossible notes and duplicate knob targets from a saved project. */
export function normalizeMidi(raw: unknown): MidiMap {
  const m = (raw ?? {}) as Partial<MidiMap>;
  const notes: Record<string, number> = {};
  if (m.notes && typeof m.notes === "object") {
    for (const [id, v] of Object.entries(m.notes)) if (ownedNote(v)) notes[id] = v;
  }
  const ccs: MidiCcBinding[] = [];
  if (Array.isArray(m.ccs)) {
    for (const c of m.ccs) {
      if (!c || typeof c !== "object") continue;
      if (!ownedNote(c.cc) || !Number.isInteger(c.channel) || c.channel < 1 || c.channel > 16)
        continue;
      if (!TARGETS.includes(c.target)) continue;
      if (ccs.some((x) => x.target === c.target)) continue;
      ccs.push({ cc: c.cc, channel: c.channel, target: c.target });
    }
  }
  return { notes, ccs };
}
