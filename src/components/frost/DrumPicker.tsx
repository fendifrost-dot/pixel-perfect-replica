import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Drum, X } from "lucide-react";
import { useFrost, uid } from "@/lib/frost/store";
import { kitService, playbackService } from "@/lib/frost/engine";
import { KITS, kitSourceId } from "@/lib/frost/kits";
import { assignDrum, ensureLane, nextEmptyPad } from "@/lib/frost/kitActions";
import { makePad } from "@/lib/frost/demo";
import { cn } from "@/lib/utils";

/**
 * Built-in drum browser. Tap a drum to hear it; "Add" puts it on a pad (the one given, else the
 * next empty pad in the current bank) and gives it a row on Beat. Every drum is then an ordinary
 * pad: pitch, volume, pan, reverse, choke, gate/loop and fades all work on it.
 */
export function DrumPicker({ padId, onClose }: { padId?: string | undefined; onClose: () => void }) {
  const { project, commit, notify } = useFrost();
  const [kitId, setKitId] = useState(KITS[0].id);
  const kit = KITS.find((k) => k.id === kitId) ?? KITS[0];
  const target = padId ? project.pads.find((x) => x.id === padId) ?? null : nextEmptyPad(project, project.bank);
  const inUse = new Set(
    project.pads.filter((x) => x.sliceId).map((x) => project.slices.find((s) => s.id === x.sliceId)?.sourceId),
  );

  useEffect(() => () => playbackService.stopAudition(), []);

  const preview = async (drumId: string) => {
    if (!playbackService.isReady()) await playbackService.resume();
    const d = kitService.loadDrum(kitId, drumId);
    if (!d) return;
    // Audition through a throwaway pad so it sounds exactly as it will on a pad.
    playbackService.triggerPad({ ...makePad("A", 0), sliceId: "preview" }, { id: "preview", ...d.slice }, 110, project.bpm);
  };

  const addDrum = (drumId: string) => {
    const d = kitService.loadDrum(kitId, drumId);
    if (!d) return notify("That drum isn't available in this version.");
    if (!target) return notify(`Bank ${project.bank} is full — pick another bank or empty a pad.`);
    const sliceId = uid();
    commit((p) => ensureLane(assignDrum(p, target.id, d, sliceId), target.id));
    notify(`${d.slice.name} is on pad ${target.id}.`);
    if (padId) onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end bg-black/50 sm:items-center sm:justify-center" onClick={onClose}>
      <div className="safe-bottom max-h-[85dvh] w-full overflow-y-auto rounded-t-xl bg-background p-4 sm:max-w-md sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="eyebrow">
            <Drum className="mr-1 inline size-4" /> Drums {target ? `→ pad ${target.id}` : `· bank ${project.bank} is full`}
          </div>
          <button aria-label="Close" className="btn size-9 min-h-9 px-0" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <div className="flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Kits">
          {KITS.map((k) => (
            <button key={k.id} role="tab" aria-selected={k.id === kitId} className={cn("btn min-h-9 shrink-0 px-3 text-xs", k.id === kitId && "btn-on")} onClick={() => setKitId(k.id)}>
              {k.name}
            </button>
          ))}
        </div>
        <p className="mb-3 mt-1 px-1 text-[11px] text-muted-foreground">{kit.blurb} Tap to hear, Add to put it on a pad.</p>
        <ul className="space-y-1">
          {kit.drums.map((d) => {
            const used = inUse.has(kitSourceId(kit.id, d.id));
            return (
              <li key={d.id} className="flex items-center gap-2 rounded-md bg-surface px-2 py-1.5">
                <button className="min-w-0 flex-1 py-1 text-left" onClick={() => void preview(d.id)}>
                  <div className="text-sm font-semibold">{d.name}</div>
                  {used && <div className="text-[10px] text-muted-foreground">On a pad</div>}
                </button>
                <button
                  aria-label={`Add ${d.name}`}
                  className={cn("btn btn-primary min-h-9 px-3 text-xs", !target && "opacity-50")}
                  disabled={!target}
                  onClick={() => addDrum(d.id)}
                >
                  Add
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 px-1 text-[11px] text-muted-foreground">
          {padId ? "Adding replaces what's on this pad." : "Each Add fills the next empty pad in the bank."} Shape the sound on Pads: pitch, volume, pan, reverse, choke, fades.
        </p>
      </div>
    </div>,
    document.body,
  );
}
