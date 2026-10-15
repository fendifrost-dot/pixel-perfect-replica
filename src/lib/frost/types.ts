/** Frost Sampler project data model. Bump SCHEMA_VERSION on breaking changes. */
export const SCHEMA_VERSION = 2;

export type Bank = "A" | "B" | "C" | "D";
export const BANKS: Bank[] = ["A", "B", "C", "D"];

export interface SourceAsset {
  id: string;
  name: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  /** demo = bundled illustrative data, imported = decoded from a user file */
  origin: "demo" | "imported";
  /**
   * device = original file bytes are saved in this browser's IndexedDB and re-decoded on reopen.
   * session-only = bytes were not saved (storage refused / full); re-import needed after reload.
   */
  persistence: "demo" | "session-only" | "device";
  /** Suggested source BPM from onset analysis (a suggestion, never applied automatically). Separate from project BPM. */
  detectedBpm: number | null;
}

export interface Slice {
  id: string;
  sourceId: string;
  name: string;
  start: number; // seconds, in source
  end: number;
}

export type PadColor = "teal" | "purple" | "amber";
export type PlayMode = "oneshot" | "gate" | "loop";
export type TimeMode = "repitch" | "stretch";
export type LengthUnit = "off" | "beats" | "bars";

export interface Pad {
  id: string; // e.g. "A1"
  bank: Bank;
  index: number; // 0..15
  sliceId: string | null;
  color: PadColor;
  volume: number; // 0..1
  pan: number; // -1..1
  pitch: number; // semitones -24..24
  reverse: boolean;
  mode: PlayMode;
  choke: number | null; // 1..4
  attack: number; // seconds
  release: number; // seconds
  timeMode: TimeMode;
  lengthUnit: LengthUnit;
  lengthValue: number;
  velocity: number; // 1..127, editable default velocity
}

export interface NoteEvent {
  id: string;
  padId: string;
  /** 16th-note step within the pattern. */
  step: number;
  velocity: number; // 1..127
  /**
   * Played timing offset in fractions of a step (-0.5..0.5), kept as played.
   * Performance quantize (Project.quantize) is applied at playback/export, never written here,
   * so turning quantize off brings the original feel back.
   */
  offset: number;
}

export interface Lane {
  padId: string;
  mute: boolean;
  solo: boolean;
}

export interface Pattern {
  id: string;
  name: string;
  lengthSteps: 16 | 32 | 64;
  lanes: Lane[];
  notes: NoteEvent[];
}

export interface ArrangementBlock {
  id: string;
  patternId: string;
  label: string;
}

export interface ExportSettings {
  /** stereo = mix only; stems = mix plus one aligned file per pad. */
  mode: "stereo" | "stems";
  bitDepth: 24;
  sampleRate: 44100 | 48000;
  range: "song" | "pattern";
  /** How many times the current pattern repeats when range = pattern. */
  patternRepeats: number;
  includeTails: boolean;
  tailSec: number;
}

/** Editable beat markers for one source recording (positions in seconds). */
export interface BeatGrid {
  /** Source tempo the grid was generated from (not the project BPM). */
  bpm: number;
  beatsPerBar: number;
  beats: number[];
}

export interface Selection {
  sourceId: string;
  start: number;
  end: number;
}

export interface Project {
  schemaVersion: number;
  name: string;
  isDemo: boolean;
  bpm: number;
  sources: SourceAsset[];
  activeSourceId: string | null;
  selection: Selection | null;
  markers: Record<string, number[]>; // sourceId -> chop marker times
  beatGrids: Record<string, BeatGrid>; // sourceId -> beat markers
  slices: Slice[];
  pads: Pad[];
  selectedPadId: string | null;
  bank: Bank;
  /** Performance quantize, applied non-destructively at playback and export. */
  quantize: "off" | "1/8" | "1/16" | "1/32";
  /** 50..75 (%), MPC-style. Applies to grid-aligned hits only; unquantized playing keeps its own feel. */
  swing: number;
  noteRepeat: "off" | "1/8" | "1/16" | "1/32";
  patterns: Pattern[];
  currentPatternId: string;
  arrangement: ArrangementBlock[];
  export: ExportSettings;
}
