import { audioStore } from "./audioStore";
import { BANKS, SCHEMA_VERSION, type Pad, type PadColor, type Project } from "./types";

export const DEMO_SOURCE_ID = "demo_source";

export function makePad(bank: (typeof BANKS)[number], index: number): Pad {
  const colors: PadColor[] = ["teal", "purple", "amber"];
  return {
    id: `${bank}${index + 1}`,
    bank,
    index,
    sliceId: null,
    color: colors[Math.floor(index / 4) % 2],
    volume: 0.8,
    pan: 0,
    pitch: 0,
    reverse: false,
    mode: "oneshot",
    choke: null,
    attack: 0.002,
    release: 0.05,
    timeMode: "repitch",
    lengthUnit: "off",
    lengthValue: 1,
    velocity: 100,
  };
}

/** Deterministic illustrative waveform. Flagged as demo — never analysis. */
function demoPeaks(bins = 2000) {
  const out = new Float32Array(bins);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < bins; i++) {
    const beat = (i % 62) / 62;
    const env = Math.exp(-beat * 5);
    out[i] = Math.min(1, 0.15 + env * 0.7 * (0.6 + rnd() * 0.4) + rnd() * 0.1);
  }
  return out;
}

export function createDemoProject(): Project {
  audioStore.setPeaks(DEMO_SOURCE_ID, demoPeaks(), true);
  const pads = BANKS.flatMap((b) => Array.from({ length: 16 }, (_, i) => makePad(b, i)));
  const slices = [
    { id: "sl1", sourceId: DEMO_SOURCE_ID, name: "Kick chop", start: 0.0, end: 0.42 },
    { id: "sl2", sourceId: DEMO_SOURCE_ID, name: "Snare hit", start: 0.95, end: 1.3 },
    { id: "sl3", sourceId: DEMO_SOURCE_ID, name: "Hat", start: 2.1, end: 2.25 },
    { id: "sl4", sourceId: DEMO_SOURCE_ID, name: "Keys stab", start: 4.0, end: 5.2 },
    { id: "sl5", sourceId: DEMO_SOURCE_ID, name: "Vox phrase", start: 8.0, end: 10.4 },
  ];
  slices.forEach((s, i) => (pads[i].sliceId = s.id));
  const n = (padId: string, step: number, velocity = 100) => ({
    id: `${padId}-${step}`,
    padId,
    step,
    velocity,
    offset: 0,
  });
  const lanes = ["A1", "A2", "A3", "A4", "A5"].map((padId) => ({ padId, mute: false, solo: false }));
  return {
    schemaVersion: SCHEMA_VERSION,
    name: "Demo — Night Drive",
    isDemo: true,
    bpm: 90,
    sources: [
      {
        id: DEMO_SOURCE_ID,
        name: "Demo source (no audio)",
        durationSec: 32,
        sampleRate: 48000,
        channels: 2,
        origin: "demo",
        persistence: "demo",
        detectedBpm: null,
      },
    ],
    activeSourceId: DEMO_SOURCE_ID,
    selection: { sourceId: DEMO_SOURCE_ID, start: 4.0, end: 5.2 },
    markers: { [DEMO_SOURCE_ID]: [0.95, 2.1, 4.0, 8.0] },
    slices,
    pads,
    selectedPadId: "A1",
    bank: "A",
    quantize: "1/16",
    swing: 54,
    noteRepeat: "off",
    patterns: [
      {
        id: "p1",
        name: "Pattern 1",
        lengthSteps: 16,
        lanes,
        notes: [
          n("A1", 0, 120), n("A1", 7, 90), n("A1", 10, 110),
          n("A2", 4), n("A2", 12),
          ...[0, 2, 4, 6, 8, 10, 12, 14].map((s) => n("A3", s, s % 4 ? 70 : 95)),
          n("A4", 0, 90), n("A5", 8, 85),
        ],
      },
      { id: "p2", name: "Pattern 2", lengthSteps: 16, lanes, notes: [n("A1", 0), n("A2", 4), n("A1", 8), n("A2", 12)] },
    ],
    currentPatternId: "p1",
    arrangement: [
      { id: "b1", patternId: "p2", label: "Intro" },
      { id: "b2", patternId: "p1", label: "Verse" },
      { id: "b3", patternId: "p1", label: "Hook" },
    ],
    export: { mode: "stereo", bitDepth: 24, sampleRate: 48000, range: "song", includeTails: true, tailSec: 2 },
  };
}
