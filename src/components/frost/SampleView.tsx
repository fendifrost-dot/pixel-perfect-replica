import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  AudioWaveform,
  Eraser,
  Grid3x3,
  Headphones,
  Maximize2,
  Minus,
  Plus,
  Scissors,
  Square,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { useFrost, uid, fmt } from "@/lib/frost/store";
import { audioStore } from "@/lib/frost/audioStore";
import { boundaries, generateBeatGrid, moveBeat } from "@/lib/frost/analysis";
import {
  analysisService,
  importService,
  playbackService,
  sliceService,
  tempoService,
  keyService,
} from "@/lib/frost/engine";
import type { KeyResult } from "@/lib/frost/key";
import { BeatKeySelect } from "./KeyMatch";
import { Waveform, type WaveMode } from "./Waveform";
import { Segmented } from "./controls";
import { cn } from "@/lib/utils";
import { AiChop } from "./AiChop";
import { useMidi } from "./Midi";
import { useZoomKeys, ZOOM_KEYS_HINT } from "./zoomKeys";
import {
  nextEmptyPad,
  viewForSelection,
  zoomAnchor,
  zoomView,
  ZOOM_STEP,
} from "@/lib/frost/waveView";
import { BANKS, type Pad } from "@/lib/frost/types";

type ChopMethod = "transients" | "equal" | "beats";

