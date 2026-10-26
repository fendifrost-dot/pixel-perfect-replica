import { useFrost } from "@/lib/frost/store";
import { keyService } from "@/lib/frost/engine";
import { NOTE_NAMES, keyName, keyShift, rootShift, transposeKey } from "@/lib/frost/key";
import { noteName } from "@/lib/frost/hum";
import { INSTRUMENTS, parseKitSourceId } from "@/lib/frost/kits";
import type { PlayPlan } from "@/lib/frost/timing";
import type { Pad, Project, Slice } from "@/lib/frost/types";

const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;
const KEYS = Array.from({ length: 24 }, (_, i) => ({
  tonic: i % 12,
  mode: (i < 12 ? "major" : "minor") as "major" | "minor",
}));

/** The project's beat key picker (shared by the pad editor and Chop). */
export function BeatKeySelect() {
  const { project, commit } = useFrost();
  const k = project.key;
  return (
    <select
      aria-label="Beat key"
      className="field min-h-8 w-auto text-xs"
      value={k ? `${k.tonic}-${k.mode}` : ""}
      onChange={(e) => {
        const v = e.target.value;
        commit((p): Project => {
          if (!v) {
            const { key: _key, ...rest } = p;
            return rest;
          }
          const [t, m] = v.split("-");
          return { ...p, key: { tonic: Number(t), mode: m as "major" | "minor" } };
        });
      }}
    >
      <option value="">Not set</option>
      {KEYS.map((x) => (
        <option key={`${x.tonic}-${x.mode}`} value={`${x.tonic}-${x.mode}`}>
          {keyName(x.tonic, x.mode)}
        </option>
      ))}
    </select>
  );
}

/**
 * A pad's key (samples) or note (drums), the beat's key, and one tap to fit it: a sample moves by
 * the smallest shift into the beat's key keeping its speed; a pitched drum is tuned onto the root.
 */
export function KeyMatch({ pad, slice, plan }: { pad: Pad; slice: Slice; plan: PlayPlan | null }) {
  const { project, commit } = useFrost();
  const kit = parseKitSourceId(slice.sourceId);
  if (kit?.kitId === INSTRUMENTS.id) return null; // instruments play their own notes per hit
  const src = project.sources.find((x) => x.id === slice.sourceId);
  const sampleKey =
    src?.origin === "imported" ? keyService.detect(slice.sourceId, slice.start, slice.end) : null;
  const note = sampleKey ? null : keyService.pitch(slice.sourceId, slice.start, slice.end);
  const beat = project.key;
  const fit = pad.lengthUnit === "off" ? "off" : pad.timeMode;
  const shiftNow = Math.round(plan?.pitchSemis ?? pad.pitch);
  const set = (patch: Partial<Pad>) =>
    commit((p) => ({ ...p, pads: p.pads.map((x) => (x.id === pad.id ? { ...x, ...patch } : x)) }));

  const target = beat
    ? sampleKey
      ? keyShift(sampleKey, beat)
      : note != null
        ? rootShift(note, beat)
        : null
    : null;
  const keepsSpeed = fit === "stretch" || (fit === "off" && !!pad.keepSpeed);
  const matched =
    target != null && pad.pitch === target && fit !== "repitch" && (!sampleKey || keepsSpeed);
  const match = () => {
    if (target == null) return;
    if (!sampleKey) return set({ pitch: target }); // drums: classic tuning, like an MPC
    // samples: change key, never speed (Repitch would override the pitch, so use Stretch)
    if (fit === "repitch") set({ pitch: target, timeMode: "stretch" });
    else if (fit === "off") set({ pitch: target, keepSpeed: true });
    else set({ pitch: target });
  };

  return (
    <div className="space-y-2 rounded-md bg-background p-2 text-xs" aria-label="Chop key">
      <div className="flex items-baseline justify-between gap-2">
        <span className="eyebrow">{sampleKey ? "Key" : "Note"}</span>
        <span className="font-mono">
          {sampleKey
            ? shiftNow
              ? `${sampleKey.name} → plays in ${transposeKey(sampleKey, shiftNow)} (${signed(shiftNow)} st)`
              : sampleKey.name
            : note != null
              ? `${noteName(Math.round(note) + (pad.pitch || 0))}${pad.pitch ? ` (${signed(pad.pitch)} st)` : ""}`
              : src?.origin === "imported"
                ? "too short / unclear to tell"
                : "no clear note (hats, snares…)"}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow">Beat key</span>
        <div className="flex items-center gap-1">
          {!beat && sampleKey && (
            <button
              className="btn min-h-8 px-2 text-xs"
              onClick={() =>
                commit((p) => ({ ...p, key: { tonic: sampleKey.tonic, mode: sampleKey.mode } }))
              }
            >
              Use {sampleKey.name}
            </button>
          )}
          <BeatKeySelect />
        </div>
      </div>
      {target != null && (
        <button className="btn w-full text-xs" disabled={matched} onClick={match}>
          {matched
            ? `✓ In ${keyName(beat!.tonic, beat!.mode)}`
            : sampleKey
              ? `Match ${keyName(beat!.tonic, beat!.mode)} (${signed(target)} st, keeps its speed)`
              : `Tune to ${NOTE_NAMES[beat!.tonic]} (${signed(target)} st)`}
        </button>
      )}
      {fit === "off" && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!pad.keepSpeed}
            onChange={(e) => set({ keepSpeed: e.target.checked })}
          />
          Keep speed when changing pitch{" "}
          {pad.keepSpeed ? "(key changes, length stays)" : "(off: classic — higher is faster)"}
        </label>
      )}
      {fit === "repitch" && (
        <p className="text-muted-foreground">
          Repitch sets the pitch from the length — Match switches the pad to Stretch so it can
          change key.
        </p>
      )}
    </div>
  );
}
