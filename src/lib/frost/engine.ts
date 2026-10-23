/**
 * Web Audio implementations of the service interfaces (live side).
 * Offline export lives in render.ts and shares voice.ts + timing.ts with this file.
 */
import { audioStore, computePeaks } from "./audioStore";
import { detectOnsets, firstAudible, suggestTempo } from "./analysis";
import { library } from "./persist";
import { fetchAudioToDevice } from "./sync";
import { findDrum, kitSourceId, parseKitSourceId } from "./kits";
import type {
  AnalysisService,
  AiSliceService,
  AudioImportService,
  KitService,
  LoopMode,
  PlaybackService,
  SliceService,
  TempoService,
  TransportService,
} from "./services";
import { eventsInRange, patternSections, songSections, sectionsLength, stepDur } from "./timing";
import { CHOKE_FADE, MIN_RELEASE, padSource, startVoice, type VoiceHandle } from "./voice";
import type { Pad, Project, Slice } from "./types";
import { encodeWav24 } from "./wav";
import { validateAiSlices } from "./aiSlices";

let ctx: AudioContext | null = null;
export function ac(): AudioContext {
  if (!ctx) {
    // iOS: "playback" makes Web Audio ignore the ring/silent switch (Safari 16.4+).
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    try {
      if (nav.audioSession) nav.audioSession.type = "playback";
    } catch {
      /* not supported */
    }
    ctx = new AudioContext({ latencyHint: "interactive" });
  }
  return ctx;
}
const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Make sure audio can actually come out. iOS can leave a page's AudioContext "suspended" or
 * "interrupted" after switching apps, a call or the screen locking, and sometimes resume() never
 * brings it back — sounds then vanish silently. If resuming doesn't work quickly, replace the
 * context (decoded AudioBuffers are independent of it, so nothing has to be reloaded).
 */
let stuck = false;
async function wake(): Promise<boolean> {
  const c = ac();
  if (c.state === "running") return true;
  const timeout = new Promise<void>((r) => setTimeout(r, 400));
  await Promise.race([c.resume().catch(() => undefined), timeout]);
  if (ac().state === "running") return true;
  // Can't safely replace here: we're past the tap, and iOS keeps a context made outside a tap silent.
  // Mark it so the very next tap swaps in a fresh one while the tap is still active.
  stuck = true;
  return false;
}

/** Runs synchronously inside a real tap — the only moment iOS reliably lets audio start. */
function unlockInGesture() {
  if (!ctx) return;
  if (stuck || (ctx.state as string) === "closed") {
    try {
      void ctx.close();
    } catch {
      /* already closed */
    }
    ctx = null;
    stuck = false;
  }
  const c = ac();
  if (c.state !== "running") void c.resume().catch(() => undefined);
  // A silent one-sample blip finishes the iOS unlock.
  try {
    const s = c.createBufferSource();
    s.buffer = c.createBuffer(1, 1, c.sampleRate);
    s.connect(c.destination);
    s.start();
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  for (const ev of ["pointerdown", "touchend", "keydown"]) window.addEventListener(ev, unlockInGesture, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ctx && ctx.state !== "running") stuck = true;
  });
}

const monoCache = new Map<AudioBuffer, Float32Array>();
export function monoOf(b: AudioBuffer): Float32Array {
  let m = monoCache.get(b);
  if (!m) {
    m = new Float32Array(b.length);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) m[i] += d[i] / b.numberOfChannels;
    }
    monoCache.set(b, m);
  }
  return m;
}

async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  // decodeAudioData detaches its input — always hand it a copy
  return ac().decodeAudioData(bytes.slice(0));
}

export const importService: AudioImportService = {
  async importFile(file) {
    const bytes = await file.arrayBuffer();
    const buffer = await decode(bytes);
    const id = "src_" + uid();
    audioStore.setBuffer(id, buffer);
    audioStore.setPeaks(id, computePeaks(buffer), false);
    let persistence: "device" | "session-only" = "device";
    try {
      await library.putAudio({ id, name: file.name, type: file.type, bytes });
      void library.requestPersistence();
    } catch {
      persistence = "session-only";
    }
    return {
      id,
      name: file.name,
      durationSec: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      origin: "imported",
      persistence,
      detectedBpm: null,
    };
  },
  async rehydrate(p) {
    const missing: string[] = [];
    for (const s of p.sources) {
      if (audioStore.hasBuffer(s.id)) continue;
      if (s.origin === "kit") {
        const k = parseKitSourceId(s.id);
        if (!k || !ensureDrum(k.kitId, k.drumId)) missing.push(s.id);
        continue;
      }
      if (s.origin !== "imported") continue;
      try {
        const local = s.persistence === "device" ? await library.getAudio(s.id) : undefined;
        // Not on this device (e.g. added by an assistant, or another phone): fetch it from the cloud.
        const bytes = local?.bytes ?? (await fetchAudioToDevice(s.id, s.name));
        if (!bytes) {
          missing.push(s.id);
          continue;
        }
        const b = await decode(bytes);
        audioStore.setBuffer(s.id, b);
        audioStore.setPeaks(s.id, computePeaks(b), false);
      } catch {
        missing.push(s.id);
      }
    }
    return missing;
  },
};

