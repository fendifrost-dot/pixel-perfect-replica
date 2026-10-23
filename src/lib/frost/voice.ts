/**
 * One pad hit as Web Audio nodes. Used by BOTH the live AudioContext and the OfflineAudioContext
 * export, so a hit sounds and lands the same in both.
 */
import { audioStore } from "./audioStore";
import { playPlan } from "./timing";
import { wsola } from "./stretch";
import type { Pad, Project, Slice } from "./types";

/** Minimum fades at every hit boundary — removes clicks from chops that don't start/end at a zero crossing. */
export const MIN_ATTACK = 0.002;
export const MIN_RELEASE = 0.004;
export const CHOKE_FADE = 0.008;

export interface PadSource {
  buffer: AudioBuffer;
  offset: number; // seconds into buffer
  duration: number; // seconds of buffer to play
  rate: number;
  /** One-shot length in output seconds. */
  playDuration: number;
}

// WeakMap: a reversed copy goes away with the buffer it was made from (no leak as stretches change).
const reversed = new WeakMap<AudioBuffer, AudioBuffer>();
const reversedRegions = new Map<string, AudioBuffer>();
const stretched = new Map<string, AudioBuffer>();

function copyRegion(b: AudioBuffer, start: number, end: number): Float32Array[] {
  const a = Math.max(0, Math.round(start * b.sampleRate));
  const z = Math.min(b.length, Math.max(a + 1, Math.round(end * b.sampleRate)));
  return Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice(a, z));
}

function toBuffer(chs: Float32Array[], sampleRate: number): AudioBuffer {
  const out = new AudioBuffer({
    length: Math.max(1, chs[0].length),
    numberOfChannels: chs.length,
    sampleRate,
  });
  chs.forEach((c, i) => out.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return out;
}

function reverseOf(b: AudioBuffer) {
  let r = reversed.get(b);
  if (!r) {
    r = toBuffer(
      Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice().reverse()),
      b.sampleRate,
    );
    reversed.set(b, r);
  }
  return r;
}

const stretchKey = (slice: Slice, ratio: number) =>
  `${slice.sourceId}|${slice.start}|${slice.end}|${ratio.toFixed(6)}`;

/** Pre-computes pitch-preserving stretches for every assigned pad. Returns how many were (re)built. */
export function prepareStretches(p: Project): number {
  let built = 0;
  const live = new Set<string>();
  for (const pad of p.pads) {
    const slice = p.slices.find((s) => s.id === pad.sliceId);
    if (!slice) continue;
    const plan = playPlan(pad, slice, p.bpm);
    if (plan.stretch == null) continue;
    const base = audioStore.getBuffer(slice.sourceId);
    if (!base) continue;
    const key = stretchKey(slice, plan.stretch);
    live.add(key);
    if (!stretched.has(key)) {
      stretched.set(
        key,
        toBuffer(wsola(copyRegion(base, slice.start, slice.end), plan.stretch), base.sampleRate),
      );
      built++;
    }
  }
  for (const k of stretched.keys()) if (!live.has(k)) stretched.delete(k);
  return built;
}

/** Resolves what buffer region and rate a pad plays. Null when there is no decoded audio. */
export function padSource(pad: Pad, slice: Slice | undefined, bpm: number): PadSource | null {
  if (!slice) return null;
  const base = audioStore.getBuffer(slice.sourceId);
  if (!base) return null;
  const plan = playPlan(pad, slice, bpm);
  if (plan.stretch != null) {
    const key = stretchKey(slice, plan.stretch);
    let s = stretched.get(key);
    if (!s) {
      s = toBuffer(wsola(copyRegion(base, slice.start, slice.end), plan.stretch), base.sampleRate);
      stretched.set(key, s);
    }
    const buf = pad.reverse ? reverseOf(s) : s;
    return {
      buffer: buf,
      offset: 0,
      duration: buf.duration,
      rate: plan.rate,
      playDuration: plan.duration,
    };
  }
  if (pad.reverse) {
    // Reverse just the chop, never the whole recording (an 11-minute song reversed is another ~250 MB).
    const key = `${slice.sourceId}|${slice.start}|${slice.end}`;
    let r = reversedRegions.get(key);
    if (!r) {
      r = toBuffer(copyRegion(base, slice.start, slice.end).map((c) => c.reverse()), base.sampleRate);
      if (reversedRegions.size > 64) reversedRegions.clear();
      reversedRegions.set(key, r);
    }
    return { buffer: r, offset: 0, duration: r.duration, rate: plan.rate, playDuration: plan.duration };
  }
  return {
    buffer: base,
    offset: slice.start,
    duration: slice.end - slice.start,
    rate: plan.rate,
    playDuration: plan.duration,
  };
}

export interface VoiceHandle {
  src: AudioBufferSourceNode;
  gain: GainNode;
  pad: Pad;
  end: number;
}

/**
 * Schedule a hit at `when`. `stopAt` (absolute context time) ends gate/loop holds and chokes,
 * with `stopFade` seconds of fade.
 */
export function startVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  pad: Pad,
  ps: PadSource,
  velocity: number,
  when: number,
  stopAt?: number,
  stopFade?: number,
): VoiceHandle {
  const src = ctx.createBufferSource();
  src.buffer = ps.buffer;
  src.playbackRate.value = ps.rate;
  const gain = ctx.createGain();
  const pan = ctx.createStereoPanner();
  pan.pan.value = pad.pan;
  src.connect(gain).connect(pan).connect(dest);

  const peak = pad.volume * (velocity / 127);
  const g = gain.gain;
  const attack = Math.max(MIN_ATTACK, pad.attack);
  g.setValueAtTime(0, when);
  g.linearRampToValueAtTime(peak, when + attack);

  let natural = Infinity;
  if (pad.mode === "loop") {
    src.loop = true;
    src.loopStart = ps.offset;
    src.loopEnd = ps.offset + ps.duration;
    src.start(when, ps.offset);
  } else {
    src.start(when, ps.offset, ps.duration);
    natural = when + ps.playDuration;
  }
  const stopFadeSec = stopFade ?? Math.max(MIN_RELEASE, pad.release);
  // A hold/choke that ends before the sample would: fade out from there (never before the attack completes).
  if (stopAt != null && Math.max(stopAt, when + attack) + stopFadeSec < natural) {
    const t = Math.max(stopAt, when + attack);
    g.setValueAtTime(peak, t);
    g.linearRampToValueAtTime(0, t + stopFadeSec);
    src.stop(t + stopFadeSec + 0.005);
    return { src, gain, pad, end: t + stopFadeSec };
  }
  if (natural !== Infinity) {
    // Fade into the slice end so a chop that ends mid-waveform doesn't click.
    const fade = Math.min(
      Math.max(MIN_RELEASE, pad.release),
      Math.max(0.001, ps.playDuration - attack),
    );
    g.setValueAtTime(peak, Math.max(when + attack, natural - fade));
    g.linearRampToValueAtTime(0, natural);
  }
  return { src, gain, pad, end: natural };
}
