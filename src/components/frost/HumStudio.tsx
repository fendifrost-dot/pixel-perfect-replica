import { useEffect, useRef, useState } from "react";
import { Drum, Mic, Play, Plus, Repeat, Square, Timer, Trash2, Upload } from "lucide-react";
import { useFrost, uid } from "@/lib/frost/store";
import { audioStore } from "@/lib/frost/audioStore";
import {
  importService,
  keyService,
  kitService,
  tempoService,
  transportService,
} from "@/lib/frost/engine";
import { renderService } from "@/lib/frost/render";
import { clearSection, humLayers, setHumTempo, startHumSession } from "@/lib/frost/humSession";
import { INSTRUMENTS, parseKitSourceId } from "@/lib/frost/kits";
import { assignDrum, pruneKitSources } from "@/lib/frost/kitActions";
import { stepDur } from "@/lib/frost/timing";
import type { RenderedFile } from "@/lib/frost/services";
import type { Project, SourceAsset } from "@/lib/frost/types";
import { HumRecorder } from "./HumRecorder";
import { Waveform } from "./Waveform";
import { FileList } from "./FileList";
import { cn } from "@/lib/utils";

const NO_PEAKS = new Float32Array(1);
const clock = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
/** Up to two decimals, no trailing zeros: 133.33, 132. */
const bpmText = (v: number) => String(Math.round(v * 100) / 100);

/**
 * Hum tab: bring in a beat bounced from your DAW, hum or beatbox new parts over any section of it,
 * and send just those parts back (WAVs + MIDI). A session is its own project with its own tempo.
 */
export function HumStudio() {
  const { project } = useFrost();
  return project.humSession ? <HumSession /> : <HumSetup />;
}

function HumSetup() {
  const { newProject, setView, commit, bumpAudio, notify } = useFrost();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [asset, setAsset] = useState<SourceAsset | null>(null);
  const [bpm, setBpm] = useState("");
  const [detected, setDetected] = useState<number | null>(null);

  const onFile = async (f: File) => {
    setBusy(true);
    try {
      const a = await importService.importFile(f);
      setAsset(a);
      const s = tempoService.suggestBpm(a.id);
      setDetected(s?.bpm ?? null);
      setBpm(s ? bpmText(s.bpm) : "");
    } catch {
      notify("Couldn't read that file. Try WAV, MP3, AIFF or M4A.");
    } finally {
      setBusy(false);
    }
  };
  const tempo = Number(bpm);
  const ok = asset && tempo >= 40 && tempo <= 300;
  const begin = () => {
    if (!ok) return;
    // its own project, with its own tempo: the sampler project you were in is left as it is
    newProject();
    setView("hum");
    commit(() => startHumSession(asset, tempo, { slice: uid(), note: uid() }));
    bumpAudio();
  };
  const key = asset ? keyService.detect(asset.id) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <section className="panel space-y-3">
        <div className="eyebrow">1 · Bring in your beat</div>
        <p className="text-sm text-muted-foreground">
          Bounce the skeleton of your beat from LUNA (or any DAW) from bar 1, then bring it in here.
          You'll hum or beatbox new parts over it and send just those parts back.
        </p>
        <input
          ref={file}
          type="file"
          accept="audio/*,.wav,.mp3,.aif,.aiff,.m4a"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])}
        />
        <button
          className="btn btn-primary h-12 w-full"
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          <Upload className="size-4" />{" "}
          {busy ? "Reading…" : asset ? "Choose a different file" : "Choose your beat"}
        </button>
        {asset && (
          <>
            <div className="rounded-md bg-background px-3 py-2 text-xs">
              <div className="truncate font-semibold">{asset.name}</div>
              <div className="font-mono text-muted-foreground">
                {clock(asset.durationSec)}
                {key ? ` · ${key.name}` : ""}
              </div>
            </div>
            <div className="eyebrow">2 · Its tempo</div>
            <label className="flex items-center gap-2">
              <input
                className="field w-32 font-mono"
                type="number"
                inputMode="decimal"
                step="0.01"
                value={bpm}
                onChange={(e) => setBpm(e.target.value)}
                placeholder="BPM"
              />
              <span className="text-sm text-muted-foreground">BPM</span>
            </label>
            <p className="text-[11px] text-muted-foreground">
              {detected ? `Sounds like ${bpmText(detected)} BPM (could be half or double). ` : ""}
              Type your LUNA session's exact tempo — decimals are fine (e.g. 133.33) — so the parts
              line up with your beat. This session keeps its own tempo; your sampler projects don't
              change.
            </p>
            <button className="btn btn-primary h-12 w-full" disabled={!ok} onClick={begin}>
              Start hum session
            </button>
          </>
        )}
      </section>
    </div>
  );
}

