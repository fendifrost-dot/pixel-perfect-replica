/**
 * Pure, validated project edits used by the MCP tools (and safe for the app to reuse).
 * Each takes a Project and returns a new Project; invalid input throws OpsError with a message an
 * assistant can act on. No I/O, no Web Audio — runs on the server.
 */
import { generateBeatGrid } from "./analysis";
import { createEmptyProject } from "./demo";
import { assignDrum, ensureLane } from "./kitActions";
import { findDrum, kitSourceId, KITS } from "./kits";
import {
  BANKS,
  type Bank,
  type Pad,
  type Pattern,
  type Project,
  type Slice,
  type SourceAsset,
} from "./types";

export class OpsError extends Error {}

const rid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

function must<T>(v: T | undefined | null, msg: string): T {
  if (v == null) throw new OpsError(msg);
  return v;
}

export function padOf(p: Project, padId: string): Pad {
  return must(
    p.pads.find((x) => x.id === padId.toUpperCase()),
    `Unknown pad "${padId}". Pads are A1–A16, B1–B16, C1–C16, D1–D16.`,
  );
}
export function patternOf(p: Project, patternId?: string): Pattern {
  const id = patternId ?? p.currentPatternId;
  return must(
    p.patterns.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase()),
    `Unknown pattern "${id}". Patterns: ${p.patterns.map((x) => `${x.id} (${x.name})`).join(", ")}.`,
  );
}
export function sourceOf(p: Project, sourceId: string): SourceAsset {
  return must(
    p.sources.find((s) => s.id === sourceId),
    `Unknown recording "${sourceId}". Recordings: ${p.sources.map((s) => `${s.id} (${s.name})`).join(", ") || "none"}.`,
  );
}

/** A compact, readable view of a project for assistants. */
export function summarize(p: Project) {
  const sliceById = new Map(p.slices.map((s) => [s.id, s]));
  return {
    name: p.name,
    bpm: p.bpm,
    feel: { quantize: p.quantize, swing: p.swing },
    recordings: p.sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.origin,
      durationSec: s.durationSec,
      beatMarkers: p.beatGrids[s.id]
        ? {
            bpm: p.beatGrids[s.id].bpm,
            count: p.beatGrids[s.id].beats.length,
            first: p.beatGrids[s.id].beats[0],
          }
        : null,
      chopMarkers: p.markers[s.id] ?? [],
    })),
    pads: p.pads
      .filter((x) => x.sliceId)
      .map((x) => {
        const s = sliceById.get(x.sliceId!);
        return {
          pad: x.id,
          chop: s
            ? { id: s.id, name: s.name, recording: s.sourceId, start: s.start, end: s.end }
            : null,
          fit: x.lengthUnit === "off" ? "off" : x.timeMode,
          lengthBeats:
            x.lengthUnit === "off"
              ? null
              : x.lengthUnit === "bars"
                ? x.lengthValue * 4
                : x.lengthValue,
          volume: x.volume,
          pan: x.pan,
          pitch: x.pitch,
          velocity: x.velocity,
          plays: x.mode === "oneshot" ? "whole" : x.mode === "gate" ? "held" : "loop",
          chokeGroup: x.choke ?? 0,
          reverse: x.reverse,
          fadeInMs: Math.round(x.attack * 1000),
          fadeOutMs: Math.round(x.release * 1000),
        };
      }),
    patterns: p.patterns.map((pt) => ({
      id: pt.id,
      name: pt.name,
      bars: pt.lengthSteps / 16,
      current: pt.id === p.currentPatternId,
      hits: [...pt.notes]
        .sort((a, b) => a.step + a.offset - (b.step + b.offset))
        .map((n) => ({ pad: n.padId, step: n.step, velocity: n.velocity, offset: n.offset })),
      muted: pt.lanes.filter((l) => l.mute).map((l) => l.padId),
      soloed: pt.lanes.filter((l) => l.solo).map((l) => l.padId),
    })),
    song: p.arrangement.map((b) => b.patternId),
    export: p.export,
  };
}