/** Synthesize a kit drum into audioStore (once). Returns its buffer, or null for an unknown drum. */
function ensureDrum(kitId: string, drumId: string): AudioBuffer | null {
  const id = kitSourceId(kitId, drumId);
  const have = audioStore.getBuffer(id);
  if (have) return have;
  const found = findDrum(kitId, drumId);
  if (!found) return null;
  const sr = ac().sampleRate;
  const mono = found.drum.render(sr);
  const b = new AudioBuffer({ length: mono.length, numberOfChannels: 1, sampleRate: sr });
  b.copyToChannel(mono as Float32Array<ArrayBuffer>, 0);
  audioStore.setBuffer(id, b);
  audioStore.setPeaks(id, computePeaks(b), false);
  return b;
}

export const kitService: KitService = {
  loadDrum(kitId, drumId) {
    const found = findDrum(kitId, drumId);
    const b = ensureDrum(kitId, drumId);
    if (!found || !b) return null;
    const id = kitSourceId(kitId, drumId);
    return {
      asset: {
        id,
        name: `${found.kit.name} · ${found.drum.name}`,
        durationSec: b.duration,
        sampleRate: b.sampleRate,
        channels: 1,
        origin: "kit",
        persistence: "generated",
        detectedBpm: null,
      },
      slice: { sourceId: id, name: found.drum.name, start: 0, end: b.duration },
      level: found.drum.level,
    };
  },
};

const voices = new Map<string, VoiceHandle[]>();
let auditionSrc: AudioBufferSourceNode | null = null;

/** Fade a live voice out starting at `at` (context time). */
function cutVoice(v: VoiceHandle, at: number, fade: number) {
  const g = v.gain.gain;
  g.cancelScheduledValues(at);
  g.setTargetAtTime(0, at, fade / 3);
  try {
    v.src.stop(at + fade * 2 + 0.01);
  } catch {
    /* already stopped */
  }
}

function trigger(pad: Pad, slice: Slice | undefined, velocity: number, bpm: number, when: number, stopAt?: number): boolean {
  const ps = padSource(pad, slice, bpm);
  if (!ps) return false;
  const c = ac();
  if (pad.choke != null) {
    for (const list of voices.values())
      for (const v of list) if (v.pad.choke === pad.choke && v.end > when) cutVoice(v, when, CHOKE_FADE);
  }
  const v = startVoice(c, c.destination, pad, ps, velocity, when, stopAt);
  const list = voices.get(pad.id) ?? [];
  list.push(v);
  voices.set(pad.id, list);
  v.src.onended = () => {
    const l = voices.get(pad.id);
    if (l) voices.set(pad.id, l.filter((x) => x !== v));
  };
  return true;
}

export const playbackService: PlaybackService = {
  async resume() {
    return wake();
  },
  isReady: () => ac().state === "running",
  now: () => ac().currentTime,
  heardTime() {
    const c = ac();
    const ts = c.getOutputTimestamp?.();
    if (ts && ts.contextTime != null && ts.performanceTime != null && ts.contextTime > 0)
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    return c.currentTime - (c.baseLatency || 0) - (c.outputLatency || 0);
  },
  latencyInfo() {
    const c = ac();
    return { sampleRate: c.sampleRate, baseLatency: c.baseLatency || 0, outputLatency: c.outputLatency || 0 };
  },
  audition(sourceId, start, end, onEnd) {
    const b = audioStore.getBuffer(sourceId);
    if (!b) return false;
    playbackService.stopAudition();
    const c = ac();
    const s = c.createBufferSource();
    if (onEnd) s.onended = onEnd;
    const g = c.createGain();
    s.buffer = b;
    s.connect(g).connect(c.destination);
    const t = c.currentTime;
    const dur = Math.max(0.01, end - start);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.002);
    g.gain.setValueAtTime(1, t + Math.max(0.002, dur - 0.004));
    g.gain.linearRampToValueAtTime(0, t + dur);
    s.start(t, start, dur);
    auditionSrc = s;
    return true;
  },
  stopAudition() {
    try {
      auditionSrc?.stop();
    } catch {
      /* not started */
    }
    auditionSrc = null;
  },
  triggerPad(pad, slice, velocity, bpm, when) {
    return trigger(pad, slice, velocity, bpm, when ?? ac().currentTime);
  },
  releasePad(padId) {
    const list = voices.get(padId);
    if (!list) return;
    const t = ac().currentTime;
    for (const v of list) if (v.pad.mode !== "oneshot") cutVoice(v, t, Math.max(MIN_RELEASE, v.pad.release));
  },
  stopAll() {
    playbackService.stopAudition();
    const t = ac().currentTime;
    for (const list of voices.values()) for (const v of list) cutVoice(v, t, 0.01);
  },
};

function click(t: number, accent: boolean) {
  const c = ac();
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.value = accent ? 1600 : 1000;
  g.gain.setValueAtTime(0.25, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + 0.06);
}

