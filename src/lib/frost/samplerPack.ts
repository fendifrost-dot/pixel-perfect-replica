/**
 * Built-in kits as a sampler instrument for a DAW: WAVs (with their root note written in) plus
 * Decent Sampler presets (a free AU / VST3 sampler that runs in LUNA), zipped into one download.
 *
 * - Pitched kits (808s, instruments): one preset per sound, playable across the keyboard and
 *   monophonic like a real 808 line — note length decides how long it rings.
 * - Drum kits: one preset with a sound on each key from MIDI note 36 up.
 */
import type { KitDef } from "./kits";
import { noteMap } from "./noteMap";
import type { Pad, Project } from "./types";
import { encodeWav24 } from "./wav";
import { makeZip, type ZipEntry } from "./zip";
import { noteName } from "./hum";

/** First key of a drum kit (MIDI 36 — "C1" in most DAWs). */
export const DRUM_BASE_NOTE = 36;

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "").trim();

/** True when every sound in the kit has a root note: played as notes rather than one-per-key. */
export const isPitchedKit = (kit: KitDef) => kit.drums.every((d) => d.rootMidi != null);

function knobs(release: number, withRelease = true): string {
  const knob = (
    x: number,
    label: string,
    min: number,
    max: number,
    value: number,
    binding: string,
  ) =>
    `      <labeled-knob x="${x}" y="90" width="110" textSize="16" textColor="FFE8F4F2" trackForegroundColor="FF9FD9CF" label="${label}" type="float" minValue="${min}" maxValue="${max}" value="${value}">\n        ${binding}\n      </labeled-knob>`;
  return [
    knob(
      40,
      "Attack",
      0,
      0.5,
      0.001,
      `<binding type="amp" level="instrument" position="0" parameter="ENV_ATTACK"/>`,
    ),
    withRelease
      ? knob(
          190,
          "Release",
          0,
          3,
          release,
          `<binding type="amp" level="instrument" position="0" parameter="ENV_RELEASE"/>`,
        )
      : "",
    knob(
      340,
      "Tune",
      -24,
      24,
      0,
      `<binding type="general" level="instrument" position="0" parameter="GLOBAL_TUNING"/>`,
    ),
    knob(
      490,
      "Volume",
      0,
      1,
      0.8,
      `<binding type="amp" level="instrument" position="0" parameter="AMP_VOLUME"/>`,
    ),
  ].join("\n");
}

