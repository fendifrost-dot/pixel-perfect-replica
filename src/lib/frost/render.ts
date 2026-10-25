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
  patternSections,
  sectionsLength,
  songSections,
  stepDur,
  type ScheduledHit,
  type Section,
} from "./timing";
import { CHOKE_FADE, padSource, prepareStretches, startVoice } from "./voice";
import { encodeWav24 } from "./wav";
import type { Project } from "./types";

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
    const pad = padById.get(h.padId);
    if (!pad) continue;
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
    const enc = encodeWav24(ch, sampleRate);
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

export const renderService: RenderService = {
  async renderWav(p, onProgress) {
    return (await renderProject(p, onProgress)).files;
  },
};
