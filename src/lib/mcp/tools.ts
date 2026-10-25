/**
 * Frost Sampler MCP tools: full read/write access to the owner's cloud-synced projects.
 * The /mcp route checks FROST_MCP_KEY before any of these run. Project edits go through the pure
 * functions in frost/ops.ts; the phone picks the changes up on its next sync.
 */
import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";
import * as ops from "../frost/ops";
import { detectOnsets, suggestTempo } from "../frost/analysis";
import { decodeWav } from "../frost/wav";
import type { Project, SourceAsset } from "../frost/types";
import { cleanName } from "../frost/persist";
import { cloudStore, editProject, type CloudRow } from "../cloud/store.server";

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }],
});
const PROJECT = z
  .string()
  .min(1)
  .describe("Project key (from list_projects) or exact project name.");
const PAD = z
  .string()
  .regex(/^[A-Da-d]([1-9]|1[0-6])$/)
  .describe("Pad id, e.g. A1 … D16.");
const PATTERN = z
  .string()
  .optional()
  .describe("Pattern id or name; omitted = the current pattern.");

async function resolveKey(project: string): Promise<string> {
  const store = cloudStore();
  if (await store.get(project)) return project;
  const all = await store.list();
  const hit = all.find((r) => r.name.toLowerCase() === project.toLowerCase());
  if (!hit)
    throw new ToolError(
      `No project "${project}". Projects: ${all.map((r) => `${r.name} (${r.key})`).join(", ") || "none yet — create_project or sync from the app"}.`,
    );
  return hit.key;
}

/** Apply an edit to a project and return the updated summary. Ops errors become tool errors. */
async function edit(project: string, fn: (p: Project) => Project, extra?: Record<string, unknown>) {
  const key = await resolveKey(project);
  let row: CloudRow;
  try {
    row = await editProject(key, fn);
  } catch (e) {
    if (e instanceof ops.OpsError) throw new ToolError(e.message);
    throw e;
  }
  return json({
    ok: true,
    key,
    updatedAt: row.updatedAt,
    ...extra,
    project: ops.summarize(row.project),
  });
}

async function loadWav(key: string, sourceId: string) {
  const bytes = await cloudStore().getAudio(sourceId);
  if (!bytes)
    throw new ToolError(
      "That recording's audio isn't in the cloud yet. Open the project in the app once (with Cloud sync on) so it uploads.",
    );
  try {
    const w = decodeWav(bytes);
    const n = w.channels[0].length;
    const mono = new Float32Array(n);
    for (const c of w.channels) for (let i = 0; i < n; i++) mono[i] += c[i] / w.channels.length;
    return { mono, sampleRate: w.sampleRate, duration: n / w.sampleRate };
  } catch {
    throw new ToolError(
      `Server-side analysis only reads WAV files, and ${sourceId} in project ${key} isn't one. Give chop times yourself (make_chops), or use Find chops in the app.`,
    );
  }
}