export function SampleView() {
  const {
    project,
    commit,
    notify,
    audioVersion,
    bumpAudio,
    loadingAudio,
    setView: setWorkspaceView,
  } = useFrost();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<WaveMode>("select");
  const [view, setView] = useState<[number, number]>([0, 1]);
  const [method, setMethod] = useState<ChopMethod>("transients");
  const [sensitivity, setSensitivity] = useState(0.5);
  const [divisions, setDivisions] = useState(16);
  const [everyBeats, setEveryBeats] = useState(1);
  const [suggestion, setSuggestion] = useState<{ bpm: number; confidence: number } | null>(null);
  /** Key of the whole recording (found automatically) and of the selection (on request). */
  const [songKey, setSongKey] = useState<KeyResult | null | "working">(null);
  const [selKey, setSelKey] = useState<{ range: [number, number]; key: KeyResult | null } | null>(
    null,
  );
  const [srcBpm, setSrcBpm] = useState("");
  const [auditioning, setAuditioning] = useState(false);
  const auditionTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const taps = useRef<number[]>([]);

  const recordings = project.sources.filter((s) => s.origin !== "kit");
  const src = recordings.find((s) => s.id === project.activeSourceId) ?? recordings[0];
  const buffer = src ? audioStore.getBuffer(src.id) : undefined;
  const peaks = src ? audioStore.getPeaks(src.id) : undefined;
  const sel = project.selection?.sourceId === src?.id ? project.selection : null;
  const markers = (src && project.markers[src.id]) || [];
  const grid = src ? project.beatGrids[src.id] : undefined;
  const dur = src?.durationSec ?? 1;
  const selectedPad = project.pads.find((p) => p.id === project.selectedPadId);
  const [showGrid, setShowGridState] = useState(gridPref.get);
  const setShowGrid = (on: boolean) => {
    gridPref.set(on);
    setShowGridState(on);
  };

  /** Zoom the waveform: buttons and the Pro Tools keys share this. */
  const zoom = (cmd: "in" | "out" | "all" | "selection"): boolean => {
    if (!src || !peaks) return false;
    const cur: [number, number] = view[1] > view[0] && view[1] <= dur + 1e-9 ? view : [0, dur];
    if (cmd === "all") setView([0, dur]);
    else if (cmd === "selection") {
      if (!sel) return false;
      setView(viewForSelection(sel, dur));
    } else
      setView(zoomView(cur, dur, cmd === "in" ? ZOOM_STEP : 1 / ZOOM_STEP, zoomAnchor(cur, sel)));
    return true;
  };
  useZoomKeys(zoom, !!src && !!peaks);

  // New source: find its key in the background (a beat after the waveform appears).
  useEffect(() => {
    setSelKey(null);
    if (!src || !buffer) return setSongKey(null);
    setSongKey("working");
    const t = setTimeout(() => setSongKey(keyService.detect(src.id)), 60);
    return () => clearTimeout(t);
  }, [src?.id, audioVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // New source: reset the view and suggest its tempo automatically.
  useEffect(() => {
    setView([0, dur]);
    setSuggestion(null);
    setSrcBpm(grid ? String(grid.bpm) : "");
    if (src && buffer && !grid) {
      const s = tempoService.suggestBpm(src.id);
      setSuggestion(s);
      if (s) setSrcBpm(String(s.bpm));
    }
  }, [src?.id, audioVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (f: File) => {
    setBusy(true);
    try {
      const asset = await importService.importFile(f);
      // Start the default selection where the recording becomes audible, not in any leading silence.
      const selStart = Math.min(
        analysisService.firstAudible(asset.id),
        Math.max(0, asset.durationSec - 0.5),
      );
      const selEnd = Math.min(asset.durationSec, selStart + 2);
      commit((p) => ({
        ...p,
        isDemo: false,
        name: p.isDemo ? f.name.replace(/\.[^.]+$/, "") : p.name,
        sources: [...p.sources.filter((s) => s.origin !== "demo"), asset],
        slices: p.isDemo ? [] : p.slices,
        pads: p.isDemo ? p.pads.map((x) => ({ ...x, sliceId: null })) : p.pads,
        patterns: p.isDemo
          ? [{ id: "p1", name: "Pattern 1", lengthSteps: 32, lanes: [], notes: [] }]
          : p.patterns,
        currentPatternId: p.isDemo ? "p1" : p.currentPatternId,
        arrangement: p.isDemo ? [] : p.arrangement,
        export: p.isDemo ? { ...p.export, mode: "stems", range: "pattern" } : p.export,
        activeSourceId: asset.id,
        selection: { sourceId: asset.id, start: selStart, end: selEnd },
        markers: { ...(p.isDemo ? {} : p.markers), [asset.id]: [] },
      }));
      bumpAudio();
      if (asset.persistence !== "device")
        notify(
          "Couldn't save the audio on this device (storage full?). It will need re-importing after reload.",
        );
    } catch {
      notify("Couldn't decode that file. Try WAV, MP3, AIFF or M4A.");
    } finally {
      setBusy(false);
    }
  };

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="audio/*,.mp3,.wav,.aif,.aiff,.m4a"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) void onFile(f);
      }}
    />
  );

  if (!src || !peaks) {
    return (
      <div>
        {fileInput}
        <section className="sample-empty">
          <div className="empty-main">
            <div>
              <div className="eyebrow">Your next beat starts here</div>
              <h2>
                Found a sound?
                <br />
                Make it yours.
              </h2>
              <p>
                Bring in a recording. Find the part that moves you, chop it to the pads, and build
                something only you could make.
              </p>
              <button
                className="btn btn-primary import-button"
                onClick={() => fileRef.current?.click()}
                disabled={busy || loadingAudio}
              >
                <Upload className="size-4" />{" "}
                {busy ? "Decoding…" : loadingAudio ? "Loading saved audio…" : "Import audio"}
                <ArrowUpRight className="ml-3 size-4" />
              </button>
              <button className="drums-start" onClick={() => setWorkspaceView("pads")}>
                Or start with drums
              </button>
            </div>
            <div className="empty-sculpture" aria-hidden="true">
              <span>
                01 <AudioWaveform className="size-6" />
              </span>
              <span>02</span>
              <span>03</span>
              <span>04</span>
            </div>
          </div>
          <div className="import-formats">
            <span>WAV / MP3 / AIFF / M4A</span>
            <span>On-device storage · Cloud sync is optional</span>
          </div>
        </section>
        <div className="workflow-guide">
          <div>
            <span>01 / CHOP</span>
            <h3>Find your moment</h3>
            <p>Zoom into a recording and slice the parts you want to keep.</p>
          </div>
          <div>
            <span>02 / PLAY</span>
            <h3>Follow the feeling</h3>
            <p>Play your chops, layer drums, and record a pattern.</p>
          </div>
          <div>
            <span>03 / EXPORT</span>
            <h3>Keep it moving</h3>
            <p>Take the mix and tracks into LUNA or Pro Tools.</p>
          </div>
        </div>
      </div>
    );
  }

  const [v0, v1] = view[1] > view[0] && view[1] <= dur + 1e-9 ? view : [0, dur];
  const setSel = (start: number, end: number, final = true) =>
    commit((p) => ({ ...p, selection: { sourceId: src.id, start, end } }), { history: final });
  const setMarkers = (m: number[], final: boolean) =>
    commit((p) => ({ ...p, markers: { ...p.markers, [src.id]: m } }), { history: final });
  const useRange = !!sel && sel.end - sel.start > 0.05;
  const range: [number, number] = useRange && sel ? [sel.start, sel.end] : [0, dur];
  const inRange = markers.filter((m) => m > range[0] && m < range[1]);
  const clearSelection = () => {
    if (auditioning) void toggleAudition();
    commit((p) => ({ ...p, selection: null }));
  };
  /** Remove chop markers: those inside the selection when there is one, otherwise all of them. */
  const clearMarkers = (all: boolean) => {
    const keep = all || !useRange ? [] : markers.filter((m) => m < range[0] || m > range[1]);
    setMarkers(keep, true);
    notify(
      all || !useRange
        ? "All chop markers cleared."
        : `${markers.length - keep.length} marker${markers.length - keep.length === 1 ? "" : "s"} cleared from the selection.`,
    );
  };

  const toggleAudition = async () => {
    clearTimeout(auditionTimer.current);
    if (auditioning) {
      playbackService.stopAudition();
      setAuditioning(false);
      return;
    }
    // No selection: play from the left edge of what's on screen to the end.
    const a = sel ? sel.start : Math.max(0, Math.min(v0, dur - 0.05));
    const b = sel ? sel.end : dur;
    if (!playbackService.isReady() && !(await playbackService.resume()))
      return notify("Audio is blocked on this phone. Check the volume, then tap Listen again.");
    if (!playbackService.audition(src.id, a, b))
      return notify(
        "This recording's audio isn't loaded on this phone yet. Wait a moment, or re-import it.",
      );
    setAuditioning(true);
    auditionTimer.current = setTimeout(() => setAuditioning(false), (b - a) * 1000);
  };

  const assignSelection = () => {
    if (!sel || !selectedPad) return;
    const id = uid();
    const bankIds = project.pads.filter((x) => x.bank === selectedPad.bank).map((x) => x.id);
    const next = nextEmptyPad(
      project.pads.map((x) => (x.id === selectedPad.id ? { ...x, sliceId: id } : x)),
      bankIds,
      selectedPad.id,
    );
    commit((p) => ({
      ...p,
      slices: [
        ...p.slices,
        {
          id,
          sourceId: src.id,
          name: `Chop ${p.slices.length + 1}`,
          start: sel.start,
          end: sel.end,
        },
      ],
      pads: p.pads.map((x) => (x.id === selectedPad.id ? { ...x, sliceId: id } : x)),
      // Move on to the next free pad in this bank, so the next chop doesn't land on this one.
      selectedPadId: next ?? p.selectedPadId,
    }));
    notify(
      next
        ? `Selection is on pad ${selectedPad.id}. Next up: pad ${next}.`
        : `Selection is on pad ${selectedPad.id}. Bank ${selectedPad.bank} is full — pick a pad or another bank below.`,
    );
  };

  const snapSelToBeats = () => {
    if (!grid || !sel) return;
    const near = (t: number) =>
      grid.beats.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), grid.beats[0]);
    const a = near(sel.start),
      b = near(sel.end);
    if (b > a) setSel(a, b);
  };

  const autoChop = () => {
    let cuts: number[] = [];
    if (method === "transients")
      cuts = sliceService.autoSlice(src.id, range[0], range[1], sensitivity);
    else if (method === "equal")
      cuts = Array.from(
        { length: divisions - 1 },
        (_, i) => range[0] + ((range[1] - range[0]) * (i + 1)) / divisions,
      );
    else if (grid) cuts = grid.beats.filter((_, i) => i % everyBeats === 0);
    else return notify("Place beat markers first (Tempo, below).");
    const keep = markers.filter((m) => m < range[0] || m > range[1]);
    const fresh = cuts.filter((c) => c > range[0] && c < range[1]);
    setMarkers(
      [...keep, ...fresh].sort((a, b) => a - b),
      true,
    );
    setMode("chop");
    notify(`${fresh.length} chop markers. Drag to adjust, tap one to delete.`);
  };

  const sendToPads = () => {
    const b = boundaries(markers, range[0], range[1]);
    const regions = b
      .slice(0, -1)
      .map((s, i) => ({ start: s, end: b[i + 1] }))
      .slice(0, 16);
    commit((p) => {
      const newSlices = regions.map((r, i) => ({
        id: uid(),
        sourceId: src.id,
        name: `Chop ${p.slices.length + i + 1}`,
        ...r,
      }));
      let k = 0;
      const pads = p.pads.map((x) =>
        x.bank === p.bank && k < newSlices.length ? { ...x, sliceId: newSlices[k++].id } : x,
      );
      return { ...p, slices: [...p.slices, ...newSlices], pads };
    });
    notify(
      `${regions.length} chops on pads ${project.bank}1–${project.bank}${regions.length}${b.length - 1 > 16 ? " (first 16)" : ""}.`,
    );
  };

  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((t) => now - t < 3000), now].slice(-8);
    if (taps.current.length >= 3) {
      const d =
        (taps.current[taps.current.length - 1] - taps.current[0]) / (taps.current.length - 1);
      setSrcBpm(String(Math.round((60000 / d) * 10) / 10));
    }
  };
  const placeBeats = () => {
    const bpm = Number(srcBpm);
    if (!(bpm >= 40 && bpm <= 300)) return notify("Enter the recording's BPM (40–300) or tap it.");
    commit((p) => ({
      ...p,
      beatGrids: { ...p.beatGrids, [src.id]: generateBeatGrid(bpm, sel ? sel.start : 0, dur) },
    }));
    setMode("beats");
    notify("Beat markers start at your selection. Drag any marker onto the beat.");
  };
  const onBeatMove = (i: number, t: number, final: boolean) =>
    grid &&
    commit(
      (p) => ({
        ...p,
        beatGrids: { ...p.beatGrids, [src.id]: moveBeat(p.beatGrids[src.id], i, t) },
      }),
      { history: final },
    );

  return (
    <div className="sample-workspace">
      {fileInput}
      <div className="source-tabs flex gap-2 overflow-x-auto pb-1">
        {recordings.map((s) => (
          <button
            key={s.id}
            onClick={() => commit((p) => ({ ...p, activeSourceId: s.id }))}
            className={cn("btn min-h-9 shrink-0 text-xs", s.id === src.id && "btn-on")}
          >
            {s.name}
          </button>
        ))}
        <button
          aria-label="Import another recording"
          className="btn min-h-9 shrink-0 px-3 text-xs"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          <Plus className="size-4" /> {busy ? "Decoding…" : "Add"}
        </button>
      </div>

      <section className="sample-wave-panel panel space-y-3">
        <div className="flex items-center justify-between gap-2 font-mono text-xs text-muted-foreground">
          <span>
            {fmt(src.durationSec)} · {src.sampleRate / 1000} kHz
          </span>
          {src.persistence !== "device" && (
            <span className="rounded bg-rec/20 px-2 py-0.5 text-[10px] font-bold uppercase text-rec">
              Not saved · re-import after reload
            </span>
          )}
        </div>

        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "select", label: "Select" },
            { value: "chop", label: `Chop markers${markers.length ? ` (${markers.length})` : ""}` },
            { value: "beats", label: "Beat markers" },
          ]}
        />

        <Waveform
          buffer={buffer}
          peaks={peaks.data}
          duration={dur}
          viewStart={v0}
          viewEnd={v1}
          onView={(a, b) => setView([a, b])}
          selection={sel}
          markers={markers}
          beats={grid?.beats ?? []}
          showGrid={showGrid}
          mode={mode}
          onSelect={setSel}
          onMarkers={setMarkers}
          onBeatMove={onBeatMove}
        />

        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {mode === "select" &&
              (sel
                ? `Selection ${(sel.end - sel.start).toFixed(3)}s${grid ? ` · ${(((sel.end - sel.start) * grid.bpm) / 60).toFixed(2)} beats` : ""}`
                : markers.length
                  ? "Drag to select · tap a green marker to delete it"
                  : "Drag to select (none = whole file)")}
            {mode === "chop" &&
              (markers.length
                ? `${markers.length} marker${markers.length === 1 ? "" : "s"} · tap one to delete · tap empty to add`
                : "Tap to add a marker · drag to move")}
            {mode === "beats" &&
              (grid ? "Drag beat markers onto the beat" : "Place beat markers under Tempo")}
            {" · pinch to zoom"}
            <span className="kbd-hint"> · {ZOOM_KEYS_HINT}</span>
          </span>
          <span className="flex shrink-0 gap-1">
            {mode === "select" && sel && (
              <button
                aria-label="Deselect"
                className="btn min-h-8 px-2 text-[11px]"
                onClick={clearSelection}
              >
                <X className="size-3.5" /> Deselect
              </button>
            )}
            {mode === "chop" && markers.length > 0 && useRange && inRange.length > 0 && (
              <button
                aria-label="Clear markers in selection"
                className="btn min-h-8 px-2 text-[11px]"
                onClick={() => clearMarkers(false)}
              >
                <Eraser className="size-3.5" /> In selection
              </button>
            )}
            {mode === "chop" && markers.length > 0 && (
              <button
                aria-label="Clear all markers"
                className="btn min-h-8 px-2 text-[11px]"
                onClick={() => clearMarkers(true)}
              >
                <Eraser className="size-3.5" /> All
              </button>
            )}
            <button
              aria-label={showGrid ? "Hide grid lines" : "Show grid lines"}
              title={`Grid lines: ${grid ? "bars and beats" : "time (place beat markers under Tempo for bars and beats)"}`}
              aria-pressed={showGrid}
              className={cn("btn min-h-8 px-2 text-[11px]", showGrid && "btn-on")}
              onClick={() => setShowGrid(!showGrid)}
            >
              <Grid3x3 className="size-3.5" /> Grid
            </button>
            <button
              aria-label="Zoom out"
              title="Zoom out (R)"
              className="btn min-h-8 w-9 px-0"
              disabled={v1 - v0 >= dur - 1e-6}
              onClick={() => zoom("out")}
            >
              <Minus className="size-4" />
            </button>
            <button
              aria-label="Zoom in"
              title="Zoom in (T)"
              className="btn min-h-8 w-9 px-0"
              disabled={v1 - v0 <= 0.02 + 1e-9}
              onClick={() => zoom("in")}
            >
              <Plus className="size-4" />
            </button>
            {v1 - v0 < dur - 1e-6 && (
              <button
                aria-label="Show whole recording"
                title="Show whole recording (⌥A)"
                className="btn min-h-8 w-9 px-0"
                onClick={() => setView([0, dur])}
              >
                <Maximize2 className="size-4" />
              </button>
            )}
          </span>
        </div>

        <div className={cn("grid gap-2", grid ? "grid-cols-3" : "grid-cols-2")}>
          <button
            className={cn("btn", auditioning && "btn-on")}
            onClick={() => void toggleAudition()}
          >
            {auditioning ? <Square className="size-4" /> : <Headphones className="size-4" />}{" "}
            {auditioning ? "Stop" : "Listen"}
          </button>
          {grid && (
            <button className="btn" onClick={snapSelToBeats} disabled={!sel}>
              Snap to beats
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={assignSelection}
            disabled={!sel || !selectedPad}
          >
            To pad {selectedPad?.id}
          </button>
        </div>

        <ChopPadPicker />
      </section>

      <section className="panel space-y-3">
        <div className="flex items-center justify-between">
          <div className="eyebrow">Auto-chop · {useRange ? "selection" : "whole file"}</div>
          {markers.length > 0 && (
            <button
              className="btn min-h-8 px-2 text-xs"
              onClick={() => clearMarkers(useRange && inRange.length > 0 ? false : true)}
            >
              <Eraser className="size-3.5" /> Clear{" "}
              {useRange && inRange.length > 0
                ? `${inRange.length} in selection`
                : `all ${markers.length}`}
            </button>
          )}
        </div>
        <Segmented
          value={method}
          onChange={setMethod}
          options={[
            { value: "transients", label: "Hits" },
            { value: "equal", label: "Equal" },
            { value: "beats", label: "Beats" },
          ]}
        />
        {method === "transients" && (
          <label className="flex items-center gap-3 text-xs">
            <span className="w-20 shrink-0 text-muted-foreground">Sensitivity</span>
            <input
              type="range"
              className="h-8 min-w-0 flex-1"
              min={0}
              max={1}
              step={0.05}
              value={sensitivity}
              onChange={(e) => setSensitivity(Number(e.target.value))}
            />
          </label>
        )}
        {method === "equal" && (
          <Segmented
            value={divisions}
            onChange={setDivisions}
            options={[4, 8, 16, 32].map((n) => ({ value: n, label: `${n}` }))}
          />
        )}
        {method === "beats" && (
          <Segmented
            value={everyBeats}
            onChange={setEveryBeats}
            options={[
              { value: 1, label: "Beat" },
              { value: 2, label: "2 beats" },
              { value: 4, label: "Bar" },
              { value: 8, label: "2 bars" },
            ]}
          />
        )}
        <div className="grid grid-cols-2 gap-2">
          <button className="btn" onClick={autoChop}>
            <Wand2 className="size-4" /> Find chops
          </button>
          <button
            className="btn btn-primary"
            onClick={sendToPads}
            disabled={!inRange.length && !useRange}
          >
            <Scissors className="size-4" /> To bank {project.bank}
          </button>
        </div>
      </section>

      {src.origin === "imported" && (
        <AiChop source={src} start={range[0]} end={range[1]} disabled={!buffer || loadingAudio} />
      )}

      <section className="panel space-y-2">
        <div className="eyebrow">Tempo of this recording</div>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <input
            className="field font-mono"
            type="number"
            inputMode="decimal"
            value={srcBpm}
            placeholder="BPM"
            onChange={(e) => setSrcBpm(e.target.value)}
          />
          <button className="btn" onClick={tap}>
            Tap
          </button>
          <button className="btn" onClick={placeBeats}>
            {grid ? "Redo markers" : "Beat markers"}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {grid
            ? `${grid.beats.length} beat markers at ${grid.bpm} BPM. Your beat plays at ${project.bpm} BPM.`
            : suggestion
              ? `Sounds like ${suggestion.bpm} BPM${suggestion.confidence > 0.3 ? "" : " (unsure)"} — could also be half or double. Tap to check.`
              : "Tap along or type the BPM, then place beat markers from your selection start."}
        </p>
        {grid && grid.bpm !== project.bpm && (
          <button
            className="btn w-full text-xs"
            onClick={() => commit((p) => ({ ...p, bpm: grid.bpm }))}
          >
            Use {grid.bpm} as the beat's BPM
          </button>
        )}
      </section>

      <section className="panel space-y-2" aria-label="Key">
        <div className="eyebrow">Key</div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-muted-foreground">Whole recording</span>
          <span className="flex items-center gap-2 font-mono text-sm">
            {songKey === "working"
              ? "listening…"
              : songKey
                ? songKey.name
                : buffer
                  ? "can't tell"
                  : "—"}
            {songKey && songKey !== "working" && <UseAsBeatKey k={songKey} />}
          </span>
        </div>
        {sel && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">Selection</span>
            {selKey && selKey.range[0] === sel.start && selKey.range[1] === sel.end ? (
              <span className="flex items-center gap-2 font-mono text-sm">
                {selKey.key ? selKey.key.name : "too short / unclear"}
                {selKey.key && <UseAsBeatKey k={selKey.key} />}
              </span>
            ) : (
              <button
                className="btn min-h-8 px-3 text-xs"
                disabled={!buffer}
                onClick={() =>
                  src &&
                  setSelKey({
                    range: [sel.start, sel.end],
                    key: keyService.detect(src.id, sel.start, sel.end),
                  })
                }
              >
                Find key
              </button>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">Beat key</span>
          <BeatKeySelect />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {songKey && songKey !== "working"
            ? `${songKey.confidence < 0.25 ? `Close call — could be ${songKey.runnerUp}. ` : ""}Relative ${songKey.mode === "minor" ? "major" : "minor"}: ${songKey.relative}.${
                Math.abs(songKey.tuningCents) >= 15
                  ? ` Tuned ${songKey.tuningCents > 0 ? "+" : ""}${songKey.tuningCents} cents from A = 440 — the key shown is what it matches in your DAW.`
                  : ""
              }`
            : "Heard from the notes in the audio, as it sounds at standard A = 440 tuning."}
        </p>
      </section>
    </div>
  );
}

/** Whether the chop waveform shows its ruler and grid lines; remembered on this device. */
const gridPref = {
  get(): boolean {
    try {
      return localStorage.getItem("frost.chopGrid") !== "off";
    } catch {
      return true;
    }
  },
  set(on: boolean) {
    try {
      localStorage.setItem("frost.chopGrid", on ? "on" : "off");
    } catch {
      // private mode: the choice lasts for this visit only
    }
  },
};

/**
 * The pads, right under the waveform: pick the pad the next chop goes to (and hear what's already
 * on it) without leaving Chop. Shows whichever bank is current; the bank can be changed here too.
 */
function ChopPadPicker() {
  const { project, commit, notify } = useFrost();
  const midi = useMidi();
  const pads = project.pads.filter((p) => p.bank === project.bank);
  const pick = (pad: Pad) => {
    if (project.selectedPadId !== pad.id)
      commit((p) => ({ ...p, selectedPadId: pad.id }), { history: false });
    const slice = project.slices.find((s) => s.id === pad.sliceId);
    if (!slice) return;
    const go = () => {
      if (!playbackService.triggerPad(pad, slice, pad.velocity, project.bpm))
        notify(`Pad ${pad.id}: its recording isn't loaded on this device yet.`);
    };
    if (playbackService.isReady()) go();
    else void playbackService.resume().then((ok) => ok && go());
  };
  return (
    <div className="chop-pads" aria-label="Pad for the next chop">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">Send to pad</span>
        <div className="flex gap-1" role="group" aria-label="Bank">
          {BANKS.map((b) => (
            <button
              key={b}
              aria-label={`Bank ${b}`}
              aria-pressed={project.bank === b}
              className={cn("btn min-h-8 w-9 px-0 text-[11px]", project.bank === b && "btn-on")}
              onClick={() =>
                commit(
                  (p) => {
                    if (p.bank === b) return p;
                    // Keep the same pad number in the new bank selected.
                    const from = p.pads.filter((x) => x.bank === p.bank);
                    const to = p.pads.filter((x) => x.bank === b);
                    const at = Math.max(
                      0,
                      from.findIndex((x) => x.id === p.selectedPadId),
                    );
                    return { ...p, bank: b, selectedPadId: to[at]?.id ?? p.selectedPadId };
                  },
                  { history: false },
                )
              }
            >
              {b}
            </button>
          ))}
        </div>
      </div>
      {midi.available && midi.learningLabel && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-black/30 px-3 py-2 text-xs">
          <span>{midi.learningLabel}</span>
          <button className="btn min-h-8 px-2 text-[10px]" onClick={midi.cancelLearn}>
            Cancel
          </button>
        </div>
      )}
      <div className="chop-pad-row">
        {pads.map((pad) => {
          const slice = project.slices.find((s) => s.id === pad.sliceId);
          return (
            <button
              key={pad.id}
              aria-label={`Pad ${pad.id}${slice ? `, ${slice.name}` : ", empty"}`}
              aria-pressed={project.selectedPadId === pad.id}
              title={slice ? `${pad.id} · ${slice.name}` : `${pad.id} · empty`}
              onPointerDown={() => pick(pad)}
              onPointerUp={() => playbackService.releasePad(pad.id)}
              onPointerLeave={() => playbackService.releasePad(pad.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!e.repeat) pick(pad);
                }
              }}
              className={cn(
                "chop-pad",
                `pad-${pad.color}`,
                slice && "has-sound",
                project.selectedPadId === pad.id && "is-selected",
                midi.lit[pad.id] && "is-hit",
                midi.learningPadId === pad.id && "is-learning",
              )}
            >
              {pad.id}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Make a found key the beat's key — pads can then be matched to it. */
function UseAsBeatKey({ k }: { k: KeyResult }) {
  const { project, commit } = useFrost();
  const same = project.key?.tonic === k.tonic && project.key?.mode === k.mode;
  if (same) return <span className="text-[11px] text-primary">beat key</span>;
  return (
    <button
      className="btn min-h-7 px-2 text-[11px]"
      onClick={() => commit((p) => ({ ...p, key: { tonic: k.tonic, mode: k.mode } }))}
    >
      Use as beat key
    </button>
  );
}
