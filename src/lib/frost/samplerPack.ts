/**
 * Built-in kits as a sampler instrument for a DAW: WAVs (with their root note written in) plus
 * Decent Sampler presets (a free AU / VST3 sampler that runs in LUNA), zipped into one download.
 *
 * - Pitched kits (808s, instruments): one preset per sound, playable across the keyboard and
 *   monophonic like a real 808 line — note length decides how long it rings.
 * - Drum kits: one preset with a sound on each key from MIDI note 36 up.
 */
import type { KitDef } from "./kits";
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

function knobs(release: number): string {
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
    knob(
      190,
      "Release",
      0,
      3,
      release,
      `<binding type="amp" level="instrument" position="0" parameter="ENV_RELEASE"/>`,
    ),
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
