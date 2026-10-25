/**
 * Hum sessions: bring in a beat bounced from a DAW, then hum / beatbox new parts over it and send
 * those parts back. Pure project edits (unit-tested); the Hum tab drives them.
 *
 * The beat plays as one long hit on a backing pad at step 0 of the session pattern, so the normal
 * transport, Timeline and export all work on it unchanged. A session is its own project with its
 * own tempo — independent of any sampler project.
 */
import { createEmptyProject } from "./demo";
import {
  MAX_PATTERN_BARS,
  type NoteEvent,
  type Pad,
  type Project,
  type SourceAsset,
} from "./types";
import { effectiveStep, stepDur } from "./timing";

/** The backing sits on the last pad of the last bank, out of the way of the layers. */
const BACKING_PAD = "D16";

/** Steps (whole bars) a beat of `seconds` needs at `bpm`. */
export const stepsForSeconds = (seconds: number, bpm: number) =>
  Math.min(MAX_PATTERN_BARS * 16, Math.max(16, Math.ceil(seconds / stepDur(bpm) / 16 - 1e-9) * 16));

/** A new project holding `asset` (already imported) as the backing of a Hum session at `bpm`. */
export function startHumSession(
  asset: SourceAsset,
  bpm: number,
  ids: { slice: string; note: string },
): Project {
  const base = createEmptyProject(`Hum · ${asset.name.replace(/\.[^.]+$/, "")}`);
  const pattern = base.patterns[0];
  const backing: Pad = {
    ...base.pads.find((x) => x.id === BACKING_PAD)!,
    sliceId: ids.slice,
    mode: "oneshot",
    lengthUnit: "off",
    pitch: 0,
    reverse: false,
    volume: 0.8,
    attack: 0,
    release: 0,
  };
  return {
    ...base,
    bpm,
    sources: [asset],
    activeSourceId: asset.id,
    markers: { [asset.id]: [] },
    slices: [
      { id: ids.slice, sourceId: asset.id, name: "Your beat", start: 0, end: asset.durationSec },
    ],
    pads: base.pads.map((x) => (x.id === BACKING_PAD ? backing : x)),
    selectedPadId: null,
    patterns: [
      {
        ...pattern,
        name: "Hum session",
        lengthSteps: stepsForSeconds(asset.durationSec, bpm),
        lanes: [{ padId: BACKING_PAD, mute: false, solo: false }],
        notes: [
          { id: ids.note, padId: BACKING_PAD, step: 0, velocity: 127, offset: 0, exact: true },
        ],
      },
    ],
    export: {
      ...base.export,
      mode: "stems",
      range: "pattern",
      patternRepeats: 1,
      includeTails: true,
    },
    humSession: { patternId: pattern.id, backingPadId: BACKING_PAD },
  };
}

/** Change the session tempo (to match the DAW); the pattern is resized to the beat's length. Layers keep their bar positions. */
export function setHumTempo(p: Project, bpm: number): Project {
  const hs = p.humSession;
  if (!hs || !(bpm >= 40 && bpm <= 300)) return p;
  const backing = p.pads.find((x) => x.id === hs.backingPadId);
  const slice = p.slices.find((s) => s.id === backing?.sliceId);
  const seconds = slice ? slice.end - slice.start : 0;
  return {
    ...p,
    bpm,
    patterns: p.patterns.map((pt) =>
      pt.id === hs.patternId
        ? {
            ...pt,
            lengthSteps: Math.max(
              stepsForSeconds(seconds, bpm),
              ...pt.notes.map((n) => Math.ceil((n.step + 0.5) / 16) * 16),
            ),
          }
        : pt,
    ),
  };
}

/** Pads with hummed / beatboxed hits in the session (everything but the backing). */
export function humLayers(p: Project): Pad[] {
  const hs = p.humSession;
  const pat = p.patterns.find((x) => x.id === hs?.patternId);
  if (!hs || !pat) return [];
  const used = new Set(pat.notes.map((n) => n.padId));
  return p.pads.filter((x) => x.id !== hs.backingPadId && used.has(x.id));
}

/** Remove the given pads' hits between steps `from` and `to` (a section to redo). */
export function clearSection(p: Project, padIds: string[], from: number, to: number): Project {
  const hs = p.humSession;
  if (!hs) return p;
  const ids = new Set(padIds);
  return {
    ...p,
    patterns: p.patterns.map((pt) => {
      if (pt.id !== hs.patternId) return pt;
      const keep = (n: NoteEvent) => {
        if (!ids.has(n.padId)) return true;
        const at = effectiveStep(n, p.quantize, p.swing, pt.lengthSteps);
        return at < from || at >= to;
      };
      return { ...pt, notes: pt.notes.filter(keep) };
    }),
  };
}
