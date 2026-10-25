/**
 * Offline export: a stereo mix plus (optionally) one stereo file per pad, all 24-bit WAV,
 * all starting at 0:00 (bar 1) and all exactly the same length, so they line up when dropped
 * at the session start in LUNA or Pro Tools.
 *
 * Every hit's start and cut-off time is computed up front from timing.ts, so a pad rendered
 * alone (stem) behaves exactly as it does inside the mix and the stems sum back to the mix.
 */
import type { RenderService, RenderedFile } from "./services";
import {
  eventsInRange,
  holdEnds,
  lengthBeats,
  padForHit,
  patternSections,
  sectionsLength,
  songSections,
  stepDur,
  type ScheduledHit,
  type Section,
} from "./timing";
import { CHOKE_FADE, MIN_ATTACK, MIN_RELEASE, padSource, prepareStretches, startVoice } from "./voice";
import { audioStore } from "./audioStore";
import { encodeWav24 } from "./wav";
import type { Pad, Project } from "./types";

export interface PlannedHit extends ScheduledHit {
  time: number;
  /** Absolute seconds the hit is cut (hold end or choke), if any. */
  stopAt?: number;
  stopFade?: number;
}

export function exportSections(p: Project): Section[] {
  return p.export.range === "song"
    ? songSections(p)
    : patternSections(p, Math.max(1, p.export.patternRepeats));
}

/** Pure: every hit in the export with its absolute start / stop. */
export function planHits(
  p: Project,
  sections: Section[],
): { hits: PlannedHit[]; musicSec: number } {
  const total = sectionsLength(sections);
  const sd = stepDur(p.bpm);
  const raw = eventsInRange(p, sections, 0, total, false);
  const holds = holdEnds(raw, total);
  const padById = new Map(p.pads.map((x) => [x.id, x]));
  const hits: PlannedHit[] = raw.map((h) => {
    const pad = padById.get(h.padId);
    const out: PlannedHit = { ...h, time: h.at * sd };
    if (h.length) out.stopAt = (h.at + h.length) * sd;
    else if (pad && pad.mode !== "oneshot")
      out.stopAt = (holds.get(h.noteId + "@" + h.at) ?? total) * sd;
    return out;
  });
  // chokes: a hit is cut by the next later hit in its choke group
  for (let i = 0; i < hits.length; i++) {
    const pad = padById.get(hits[i].padId);
    if (pad?.choke == null) continue;
    for (let j = i + 1; j < hits.length; j++) {
      if (hits[j].time <= hits[i].time) continue;
      if (padById.get(hits[j].padId)?.choke !== pad.choke) continue;
      if (hits[i].stopAt == null || hits[j].time < hits[i].stopAt!) {
        hits[i].stopAt = hits[j].time;
        hits[i].stopFade = CHOKE_FADE;
      }
      break;
    }
  }
  return { hits, musicSec: total * sd };
}

async function renderHits(
  p: Project,
  hits: PlannedHit[],
  frames: number,
  sampleRate: number,
): Promise<Float32Array[]> {
  const off = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate });
  const padById = new Map(p.pads.map((x) => [x.id, x]));
  for (const h of hits) {
    const base = padById.get(h.padId);
    if (!base) continue;
    const pad = padForHit(base, h);
    const ps = padSource(
      pad,
      p.slices.find((s) => s.id === pad.sliceId),
      p.bpm,
    );
    if (!ps) continue;
    startVoice(off, off.destination, pad, ps, h.velocity, h.time, h.stopAt, h.stopFade);
  }
  const buf = await off.startRendering();
  return [buf.getChannelData(0), buf.getChannelData(1)];
}

const safe = (s: string) =>
  s
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "_") || "untitled";

