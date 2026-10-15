import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import { useFrost, uid } from "@/lib/frost/store";
import type { ArrangementBlock } from "@/lib/frost/types";

const LABELS = ["Intro", "Verse", "Pre", "Hook", "Bridge", "Break", "Outro"];

export function SongView() {
  const { project, commit } = useFrost();
  const arr = project.arrangement;
  const set = (a: ArrangementBlock[]) => commit((p) => ({ ...p, arrangement: a }));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    const a = [...arr];
    [a[i], a[j]] = [a[j], a[i]];
    set(a);
  };
  const bars = arr.reduce((s, b) => s + (project.patterns.find((p) => p.id === b.patternId)?.lengthSteps ?? 16) / 16, 0);

  return (
    <div className="space-y-3">
      <div className="panel flex items-center justify-between">
        <div>
          <div className="eyebrow">Song length</div>
          <div className="font-mono text-lg">{bars} bars · {((bars * 4 * 60) / project.bpm).toFixed(1)} s</div>
        </div>
        <button className="btn btn-primary" onClick={() => set([...arr, { id: uid(), patternId: project.currentPatternId, label: "Verse" }])}>
          <Plus className="size-4" /> Add block
        </button>
      </div>
      <ol className="space-y-2">
        {arr.map((b, i) => (
          <li key={b.id} className="panel flex flex-wrap items-center gap-2 p-2">
            <span className="w-6 text-center font-mono text-xs text-muted-foreground">{i + 1}</span>
            <select className="field min-h-11 w-28 flex-1" value={b.label} onChange={(e) => set(arr.map((x) => (x.id === b.id ? { ...x, label: e.target.value } : x)))}>
              {LABELS.map((l) => <option key={l}>{l}</option>)}
            </select>
            <select className="field min-h-11 w-32 flex-1" value={b.patternId} onChange={(e) => set(arr.map((x) => (x.id === b.id ? { ...x, patternId: e.target.value } : x)))}>
              {project.patterns.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="ml-auto flex gap-1">
              <button aria-label="Move up" className="btn w-11 px-0" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></button>
              <button aria-label="Move down" className="btn w-11 px-0" disabled={i === arr.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></button>
              <button aria-label="Duplicate" className="btn w-11 px-0" onClick={() => set([...arr.slice(0, i + 1), { ...b, id: uid() }, ...arr.slice(i + 1)])}><Copy className="size-4" /></button>
              <button aria-label="Remove" className="btn w-11 px-0" onClick={() => set(arr.filter((x) => x.id !== b.id))}><Trash2 className="size-4" /></button>
            </div>
          </li>
        ))}
      </ol>
      {arr.length === 0 && <p className="text-center text-sm text-muted-foreground">No blocks yet. Add your current pattern to start a song.</p>}
      <p className="px-1 text-[11px] text-muted-foreground">Transport currently loops the selected pattern; song-mode playback is part of the audio engine work.</p>
    </div>
  );
}
