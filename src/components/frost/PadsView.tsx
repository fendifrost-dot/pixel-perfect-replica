import { useRef, useState } from "react";
import { useFrost, uid } from "@/lib/frost/store";
import { playbackService, transportService } from "@/lib/frost/engine";
import { recordPosition } from "@/lib/frost/timing";
import { BANKS, type Pad } from "@/lib/frost/types";
import { PadEditor } from "./PadEditor";
import { cn } from "@/lib/utils";

const COLOR: Record<Pad["color"], string> = {
  teal: "border-teal/60 bg-teal/10",
  purple: "border-purple/60 bg-purple/10",
  amber: "border-primary/60 bg-primary/10",
};
const HIT: Record<Pad["color"], string> = { teal: "bg-teal/45", purple: "bg-purple/45", amber: "bg-primary/45" };
const REPEAT_DIV = { "1/8": 2, "1/16": 4, "1/32": 8 } as const;

const OFFSET_KEY = "frost-sampler:record-offset-ms";
const readOffset = () => {
  try {
    return Number(localStorage.getItem(OFFSET_KEY)) || 0;
  } catch {
    return 0;
  }
};

export function PadsView() {
  const { project, commit, recording, playing, loopMode, notify } = useFrost();
  const [hit, setHit] = useState<Record<string, boolean>>({});
  const [recOffset, setRecOffset] = useState(readOffset);
  const repeat = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const warned = useRef(false);
  const pads = project.pads.filter((p) => p.bank === project.bank);
  const selected = project.pads.find((p) => p.id === project.selectedPadId);

  const record = (pad: Pad) => {
    if (loopMode === "song") {
      if (!warned.current) notify("Recording writes into a pattern — switch the transport to Pattern loop.");
      warned.current = true;
      return;
    }
    // Position of what the player was HEARING when they tapped, minus their calibration offset.
    const pos = transportService.positionAt(playbackService.heardTime() - recOffset / 1000);
    if (pos == null || pos < 0) return;
    const pat = project.patterns.find((p) => p.id === project.currentPatternId)!;
    const { step, offset } = recordPosition(pos, pat.lengthSteps);
    const id = uid();
    // The tap already sounded; don't let the scheduler play this hit again in the same pass.
    transportService.suppress(id, pos + 1);
    commit((p) => ({
      ...p,
      patterns: p.patterns.map((pt) =>
        pt.id !== pat.id
          ? pt
          : {
              ...pt,
              lanes: pt.lanes.some((l) => l.padId === pad.id) ? pt.lanes : [...pt.lanes, { padId: pad.id, mute: false, solo: false }],
              notes: [...pt.notes, { id, padId: pad.id, step, velocity: pad.velocity, offset }],
            },
      ),
    }));
  };

  const fire = (pad: Pad) => {
    const slice = project.slices.find((s) => s.id === pad.sliceId);
    const ok = playbackService.triggerPad(pad, slice, pad.velocity, project.bpm);
    if (!ok && slice && !warned.current) {
      warned.current = true;
      notify("Demo chops have no audio. Import a recording to hear pads.");
    }
    if (recording && playing) record(pad);
  };

  const down = (pad: Pad) => {
    void playbackService.resume();
    fire(pad); // sound first, UI after
    setHit((h) => ({ ...h, [pad.id]: true }));
    if (project.selectedPadId !== pad.id) commit((p) => ({ ...p, selectedPadId: pad.id }), { history: false });
    if (project.noteRepeat !== "off") {
      const ms = (60 / project.bpm / REPEAT_DIV[project.noteRepeat]) * 1000;
      repeat.current[pad.id] = setInterval(() => fire(pad), ms);
    }
  };
  const up = (pad: Pad) => {
    setHit((h) => ({ ...h, [pad.id]: false }));
    clearInterval(repeat.current[pad.id]);
    playbackService.releasePad(pad.id);
  };

  return (
    <div className="landscape:grid landscape:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] landscape:gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-4">
      <div className="space-y-3">
        <div className="grid grid-cols-4 gap-2">
          {BANKS.map((b) => (
            <button key={b} onClick={() => commit((p) => ({ ...p, bank: b }), { history: false })} className={cn("btn", project.bank === b && "btn-on")}>
              Bank {b}
            </button>
          ))}
        </div>
        <div className="no-touch-scroll mx-auto grid max-w-[min(100%,70vh)] grid-cols-4 gap-2">
          {[...pads].reverse().reduce<Pad[][]>((rows, p, i) => {
            (rows[Math.floor(i / 4)] ??= []).unshift(p);
            return rows;
          }, []).flat().map((pad) => {
            const slice = project.slices.find((s) => s.id === pad.sliceId);
            return (
              <button
                key={pad.id}
                onPointerDown={(e) => {
                  e.preventDefault();
                  down(pad);
                }}
                onPointerUp={() => up(pad)}
                onPointerLeave={() => hit[pad.id] && up(pad)}
                onPointerCancel={() => up(pad)}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  "relative flex aspect-square flex-col justify-between overflow-hidden rounded-lg border-2 p-2 text-left transition-transform duration-75",
                  slice ? COLOR[pad.color] : "border-border bg-surface",
                  project.selectedPadId === pad.id && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                  hit[pad.id] && "scale-95",
                )}
              >
                {hit[pad.id] && <span className={cn("absolute inset-0", HIT[pad.color])} />}
                <span className="relative font-mono text-[10px] text-muted-foreground">{pad.id}</span>
                <span className="relative line-clamp-2 text-[11px] font-semibold leading-tight">{slice ? slice.name : <span className="text-muted-foreground">Empty</span>}</span>
              </button>
            );
          })}
        </div>
        <div className="panel grid grid-cols-3 gap-2">
          <Choice label="Note repeat" value={project.noteRepeat} options={["off", "1/8", "1/16", "1/32"]} onChange={(v) => commit((p) => ({ ...p, noteRepeat: v }))} />
          <Choice label="Quantize" value={project.quantize} options={["off", "1/8", "1/16", "1/32"]} onChange={(v) => commit((p) => ({ ...p, quantize: v }))} />
          <label>
            <div className="eyebrow mb-1">Swing {project.swing}%</div>
            <input type="range" min={50} max={75} value={project.swing} onChange={(e) => commit((p) => ({ ...p, swing: Number(e.target.value) }), { history: false })} className="w-full" />
          </label>
          <label className="col-span-3 flex items-center justify-between gap-2 text-xs">
            <span>Record timing offset <span className="text-muted-foreground">(calibrate per device)</span></span>
            <input className="field w-24 font-mono" type="number" inputMode="numeric" step={1} value={recOffset} onChange={(e) => {
              const v = Math.max(-200, Math.min(200, Number(e.target.value) || 0));
              setRecOffset(v);
              try { localStorage.setItem(OFFSET_KEY, String(v)); } catch { /* private mode */ }
            }} />
          </label>
          <p className="col-span-3 text-[11px] text-muted-foreground">
            Record (●) while playing captures hits exactly as played. Quantize and swing are applied on playback and export only — set Quantize to off to hear your raw timing. Touch can't sense force; each pad plays at its velocity.
          </p>
        </div>
      </div>
      {selected && <PadEditor pad={selected} />}
    </div>
  );
}

export function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <label>
      <div className="eyebrow mb-1">{label}</div>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}