const LOOKAHEAD = 0.12;
interface TState {
  timer: ReturnType<typeof setInterval>;
  mode: LoopMode;
  anchorTime: number;
  anchorPos: number;
  bpm: number;
  scheduledTo: number;
  suppressed: Map<string, number>;
}
let ts: TState | null = null;
const posAt = (s: TState, t: number) => s.anchorPos + (t - s.anchorTime) / stepDur(s.bpm);
const timeAt = (s: TState, pos: number) => s.anchorTime + (pos - s.anchorPos) * stepDur(s.bpm);

export const transportService: TransportService = {
  isRunning: () => ts != null,
  mode: () => ts?.mode ?? "pattern",
  positionAt: (t) => (ts ? posAt(ts, t) : null),
  suppress(noteId, untilStep) {
    ts?.suppressed.set(noteId, untilStep);
  },
  start(getProject, onStep, metronome, mode) {
    if (ts) return;
    const c = ac();
    const p0 = getProject();
    const s: TState = {
      timer: 0 as unknown as ReturnType<typeof setInterval>,
      mode,
      anchorTime: c.currentTime + 0.06,
      anchorPos: 0,
      bpm: p0.bpm,
      scheduledTo: 0,
      suppressed: new Map(),
    };
    const tick = () => {
      const p = getProject();
      const now = c.currentTime;
      if (p.bpm !== s.bpm) {
        // re-anchor so a tempo change continues from the current position
        s.anchorPos = posAt(s, now);
        s.anchorTime = now;
        s.bpm = p.bpm;
      }
      const sections = s.mode === "song" ? songSections(p) : patternSections(p, 1);
      const total = sectionsLength(sections);
      const to = posAt(s, now + LOOKAHEAD);
      if (!total || to <= s.scheduledTo) return;
      const from = s.scheduledTo;
      for (const h of eventsInRange(p, sections, from, to, true)) {
        const sup = s.suppressed.get(h.noteId);
        if (sup != null) {
          s.suppressed.delete(h.noteId);
          if (h.at <= sup) continue;
        }
        const pad = p.pads.find((x) => x.id === h.padId);
        if (!pad) continue;
        const slice = p.slices.find((x) => x.id === pad.sliceId);
        let stopAt: number | undefined;
        if (pad.mode !== "oneshot") {
          const next = eventsInRange(p, sections, h.at + 1e-6, h.at + total + 1e-6, true).find((x) => x.padId === h.padId);
          stopAt = timeAt(s, next ? next.at : h.at + total);
        }
        trigger(pad, slice, h.velocity, p.bpm, Math.max(now, timeAt(s, h.at)), stopAt);
      }
      for (const [id, until] of s.suppressed) if (until < from) s.suppressed.delete(id);
      if (metronome()) {
        for (let b = Math.ceil(from / 4); b * 4 < to; b++) if (b >= 0) click(timeAt(s, b * 4), (b * 4) % 16 === 0);
      }
      for (let st = Math.max(0, Math.ceil(from)); st < to; st++) {
        const t = timeAt(s, st);
        setTimeout(() => ts === s && onStep(st % total), Math.max(0, (t - now) * 1000));
      }
      s.scheduledTo = to;
    };
    s.timer = setInterval(tick, 25);
    ts = s;
    tick();
  },
  stop() {
    if (ts) clearInterval(ts.timer);
    ts = null;
    playbackService.stopAll();
  },
};

export const sliceService: SliceService = {
  autoSlice(sourceId, start, end, sensitivity) {
    const b = audioStore.getBuffer(sourceId);
    if (!b) return [];
    return detectOnsets(monoOf(b), b.sampleRate, start, end, sensitivity);
  },
};

export const analysisService: AnalysisService = {
  firstAudible(sourceId) {
    const b = audioStore.getBuffer(sourceId);
    return b ? firstAudible(monoOf(b), b.sampleRate) : 0;
  },
};

export const tempoService: TempoService = {
  suggestBpm(sourceId) {
    const b = audioStore.getBuffer(sourceId);
    return b ? suggestTempo(monoOf(b), b.sampleRate) : null;
  },
};

export const aiSliceService: AiSliceService = {
  async suggest(sourceId, start, end, availablePads, signal) {
    const buffer = audioStore.getBuffer(sourceId);
    if (!buffer) throw new Error("Re-import this recording before using AI.");
    if (start < 0 || end > buffer.duration || end <= start || end - start > 60) throw new Error("Choose a selection up to 60 seconds.");
    if (!availablePads.length) throw new Error("Choose a bank with empty pads.");
    const a = Math.floor(start * buffer.sampleRate), b = Math.ceil(end * buffer.sampleRate);
    const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c).slice(a, b));
    const { bytes } = encodeWav24(channels, buffer.sampleRate);
    const form = new FormData();
    form.set("audio", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "selection.wav");
    form.set("pads", JSON.stringify(availablePads));
    const response = await fetch("/api/ai-slices", { method: "POST", body: form, signal });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "AI analysis is unavailable.");
    const result = validateAiSlices(data, end - start, availablePads);
    return { ...result, slices: result.slices.map((s) => ({ ...s, start: s.start + start, end: Math.min(end, s.end + start) })) };
  },
};

export type { Pad, Project, Slice };
