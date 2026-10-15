import { useFrost } from "@/lib/frost/store";
import type { Availability } from "@/lib/frost/services";
import type { Pad } from "@/lib/frost/types";
import { Choice } from "./PadsView";
import { cn } from "@/lib/utils";

export function PadEditor({ pad, stretchNote }: { pad: Pad; stretchNote: Availability }) {
  const { project, commit } = useFrost();
  const slice = project.slices.find((s) => s.id === pad.sliceId);
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
        <Slider label="Pitch" value={pad.pitch} min={-24} max={24} step={1} display={`${pad.pitch > 0 ? "+" : ""}${pad.pitch} st`} onChange={(v) => set({ pitch: v })} />
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
        <div className="eyebrow">Fit chop to musical length</div>
        <div className="grid grid-cols-2 gap-2">
          <button className={cn("btn text-xs", pad.timeMode === "repitch" && "btn-on")} onClick={() => set({ timeMode: "repitch" }, true)}>
            Classic repitch
          </button>
          <button className={cn("btn text-xs", pad.timeMode === "stretch" && "btn-on")} onClick={() => set({ timeMode: "stretch" }, true)}>
            Keep pitch (stretch)
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Choice label="Length unit" value={pad.lengthUnit} options={["off", "beats", "bars"]} onChange={(v) => set({ lengthUnit: v }, true)} />
          <label>
            <div className="eyebrow mb-1">Length</div>
            <input className="field" type="number" min={0.25} step={0.25} value={pad.lengthValue} disabled={pad.lengthUnit === "off"} onChange={(e) => set({ lengthValue: Math.max(0.25, Number(e.target.value)) })} />
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {pad.timeMode === "repitch"
            ? "Repitch changes speed and pitch together to fill the length at project BPM."
            : !stretchNote.available ? stretchNote.reason : ""}
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
