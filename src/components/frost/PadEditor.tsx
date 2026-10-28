import { useState } from "react";
import { ChevronDown, Download, Scissors, Trash2 } from "lucide-react";
import { renderService } from "@/lib/frost/render";
import type { RenderedFile } from "@/lib/frost/services";
import { FileList } from "./FileList";
import { useFrost } from "@/lib/frost/store";
import type { Pad } from "@/lib/frost/types";
import { playPlan } from "@/lib/frost/timing";
import { pruneKitSources } from "@/lib/frost/kitActions";
import { Segmented, Slider } from "./controls";
import { ChopTrim } from "./ChopTrim";
import { KeyMatch } from "./KeyMatch";
import { cn } from "@/lib/utils";

const LENGTHS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 32];
/** Speed relative to the chop's natural length: ½× lasts twice as many beats, 2× half as many. */
const SPEEDS = [
  { value: 0.5, label: "½× slower" },
  { value: 1, label: "1× natural" },
  { value: 2, label: "2× faster" },
];
const quarter = (b: number) => Math.max(0.25, Math.round(b * 4) / 4);
const beatLabel = (b: number) => {
  if (b >= 4 && b % 4 === 0) return `${b / 4} bar${b > 4 ? "s" : ""}`;
  const n = Number(b.toFixed(2));
  return b < 1 ? `${n}b` : `${n} beat${n === 1 ? "" : "s"}`;
};

