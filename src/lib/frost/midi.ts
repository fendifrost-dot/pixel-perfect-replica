/**
 * Standard MIDI File (type 1) writer, so hummed / beatboxed parts can go into a DAW as MIDI and be
 * played with the DAW's own drums and 808s. Pure, unit-tested.
 */

export interface MidiNote {
  /** Start, in ticks from the beginning. */
  tick: number;
  /** Length in ticks (≥ 1). */
  dur: number;
  key: number;
  vel: number;
}

export interface MidiTrack {
  name: string;
  /** 0-based MIDI channel (9 = General MIDI drums). */
  channel: number;
  notes: MidiNote[];
}

export const PPQ = 480;
/** Ticks per 16th-note step. */
export const TICKS_PER_STEP = PPQ / 4;

/** General MIDI drum notes for the built-in kit drums (by drum id). */
export const GM_DRUM: Record<string, number> = {
  kick: 36,
  "808c": 36,
  "808f": 36,
  "808d": 36,
  snare: 38,
  clap: 39,
  rim: 37,
  snap: 39,
  hat: 42,
  ohat: 46,
  tom: 45,
  cowbell: 56,
  perc: 67,
  // Metro-style drums
  hat1: 42,
  hat2: 42,
  hat3: 42,
  hat4: 42,
  hat5: 42,
  hat6: 42,
  ohat1: 46,
  ohat2: 46,
  snr1: 38,
  snr2: 38,
  snr3: 38,
  snr4: 38,
  snr5: 38,
  snr6: 37,
  clp1: 39,
  clp2: 39,
  clp3: 39,
  perc1: 67,
  perc2: 76,
  shaker: 70,
  revcym: 55,
  crash: 49,
};

function vlq(n: number): number[] {
  let v = Math.max(0, Math.round(n));
  const out = [v & 0x7f];
  while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
  return out;
}

const text = (s: string) => [...new TextEncoder().encode(s)];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (id: string, body: number[]) => [...text(id), ...u32(body.length), ...body];

function trackChunk(events: { tick: number; bytes: number[]; order: number }[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    body.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0x00); // end of track
  return chunk("MTrk", body);
}

/** A type-1 MIDI file: a tempo / 4/4 track, then one track per part. */
export function writeMidi(tracks: MidiTrack[], bpm: number, name = "Frost Sampler"): Uint8Array {
  const usPerQuarter = Math.round(60_000_000 / bpm);
  const meta = trackChunk([
    { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(text(name).length), ...text(name)] },
    {
      tick: 0,
      order: 1,
      bytes: [
        0xff,
        0x51,
        0x03,
        (usPerQuarter >> 16) & 255,
        (usPerQuarter >> 8) & 255,
        usPerQuarter & 255,
      ],
    },
    { tick: 0, order: 2, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
  ]);
  const parts = tracks.map((t) => {
    const ch = t.channel & 15;
    const ev: { tick: number; bytes: number[]; order: number }[] = [
      { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(text(t.name).length), ...text(t.name)] },
    ];
    for (const n of t.notes) {
      const key = Math.max(0, Math.min(127, Math.round(n.key)));
      const vel = Math.max(1, Math.min(127, Math.round(n.vel)));
      ev.push({ tick: n.tick, order: 2, bytes: [0x90 | ch, key, vel] });
      // note-offs sort before note-ons on the same tick, so repeated notes retrigger cleanly
      ev.push({ tick: n.tick + Math.max(1, n.dur), order: 1, bytes: [0x80 | ch, key, 0] });
    }
    return trackChunk(ev);
  });
  const header = chunk("MThd", [0, 1, 0, tracks.length + 1, (PPQ >> 8) & 255, PPQ & 255]);
  return new Uint8Array([...header, ...meta, ...parts.flat()]);
}
