import { useEffect, useRef, useState } from "react";
import { Mic, Play, RotateCcw, Square, X } from "lucide-react";
import { useFrost, uid } from "@/lib/frost/store";
import { ac, kitService, micService, playbackService, transportService } from "@/lib/frost/engine";
import { recordOffset } from "@/lib/frost/device";
import { stepDur } from "@/lib/frost/timing";
import { INSTRUMENTS, KITS, kitSourceId } from "@/lib/frost/kits";
import { assignDrum, ensureLane, nextEmptyPad } from "@/lib/frost/kitActions";
import { stepsToFit } from "@/lib/frost/ops";
import { makePad } from "@/lib/frost/demo";
import {
  beatboxHits,
  melodyHits,
  noteName,
  octaveShift,
  transcribeBeatbox,
  transcribeHum,
  type BeatboxHit,
  type BeatboxKind,
  type HumNote,
} from "@/lib/frost/hum";
import type { MicTake } from "@/lib/frost/services";
import type { NoteEvent, Pattern, Project } from "@/lib/frost/types";
import { Segmented } from "./controls";
import { cn } from "@/lib/utils";

type Mode = "melody" | "beatbox";
/** Which drum of each kit a beatboxed sound becomes. */
const BEATBOX_DRUMS: Record<string, Record<BeatboxKind, string>> = {
  westside: { kick: "kick", snare: "snare", hat: "hat" },
  trap808: { kick: "808c", snare: "snare", hat: "hat" },
};
const DRUM_KITS = KITS.filter((k) => BEATBOX_DRUMS[k.id]);

/** First empty pad: the current bank first, then any bank. */
const freePad = (p: Project) => nextEmptyPad(p, p.bank) ?? p.pads.find((x) => !x.sliceId) ?? null;

/** Add hits to a pattern, making it long enough to hold them. */
function addToPattern(p: Project, patId: string, hits: NoteEvent[]): Project {
  return {
    ...p,
    patterns: p.patterns.map((x) =>
      x.id !== patId ? x : { ...x, notes: [...x.notes, ...hits], lengthSteps: Math.max(x.lengthSteps, ...hits.map((h) => stepsToFit(h.step))) },
    ),
  };
}

/**
 * Record from the mic over the beat and turn it into hits: a hummed line becomes notes on an
 * instrument (808, bass guitar, keys…), beatboxing becomes kick / snare / hat on a drum kit.
 * Everything is worked out on the phone; the recording itself is not kept.
 */
