import { useMemo, useRef, useState } from "react";
import { useFrost, uid } from "@/lib/frost/store";
import { playbackService, transportService } from "@/lib/frost/engine";
import { recordOffset } from "@/lib/frost/device";
import { recordPosition } from "@/lib/frost/timing";
import { BANKS, type Pad, type Slice } from "@/lib/frost/types";
import { audioStore } from "@/lib/frost/audioStore";
import { PadEditor } from "./PadEditor";
import { DrumPicker } from "./DrumPicker";
import { Drum, SlidersHorizontal, Square } from "lucide-react";
import { Segmented } from "./controls";
import { cn } from "@/lib/utils";

/** A tiny view of the actual slice peaks, never a generated decorative waveform. */
function PadSignal({ slice, duration }: { slice: Slice; duration: number }) {
  const { audioVersion } = useFrost();
  const bars = useMemo(() => {
    const peaks = audioStore.getPeaks(slice.sourceId)?.data;
    if (!peaks?.length || duration <= 0) return [];
    const first = Math.floor((slice.start / duration) * peaks.length);
    const last = Math.min(peaks.length, Math.ceil((slice.end / duration) * peaks.length));
    return Array.from({ length: 24 }, (_, i) => {
      const from = first + Math.floor(((last - first) * i) / 24);
      const to = Math.max(from + 1, first + Math.floor(((last - first) * (i + 1)) / 24));
      let peak = 0;
      for (let j = from; j < to; j++) peak = Math.max(peak, peaks[j] ?? 0);
      return Math.max(1, Math.min(20, peak * 20));
    });
  }, [slice.sourceId, slice.start, slice.end, duration, audioVersion]);
  if (!bars.length)
    return <span className="text-[8px] text-muted-foreground">Audio not loaded</span>;
  return (
    <svg className="pad-signal" viewBox="0 0 72 22" preserveAspectRatio="none" aria-hidden="true">
      {bars.map((h, i) => (
        <rect
          key={i}
          x={i * 3}
          y={(22 - h) / 2}
          width="1.5"
          height={h}
          rx=".75"
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

export function PadsView() {
  const { project, commit, recording, playing, togglePlay, loopMode, notify, setView } = useFrost();
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
    const pos = transportService.positionAt(
      playbackService.heardTime() - recordOffset.get() / 1000,
    );
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
              notes: [...pt.notes, { id, padId: pad.id, step, velocity: pad.velocity, offset }],
            },
      ),
    }));
  };

  const play = (pad: Pad, slice: (typeof project.slices)[number] | undefined) => {
    if (playbackService.triggerPad(pad, slice, pad.velocity, project.bpm) || !slice) return;
    const src = project.sources.find((s) => s.id === slice.sourceId);
    notify(
      src
        ? `Pad ${pad.id}: “${src.name}” isn't loaded on this phone yet. Open Chop and wait for the waveform, or re-import it.`
        : `Pad ${pad.id}: its recording is missing from this project. Assign a new chop.`,
    );
  };

  const down = (pad: Pad) => {
    const slice = project.slices.find((s) => s.id === pad.sliceId);
    // Sound first, UI after. If iOS has put audio to sleep, wake it first (one short delay).
    if (playbackService.isReady()) play(pad, slice);
    else
      void playbackService.resume().then((ok) => {
        if (ok) play(pad, slice);
        else notify("Audio is blocked on this phone. Check the volume, then tap the pad again.");
      });
    if (slice && recording && playing) record(pad);
    setHit((h) => ({ ...h, [pad.id]: true }));
    if (project.selectedPadId !== pad.id)
      commit((p) => ({ ...p, selectedPadId: pad.id }), { history: false });
  };
  const up = (pad: Pad) => {
    setHit((h) => ({ ...h, [pad.id]: false }));
    playbackService.releasePad(pad.id);
  };

  // rows bottom-up like an MPC: 13–16 on top, 1–4 at the bottom
  const ordered = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3].map((i) => pads[i]);
  const empty = !project.slices.length;

  return (
    <div className="pad-workspace">
      <div className="min-w-0">
        <section className="pad-deck" aria-label="Performance pads">
          <div className="deck-header">
            <span className="eyebrow">Performance / Bank {project.bank}</span>
            <button
              aria-label="Stop all sound"
              className="btn shrink-0 px-3 text-xs"
              onClick={() => {
                // Silences every pad still ringing (and the beat, if it's playing).
                if (playing) void togglePlay();
                playbackService.stopAll();
                setHit({});
              }}
            >
              <Square className="size-3.5 fill-current" /> Stop
            </button>
          </div>
          <Segmented
            value={project.bank}
            onChange={(b) => commit((p) => ({ ...p, bank: b }), { history: false })}
            options={BANKS.map((b) => ({ value: b, label: `Bank ${b}` }))}
          />
          {empty && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button className="btn text-xs" onClick={() => setDrumsFor(selected?.id ?? "")}>
                <Drum className="size-4" /> Add drums
              </button>
              <button className="btn text-xs" onClick={() => setView("sample")}>
                Chop a recording
              </button>
            </div>
          )}
          <div className="pad-grid no-touch-scroll">
            {ordered.map((pad) => {
              const slice = project.slices.find((s) => s.id === pad.sliceId);
              return (
                <button
                  key={pad.id}
                  aria-label={`${pad.id}: ${slice?.name ?? "Empty pad"}`}
                  aria-pressed={project.selectedPadId === pad.id}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    down(pad);
                  }}
                  onPointerUp={() => up(pad)}
                  onPointerLeave={() => hit[pad.id] && up(pad)}
                  onPointerCancel={() => up(pad)}
                  onLostPointerCapture={() => hit[pad.id] && up(pad)}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      if (!e.repeat) down(pad);
                    }
                  }}
                  onKeyUp={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      up(pad);
                    }
                  }}
                  onBlur={() => hit[pad.id] && up(pad)}
                  onClick={(e) => {
                    if (e.detail === 0) {
                      down(pad);
                      up(pad);
                    }
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  className={cn(
                    "sampler-pad",
                    `pad-${pad.color}`,
                    slice && "has-sound",
                    project.selectedPadId === pad.id && "is-selected",
                    hit[pad.id] && "is-hit",
                  )}
                >
                  <span className="pad-id">
                    {pad.id}
                    {slice && <i />}
                  </span>
                  {slice ? (
                    <PadSignal
                      slice={slice}
                      duration={
                        project.sources.find((s) => s.id === slice.sourceId)?.durationSec ?? 0
                      }
                    />
                  ) : (
                    <span className="pad-empty-mark" aria-hidden="true">
                      +
                    </span>
                  )}
                  <span className="pad-name">{slice ? slice.name : ""}</span>
                </button>
              );
            })}
          </div>
          <div className="deck-footer">
            <span>{pads.filter((p) => p.sliceId).length} / 16 loaded</span>
            <span>Tap to play · select to edit</span>
          </div>
        </section>
        <section className="groove-panel panel space-y-2">
          <div className="groove-heading">
            <SlidersHorizontal className="size-3.5 text-primary" />
            <div className="eyebrow">Groove & timing</div>
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
          <p className="groove-hint">
            {project.quantize === "off"
              ? "Live hits play exactly as played."
              : "Quantize snaps on playback. Your original take is kept."}
          </p>
          <label className="flex items-center gap-3 text-xs">
            <span className="w-20 shrink-0 text-muted-foreground">Swing {project.swing}%</span>
            <input
              type="range"
              className="h-8 min-w-0 flex-1"
              min={50}
              max={75}
              value={project.swing}
              onChange={(e) =>
                commit((p) => ({ ...p, swing: Number(e.target.value) }), { history: false })
              }
            />
          </label>
        </section>
      </div>
      {selected && <PadEditor pad={selected} onAddDrum={() => setDrumsFor(selected.id)} />}
      {drumsFor != null && (
        <DrumPicker padId={drumsFor || undefined} onClose={() => setDrumsFor(null)} />
      )}
    </div>
  );
}
