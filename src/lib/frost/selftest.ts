/**
 * On-device proof checks. Run from Export → Device check on the iPhone itself; the report is the
 * evidence for "does the workflow actually work on this phone", not a unit test.
 *
 * 1. Export timing: renders a synthetic click project through the real export path, decodes the
 *    WAV bytes back, and compares every click with the sample position timing.ts predicts
 *    (quantized, swung, unquantized, repitched and stretched hits).
 * 2. Clean boundaries: renders each of your assigned pads alone and checks the hit starts and
 *    ends at silence.
 * 3. Reopen: saves the project, reads it back from IndexedDB, re-decodes the stored audio and
 *    compares it with what is in memory.
 */
import { audioStore } from "./audioStore";
import { makePad } from "./demo";
import { library } from "./persist";
import { planHits, exportSections, renderProject } from "./render";
import { playPlan } from "./timing";
import { decodeWav } from "./wav";
import { padSource, startVoice } from "./voice";
import { playbackService } from "./engine";
import { SCHEMA_VERSION, type Pad, type Project, type Slice } from "./types";

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const TEST_SRC = "__selftest_source";
const CLICKS = [0.1, 0.6, 1.1];
const LEAD = 0.005; // click sits 5 ms into each slice (after the 2 ms attack)

function testProject(sampleRate: number, quantize: Project["quantize"]): Project {
  const slices: Slice[] = CLICKS.map((t, i) => ({
    id: `ts${i}`,
    sourceId: TEST_SRC,
    name: `Click ${i + 1}`,
    start: t - LEAD,
    end: t + 0.2 + i * 0.1,
  }));
  const pad = (i: number, patch: Partial<Pad>): Pad => ({
    ...makePad("A", i),
    sliceId: slices[Math.min(i, 2)].id,
    release: 0.004,
    ...patch,
  });
  const pads = [
    pad(0, {}), // natural
    pad(1, { lengthUnit: "beats", lengthValue: 0.5, timeMode: "repitch" }),
    pad(2, { lengthUnit: "beats", lengthValue: 0.625, timeMode: "stretch" }), // ~1.3x stretch
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    name: "Self test",
    isDemo: false,
    bpm: 93.7,
    sources: [
      {
        id: TEST_SRC,
        name: "clicks",
        durationSec: 2,
        sampleRate,
        channels: 2,
        origin: "imported",
        persistence: "session-only",
        detectedBpm: null,
      },
    ],
    activeSourceId: TEST_SRC,
    selection: null,
    markers: {},
    beatGrids: {},
    slices,
    pads,
    selectedPadId: null,
    bank: "A",
    quantize,
    swing: 62,
    noteRepeat: "off",
    patterns: [
      {
        id: "tp",
        name: "Test",
        lengthSteps: 16,
        lanes: pads.map((p) => ({ padId: p.id, mute: false, solo: false })),
        notes: [
          { id: "n1", padId: "A1", step: 0, velocity: 127, offset: 0 },
          { id: "n2", padId: "A1", step: 6, velocity: 127, offset: 0 },
          { id: "n3", padId: "A2", step: 1, velocity: 127, offset: 0 }, // swung off-beat
          { id: "n4", padId: "A2", step: 9, velocity: 127, offset: 0.23 }, // played late
          { id: "n5", padId: "A3", step: 4, velocity: 127, offset: -0.18 }, // played early
          { id: "n6", padId: "A3", step: 12, velocity: 127, offset: 0 },
        ],
      },
    ],
    currentPatternId: "tp",
    arrangement: [],
    export: {
      mode: "stems",
      bitDepth: 24,
      sampleRate: sampleRate as 44100 | 48000,
      range: "pattern",
      patternRepeats: 2,
      includeTails: true,
      tailSec: 0.5,
    },
  };
}

function clickSource(sampleRate: number): AudioBuffer {
  const b = new AudioBuffer({ length: sampleRate * 2, numberOfChannels: 2, sampleRate });
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (const t of CLICKS) d[Math.round(t * sampleRate)] = 0.9;
  }
  return b;
}

/** First sample within ±radius that reaches half the local peak (ignores later stretch echoes). */
function onsetNear(x: Float32Array, center: number, radius: number): number {
  const a = Math.max(0, center - radius),
    b = Math.min(x.length, center + radius);
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = a; i < b; i++) if (Math.abs(x[i]) >= peak * 0.5) return i;
  return center;
}

