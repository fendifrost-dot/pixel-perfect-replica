import { useRef, useState } from "react";
import { Headphones, Plus, Scissors, Trash2, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { useFrost, uid, fmt } from "@/lib/frost/store";
import { audioStore } from "@/lib/frost/audioStore";
import { importService, playbackService, sliceService, tempoService } from "@/lib/frost/engine";
import { Waveform } from "./Waveform";
import { Unavailable } from "./Unavailable";
import { cn } from "@/lib/utils";

export function SampleView() {
  const { project, commit, notify } = useFrost();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [scroll, setScroll] = useState(0); // 0..1
  const src = project.sources.find((s) => s.id === project.activeSourceId);
  const peaks = src ? audioStore.getPeaks(src.id) : undefined;
  const sel = project.selection?.sourceId === src?.id ? project.selection : null;
  const markers = (src && project.markers[src.id]) || [];

  const onFile = async (f: File) => {
    setBusy(true);
    try {
      const asset = await importService.importFile(f);
      commit((p) => ({
        ...p,
        sources: [...p.sources, asset],
        activeSourceId: asset.id,
        selection: { sourceId: asset.id, start: 0, end: Math.min(2, asset.durationSec) },
        markers: { ...p.markers, [asset.id]: [] },
      }));
      setZoom(1);
      setScroll(0);
    } catch {
      notify("Couldn't decode that file. Try WAV, AIFF, MP3 or M4A.");
    } finally {
      setBusy(false);
    }
  };

  const dur = src?.durationSec ?? 1;
  const span = dur / zoom;
  const viewStart = (dur - span) * scroll;
  const setSel = (start: number, end: number, final = true) =>
    src && commit((p) => ({ ...p, selection: { sourceId: src.id, start, end } }), { history: final });

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

  const sendSlices = () => {
    if (!src) return;
    const bounds = [0, ...markers.filter((m) => m > 0 && m < dur).sort((a, b) => a - b), dur];
    const regions = bounds.slice(0, -1).map((s, i) => ({ start: s, end: bounds[i + 1] })).slice(0, 16);
    commit((p) => {
      const newSlices = regions.map((r, i) => ({ id: uid(), sourceId: src.id, name: `Slice ${i + 1}`, ...r }));
      let k = 0;
      const pads = p.pads.map((x) => (x.bank === p.bank && k < newSlices.length ? { ...x, sliceId: newSlices[k++].id } : x));
      return { ...p, slices: [...p.slices, ...newSlices], pads };
    });
    notify(`${regions.length} slices sent to bank ${project.bank}.`);
  };

  const addMarker = () => {
    if (!src) return;
    const t = sel ? sel.start : viewStart + span / 2;
    commit((p) => ({ ...p, markers: { ...p.markers, [src.id]: [...(p.markers[src.id] ?? []), t].sort((a, b) => a - b) } }));
  };
  const delMarker = (t: number) =>
    src && commit((p) => ({ ...p, markers: { ...p.markers, [src.id]: (p.markers[src.id] ?? []).filter((m) => m !== t) } }));

  const audition = () => {
    if (!src || !sel) return;
    void playbackService.resume();
    if (!playbackService.audition(src.id, sel.start, sel.end))
      notify("No audio here — this is the demo source. Import a file to audition.");
  };

  const autoSlice = sliceService.autoSliceAvailability();
  const bpmA = tempoService.analysisAvailability();

  return (
    <div className="space-y-3">
      <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <button className="btn btn-primary h-14 w-full text-base" onClick={() => fileRef.current?.click()} disabled={busy}>
        <Upload className="size-5" /> {busy ? "Decoding…" : "Import audio"}
      </button>

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
            <span className={cn("shrink-0 rounded px-2 py-1 text-[10px] font-bold uppercase", peaks.demo ? "bg-primary/15 text-primary" : "bg-teal/15 text-teal")}>
              {peaks.demo ? "Demo waveform · not analysis" : "Session only · not saved"}
            </span>
          </div>

          <Waveform peaks={peaks.data} duration={dur} viewStart={viewStart} viewEnd={viewStart + span} selection={sel} markers={markers} onSelect={setSel} />

          <div className="flex items-center gap-2">
            <button aria-label="Zoom out" className="btn w-11 px-0" onClick={() => setZoom((z) => Math.max(1, z / 2))}><ZoomOut className="size-5" /></button>
            <span className="w-10 text-center font-mono text-xs">{zoom}×</span>
            <button aria-label="Zoom in" className="btn w-11 px-0" onClick={() => setZoom((z) => Math.min(64, z * 2))}><ZoomIn className="size-5" /></button>
            <input aria-label="Scroll waveform" type="range" min={0} max={1} step={0.001} value={scroll} disabled={zoom === 1} onChange={(e) => setScroll(Number(e.target.value))} className="min-w-0 flex-1" />
          </div>

          {sel && (
            <div className="grid grid-cols-3 gap-2">
              <NumField label="Start (s)" value={sel.start} onChange={(v) => setSel(Math.min(v, sel.end - 0.001), sel.end)} />
              <NumField label="End (s)" value={sel.end} onChange={(v) => setSel(sel.start, Math.min(dur, Math.max(v, sel.start + 0.001)))} />
              <div>
                <div className="eyebrow mb-1">Length</div>
                <div className="field flex items-center">{(sel.end - sel.start).toFixed(3)}</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button className="btn" onClick={audition}><Headphones className="size-4" /> Audition</button>
            <button className="btn" onClick={assignSelection} disabled={!sel || !selectedPad}>
              Assign to pad {selectedPad?.id}
            </button>
          </div>
        </section>
      )}

      {src && (
        <section className="panel space-y-2">
          <div className="flex items-center justify-between">
            <div className="eyebrow">Slice markers ({markers.length})</div>
            <button className="btn min-h-9 text-xs" onClick={addMarker}><Plus className="size-4" /> At selection start</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {markers.map((m) => (
              <button key={m} onClick={() => delMarker(m)} className="btn min-h-9 bg-teal/15 font-mono text-xs text-teal">
                {m.toFixed(3)} <Trash2 className="size-3.5" />
              </button>
            ))}
          </div>
          <button className="btn w-full" onClick={sendSlices}><Scissors className="size-4" /> Send slices to pads (bank {project.bank})</button>
          <Unavailable label="Auto-slice" reason={autoSlice.available ? "" : autoSlice.reason} />
        </section>
      )}

      {src && (
        <section className="panel grid grid-cols-2 gap-3">
          <div>
            <div className="eyebrow">Detected source BPM</div>
            <div className="font-mono text-2xl text-muted-foreground">{src.detectedBpm ?? "—"}</div>
            <div className="text-[11px] text-muted-foreground">{bpmA.available ? "" : "Analyzer not built"}</div>
          </div>
          <div>
            <div className="eyebrow">Project BPM</div>
            <div className="font-mono text-2xl text-primary">{project.bpm}</div>
            <div className="text-[11px] text-muted-foreground">Set in the top bar</div>
          </div>
          <div className="col-span-2">
            <Unavailable label="Analyze BPM" reason={bpmA.available ? "" : bpmA.reason} />
          </div>
        </section>
      )}

      <p className="px-1 text-xs text-muted-foreground">
        Editing is non-destructive: chops store start/end times in the original recording. Imported audio lives only in this browser session.
      </p>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label>
      <div className="eyebrow mb-1">{label}</div>
      <input className="field" type="number" inputMode="decimal" step={0.001} value={Number(value.toFixed(3))} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
