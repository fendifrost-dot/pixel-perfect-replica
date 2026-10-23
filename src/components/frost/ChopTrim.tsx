import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import { audioStore } from "@/lib/frost/audioStore";
import { playbackService } from "@/lib/frost/engine";
import { MIN_CHOP_SEC, trimChop } from "@/lib/frost/ops";
import type { Pad, Project, Slice } from "@/lib/frost/types";
import { Waveform } from "./Waveform";

const NONE = new Float32Array(1);
/** Context shown around the chop so its edges can be pulled outward too. */
const around = (s: Slice, total: number): [number, number] => {
  const ctx = Math.max(0.5, (s.end - s.start) * 0.5);
  return [Math.max(0, s.start - ctx), Math.min(total, s.end + ctx)];
};

/**
 * Refine a pad's chop without going back to the whole song: drag its edges or nudge them, and
 * hear it again at the pad's own fit (½× stays ½×) after every change.
 */
export function ChopTrim({ pad, slice }: { pad: Pad; slice: Slice }) {
  const { project, commit, audioVersion, notify } = useFrost();
  const buffer = audioStore.getBuffer(slice.sourceId);
  const total = buffer?.duration ?? project.sources.find((s) => s.id === slice.sourceId)?.durationSec ?? slice.end;
  const [view, setView] = useState(() => around(slice, total));
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  // Re-centre when a different chop is opened.
  useEffect(() => setView(around(slice, total)), [slice.id, audioVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const hear = (p: Project = project) => {
    const pd = p.pads.find((x) => x.id === pad.id);
    const sl = p.slices.find((s) => s.id === pd?.sliceId);
    if (!pd || !sl) return;
    playbackService.stopAll();
    const go = () => playbackService.triggerPad(pd, sl, pd.velocity, p.bpm);
    if (playbackService.isReady()) go();
    else void playbackService.resume().then((ok) => ok && go());
  };
  const apply = (start: number, end: number) => {
    let next: Project;
    try {
      next = trimChop(project, pad.id, start, end);
    } catch (e) {
      notify((e as Error).message);
      return;
    }
    commit((p) => trimChop(p, pad.id, start, end));
    hear(next);
  };
  const nudge = (edge: "start" | "end", by: number) =>
    apply(edge === "start" ? Math.min(slice.start + by, slice.end - MIN_CHOP_SEC) : slice.start, edge === "end" ? Math.max(slice.end + by, slice.start + MIN_CHOP_SEC) : slice.end);

  if (!buffer) return <p className="text-[11px] text-muted-foreground">Open Chop and wait for the waveform to load, then trim here.</p>;

  const sel = draft ?? { start: slice.start, end: slice.end };
  const len = sel.end - sel.start;
  const beats = (len * project.bpm) / 60;
  return (
    <div className="space-y-2">
      <Waveform
        className="h-24"
        buffer={buffer}
        peaks={NONE}
        duration={total}
        viewStart={view[0]}
        viewEnd={view[1]}
        onView={(a, b) => setView([a, b])}
        selection={sel}
        markers={[]}
        beats={project.beatGrids[slice.sourceId]?.beats ?? []}
        mode="select"
        onSelect={(a, b, final) => {
          if (!final) return setDraft({ start: a, end: b });
          setDraft(null);
          apply(a, b);
        }}
        onMarkers={() => {}}
        onBeatMove={() => {}}
      />
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2 text-xs">
        <div>
          <div className="eyebrow mb-1">Start</div>
          <div className="flex gap-1">
            <button aria-label="Start earlier" className="btn min-h-9 flex-1 px-1" onClick={() => nudge("start", -0.02)}>◀</button>
            <button aria-label="Start later" className="btn min-h-9 flex-1 px-1" onClick={() => nudge("start", 0.02)}>▶</button>
          </div>
        </div>
        <button aria-label="Hear the chop" className="btn btn-on min-h-9 px-3" onClick={() => hear()}>
          <Play className="size-3.5 fill-current" /> Hear
        </button>
        <div>
          <div className="eyebrow mb-1 text-right">End</div>
          <div className="flex gap-1">
            <button aria-label="End earlier" className="btn min-h-9 flex-1 px-1" onClick={() => nudge("end", -0.02)}>◀</button>
            <button aria-label="End later" className="btn min-h-9 flex-1 px-1" onClick={() => nudge("end", 0.02)}>▶</button>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {len.toFixed(2)}s of the recording ({beats.toFixed(2)} beats at {project.bpm}). Drag the edges, or nudge them 20 ms at a time. It replays at this pad's speed after every change; pinch to zoom.
      </p>
    </div>
  );
}

