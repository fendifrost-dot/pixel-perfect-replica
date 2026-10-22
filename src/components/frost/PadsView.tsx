import { useRef, useState } from "react";
import { useFrost, uid } from "@/lib/frost/store";
import { playbackService, transportService } from "@/lib/frost/engine";
import { recordOffset } from "@/lib/frost/device";
import { recordPosition } from "@/lib/frost/timing";
import { BANKS, type Pad } from "@/lib/frost/types";
import { PadEditor } from "./PadEditor";
import { DrumPicker } from "./DrumPicker";
import { Drum } from "lucide-react";
import { Segmented } from "./controls";
import { cn } from "@/lib/utils";

const COLOR: Record<Pad["color"], string> = {
  teal: "border-teal/60 bg-teal/10",
  purple: "border-purple/60 bg-purple/10",
  amber: "border-primary/60 bg-primary/10",
};
const HIT: Record<Pad["color"], string> = { teal: "bg-teal/45", purple: "bg-purple/45", amber: "bg-primary/45" };

export function PadsView() {
  const { project, commit, recording, playing, loopMode, notify, setView } = useFrost();
  const [hit, setHit] = useState<Record<string, boolean>>({});
  const [drumsFor, setDrumsFor] = useState<string | null>(null);
  const warned = useRef(false);
  const pads = project.pads.filter((p) => p.bank === project.bank);
  const selected = project.pads.find((p) => p.id === project.selectedPadId);

  const record = (pad: Pad) => {
    if (loopMode === "song") {
      if (!warned.current) notify("Recording goes into a pattern — switch Beat to Pattern.");
      warned.current = true;
      return;
    }
    // Position of what the player was HEARING when they tapped, minus their calibration offset.
    const pos = transportService.positionAt(playbackService.heardTime() - recordOffset.get() / 1000);
    if (pos == null || pos < 0) return;
    const pat = project.patterns.find((p) => p.id === project.currentPatternId)!;
    const { step, offset } = recordPosition(pos, pat.lengthSteps);
    const id = uid();
    // The tap already sounded; don't let the scheduler play this hit again in the same pass.
    transportService.suppress(id, pos + 1);
    commit((p) => ({
      ...p,
      patterns: p.patterns.map((pt) => (pt.id !== pat.id ? pt : { ...pt, notes: [...pt.notes, { id, padId: pad.id, step, velocity: pad.velocity, offset }] })),
    }));
  };

  const down = (pad: Pad) => {
    void playbackService.resume();
    const slice = project.slices.find((s) => s.id === pad.sliceId);
    playbackService.triggerPad(pad, slice, pad.velocity, project.bpm); // sound first, UI after
    if (slice && recording && playing) record(pad);
    setHit((h) => ({ ...h, [pad.id]: true }));
    if (project.selectedPadId !== pad.id) commit((p) => ({ ...p, selectedPadId: pad.id }), { history: false });
  };
  const up = (pad: Pad) => {
    setHit((h) => ({ ...h, [pad.id]: false }));
    playbackService.releasePad(pad.id);
  };

  // rows bottom-up like an MPC: 13–16 on top, 1–4 at the bottom
  const ordered = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3].map((i) => pads[i]);
  const empty = !project.slices.length;

  return (
    <div className="landscape:grid landscape:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] landscape:gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-4">
      <div className="space-y-3">
        <Segmented value={project.bank} onChange={(b) => commit((p) => ({ ...p, bank: b }), { history: false })} options={BANKS.map((b) => ({ value: b, label: `Bank ${b}` }))} />
        {empty && (
          <div className="grid grid-cols-2 gap-2">
            <button className="btn text-xs" onClick={() => setDrumsFor(selected?.id ?? "")}>
              <Drum className="size-4" /> Add drums
            </button>
            <button className="btn text-xs" onClick={() => setView("sample")}>
              Chop a recording
            </button>
          </div>
        )}
        <div className="no-touch-scroll mx-auto grid max-w-[min(100%,70vh)] grid-cols-4 gap-2">
          {ordered.map((pad) => {
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
                <span className="relative line-clamp-2 text-[11px] font-semibold leading-tight">{slice ? slice.name : ""}</span>
              </button>
            );
          })}
        </div>
        <section className="panel space-y-2">
          <div className="flex items-center justify-between">
            <div className="eyebrow">Feel</div>
            <span className="text-[11px] text-muted-foreground">{project.quantize === "off" ? "Live hits play exactly as played" : "Snaps on playback — your take is kept"}</span>
          </div>
          <Segmented
            value={project.quantize}
            onChange={(v) => commit((p) => ({ ...p, quantize: v }))}
            options={[
              { value: "off", label: "Free" },
              { value: "1/8", label: "1/8" },
              { value: "1/16", label: "1/16" },
              { value: "1/32", label: "1/32" },
            ]}
          />
          <label className="flex items-center gap-3 text-xs">
            <span className="w-20 shrink-0 text-muted-foreground">Swing {project.swing}%</span>
            <input
              type="range"
              className="h-8 min-w-0 flex-1"
              min={50}
              max={75}
              value={project.swing}
              onChange={(e) => commit((p) => ({ ...p, swing: Number(e.target.value) }), { history: false })}
            />
          </label>
        </section>
      </div>
      {selected && <PadEditor pad={selected} onAddDrum={() => setDrumsFor(selected.id)} />}
      {drumsFor != null && <DrumPicker padId={drumsFor || undefined} onClose={() => setDrumsFor(null)} />}
    </div>
  );
}