export const tools = [
  defineTool({
    name: "list_projects",
    title: "List projects",
    description: "List every Frost Sampler project synced to the cloud (key, name, last change).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async () =>
      json({
        projects: (await cloudStore().list()).map(({ key, name, updatedAt }) => ({
          key,
          name,
          updatedAt,
        })),
      }),
  }),
  defineTool({
    name: "get_project",
    title: "Read a project",
    description:
      "Read a project: tempo, feel, recordings (with chop/beat markers), pads and their settings, patterns with every hit, song order and export settings. Set raw=true for the full stored JSON.",
    inputSchema: { project: PROJECT, raw: z.boolean().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ project, raw }) => {
      const row = (await cloudStore().get(await resolveKey(project)))!;
      return json({
        key: row.key,
        updatedAt: row.updatedAt,
        audioInCloud: row.audio,
        ...(raw ? { raw: row.project } : { project: ops.summarize(row.project) }),
      });
    },
  }),
  defineTool({
    name: "create_project",
    title: "Create a project",
    description:
      "Create a new empty project (4 banks of 16 pads, one 2-bar pattern). It appears in the app on the next sync.",
    inputSchema: { name: z.string().min(1), bpm: z.number().min(40).max(300).optional() },
    handler: async ({ name, bpm }) => {
      const key = "prj_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const p = { ...ops.newProject(cleanName(name), bpm ?? 90), isDemo: false };
      const row = await cloudStore().put(key, p, null);
      return json({ ok: true, key, updatedAt: row.updatedAt, project: ops.summarize(row.project) });
    },
  }),
  defineTool({
    name: "delete_project",
    title: "Delete a project",
    description:
      "Delete a project from the cloud. A phone that still has it will upload it again unless it is deleted there too.",
    inputSchema: { project: PROJECT },
    annotations: { destructiveHint: true },
    handler: async ({ project }) => {
      const key = await resolveKey(project);
      await cloudStore().remove(key);
      return json({ ok: true, deleted: key });
    },
  }),
  defineTool({
    name: "update_project",
    title: "Set name, BPM, feel",
    description:
      "Rename the project, set the beat's BPM (40–300), the feel (quantize off|1/8|1/16|1/32, applied on playback; swing 50–75%) or the bank shown on Pads.",
    inputSchema: {
      project: PROJECT,
      name: z.string().optional(),
      bpm: z.number().optional(),
      quantize: z.enum(["off", "1/8", "1/16", "1/32"]).optional(),
      swing: z.number().optional(),
      bank: z.enum(["A", "B", "C", "D"]).optional(),
    },
    handler: async ({ project, ...f }) => edit(project, (p) => ops.setProjectFields(p, { ...f, name: f.name == null ? undefined : cleanName(f.name) })),
  }),
  defineTool({
    name: "list_drum_kits",
    title: "List built-in drum kits",
    description: "Built-in synthesized drum kits and their drums, for add_kit_drum.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async () => json({ kits: ops.kitCatalog() }),
  }),
  defineTool({
    name: "add_kit_drum",
    title: "Put a built-in drum on a pad",
    description:
      "Put a built-in drum (see list_drum_kits) on a pad. It then behaves like any chop.",
    inputSchema: { project: PROJECT, pad: PAD, kit: z.string(), drum: z.string() },
    handler: async ({ project, pad, kit, drum }) =>
      edit(project, (p) => ops.addKitDrum(p, pad, kit, drum)),
  }),
  defineTool({
    name: "add_audio_from_url",
    title: "Add a recording from a link",
    description:
      "Download an audio file (WAV, MP3, M4A, AIFF; up to 60 MB) from a public http(s) link and add it to the project as a recording. Returns its recording id for make_chops / find_chops.",
    inputSchema: { project: PROJECT, url: z.string().url(), name: z.string().optional() },
    handler: async ({ project, url, name }) => {
      const key = await resolveKey(project);
      if (!/^https?:\/\//i.test(url)) throw new ToolError("Only http(s) links.");
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new ToolError(`Download failed: HTTP ${res.status}.`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > 60_000_000) throw new ToolError("File is over 60 MB.");
      const type = res.headers.get("content-type") ?? "audio/mpeg";
      const sourceId = "src_" + Math.random().toString(36).slice(2, 10);
      await cloudStore().putAudio(sourceId, bytes, type);
      let meta = { durationSec: 0, sampleRate: 0, channels: 2 };
      try {
        const w = decodeWav(bytes);
        meta = {
          durationSec: w.channels[0].length / w.sampleRate,
          sampleRate: w.sampleRate,
          channels: w.channels.length,
        };
      } catch {
        /* not WAV: the app fills in length/rate the first time it decodes the file */
      }
      const fileName = cleanName(name ?? (new URL(url).pathname.split("/").pop() || "recording"));
      const asset: SourceAsset = {
        id: sourceId,
        name: fileName,
        ...meta,
        origin: "imported",
        persistence: "device",
        detectedBpm: null,
      };
      await cloudStore().markAudio(key, sourceId);
      return edit(key, (p) => ops.addSource(p, asset), {
        recording: sourceId,
        lengthKnown: meta.durationSec > 0,
      });
    },
  }),
  defineTool({
    name: "find_chops",
    title: "Find chop points",
    description:
      "Find chop points in a recording between start and end (seconds; default whole file). method: hits = transient detection (WAV recordings only; sensitivity 0–1), equal = `count` equal parts, beats = every `everyBeats` beat markers. apply: markers (set the recording's chop markers), pads (make chops onto pads from startPad/bank) or none (just return the times).",
    inputSchema: {
      project: PROJECT,
      recording: z.string(),
      method: z.enum(["hits", "equal", "beats"]),
      sensitivity: z.number().min(0).max(1).optional(),
      count: z.number().int().min(2).max(64).optional(),
      everyBeats: z.number().int().min(1).max(64).optional(),
      start: z.number().min(0).optional(),
      end: z.number().optional(),
      apply: z.enum(["markers", "pads", "none"]).optional(),
      startPad: PAD.optional(),
      bank: z.enum(["A", "B", "C", "D"]).optional(),
    },
    handler: async (a) => {
      const key = await resolveKey(a.project);
      const row = (await cloudStore().get(key))!;
      const src = ops.sourceOf(row.project, a.recording);
      let duration = src.durationSec;
      let cuts: number[];
      if (a.method === "hits") {
        const w = await loadWav(key, src.id);
        duration = w.duration;
        cuts = detectOnsets(
          w.mono,
          w.sampleRate,
          a.start ?? 0,
          a.end ?? duration,
          a.sensitivity ?? 0.5,
        );
      } else if (a.method === "equal") {
        if (!duration)
          throw new ToolError("Recording length unknown yet — open it in the app once.");
        const s = a.start ?? 0,
          e = a.end ?? duration,
          n = a.count ?? 16;
        cuts = Array.from({ length: n - 1 }, (_, i) => s + ((e - s) * (i + 1)) / n);
      } else {
        const g = row.project.beatGrids[src.id];
        if (!g)
          throw new ToolError("No beat markers on this recording — use set_beat_markers first.");
        cuts = g.beats.filter((_, i) => i % (a.everyBeats ?? 1) === 0);
      }
      const s = a.start ?? 0,
        e = a.end ?? duration;
      cuts = cuts.filter((c) => c > s && c < e);
      if (a.apply === "markers")
        return edit(
          key,
          (p) =>
            ops.setChopMarkers(p, src.id, [
              ...(p.markers[src.id] ?? []).filter((m) => m < s || m > e),
              ...cuts,
            ]),
          { cuts },
        );
      if (a.apply === "pads") {
        let assigned: unknown;
        return edit(
          key,
          (p) => {
            const r = ops.makeChops(p, src.id, ops.regionsFromCuts(cuts, s, e).slice(0, 16), {
              startPad: a.startPad,
              bank: a.bank,
            });
            assigned = r.assigned;
            return r.project;
          },
          {
            cuts,
            get assigned() {
              return assigned;
            },
          },
        );
      }
      return json({ recording: src.id, start: s, end: e, cuts });
    },
  }),
  defineTool({
    name: "suggest_tempo",
    title: "Suggest a recording's tempo",
    description:
      "Estimate a recording's BPM from its hits (WAV recordings only). Could be half or double — check by ear.",
    inputSchema: { project: PROJECT, recording: z.string() },
    annotations: { readOnlyHint: true },
    handler: async ({ project, recording }) => {
      const key = await resolveKey(project);
      const w = await loadWav(key, recording);
      return json({ suggestion: suggestTempo(w.mono, w.sampleRate) });
    },
  }),
  defineTool({
    name: "make_chops",
    title: "Make chops onto pads",
    description:
      "Cut regions of a recording and put them on pads (replacing what those pads held). Give either `regions` [{start,end,name?}] in seconds, or `cuts` (cut points; chops run between them from `start` to `end`). Pads: `pads` list, or consecutive from `startPad` (default first pad of `bank`, default A1).",
    inputSchema: {
      project: PROJECT,
      recording: z.string(),
      regions: z
        .array(z.object({ start: z.number().min(0), end: z.number(), name: z.string().optional() }))
        .optional(),
      cuts: z.array(z.number()).optional(),
      start: z.number().min(0).optional(),
      end: z.number().optional(),
      pads: z.array(PAD).optional(),
      startPad: PAD.optional(),
      bank: z.enum(["A", "B", "C", "D"]).optional(),
    },
    handler: async (a) => {
      let assigned: unknown;
      return edit(
        a.project,
        (p) => {
          const src = ops.sourceOf(p, a.recording);
          const regions =
            a.regions ??
            (a.cuts ? ops.regionsFromCuts(a.cuts, a.start ?? 0, a.end ?? src.durationSec) : null);
          if (!regions) throw new ops.OpsError("Give regions or cuts.");
          const r = ops.makeChops(p, src.id, regions, {
            pads: a.pads,
            startPad: a.startPad,
            bank: a.bank,
          });
          assigned = r.assigned;
          return r.project;
        },
        {
          get assigned() {
            return assigned;
          },
        },
      );
    },
  }),
  defineTool({
    name: "set_chop_markers",
    title: "Set chop markers",
    description:
      "Replace a recording's chop markers (seconds). They show on the Chop tab for dragging and 'To bank'.",
    inputSchema: { project: PROJECT, recording: z.string(), times: z.array(z.number()) },
    handler: async ({ project, recording, times }) =>
      edit(project, (p) => ops.setChopMarkers(p, recording, times)),
  }),
  defineTool({
    name: "set_beat_markers",
    title: "Set beat markers",
    description:
      "Place beat markers on a recording from its own BPM and the time (seconds) of its first downbeat.",
    inputSchema: {
      project: PROJECT,
      recording: z.string(),
      bpm: z.number(),
      firstBeat: z.number().min(0),
    },
    handler: async ({ project, recording, bpm, firstBeat }) =>
      edit(project, (p) => ops.setBeatMarkers(p, recording, bpm, firstBeat)),
  }),
  defineTool({
    name: "set_pad",
    title: "Change a pad",
    description:
      "Change a pad. fit: off | stretch (keeps pitch) | repitch (classic, pitch follows) to lengthBeats at the project BPM. volume 0–1, pan −1–1, pitch −24–24 st, velocity 1–127, plays whole|held|loop, chokeGroup 0–4 (0 = none), reverse, fadeInMs, fadeOutMs, chopName (rename its chop), chopStart/chopEnd (seconds into the recording) trim or extend its chop — a fitted pad keeps its speed (its lengthBeats scales with the chop) unless lengthBeats is also given, empty=true clears the pad.",
    inputSchema: {
      project: PROJECT,
      pad: PAD,
      fit: z.enum(["off", "stretch", "repitch"]).optional(),
      lengthBeats: z.number().optional(),
      volume: z.number().optional(),
      pan: z.number().optional(),
      pitch: z.number().optional(),
      velocity: z.number().optional(),
      plays: z.enum(["whole", "held", "loop"]).optional(),
      chokeGroup: z.number().int().optional(),
      reverse: z.boolean().optional(),
      fadeInMs: z.number().optional(),
      fadeOutMs: z.number().optional(),
      chopName: z.string().optional(),
      chopStart: z.number().optional(),
      chopEnd: z.number().optional(),
      empty: z.boolean().optional(),
    },
    handler: async ({ project, pad, ...f }) => edit(project, (p) => ops.setPad(p, pad, f)),
  }),
  defineTool({
    name: "add_pattern",
    title: "Add a pattern",
    description:
      "Add a pattern (1, 2 or 4 bars for a loop; any whole number of bars up to 256 for a whole song on the Timeline), empty or copied from another; it becomes the current pattern unless makeCurrent=false.",
    inputSchema: {
      project: PROJECT,
      name: z.string().optional(),
      bars: z.number().int().optional(),
      copyFrom: z.string().optional(),
      makeCurrent: z.boolean().optional(),
    },
    handler: async ({ project, ...o }) => {
      let id = "";
      return edit(
        project,
        (p) => {
          const r = ops.addPattern(p, o);
          id = r.patternId;
          return r.project;
        },
        {
          get patternId() {
            return id;
          },
        },
      );
    },
  }),
  defineTool({
    name: "edit_pattern",
    title: "Edit a pattern",
    description:
      "Rename a pattern, set its length (1–256 whole bars; hits past the end are dropped), clear all its hits, or make it current.",
    inputSchema: {
      project: PROJECT,
      pattern: PATTERN,
      name: z.string().optional(),
      bars: z.number().int().optional(),
      clear: z.boolean().optional(),
      makeCurrent: z.boolean().optional(),
    },
    handler: async ({ project, pattern, ...f }) =>
      edit(project, (p) => ops.editPattern(p, pattern, f)),
  }),
  defineTool({
    name: "delete_pattern",
    title: "Delete a pattern",
    description: "Delete a pattern (and remove it from the song).",
    inputSchema: { project: PROJECT, pattern: z.string() },
    annotations: { destructiveHint: true },
    handler: async ({ project, pattern }) => edit(project, (p) => ops.deletePattern(p, pattern)),
  }),
  defineTool({
    name: "add_hits",
    title: "Add hits to a pattern",
    description:
      "Add hits to a pattern. step = 16th note from the pattern start (0-based; 0–15 per bar, beat n starts at step 4n). velocity 1–127 (default the pad's), offset −0.5–0.49 of a step for played feel (heard when quantize is off). step may be a half step (x.5) for a 1/32 position; a step past the pattern's end makes the pattern longer (up to 256 bars). length = steps the hit sounds (0.5 = 1/32 note, 16 = a bar; loop pads repeat to fill it); omit for the pad's natural length. pitch = semitones on top of the pad for this hit (for the Instruments kit — 808 bass, sub, bass guitar, synth bass, keys, pluck — this plays a melody/bassline from one pad; add one with add_kit_drum kit=instruments). A hit on the same pad+step is replaced.",
    inputSchema: {
      project: PROJECT,
      pattern: PATTERN,
      hits: z
        .array(
          z.object({
            pad: PAD,
            step: z.number().min(0),
            velocity: z.number().optional(),
            offset: z.number().optional(),
            length: z.number().optional(),
            pitch: z.number().optional(),
          }),
        )
        .min(1)
        .max(1024),
    },
    handler: async ({ project, pattern, hits }) =>
      edit(project, (p) => ops.addHits(p, pattern, hits)),
  }),
  defineTool({
    name: "song_to_timeline",
    title: "Lay the song out on the Timeline",
    description:
      "Copy the Song (patterns in order) into one long pattern (rounded up to whole bars, up to 256) so the whole track can be edited hit by hit on the Timeline. Muted lanes are left out. The new pattern becomes current; the original patterns and song are kept.",
    inputSchema: { project: PROJECT, name: z.string().optional() },
    handler: async ({ project, name }) => {
      let id = "";
      return edit(
        project,
        (p) => {
          const r = ops.songToTimeline(p, name?.trim() || undefined);
          id = r.patternId;
          return r.project;
        },
        {
          get patternId() {
            return id;
          },
        },
      );
    },
  }),
  defineTool({
    name: "remove_hits",
    title: "Remove hits",
    description:
      "Remove a pad's hits at the given steps, or all of that pad's hits in the pattern when steps is omitted.",
    inputSchema: {
      project: PROJECT,
      pattern: PATTERN,
      pad: PAD,
      steps: z.array(z.number().int()).optional(),
    },
    handler: async ({ project, pattern, pad, steps }) =>
      edit(project, (p) => ops.removeHits(p, pattern, pad, steps)),
  }),
  defineTool({
    name: "set_lane",
    title: "Mute / solo a pad",
    description: "Mute or solo a pad's row in a pattern.",
    inputSchema: {
      project: PROJECT,
      pattern: PATTERN,
      pad: PAD,
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
    },
    handler: async ({ project, pattern, pad, ...f }) =>
      edit(project, (p) => ops.setLane(p, pattern, pad, f)),
  }),
  defineTool({
    name: "set_song",
    title: "Set the song order",
    description:
      "Set the song: pattern ids or names in play order (repeat an id to repeat a pattern). Empty list clears it.",
    inputSchema: { project: PROJECT, patterns: z.array(z.string()) },
    handler: async ({ project, patterns }) => edit(project, (p) => ops.setSong(p, patterns)),
  }),
  defineTool({
    name: "set_export",
    title: "Set export options",
    description:
      "Export settings used by Render in the app: mode stereo (mix only) | stems (mix + each pad), sampleRate 44100|48000, range pattern|song, patternRepeats 1–64, tailSec 0–10. Rendering the WAVs happens on the phone (Export → Render).",
    inputSchema: {
      project: PROJECT,
      mode: z.enum(["stereo", "stems"]).optional(),
      sampleRate: z.union([z.literal(44100), z.literal(48000)]).optional(),
      range: z.enum(["pattern", "song"]).optional(),
      patternRepeats: z.number().int().optional(),
      tailSec: z.number().optional(),
    },
    handler: async ({ project, ...f }) => edit(project, (p) => ops.setExport(p, f)),
  }),
];
