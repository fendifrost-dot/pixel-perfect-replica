/**
 * Replaceable service interfaces. The UI depends ONLY on these contracts.
 * See FRONTEND_HANDOFF.md for implementation notes.
 */
import type { Pad, Project, SourceAsset, Slice } from "./types";
import type { AiSliceResult } from "./aiSlices";
import type { KeyResult } from "./key";

export type Availability = { available: true } | { available: false; reason: string };

export interface AudioImportService {
  /** Decode a user file and save its bytes on-device. Buffer goes to audioStore. */
  importFile(file: File): Promise<SourceAsset>;
  /** Re-decode saved audio for a reopened project. Returns ids that could not be restored. */
  rehydrate(p: Project): Promise<string[]>;
}

export type LoopMode = "pattern" | "song";

export interface PlaybackService {
  /** Get audio running (reviving or replacing an interrupted iOS context). Resolves true when it is. */
  resume(): Promise<boolean>;
  /** True when sounds triggered now will be heard. */
  isReady(): boolean;
  /** Play part of a recording once. `onEnd` fires when it finishes or is stopped. */
  audition(sourceId: string, start: number, end: number, onEnd?: () => void): boolean;
  stopAudition(): void;
  /** Returns false when no decoded audio exists for the pad. */
  triggerPad(pad: Pad, slice: Slice | undefined, velocity: number, bpm: number, when?: number): boolean;
  releasePad(padId: string): void;
  stopAll(): void;
  now(): number;
  /** Context time of the audio currently leaving the speaker (for recording what the player heard). */
  heardTime(): number;
  latencyInfo(): { sampleRate: number; baseLatency: number; outputLatency: number };
}

export interface TransportService {
  /**
   * Play the pattern / song. With `repeat()` false it plays through once and then calls `onEnd`
   * (sounds still ringing are left to finish).
   */
  start(
    getProject: () => Project,
    onStep: (step: number) => void,
    metronome: () => boolean,
    mode: LoopMode,
    repeat?: () => boolean,
    onEnd?: () => void,
    /**
     * Pattern mode only: play just steps `from`–`to` of the current pattern (looping it with
     * repeat). Long sounds that started earlier, like a whole beat, are joined part-way.
     * `onStep` and `positionAt` still report positions in the whole pattern.
     */
    region?: { from: number; to: number },
  ): void;
  stop(): void;
  isRunning(): boolean;
  mode(): LoopMode;
  /** Absolute position in steps at a context time (null when stopped). With a region it counts from the region's start, unwrapped. */
  positionAt(time: number): number | null;
  /** Don't replay a just-recorded hit if it falls within `untilStep` (absolute). */
  suppress(noteId: string, untilStep: number): void;
}

export interface SliceService {
  /** Transient positions (seconds) inside [start, end). */
  autoSlice(sourceId: string, start: number, end: number, sensitivity: number): number[];
}

export interface AnalysisService {
  /** Seconds into the recording where it becomes audible (0 for silence / unknown). */
  firstAudible(sourceId: string): number;
}

export interface AiSliceService {
  suggest(sourceId: string, start: number, end: number, availablePads: number[], signal: AbortSignal): Promise<AiSliceResult>;
}

export interface TempoService {
  /** Source tempo SUGGESTION from onset analysis; null when unclear. Never applied automatically. */
  suggestBpm(sourceId: string): { bpm: number; confidence: number } | null;
}

export interface KeyService {
  /**
   * Musical key of a recording, or of part of it (start/end in seconds), as it sounds at A = 440.
   * Null when the audio isn't loaded or the part is too short / too unpitched to tell.
   */
  detect(sourceId: string, start?: number, end?: number): KeyResult | null;
  /** The note a single hit sounds (MIDI number), e.g. an 808 or a kick's body; null for noise. */
  pitch(sourceId: string, start?: number, end?: number): number | null;
}

export interface KitService {
  /**
   * Make a built-in drum available as a source (synthesized once, shared by every pad using it).
   * Returns the asset and a slice covering the whole hit, ready to assign to a pad. Null if unknown.
   */
  loadDrum(kitId: string, drumId: string): { asset: SourceAsset; slice: Omit<Slice, "id">; level: number } | null;
}

export interface RenderedFile {
  name: string;
  blob: Blob;
  frames: number;
  peak: number;
  clipped: number;
  kind: "mix" | "stem" | "midi";
}

export interface RenderService {
  renderWav(p: Project, onProgress?: (msg: string) => void): Promise<RenderedFile[]>;
  /**
   * One WAV per pad with a sound, no beat needed. "pad" = as a tap plays it (fit, pitch, reverse,
   * fades; full level, centred); "original" = the untouched cut. `skipped` = pads not loaded here.
   */
  renderPadSamples(p: Project, mode: "pad" | "original", onProgress?: (msg: string) => void): Promise<{ files: RenderedFile[]; skipped: string[] }>;
  /** A Hum session's layers (beat muted): one WAV each, their mix, and a MIDI file — all from the beat's bar 1. */
  renderHumLayers(p: Project, onProgress?: (msg: string) => void): Promise<RenderedFile[]>;
}

/** One microphone take, in the playback clock (so it lines up with the beat). */
export interface MicTake {
  samples: Float32Array;
  sampleRate: number;
  /** AudioContext time of the first sample. */
  startTime: number;
}

export interface MicService {
  /** Whether this browser can record from the microphone at all. */
  availability(): Availability;
  /** Ask for the mic (first time: the permission prompt) and start recording. Rejects with a readable reason. */
  start(): Promise<void>;
  /** Input level now, 0..1, for a meter. */
  level(): number;
  /** Stop and return what was recorded (null if nothing was). */
  stop(): MicTake | null;
}
