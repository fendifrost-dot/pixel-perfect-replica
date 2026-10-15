import { useFrost } from "@/lib/frost/store";
import type { Pad } from "@/lib/frost/types";
import { lengthBeats, playPlan } from "@/lib/frost/timing";
import { Choice } from "./PadsView";
import { cn } from "@/lib/utils";

export function PadEditor({ pad }: { pad: Pad }) {
  const { project, commit } = useFrost();
  const slice = project.slices.find((s) => s.id === pad.sliceId);
  const plan = slice ? playPlan(pad, slice, project.bpm) : null;
  const grid = slice ? project.beatGrids[slice.sourceId] : undefined;
  /** Musical length of the chop at the recording's own tempo (beat grid), else at project BPM. */
  const detectLength = () => {
    if (!slice) return;
    const beats = ((slice.end - slice.start) * (grid?.bpm ?? project.bpm)) / 60;
    const q = Math.max(0.25, Math.round(beats * 4) / 4);
    set(q >= 4 && q % 4 === 0 ? { lengthUnit: "bars", lengthValue: q / 4 } : { lengthUnit: "beats", lengthValue: q }, true);
  };
  const set = (patch: Partial<Pad>, history = false) =>
    commit((p) => ({ ...p, pads: p.pads.map((x) => (x.id === pad.id ? { ...x, ...patch } : x)) }), { history });

  return (
    <section className="panel mt-3 space-y-3 landscape:mt-0 lg:mt-0">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="eyebrow">Pad {pad.id}</div>
          {slice ? (
            <input className="w-full bg-transparent font-semibold outline-none" value={slice.name}
              onChange={(e) => commit((p) => ({ ...p, slices: p.slices.map((s) => (s.id === slice.id ? { ...s, name: e.target.value } : s)) }), { history: false })} />
          ) : (
            <div className="text-sm text-muted-foreground">Unassigned — use Sample to assign a chop</div>
          )}
        </div>
        {slice && (
          <button className="btn min-h-9 text-xs" onClick={() => set({ sliceId: null }, true)}>Clear</button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Slider label="Volume" value={pad.volume} min={0} max={1} step={0.01} display={`${Math.round(pad.volume * 100)}%`} onChange={(v) => set({ volume: v })} />
        <Slider label="Pan" value={pad.pan} min={-1} max={1} step={0.01} display={pad.pan === 0 ? "C" : pad.pan < 0 ? `L${Math.round(-pad.pan * 100)}` : `R${Math.round(pad.pan * 100)}`} onChange={(v) => set({ pan: v })} />
        <Slider label={pad.lengthUnit !== "off" && pad.timeMode === "repitch" ? "Pitch (set by fit)" : pad.lengthUnit !== "off" ? "Pitch (keeps length)" : "Pitch"} value={pad.pitch} min={-24} max={24} step={1} display={`${pad.pitch > 0 ? "+" : ""}${pad.pitch} st`} onChange={(v) => set({ pitch: v })} />
        <Slider label="Velocity" value={pad.velocity} min={1} max={127} step={1} display={String(pad.velocity)} onChange={(v) => set({ velocity: v })} />
        <Slider label="Attack" value={pad.attack} min={0} max={1} step={0.005} display={`${Math.round(pad.attack * 1000)} ms`} onChange={(v) => set({ attack: v })} />
        <Slider label="Release" value={pad.release} min={0} max={2} step={0.01} display={`${Math.round(pad.release * 1000)} ms`} onChange={(v) => set({ release: v })} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Choice label="Mode" value={pad.mode} options={["oneshot", "gate", "loop"]} onChange={(v) => set({ mode: v }, true)} />
        <Choice label="Choke" value={pad.choke == null ? "none" : String(pad.choke)} options={["none", "1", "2", "3", "4"]} onChange={(v) => set({ choke: v === "none" ? null : Number(v) }, true)} />
        <div>
          <div className="eyebrow mb-1">Reverse</div>
          <button className={cn("btn w-full min-h-10", pad.reverse && "btn-on")} onClick={() => set({ reverse: !pad.reverse }, true)}>
            {pad.reverse ? "On" : "Off"}
          </button>
        </div>
      </div>

      <div className="space-y-2 rounded-md bg-background p-3">
        <div className="eyebrow">Fit chop to a musical length (project BPM)</div>
        <div className="grid grid-cols-3 gap-2">
          <Choice label="Length" value={pad.lengthUnit} options={["off", "beats", "bars"]} onChange={(v) => set({ lengthUnit: v }, true)} />
          <label>
            <div className="eyebrow mb-1">{pad.lengthUnit === "bars" ? "Bars" : "Beats"}</div>
            <input className="field font-mono" type="number" inputMode="decimal" min={0.25} step={0.25} value={pad.lengthValue} disabled={pad.lengthUnit === "off"} onChange={(e) => set({ lengthValue: Math.max(0.25, Number(e.target.value) || 0.25) })} />
          </label>
          <div>
            <div className="eyebrow mb-1">&nbsp;</div>
            <button className="btn w-full min-h-10 text-xs" disabled={!slice} onClick={detectLength}>Detect</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button className={cn("btn text-xs", pad.timeMode === "stretch" && "btn-on")} onClick={() => set({ timeMode: "stretch" }, true)}>
            Time-stretch (keep pitch)
          </button>
          <button className={cn("btn text-xs", pad.timeMode === "repitch" && "btn-on")} onClick={() => set({ timeMode: "repitch" }, true)}>
            Classic repitch
          </button>
        </div>
        {plan && (
          <div className="font-mono text-[11px] text-muted-foreground">
            {(slice!.end - slice!.start).toFixed(3)}s chop → plays {plan.duration.toFixed(3)}s
            {pad.lengthUnit !== "off" && ` (${lengthBeats(pad)} beats @ ${project.bpm})`} · pitch {plan.pitchSemis >= 0 ? "+" : ""}{plan.pitchSemis.toFixed(2)} st
            {plan.stretch != null && ` · stretch ×${plan.stretch.toFixed(3)}`}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          {pad.lengthUnit === "off"
            ? "Natural length. Pitch changes speed like a classic sampler."
            : pad.timeMode === "repitch"
              ? "Speed and pitch change together to fill the length — the classic sampler sound."
              : "Length changes, pitch stays. The Pitch slider transposes without changing the length."}
          {" "}Quantize (Pads) is separate: it moves when hits start, never how long they play.
        </p>
      </div>
    </section>
  );
}

function Slider({ label, value, min, max, step, display, onChange }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="mb-1 flex justify-between">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-xs">{display}</span>
      </div>
      <input type="range" className="h-8 w-full" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