export function newProject(name: string, bpm = 90): Project {
  return { ...createEmptyProject(name), bpm: clampBpm(bpm) };
}

const clampBpm = (v: number) => {
  if (!(v >= 40 && v <= 300)) throw new OpsError("BPM must be between 40 and 300.");
  return Math.round(v * 10) / 10;
};

export interface ProjectFields {
  name?: string | undefined;
  bpm?: number | undefined;
  quantize?: Project["quantize"] | undefined;
  swing?: number | undefined;
  bank?: Bank | undefined;
}
export function setProjectFields(p: Project, f: ProjectFields): Project {
  const out = { ...p };
  if (f.name != null) out.name = f.name.trim() || p.name;
  if (f.bpm != null) out.bpm = clampBpm(f.bpm);
  if (f.quantize != null) out.quantize = f.quantize;
  if (f.swing != null) {
    if (!(f.swing >= 50 && f.swing <= 75)) throw new OpsError("Swing is 50–75 (%).");
    out.swing = Math.round(f.swing);
  }
  if (f.bank != null) out.bank = f.bank;
  return { ...out, isDemo: false };
}

export function addSource(p: Project, asset: SourceAsset): Project {
  return {
    ...p,
    isDemo: false,
    sources: [...p.sources.filter((s) => s.id !== asset.id), asset],
    activeSourceId: asset.id,
    markers: { ...p.markers, [asset.id]: p.markers[asset.id] ?? [] },
  };
}

export function setChopMarkers(p: Project, sourceId: string, times: number[]): Project {
  const s = sourceOf(p, sourceId);
  const clean = [
    ...new Set(
      times
        .filter((t) => t > 0 && (!s.durationSec || t < s.durationSec))
        .map((t) => Math.round(t * 1e6) / 1e6),
    ),
  ].sort((a, b) => a - b);
  return { ...p, markers: { ...p.markers, [sourceId]: clean } };
}

export interface Region {
  start: number;
  end: number;
  name?: string | undefined;
}

/**
 * Create chops from regions of a recording and put them on pads. With `pads`, region i goes on pads[i];
 * otherwise consecutive pads from `startPad` (default the first pad of `bank`, default A). Replaces what
 * those pads held.
 */
export function makeChops(
  p: Project,
  sourceId: string,
  regions: Region[],
  opts: {
    pads?: string[] | undefined;
    startPad?: string | undefined;
    bank?: Bank | undefined;
  } = {},
): { project: Project; assigned: { pad: string; chop: string }[] } {
  const src = sourceOf(p, sourceId);
  if (!regions.length) throw new OpsError("Give at least one region.");
  if (regions.length > 64) throw new OpsError("At most 64 chops at once.");
  let targets: string[];
  if (opts.pads?.length) {
    if (opts.pads.length < regions.length) throw new OpsError("Give one pad per region.");
    targets = opts.pads.map((x) => padOf(p, x).id);
  } else {
    const first = padOf(p, opts.startPad ?? `${opts.bank ?? "A"}1`);
    const order = p.pads.map((x) => x.id);
    const i0 = order.indexOf(first.id);
    targets = order.slice(i0, i0 + regions.length);
    if (targets.length < regions.length) throw new OpsError("Not enough pads after the start pad.");
  }
  const slices: Slice[] = regions.map((r, i) => {
    if (!(r.end > r.start && r.start >= 0))
      throw new OpsError(`Region ${i + 1}: end must be after start (seconds).`);
    if (src.durationSec && r.start >= src.durationSec)
      throw new OpsError(
        `Region ${i + 1} starts after the recording ends (${src.durationSec.toFixed(2)} s).`,
      );
    return {
      id: rid("sl"),
      sourceId,
      name: r.name?.trim() || `Chop ${p.slices.length + i + 1}`,
      start: r.start,
      end: src.durationSec ? Math.min(r.end, src.durationSec) : r.end,
    };
  });
  const byPad = new Map(targets.map((t, i) => [t, slices[i]]));
  return {
    project: {
      ...p,
      isDemo: false,
      slices: [...p.slices, ...slices],
      pads: p.pads.map((x) => (byPad.has(x.id) ? { ...x, sliceId: byPad.get(x.id)!.id } : x)),
    },
    assigned: targets.map((t, i) => ({ pad: t, chop: slices[i].name })),
  };
}

