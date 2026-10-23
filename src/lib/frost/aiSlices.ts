import { z } from "zod";
import type { Project } from "./types";

// Keep the model schema simple; enforce temporal and pad constraints after generation.
export const aiSliceOutput = z.object({
  summary: z.string(),
  slices: z.array(z.object({ start: z.number(), end: z.number(), label: z.string(), pad: z.number(), reason: z.string() })),
});
export type AiSliceResult = z.infer<typeof aiSliceOutput>;

export function validateAiSlices(raw: unknown, duration: number, availablePads: number[]): AiSliceResult {
  const parsed = aiSliceOutput.parse(raw);
  const used = new Set<number>();
  const slices = parsed.slices.filter((s) => {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end > duration + 0.001 || s.end - s.start < 0.015 || !availablePads.includes(s.pad) || used.has(s.pad)) return false;
    used.add(s.pad);
    return true;
  }).slice(0, 16).map((s) => ({ ...s, end: Math.min(duration, s.end), label: s.label.slice(0, 48), reason: s.reason.slice(0, 240) }));
  return { summary: parsed.summary.slice(0, 400), slices };
}

export function applyAiSlices(project: Project, sourceId: string, assignments: { padId: string; start: number; end: number; label: string }[], makeId: () => string): Project {
  const source = project.sources.find((s) => s.id === sourceId && s.origin === "imported");
  if (!source) throw new Error("This imported recording is no longer open.");
  const used = new Set<string>();
  for (const s of assignments) {
    const pad = project.pads.find((p) => p.id === s.padId);
    if (!pad || pad.sliceId || used.has(s.padId)) throw new Error("Choose a different empty pad for each suggestion.");
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end > source.durationSec || s.end - s.start < 0.015) throw new Error("Each chop must fit inside this recording.");
    used.add(s.padId);
  }
  if (!assignments.length) throw new Error("Select at least one suggestion.");
  const slices = assignments.map((s) => ({ id: makeId(), sourceId, name: s.label || "AI chop", start: s.start, end: s.end }));
  const pads = project.pads.map((pad) => {
    const i = assignments.findIndex((s) => s.padId === pad.id);
    return i < 0 ? pad : { ...pad, sliceId: slices[i].id };
  });
  const markers = [...new Set([...(project.markers[sourceId] ?? []), ...slices.flatMap((s) => [s.start, s.end])])]
    .filter((t) => t > 0 && t < source.durationSec).sort((a, b) => a - b);
  return { ...project, slices: [...project.slices, ...slices], pads, markers: { ...project.markers, [sourceId]: markers } };
}