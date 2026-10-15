/**
 * Replaceable service interfaces. The UI depends ONLY on these contracts.
 * See FRONTEND_HANDOFF.md for which are implemented vs. unavailable.
 */
import type { Pad, Project, SourceAsset, Slice } from "./types";

export type Availability = { available: true } | { available: false; reason: string };

export interface AudioImportService {
  /** Decode a user file. Returns metadata; buffer + peaks go to audioStore. */
  importFile(file: File): Promise<SourceAsset>;
}

export interface PlaybackService {
  resume(): Promise<void>;
  audition(sourceId: string, start: number, end: number): boolean;
  /** Returns false when no decoded audio exists for the pad. */
  triggerPad(pad: Pad, slice: Slice | undefined, velocity: number, bpm: number, when?: number): boolean;
  releasePad(padId: string): void;
  stopAll(): void;
  now(): number;
}

export interface TransportService {
  start(getProject: () => Project, onStep: (step: number) => void, metronome: () => boolean): void;
  stop(): void;
  isRunning(): boolean;
}

export interface SliceService {
  autoSliceAvailability(): Availability;
  autoSlice(sourceId: string, start: number, end: number): Promise<number[]>;
}

export interface TempoService {
  analysisAvailability(): Availability;
  detectBpm(sourceId: string): Promise<number>;
  stretchAvailability(): Availability;
}

export interface PersistenceService {
  /** Saves project METADATA only. Imported audio bytes are not persisted. */
  saveLocal(p: Project): void;
  loadLocal(): Project | null;
  backupToFile(p: Project): void;
  restoreFromFile(file: File): Promise<Project>;
}

export interface RenderService {
  availability(): Availability;
  renderWav(p: Project): Promise<Blob[]>;
}