/** Chops between consecutive cut points (seconds), including the range ends. */
export function regionsFromCuts(cuts: number[], start: number, end: number): Region[] {
  const b = [
    start,
    ...cuts.filter((c) => c > start + 0.01 && c < end - 0.01).sort((a, c) => a - c),
    end,
  ];
  return b.slice(0, -1).map((s, i) => ({ start: s, end: b[i + 1] }));
}

export interface PadPatch {
  chopName?: string | undefined;
  fit?: "off" | "stretch" | "repitch" | undefined;
  lengthBeats?: number | undefined;
  volume?: number | undefined;
  pan?: number | undefined;
  pitch?: number | undefined;
  velocity?: number | undefined;
  plays?: "whole" | "held" | "loop" | undefined;
  chokeGroup?: number | undefined;
  reverse?: boolean | undefined;
  fadeInMs?: number | undefined;
  fadeOutMs?: number | undefined;
  empty?: boolean | undefined;
}

export function setPad(p: Project, padId: string, f: PadPatch): Project {
  const pad = padOf(p, padId);
  if (f.empty)
    return { ...p, pads: p.pads.map((x) => (x.id === pad.id ? { ...x, sliceId: null } : x)) };
  const next: Pad = { ...pad };
  const range = (v: number, lo: number, hi: number, what: string) => {
    if (!(v >= lo && v <= hi)) throw new OpsError(`${what} must be ${lo}–${hi}.`);
    return v;
  };
  if (f.volume != null) next.volume = range(f.volume, 0, 1, "volume");
  if (f.pan != null) next.pan = range(f.pan, -1, 1, "pan");
  if (f.pitch != null) next.pitch = Math.round(range(f.pitch, -24, 24, "pitch (semitones)"));
  if (f.velocity != null) next.velocity = Math.round(range(f.velocity, 1, 127, "velocity"));
  if (f.plays != null)
    next.mode = f.plays === "whole" ? "oneshot" : f.plays === "held" ? "gate" : "loop";
  if (f.chokeGroup != null)
    next.choke = Math.round(range(f.chokeGroup, 0, 4, "chokeGroup")) || null;
  if (f.reverse != null) next.reverse = f.reverse;
  if (f.fadeInMs != null) next.attack = range(f.fadeInMs, 0, 500, "fadeInMs") / 1000;
  if (f.fadeOutMs != null) next.release = range(f.fadeOutMs, 0, 2000, "fadeOutMs") / 1000;
  if (f.lengthBeats != null) {
    const b = range(f.lengthBeats, 0.25, 128, "lengthBeats");
    if (b >= 4 && b % 4 === 0) {
      next.lengthUnit = "bars";
      next.lengthValue = b / 4;
    } else {
      next.lengthUnit = "beats";
      next.lengthValue = b;
    }
    if (f.fit == null && pad.lengthUnit === "off") next.timeMode = "stretch";
  }
  if (f.fit != null) {
    if (f.fit === "off") next.lengthUnit = "off";
    else {
      next.timeMode = f.fit;
      if (next.lengthUnit === "off") {
        next.lengthUnit = "beats";
        next.lengthValue = 1;
      }
    }
  }
  let slices = p.slices;
  if (f.chopName != null) {
    const sid = must(pad.sliceId, `Pad ${pad.id} is empty; there is no chop to rename.`);
    slices = slices.map((s) => (s.id === sid ? { ...s, name: f.chopName!.trim() || s.name } : s));
  }
  return { ...p, slices, pads: p.pads.map((x) => (x.id === pad.id ? next : x)) };
}

export function setBeatMarkers(
  p: Project,
  sourceId: string,
  bpm: number,
  firstBeat: number,
): Project {
  const s = sourceOf(p, sourceId);
  if (!s.durationSec)
    throw new OpsError(
      "This recording's length isn't known yet — open the project in the app once, then try again.",
    );
  return {
    ...p,
    beatGrids: {
      ...p.beatGrids,
      [sourceId]: generateBeatGrid(clampBpm(bpm), Math.max(0, firstBeat), s.durationSec),
    },
  };
}

