import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  AudioWaveform,
  Eraser,
  Headphones,
  Maximize2,
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
} from "@/lib/frost/engine";
import { Waveform, type WaveMode } from "./Waveform";
import { Segmented } from "./controls";
import { cn } from "@/lib/utils";
import { AiChop } from "./AiChop";

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
    }));
    notify(
      `Selection is on pad ${selectedPad.id}. Pick another pad on the Pads tab to assign the next one.`,
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
            {v1 - v0 < dur - 1e-6 && (
              <button
                aria-label="Show whole recording"
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
    </div>
  );
}
