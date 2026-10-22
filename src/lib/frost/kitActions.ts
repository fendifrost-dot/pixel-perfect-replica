/**
 * Pure project updates for putting a built-in drum on a pad. The drum becomes a `kit` source with
 * one slice covering the hit, so from here on it is a pad like any chop.
 */
import type { Pad, Project, Slice, SourceAsset } from "./types";

export interface LoadedDrum {
  asset: SourceAsset;
  slice: Omit<Slice, "id">;
  /** Starting pad volume for this drum. */
  level: number;
}

/** Pad volume as created by makePad; a pad still at this value has not been mixed by the user. */
const DEFAULT_PAD_VOLUME = 0.8;

/** First empty pad in `bank` (A1 before A2 …), else null. */
export function nextEmptyPad(p: Project, bank: Pad["bank"]): Pad | null {
  return p.pads.filter((x) => x.bank === bank && !x.sliceId).sort((a, b) => a.index - b.index)[0] ?? null;
}

/**
 * Assign `drum` to pad `padId`. Adds the source once (shared by every pad that uses the same drum),
 * adds a slice, and if the pad was set up for a chop (reverse, tempo-fit…) resets those so the
 * drum plays as itself. Pan and choke are kept since they belong to the pad's role in the beat, and so
 * is volume once the user has moved it; an untouched pad takes the drum's own starting level.
 */
export function assignDrum(p: Project, padId: string, drum: LoadedDrum, sliceId: string): Project {
  const sources = p.sources.some((s) => s.id === drum.asset.id) ? p.sources : [...p.sources, drum.asset];
  const slice: Slice = { id: sliceId, ...drum.slice };
  return {
    ...p,
    // A beat made only of drums is a real project: leave the unsaved "new" state so autosave starts.
    isDemo: false,
    sources,
    slices: [...p.slices, slice],
    pads: p.pads.map((x) =>
      x.id === padId
        ? { ...x, sliceId, reverse: false, lengthUnit: "off", pitch: 0, mode: "oneshot", volume: x.volume === DEFAULT_PAD_VOLUME ? drum.level : x.volume }
        : x,
    ),
    selectedPadId: padId,
  };
}

/** Add a lane row for `padId` to the current pattern if it has none, so the drum shows on Beat. */
export function ensureLane(p: Project, padId: string): Project {
  return {
    ...p,
    patterns: p.patterns.map((pt) =>
      pt.id !== p.currentPatternId || pt.lanes.some((l) => l.padId === padId)
        ? pt
        : { ...pt, lanes: [...pt.lanes, { padId, mute: false, solo: false }] },
    ),
  };
}

/** Drop kit sources no pad or slice refers to any more (keeps the project tidy after "Empty this pad"). */
export function pruneKitSources(p: Project): Project {
  const used = new Set(p.pads.map((x) => x.sliceId).filter(Boolean) as string[]);
  const slices = p.slices.filter((s) => used.has(s.id) || p.sources.find((x) => x.id === s.sourceId)?.origin !== "kit");
  const liveSrc = new Set(slices.map((s) => s.sourceId));
  const sources = p.sources.filter((s) => s.origin !== "kit" || liveSrc.has(s.id));
  return sources.length === p.sources.length && slices.length === p.slices.length ? p : { ...p, sources, slices };
}
