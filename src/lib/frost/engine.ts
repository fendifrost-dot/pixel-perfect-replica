/**
 * Prototype Web Audio implementations of the service interfaces.
 * Real: decoding, waveform peaks, audition, pad trigger (volume/pan/repitch/reverse/envelope/choke/modes),
 * step scheduling + metronome, local metadata save, JSON backup/restore.
 * Unavailable (honest stubs): auto-slice, BPM detection, time-stretch, WAV rendering.
 */
import { audioStore, computePeaks } from "./audioStore";
import type {
  AudioImportService,
  PersistenceService,
  PlaybackService,
  RenderService,
  SliceService,
  TempoService,
  TransportService,
} from "./services";
import { SCHEMA_VERSION, type Pad, type Project, type Slice } from "./types";

let ctx: AudioContext | null = null;
function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}
const uid = () => Math.random().toString(36).slice(2, 10);

export const importService: AudioImportService = {
  async importFile(file) {
    const bytes = await file.arrayBuffer();
    const buffer = await ac().decodeAudioData(bytes);
    const id = "src_" + uid();
    audioStore.setBuffer(id, buffer);
    audioStore.setPeaks(id, computePeaks(buffer), false);
    return {
      id,
      name: file.name,
      durationSec: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      origin: "imported",
      persistence: "session-only",
      detectedBpm: null,
    };
  },
};

const reversed = new Map<string, AudioBuffer>();
function reverseOf(id: string, b: AudioBuffer) {
  let r = reversed.get(id);
  if (!r) {
    r = ac().createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c);
      const dst = r.getChannelData(c);
      for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
    }
    reversed.set(id, r);
  }
  return r;
}

type Voice = { src: AudioBufferSourceNode; gain: GainNode; pad: Pad };
const voices = new Map<string, Voice[]>();
let auditionSrc: AudioBufferSourceNode | null = null;

function stopVoice(v: Voice, release = 0.01) {
  const t = ac().currentTime;
  v.gain.gain.cancelScheduledValues(t);
  v.gain.gain.setValueAtTime(v.gain.gain.value, t);
  v.gain.gain.linearRampToValueAtTime(0, t + Math.max(0.005, release));
  try {
    v.src.stop(t + Math.max(0.005, release) + 0.01);
  } catch {
    /* already stopped */
  }
}