export function HumRecorder({ pat, snap, onClose }: { pat: Pattern; snap: number; onClose: () => void }) {
  const { project, commit, playing, togglePlay, repeat, notify } = useFrost();
  const [mode, setMode] = useState<Mode>("melody");
  const [phase, setPhase] = useState<"ready" | "recording" | "review">("ready");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [notes, setNotes] = useState<HumNote[]>([]);
  const [beats, setBeats] = useState<BeatboxHit[]>([]);
  const [instrument, setInstrument] = useState(INSTRUMENTS.drums[0].id);
  const [shift, setShift] = useState(0);
  const [kit, setKit] = useState(DRUM_KITS[0]?.id ?? "westside");
  const [snapOn, setSnapOn] = useState(true);
  const take = useRef<MicTake | null>(null);
  /** Where the beat was when recording began: maps take time → timeline steps. */
  const anchor = useRef<{ time: number; pos: number; bpm: number; ownTransport: boolean; storePlayback: boolean } | null>(null);
  const root = INSTRUMENTS.drums.find((d) => d.id === instrument)?.rootMidi ?? 36;
  const avail = micService.availability();

  // live meter + clock while recording
  useEffect(() => {
    if (phase !== "recording") return;
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      setLevel(micService.level());
      setElapsed((performance.now() - t0) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);
  // never leave the mic open
  useEffect(() => () => void micService.stop(), []);

  const start = async () => {
    setError(null);
    if (!playbackService.isReady() && !(await playbackService.resume())) return setError("Audio is blocked on this phone. Check the volume and try again.");
    try {
      await micService.start();
    } catch (e) {
      return setError((e as Error).message);
    }
    let ownTransport = false;
    let storePlayback = false;
    if (!transportService.isRunning()) {
      const playable = new Set(project.pads.filter((x) => x.sliceId).map((x) => x.id));
      if (pat.notes.some((n) => playable.has(n.padId))) {
        await togglePlay(); // play the beat to hum over
        storePlayback = true;
      } else {
        // nothing to play yet: run the clock with the metronome so the take still lands in time
        transportService.start(() => project, () => {}, () => true, "pattern", () => true, () => {});
        ownTransport = true;
      }
    }
    const now = ac().currentTime;
    anchor.current = { time: now, pos: transportService.positionAt(now) ?? 0, bpm: project.bpm, ownTransport, storePlayback };
    setPhase("recording");
  };

  const stop = () => {
    const t = micService.stop();
    const a = anchor.current;
    if (a?.ownTransport) transportService.stop();
    else if (a?.storePlayback && playing) void togglePlay();
    take.current = t;
    if (!t) {
      setPhase("ready");
      return setError("Nothing was recorded. Check the microphone and try again.");
    }
    if (mode === "melody") {
      const found = transcribeHum(t.samples, t.sampleRate);
      setNotes(found);
      setShift(octaveShift(found, root));
    } else setBeats(transcribeBeatbox(t.samples, t.sampleRate));
    setPhase("review");
  };

  /** Timeline step of a moment `sec` into the take (calibrated for this phone's delay; wraps when looping). */
  const stepAt = (sec: number) => {
    const t = take.current!, a = anchor.current!;
    const pos = a.pos + (t.startTime + sec - recordOffset.get() / 1000 - a.time) / stepDur(a.bpm);
    return repeat ? ((pos % pat.lengthSteps) + pat.lengthSteps) % pat.lengthSteps : pos;
  };
  const placement = () => ({ stepAt, snap: snapOn ? snap : 0, makeId: uid });

  const listen = async () => {
    if (!playbackService.isReady()) await playbackService.resume();
    playbackService.stopAll();
    const now = ac().currentTime + 0.1;
    const sd = stepDur(project.bpm);
    if (mode === "melody") {
      const d = kitService.loadDrum(INSTRUMENTS.id, instrument);
      if (!d) return;
      const hits = melodyHits(notes, "preview", root, shift, placement());
      const first = Math.min(...hits.map((h) => h.step));
      const slice = { id: "preview", ...d.slice };
      for (const h of hits)
        playbackService.triggerPad({ ...makePad("A", 0), id: "preview", sliceId: "preview", volume: d.level, pitch: h.pitch ?? 0 }, slice, h.velocity, project.bpm, now + (h.step - first) * sd);
    } else {
      const drums = BEATBOX_DRUMS[kit];
      const hits = beatboxHits(beats, { kick: "kick", snare: "snare", hat: "hat" }, placement());
      const first = Math.min(...hits.map((h) => h.step));
      for (const h of hits) {
        const d = kitService.loadDrum(kit, drums[h.padId as BeatboxKind]);
        if (d) playbackService.triggerPad({ ...makePad("A", 0), id: `preview-${h.padId}`, sliceId: "preview", volume: d.level }, { id: "preview", ...d.slice }, h.velocity, project.bpm, now + (h.step - first) * sd);
      }
    }
  };

  const add = () => {
    try {
      let next: Project = project;
      let summary = "";
      if (mode === "melody") {
        const pad = freePad(next);
        if (!pad) throw new Error("Every pad is taken — empty one on Pads first.");
        const d = kitService.loadDrum(INSTRUMENTS.id, instrument);
        if (!d) throw new Error("That instrument isn't available.");
        next = ensureLane(assignDrum(next, pad.id, d, uid()), pad.id);
        const hits = melodyHits(notes, pad.id, root, shift, placement());
        next = addToPattern(next, pat.id, hits);
        summary = `${hits.length} note${hits.length === 1 ? "" : "s"} on pad ${pad.id} (${d.slice.name}).`;
      } else {
        const drums = BEATBOX_DRUMS[kit];
        const padFor = {} as Record<BeatboxKind, string>;
        for (const kind of ["kick", "snare", "hat"] as BeatboxKind[]) {
          if (!beats.some((b) => b.kind === kind)) continue;
          const src = kitSourceId(kit, drums[kind]);
          const have = next.pads.find((x) => next.slices.find((s) => s.id === x.sliceId)?.sourceId === src);
          if (have) {
            padFor[kind] = have.id;
            continue;
          }
          const pad = freePad(next);
          const d = kitService.loadDrum(kit, drums[kind]);
          if (!pad || !d) throw new Error("Not enough empty pads for the drums — empty some on Pads first.");
          next = ensureLane(assignDrum(next, pad.id, d, uid()), pad.id);
          padFor[kind] = pad.id;
        }
        const hits = beatboxHits(beats, padFor, placement());
        next = addToPattern(next, pat.id, hits);
        summary = `${hits.length} drum hit${hits.length === 1 ? "" : "s"} added.`;
      }
      commit(() => next);
      notify(`${summary} Undo takes it back.`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const counts = { kick: 0, snare: 0, hat: 0 };
  for (const b of beats) counts[b.kind]++;
  const heard = mode === "melody" ? notes.length : beats.length;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[65] p-2" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
      <section className="panel mx-auto max-w-2xl space-y-2 shadow-lg" aria-label="Record a sound">
        <div className="flex items-center gap-2">
          <Mic className="size-4 text-primary" />
          <div className="eyebrow flex-1">Hum it · beatbox it</div>
          <button aria-label="Close" className="btn size-9 min-h-9 px-0" onClick={() => (phase === "recording" ? stop() : onClose())}>
            <X className="size-4" />
          </button>
        </div>

        {!avail.available ? (
          <p className="text-sm text-muted-foreground">{avail.reason}</p>
        ) : phase === "ready" ? (
          <>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: "melody", label: "Melody / bass" },
                { value: "beatbox", label: "Beatbox drums" },
              ]}
            />
            <p className="text-[11px] text-muted-foreground">
              {mode === "melody"
                ? "Hum or sing one note at a time (“doo doo” works well). You'll pick the instrument after."
                : "“Boom” = kick, “ka” or “psh” = snare, “ts” = hat."}{" "}
              The beat plays while you record{pat.notes.length ? "" : " (a click if there's no beat yet)"} — headphones keep it out of the mic.
            </p>
            <button className="btn btn-primary min-h-11 w-full" onClick={() => void start()}>
              <span className="size-3 rounded-full bg-rec" /> Record
            </button>
          </>
        ) : phase === "recording" ? (
          <>
            <div className="flex items-center gap-3">
              <span className="size-3 animate-pulse rounded-full bg-rec" />
              <span className="font-mono text-sm">{elapsed.toFixed(1)} s</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-primary transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
              </div>
            </div>
            <button className="btn btn-on min-h-11 w-full" onClick={stop}>
              <Square className="size-4 fill-current" /> Stop
            </button>
          </>
        ) : (
          <>
            {heard === 0 ? (
              <p className="text-sm text-muted-foreground">
                {mode === "melody" ? "No clear notes heard — hum a little louder and closer, one note at a time." : "No hits heard — make each sound short and punchy."}
              </p>
            ) : mode === "melody" ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Heard {notes.length} note{notes.length === 1 ? "" : "s"}:{" "}
                  <span className="font-mono text-foreground">
                    {notes.slice(0, 16).map((n) => noteName(n.midi + shift)).join(" ")}
                    {notes.length > 16 ? " …" : ""}
                  </span>
                </p>
                <div className="flex flex-wrap gap-1">
                  {INSTRUMENTS.drums.map((d) => (
                    <button
                      key={d.id}
                      className={cn("btn min-h-9 px-2.5 text-xs", instrument === d.id && "btn-on")}
                      onClick={() => {
                        setInstrument(d.id);
                        setShift(octaveShift(notes, d.rootMidi ?? 36));
                      }}
                    >
                      {d.name}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Octave</span>
                  <button aria-label="Octave down" className="btn min-h-8 w-9 px-0" onClick={() => setShift(shift - 12)}>
                    −
                  </button>
                  <span className="w-10 text-center font-mono">{shift > 0 ? `+${shift / 12}` : shift / 12}</span>
                  <button aria-label="Octave up" className="btn min-h-8 w-9 px-0" onClick={() => setShift(shift + 12)}>
                    +
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Heard {counts.kick} kick · {counts.snare} snare · {counts.hat} hat
                </p>
                <Segmented value={kit} onChange={setKit} options={DRUM_KITS.map((k) => ({ value: k.id, label: k.name }))} />
              </>
            )}
            {heard > 0 && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} />
                Snap to the grid ({snap === 0.5 ? "1/32" : snap === 1 ? "1/16" : snap === 2 ? "1/8" : snap === 4 ? "1/4" : "bar"}) — off keeps your exact timing
              </label>
            )}
            <div className="grid grid-cols-3 gap-2">
              <button className="btn min-h-10 text-xs" onClick={() => setPhase("ready")}>
                <RotateCcw className="size-4" /> Again
              </button>
              <button className="btn min-h-10 text-xs" disabled={!heard} onClick={() => void listen()}>
                <Play className="size-4" /> Listen
              </button>
              <button className="btn btn-primary min-h-10 text-xs" disabled={!heard} onClick={add}>
                Add to timeline
              </button>
            </div>
          </>
        )}
        {error && <p className="text-xs text-rec">{error}</p>}
      </section>
    </div>
  );
}