async function exportTiming(
  sampleRate: number,
  quantize: Project["quantize"],
): Promise<CheckResult[]> {
  const label = `${sampleRate / 1000} kHz, quantize ${quantize}`;
  const p = testProject(sampleRate, quantize);
  audioStore.setBuffer(TEST_SRC, clickSource(sampleRate));
  try {
    const { files } = await renderProject(p);
    const decoded = await Promise.all(
      files.map(async (f) => ({ f, w: decodeWav(new Uint8Array(await f.blob.arrayBuffer())) })),
    );
    const out: CheckResult[] = [];
    const { hits, musicSec } = planHits(p, exportSections(p));
    const expectedFrames = Math.round((musicSec + p.export.tailSec) * sampleRate);

    const fmtOk = decoded.every(
      ({ w }) => w.bitsPerSample === 24 && w.sampleRate === sampleRate && w.channels.length === 2,
    );
    const lenOk = decoded.every(({ w }) => w.channels[0].length === expectedFrames);
    out.push({
      name: `Export files (${label})`,
      pass: fmtOk && lenOk && decoded.length === 4,
      detail: `${decoded.length} files (mix + 3 tracks), 24-bit ${fmtOk ? "✓" : "✗"}, all ${expectedFrames} frames ${lenOk ? "✓" : "✗ " + decoded.map(({ w }) => w.channels[0].length).join("/")}`,
    });

    const mix = decoded.find(({ f }) => f.kind === "mix")!.w.channels[0];
    let worst = 0;
    const errs: string[] = [];
    for (const h of hits) {
      const pad = p.pads.find((x) => x.id === h.padId)!;
      const plan = playPlan(
        pad,
        p.slices.find((s) => s.id === pad.sliceId)!,
        p.bpm,
      );
      const lead = plan.stretch != null ? LEAD : LEAD / plan.rate;
      const expected = (h.time + lead) * sampleRate;
      const got = onsetNear(mix, Math.round(expected), Math.round(0.008 * sampleRate));
      const err = got - expected;
      worst = Math.max(worst, Math.abs(err));
      if (Math.abs(err) > 1.5) errs.push(`${h.padId}@${h.at.toFixed(2)} off by ${err.toFixed(1)}`);
    }
    out.push({
      name: `Hit timing in mix (${label})`,
      pass: errs.length === 0,
      detail: `${hits.length} hits, worst error ${worst.toFixed(2)} samples (limit 1.5)${errs.length ? " — " + errs.join("; ") : ""}`,
    });

    const stems = decoded.filter(({ f }) => f.kind === "stem").map(({ w }) => w.channels);
    let maxDiff = 0;
    const mixW = decoded.find(({ f }) => f.kind === "mix")!.w.channels;
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < expectedFrames; i++) {
        let s = 0;
        for (const st of stems) s += st[c][i];
        maxDiff = Math.max(maxDiff, Math.abs(s - mixW[c][i]));
      }
    out.push({
      name: `Tracks sum to mix (${label})`,
      pass: maxDiff < 1e-4,
      detail: `max difference ${(20 * Math.log10(maxDiff + 1e-12)).toFixed(1)} dBFS (limit −80)`,
    });
    return out;
  } finally {
    audioStore.delete(TEST_SRC);
  }
}

const db = (x: number) => (x <= 0 ? "−∞" : (20 * Math.log10(x)).toFixed(0)) + " dBFS";