/** Put a built-in drum on a pad. Duration comes from rendering the (deterministic) drum once. */
export function addKitDrum(p: Project, padId: string, kitId: string, drumId: string): Project {
  const found = must(
    findDrum(kitId, drumId),
    `Unknown drum. Kits: ${KITS.map((k) => `${k.id} [${k.drums.map((d) => d.id).join(", ")}]`).join("; ")}.`,
  );
  const sr = 48000;
  const duration = found.drum.render(sr).length / sr;
  const id = kitSourceId(kitId, drumId);
  const pad = padOf(p, padId);
  const out = assignDrum(
    p,
    pad.id,
    {
      asset: {
        id,
        name: `${found.kit.name} · ${found.drum.name}`,
        durationSec: duration,
        sampleRate: sr,
        channels: 1,
        origin: "kit",
        persistence: "generated",
        detectedBpm: null,
      },
      slice: { sourceId: id, name: found.drum.name, start: 0, end: duration },
      level: found.drum.level,
    },
    rid("sl"),
  );
  return ensureLane(out, pad.id);
}

export const kitCatalog = () =>
  KITS.map((k) => ({
    kit: k.id,
    name: k.name,
    about: k.blurb,
    drums: k.drums.map((d) => ({ id: d.id, name: d.name })),
  }));

const barsToSteps = (bars: number) => {
  if (![1, 2, 4].includes(bars)) throw new OpsError("Pattern length is 1, 2 or 4 bars.");
  return (bars * 16) as Pattern["lengthSteps"];
};

export function addPattern(
  p: Project,
  opts: {
    name?: string | undefined;
    bars?: number | undefined;
    copyFrom?: string | undefined;
    makeCurrent?: boolean | undefined;
  },
): { project: Project; patternId: string } {
  const id = rid("pt");
  const base = opts.copyFrom ? patternOf(p, opts.copyFrom) : null;
  const pat: Pattern = base
    ? {
        ...base,
        id,
        name: opts.name ?? `Pattern ${p.patterns.length + 1}`,
        notes: base.notes.map((n) => ({ ...n, id: rid("n") })),
        lanes: base.lanes.map((l) => ({ ...l })),
      }
    : {
        id,
        name: opts.name ?? `Pattern ${p.patterns.length + 1}`,
        lengthSteps: barsToSteps(opts.bars ?? 2),
        lanes: [],
        notes: [],
      };
  if (base && opts.bars != null) pat.lengthSteps = barsToSteps(opts.bars);
  return {
    project: {
      ...p,
      patterns: [...p.patterns, pat],
      currentPatternId: opts.makeCurrent === false ? p.currentPatternId : id,
    },
    patternId: id,
  };
}

const mapPattern = (p: Project, id: string, fn: (pt: Pattern) => Pattern): Project => ({
  ...p,
  patterns: p.patterns.map((x) => (x.id === id ? fn(x) : x)),
});

export function editPattern(
  p: Project,
  patternId: string | undefined,
  f: {
    name?: string | undefined;
    bars?: number | undefined;
    clear?: boolean | undefined;
    makeCurrent?: boolean | undefined;
  },
): Project {
  const pt = patternOf(p, patternId);
  let out = mapPattern(p, pt.id, (x) => {
    const lengthSteps = f.bars != null ? barsToSteps(f.bars) : x.lengthSteps;
    return {
      ...x,
      name: f.name?.trim() || x.name,
      lengthSteps,
      notes: f.clear ? [] : x.notes.filter((n) => n.step < lengthSteps),
    };
  });
  if (f.makeCurrent) out = { ...out, currentPatternId: pt.id };
  return out;
}

