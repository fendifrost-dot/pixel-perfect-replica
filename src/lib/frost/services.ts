/**
 * Replaceable service interfaces. The UI depends ONLY on these contracts.
 * See FRONTEND_HANDOFF.md for implementation notes.
 */
import type { Pad, Project, SourceAsset, Slice } from "./types";

export type Availability = { available: true } | { available: false; reason: string };

export interface AudioImportService {
  /** Decode a user file and save its bytes on-device. Buffer goes to audioStore. */
  importFile(file: File): Promise<SourceAsset>;
  /** Re-decode saved audio for a reopened project. Returns ids that could not be restored. */
  rehydrate(p: Project): Promise<string[]>;
}

export type LoopMode = "pattern" | "song";

export interface PlaybackService {
  resume(): Promise<void>;
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
  start(getProject: () => Project, onStep: (step: number) => void, metronome: () => boolean, mode: LoopMode): void;
  stop(): void;
  isRunning(): boolean;
  mode(): LoopMode;
  /** Absolute position in steps at a context time (null when stopped). */
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

export interface TempoService {
  /** Source tempo SUGGESTION from onset analysis; null when unclear. Never applied automatically. */
  suggestBpm(sourceId: string): { bpm: number; confidence: number } | null;
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
  kind: "mix" | "stem";
}

export interface RenderService {
  renderWav(p: Project, onProgress?: (msg: string) => void): Promise<RenderedFile[]>;
}