export function PadEditor({ pad, onAddDrum }: { pad: Pad; onAddDrum?: () => void }) {
  const { project, commit, notify } = useFrost();
  const [more, setMore] = useState(false);
  const [trim, setTrim] = useState(false);
  // Export this one pad as it plays; files go through the same list the Export page uses.
  const [busy, setBusy] = useState<string | null>(null);
  const [exported, setExported] = useState<RenderedFile[]>([]);
  const exportPad = async () => {
    setBusy("Preparing…");
    setExported([]);
    try {
      const { files, skipped } = await renderService.renderPadSamples(project, "pad", setBusy, [
        pad.id,
      ]);
      setExported(files);
      if (skipped.length)
        notify(
          `Pad ${pad.id}'s recording isn't loaded on this phone — open Chop and wait for the waveform.`,
        );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const slice = project.slices.find((s) => s.id === pad.sliceId);
  const plan = slice ? playPlan(pad, slice, project.bpm) : null;
  const grid = slice ? project.beatGrids[slice.sourceId] : undefined;
  const set = (patch: Partial<Pad>, history = false) =>
    commit((p) => ({ ...p, pads: p.pads.map((x) => (x.id === pad.id ? { ...x, ...patch } : x)) }), {
      history,
    });

  /** Beats the chop lasts at the recording's own tempo (beat markers), else at project BPM. */
  const naturalExact = slice ? ((slice.end - slice.start) * (grid?.bpm ?? project.bpm)) / 60 : 1;
  const naturalBeats = quarter(naturalExact);
  const beats =
    pad.lengthUnit === "off"
      ? null
      : pad.lengthUnit === "bars"
        ? pad.lengthValue * 4
        : pad.lengthValue;
  const setFit = (v: "off" | "stretch" | "repitch") =>
    v === "off"
      ? set({ lengthUnit: "off" }, true)
      : set(
          {
            timeMode: v,
            ...(pad.lengthUnit === "off" ? { lengthUnit: "beats", lengthValue: naturalBeats } : {}),
          },
          true,
        );
  const setBeats = (b: number) =>
    set(
      b >= 4 && b % 4 === 0
        ? { lengthUnit: "bars", lengthValue: b / 4 }
        : { lengthUnit: "beats", lengthValue: b },
      true,
    );
  const fit = pad.lengthUnit === "off" ? "off" : pad.timeMode;
  const pitchLocked = fit === "repitch";
  /** How fast the chop plays compared with the original recording (1 = untouched). */
  const realSpeed =
    slice && plan && plan.duration > 0 ? (slice.end - slice.start) / plan.duration : 1;
  const speedText = grid
    ? `its groove runs at ${Math.round(grid.bpm * realSpeed)} BPM under your ${project.bpm}`
    : `${realSpeed.toFixed(2)}× its original speed`;
  const emptyPad = () =>
    commit((p) =>
      pruneKitSources({
        ...p,
        pads: p.pads.map((x) => (x.id === pad.id ? { ...x, sliceId: null } : x)),
      }),
    );

  if (!slice) {
    return (
      <section className="pad-inspector panel text-sm text-muted-foreground">
        <div className="inspector-heading">
          <span className="inspector-badge">{pad.id}</span>
          <div>
            <div className="eyebrow">Sound editor</div>
            <div className="mt-1 text-xs">Empty pad</div>
          </div>
        </div>
        <div className="inspector-empty">
          <h2>A space for your sound.</h2>
          <p>Add a drum below, or select part of a recording on Chop and tap “To pad {pad.id}”.</p>
        </div>
        {onAddDrum && (
          <button className="btn btn-primary w-full text-xs" onClick={onAddDrum}>
            Add a drum to {pad.id}
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="pad-inspector panel space-y-4">
      <div className="inspector-heading">
        <span className="inspector-badge">{pad.id}</span>
        <div>
          <div className="eyebrow">Sound editor</div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            {(slice.end - slice.start).toFixed(3)} s ·{" "}
            {pad.mode === "oneshot" ? "One shot" : pad.mode === "gate" ? "While held" : "Loop"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          aria-label="Chop name"
          className="min-w-0 flex-1 bg-transparent font-semibold outline-none"
          value={slice.name}
          onChange={(e) =>
            commit(
              (p) => ({
                ...p,
                slices: p.slices.map((s) =>
                  s.id === slice.id ? { ...s, name: e.target.value } : s,
                ),
              }),
              { history: false },
            )
          }
        />
        <button
          aria-label={`Export pad ${pad.id} as WAV`}
          className="btn min-h-8 shrink-0 px-2.5 text-xs"
          onClick={exportPad}
          disabled={!!busy}
        >
          <Download className="size-3.5" /> {busy ? "Rendering…" : "Export WAV"}
        </button>
        <button
          aria-label={`Remove the sound from pad ${pad.id}`}
          className="btn min-h-8 shrink-0 px-2.5 text-xs"
          onClick={emptyPad}
        >
          <Trash2 className="size-3.5" /> Remove
        </button>
      </div>
      {exported.length > 0 && <FileList files={exported} title={`${project.name} ${pad.id}`} />}

      <div className="space-y-2">
        <button
          className={cn("btn w-full text-xs", trim && "btn-on")}
          onClick={() => setTrim(!trim)}
        >
          <Scissors className="size-3.5" /> {trim ? "Done trimming" : "Trim this chop"}
        </button>
        {trim && <ChopTrim pad={pad} slice={slice} />}
      </div>

      <KeyMatch pad={pad} slice={slice} plan={plan} />

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
          <>
            <div className="grid grid-cols-3 gap-1">
              {SPEEDS.map((sp) => {
                const b = quarter(naturalBeats / sp.value);
                return (
                  <button
                    key={sp.value}
                    className={cn(
                      "btn min-h-9 flex-col gap-0 px-1 text-xs leading-tight",
                      beats != null &&
                        Math.abs(naturalExact / beats - sp.value) < 0.03 * sp.value &&
                        "btn-on",
                    )}
                    onClick={() => setBeats(b)}
                  >
                    <span className="font-semibold">{sp.label}</span>
                    <span className="font-mono text-[10px] opacity-70">{beatLabel(b)}</span>
                  </button>
                );
              })}
            </div>
            <div className="eyebrow pt-1">Or pick the length</div>
            <div className="flex gap-1 overflow-x-auto pb-1">
              {[...new Set([...LENGTHS, beats])]
                .sort((a, b) => a - b)
                .map((b) => (
                  <button
                    key={b}
                    className={cn(
                      "btn min-h-9 shrink-0 px-2.5 font-mono text-xs",
                      beats === b && "btn-on",
                    )}
                    onClick={() => setBeats(b)}
                  >
                    {beatLabel(b)}
                  </button>
                ))}
            </div>
          </>
        )}
        {plan && (
          <p className="text-[11px] text-muted-foreground">
            {fit === "off" && "Plays at its own length and speed."}
            {fit === "stretch" &&
              `Lasts ${beatLabel(beats!)} at ${project.bpm} BPM — ${speedText}. Pitch stays the same.`}
            {fit === "repitch" &&
              `Lasts ${beatLabel(beats!)} at ${project.bpm} BPM — ${speedText}. Pitch moves ${plan.pitchSemis >= 0 ? "+" : ""}${plan.pitchSemis.toFixed(1)} st, like a classic sampler.`}
            {fit !== "off" && ` Natural length ≈ ${beatLabel(naturalBeats)}.`}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Slider
          label="Volume"
          value={pad.volume}
          min={0}
          max={1}
          step={0.01}
          display={`${Math.round(pad.volume * 100)}%`}
          onChange={(v) => set({ volume: v })}
        />
        {pitchLocked ? (
          <div>
            <div className="eyebrow mb-1">Pitch</div>
            <div className="text-[11px] text-muted-foreground">Set by Repitch</div>
          </div>
        ) : (
          <Slider
            label="Pitch"
            value={pad.pitch}
            min={-24}
            max={24}
            step={1}
            display={`${pad.pitch > 0 ? "+" : ""}${pad.pitch} st`}
            onChange={(v) => set({ pitch: v })}
          />
        )}
      </div>

      <button
        className="flex min-h-11 w-full items-center justify-between text-xs font-semibold text-muted-foreground"
        aria-expanded={more}
        onClick={() => setMore(!more)}
      >
        More sound settings{" "}
        <ChevronDown className={cn("size-4 transition-transform", more && "rotate-180")} />
      </button>
      {more && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Slider
              label="Pan"
              value={pad.pan}
              min={-1}
              max={1}
              step={0.01}
              display={
                pad.pan === 0
                  ? "C"
                  : pad.pan < 0
                    ? `L${Math.round(-pad.pan * 100)}`
                    : `R${Math.round(pad.pan * 100)}`
              }
              onChange={(v) => set({ pan: v })}
            />
            <Slider
              label="Velocity"
              value={pad.velocity}
              min={1}
              max={127}
              step={1}
              display={String(pad.velocity)}
              onChange={(v) => set({ velocity: v })}
            />
            <Slider
              label="Fade in"
              value={pad.attack}
              min={0}
              max={0.5}
              step={0.005}
              display={`${Math.round(pad.attack * 1000)} ms`}
              onChange={(v) => set({ attack: v })}
            />
            <Slider
              label="Fade out"
              value={pad.release}
              min={0}
              max={2}
              step={0.01}
              display={`${Math.round(pad.release * 1000)} ms`}
              onChange={(v) => set({ release: v })}
            />
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
              options={[0, 1, 2, 3, 4].map((n) => ({
                value: n,
                label: n === 0 ? "None" : String(n),
              }))}
            />
          </div>
          <button
            className={cn("btn w-full text-xs", pad.reverse && "btn-on")}
            onClick={() => set({ reverse: !pad.reverse }, true)}
          >
            Reverse {pad.reverse ? "on" : "off"}
          </button>
        </div>
      )}
    </section>
  );
}