export async function renderProject(
  p: Project,
  onProgress?: (msg: string) => void,
): Promise<{
  files: RenderedFile[];
  channels: Float32Array[][];
  frames: number;
  sampleRate: number;
}> {
  const sampleRate = p.export.sampleRate;
  prepareStretches(p);
  const { hits, musicSec } = planHits(p, exportSections(p));
  if (!hits.length)
    throw new Error("Nothing to export — the pattern/song has no hits on assigned pads.");
  const tail = p.export.includeTails ? Math.max(0, p.export.tailSec) : 0;
  const frames = Math.max(1, Math.round((musicSec + tail) * sampleRate));
  const base = `${safe(p.name)}_${p.bpm}bpm`;
  const files: RenderedFile[] = [];
  const channels: Float32Array[][] = [];
  const add = (name: string, ch: Float32Array[], kind: RenderedFile["kind"]) => {
    // tempo tag: the session BPM, so a DAW reads 132 instead of guessing from the length
    const enc = encodeWav24(ch, sampleRate, { bpm: p.bpm, beats: (musicSec * p.bpm) / 60 });
    files.push({
      name,
      blob: new Blob([enc.bytes as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
      frames,
      peak: enc.peak,
      clipped: enc.clipped,
      kind,
    });
    channels.push(ch);
  };
  onProgress?.("Rendering stereo mix…");
  add(`${base}_Mix.wav`, await renderHits(p, hits, frames, sampleRate), "mix");
  if (p.export.mode === "stems") {
    const padIds = [...new Set(hits.map((h) => h.padId))].sort();
    for (const [i, id] of padIds.entries()) {
      const pad = p.pads.find((x) => x.id === id);
      const slice = p.slices.find((s) => s.id === pad?.sliceId);
      onProgress?.(`Rendering track ${i + 1}/${padIds.length} (${id})…`);
      add(
        `${base}_${String(i + 1).padStart(2, "0")}_${id}_${safe(slice?.name ?? "pad")}.wav`,
        await renderHits(
          p,
          hits.filter((h) => h.padId === id),
          frames,
          sampleRate,
        ),
        "stem",
      );
    }
  }
  return { files, channels, frames, sampleRate };
}

/** How a pad sample is exported: as the pad plays it, or the untouched cut from the recording. */
export type PadSampleMode = "pad" | "original";

/** File name for one pad's sample: pad, chop name, and its musical length when it is fitted. */
export function padSampleName(p: Project, pad: Pad, chopName: string, mode: PadSampleMode): string {
  const fit = mode === "pad" && pad.lengthUnit !== "off" ? `_${lengthBeats(pad)}beats_${p.bpm}bpm` : "";
  return `${safe(p.name)}_${pad.id}_${safe(chopName)}${fit}${mode === "original" ? "_original" : ""}.wav`;
}

/**
 * Every pad with a sound as its own WAV, no beat needed — to load into a DAW's sampler or drop on
 * a track. "pad": exactly what a tap plays (fit / stretch, pitch, reverse, fades), one pass, at
 * full level and centred so it can be mixed in the DAW. "original": the cut, untouched.
 * Pads whose recording isn't loaded on this device are listed in `skipped`.
 */
export async function renderPadSamples(
  p: Project,
  mode: PadSampleMode,
  onProgress?: (msg: string) => void,
): Promise<{ files: RenderedFile[]; skipped: string[] }> {
  const sampleRate = p.export.sampleRate;
  if (mode === "pad") prepareStretches(p);
  const pads = p.pads.filter((x) => x.sliceId);
  if (!pads.length) throw new Error("No pads have a sound yet — chop a recording onto the pads first.");
  const files: RenderedFile[] = [];
  const skipped: string[] = [];
  for (const [i, pad] of pads.entries()) {
    const slice = p.slices.find((s) => s.id === pad.sliceId);
    if (!slice || !audioStore.getBuffer(slice.sourceId)) {
      skipped.push(pad.id);
      continue;
    }
    onProgress?.(`Rendering pad ${i + 1}/${pads.length} (${pad.id})…`);
    let ch: Float32Array[];
    if (mode === "original") {
      const b = audioStore.getBuffer(slice.sourceId)!;
      const dur = slice.end - slice.start;
      const frames = Math.max(1, Math.ceil(dur * sampleRate));
      const off = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate });
      const src = off.createBufferSource();
      src.buffer = b;
      // only the app's own click-guard fades (2 ms in, 4 ms out); nothing else is changed
      const g = off.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(1, MIN_ATTACK);
      g.gain.setValueAtTime(1, Math.max(MIN_ATTACK, dur - MIN_RELEASE));
      g.gain.linearRampToValueAtTime(0, dur);
      src.connect(g).connect(off.destination);
      src.start(0, slice.start, dur);
      const out = await off.startRendering();
      ch = [out.getChannelData(0), out.getChannelData(1)];
    } else {
      // one pass of the pad as tapped, at full level and centred
      const one: Pad = { ...pad, mode: "oneshot", volume: 1, pan: 0 };
      const ps = padSource(one, slice, p.bpm)!;
      const frames = Math.max(1, Math.ceil(ps.playDuration * sampleRate));
      const off = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate });
      startVoice(off, off.destination, one, ps, 127, 0);
      const out = await off.startRendering();
      ch = [out.getChannelData(0), out.getChannelData(1)];
    }
    // A fitted pad is a loop of known beats at the project tempo; anything else is a one-shot,
    // tagged so a DAW doesn't guess a tempo from its length (a 0.45 s kick reads as 133.33 BPM).
    const fitted = mode === "pad" && pad.lengthUnit !== "off";
    const enc = encodeWav24(ch, sampleRate, fitted ? { bpm: p.bpm, beats: lengthBeats(pad) } : { bpm: p.bpm, oneShot: true });
    files.push({
      name: padSampleName(p, pad, slice.name, mode),
      blob: new Blob([enc.bytes as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
      frames: ch[0].length,
      peak: enc.peak,
      clipped: enc.clipped,
      kind: "stem",
    });
  }
  if (!files.length) throw new Error("None of the pads' recordings are loaded on this phone yet — open Chop and wait for the waveform.");
  return { files, skipped };
}

export const renderService: RenderService = {
  async renderWav(p, onProgress) {
    return (await renderProject(p, onProgress)).files;
  },
  renderPadSamples,
};