function HumSession() {
  const {
    project,
    commit,
    setView,
    notify,
    newProject,
    repeat,
    setRepeat,
    metronome,
    setMetronome,
    audioVersion,
    loadingAudio,
  } = useFrost();
  const hs = project.humSession!;
  const pat = project.patterns.find((x) => x.id === hs.patternId);
  const backing = project.pads.find((x) => x.id === hs.backingPadId);
  const slice = project.slices.find((s) => s.id === backing?.sliceId);
  const source = project.sources.find((s) => s.id === slice?.sourceId);
  const buffer = source ? audioStore.getBuffer(source.id) : undefined;
  const sd = stepDur(project.bpm);
  const barSec = 16 * sd;
  const L = pat?.lengthSteps ?? 16;
  const dur = slice ? slice.end - slice.start : 1;

  const [region, setRegion] = useState<{ from: number; to: number }>({ from: 0, to: L });
  const [view, setView2] = useState<[number, number]>([0, dur]);
  const [draftSel, setDraftSel] = useState<{ start: number; end: number } | null>(null);
  const [playingSec, setPlayingSec] = useState(false);
  const [head, setHead] = useState(-1);
  const [rec, setRec] = useState<"melody" | "beatbox" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [files, setFiles] = useState<RenderedFile[]>([]);
  const [bpmEdit, setBpmEdit] = useState<string | null>(null);
  const live = useRef({ project, metronome, repeat });
  live.current = { project, metronome, repeat };

  // the session pattern is the one playing / shown on Beat
  useEffect(() => {
    if (pat && project.currentPatternId !== pat.id)
      commit((p) => ({ ...p, currentPatternId: pat.id }), { history: false });
  }, [pat?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setView2([0, dur]), [source?.id, dur]);
  useEffect(
    () => setRegion((r) => ({ from: Math.min(r.from, L - 16), to: Math.min(r.to, L) })),
    [L],
  );
  useEffect(() => () => void (transportService.isRunning() && transportService.stop()), []);

  if (!pat || !backing || !slice || !source) {
    return (
      <p className="panel text-sm text-muted-foreground">
        This hum session is missing its beat. Start a new one below.
      </p>
    );
  }

  const stopSection = () => {
    transportService.stop();
    setPlayingSec(false);
    setHead(-1);
  };
  const playSection = () => {
    if (transportService.isRunning()) transportService.stop();
    transportService.start(
      () => live.current.project,
      setHead,
      () => live.current.metronome,
      "pattern",
      () => live.current.repeat,
      () => {
        setPlayingSec(false);
        setHead(-1);
      },
      region,
    );
    setPlayingSec(true);
  };

  const sel = draftSel ?? { start: region.from * sd, end: Math.min(dur, region.to * sd) };
  const whole = region.from === 0 && region.to >= L;
  const layers = humLayers(project);
  const lane = (padId: string) => pat.lanes.find((l) => l.padId === padId);
  const setLane = (padId: string, mute: boolean) =>
    commit((p) => ({
      ...p,
      patterns: p.patterns.map((x) =>
        x.id !== pat.id
          ? x
          : {
              ...x,
              lanes: [...x.lanes.filter((l) => l.padId !== padId), { padId, mute, solo: false }],
            },
      ),
    }));
  const key = keyService.detect(source.id);
  const barTimes = Array.from({ length: Math.ceil(dur / barSec) + 1 }, (_, i) => i * barSec).filter(
    (t) => t <= dur,
  );

  const exportLayers = async () => {
    setBusy("Preparing…");
    setFiles([]);
    try {
      const out = await renderService.renderHumLayers(project, setBusy);
      setFiles(out);
      notify(`${out.length} file(s) ready.`);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-audio={audioVersion}>
      <section className="panel space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="eyebrow">Your beat</div>
            <div className="truncate text-sm font-semibold">{source.name}</div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {L / 16} bars · {clock(dur)}
              {key ? ` · ${key.name}` : ""}
            </div>
          </div>
          <label className="flex shrink-0 items-center gap-1 text-xs">
            <input
              aria-label="Session tempo"
              className="field w-24 font-mono"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={bpmEdit ?? bpmText(project.bpm)}
              onChange={(e) => setBpmEdit(e.target.value)}
              onBlur={() => {
                const v = Number(bpmEdit);
                setBpmEdit(null);
                if (bpmEdit == null || !(v >= 40 && v <= 300) || v === project.bpm) return;
                commit((p) => setHumTempo(p, v));
                if (layers.length)
                  notify(
                    "Tempo changed — your layers stay on their bars, so they now land at new times in the beat.",
                  );
              }}
            />
            BPM
          </label>
        </div>
        {buffer ? (
          <Waveform
            className="h-28"
            buffer={buffer}
            peaks={NO_PEAKS}
            duration={dur}
            viewStart={view[0]}
            viewEnd={view[1]}
            onView={(a, b) => setView2([a, b])}
            selection={sel}
            markers={[]}
            beats={barTimes}
            mode="select"
            onSelect={(a, b, final) => {
              if (!final) return setDraftSel({ start: a, end: b });
              setDraftSel(null);
              // snap the section to whole bars
              const from = Math.max(0, Math.floor(a / barSec)) * 16;
              const to = Math.min(L, Math.max(from + 16, Math.ceil(b / barSec - 1e-6) * 16));
              setRegion({ from, to });
              if (playingSec) stopSection();
            }}
            onMarkers={() => {}}
            onBeatMove={() => {}}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {loadingAudio
              ? "Loading your beat…"
              : "Your beat isn't loaded on this device — bring it in again below."}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 text-xs">
            <span className="eyebrow mr-1">Section</span>
            <span className="font-mono">
              {whole ? "whole beat" : `bars ${region.from / 16 + 1}–${region.to / 16}`} ·{" "}
              {clock(region.from * sd)}–{clock(Math.min(dur, region.to * sd))}
              {head >= 0
                ? ` · bar ${Math.floor(head / 16) + 1}.${Math.floor((head % 16) / 4) + 1}`
                : ""}
            </span>
          </div>
          {!whole && (
            <button className="btn min-h-9 text-xs" onClick={() => setRegion({ from: 0, to: L })}>
              Whole beat
            </button>
          )}
          <button
            aria-label="Repeat the section"
            aria-pressed={repeat}
            className={cn("btn min-h-9 w-10 px-0", repeat && "btn-on")}
            onClick={() => setRepeat(!repeat)}
          >
            <Repeat className="size-4" />
          </button>
          <button
            aria-label="Metronome"
            aria-pressed={metronome}
            className={cn("btn min-h-9 w-10 px-0", metronome && "btn-on")}
            onClick={() => setMetronome(!metronome)}
          >
            <Timer className="size-4" />
          </button>
          <button
            aria-label={playingSec ? "Stop" : "Play section"}
            className={cn("btn min-h-9 px-4", playingSec ? "btn-on" : "btn-primary")}
            disabled={!buffer}
            onClick={playingSec ? stopSection : playSection}
          >
            {playingSec ? (
              <Square className="size-4 fill-current" />
            ) : (
              <Play className="size-4 fill-current" />
            )}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Drag across the waveform to pick the bars to work on. Pinch to zoom.
        </p>
      </section>

      <section className="panel space-y-2">
        <div className="eyebrow">
          Hum over {whole ? "the beat" : `bars ${region.from / 16 + 1}–${region.to / 16}`}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            className="btn btn-primary min-h-12"
            disabled={!buffer}
            onClick={() => setRec("beatbox")}
          >
            <Drum className="size-4" /> Beatbox drums
          </button>
          <button
            className="btn btn-primary min-h-12"
            disabled={!buffer}
            onClick={() => setRec("melody")}
          >
            <Mic className="size-4" /> Hum a part
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          The section plays while you record{repeat ? " and loops" : ""}. Use headphones so the beat
          stays out of the mic.
        </p>
      </section>

      <section className="panel space-y-2">
        <div className="flex items-center justify-between">
          <div className="eyebrow">Layers</div>
          <button className="btn min-h-8 text-xs" onClick={() => setView("beat")}>
            Edit in Timeline
          </button>
        </div>
        <div className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate font-semibold">Your beat</span>
          <input
            aria-label="Beat volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={backing.volume}
            className="h-7 w-28"
            onChange={(e) =>
              commit(
                (p) => ({
                  ...p,
                  pads: p.pads.map((x) =>
                    x.id === backing.id ? { ...x, volume: Number(e.target.value) } : x,
                  ),
                }),
                { history: false },
              )
            }
          />
          <button
            aria-pressed={lane(backing.id)?.mute ?? false}
            className={cn("btn min-h-8 w-9 px-0 text-[11px]", lane(backing.id)?.mute && "bg-rec")}
            onClick={() => setLane(backing.id, !(lane(backing.id)?.mute ?? false))}
          >
            M
          </button>
        </div>
        {layers.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            Nothing yet — beatbox some drums or hum a part above.
          </p>
        )}
        {layers.map((pad) => {
          const s = project.slices.find((x) => x.id === pad.sliceId);
          const k = s ? parseKitSourceId(s.sourceId) : null;
          const inst = k?.kitId === INSTRUMENTS.id;
          const count = pat.notes.filter((n) => n.padId === pad.id).length;
          const muted = lane(pad.id)?.mute ?? false;
          return (
            <div
              key={pad.id}
              className={cn(
                "space-y-1 rounded-md bg-background px-2 py-1.5 text-xs",
                muted && "opacity-60",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">{pad.id}</span>
                <span className="min-w-0 flex-1 truncate font-semibold">{s?.name ?? "—"}</span>
                <span className="font-mono text-muted-foreground">{count}</span>
                <button
                  aria-pressed={muted}
                  className={cn("btn min-h-8 w-9 px-0 text-[11px]", muted && "bg-rec")}
                  onClick={() => setLane(pad.id, !muted)}
                >
                  M
                </button>
                {!whole && (
                  <button
                    className="btn min-h-8 px-2 text-[11px]"
                    onClick={() => commit((p) => clearSection(p, [pad.id], region.from, region.to))}
                  >
                    Clear section
                  </button>
                )}
                <button
                  aria-label={`Delete layer ${pad.id}`}
                  className="btn min-h-8 w-9 px-0"
                  onClick={() =>
                    commit((p: Project) =>
                      pruneKitSources({
                        ...p,
                        patterns: p.patterns.map((x) =>
                          x.id !== pat.id
                            ? x
                            : {
                                ...x,
                                notes: x.notes.filter((n) => n.padId !== pad.id),
                                lanes: x.lanes.filter((l) => l.padId !== pad.id),
                              },
                        ),
                        pads: p.pads.map((x) => (x.id === pad.id ? { ...x, sliceId: null } : x)),
                      }),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              {inst && (
                <div className="flex gap-1 overflow-x-auto">
                  {INSTRUMENTS.drums.map((d) => (
                    <button
                      key={d.id}
                      className={cn(
                        "btn min-h-8 shrink-0 px-2 text-[11px]",
                        k?.drumId === d.id && "btn-on",
                      )}
                      onClick={() => {
                        const loaded = kitService.loadDrum(INSTRUMENTS.id, d.id);
                        if (loaded)
                          commit((p) => pruneKitSources(assignDrum(p, pad.id, loaded, uid())));
                      }}
                    >
                      {d.short}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="panel space-y-2">
        <div className="eyebrow">Send to LUNA</div>
        <p className="text-[11px] text-muted-foreground">
          Each layer as a WAV, the layers mixed together (your beat left out), and a MIDI file to
          play the parts with your own drums and 808 — all starting at bar 1 of your beat. In LUNA:
          session at {bpmText(project.bpm)} BPM, drop them where your beat starts.
        </p>
        <button
          className="btn btn-primary h-12 w-full"
          disabled={!!busy || !layers.length}
          onClick={() => void exportLayers()}
        >
          {busy ?? (layers.length ? "Export layers" : "Hum a part first")}
        </button>
        {files.length > 0 && <FileList files={files} title={`${project.name} layers`} />}
      </section>

      <button
        className="btn w-full text-xs"
        onClick={() => {
          stopSection();
          newProject();
          setView("hum");
        }}
      >
        <Plus className="size-4" /> New hum session (another beat)
      </button>

      {rec && (
        <HumRecorder
          pat={pat}
          snap={1}
          region={region}
          initialMode={rec}
          onStep={setHead}
          onClose={() => {
            setRec(null);
            if (transportService.isRunning()) stopSection();
          }}
        />
      )}
    </div>
  );
}
