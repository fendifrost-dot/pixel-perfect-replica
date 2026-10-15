import { useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Eraser, Plus } from "lucide-react";
import { useFrost, uid } from "@/lib/frost/store";
import type { Pattern } from "@/lib/frost/types";
import { cn } from "@/lib/utils";

export function SequenceView() {
  const { project, commit, currentStep, playing } = useFrost();
  const [page, setPage] = useState(0);
  const [selNote, setSelNote] = useState<string | null>(null);
  const pat = project.patterns.find((p) => p.id === project.currentPatternId)!;
  const pages = pat.lengthSteps / 16;
  const pg = Math.min(page, pages - 1);
  const upd = (fn: (p: Pattern) => Pattern, history = true) =>
    commit((p) => ({ ...p, patterns: p.patterns.map((x) => (x.id === pat.id ? fn(x) : x)) }), { history });
  const note = pat.notes.find((n) => n.id === selNote);

  const toggle = (padId: string, step: number) => {
    const ex = pat.notes.find((n) => n.padId === padId && n.step === step);
    if (ex) {
      if (selNote === ex.id) {
        upd((x) => ({ ...x, notes: x.notes.filter((n) => n.id !== ex.id) }));
        setSelNote(null);
      } else setSelNote(ex.id);
    } else {
      const pad = project.pads.find((p) => p.id === padId);
      const id = uid();
      upd((x) => ({ ...x, notes: [...x.notes, { id, padId, step, velocity: pad?.velocity ?? 100, offset: 0 }] }));
      setSelNote(id);
    }
  };

  const newPattern = (copy: boolean) => {
    const id = uid();
    commit((p) => ({
      ...p,
      currentPatternId: id,
      patterns: [
        ...p.patterns,
        copy
          ? { ...pat, id, name: `${pat.name} copy`, notes: pat.notes.map((n) => ({ ...n, id: uid() })) }
          : { id, name: `Pattern ${p.patterns.length + 1}`, lengthSteps: 16, lanes: pat.lanes.map((l) => ({ ...l, mute: false, solo: false })), notes: [] },
      ],
    }));
  };

  const assigned = project.pads.filter((p) => p.sliceId && !pat.lanes.some((l) => l.padId === p.id));

  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {project.patterns.map((p) => (
          <button key={p.id} onClick={() => commit((x) => ({ ...x, currentPatternId: p.id }), { history: false })} className={cn("btn shrink-0", p.id === pat.id && "btn-on")}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-2">
        <button className="btn text-xs" onClick={() => newPattern(false)}><Plus className="size-4" /> New</button>
        <button className="btn text-xs" onClick={() => newPattern(true)}><Copy className="size-4" /> Duplicate</button>
        <button className="btn text-xs" onClick={() => upd((x) => ({ ...x, notes: [] }))}><Eraser className="size-4" /> Clear</button>
        <select className="field min-h-11" value={pat.lengthSteps} onChange={(e) => upd((x) => ({ ...x, lengthSteps: Number(e.target.value) as Pattern["lengthSteps"], notes: x.notes.filter((n) => n.step < Number(e.target.value)) }))}>
          {[16, 32, 64].map((n) => <option key={n} value={n}>{n / 16} bar{n > 16 ? "s" : ""}</option>)}
        </select>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2">
          {Array.from({ length: pages }, (_, i) => (
            <button key={i} onClick={() => setPage(i)} className={cn("btn min-h-9 w-12", pg === i && "btn-on")}>Bar {i + 1}</button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {pat.lanes.map((lane) => {
          const pad = project.pads.find((p) => p.id === lane.padId);
          const slice = project.slices.find((s) => s.id === pad?.sliceId);
          return (
            <div key={lane.padId} className={cn("panel p-2", lane.mute && "opacity-50")}>
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{lane.padId}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{slice?.name ?? "Empty pad"}</span>
                <button aria-pressed={lane.mute} className={cn("btn min-h-9 w-10 px-0 text-xs", lane.mute && "bg-rec")} onClick={() => upd((x) => ({ ...x, lanes: x.lanes.map((l) => (l.padId === lane.padId ? { ...l, mute: !l.mute } : l)) }))}>M</button>
                <button aria-pressed={lane.solo} className={cn("btn min-h-9 w-10 px-0 text-xs", lane.solo && "btn-on")} onClick={() => upd((x) => ({ ...x, lanes: x.lanes.map((l) => (l.padId === lane.padId ? { ...l, solo: !l.solo } : l)) }))}>S</button>
              </div>
              <div className="grid grid-cols-8 gap-1 sm:grid-cols-16">
                {Array.from({ length: 16 }, (_, i) => {
                  const step = pg * 16 + i;
                  const n = pat.notes.find((x) => x.padId === lane.padId && x.step === step);
                  const now = playing && currentStep % pat.lengthSteps === step;
                  return (
                    <button
                      key={step}
                      aria-label={`Step ${step + 1}`}
                      onClick={() => toggle(lane.padId, step)}
                      className={cn(
                        "relative h-10 overflow-hidden rounded-sm border",
                        i % 4 === 0 ? "bg-surface-2" : "bg-background",
                        now && "border-foreground",
                        n && selNote === n.id && "ring-2 ring-foreground",
                      )}
                    >
                      {n && <span className="absolute inset-x-0 bottom-0 bg-primary" style={{ height: `${(n.velocity / 127) * 100}%` }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {assigned.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {assigned.slice(0, 8).map((p) => (
              <button key={p.id} className="btn min-h-9 text-xs" onClick={() => upd((x) => ({ ...x, lanes: [...x.lanes, { padId: p.id, mute: false, solo: false }] }))}>
                <Plus className="size-3.5" /> Lane {p.id}
              </button>
            ))}
          </div>
        )}
      </div>

      {note && (
        <section className="panel space-y-3">
          <div className="eyebrow">Selected hit · {note.padId} · step {note.step + 1} — tap again to delete</div>
          <label className="block">
            <div className="mb-1 flex justify-between"><span className="eyebrow">Velocity</span><span className="font-mono text-xs">{note.velocity}</span></div>
            <input type="range" min={1} max={127} value={note.velocity} className="h-8 w-full" onChange={(e) => upd((x) => ({ ...x, notes: x.notes.map((n) => (n.id === note.id ? { ...n, velocity: Number(e.target.value) } : n)) }), false)} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="eyebrow mb-1">Move step</div>
              <div className="flex gap-2">
                {[-1, 1].map((d) => (
                  <button key={d} className="btn flex-1" aria-label={d < 0 ? "Earlier step" : "Later step"} onClick={() => {
                    const s = (note.step + d + pat.lengthSteps) % pat.lengthSteps;
                    upd((x) => ({ ...x, notes: x.notes.filter((n) => n.id === note.id || !(n.padId === note.padId && n.step === s)).map((n) => (n.id === note.id ? { ...n, step: s } : n)) }));
                  }}>{d < 0 ? <ChevronLeft className="size-5" /> : <ChevronRight className="size-5" />}</button>
                ))}
              </div>
            </div>
            <label className="block">
              <div className="mb-1 flex justify-between"><span className="eyebrow">Timing nudge</span><span className="font-mono text-xs">{Math.round(note.offset * 100)}%</span></div>
              <input type="range" min={-0.5} max={0.5} step={0.05} value={note.offset} className="h-8 w-full" onChange={(e) => upd((x) => ({ ...x, notes: x.notes.map((n) => (n.id === note.id ? { ...n, offset: Number(e.target.value) } : n)) }), false)} />
            </label>
          </div>
          <button className="btn w-full text-xs" onClick={() => upd((x) => ({ ...x, notes: x.notes.map((n) => ({ ...n, offset: 0 })) }))}>
            Snap all hits to the step grid (permanent)
          </button>
          <p className="text-[11px] text-muted-foreground">
            Quantize moves <em>when</em> a hit starts. It never changes the sample's duration — that's the pad's length/stretch setting.
          </p>
        </section>
      )}
    </div>
  );
}
