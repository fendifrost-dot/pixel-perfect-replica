import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, Drum, Eraser, Plus, Trash2 } from "lucide-react";
import { DrumPicker } from "./DrumPicker";
import { useFrost, uid } from "@/lib/frost/store";
import type { Lane, Pattern } from "@/lib/frost/types";
import { Segmented } from "./controls";
import { TimelineView } from "./TimelineView";
import { songToTimeline } from "@/lib/frost/ops";
import { cn } from "@/lib/utils";

/** The beat: one pattern's step grid, or the song (patterns in order). Choosing one also sets what Play plays. */
export function BeatView() {
  const { loopMode, setLoopMode } = useFrost();
  return (
    <div className="space-y-3">
      <Segmented
        value={loopMode}
        onChange={setLoopMode}
        options={[
          { value: "pattern", label: "Pattern (loops)" },
          { value: "song", label: "Song" },
        ]}
      />
      {loopMode === "pattern" ? <PatternEditor /> : <SongEditor />}
    </div>
  );
}

function PatternEditor() {
  const { project, commit, currentStep, playing } = useFrost();
  const [page, setPage] = useState(0);
  const [selNote, setSelNote] = useState<string | null>(null);
  const [drumsOpen, setDrumsOpen] = useState(false);
  const pat = project.patterns.find((p) => p.id === project.currentPatternId)!;
  const [layout, setLayout] = useState<"steps" | "timeline">(() => (pat.lengthSteps > 64 ? "timeline" : "steps"));
  const pages = pat.lengthSteps / 16;
  const pg = Math.min(page, pages - 1);
  const upd = (fn: (p: Pattern) => Pattern, history = true) => commit((p) => ({ ...p, patterns: p.patterns.map((x) => (x.id === pat.id ? fn(x) : x)) }), { history });
  const note = pat.notes.find((n) => n.id === selNote);

  // Rows: pads with hits, pads added here, and the pad selected on Pads — not all 64.
  const rowIds = project.pads
    .filter((p) => pat.notes.some((n) => n.padId === p.id) || pat.lanes.some((l) => l.padId === p.id) || (p.id === project.selectedPadId && p.sliceId))
    .map((p) => p.id);
  const addable = project.pads.filter((p) => p.sliceId && !rowIds.includes(p.id));
  const laneOf = (padId: string): Lane => pat.lanes.find((l) => l.padId === padId) ?? { padId, mute: false, solo: false };
  const setLane = (padId: string, patch: Partial<Lane>) =>
    upd((x) => ({ ...x, lanes: [...x.lanes.filter((l) => l.padId !== padId), { ...laneOf(padId), ...patch }] }));

  const tapStep = (padId: string, step: number) => {
    const ex = pat.notes.find((n) => n.padId === padId && n.step === step);
    if (ex && selNote === ex.id) {
      upd((x) => ({ ...x, notes: x.notes.filter((n) => n.id !== ex.id) }));
      setSelNote(null);
    } else if (ex) setSelNote(ex.id);
    else {
      const id = uid();
      upd((x) => ({ ...x, notes: [...x.notes, { id, padId, step, velocity: project.pads.find((p) => p.id === padId)?.velocity ?? 100, offset: 0 }] }));
      setSelNote(id);
    }
  };

  const addPattern = (copy: boolean) => {
    const id = uid();
    commit((p) => ({
      ...p,
      currentPatternId: id,
      patterns: [
        ...p.patterns,
        copy
          ? { ...pat, id, name: `Pattern ${p.patterns.length + 1}`, notes: pat.notes.map((n) => ({ ...n, id: uid() })) }
          : { id, name: `Pattern ${p.patterns.length + 1}`, lengthSteps: pat.lengthSteps, lanes: [], notes: [] },
      ],
    }));
    setSelNote(null);
  };

  return (
    <>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {project.patterns.map((p) => (
          <button key={p.id} onClick={() => commit((x) => ({ ...x, currentPatternId: p.id }), { history: false })} className={cn("btn min-h-9 shrink-0 text-xs", p.id === pat.id && "btn-on")}>
            {p.name}
          </button>
        ))}
        <button aria-label="New empty pattern" className="btn min-h-9 shrink-0 px-3 text-xs" onClick={() => addPattern(false)}>
          <Plus className="size-4" />
        </button>
      </div>

      <Segmented
        value={layout}
        onChange={setLayout}
        options={[
          { value: "steps", label: "Steps" },
          { value: "timeline", label: "Timeline" },
        ]}
      />

      {layout === "timeline" ? <TimelineView pat={pat} /> : <>
      <div className="flex items-center gap-2">
        {pat.lengthSteps > 64 ? (
          <div className="flex-1 text-xs text-muted-foreground">{pat.lengthSteps / 16} bars — change the length on Timeline</div>
        ) : (
        <Segmented
          className="flex-1"
          value={pat.lengthSteps}
          onChange={(len) => upd((x) => ({ ...x, lengthSteps: len, notes: x.notes.filter((n) => n.step < len) }))}
          options={[
            { value: 16, label: "1 bar" },
            { value: 32, label: "2 bars" },
            { value: 64, label: "4 bars" },
          ]}
        />
        )}
        <button aria-label="Copy pattern" className="btn min-h-11 w-11 px-0" onClick={() => addPattern(true)}>
          <Copy className="size-4" />
        </button>
        <button aria-label="Clear pattern" className="btn min-h-11 w-11 px-0" onClick={() => upd((x) => ({ ...x, notes: [] }))} disabled={!pat.notes.length}>
          <Eraser className="size-4" />
        </button>
      </div>

      {pages > 1 && pages <= 4 && (
        <Segmented value={pg} onChange={setPage} options={Array.from({ length: pages }, (_, i) => ({ value: i, label: `Bar ${i + 1}` }))} />
      )}
      {pages > 4 && (
        <div className="flex gap-1 overflow-x-auto pb-1">
          {Array.from({ length: pages }, (_, i) => (
            <button key={i} className={cn("btn min-h-9 shrink-0 px-3 text-xs", pg === i && "btn-on")} onClick={() => setPage(i)}>
              Bar {i + 1}
            </button>
          ))}
        </div>
      )}

      {!rowIds.length && !addable.length && <p className="panel text-sm text-muted-foreground">Add drums below, or put chops on pads on Chop — then tap steps here, or press ● and play the pads.</p>}

      <div className="space-y-2">
        {rowIds.map((padId) => {
          const lane = laneOf(padId);
          const pad = project.pads.find((p) => p.id === padId);
          const slice = project.slices.find((s) => s.id === pad?.sliceId);
          return (
            <div key={padId} className={cn("panel p-2", lane.mute && "opacity-50")}>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{padId}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{slice?.name ?? "Empty pad"}</span>
                <button aria-pressed={lane.mute} className={cn("btn min-h-8 w-9 px-0 text-xs", lane.mute && "bg-rec")} onClick={() => setLane(padId, { mute: !lane.mute })}>
                  M
                </button>
                <button aria-pressed={lane.solo} className={cn("btn min-h-8 w-9 px-0 text-xs", lane.solo && "btn-on")} onClick={() => setLane(padId, { solo: !lane.solo })}>
                  S
                </button>
              </div>
              <div className="grid grid-cols-8 gap-1 sm:grid-cols-16">
                {Array.from({ length: 16 }, (_, i) => {
                  const step = pg * 16 + i;
                  const n = pat.notes.find((x) => x.padId === padId && x.step === step);
                  const now = playing && currentStep % pat.lengthSteps === step;
                  return (
                    <button
                      key={step}
                      aria-label={`Step ${step + 1}`}
                      onClick={() => tapStep(padId, step)}
                      className={cn(
                        "relative h-10 overflow-hidden rounded-sm border",
                        i % 4 === 0 ? "bg-surface-2" : "bg-background",
                        now && "border-foreground",
                        n && selNote === n.id && "ring-2 ring-foreground",
                      )}
                    >
                      {n && (
                        <span
                          className="absolute inset-x-1 bottom-0 rounded-t-sm bg-primary"
                          style={{ height: `${(n.velocity / 127) * 100}%`, transform: `translateX(${n.offset * 100}%)` }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className={cn("grid gap-2", addable.length > 0 ? "grid-cols-2" : "grid-cols-1")}>
          <button className="btn min-h-10 text-sm" onClick={() => setDrumsOpen(true)}>
            <Drum className="size-4" /> Add drum
          </button>
          {addable.length > 0 && (
            <select className="field min-h-10 text-sm text-muted-foreground" value="" onChange={(e) => e.target.value && setLane(e.target.value, {})}>
              <option value="">+ Add a pad row…</option>
              {addable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {project.slices.find((s) => s.id === p.sliceId)?.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {drumsOpen && <DrumPicker onClose={() => setDrumsOpen(false)} />}

      {note && (
        <section className="panel space-y-3">
          <div className="flex items-center justify-between">
            <div className="eyebrow">
              Hit · {note.padId} · step {note.step + 1}
            </div>
            <button
              className="btn min-h-9 text-xs"
              onClick={() => {
                upd((x) => ({ ...x, notes: x.notes.filter((n) => n.id !== note.id) }));
                setSelNote(null);
              }}
            >
              <Trash2 className="size-4" /> Delete
            </button>
          </div>
          <label className="flex items-center gap-3 text-xs">
            <span className="w-16 shrink-0 text-muted-foreground">Velocity</span>
            <input type="range" min={1} max={127} value={note.velocity} className="h-8 min-w-0 flex-1"
              onChange={(e) => upd((x) => ({ ...x, notes: x.notes.map((n) => (n.id === note.id ? { ...n, velocity: Number(e.target.value) } : n)) }), false)} />
            <span className="w-8 text-right font-mono">{note.velocity}</span>
          </label>
          <label className="flex items-center gap-3 text-xs">
            <span className="w-16 shrink-0 text-muted-foreground">Timing</span>
            <input type="range" min={-0.5} max={0.49} step={0.01} value={note.offset} className="h-8 min-w-0 flex-1"
              onChange={(e) => upd((x) => ({ ...x, notes: x.notes.map((n) => (n.id === note.id ? { ...n, offset: Number(e.target.value) } : n)) }), false)} />
            <span className="w-8 text-right font-mono">{note.offset === 0 ? "0" : `${note.offset > 0 ? "+" : ""}${Math.round(note.offset * 100)}`}</span>
          </label>
          <p className="text-[11px] text-muted-foreground">
            Tap a hit again to delete it. Timing early/late is heard when Feel (Pads) is set to Free.
          </p>
        </section>
      )}
      </>}
    </>
  );
}

function SongEditor() {
  const { project, commit, setLoopMode, notify } = useFrost();
  const arr = project.arrangement;
  const set = (a: typeof arr) => commit((p) => ({ ...p, arrangement: a }));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    const a = [...arr];
    [a[i], a[j]] = [a[j], a[i]];
    set(a);
  };
  const bars = arr.reduce((s, b) => s + (project.patterns.find((p) => p.id === b.patternId)?.lengthSteps ?? 16) / 16, 0);

  return (
    <>
      <div className="panel flex items-center justify-between">
        <div className="font-mono text-sm">
          {bars} bars · {((bars * 4 * 60) / project.bpm).toFixed(1)} s
        </div>
        <button className="btn btn-primary min-h-10" onClick={() => set([...arr, { id: uid(), patternId: project.currentPatternId, label: "" }])}>
          <Plus className="size-4" /> Add pattern
        </button>
      </div>
      <ol className="space-y-2">
        {arr.map((b, i) => (
          <li key={b.id} className="panel flex items-center gap-2 p-2">
            <span className="w-5 text-center font-mono text-xs text-muted-foreground">{i + 1}</span>
            <select className="field min-h-10 min-w-0 flex-1" value={b.patternId} onChange={(e) => set(arr.map((x) => (x.id === b.id ? { ...x, patternId: e.target.value } : x)))}>
              {project.patterns.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button aria-label="Move up" className="btn min-h-10 w-10 px-0" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="size-4" />
            </button>
            <button aria-label="Move down" className="btn min-h-10 w-10 px-0" disabled={i === arr.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="size-4" />
            </button>
            <button aria-label="Remove" className="btn min-h-10 w-10 px-0" onClick={() => set(arr.filter((x) => x.id !== b.id))}>
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ol>
      {arr.length > 0 && (
        <button
          className="btn w-full text-xs"
          onClick={() => {
            try {
              const r = songToTimeline(project);
              commit(() => r.project);
              setLoopMode("pattern");
            } catch (err) {
              notify((err as Error).message);
            }
          }}
        >
          Lay the whole song out on the Timeline
        </button>
      )}
      <p className="px-1 text-[11px] text-muted-foreground">
        {arr.length ? "Play runs the song top to bottom and repeats. Export → Song renders it once." : "Add patterns in the order they should play."}
      </p>
    </>
  );
}