function preset(title: string, release: number, groupAttrs: string, samples: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<DecentSampler minVersion="1.0.0" title="${xml(title)}">
  <ui width="812" height="375" bgColor="FF151A1C">
    <tab name="main">
      <label x="40" y="20" width="732" height="40" textSize="24" textColor="FFFFFFFF" text="${xml(title)}"/>
      <label x="40" y="52" width="732" height="24" textSize="14" textColor="FF8FA6A3" text="Frost Sampler"/>
${knobs(release)}
    </tab>
  </ui>
  <groups attack="0.001" decay="0" sustain="1" release="${release}">
    <group${groupAttrs}>
${samples.map((s) => `      ${s}`).join("\n")}
    </group>
  </groups>
</DecentSampler>
`;
}

function readme(kit: KitDef, folder: string, pitched: boolean): string {
  return `${kit.name} — from Frost Sampler
${"=".repeat(kit.name.length + 20)}

${kit.blurb}

PLAY THEM AS MIDI IN LUNA (or any DAW)
1. Install Decent Sampler (free, AU / VST3): https://www.decentsamples.com/product/decent-sampler-plugin/
2. Unzip this file and keep the "${folder}" folder together (presets and Samples/ side by side).
3. In LUNA: add an Instrument track, load Decent Sampler on it, then in Decent Sampler choose
   File → Load Sample Library… and pick a .dspreset file from this folder.
4. Write or record MIDI on that track and edit the notes in LUNA's piano roll.

${
  pitched
    ? `Each .dspreset is one sound, playable on every key (tuned at ${noteName(kit.drums[0].rootMidi!)} = MIDI ${kit.drums[0].rootMidi}).
It plays one note at a time, like a real 808 line: a new note cuts the last one, and the length
of each MIDI note decides how long it rings (Release knob = the fade after you let go).`
    : `One preset, one sound per key starting at MIDI note ${DRUM_BASE_NOTE} (C1 in most DAWs):
${kit.drums.map((d, i) => `  ${String(DRUM_BASE_NOTE + i).padStart(3)}  ${noteName(DRUM_BASE_NOTE + i).padEnd(4)} ${d.name}`).join("\n")}`
}

OTHER SAMPLERS
The WAVs in Samples/ are 24-bit with their root note written into the file (smpl chunk), so most
samplers map them to the right key on drag-and-drop.
`;
}

/** Render a kit and pack it as `<Kit>.zip`. */
export function buildSamplerPack(
  kit: KitDef,
  sampleRate = 48000,
): { fileName: string; bytes: Uint8Array } {
  const folder = `Frost ${kit.name}`;
  const pitched = isPitchedKit(kit);
  const entries: ZipEntry[] = [];
  const enc = new TextEncoder();
  const wavName = (d: KitDef["drums"][number]) => `${fileSafe(d.name)}.wav`;

  kit.drums.forEach((d, i) => {
    const root = pitched ? d.rootMidi! : DRUM_BASE_NOTE + i;
    entries.push({
      name: `${folder}/Samples/${wavName(d)}`,
      data: encodeWav24([d.render(sampleRate)], sampleRate, undefined, root).bytes,
    });
  });
  if (pitched) {
    for (const d of kit.drums) {
      // mono: a new note silences the ringing one (tag silences itself)
      const s = `<sample path="Samples/${xml(wavName(d))}" rootNote="${d.rootMidi}" loNote="0" hiNote="127"/>`;
      entries.push({
        name: `${folder}/${fileSafe(d.name)}.dspreset`,
        data: enc.encode(
          preset(d.name, 0.12, ` tags="mono" silencedByTags="mono" silencingMode="fast"`, [s]),
        ),
      });
    }
  } else {
    const samples = kit.drums.map((d, i) => {
      const n = DRUM_BASE_NOTE + i;
      return `<sample path="Samples/${xml(wavName(d))}" rootNote="${n}" loNote="${n}" hiNote="${n}"/>`;
    });
    // long release: a short MIDI note still lets the hit ring out
    entries.push({
      name: `${folder}/${fileSafe(kit.name)}.dspreset`,
      data: enc.encode(preset(kit.name, 3, "", samples)),
    });
  }
  entries.push({ name: `${folder}/README.txt`, data: enc.encode(readme(kit, folder, pitched)) });
  return { fileName: `${folder.replace(/\s+/g, "_")}.zip`, bytes: makeZip(entries) };
}

/** Pads that have a chop, in map order, each with the note `noteMap` gives it. */
export function chopAssignments(p: Project): { pad: Pad; note: number }[] {
  const byId = new Map(p.pads.map((pad) => [pad.id, pad]));
  const out: { pad: Pad; note: number }[] = [];
  for (const m of noteMap(p.pads, p.midi?.notes)) {
    const pad = byId.get(m.padId);
    if (pad?.sliceId) out.push({ pad, note: m.note });
  }
  return out;
}

export interface ChopPackSample {
  padId: string;
  chopName: string;
  note: number;
  wav: Uint8Array;
  /** Seconds the amp fades after note-off. Long for one-shots, so the hit rings. */
  release: number;
  loop: boolean;
  frames: number;
}

/**
 * The project's chops as one Decent Sampler preset. Paths stay put across re-exports:
 * `Chops.dspreset` and `Samples/<pad id>.wav`, so a DAW session keeps the instrument.
 */
export function buildChopPack(opts: {
  projectName: string;
  samples: ChopPackSample[];
  omitted?: { padId: string; reason: string }[];
}): { fileName: string; bytes: Uint8Array } {
  const title = fileSafe(opts.projectName) || "Chops";
  const folder = `Frost ${title}`;
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [];
  const seenNote = new Set<number>();
  const samples = opts.samples.filter((s) => {
    if (seenNote.has(s.note)) return false;
    seenNote.add(s.note);
    return true;
  });
  for (const s of samples) {
    entries.push({ name: `${folder}/Samples/${fileSafe(s.padId)}.wav`, data: s.wav });
  }
  const groups = new Map<string, ChopPackSample[]>();
  for (const s of samples) {
    const key = `${s.loop ? "loop" : "once"}|${s.release.toFixed(3)}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const groupXml = [...groups.values()]
    .map((list) => {
      const head = list[0]!;
      const body = list
        .map((s) => {
          const loop = s.loop
            ? ` loopEnabled="1" loopStart="0" loopEnd="${Math.max(1, s.frames)}"`
            : "";
          return `      <sample path="Samples/${xml(fileSafe(s.padId))}.wav" rootNote="${s.note}" loNote="${s.note}" hiNote="${s.note}"${loop}/>`;
        })
        .join("\n");
      return `    <group attack="0.001" decay="0" sustain="1" release="${head.release}">\n${body}\n    </group>`;
    })
    .join("\n");
  const preset = `<?xml version="1.0" encoding="UTF-8"?>
<DecentSampler minVersion="1.0.0" title="${xml(title)}">
  <ui width="812" height="375" bgColor="FF151A1C">
    <tab name="main">
      <label x="40" y="20" width="732" height="40" textSize="24" textColor="FFFFFFFF" text="${xml(title)}"/>
      <label x="40" y="52" width="732" height="24" textSize="14" textColor="FF8FA6A3" text="Frost Sampler"/>
${knobs(0, false)}
    </tab>
  </ui>
  <groups>
${groupXml}
  </groups>
</DecentSampler>
`;
  entries.push({ name: `${folder}/Chops.dspreset`, data: enc.encode(preset) });
  const lines = [...samples].sort((a, b) => a.note - b.note || a.padId.localeCompare(b.padId));
  const omitted = opts.omitted ?? [];
  const readme = `${title} — chops for a DAW
${"=".repeat(title.length + 18)}

These are the chops from this project, rendered as they play in Frost (pitch, reverse, fades,
stretch, volume). Each pad is one MIDI note. The numbers below are MIDI note numbers. DAWs
label the same number differently, so follow the number.

PLAY THEM
1. Install Decent Sampler (free, AU / VST3): https://www.decentsamples.com/product/decent-sampler-plugin/
2. Unzip this file and keep the "${folder}" folder together. To update the chops, unzip a new
   export over this same folder. The preset stays Chops.dspreset and each pad stays
   Samples/<pad>.wav, so the DAW does not need to be pointed at the instrument again.
3. Add an instrument track, load Decent Sampler, then File → Load Sample Library… and choose
   Chops.dspreset from this folder.
4. Record on that track and play the same pads you use in Frost. Turn Frost's MIDI input off
   while you do, so each hit is heard once.

NOTE NUMBERS
${lines.map((s) => `  ${String(s.note).padStart(3)}  ${s.padId.padEnd(4)} ${s.chopName}${s.loop ? "  (loops while held)" : ""}`).join("\n")}
${omitted.length ? `\nLEFT OUT\n${omitted.map((o) => `  ${o.padId}  ${o.reason}`).join("\n")}\n` : ""}
One-shot pads ring after you let go. Pads set to hold or loop fade using their release.
The Release knob on the preset fades every pad after a note-off.

OTHER SAMPLERS
The WAVs in Samples/ are 24-bit with the pad's MIDI note written into the file.
`;
  entries.push({ name: `${folder}/README.txt`, data: enc.encode(readme) });
  return { fileName: `${folder.replace(/\s+/g, "_")}_Chops.zip`, bytes: makeZip(entries) };
}
