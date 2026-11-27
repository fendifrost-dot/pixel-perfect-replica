/**
 * Web MIDI: list ports, follow hot-plug, and deliver note and CC messages from every channel.
 * The note-to-pad map lives in noteMap.ts. This file does not decide which pad a note plays.
 */
import { ac } from "./engine";

export interface MidiMessage {
  kind: "noteon" | "noteoff" | "cc";
  /** 1–16. */
  channel: number;
  /** Note number, or CC number. */
  number: number;
  /** Velocity, or CC value. 0 on note-off. */
  value: number;
  inputId: string;
  inputName: string;
}

/**
 * Note-on, note-off and CC from one MIDI packet. Every channel. A note-on with velocity 0 is a
 * note-off. Realtime bytes (clock, active sensing) are ignored so they don't split a message.
 */
export function parseMidiBytes(
  data: Uint8Array,
  inputId: string,
  inputName: string,
): MidiMessage[] {
  const raw = [...data].filter((b) => b < 0xf8);
  const out: MidiMessage[] = [];
  let status = 0;
  let i = 0;
  while (i < raw.length) {
    const b = raw[i]!;
    if (b & 0x80) {
      status = b;
      i++;
      if (status >= 0xf0) status = 0;
      continue;
    }
    if (!status) {
      i++;
      continue;
    }
    const cmd = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    const two = cmd !== 0xc0 && cmd !== 0xd0;
    if (two && i + 1 >= raw.length) break;
    const d1 = raw[i]!;
    const d2 = two ? raw[i + 1]! : 0;
    i += two ? 2 : 1;
    if (cmd === 0x90 && d2 > 0)
      out.push({ kind: "noteon", channel, number: d1, value: d2, inputId, inputName });
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0))
      out.push({ kind: "noteoff", channel, number: d1, value: 0, inputId, inputName });
    else if (cmd === 0xb0)
      out.push({ kind: "cc", channel, number: d1, value: d2, inputId, inputName });
  }
  return out;
}

const INPUT_KEY = "frost-sampler:midi-input";
const OUTPUT_KEY = "frost-sampler:midi-output";
const OFFSET_KEY = "frost-sampler:midi-out-offset-ms";
const INPUT_ON_KEY = "frost-sampler:midi-in";
const OUTPUT_ON_KEY = "frost-sampler:midi-out";
const CHANNEL_KEY = "frost-sampler:midi-out-channel";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** Chosen ports and the output timing offset. Kept in this browser, not in the project. */
export const midiPrefs = {
  inputId: () => read(INPUT_KEY),
  setInputId(id: string | null) {
    write(INPUT_KEY, id);
    bindInput();
    emit();
  },
  outputId: () => read(OUTPUT_KEY),
  setOutputId(id: string | null) {
    write(OUTPUT_KEY, id);
    emit();
  },
  offsetMs(): number {
    const n = Number(read(OFFSET_KEY));
    return Number.isFinite(n) ? Math.max(-200, Math.min(200, Math.round(n))) : 0;
  },
  setOffsetMs(ms: number) {
    write(OFFSET_KEY, String(Math.max(-200, Math.min(200, Math.round(ms)))));
    emit();
  },
  inputOn: () => read(INPUT_ON_KEY) === "1",
  setInputOn(on: boolean) {
    write(INPUT_ON_KEY, on ? "1" : "0");
  },
  outputOn: () => read(OUTPUT_ON_KEY) === "1",
  setOutputOn(on: boolean) {
    write(OUTPUT_ON_KEY, on ? "1" : "0");
  },
  /** 1–16. A user setting for the port we send to; the note map itself has no channel. */
  channel(): number {
    const n = Number(read(CHANNEL_KEY));
    return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 1;
  },
  setChannel(channel: number) {
    write(CHANNEL_KEY, String(Math.max(1, Math.min(16, Math.round(channel)))));
    emit();
  },
};

export interface MidiPortInfo {
  id: string;
  name: string;
  state: string;
}

