import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Dices, Plus, Trash2, X } from "lucide-react";
import { useFrost, uid } from "@/lib/frost/store";
import { kitService } from "@/lib/frost/engine";
import { assignDrum } from "@/lib/frost/kitActions";
import { BANKS, type Bank, type Pattern } from "@/lib/frost/types";
import {
  TRAP_KIT,
  TRAP_ROLES,
  addTrapDrums,
  clearTrapDrums,
  hasTrapDrums,
  normaliseSections,
  planTrapPads,
  wholeSection,
  type Density,
  type TrapSection,
} from "@/lib/frost/trapGen";
import { Segmented } from "./controls";
import { cn } from "@/lib/utils";

const DENSITIES: { value: Density; label: string }[] = [
  { value: "sparse", label: "Sparse" },
  { value: "normal", label: "Normal" },
  { value: "busy", label: "Busy" },
];

/** Numeric field edited as text, applied on blur / Enter (so "-" and "." can be typed). */
function NumField({
  value,
  onChange,
  min,
  max,
  step,
  label,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const apply = () => {
    if (text == null) return;
    const v = Number(text.replace(",", "."));
    setText(null);
    if (text.trim() !== "" && Number.isFinite(v))
      onChange(Math.max(min, Math.min(max, Math.round(v / step) * step)));
  };
  return (
    <input
      aria-label={label}
      className={cn("field min-h-9 w-16 text-center font-mono text-xs", className)}
      type="text"
      inputMode="decimal"
      value={text ?? String(Math.round(value * 1000) / 1000)}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value.replace(/[^\d.,-]/g, ""))}
      onBlur={apply}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(null);
      }}
    />
  );
}

/**
 * "Add trap drums": Metro-style hats, snare + clap and accents over this pattern, generated from
 * a seed. The song is split into sections, each with its own offset (for parts whose groove sits
 * on the "&"), density, or skipped. Generated hits are tagged, so Regenerate replaces only them.
 */
