import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import type { Pad } from "@/lib/frost/types";
import { playPlan } from "@/lib/frost/timing";
import { pruneKitSources } from "@/lib/frost/kitActions";
import { Segmented, Slider } from "./controls";
import { cn } from "@/lib/utils";

const LENGTHS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 32];

export function PadEditor({ pad, onAddDrum }: { pad: Pad; onAddDrum?: () => void }) {
  const { project, commit } = useFrost();
  const [more, setMore] = useState(false);
  const slice = project.slices.find((s) => s.id === pad.sliceId);
  const plan = slice ? playPlan(pad, slice, project.bpm) : null;
  const grid = slice ? project.beatGrids[slice.sourceId] : undefined;
  const set = (patch: Partial<Pad>, history = false) => commit((p) => ({ ...p, pads: p.pads.map((x) => (x.id === pad.id ? { ...x, ...patch } : x)) }), { history });

  /** Beats the chop lasts at the recording's own tempo (beat markers), else at project BPM. */
  const naturalBeats = slice ? Math.max(0.25, Math.round((((slice.end - slice.start) * (grid?.bpm ?? project.bpm)) / 60) * 4) / 4) : 1;
  const beats = pad.lengthUnit === "off" ? null : pad.lengthUnit === "bars" ? pad.lengthValue * 4 : pad.lengthValue;
  const setFit = (v: "off" | "stretch" | "repitch") =>
    v === "off"
      ? set({ lengthUnit: "off" }, true)
      : set({ timeMode: v, ...(pad.lengthUnit === "off" ? { lengthUnit: "beats", lengthValue: naturalBeats } : {}) }, true);
  const setBeats = (b: number) => set(b >= 4 && b % 4 === 0 ? { lengthUnit: "bars", lengthValue: b / 4 } : { lengthUnit: "beats", lengthValue: b }, true);
  const fit = pad.lengthUnit === "off" ? "off" : pad.timeMode;
  const pitchLocked = fit === "repitch";

  if (!slice) {
    return (
      <section className="panel mt-3 space-y-2 text-sm text-muted-foreground landscape:mt-0 lg:mt-0">
        <div>Pad {pad.id} is empty. Put a drum on it, or select part of a recording on Chop and tap “To pad {pad.id}”.</div>
        {onAddDrum && (
          <button className="btn w-full text-xs" onClick={onAddDrum}>
            Add a drum to {pad.id}
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="panel mt-3 space-y-3 landscape:mt-0 lg:mt-0">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{pad.id}</span>
        <input
          aria-label="Chop name"
          className="min-w-0 flex-1 bg-transparent font-semibold outline-none"
          value={slice.name}
          onChange={(e) => commit((p) => ({ ...p, slices: p.slices.map((s) => (s.id === slice.id ? { ...s, name: e.target.value } : s)) }), { history: false })}
        />
      </div>

      <div className="space-y-2">
        <div className="eyebrow">Fit to the beat</div>
        <Segmented
          value={fit}
          onChange={setFit}
          options={[
            { value: "off", label: "Off" },
            { value: "stretch", label: "Stretch" },
            { value: "repitch", label: "Repitch" },
          ]}
        />
        {beats != null && (
          <div className="flex gap-1 overflow-x-auto pb-1">
            {[...new Set([...LENGTHS, beats])].sort((a, b) => a - b).map((b) => (
              <button key={b} className={cn("btn min-h-9 shrink-0 px-2.5 font-mono text-xs", beats === b && "btn-on")} onClick={() => setBeats(b)}>
                {b >= 4 && b % 4 === 0 ? `${b / 4} bar` : b < 1 ? `${b}b` : `${b} beat${b > 1 ? "s" : ""}`}
              </button>
            ))}
          </div>
        )}
        {plan && (
          <p className="text-[11px] text-muted-foreground">
            {fit === "off" && "Plays at its own length and speed."}
            {fit === "stretch" && `Stretched to ${beats} beat${beats === 1 ? "" : "s"} at ${project.bpm} BPM — pitch stays the same.`}
            {fit === "repitch" && `Sped/slowed to ${beats} beat${beats === 1 ? "" : "s"} at ${project.bpm} BPM — pitch moves ${plan.pitchSemis >= 0 ? "+" : ""}${plan.pitchSemis.toFixed(1)} st, like a classic sampler.`}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Slider label="Volume" value={pad.volume} min={0} max={1} step={0.01} display={`${Math.round(pad.volume * 100)}%`} onChange={(v) => set({ volume: v })} />
        {pitchLocked ? (
          <div>
            <div className="eyebrow mb-1">Pitch</div>
            <div className="text-[11px] text-muted-foreground">Set by Repitch</div>
          </div>
        ) : (
          <Slider label="Pitch" value={pad.pitch} min={-24} max={24} step={1} display={`${pad.pitch > 0 ? "+" : ""}${pad.pitch} st`} onChange={(v) => set({ pitch: v })} />
        )}
      </div>

      <button className="flex w-full items-center justify-between text-xs font-semibold text-muted-foreground" onClick={() => setMore(!more)}>
        More sound settings <ChevronDown className={cn("size-4 transition-transform", more && "rotate-180")} />
      </button>
      {more && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Slider label="Pan" value={pad.pan} min={-1} max={1} step={0.01} display={pad.pan === 0 ? "C" : pad.pan < 0 ? `L${Math.round(-pad.pan * 100)}` : `R${Math.round(pad.pan * 100)}`} onChange={(v) => set({ pan: v })} />
            <Slider label="Velocity" value={pad.velocity} min={1} max={127} step={1} display={String(pad.velocity)} onChange={(v) => set({ velocity: v })} />
            <Slider label="Fade in" value={pad.attack} min={0} max={0.5} step={0.005} display={`${Math.round(pad.attack * 1000)} ms`} onChange={(v) => set({ attack: v })} />
            <Slider label="Fade out" value={pad.release} min={0} max={2} step={0.01} display={`${Math.round(pad.release * 1000)} ms`} onChange={(v) => set({ release: v })} />
          </div>
          <div>
            <div className="eyebrow mb-1">Plays</div>
            <Segmented
              value={pad.mode}
              onChange={(v) => set({ mode: v }, true)}
              options={[
                { value: "oneshot", label: "Whole chop" },
                { value: "gate", label: "While held" },
                { value: "loop", label: "Loop" },
              ]}
            />
          </div>
          <div>
            <div className="eyebrow mb-1">Cuts off pads in group</div>
            <Segmented
              value={pad.choke ?? 0}
              onChange={(v) => set({ choke: v === 0 ? null : v }, true)}
              options={[0, 1, 2, 3, 4].map((n) => ({ value: n, label: n === 0 ? "None" : String(n) }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className={cn("btn text-xs", pad.reverse && "btn-on")} onClick={() => set({ reverse: !pad.reverse }, true)}>
              Reverse {pad.reverse ? "on" : "off"}
            </button>
            <button className="btn text-xs" onClick={() => commit((p) => pruneKitSources({ ...p, pads: p.pads.map((x) => (x.id === pad.id ? { ...x, sliceId: null } : x)) }))}>
              Empty this pad
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