export const playbackService: PlaybackService = {
  async resume() {
    if (ac().state !== "running") await ac().resume();
  },
  now: () => ac().currentTime,
  audition(sourceId, start, end) {
    const b = audioStore.getBuffer(sourceId);
    if (!b) return false;
    auditionSrc?.stop();
    const s = ac().createBufferSource();
    s.buffer = b;
    s.connect(ac().destination);
    s.start(0, start, Math.max(0.01, end - start));
    auditionSrc = s;
    return true;
  },
  triggerPad(pad, slice, velocity, bpm, when) {
    if (!slice) return false;
    const base = audioStore.getBuffer(slice.sourceId);
    if (!base) return false;
    const c = ac();
    const t = when ?? c.currentTime;
    // choke group
    if (pad.choke != null) {
      for (const list of voices.values()) for (const v of list) if (v.pad.choke === pad.choke) stopVoice(v);
    }
    const buf = pad.reverse ? reverseOf(slice.sourceId, base) : base;
    const dur = slice.end - slice.start;
    const offset = pad.reverse ? base.duration - slice.end : slice.start;
    let rate = Math.pow(2, pad.pitch / 12);
    // Classic repitch to a musical length (changes pitch). Stretch mode is not implemented -> original speed.
    if (pad.lengthUnit !== "off" && pad.timeMode === "repitch") {
      const beats = pad.lengthUnit === "bars" ? pad.lengthValue * 4 : pad.lengthValue;
      const target = (beats * 60) / bpm;
      if (target > 0) rate = dur / target;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = c.createGain();
    const pan = c.createStereoPanner();
    pan.pan.value = pad.pan;
    const peak = pad.volume * (velocity / 127);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + Math.max(0.002, pad.attack));
    src.connect(gain).connect(pan).connect(c.destination);
    if (pad.mode === "loop") {
      src.loop = true;
      src.loopStart = offset;
      src.loopEnd = offset + dur;
      src.start(t, offset);
    } else {
      src.start(t, offset, dur);
      if (pad.mode === "oneshot" && pad.release > 0) {
        const endT = t + dur / rate;
        gain.gain.setValueAtTime(peak, Math.max(t + pad.attack, endT - pad.release));
        gain.gain.linearRampToValueAtTime(0, endT);
      }
    }
    const v: Voice = { src, gain, pad };
    const list = voices.get(pad.id) ?? [];
    list.push(v);
    voices.set(pad.id, list);
    src.onended = () => {
      const l = voices.get(pad.id);
      if (l) voices.set(pad.id, l.filter((x) => x !== v));
    };
    return true;
  },
  releasePad(padId) {
    const list = voices.get(padId);
    if (!list) return;
    for (const v of list) if (v.pad.mode !== "oneshot") stopVoice(v, v.pad.release);
  },
  stopAll() {
    auditionSrc?.stop();
    auditionSrc = null;
    for (const list of voices.values()) for (const v of list) stopVoice(v);
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

let timer: ReturnType<typeof setInterval> | null = null;
export const transportService: TransportService = {
  isRunning: () => timer != null,
  start(getProject, onStep, metronome) {
    if (timer) return;
    const c = ac();
    let step = 0;
    let next = c.currentTime + 0.06;
    timer = setInterval(() => {
      const p = getProject();
      const pat = p.patterns.find((x) => x.id === p.currentPatternId);
      if (!pat) return;
      const stepDur = 60 / p.bpm / 4;
      while (next < c.currentTime + 0.1) {
        const s = step % pat.lengthSteps;
        const swingDelay = s % 2 === 1 ? ((p.swing - 50) / 50) * stepDur * 0.5 : 0;
        if (metronome() && s % 4 === 0) click(next, s % 16 === 0);
        const anySolo = pat.lanes.some((l) => l.solo);
        for (const n of pat.notes) {
          if (n.step !== s) continue;
          const lane = pat.lanes.find((l) => l.padId === n.padId);
          if (lane && (lane.mute || (anySolo && !lane.solo))) continue;
          const pad = p.pads.find((x) => x.id === n.padId);
          if (!pad) continue;
          const slice = p.slices.find((x) => x.id === pad.sliceId);
          playbackService.triggerPad(pad, slice, n.velocity, p.bpm, next + swingDelay + n.offset * stepDur);
        }
        const fireAt = next;
        setTimeout(() => onStep(s), Math.max(0, (fireAt - c.currentTime) * 1000));
        next += stepDur;
        step++;
      }
    }, 25);
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = null;
    playbackService.stopAll();
  },
};

const NA = (reason: string) => ({ available: false as const, reason });

export const sliceService: SliceService = {
  autoSliceAvailability: () => NA("Transient detection is not implemented yet."),
  autoSlice: () => Promise.reject(new Error("Auto-slice unavailable")),
};

export const tempoService: TempoService = {
  analysisAvailability: () => NA("BPM analysis is not implemented yet."),
  detectBpm: () => Promise.reject(new Error("BPM analysis unavailable")),
  stretchAvailability: () => NA("Pitch-preserving stretch engine not implemented — plays at original speed."),
};

export const renderService: RenderService = {
  availability: () => NA("Offline WAV rendering is not implemented yet. No file will be produced."),
  renderWav: () => Promise.reject(new Error("WAV render unavailable")),
};

const KEY = "frost-sampler:project";
export const persistenceService: PersistenceService = {
  saveLocal(p) {
    localStorage.setItem(KEY, JSON.stringify(p));
  },
  loadLocal() {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Project;
    return p.schemaVersion === SCHEMA_VERSION ? p : null;
  },
  backupToFile(p) {
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.name.replace(/\W+/g, "_")}.frost.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  async restoreFromFile(file) {
    const p = JSON.parse(await file.text()) as Project;
    if (p.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported schema version ${p.schemaVersion}`);
    return p;
  },
};

export type { Pad, Slice };