export function TrapDrums({ pat, onClose }: { pat: Pattern; onClose: () => void }) {
  const { project, commit, notify } = useFrost();
  const totalBars = Math.max(1, Math.ceil(pat.lengthSteps / 16));
  const [bank, setBank] = useState<Bank>(project.bank);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e6));
  const [sections, setSections] = useState<TrapSection[]>([wholeSection(pat)]);
  const plan = useMemo(() => planTrapPads(project, bank), [project, bank]);
  const existing = hasTrapDrums(pat);

  const setSec = (i: number, patch: Partial<TrapSection>) =>
    setSections(sections.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const splitLast = () => {
    const last = sections[sections.length - 1];
    if (!last || last.endBar - last.startBar < 2)
      return notify("That section is one bar — nothing to split.");
    const mid = Math.floor((last.startBar + last.endBar) / 2);
    setSections([
      ...sections.slice(0, -1),
      { ...last, endBar: mid },
      { ...last, startBar: mid, offsetSteps: 0, skip: false },
    ]);
  };
  const removeSec = (i: number) => {
    if (sections.length === 1) return;
    setSections(sections.filter((_, k) => k !== i));
  };

  const run = () => {
    if (!plan)
      return notify(
        `Bank ${bank} has no room for the drums — pick another bank or empty some pads.`,
      );
    const ok = normaliseSections(sections, totalBars);
    if (!ok.length) return notify("Sections don't cover any bars.");
    // Put any missing drums on pads first (synthesized once, shared), then generate — one undo step.
    const loaded = plan.toLoad.map(({ role, padId }) => ({
      padId,
      drum: kitService.loadDrum(TRAP_KIT, TRAP_ROLES[role]),
    }));
    if (loaded.some((x) => !x.drum))
      return notify("The Metro-style drums kit isn't available in this version.");
    commit((p) => {
      let next = p;
      for (const { padId, drum } of loaded) next = assignDrum(next, padId, drum!, uid());
      return addTrapDrums(next, pat.id, { sections: ok, seed, pads: plan.pads, makeId: uid });
    });
    notify(
      `${existing ? "Regenerated" : "Added"} trap drums over ${ok.filter((s) => !s.skip).reduce((n, s) => n + s.endBar - s.startBar, 0)} bars (seed ${seed}). Undo takes them back.`,
    );
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-end bg-black/50 sm:items-center sm:justify-center"
      onClick={onClose}
    >
      <div
        className="safe-bottom max-h-[90dvh] w-full overflow-y-auto rounded-t-xl bg-background p-4 sm:max-w-lg sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="eyebrow">
            Trap drums · {totalBars} bar{totalBars === 1 ? "" : "s"} at {project.bpm} BPM
          </div>
          <button aria-label="Close" className="btn size-9 min-h-9 px-0" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-3 text-[11px] text-muted-foreground">
          Hats on 8ths with 16th fills and rolls, snare + clap on beat 3, open-hat and perc accents
          — Metro-style, from the built-in kit. Split the song into sections when part of it lands
          on the offbeat, or to leave an interlude without drums.
        </p>

        <div className="mb-3 space-y-2">
          {sections.map((s, i) => (
            <div
              key={i}
              className={cn("space-y-2 rounded-md bg-surface p-2", s.skip && "opacity-60")}
              aria-label={`Section ${i + 1}`}
            >
              <div className="flex items-center gap-2 text-xs">
                <span className="eyebrow">Section {i + 1}</span>
                <span className="text-muted-foreground">bars</span>
                <NumField
                  label={`Section ${i + 1} start bar`}
                  value={s.startBar + 1}
                  min={1}
                  max={totalBars}
                  step={1}
                  onChange={(v) => setSec(i, { startBar: v - 1 })}
                />
                <span className="text-muted-foreground">to</span>
                <NumField
                  label={`Section ${i + 1} end bar`}
                  value={s.endBar}
                  min={1}
                  max={totalBars}
                  step={1}
                  onChange={(v) => setSec(i, { endBar: v })}
                />
                <div className="flex-1" />
                <button
                  aria-label={`Remove section ${i + 1}`}
                  className="btn min-h-8 w-9 px-0"
                  disabled={sections.length === 1}
                  onClick={() => removeSec(i)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Offset</span>
                <NumField
                  label={`Section ${i + 1} offset in steps`}
                  value={s.offsetSteps}
                  min={-8}
                  max={8}
                  step={1 / 6}
                  onChange={(v) => setSec(i, { offsetSteps: v })}
                />
                <span className="text-[10px] text-muted-foreground">
                  steps (+2 = starts on the &)
                </span>
                <div className="flex-1" />
                <button
                  aria-pressed={!!s.skip}
                  className={cn("btn min-h-8 px-2.5 text-xs", s.skip && "btn-on")}
                  onClick={() => setSec(i, { skip: !s.skip })}
                >
                  {s.skip ? "Skipped" : "Skip"}
                </button>
              </div>
              {!s.skip && (
                <Segmented
                  value={s.density}
                  onChange={(v) => setSec(i, { density: v })}
                  options={DENSITIES}
                />
              )}
            </div>
          ))}
          <button className="btn min-h-9 w-full text-xs" onClick={splitLast}>
            <Plus className="size-4" /> Split the last section
          </button>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <div className="eyebrow mb-1">Drums go on bank</div>
            <Segmented
              value={bank}
              onChange={setBank}
              options={BANKS.map((b) => ({ value: b, label: b }))}
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              {plan
                ? plan.toLoad.length
                  ? `Adds ${plan.toLoad.map((x) => x.padId).join(", ")}.`
                  : "Uses the drums already on this bank."
                : "No room on this bank."}
            </p>
          </div>
          <div>
            <div className="eyebrow mb-1">Seed</div>
            <div className="flex items-center gap-1">
              <NumField
                label="Seed"
                value={seed}
                min={0}
                max={999999}
                step={1}
                className="w-24"
                onChange={setSeed}
              />
              <button
                aria-label="New seed"
                className="btn min-h-9 w-9 px-0"
                onClick={() => setSeed(Math.floor(Math.random() * 1e6))}
              >
                <Dices className="size-4" />
              </button>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">Same seed, same drums.</p>
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <button className="btn btn-primary h-12" onClick={run} disabled={!plan}>
            {existing ? "Regenerate trap drums" : "Add trap drums"}
          </button>
          <button
            className="btn h-12 text-xs"
            disabled={!existing}
            onClick={() => {
              commit((p) => clearTrapDrums(p, pat.id));
              notify("Generated drums removed. Your own hits are untouched.");
              onClose();
            }}
          >
            Remove
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Only the generated hits are replaced or removed — anything you placed yourself stays.
        </p>
      </div>
    </div>,
    document.body,
  );
}