let access: MIDIAccess | null = null;
let handler: ((m: MidiMessage) => void) | null = null;
const subs = new Set<() => void>();
const sounding = new Set<string>();

function emit() {
  for (const fn of subs) fn();
}

export function midiAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
}

function list(map: MIDIInputMap | MIDIOutputMap): MidiPortInfo[] {
  return [...map.values()].map((p) => ({ id: p.id, name: p.name || "MIDI", state: p.state }));
}

function bindInput() {
  if (!access) return;
  for (const input of access.inputs.values()) input.onmidimessage = null;
  if (!handler) return;
  const id = midiPrefs.inputId();
  const input = id ? access.inputs.get(id) : undefined;
  if (!input) return;
  input.onmidimessage = (ev) => {
    const data = ev.data;
    if (!data || !handler) return;
    for (const m of parseMidiBytes(data, input.id, input.name || "MIDI")) handler(m);
  };
}

async function openAccess(): Promise<MIDIAccess> {
  if (access) return access;
  if (!midiAvailable()) throw new Error("This browser has no MIDI.");
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(
      name === "SecurityError" || name === "NotAllowedError"
        ? "The browser blocked MIDI. Allow it for this site in the address bar, then turn input on again."
        : "MIDI couldn't be opened.",
    );
  }
  access.onstatechange = () => {
    const inputs = [...access!.inputs.values()].filter((i) => i.state === "connected");
    if (!midiPrefs.inputId() && inputs.length === 1) midiPrefs.setInputId(inputs[0]!.id);
    else bindInput();
    emit();
  };
  const inputs = [...access.inputs.values()].filter((i) => i.state === "connected");
  if (!midiPrefs.inputId() && inputs.length === 1) midiPrefs.setInputId(inputs[0]!.id);
  return access;
}

function outputPort(): MIDIOutput | null {
  const id = midiPrefs.outputId();
  if (!access || !id) return null;
  const port = access.outputs.get(id);
  return port && port.state === "connected" ? port : null;
}

/** AudioContext time → the performance clock Web MIDI send() expects, plus the user's offset. */
function stamp(ctxTime: number): number {
  const c = ac();
  return performance.now() + (ctxTime - c.currentTime) * 1000 + midiPrefs.offsetMs();
}

export const midiService = {
  available: midiAvailable,
  listening: () => handler != null,
  inputs(): MidiPortInfo[] {
    return access ? list(access.inputs) : [];
  },
  outputs(): MidiPortInfo[] {
    return access ? list(access.outputs) : [];
  },
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  async ensureAccess() {
    await openAccess();
    emit();
  },
  async startInput(onMessage: (m: MidiMessage) => void) {
    handler = onMessage;
    await openAccess();
    bindInput();
    emit();
  },
  stopInput() {
    handler = null;
    if (access) for (const input of access.inputs.values()) input.onmidimessage = null;
    emit();
  },
  /**
   * Send a note to the chosen output. `when` and `off` are AudioContext times (seconds).
   * No-op until an output is chosen and access has been opened.
   */
  send(note: number, velocity: number, when: number, off: number, channel: number) {
    const port = outputPort();
    if (!port) return;
    const ch = (Math.max(1, Math.min(16, channel)) - 1) & 0xf;
    const key = Math.max(0, Math.min(127, Math.round(note)));
    const vel = Math.max(1, Math.min(127, Math.round(velocity)));
    const onAt = stamp(when);
    const offAt = Math.max(stamp(off), onAt + 1);
    port.send([0x90 | ch, key, vel], onAt);
    port.send([0x80 | ch, key, 0], offAt);
    sounding.add(`${channel}:${key}`);
  },
  allNotesOff(channel: number) {
    const port = outputPort();
    if (!port) return;
    const ch = (Math.max(1, Math.min(16, channel)) - 1) & 0xf;
    for (const id of sounding) {
      const [c, n] = id.split(":");
      if (Number(c) === channel) port.send([0x80 | ch, Number(n), 0]);
    }
    sounding.clear();
    port.send([0xb0 | ch, 123, 0]);
  },
};