export function deletePattern(p: Project, patternId: string): Project {
  const pt = patternOf(p, patternId);
  if (p.patterns.length === 1) throw new OpsError("A project needs at least one pattern.");
  const patterns = p.patterns.filter((x) => x.id !== pt.id);
  return {
    ...p,
    patterns,
    currentPatternId: p.currentPatternId === pt.id ? patterns[0].id : p.currentPatternId,
    arrangement: p.arrangement.filter((b) => b.patternId !== pt.id),
  };
}

export interface HitInput {
  pad: string;
  step: number;
  velocity?: number | undefined;
  offset?: number | undefined;
}

/** Add hits (step = 16th note from pattern start, 0-based). An existing hit on the same pad+step is replaced. */
export function addHits(p: Project, patternId: string | undefined, hits: HitInput[]): Project {
  const pt = patternOf(p, patternId);
  const notes = [...pt.notes];
  for (const h of hits) {
    const pad = padOf(p, h.pad);
    const step = Math.round(h.step);
    if (!(step >= 0 && step < pt.lengthSteps))
      throw new OpsError(
        `Step ${h.step} is outside this ${pt.lengthSteps / 16}-bar pattern (0–${pt.lengthSteps - 1}).`,
      );
    const velocity =
      h.velocity == null ? pad.velocity : Math.round(Math.min(127, Math.max(1, h.velocity)));
    const offset = h.offset == null ? 0 : Math.min(0.49, Math.max(-0.5, h.offset));
    const i = notes.findIndex((n) => n.padId === pad.id && n.step === step);
    const note = { id: i >= 0 ? notes[i].id : rid("n"), padId: pad.id, step, velocity, offset };
    if (i >= 0) notes[i] = note;
    else notes.push(note);
  }
  return mapPattern(p, pt.id, (x) => ({ ...x, notes }));
}

/** Remove hits of `pad` at `steps` (or all of that pad's hits when steps is omitted). */
export function removeHits(
  p: Project,
  patternId: string | undefined,
  pad: string,
  steps?: number[],
): Project {
  const pt = patternOf(p, patternId);
  const id = padOf(p, pad).id;
  const set = steps ? new Set(steps.map(Math.round)) : null;
  return mapPattern(p, pt.id, (x) => ({
    ...x,
    notes: x.notes.filter((n) => n.padId !== id || (set != null && !set.has(n.step))),
  }));
}

export function setLane(
  p: Project,
  patternId: string | undefined,
  pad: string,
  f: { mute?: boolean | undefined; solo?: boolean | undefined },
): Project {
  const pt = patternOf(p, patternId);
  const id = padOf(p, pad).id;
  const cur = pt.lanes.find((l) => l.padId === id) ?? { padId: id, mute: false, solo: false };
  const lane = {
    ...cur,
    ...(f.mute != null ? { mute: f.mute } : {}),
    ...(f.solo != null ? { solo: f.solo } : {}),
  };
  return mapPattern(p, pt.id, (x) => ({
    ...x,
    lanes: [...x.lanes.filter((l) => l.padId !== id), lane],
  }));
}

export function setSong(p: Project, patternIds: string[]): Project {
  const blocks = patternIds.map((id) => ({
    id: rid("b"),
    patternId: patternOf(p, id).id,
    label: "",
  }));
  return { ...p, arrangement: blocks };
}

type ExportPatch = {
  [K in "mode" | "sampleRate" | "range" | "patternRepeats" | "tailSec"]?:
    Project["export"][K] | undefined;
};
export function setExport(p: Project, f: ExportPatch): Project {
  const defined = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
  const e = { ...p.export, ...defined };
  if (![44100, 48000].includes(e.sampleRate)) throw new OpsError("sampleRate is 44100 or 48000.");
  if (!(e.patternRepeats >= 1 && e.patternRepeats <= 64))
    throw new OpsError("patternRepeats is 1–64.");
  if (!(e.tailSec >= 0 && e.tailSec <= 10)) throw new OpsError("tailSec is 0–10.");
  return { ...p, export: { ...e, includeTails: e.tailSec > 0 } };
}

export const PAD_IDS = BANKS.flatMap((b) => Array.from({ length: 16 }, (_, i) => `${b}${i + 1}`));