/** Each assigned pad of the user's project, rendered alone: does it start and end at silence? */
export async function boundaryCheck(p: Project): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const sr = 48000;
  for (const pad of p.pads) {
    const slice = p.slices.find((s) => s.id === pad.sliceId);
    const ps = padSource(pad, slice, p.bpm);
    if (!ps || pad.mode === "loop") continue;
    const len = Math.round((ps.playDuration + 0.05) * sr);
    const off = new OfflineAudioContext({ numberOfChannels: 2, length: len, sampleRate: sr });
    const when = 0.01;
    startVoice(
      off,
      off.destination,
      pad,
      ps,
      127,
      when,
      pad.mode === "gate" ? when + ps.playDuration : undefined,
    );
    const b = await off.startRendering();
    const x = b.getChannelData(0);
    const s0 = Math.round(when * sr);
    const e0 = Math.round((when + ps.playDuration) * sr);
    let first = 0,
      body = 0,
      endJump = 0;
    for (let i = s0; i < s0 + 2; i++) first = Math.max(first, Math.abs(x[i]));
    for (let i = s0; i < e0; i++) body = Math.max(body, Math.abs(x[i]));
    for (let i = Math.max(1, e0 - 2); i < Math.min(x.length, e0 + 48); i++)
      endJump = Math.max(endJump, Math.abs(x[i] - x[i - 1]));
    const pass = first < 0.01 && endJump < 0.02;
    out.push({
      name: `Pad ${pad.id} boundaries`,
      pass,
      detail: `start ${db(first)}, end step ${db(endJump)}, body peak ${db(body)}`,
    });
  }
  if (!out.length)
    out.push({
      name: "Pad boundaries",
      pass: true,
      detail: "No pads with audio assigned yet — assign chops and run again.",
    });
  return out;
}

/** Save → read back from IndexedDB → re-decode audio → compare. */
export async function reopenCheck(p: Project, key: string): Promise<CheckResult[]> {
  if (p.isDemo)
    return [
      {
        name: "Reopen",
        pass: true,
        detail: "Demo project isn't saved. Import audio first, then run again.",
      },
    ];
  await library.save(key, p);
  const back = await library.load(key);
  const same = !!back && JSON.stringify(back) === JSON.stringify(p);
  const out: CheckResult[] = [
    {
      name: "Project reopens identically",
      pass: same,
      detail: same
        ? "Saved and re-read project matches field for field."
        : "Re-read project differs from memory.",
    },
  ];
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 1,
    sampleRate: playbackService.latencyInfo().sampleRate,
  });
  for (const s of p.sources) {
    if (s.origin !== "imported") continue;
    const mem = audioStore.getBuffer(s.id);
    const a = await library.getAudio(s.id);
    if (!a || !mem) {
      out.push({
        name: `Audio “${s.name}”`,
        pass: false,
        detail: a
          ? "Not loaded in memory."
          : `Not stored on device (persistence: ${s.persistence}). Re-import it.`,
      });
      continue;
    }
    const re = await ctx.decodeAudioData(a.bytes.slice(0));
    let diff = re.length === mem.length ? 0 : Infinity;
    if (diff === 0) {
      const x = re.getChannelData(0),
        y = mem.getChannelData(0);
      for (let i = 0; i < x.length; i += 97) diff = Math.max(diff, Math.abs(x[i] - y[i]));
    }
    out.push({
      name: `Audio “${s.name}” reopens sample-exact`,
      pass: diff < 1e-6,
      detail:
        diff === Infinity
          ? `length ${re.length} vs ${mem.length} frames`
          : `${re.length} frames, max diff ${diff.toExponential(1)}`,
    });
  }
  return out;
}

export async function runDeviceCheck(
  p: Project,
  key: string,
  onProgress: (m: string) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const li = playbackService.latencyInfo();
  results.push({
    name: "Audio device",
    pass: true,
    detail: `${li.sampleRate} Hz, base latency ${(li.baseLatency * 1000).toFixed(1)} ms, output latency ${(li.outputLatency * 1000).toFixed(1)} ms`,
  });
  for (const [sr, q] of [
    [48000, "1/16"],
    [48000, "off"],
    [44100, "1/16"],
  ] as const) {
    onProgress(`Export timing ${sr / 1000} kHz, quantize ${q}…`);
    try {
      results.push(...(await exportTiming(sr, q)));
    } catch (e) {
      results.push({
        name: `Export timing ${sr / 1000} kHz`,
        pass: false,
        detail: (e as Error).message,
      });
    }
  }
  onProgress("Pad boundaries…");
  try {
    results.push(...(await boundaryCheck(p)));
  } catch (e) {
    results.push({ name: "Pad boundaries", pass: false, detail: (e as Error).message });
  }
  onProgress("Save and reopen…");
  try {
    results.push(...(await reopenCheck(p, key)));
  } catch (e) {
    results.push({ name: "Reopen", pass: false, detail: (e as Error).message });
  }
  return results;
}
