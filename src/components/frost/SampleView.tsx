import { useEffect, useRef, useState } from "react";
import { Headphones, Maximize2, Scissors, Square, Trash2, Upload, Wand2, ZoomIn, ZoomOut } from "lucide-react";
import { useFrost, uid, fmt } from "@/lib/frost/store";
import { audioStore } from "@/lib/frost/audioStore";
import { boundaries, generateBeatGrid, moveBeat } from "@/lib/frost/analysis";
import { importService, playbackService, sliceService, tempoService } from "@/lib/frost/engine";
import { Waveform, type WaveMode } from "./Waveform";
import { cn } from "@/lib/utils";

type SliceMethod = "transients" | "equal" | "beats";

export function SampleView() {
  const { project, commit, notify, audioVersion, bumpAudio, loadingAudio } = useFrost();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<WaveMode>("select");
  const [view, setView] = useState<[number, number]>([0, 1]);
  const [method, setMethod] = useState<SliceMethod>("transients");
  const [sensitivity, setSensitivity] = useState(0.5);
  const [divisions, setDivisions] = useState(16);
  const [everyBeats, setEveryBeats] = useState(1);
  const [suggested, setSuggested] = useState<{ bpm: number; confidence: number } | null | undefined>(undefined);
  const [gridBpm, setGridBpm] = useState("");
  const taps = useRef<number[]>([]);

  const src = project.sources.find((s) => s.id === project.activeSourceId);
  const buffer = src ? audioStore.getBuffer(src.id) : undefined;
  const peaks = src ? audioStore.getPeaks(src.id) : undefined;
  const sel = project.selection?.sourceId === src?.id ? project.selection : null;
  const markers = (src && project.markers[src.id]) || [];
  const grid = src ? project.beatGrids[src.id] : undefined;
  const dur = src?.durationSec ?? 1;
  void audioVersion; // re-render when audio is (re)decoded

  // reset view when switching source
  useEffect(() => {
    setView([0, dur]);
    setSuggested(undefined);
    setGridBpm(grid ? String(grid.bpm) : "");
  }, [src?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (f: File) => {
    setBusy(true);
    try {
      const asset = await importService.importFile(f);
      commit((p) => ({
        ...p,
        isDemo: false,
        name: p.isDemo ? f.name.replace(/\.[^.]+$/, "") : p.name,
        sources: [...p.sources.filter((s) => s.origin !== "demo"), asset],
        slices: p.isDemo ? [] : p.slices,
        pads: p.isDemo ? p.pads.map((x) => ({ ...x, sliceId: null })) : p.pads,
        patterns: p.isDemo ? [{ id: "p1", name: "Pattern 1", lengthSteps: 32, lanes: [], notes: [] }] : p.patterns,
        currentPatternId: p.isDemo ? "p1" : p.currentPatternId,
        arrangement: p.isDemo ? [] : p.arrangement,
        export: p.isDemo ? { ...p.export, mode: "stems", range: "pattern" } : p.export,
        activeSourceId: asset.id,
        selection: { sourceId: asset.id, start: 0, end: Math.min(2, asset.durationSec) },
        markers: { ...(p.isDemo ? {} : p.markers), [asset.id]: [] },
      }));
      bumpAudio();
      if (asset.persistence !== "device") notify("Couldn't save the audio on this device (storage full?). It will need re-importing after reload.");
    } catch {
      notify("Couldn't decode that file. Try WAV, MP3, AIFF or M4A.");
    } finally {
      setBusy(false);
    }
  };

  const [v0, v1] = view[1] > view[0] && view[1] <= dur + 1e-9 ? view : [0, dur];
  const zoomBy = (f: number) => {
    const c = (v0 + v1) / 2;
    const span = Math.min(dur, Math.max(0.02, (v1 - v0) / f));
    const s = Math.min(Math.max(0, c - span / 2), dur - span);
    setView([s, s + span]);
  };
  const setSel = (start: number, end: number, final = true) =>
    src && commit((p) => ({ ...p, selection: { sourceId: src.id, start, end } }), { history: final });
  const setMarkers = (m: number[], final: boolean) =>
    src && commit((p) => ({ ...p, markers: { ...p.markers, [src.id]: m } }), { history: final });

  const selectedPad = project.pads.find((p) => p.id === project.selectedPadId);
  const assignSelection = () => {
    if (!src || !sel || !selectedPad) return;
    const id = uid();
    commit((p) => ({
      ...p,
      slices: [...p.slices, { id, sourceId: src.id, name: `Chop ${p.slices.length + 1}`, start: sel.start, end: sel.end }],
      pads: p.pads.map((x) => (x.id === selectedPad.id ? { ...x, sliceId: id } : x)),
    }));
    notify(`Selection assigned to pad ${selectedPad.id}.`);
  };

  const useRange = sel && sel.end - sel.start > 0.05;
  const range: [number, number] = useRange ? [sel.start, sel.end] : [0, dur];

  const sendSlices = () => {
    if (!src) return;
    const b = boundaries(markers, range[0], range[1]);
    const regions = b.slice(0, -1).map((s, i) => ({ start: s, end: b[i + 1] })).slice(0, 16);
    commit((p) => {
      const newSlices = regions.map((r, i) => ({ id: uid(), sourceId: src.id, name: `Slice ${i + 1}`, ...r }));
      let k = 0;
      const pads = p.pads.map((x) => (x.bank === p.bank && k < newSlices.length ? { ...x, sliceId: newSlices[k++].id } : x));
      return { ...p, slices: [...p.slices, ...newSlices], pads };
    });
    notify(`${regions.length} slices sent to bank ${project.bank}${b.length - 1 > 16 ? " (first 16)" : ""}.`);
  };

  const autoSlice = () => {
    if (!src) return;
    let cuts: number[] = [];
    if (method === "transients") {
      if (!buffer) return notify("No audio loaded for this source.");
      cuts = sliceService.autoSlice(src.id, range[0], range[1], sensitivity);
    } else if (method === "equal") {
      const n = Math.max(2, divisions);
      cuts = Array.from({ length: n - 1 }, (_, i) => range[0] + ((range[1] - range[0]) * (i + 1)) / n);
    } else {
      if (!grid) return notify("Set a beat grid first (Tempo, below).");
      cuts = grid.beats.filter((_, i) => i % Math.max(1, everyBeats) === 0);
    }
    const keep = markers.filter((m) => m < range[0] || m > range[1]);
    const inRange = cuts.filter((c) => c > range[0] && c < range[1]);
    setMarkers([...keep, ...inRange].sort((a, b) => a - b), true);
    setMode("chop");
    notify(`${inRange.length} markers in ${useRange ? "selection" : "whole file"}. Drag to adjust, tap one to delete.`);
  };

  const audition = () => {
    if (!src || !sel) return;
    void playbackService.resume();
    if (!playbackService.audition(src.id, sel.start, sel.end)) notify("No audio here — this is the demo source. Import a file to audition.");
  };

  const snapSelToBeats = () => {
    if (!grid || !sel) return;
    const near = (t: number) => grid.beats.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), grid.beats[0]);
    const a = near(sel.start), b = near(sel.end);
    if (b > a) setSel(a, b);
  };

  const suggest = () => {
    if (!src) return;
    const s = tempoService.suggestBpm(src.id);
    setSuggested(s);
    if (s) setGridBpm(String(s.bpm));
  };
  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((t) => now - t < 3000), now].slice(-8);
    if (taps.current.length >= 3) {
      const d = (taps.current[taps.current.length - 1] - taps.current[0]) / (taps.current.length - 1);
      setGridBpm((Math.round((60000 / d) * 10) / 10).toString());
    }
  };
  const makeGrid = () => {
    const bpm = Number(gridBpm);
    if (!src || !(bpm >= 40 && bpm <= 300)) return notify("Enter a source BPM between 40 and 300.");
    const first = sel ? sel.start : 0;
    commit((p) => ({ ...p, beatGrids: { ...p.beatGrids, [src.id]: generateBeatGrid(bpm, first, dur) } }));
    setMode("beats");
    notify("Beat markers placed from the selection start. Drag any marker to line it up.");
  };
  const onBeatMove = (i: number, t: number, final: boolean) =>
    src && grid && commit((p) => ({ ...p, beatGrids: { ...p.beatGrids, [src.id]: moveBeat(p.beatGrids[src.id], i, t) } }), { history: final });

  return (
    <div className="space-y-3">
      <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.aif,.aiff,.m4a" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) void onFile(f);
      }} />
      <button className="btn btn-primary h-14 w-full text-base" onClick={() => fileRef.current?.click()} disabled={busy}>
        <Upload className="size-5" /> {busy ? "Decoding…" : "Import audio (MP3 / WAV)"}
      </button>
      {loadingAudio && <p className="text-center text-xs text-muted-foreground">Loading saved audio…</p>}

      {project.sources.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {project.sources.map((s) => (
            <button key={s.id} onClick={() => commit((p) => ({ ...p, activeSourceId: s.id }))} className={cn("btn shrink-0 text-xs", s.id === src?.id && "btn-on")}>
              {s.name}
            </button>
          ))}
        </div>
      )}

      {src && peaks && (
        <section className="panel space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="eyebrow">Original recording</div>
              <div className="truncate font-semibold">{src.name}</div>
              <div className="font-mono text-xs text-muted-foreground">
                {fmt(src.durationSec)} · {src.sampleRate / 1000} kHz · {src.channels}ch
              </div>
            </div>
            <span className={cn("shrink-0 rounded px-2 py-1 text-[10px] font-bold uppercase",
              peaks.demo ? "bg-primary/15 text-primary" : src.persistence === "device" ? "bg-teal/15 text-teal" : "bg-rec/20 text-rec")}>
              {peaks.demo ? "Demo waveform · not analysis" : src.persistence === "device" ? "Saved on device" : "Not saved · re-import after reload"}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1 rounded-md bg-background p-1">
            {(["select", "chop", "beats"] as const).map((m) => (
              <button key={m} className={cn("btn min-h-9 text-xs", mode === m && "btn-on")} onClick={() => setMode(m)}>
                {m === "select" ? "Select" : m === "chop" ? "Chop markers" : "Beat markers"}
              </button>
            ))}
          </div>

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
          <p className="text-[11px] text-muted-foreground">
            {mode === "select" && "Drag to select. Pinch with two fingers to zoom."}
            {mode === "chop" && "Tap to add a chop marker, drag to move, tap a marker to delete."}
            {mode === "beats" && (grid ? "Drag beat markers to line them up with the recording." : "No beat grid yet — set one under Tempo.")}
          </p>

          <div className="flex items-center gap-2">
            <button aria-label="Zoom out" className="btn w-11 px-0" onClick={() => zoomBy(0.5)}><ZoomOut className="size-5" /></button>
            <button aria-label="Zoom in" className="btn w-11 px-0" onClick={() => zoomBy(2)}><ZoomIn className="size-5" /></button>
            <button aria-label="Show all" className="btn w-11 px-0" onClick={() => setView([0, dur])}><Maximize2 className="size-4" /></button>
            <input aria-label="Scroll waveform" type="range" min={0} max={1} step={0.0005}
              value={dur - (v1 - v0) > 0 ? v0 / (dur - (v1 - v0)) : 0} disabled={v1 - v0 >= dur - 1e-9}
              onChange={(e) => { const span = v1 - v0; const s = Number(e.target.value) * (dur - span); setView([s, s + span]); }}
              className="min-w-0 flex-1" />
          </div>

          {sel && (
            <div className="grid grid-cols-3 gap-2">
              <NumField label="Start (s)" value={sel.start} onChange={(v) => setSel(Math.max(0, Math.min(v, sel.end - 0.001)), sel.end)} />
              <NumField label="End (s)" value={sel.end} onChange={(v) => setSel(sel.start, Math.min(dur, Math.max(v, sel.start + 0.001)))} />
              <div>
                <div className="eyebrow mb-1">Length</div>
                <div className="field flex items-center font-mono text-sm">
                  {(sel.end - sel.start).toFixed(3)}s{grid ? ` · ${(((sel.end - sel.start) * grid.bpm) / 60).toFixed(2)}b` : ""}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button className="btn" onClick={audition}><Headphones className="size-4" /> Audition</button>
            <button className="btn" onClick={() => playbackService.stopAudition()}><Square className="size-4" /> Stop</button>
            <button className="btn" onClick={snapSelToBeats} disabled={!grid || !sel}>Snap to beats</button>
            <button className="btn btn-primary" onClick={assignSelection} disabled={!sel || !selectedPad}>
              Assign to pad {selectedPad?.id}
            </button>
          </div>
        </section>
      )}

      {src && (
        <section className="panel space-y-3">
          <div className="flex items-center justify-between">
            <div className="eyebrow">Chop · {useRange ? "inside selection" : "whole file"} · {markers.length} markers</div>
            <button className="btn min-h-9 text-xs" onClick={() => setMarkers(markers.filter((m) => m < range[0] || m > range[1]), true)} disabled={!markers.length}>
              <Trash2 className="size-3.5" /> Clear
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-md bg-background p-1">
            {(["transients", "equal", "beats"] as const).map((m) => (
              <button key={m} className={cn("btn min-h-9 text-xs", method === m && "btn-on")} onClick={() => setMethod(m)}>
                {m === "transients" ? "Transients" : m === "equal" ? "Equal" : "Beat grid"}
              </button>
            ))}
          </div>
          {method === "transients" && (
            <label className="block">
              <div className="mb-1 flex justify-between"><span className="eyebrow">Sensitivity</span><span className="font-mono text-xs">{Math.round(sensitivity * 100)}%</span></div>
              <input type="range" className="h-8 w-full" min={0} max={1} step={0.05} value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} />
            </label>
          )}
          {method === "equal" && (
            <label className="flex items-center justify-between gap-2 text-sm">Slices
              <select className="field w-24" value={divisions} onChange={(e) => setDivisions(Number(e.target.value))}>
                {[2, 4, 8, 16, 32].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
          {method === "beats" && (
            <label className="flex items-center justify-between gap-2 text-sm">Slice every
              <select className="field w-28" value={everyBeats} onChange={(e) => setEveryBeats(Number(e.target.value))}>
                {[1, 2, 4, 8, 16].map((n) => <option key={n} value={n}>{n === 4 ? "bar" : n === 8 ? "2 bars" : n === 16 ? "4 bars" : `${n} beat${n > 1 ? "s" : ""}`}</option>)}
              </select>
            </label>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button className="btn" onClick={autoSlice}><Wand2 className="size-4" /> Auto-slice</button>
            <button className="btn btn-primary" onClick={sendSlices}><Scissors className="size-4" /> To bank {project.bank}</button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            “To bank” turns the markers {useRange ? "inside the selection" : "across the file"} into chops on pads {project.bank}1–{project.bank}16 (first 16).
          </p>
        </section>
      )}

      {src && (
        <section className="panel space-y-3">
          <div className="eyebrow">Tempo of this recording</div>
          <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
            <label>
              <div className="eyebrow mb-1">Source BPM</div>
              <input className="field font-mono" type="number" inputMode="decimal" value={gridBpm} placeholder="e.g. 92" onChange={(e) => setGridBpm(e.target.value)} />
            </label>
            <button className="btn" onClick={tap}>Tap</button>
            <button className="btn" onClick={suggest} disabled={!buffer}>Suggest</button>
          </div>
          {suggested === null && <p className="text-[11px] text-muted-foreground">No steady pulse found — tap the tempo instead.</p>}
          {suggested && (
            <p className="text-[11px] text-muted-foreground">
              Suggestion {suggested.bpm} BPM ({suggested.confidence > 0.3 ? "fairly sure" : "unsure"}). Could also be {Math.round(suggested.bpm / 2 * 10) / 10} or {Math.round(suggested.bpm * 20) / 10}.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button className="btn" onClick={makeGrid}>Beat markers from {sel ? "selection start" : "0:00"}</button>
            <button className="btn" disabled={!grid} onClick={() => grid && commit((p) => ({ ...p, bpm: Math.round(grid.bpm * 10) / 10 }))}>
              Project BPM = {grid ? grid.bpm : "source"}
            </button>
          </div>
          {grid && (
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{grid.beats.length} beat markers at {grid.bpm} BPM · project {project.bpm} BPM</span>
              <button className="btn min-h-8 text-xs" onClick={() => commit((p) => { const g = { ...p.beatGrids }; delete g[src.id]; return { ...p, beatGrids: g }; })}>Remove</button>
            </div>
          )}
        </section>
      )}

      <p className="px-1 text-xs text-muted-foreground">
        Editing is non-destructive: chops store start/end times in the original recording. Audio and projects stay on this device.
      </p>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label>
      <div className="eyebrow mb-1">{label}</div>
      <input className="field font-mono" type="number" inputMode="decimal" step={0.001} value={Number(value.toFixed(3))} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
